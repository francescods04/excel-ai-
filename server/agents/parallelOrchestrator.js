/**
 * Parallel DAG Orchestrator
 *
 * Executes an architect blueprint by spawning slice-bounded workers in parallel waves.
 * Each worker is a runAgentLoop call constrained to its slice scope.
 *
 * Concurrency is bounded by maxParallel (default 4). Within a single wave, ready slices
 * run concurrently. Workers in the SAME wave never share writable sheets/ranges (the
 * architect validator guarantees this), so Excel writes are safe to interleave at the
 * client-side queue level.
 *
 * Failure isolation:
 *   - if a slice worker fails (or returns aborted/error), the orchestrator marks it
 *     failed but continues other workers in parallel waves whose deps don't transitively
 *     require the failed slice. Slices that DID depend on it are skipped with a clear
 *     reason.
 *   - the orchestrator returns a comprehensive result including succeeded/failed/skipped.
 */

const { runAgentLoop } = require('./agentLoop');
const { buildSliceWorkerPrompt } = require('./architect');
const logger = require('../utils/logger');

const DEFAULT_MAX_PARALLEL = Number(process.env.PARALLEL_ORCHESTRATOR_MAX || 4);
// Workers default to the fast model; a slice may opt into the pro model via tier:'pro'
// (reserved by the architect for a final audit/verification slice, not routine formatting).
const PRO_MODEL = process.env.AGENT_LOOP_PRO_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';

// Bumped 12 → 30 to match architectStepwise (2026-05-31 Revenue slice cap-hit).
const SLICE_HARD_ITER_CAP = Number(process.env.SLICE_HARD_ITER_CAP) || 30;
// Wall-clock budget for an entire wave's Promise.allSettled. If the longest
// slice in the wave exceeds this, we cut it off and mark every still-running
// slice as failed_timeout so the wave returns to the client and the next
// /step can proceed. Default 240s = stays safely under Vercel's 300s cap.
const WAVE_WALL_TIMEOUT_MS = Number(process.env.WAVE_WALL_TIMEOUT_MS) || 240000;

