'use strict';

/**
 * Durable stepwise architect engine.
 *
 * This is the production-safe replacement for running whole slice workers
 * inside one server invocation. Each slice owns a serializable agentState and
 * advances by at most one agent step per /turn/step round. The caller persists
 * this state after every round, so no client request or worker state lives only
 * in process memory.
 */

const { initAgentRun, runAgentStep, executeAgentTool } = require('./agentLoop');
const { buildSliceWorkerPrompt } = require('./architect');

// Bumped from 4 → 6: typical blueprints have 5-8 build slices in their first wave,
// and 4 forced them into two sequential LLM batches. Six fits the common 5-7 slice
// shape in one batch and roughly halves wall-clock time on build-heavy turns.
const DEFAULT_MAX_PARALLEL = Number(process.env.PARALLEL_ORCHESTRATOR_MAX || 6);
// Bumped 20 → 30: the 2026-05-31 fast-food run #3 had Revenue slice succeed
// at iter 15 (3 layout-discovery iters + 5 write/rewrite + 1 format + 1 verify)
// but cap=16 (from estimated_iters=8 * 2) hit before the slice could finish a
// layout-drift recovery. 30 gives a build slice room for: 1 read upstream, 1
// re-read if drift, 1 create_sheet, 3-5 writes, 1 format, 1 verify, plus ~5
// iter cushion for tool param glitches and JSON parse retries.
const SLICE_HARD_ITER_CAP = Number(process.env.SLICE_HARD_ITER_CAP) || 30;
const PRO_MODEL = process.env.AGENT_LOOP_PRO_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';

function initArchitectRun(blueprint) {
  if (!blueprint || !Array.isArray(blueprint.slices) || blueprint.slices.length === 0) {
    throw new Error('initArchitectRun: blueprint with slices required');
  }
  const sliceStates = {};
  for (const slice of blueprint.slices) sliceStates[slice.id] = 'pending';
  return {
    blueprint,
    sliceStates,
    sliceResults: {},
    sliceAgents: {},
    sliceWriteCounts: {},
    pendingBatch: null,
    roundIndex: 0,
    startedAt: null,
    completedAt: null,
    status: 'pending',
    metrics: {
      llmRoundTrips: 0,
      sliceStepCalls: 0,
      clientRoundTrips: 0,
      actionBatches: 0,
      actionsEmitted: 0,
      deterministicSlices: 0,
      peakActiveSlices: 0,
      firstActionAt: null
    }
  };
}

function ensureArchitectRun(state) {
  if (!state || !state.blueprint || !Array.isArray(state.blueprint.slices)) {
    throw new Error('advanceArchitectRun: state with embedded blueprint required');
  }
  if (!state.sliceStates) {
    state.sliceStates = {};
    for (const slice of state.blueprint.slices) state.sliceStates[slice.id] = 'pending';
  }
  if (!state.sliceResults) state.sliceResults = {};
  if (!state.sliceAgents) state.sliceAgents = {};
  if (!state.sliceWriteCounts) state.sliceWriteCounts = {};
  if (!state.metrics) state.metrics = {};
  state.metrics.llmRoundTrips = Number(state.metrics.llmRoundTrips || 0);
  state.metrics.sliceStepCalls = Number(state.metrics.sliceStepCalls || 0);
  state.metrics.clientRoundTrips = Number(state.metrics.clientRoundTrips || 0);
  state.metrics.actionBatches = Number(state.metrics.actionBatches || 0);
  state.metrics.actionsEmitted = Number(state.metrics.actionsEmitted || 0);
  state.metrics.peakActiveSlices = Number(state.metrics.peakActiveSlices || 0);
  state.metrics.deterministicSlices = Number(state.metrics.deterministicSlices || 0);
  return state;
}

