const assert = require('assert');
const { runParallelBlueprint } = require('../../server/agents/parallelOrchestrator');
const { validateBlueprint } = require('../../server/agents/architect');

function makeMockAgentLoop({ behaviorBySlice = {}, defaultBehavior = 'success', delayMs = 10 } = {}) {
  /**
   * The mocked agent loop reads sliceId from options.systemPromptAddendum (which contains the
   * slice tag) and applies the requested behavior:
   *   - 'success' → resolves with status: 'completed'
   *   - 'fail'    → resolves with status: 'max_iterations' (treated as failure)
   *   - 'throw'   → rejects
   *   - 'slow'    → completes after delayMs ms
   * Also records the order of completion and concurrency observed.
   */
  const completions = [];
  let inFlight = 0;
  let peakConcurrency = 0;

  async function mockedAgentLoop(objective, context, opts) {
    const sliceId = (opts.systemPromptAddendum.match(/SLICE: (\S+)/) || [])[1];
    inFlight++;
    peakConcurrency = Math.max(peakConcurrency, inFlight);
    const behavior = behaviorBySlice[sliceId] || defaultBehavior;
    await new Promise(resolve => setTimeout(resolve, behavior === 'slow' ? delayMs * 5 : delayMs));
    inFlight--;
    completions.push(sliceId);
    if (behavior === 'throw') throw new Error(`mock throw for ${sliceId}`);
    if (behavior === 'fail') return { status: 'max_iterations', iteration: 99, summary: `${sliceId} hit max iter` };
    return { status: 'completed', iteration: 3, summary: `${sliceId} done` };
  }

  return { mockedAgentLoop, completions: () => completions, peakConcurrency: () => peakConcurrency };
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

async function test_runs_all_slices_in_correct_topological_order() {
  const { mockedAgentLoop, completions, peakConcurrency } = makeMockAgentLoop();
  const summary = await runParallelBlueprint({
    blueprint: sampleBlueprint(),
    turnId: 't1',
    context: {},
    runAgentLoopFn: mockedAgentLoop,
    maxParallel: 4
  });
  assert.strictEqual(summary.succeeded, 5);
  assert.strictEqual(summary.failed, 0);
  assert.strictEqual(summary.skipped, 0);
  const order = completions();
  const idxOf = id => order.indexOf(id);
  assert.ok(idxOf('c') > idxOf('a'), 'c depends on a, must finish after');
  assert.ok(idxOf('d') > idxOf('a'));
  assert.ok(idxOf('d') > idxOf('b'));
  assert.ok(idxOf('finalize') > idxOf('c'));
  assert.ok(idxOf('finalize') > idxOf('d'));
  assert.ok(peakConcurrency() >= 2, `should have run a+b in parallel, peak was ${peakConcurrency()}`);
  console.log('  ✓ topological order respected, parallelism observed (peak concurrency:', peakConcurrency(), ')');
}

async function test_max_parallel_respected() {
  const { mockedAgentLoop, peakConcurrency } = makeMockAgentLoop();
  await runParallelBlueprint({
    blueprint: sampleBlueprint(),
    turnId: 't1',
    context: {},
    runAgentLoopFn: mockedAgentLoop,
    maxParallel: 1
  });
  assert.strictEqual(peakConcurrency(), 1, 'maxParallel=1 should serialize');
  console.log('  ✓ maxParallel bound respected');
}

async function test_failed_slice_skips_dependents() {
  const { mockedAgentLoop } = makeMockAgentLoop({ behaviorBySlice: { a: 'fail' } });
  const summary = await runParallelBlueprint({
    blueprint: sampleBlueprint(),
    turnId: 't1',
    context: {},
    runAgentLoopFn: mockedAgentLoop,
    maxParallel: 4
  });
  assert.strictEqual(summary.perSlice.a.state, 'failed', 'a should be failed');
  assert.strictEqual(summary.perSlice.b.state, 'succeeded', 'b is independent of a, should still succeed');
  assert.strictEqual(summary.perSlice.c.state, 'skipped', 'c depends on a, must be skipped');
  assert.strictEqual(summary.perSlice.d.state, 'skipped', 'd depends on a, must be skipped');
  assert.strictEqual(summary.perSlice.finalize.state, 'skipped', 'finalize transitively depends, must be skipped');
  console.log('  ✓ failure cascades to dependents while independent slices succeed');
}

async function test_throw_in_worker_treated_as_failure() {
  const { mockedAgentLoop } = makeMockAgentLoop({ behaviorBySlice: { b: 'throw' } });
  const summary = await runParallelBlueprint({
    blueprint: sampleBlueprint(),
    turnId: 't1',
    context: {},
    runAgentLoopFn: mockedAgentLoop,
    maxParallel: 4
  });
  assert.strictEqual(summary.perSlice.b.state, 'failed');
  assert.ok(summary.perSlice.b.error.includes('mock throw'));
  // c depends on a not b → c should succeed
  assert.strictEqual(summary.perSlice.c.state, 'succeeded');
  // d depends on b → skipped
  assert.strictEqual(summary.perSlice.d.state, 'skipped');
  console.log('  ✓ worker exception handled, dependents skipped');
}

async function test_orchestrator_emits_lifecycle_events() {
  const { mockedAgentLoop } = makeMockAgentLoop();
  const events = [];
  await runParallelBlueprint({
    blueprint: sampleBlueprint(),
    turnId: 't1',
    context: {},
    runAgentLoopFn: mockedAgentLoop,
    maxParallel: 4,
    onEvent: (evt, data) => events.push([evt, data])
  });
  const evtTypes = events.map(e => e[0]);
  assert.ok(evtTypes.filter(t => t === 'sliceStarted').length === 5);
  assert.ok(evtTypes.filter(t => t === 'sliceCompleted').length === 5);
  assert.ok(evtTypes.includes('blueprintCompleted'));
  console.log('  ✓ orchestrator emits started/completed/summary events');
}

async function test_worker_receives_slice_prompt() {
  // Capture what the worker received in opts
  const receivedPrompts = {};
  async function spy(objective, context, opts) {
    const sliceId = (opts.systemPromptAddendum.match(/SLICE: (\S+)/) || [])[1];
    receivedPrompts[sliceId] = { addendum: opts.systemPromptAddendum, objective, scope: context._sliceScope };
    return { status: 'completed', iteration: 1, summary: 'ok' };
  }
  await runParallelBlueprint({
    blueprint: sampleBlueprint(),
    turnId: 't1',
    context: { foo: 'bar' },
    runAgentLoopFn: spy,
    maxParallel: 4
  });
  assert.ok(receivedPrompts.a, 'slice a should have received prompt');
  assert.ok(receivedPrompts.a.addendum.includes('SLICE: a'));
  assert.deepStrictEqual(receivedPrompts.a.scope, { sheets_owned: ['SA'], ranges_owned: [], may_read_from: [] });
  assert.ok(receivedPrompts.finalize.addendum.includes('Final'));
  console.log('  ✓ each worker receives scoped prompt and slice context');
}

async function test_pro_tier_routes_to_pro_model() {
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
  assert.strictEqual(received.build.modelOverride, undefined, 'flash worker must not override model');
  assert.strictEqual(received.build.promptVariant, 'fast', 'flash worker uses fast variant');
  assert.ok(received.audit.modelOverride && /pro/.test(received.audit.modelOverride), `pro slice should route to a pro model, got ${received.audit.modelOverride}`);
  assert.strictEqual(received.audit.promptVariant, 'default', 'pro slice uses default variant');
  console.log('  ✓ tier:pro routes worker to pro model, flash stays fast');
}

(async () => {
  console.log('Parallel orchestrator tests:');
  await test_runs_all_slices_in_correct_topological_order();
  await test_max_parallel_respected();
  await test_failed_slice_skips_dependents();
  await test_throw_in_worker_treated_as_failure();
  await test_orchestrator_emits_lifecycle_events();
  await test_worker_receives_slice_prompt();
  await test_pro_tier_routes_to_pro_model();
  console.log('All orchestrator tests passed.\n');
})().catch(err => {
  console.error('Orchestrator test failed:', err);
  process.exit(1);
});