async function runParallelBlueprint({
  blueprint,
  turnId,
  context,
  onEvent = () => {},
  runtimeHelpers = {},
  maxParallel = DEFAULT_MAX_PARALLEL,
  runAgentLoopFn = runAgentLoop,         // injectable for tests
  pullSteerMessages = null,
  abortSignal = null,
} = {}) {
  if (!blueprint || !Array.isArray(blueprint.slices) || blueprint.slices.length === 0) {
    throw new Error('runParallelBlueprint: blueprint with slices required');
  }

  const sliceMap = new Map(blueprint.slices.map(s => [s.id, s]));
  const state = new Map(); // id → 'pending'|'running'|'succeeded'|'failed'|'skipped'
  const results = new Map(); // id → worker result or error
  const startedAt = new Map();

  for (const s of blueprint.slices) state.set(s.id, 'pending');

  function isAborted() {
    return abortSignal && abortSignal.aborted;
  }

  function readyForLaunch(id) {
    if (state.get(id) !== 'pending') return false;
    const slice = sliceMap.get(id);
    for (const dep of slice.deps) {
      const st = state.get(dep);
      if (st === 'failed' || st === 'skipped') {
        // mark this slice skipped because a dep is broken
        state.set(id, 'skipped');
        results.set(id, { ok: false, skipped: true, reason: `dep ${dep} ${st}` });
        onEvent('sliceSkipped', { sliceId: id, reason: `dep ${dep} ${st}` });
        return false;
      }
      if (st !== 'succeeded') return false;
    }
    return true;
  }

  function allDone() {
    for (const st of state.values()) {
      if (st === 'pending' || st === 'running') return false;
    }
    return true;
  }

  async function runOne(sliceId) {
    const slice = sliceMap.get(sliceId);
    state.set(sliceId, 'running');
    startedAt.set(sliceId, Date.now());
    const sliceTier = (context && context.forceWorkerTier) || (slice.tier === 'pro' ? 'pro' : 'flash');
    onEvent('sliceStarted', { sliceId, title: slice.title, estimatedIters: slice.estimated_iters, tier: sliceTier });
    logger.info(`[Orchestrator] slice "${sliceId}" started (${slice.title}) [tier=${sliceTier}]`);

    try {
      const userObjective = (context && (context.userObjective || context.objective)) || '';
      const slicePrompt = buildSliceWorkerPrompt(slice, blueprint, userObjective);
      const sliceObjective = `${slice.title}\n\n${slice.instructions}`;
      // Build a derived context the worker can use. Don't mutate the parent context.
      const workerContext = { ...context, _sliceId: sliceId, _sliceScope: slice.scope };

      const tier = (context && context.forceWorkerTier) || (slice.tier === 'pro' ? 'pro' : 'flash');
      const workerOpts = {
        turnId,
        promptVariant: tier === 'pro' ? 'default' : 'fast',
        modelOverride: tier === 'pro' ? PRO_MODEL : undefined,
        maxIterations: Math.min(SLICE_HARD_ITER_CAP, Math.max(20, Math.ceil(Number(slice.estimated_iters || 10) * 2.5))),
        systemPromptAddendum: slicePrompt,
        onEvent: (evt, data) => {
          onEvent('sliceEvent', { sliceId, event: evt, data });
        },
        requestClientTool: runtimeHelpers.requestClientTool,
        requestQuestion: runtimeHelpers.requestQuestion,
        pullSteerMessages, // workers honor turn-wide steering as well
      };

      const result = await runAgentLoopFn(sliceObjective, workerContext, workerOpts);
      const ok = result && result.status === 'completed';
      state.set(sliceId, ok ? 'succeeded' : 'failed');
      results.set(sliceId, { ok, status: result?.status, summary: result?.summary, iteration: result?.iteration });
      onEvent(ok ? 'sliceCompleted' : 'sliceFailed', {
        sliceId,
        status: result?.status,
        summary: result?.summary,
        iteration: result?.iteration,
        elapsedMs: Date.now() - startedAt.get(sliceId)
      });
      logger.info(`[Orchestrator] slice "${sliceId}" ${ok ? 'completed' : 'failed'} (${result?.status})`);
    } catch (err) {
      state.set(sliceId, 'failed');
      results.set(sliceId, { ok: false, error: err.message });
      onEvent('sliceFailed', { sliceId, error: err.message, elapsedMs: Date.now() - startedAt.get(sliceId) });
      logger.warn(`[Orchestrator] slice "${sliceId}" threw: ${err.message}`);
    }
  }

  // Scheduler loop: launch up to maxParallel runners, awaiting any to finish before launching the next batch.
  const inFlight = new Map(); // id → promise
  while (!allDone() && !isAborted()) {
    // Find launch candidates (this also marks skipped slices)
    const candidates = [];
    for (const id of sliceMap.keys()) {
      if (readyForLaunch(id)) candidates.push(id);
    }
    // Launch as many as we can
    while (candidates.length > 0 && inFlight.size < maxParallel) {
      const id = candidates.shift();
      const promise = runOne(id).finally(() => inFlight.delete(id));
      inFlight.set(id, promise);
    }
    if (inFlight.size === 0) {
      // Nothing in flight and nothing launchable but not done → deadlock (shouldn't happen with validated DAG)
      const stuck = [...sliceMap.keys()].filter(id => state.get(id) === 'pending');
      for (const id of stuck) {
        state.set(id, 'skipped');
        results.set(id, { ok: false, skipped: true, reason: 'orchestrator_deadlock' });
        onEvent('sliceSkipped', { sliceId: id, reason: 'orchestrator_deadlock' });
      }
      break;
    }
    // Wait for at least one in-flight worker to finish before reconsidering
    await Promise.race(inFlight.values());
  }

  // Drain any still in flight (in case of abort, runOne resolves with whatever it has)
  if (inFlight.size > 0) {
    await Promise.allSettled(inFlight.values());
  }

  // Final summary
  const summary = {
    total: sliceMap.size,
    succeeded: 0, failed: 0, skipped: 0,
    perSlice: {}
  };
  for (const [id, st] of state.entries()) {
    if (st === 'succeeded') summary.succeeded++;
    else if (st === 'failed') summary.failed++;
    else if (st === 'skipped') summary.skipped++;
    summary.perSlice[id] = { state: st, ...(results.get(id) || {}) };
  }
  onEvent('blueprintCompleted', summary);
  return summary;
}

/* =========================================================================
 * STEPWISE BLUEPRINT ENGINE (serverless-friendly, wave-by-wave)
 *
 * runParallelBlueprint (above) runs the WHOLE blueprint inside a single
 * server invocation. On Vercel that invocation is killed after the HTTP
 * response, so the orchestrator's background loop dies long before all
 * waves finish — exactly the 300s cap the user keeps hitting.
 *
 * stepBlueprintWave runs ONE wave per call: it launches every slice whose
 * deps are satisfied in Promise.all, awaits them all, persists the
 * serializable state back to the caller, and returns. The client driver
 * then POSTs another /step to advance to the next wave. State is a plain
 * JSON object so it survives Supabase round-trips between waves.
 *
 * Each wave fits comfortably under 300s because:
 *   - architect caps slice estimated_iters at ~10-15
 *   - workers default to flash + thinking off (~2-4s/iter)
 *   - typical wave duration: 30-90s (max-of-parallel-slices)
 * ========================================================================= */

