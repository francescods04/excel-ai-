const assert = require('assert');
const { runParallelBlueprint } = require('../../server/agents/parallelOrchestrator');
const { validateBlueprint } = require('../../server/agents/architect');

const TICK = 2; // ms — base unit. Kept tiny so tests stay fast but observable.

function makeMockAgentLoop({ behaviorBySlice = {}, defaultBehavior = 'success', delayMs = TICK } = {}) {
  /**
   * Behaviors per slice:
   *   'success' → completed
   *   'fail'    → max_iterations (treated as failed)
   *   'throw'   → reject
   *   'slow'    → completed after delayMs*5
   *   { ms }    → custom delay then completed
   * Records completion order, peak concurrency, and per-slice wall-clock.
   */
  const completions = [];
  const wallClock = {};
  let inFlight = 0;
  let peakConcurrency = 0;

  async function mockedAgentLoop(objective, context, opts) {
    const sliceId = (opts.systemPromptAddendum.match(/SLICE: (\S+)/) || [])[1];
    inFlight++;
    peakConcurrency = Math.max(peakConcurrency, inFlight);
    const startedAt = Date.now();
    const behavior = behaviorBySlice[sliceId] || defaultBehavior;
    const ms = (typeof behavior === 'object' && behavior !== null && behavior.ms)
      ? behavior.ms
      : (behavior === 'slow' ? delayMs * 5 : delayMs);
    await new Promise(resolve => setTimeout(resolve, ms));
    inFlight--;
    completions.push(sliceId);
    wallClock[sliceId] = Date.now() - startedAt;
    const verdict = typeof behavior === 'object' ? (behavior.verdict || 'success') : behavior;
    if (verdict === 'throw') throw new Error(`mock throw for ${sliceId}`);
    if (verdict === 'fail') return { status: 'max_iterations', iteration: 99, summary: `${sliceId} hit max iter` };
    return { status: 'completed', iteration: 3, summary: `${sliceId} done` };
  }

  return {
    mockedAgentLoop,
    completions: () => completions,
    peakConcurrency: () => peakConcurrency,
    wallClock: () => wallClock
  };
}

function sampleBlueprint() {
  return validateBlueprint({
    objective_restated: 'test',
    global_layout_notes: 'none',
    slices: [
      { id: 'a', title: 'A', deps: [], scope: { sheets_owned: ['SA'], may_read_from: [] }, instructions: 'x', estimated_iters: 5 },
      { id: 'b', title: 'B', deps: [], scope: { sheets_owned: ['SB'], may_read_from: [] }, instructions: 'x', estimated_iters: 5 },
      { id: 'c', title: 'C', deps: ['a'], scope: { sheets_owned: ['SC'], may_read_from: ['SA'] }, instructions: 'x', estimated_iters: 5 },
      { id: 'd', title: 'D', deps: ['a', 'b'], scope: { sheets_owned: ['SD'], may_read_from: ['SA', 'SB'] }, instructions: 'x', estimated_iters: 5 },
      { id: 'finalize', title: 'Final', deps: ['c', 'd'], scope: { sheets_owned: [], may_read_from: ['SC', 'SD'] }, instructions: 'x', estimated_iters: 4 }
    ]
  }).blueprint;
}

function singleSliceBlueprint() {
  return validateBlueprint({
    objective_restated: 'solo',
    global_layout_notes: 'none',
    slices: [
      { id: 'solo', title: 'Solo', deps: [], scope: { sheets_owned: ['S0'], may_read_from: [] }, instructions: 'x', estimated_iters: 3 }
    ]
  }).blueprint;
}

async function test_topological_order() {
  const { mockedAgentLoop, completions, peakConcurrency } = makeMockAgentLoop();
  const summary = await runParallelBlueprint({
    blueprint: sampleBlueprint(), turnId: 't1', context: {},
    runAgentLoopFn: mockedAgentLoop, maxParallel: 4
  });
  assert.strictEqual(summary.total, 5);
  assert.strictEqual(summary.succeeded, 5);
  assert.strictEqual(summary.failed, 0);
  assert.strictEqual(summary.skipped, 0);
  const order = completions();
  const idxOf = id => order.indexOf(id);
  assert.ok(idxOf('c') > idxOf('a'), 'c depends on a');
  assert.ok(idxOf('d') > idxOf('a'));
  assert.ok(idxOf('d') > idxOf('b'));
  assert.ok(idxOf('finalize') > idxOf('c'));
  assert.ok(idxOf('finalize') > idxOf('d'));
  // Per-slice summary should be populated for every id.
  for (const id of ['a', 'b', 'c', 'd', 'finalize']) {
    assert.strictEqual(summary.perSlice[id].state, 'succeeded', `${id} state`);
    assert.strictEqual(summary.perSlice[id].ok, true);
    assert.ok(typeof summary.perSlice[id].summary === 'string');
  }
  assert.ok(peakConcurrency() >= 2, `a+b should run in parallel; peak=${peakConcurrency()}`);
  return `topo+summary fields (peak=${peakConcurrency()})`;
}

