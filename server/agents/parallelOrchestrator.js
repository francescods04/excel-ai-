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
    const sliceTier = slice.tier === 'pro' ? 'pro' : 'flash';
    onEvent('sliceStarted', { sliceId, title: slice.title, estimatedIters: slice.estimated_iters, tier: sliceTier });
    logger.info(`[Orchestrator] slice "${sliceId}" started (${slice.title}) [tier=${sliceTier}]`);

    try {
      const slicePrompt = buildSliceWorkerPrompt(slice, blueprint);
      const sliceObjective = `${slice.title}\n\n${slice.instructions}`;
      // Build a derived context the worker can use. Don't mutate the parent context.
      const workerContext = { ...context, _sliceId: sliceId, _sliceScope: slice.scope };

      const tier = slice.tier === 'pro' ? 'pro' : 'flash';
      const workerOpts = {
        turnId,
        promptVariant: tier === 'pro' ? 'default' : 'fast',
        modelOverride: tier === 'pro' ? PRO_MODEL : undefined,
        maxIterations: Math.max(6, Math.min(20, slice.estimated_iters * 2)),
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

module.exports = {
  runParallelBlueprint,
  DEFAULT_MAX_PARALLEL
};