function initBlueprintRun(blueprint) {
  if (!blueprint || !Array.isArray(blueprint.slices) || blueprint.slices.length === 0) {
    throw new Error('initBlueprintRun: blueprint with slices required');
  }
  const sliceStates = {};
  for (const s of blueprint.slices) sliceStates[s.id] = 'pending';
  return {
    // We embed the full blueprint so a different serverless instance can
    // pick the run back up after Supabase hydration — no need to also fetch
    // the blueprint from the turn separately.
    blueprint,
    sliceStates,        // id → 'pending'|'running'|'succeeded'|'failed'|'skipped'
    sliceResults: {},   // id → { ok, status, summary, iteration, error?, skipped?, reason? }
    waveIndex: 0,
    startedAt: null,
    completedAt: null,
    status: 'pending'   // 'pending'|'running'|'completed'
  };
}

function computeBlueprintSummary(state) {
  const summary = { total: 0, succeeded: 0, failed: 0, skipped: 0, perSlice: {} };
  for (const [id, st] of Object.entries(state.sliceStates)) {
    summary.total++;
    if (st === 'succeeded') summary.succeeded++;
    else if (st === 'failed') summary.failed++;
    else if (st === 'skipped') summary.skipped++;
    summary.perSlice[id] = { state: st, ...(state.sliceResults[id] || {}) };
  }
  return summary;
}

// Mark every pending slice whose deps failed/skipped as skipped (transitive).
// Returns true if any slice was newly marked, so the caller can re-run until stable.
function _cascadeSkips(state, onEvent) {
  let changed = false;
  for (const slice of state.blueprint.slices) {
    if (state.sliceStates[slice.id] !== 'pending') continue;
    for (const dep of slice.deps || []) {
      const depSt = state.sliceStates[dep];
      if (depSt === 'failed' || depSt === 'skipped') {
        state.sliceStates[slice.id] = 'skipped';
        state.sliceResults[slice.id] = { ok: false, skipped: true, reason: `dep ${dep} ${depSt}` };
        onEvent('sliceSkipped', { sliceId: slice.id, reason: `dep ${dep} ${depSt}` });
        changed = true;
        break;
      }
    }
  }
  return changed;
}