async function test_max_parallel_respected() {
  const { mockedAgentLoop, peakConcurrency } = makeMockAgentLoop();
  await runParallelBlueprint({
    blueprint: sampleBlueprint(), turnId: 't1', context: {},
    runAgentLoopFn: mockedAgentLoop, maxParallel: 1
  });
  assert.strictEqual(peakConcurrency(), 1, 'maxParallel=1 must serialize');
  return 'maxParallel=1 honored';
}

async function test_failed_slice_skips_dependents() {
  const { mockedAgentLoop } = makeMockAgentLoop({ behaviorBySlice: { a: 'fail' } });
  const summary = await runParallelBlueprint({
    blueprint: sampleBlueprint(), turnId: 't1', context: {},
    runAgentLoopFn: mockedAgentLoop, maxParallel: 4
  });
  assert.strictEqual(summary.perSlice.a.state, 'failed');
  assert.strictEqual(summary.perSlice.a.status, 'max_iterations');
  assert.strictEqual(summary.perSlice.b.state, 'succeeded', 'b independent of a');
  assert.strictEqual(summary.perSlice.c.state, 'skipped');
  assert.match(summary.perSlice.c.reason, /dep a/);
  assert.strictEqual(summary.perSlice.d.state, 'skipped');
  assert.strictEqual(summary.perSlice.finalize.state, 'skipped', 'transitive skip via c/d');
  assert.strictEqual(summary.succeeded, 1);
  assert.strictEqual(summary.failed, 1);
  assert.strictEqual(summary.skipped, 3);
  return 'cascade skip correct';
}

async function test_throw_treated_as_failure() {
  const { mockedAgentLoop } = makeMockAgentLoop({ behaviorBySlice: { b: 'throw' } });
  const summary = await runParallelBlueprint({
    blueprint: sampleBlueprint(), turnId: 't1', context: {},
    runAgentLoopFn: mockedAgentLoop, maxParallel: 4
  });
  assert.strictEqual(summary.perSlice.b.state, 'failed');
  assert.ok(summary.perSlice.b.error && summary.perSlice.b.error.includes('mock throw'));
  assert.strictEqual(summary.perSlice.c.state, 'succeeded', 'c only depends on a');
  assert.strictEqual(summary.perSlice.d.state, 'skipped');
  assert.strictEqual(summary.perSlice.finalize.state, 'skipped');
  return 'throw captured + dependents skipped';
}

async function test_all_independent_slices_fail() {
  // Both root slices fail → everything downstream skipped, nothing succeeds.
  const { mockedAgentLoop } = makeMockAgentLoop({ behaviorBySlice: { a: 'fail', b: 'throw' } });
  const summary = await runParallelBlueprint({
    blueprint: sampleBlueprint(), turnId: 't1', context: {},
    runAgentLoopFn: mockedAgentLoop, maxParallel: 4
  });
  assert.strictEqual(summary.succeeded, 0);
  assert.strictEqual(summary.failed, 2);
  assert.strictEqual(summary.skipped, 3);
  return 'total root failure → all downstream skipped';
}

async function test_lifecycle_events() {
  const { mockedAgentLoop } = makeMockAgentLoop();
  const events = [];
  const summary = await runParallelBlueprint({
    blueprint: sampleBlueprint(), turnId: 't1', context: {},
    runAgentLoopFn: mockedAgentLoop, maxParallel: 4,
    onEvent: (evt, data) => events.push([evt, data])
  });
  const counts = events.reduce((m, [t]) => (m[t] = (m[t] || 0) + 1, m), {});
  assert.strictEqual(counts.sliceStarted, 5);
  assert.strictEqual(counts.sliceCompleted, 5);
  assert.strictEqual(counts.blueprintCompleted, 1);
  // Every sliceStarted should have a matching sliceCompleted with elapsedMs.
  const starts = events.filter(e => e[0] === 'sliceStarted').map(e => e[1].sliceId);
  const completes = events.filter(e => e[0] === 'sliceCompleted');
  assert.deepStrictEqual(new Set(starts), new Set(['a','b','c','d','finalize']));
  for (const [, data] of completes) {
    assert.ok(typeof data.elapsedMs === 'number' && data.elapsedMs >= 0, 'elapsedMs present');
  }
  // The final blueprintCompleted payload must equal the function return value.
  const lastPayload = events[events.length - 1][1];
  assert.strictEqual(lastPayload.total, summary.total);
  assert.strictEqual(lastPayload.succeeded, summary.succeeded);
  return 'lifecycle events emitted & consistent';
}