function computeArchitectSummary(state) {
  const summary = {
    total: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    perSlice: {},
    metrics: { ...(state.metrics || {}) }
  };
  for (const slice of state.blueprint.slices) {
    const id = slice.id;
    const st = state.sliceStates[id] || 'pending';
    summary.total++;
    if (st === 'succeeded') summary.succeeded++;
    else if (st === 'failed') summary.failed++;
    else if (st === 'skipped') summary.skipped++;
    summary.perSlice[id] = { state: st, ...(state.sliceResults[id] || {}) };
  }
  return summary;
}

function sliceById(state, sliceId) {
  return (state.blueprint.slices || []).find(slice => slice.id === sliceId) || null;
}

function terminalStateCount(state) {
  return Object.values(state.sliceStates || {}).filter(st => ['succeeded', 'failed', 'skipped'].includes(st)).length;
}

function isComplete(state) {
  const total = (state.blueprint.slices || []).length;
  return total > 0 && terminalStateCount(state) === total;
}

function cascadeSkips(state, onEvent = () => {}) {
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

function normalizeClientResults(clientResult) {
  if (!clientResult) return [];
  const arr = Array.isArray(clientResult)
    ? clientResult
    : Array.isArray(clientResult.results) ? clientResult.results : [];
  return arr.map(result => {
    if (result && typeof result === 'object') {
      if (result.response) return result.response;
      if (result.data !== undefined || result.error !== undefined) return result;
    }
    return { data: result };
  });
}

function makeSliceRequestId(sliceId, req, index) {
  const raw = req && req.id ? String(req.id) : `req-${index}`;
  return `slice_${sliceId}_${raw}`;
}

function collectAwaitingClientBatch(state) {
  const requests = [];
  const slices = [];
  for (const slice of state.blueprint.slices) {
    const sliceId = slice.id;
    if (state.sliceStates[sliceId] !== 'running') continue;
    const agent = state.sliceAgents[sliceId];
    if (!agent || agent.status !== 'awaiting_client' || !agent.pending) continue;
    const pendingRequests = Array.isArray(agent.pending.requests) ? agent.pending.requests : [];
    if (pendingRequests.length === 0) continue;
    const reqStart = requests.length;
    pendingRequests.forEach((req, idx) => {
      requests.push({
        ...req,
        id: makeSliceRequestId(sliceId, req, idx),
        sliceId,
        taskId: sliceId
      });
    });
    slices.push({ sliceId, reqStart, reqCount: pendingRequests.length });
  }
  if (requests.length === 0) return null;
  return { kind: 'await_client', requests, slices };
}

function collectPausedBatch(state) {
  for (const slice of state.blueprint.slices) {
    const sliceId = slice.id;
    if (state.sliceStates[sliceId] !== 'running') continue;
    const agent = state.sliceAgents[sliceId];
    if (!agent || agent.status !== 'paused' || !agent.pending) continue;
    return { kind: 'paused', sliceId, question: agent.pending.question };
  }
  return null;
}

function maybeComplete(state, onEvent = () => {}) {
  if (!isComplete(state)) return null;
  state.status = 'completed';
  state.completedAt = state.completedAt || Date.now();
  const summary = computeArchitectSummary(state);
  onEvent('blueprintCompleted', summary);
  return { state, control: 'done', payload: { summary }, done: true };
}

function activeRunningSliceIds(state) {
  return state.blueprint.slices
    .filter(slice => state.sliceStates[slice.id] === 'running')
    .map(slice => slice.id);
}

function readyPendingSlices(state) {
  return state.blueprint.slices.filter(slice => {
    if (state.sliceStates[slice.id] !== 'pending') return false;
    return (slice.deps || []).every(dep => state.sliceStates[dep] === 'succeeded');
  });
}

function hasDeterministicActions(slice) {
  return Array.isArray(slice?.actions) && slice.actions.length > 0;
}

async function materializeDeterministicSliceActions(slice, context = {}) {
  const actions = [];
  const toolResults = [];
  for (let index = 0; index < slice.actions.length; index++) {
    const planned = slice.actions[index];
    const result = await executeAgentTool(planned.tool, planned.params || {}, context, null);
    toolResults.push({ tool: planned.tool, result });
    if (result && result.error) {
      throw new Error(`${planned.tool} failed: ${result.error}`);
    }
    const emitted = Array.isArray(result?.actions) ? result.actions : [];
    if (emitted.length === 0) {
      throw new Error(`${planned.tool} produced no Excel actions`);
    }
    actions.push(...emitted.map(action => ({
      ...action,
      _sliceId: slice.id,
      _architectTool: planned.tool,
      _architectActionIndex: index
    })));
  }
  return { actions, toolResults };
}

function initReadySlices(state, {
  context = {},
  maxParallel = DEFAULT_MAX_PARALLEL,
  initAgentRunFn = initAgentRun,
  onEvent = () => {}
} = {}) {
  const activeCount = activeRunningSliceIds(state).length;
  const capacity = Math.max(0, maxParallel - activeCount);
  if (capacity <= 0) return [];
  const toStart = readyPendingSlices(state).slice(0, capacity);
  if (toStart.length === 0) return [];

  state.roundIndex = (state.roundIndex || 0) + 1;
  onEvent('waveStarted', { waveIndex: state.roundIndex, sliceIds: toStart.map(s => s.id) });

  const userObjective = context.userObjective || context.objective || '';
  for (const slice of toStart) {
    if (hasDeterministicActions(slice)) {
      state.sliceAgents[slice.id] = {
        sliceId: slice.id,
        status: 'running',
        pending: null,
        iteration: 0,
        deterministicActions: slice.actions
      };
      state.sliceStates[slice.id] = 'running';
      onEvent('sliceStarted', {
        sliceId: slice.id,
        title: slice.title,
        estimatedIters: slice.estimated_iters,
        tier: 'deterministic',
        deterministic: true,
        actionCount: slice.actions.length
      });
      continue;
    }
    const sliceTier = slice.tier === 'flash' ? 'flash' : 'pro';
    const slicePrompt = buildSliceWorkerPrompt(slice, state.blueprint, userObjective);
    const sliceObjective = `${slice.title}\n\n${slice.instructions}`;
    const workerContext = { ...context, _sliceId: slice.id, _sliceScope: slice.scope };
    const workerState = initAgentRunFn(sliceObjective, workerContext, {
      promptVariant: sliceTier === 'pro' ? 'default' : 'fast',
      modelOverride: sliceTier === 'pro' ? PRO_MODEL : undefined,
      // Floor maxIterations at 20 so a slice with low estimated_iters still
      // gets a usable budget. Cap at SLICE_HARD_ITER_CAP. Multiplier 2.5x to
      // give layout-discovery + drift recovery + verify some room.
      maxIterations: Math.min(SLICE_HARD_ITER_CAP, Math.max(20, Math.ceil(Number(slice.estimated_iters || 10) * 2.5))),
      autoFormatOnDone: false,
      // Block execute_office_js for slice workers. In prod logs a single bad JS
      // call would burn 4-6 iters debugging itself (numberFormat 1x1 throws,
      // ctx redeclaration, "Sheet1 doesn't exist" guesses) instead of using
      // the structured tools that are already covered by the system prompt.
      disabledTools: ['execute_office_js'],
      systemPromptAddendum: slicePrompt
    });
    state.sliceAgents[slice.id] = workerState;
    state.sliceStates[slice.id] = 'running';
    onEvent('sliceStarted', {
      sliceId: slice.id,
      title: slice.title,
      estimatedIters: slice.estimated_iters,
      tier: sliceTier
    });
  }
  state.metrics.peakActiveSlices = Math.max(state.metrics.peakActiveSlices || 0, activeRunningSliceIds(state).length);
  return toStart.map(slice => slice.id);
}

function makeSliceProgress(onEvent, sliceId) {
  return (event, data = {}) => onEvent('sliceEvent', { sliceId, event, data });
}

function ingestSliceStep(state, sliceId, result, sinks, onEvent = () => {}) {
  if (!result || !result.state) return;
  state.sliceAgents[sliceId] = result.state;
  const slice = sliceById(state, sliceId) || { title: sliceId };

  if (result.control === 'emit_actions') {
    const actions = Array.isArray(result.payload?.actions) ? result.payload.actions : [];
    if (actions.length > 0) {
      sinks.actions.push(...actions.map(action => ({ ...action, _sliceId: sliceId })));
      state.sliceWriteCounts[sliceId] = (state.sliceWriteCounts[sliceId] || 0) + actions.length;
    }
    return;
  }

  if (result.control === 'done') {
    // Reject done with zero writes. Past runs had slice workers confabulate
    // "upstream not available" and call done immediately, marking the slice
    // succeeded — the workbook stayed empty but every dependent slice was
    // greenlit, producing a fake "completato" turn with missing sheets.
    // Format/audit-style slices (no sheets_owned, no ranges_owned) are exempt
    // because their job is to verify, not write.
    const wroteSomething = (state.sliceWriteCounts[sliceId] || 0) > 0;
    const canBeReadOnly = (!slice.scope || (
      (!slice.scope.sheets_owned || slice.scope.sheets_owned.length === 0) &&
      (!slice.scope.ranges_owned || slice.scope.ranges_owned.length === 0)
    ));
    // Only enforce when the slice actually had time to act (>1 iteration). A
    // 1-iteration immediate done is allowed (legitimate "nothing to add" or
    // test scenario). Multi-iteration done with zero writes = confabulation.
    const sliceIter = Number(result.state.iteration || 0);
    if (!wroteSomething && !canBeReadOnly && sliceIter > 1) {
      state.sliceStates[sliceId] = 'failed';
      state.sliceResults[sliceId] = {
        ok: false,
        status: 'failed_no_writes',
        error: `slice called done without writing any cells in its owned scope (claimed: "${result.payload?.summary || ''}")`,
        iteration: result.state.iteration || 0
      };
      delete state.sliceAgents[sliceId];
      onEvent('sliceFailed', {
        sliceId,
        status: 'failed_no_writes',
        error: state.sliceResults[sliceId].error,
        iteration: state.sliceResults[sliceId].iteration,
        elapsedMs: null
      });
      return;
    }
    state.sliceStates[sliceId] = 'succeeded';
    state.sliceResults[sliceId] = {
      ok: true,
      status: 'completed',
      summary: result.payload?.summary || result.state.summary || `${slice.title} completed`,
      iteration: result.state.iteration || 0,
      writes: state.sliceWriteCounts[sliceId] || 0
    };
    delete state.sliceAgents[sliceId];
    const autoFormatActions = Array.isArray(result.payload?.autoFormatActions) ? result.payload.autoFormatActions : [];
    if (autoFormatActions.length > 0) sinks.actions.push(...autoFormatActions.map(action => ({ ...action, _sliceId: sliceId })));
    onEvent('sliceCompleted', {
      sliceId,
      status: 'completed',
      summary: state.sliceResults[sliceId].summary,
      iteration: state.sliceResults[sliceId].iteration,
      elapsedMs: null
    });
    return;
  }

  if (result.control === 'aborted') {
    state.sliceStates[sliceId] = 'failed';
    state.sliceResults[sliceId] = {
      ok: false,
      status: 'aborted',
      error: result.payload?.reason || result.state.abortReason || 'aborted',
      iteration: result.state.iteration || 0
    };
    delete state.sliceAgents[sliceId];
    onEvent('sliceFailed', {
      sliceId,
      status: 'aborted',
      error: state.sliceResults[sliceId].error,
      iteration: state.sliceResults[sliceId].iteration,
      elapsedMs: null
    });
  }
}

function actionControl(state, actions) {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  state.metrics.actionBatches += 1;
  state.metrics.actionsEmitted += actions.length;
  if (!state.metrics.firstActionAt) state.metrics.firstActionAt = Date.now();
  return { state, control: 'emit_actions', payload: { actions }, done: false };
}

async function resumePendingBatch(state, clientResult, {
  runAgentStepFn = runAgentStep,
  onEvent = () => {}
} = {}) {
  const batch = state.pendingBatch;
  if (!batch) return { actions: [] };

  const staged = normalizeClientResults(clientResult);
  const sinks = { actions: [] };
  state.pendingBatch = null;
  state.metrics.clientRoundTrips += 1;

  if (batch.kind === 'await_client') {
    const items = (batch.slices || []).filter(item => state.sliceAgents[item.sliceId]);
    state.metrics.sliceStepCalls += items.length;
    const settled = await Promise.allSettled(items.map(item => {
      const sub = staged.slice(item.reqStart, item.reqStart + item.reqCount);
      return runAgentStepFn(state.sliceAgents[item.sliceId], { results: sub }, {
        onProgress: makeSliceProgress(onEvent, item.sliceId)
      }).then(result => ({ sliceId: item.sliceId, result }));
    }));
    for (let index = 0; index < settled.length; index++) {
      const entry = settled[index];
      if (entry.status === 'fulfilled') {
        ingestSliceStep(state, entry.value.sliceId, entry.value.result, sinks, onEvent);
      } else {
        const sliceId = items[index].sliceId;
        state.sliceStates[sliceId] = 'failed';
        state.sliceResults[sliceId] = { ok: false, error: entry.reason?.message || String(entry.reason) };
        delete state.sliceAgents[sliceId];
        onEvent('sliceFailed', { sliceId, error: state.sliceResults[sliceId].error });
      }
    }
  } else if (batch.kind === 'paused') {
    const agent = state.sliceAgents[batch.sliceId];
    if (agent) {
      const raw = clientResult && clientResult.response !== undefined ? clientResult.response : clientResult;
      state.metrics.sliceStepCalls += 1;
      const result = await runAgentStepFn(agent, { response: raw }, {
        onProgress: makeSliceProgress(onEvent, batch.sliceId)
      });
      ingestSliceStep(state, batch.sliceId, result, sinks, onEvent);
    }
  }
  return sinks;
}

async function advanceRunningSlices(state, {
  maxParallel = DEFAULT_MAX_PARALLEL,
  runAgentStepFn = runAgentStep,
  context = {},
  onEvent = () => {}
} = {}) {
  const runnable = activeRunningSliceIds(state).filter(sliceId => {
    const agent = state.sliceAgents[sliceId];
    return agent && agent.status === 'running' && !agent.pending;
  }).slice(0, maxParallel);

  if (runnable.length === 0) return { actions: [] };
  state.metrics.peakActiveSlices = Math.max(state.metrics.peakActiveSlices || 0, activeRunningSliceIds(state).length);
  const deterministic = runnable.filter(sliceId => state.sliceAgents[sliceId]?.deterministicActions);
  const agentic = runnable.filter(sliceId => !state.sliceAgents[sliceId]?.deterministicActions);
  state.metrics.llmRoundTrips += agentic.length;
  state.metrics.sliceStepCalls += agentic.length;

  const sinks = { actions: [] };

  for (const sliceId of deterministic) {
    const slice = sliceById(state, sliceId) || { id: sliceId, title: sliceId };
    try {
      const materialized = await materializeDeterministicSliceActions(slice, context);
      sinks.actions.push(...materialized.actions);
      state.metrics.deterministicSlices = Number(state.metrics.deterministicSlices || 0) + 1;
      state.sliceWriteCounts[sliceId] = materialized.actions.length;
      state.sliceStates[sliceId] = 'succeeded';
      state.sliceResults[sliceId] = {
        ok: true,
        status: 'completed',
        deterministic: true,
        summary: `${slice.title} emitted ${materialized.actions.length} deterministic action(s)`,
        iteration: 0,
        writes: materialized.actions.length,
        toolActions: slice.actions.length
      };
      delete state.sliceAgents[sliceId];
      onEvent('sliceCompleted', {
        sliceId,
        status: 'completed',
        deterministic: true,
        summary: state.sliceResults[sliceId].summary,
        iteration: 0,
        elapsedMs: null
      });
    } catch (err) {
      state.sliceStates[sliceId] = 'failed';
      state.sliceResults[sliceId] = {
        ok: false,
        status: 'deterministic_action_failed',
        deterministic: true,
        error: err && err.message ? err.message : String(err),
        iteration: 0
      };
      delete state.sliceAgents[sliceId];
      onEvent('sliceFailed', {
        sliceId,
        status: 'deterministic_action_failed',
        error: state.sliceResults[sliceId].error,
        iteration: 0,
        elapsedMs: null
      });
    }
  }

  if (agentic.length === 0) return sinks;

  const settled = await Promise.allSettled(agentic.map(sliceId =>
    runAgentStepFn(state.sliceAgents[sliceId], null, {
      onProgress: makeSliceProgress(onEvent, sliceId)
    }).then(result => ({ sliceId, result }))
  ));

  for (const entry of settled) {
    if (entry.status === 'fulfilled') {
      ingestSliceStep(state, entry.value.sliceId, entry.value.result, sinks, onEvent);
    } else {
      const sliceId = agentic[settled.indexOf(entry)];
      state.sliceStates[sliceId] = 'failed';
      state.sliceResults[sliceId] = { ok: false, error: entry.reason?.message || String(entry.reason) };
      delete state.sliceAgents[sliceId];
      onEvent('sliceFailed', { sliceId, error: state.sliceResults[sliceId].error });
    }
  }
  return sinks;
}

async function advanceArchitectRun(state, {
  context = {},
  clientResult = null,
  maxParallel = DEFAULT_MAX_PARALLEL,
  initAgentRunFn = initAgentRun,
  runAgentStepFn = runAgentStep,
  onEvent = () => {}
} = {}) {
  ensureArchitectRun(state);
  if (state.status === 'completed') {
    return { state, control: 'done', payload: { summary: computeArchitectSummary(state) }, done: true };
  }
  if (state.status === 'pending') {
    state.status = 'running';
    state.startedAt = state.startedAt || Date.now();
  }

  if (state.pendingBatch && clientResult) {
    const resumed = await resumePendingBatch(state, clientResult, { runAgentStepFn, onEvent });
    while (cascadeSkips(state, onEvent)) {}
    const action = actionControl(state, resumed.actions);
    if (action) return action;
    const completed = maybeComplete(state, onEvent);
    if (completed) return completed;
  }

  while (cascadeSkips(state, onEvent)) {}
  const completedBeforeStart = maybeComplete(state, onEvent);
  if (completedBeforeStart) return completedBeforeStart;

  const existingAwait = collectAwaitingClientBatch(state);
  if (existingAwait) {
    state.pendingBatch = existingAwait;
    return { state, control: 'await_client', payload: { requests: existingAwait.requests }, done: false };
  }
  const existingPause = collectPausedBatch(state);
  if (existingPause) {
    state.pendingBatch = existingPause;
    return { state, control: 'paused', payload: { question: existingPause.question, sliceId: existingPause.sliceId }, done: false };
  }

  initReadySlices(state, { context, maxParallel, initAgentRunFn, onEvent });
  const stepped = await advanceRunningSlices(state, { maxParallel, runAgentStepFn, context, onEvent });
  while (cascadeSkips(state, onEvent)) {}

  const action = actionControl(state, stepped.actions);
  if (action) return action;

  const awaitBatch = collectAwaitingClientBatch(state);
  if (awaitBatch) {
    state.pendingBatch = awaitBatch;
    return { state, control: 'await_client', payload: { requests: awaitBatch.requests }, done: false };
  }

  const paused = collectPausedBatch(state);
  if (paused) {
    state.pendingBatch = paused;
    return { state, control: 'paused', payload: { question: paused.question, sliceId: paused.sliceId }, done: false };
  }

  const completed = maybeComplete(state, onEvent);
  if (completed) return completed;
  return { state, control: 'continue', payload: { activeSlices: activeRunningSliceIds(state) }, done: false };
}

module.exports = {
  initArchitectRun,
  advanceArchitectRun,
  computeArchitectSummary,
  collectAwaitingClientBatch,
  collectPausedBatch,
  DEFAULT_MAX_PARALLEL
};