async function stepBlueprintWave(state, {
  context,
  turnId,
  onEvent = () => {},
  runtimeHelpers = {},
  runAgentLoopFn = runAgentLoop,
  maxParallel = DEFAULT_MAX_PARALLEL,
  pullSteerMessages = null
} = {}) {
  if (!state || !state.blueprint) {
    throw new Error('stepBlueprintWave: state with embedded blueprint required');
  }
  if (state.status === 'completed') {
    return { state, done: true, summary: computeBlueprintSummary(state) };
  }
  if (state.status === 'pending') {
    state.status = 'running';
    state.startedAt = Date.now();
  }

  const sliceMap = new Map(state.blueprint.slices.map(s => [s.id, s]));

  // Cascade skips from any deps already known-bad before computing ready set.
  while (_cascadeSkips(state, onEvent)) { /* stable */ }

  // Ready = pending AND every dep succeeded. (Failed/skipped deps were just
  // cascaded above so they can't appear here.)
  const ready = [];
  for (const slice of state.blueprint.slices) {
    if (state.sliceStates[slice.id] !== 'pending') continue;
    const allDepsOk = (slice.deps || []).every(d => state.sliceStates[d] === 'succeeded');
    if (allDepsOk) ready.push(slice.id);
  }

  // Nothing ready → either all done, or deadlock.
  if (ready.length === 0) {
    const stillOpen = Object.values(state.sliceStates).some(s => s === 'pending' || s === 'running');
    if (stillOpen) {
      // Deadlock on validated DAG should be impossible, but be defensive:
      // mark everything still pending as skipped and finish.
      for (const id of Object.keys(state.sliceStates)) {
        if (state.sliceStates[id] === 'pending') {
          state.sliceStates[id] = 'skipped';
          state.sliceResults[id] = { ok: false, skipped: true, reason: 'orchestrator_deadlock' };
          onEvent('sliceSkipped', { sliceId: id, reason: 'orchestrator_deadlock' });
        }
      }
    }
    state.status = 'completed';
    state.completedAt = Date.now();
    const summary = computeBlueprintSummary(state);
    onEvent('blueprintCompleted', summary);
    return { state, done: true, summary };
  }

  // Run the wave. Each slice is a runAgentLoop driven by the parent's
  // requestClientTool — they share the same HTTP invocation and each await
  // their own SSE round-trip in parallel.
  const toLaunch = ready.slice(0, maxParallel);
  state.waveIndex = (state.waveIndex || 0) + 1;
  onEvent('waveStarted', { waveIndex: state.waveIndex, sliceIds: toLaunch });

  const promises = toLaunch.map(sliceId => {
    const slice = sliceMap.get(sliceId);
    const sliceTier = (context && context.forceWorkerTier) || (slice.tier === 'pro' ? 'pro' : 'flash');
    state.sliceStates[sliceId] = 'running';
    const startedAt = Date.now();
    onEvent('sliceStarted', {
      sliceId,
      title: slice.title,
      estimatedIters: slice.estimated_iters,
      tier: sliceTier
    });
    logger.info(`[Orchestrator/stepwise] slice "${sliceId}" started [tier=${sliceTier}, wave=${state.waveIndex}]`);

    const userObjective = (context && (context.userObjective || context.objective)) || '';
    const slicePrompt = buildSliceWorkerPrompt(slice, state.blueprint, userObjective);
    const sliceObjective = `${slice.title}\n\n${slice.instructions}`;
    const workerContext = { ...context, _sliceId: sliceId, _sliceScope: slice.scope };
    const tier = sliceTier;
    const workerOpts = {
      turnId,
      promptVariant: tier === 'pro' ? 'default' : 'fast',
      modelOverride: tier === 'pro' ? PRO_MODEL : undefined,
      maxIterations: Math.max(6, Math.min(SLICE_HARD_ITER_CAP, slice.estimated_iters * 2)),
      systemPromptAddendum: slicePrompt,
      onEvent: (evt, data) => { onEvent('sliceEvent', { sliceId, event: evt, data }); },
      requestClientTool: runtimeHelpers.requestClientTool,
      requestQuestion: runtimeHelpers.requestQuestion,
      pullSteerMessages
    };

    return runAgentLoopFn(sliceObjective, workerContext, workerOpts)
      .then(result => {
        const ok = result && result.status === 'completed';
        state.sliceStates[sliceId] = ok ? 'succeeded' : 'failed';
        state.sliceResults[sliceId] = {
          ok,
          status: result?.status,
          summary: result?.summary,
          iteration: result?.iteration
        };
        onEvent(ok ? 'sliceCompleted' : 'sliceFailed', {
          sliceId,
          status: result?.status,
          summary: result?.summary,
          iteration: result?.iteration,
          elapsedMs: Date.now() - startedAt
        });
        logger.info(`[Orchestrator/stepwise] slice "${sliceId}" ${ok ? 'completed' : 'failed'}`);
      })
      .catch(err => {
        state.sliceStates[sliceId] = 'failed';
        state.sliceResults[sliceId] = { ok: false, error: err.message };
        onEvent('sliceFailed', { sliceId, error: err.message, elapsedMs: Date.now() - startedAt });
        logger.warn(`[Orchestrator/stepwise] slice "${sliceId}" threw: ${err.message}`);
      });
  });

  // Race the wave's Promise.allSettled against a wall-clock timeout so a
  // runaway slice (or a stuck RPC after an SSE reconnect on a new instance)
  // can't drag the whole HTTP invocation past Vercel's 300s cap.
  const waveStartMs = Date.now();
  let waveTimedOut = false;
  await Promise.race([
    Promise.allSettled(promises),
    new Promise(resolve => setTimeout(() => { waveTimedOut = true; resolve(); }, WAVE_WALL_TIMEOUT_MS))
  ]);
  if (waveTimedOut) {
    const elapsed = Date.now() - waveStartMs;
    for (const sliceId of toLaunch) {
      if (state.sliceStates[sliceId] === 'running') {
        state.sliceStates[sliceId] = 'failed';
        state.sliceResults[sliceId] = { ok: false, error: `wave_wall_timeout after ${elapsed}ms (cap=${WAVE_WALL_TIMEOUT_MS}ms)` };
        onEvent('sliceFailed', { sliceId, error: 'wave_wall_timeout', elapsedMs: elapsed });
      }
    }
    logger.warn(`[Orchestrator/stepwise] wave ${state.waveIndex} timed out after ${elapsed}ms; marked stuck slices failed.`);
  }

  // Final check: anything still open? If not, mark complete.
  const stillOpen = Object.values(state.sliceStates).some(s => s === 'pending' || s === 'running');
  if (!stillOpen) {
    state.status = 'completed';
    state.completedAt = Date.now();
    const summary = computeBlueprintSummary(state);
    onEvent('blueprintCompleted', summary);
    return { state, done: true, summary };
  }
  return { state, done: false };
}

module.exports = {
  runParallelBlueprint,
  initBlueprintRun,
  stepBlueprintWave,
  computeBlueprintSummary,
  DEFAULT_MAX_PARALLEL
};