async function test_worker_receives_scoped_prompt() {
  const receivedPrompts = {};
  async function spy(objective, context, opts) {
    const sliceId = (opts.systemPromptAddendum.match(/SLICE: (\S+)/) || [])[1];
    receivedPrompts[sliceId] = {
      addendum: opts.systemPromptAddendum,
      objective,
      scope: context._sliceScope,
      sliceIdInCtx: context._sliceId,
      turnId: opts.turnId,
      parentFoo: context.foo
    };
    return { status: 'completed', iteration: 1, summary: 'ok' };
  }
  const parentContext = { foo: 'bar' };
  await runParallelBlueprint({
    blueprint: sampleBlueprint(), turnId: 'turn-42', context: parentContext,
    runAgentLoopFn: spy, maxParallel: 4
  });
  assert.ok(receivedPrompts.a);
  assert.ok(receivedPrompts.a.addendum.includes('SLICE: a'));
  assert.deepStrictEqual(receivedPrompts.a.scope, { sheets_owned: ['SA'], ranges_owned: [], may_read_from: [] });
  assert.strictEqual(receivedPrompts.a.sliceIdInCtx, 'a');
  assert.strictEqual(receivedPrompts.a.turnId, 'turn-42');
  assert.strictEqual(receivedPrompts.a.parentFoo, 'bar', 'parent context fields forwarded');
  assert.ok(receivedPrompts.finalize.addendum.includes('Final'));
  // Parent context must NOT be mutated by the orchestrator.
  assert.strictEqual(parentContext._sliceId, undefined);
  assert.strictEqual(parentContext._sliceScope, undefined);
  return 'scoped prompt + parent context untouched';
}

async function test_flash_default_pro_explicit_opt_in() {
  // Tier default is FLASH (per 2026-05-31 perf decision). 'pro' is explicit opt-in
  // reserved for slices that genuinely benefit from the heavier model.
  const received = {};
  async function spy(objective, context, opts) {
    const sliceId = (opts.systemPromptAddendum.match(/SLICE: (\S+)/) || [])[1];
    received[sliceId] = { modelOverride: opts.modelOverride, promptVariant: opts.promptVariant };
    return { status: 'completed', iteration: 1, summary: 'ok' };
  }
  const bp = validateBlueprint({
    objective_restated: 'test',
    global_layout_notes: 'none',
    slices: [
      { id: 'build', title: 'Build', deps: [], scope: { sheets_owned: ['S1'], may_read_from: [] }, instructions: 'x', estimated_iters: 5 },
      { id: 'audit', title: 'Audit', deps: ['build'], scope: { sheets_owned: [], may_read_from: ['S1'] }, instructions: 'x', estimated_iters: 5, tier: 'pro' }
    ]
  }).blueprint;
  await runParallelBlueprint({ blueprint: bp, turnId: 't1', context: {}, runAgentLoopFn: spy, maxParallel: 2 });
  // Default → flash → fast variant, no modelOverride
  assert.strictEqual(received.build.modelOverride, undefined, 'flash default must NOT override model');
  assert.strictEqual(received.build.promptVariant, 'fast');
  // Explicit tier:'pro' → pro variant + modelOverride set
  assert.ok(received.audit.modelOverride && /pro/i.test(received.audit.modelOverride),
    `pro slice should route to pro model, got ${received.audit.modelOverride}`);
  assert.strictEqual(received.audit.promptVariant, 'default');
  return 'flash default, pro on opt-in';
}

async function test_force_worker_tier_override() {
  // context.forceWorkerTier='pro' overrides per-slice tier defaults.
  const received = {};
  async function spy(objective, context, opts) {
    const sliceId = (opts.systemPromptAddendum.match(/SLICE: (\S+)/) || [])[1];
    received[sliceId] = { modelOverride: opts.modelOverride, promptVariant: opts.promptVariant };
    return { status: 'completed', iteration: 1, summary: 'ok' };
  }
  await runParallelBlueprint({
    blueprint: sampleBlueprint(), turnId: 't1',
    context: { forceWorkerTier: 'pro' },
    runAgentLoopFn: spy, maxParallel: 4
  });
  for (const id of ['a', 'b', 'c', 'd', 'finalize']) {
    assert.ok(received[id].modelOverride && /pro/i.test(received[id].modelOverride),
      `${id} must use pro under forceWorkerTier=pro`);
    assert.strictEqual(received[id].promptVariant, 'default');
  }
  return 'forceWorkerTier overrides per-slice tier';
}

async function test_single_slice_blueprint() {
  const { mockedAgentLoop } = makeMockAgentLoop();
  const summary = await runParallelBlueprint({
    blueprint: singleSliceBlueprint(), turnId: 't1', context: {},
    runAgentLoopFn: mockedAgentLoop, maxParallel: 4
  });
  assert.strictEqual(summary.total, 1);
  assert.strictEqual(summary.succeeded, 1);
  assert.strictEqual(summary.perSlice.solo.state, 'succeeded');
  return 'degenerate 1-slice blueprint';
}

async function test_empty_blueprint_rejected() {
  await assert.rejects(
    () => runParallelBlueprint({ blueprint: null, turnId: 't', context: {}, runAgentLoopFn: async () => ({}) }),
    /blueprint with slices required/
  );
  await assert.rejects(
    () => runParallelBlueprint({ blueprint: { slices: [] }, turnId: 't', context: {}, runAgentLoopFn: async () => ({}) }),
    /blueprint with slices required/
  );
  return 'invalid blueprints rejected';
}

async function test_wall_clock_parallelism() {
  // 'a' and 'b' both root, equal duration. With maxParallel=2 the wall-clock
  // for the a+b wave must be < 2× a single slice. Use a generous (1.7×) bound
  // to absorb event-loop jitter on CI while still catching serialization bugs.
  const SLOW = 30;
  const { mockedAgentLoop } = makeMockAgentLoop({
    behaviorBySlice: { a: { ms: SLOW }, b: { ms: SLOW } },
    defaultBehavior: { ms: TICK }
  });
  const start = Date.now();
  await runParallelBlueprint({
    blueprint: sampleBlueprint(), turnId: 't1', context: {},
    runAgentLoopFn: mockedAgentLoop, maxParallel: 4
  });
  const totalMs = Date.now() - start;
  // Serial lower bound would be ~2*SLOW + 3*TICK = 66ms; parallel ~ SLOW + downstream.
  assert.ok(totalMs < SLOW * 1.7 + 60,
    `expected parallel wall-clock < ${Math.round(SLOW * 1.7 + 60)}ms, got ${totalMs}ms`);
  return `wall-clock proves parallel (${totalMs}ms)`;
}

async function test_results_isolated_per_run() {
  // Two concurrent runParallelBlueprint invocations must not interfere.
  const r1 = makeMockAgentLoop({ behaviorBySlice: { a: 'fail' } });
  const r2 = makeMockAgentLoop();
  const [s1, s2] = await Promise.all([
    runParallelBlueprint({ blueprint: sampleBlueprint(), turnId: 'r1', context: {}, runAgentLoopFn: r1.mockedAgentLoop, maxParallel: 4 }),
    runParallelBlueprint({ blueprint: sampleBlueprint(), turnId: 'r2', context: {}, runAgentLoopFn: r2.mockedAgentLoop, maxParallel: 4 })
  ]);
  assert.strictEqual(s1.perSlice.a.state, 'failed');
  assert.strictEqual(s2.perSlice.a.state, 'succeeded');
  assert.strictEqual(s1.succeeded, 1);
  assert.strictEqual(s2.succeeded, 5);
  return 'concurrent runs do not cross-contaminate';
}

(async () => {
  console.log('Parallel orchestrator tests:');
  const t0 = Date.now();

  // Independent tests run in parallel — each owns its own mock state.
  const parallelTests = [
    ['topo order',              test_topological_order],
    ['max parallel',            test_max_parallel_respected],
    ['fail cascades',           test_failed_slice_skips_dependents],
    ['throw → failure',         test_throw_treated_as_failure],
    ['all roots fail',          test_all_independent_slices_fail],
    ['lifecycle events',        test_lifecycle_events],
    ['worker scope/context',    test_worker_receives_scoped_prompt],
    ['flash default',           test_flash_default_pro_explicit_opt_in],
    ['forceWorkerTier=pro',     test_force_worker_tier_override],
    ['single slice',            test_single_slice_blueprint],
    ['empty bp rejected',       test_empty_blueprint_rejected],
    ['wall-clock parallel',     test_wall_clock_parallelism],
    ['isolated runs',           test_results_isolated_per_run]
  ];

  const settled = await Promise.all(parallelTests.map(async ([name, fn]) => {
    try { return { name, ok: true, note: await fn() }; }
    catch (err) { return { name, ok: false, err }; }
  }));

  let failed = 0;
  for (const r of settled) {
    if (r.ok) console.log(`  ✓ ${r.name} — ${r.note}`);
    else { failed++; console.error(`  ✗ ${r.name}:`, r.err && r.err.message); }
  }
  const dt = Date.now() - t0;
  if (failed > 0) {
    console.error(`\n${failed}/${settled.length} orchestrator tests FAILED in ${dt}ms`);
    process.exit(1);
  }
  console.log(`\nAll ${settled.length} orchestrator tests passed in ${dt}ms.\n`);
})().catch(err => {
  console.error('Orchestrator suite crashed:', err);
  process.exit(1);
});
