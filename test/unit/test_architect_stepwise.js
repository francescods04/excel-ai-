'use strict';

const assert = require('assert');
const {
  initArchitectRun,
  advanceArchitectRun,
  collectAwaitingClientBatch
} = require('../../server/agents/architectStepwise');
const { validateBlueprint, buildSliceWorkerPrompt } = require('../../server/agents/architect');

function blueprint(rawSlices) {
  return validateBlueprint({
    objective_restated: 'test durable architect',
    global_layout_notes: 'none',
    slices: rawSlices
  }).blueprint;
}

function baseSlices() {
  return [
    { id: 'a', title: 'A', deps: [], scope: { sheets_owned: ['A'], may_read_from: [] }, instructions: 'Build A', estimated_iters: 4 },
    { id: 'b', title: 'B', deps: [], scope: { sheets_owned: ['B'], may_read_from: [] }, instructions: 'Build B', estimated_iters: 4 },
    { id: 'final', title: 'Final', deps: ['a', 'b'], scope: { sheets_owned: ['Summary'], may_read_from: ['A', 'B'] }, instructions: 'Finish', estimated_iters: 3 }
  ];
}

function initAgentRunMock(objective, context) {
  return {
    sliceId: context._sliceId,
    objective,
    context,
    status: 'running',
    pending: null,
    iteration: 0,
    summary: null
  };
}

function makeStepMock(handler) {
  const calls = [];
  let inFlight = 0;
  let peak = 0;
  let clientInFlight = 0;
  let clientPeak = 0;
  async function runAgentStepFn(agentState, clientResult) {
    calls.push({ sliceId: agentState.sliceId, clientResult });
    const isClientResume = Boolean(clientResult);
    inFlight++;
    peak = Math.max(peak, inFlight);
    if (isClientResume) {
      clientInFlight++;
      clientPeak = Math.max(clientPeak, clientInFlight);
    }
    await new Promise(resolve => setTimeout(resolve, 5));
    try {
      return handler(agentState, clientResult);
    } finally {
      if (isClientResume) clientInFlight--;
      inFlight--;
    }
  }
  return { runAgentStepFn, calls, peak: () => peak, clientPeak: () => clientPeak };
}

async function testParallelRootsThenFinal() {
  const state = initArchitectRun(blueprint(baseSlices()));
  const mock = makeStepMock((agent) => ({
    state: { ...agent, status: 'completed', summary: `${agent.sliceId} done`, iteration: agent.iteration + 1 },
    control: 'done',
    payload: { summary: `${agent.sliceId} done` }
  }));

  const first = await advanceArchitectRun(state, {
    context: {},
    initAgentRunFn: initAgentRunMock,
    runAgentStepFn: mock.runAgentStepFn,
    maxParallel: 2
  });
  assert.strictEqual(first.control, 'continue', 'roots done, final still pending');
  assert.strictEqual(first.state.sliceStates.a, 'succeeded');
  assert.strictEqual(first.state.sliceStates.b, 'succeeded');
  assert.strictEqual(first.state.sliceStates.final, 'pending');
  assert.strictEqual(mock.peak(), 2, 'root slices stepped concurrently');
  assert.strictEqual(first.state.metrics.llmRoundTrips, 2);

  const second = await advanceArchitectRun(state, {
    context: {},
    initAgentRunFn: initAgentRunMock,
    runAgentStepFn: mock.runAgentStepFn,
    maxParallel: 2
  });
  assert.strictEqual(second.control, 'done', 'final slice completes blueprint');
  assert.strictEqual(second.state.sliceStates.final, 'succeeded');
  assert.strictEqual(second.state.metrics.llmRoundTrips, 3);
  console.log('OK architect stepwise advances root slices in parallel, then final slice');
}

async function testMultiSliceClientReadBatch() {
  const state = initArchitectRun(blueprint(baseSlices().slice(0, 2)));
  const seenResumes = [];
  const mock = makeStepMock((agent, clientResult) => {
    if (clientResult) {
      seenResumes.push({ sliceId: agent.sliceId, results: clientResult.results });
      return {
        state: { ...agent, status: 'completed', pending: null, summary: `${agent.sliceId} read`, iteration: agent.iteration + 1 },
        control: 'done',
        payload: { summary: `${agent.sliceId} read` }
      };
    }
    return {
      state: {
        ...agent,
        status: 'awaiting_client',
        pending: {
          kind: 'single',
          requests: [{ id: 'r1', toolName: 'workbook.readRange', params: { sheet: agent.sliceId, target: 'A1:B2' } }]
        },
        iteration: agent.iteration + 1
      },
      control: 'await_client',
      payload: { requests: [{ id: 'r1', toolName: 'workbook.readRange', params: { sheet: agent.sliceId, target: 'A1:B2' } }] }
    };
  });

  const first = await advanceArchitectRun(state, {
    context: {},
    initAgentRunFn: initAgentRunMock,
    runAgentStepFn: mock.runAgentStepFn,
    maxParallel: 2
  });
  assert.strictEqual(first.control, 'await_client');
  assert.strictEqual(first.payload.requests.length, 2, 'requests from both slices are flattened');
  assert.ok(first.payload.requests.every(r => r.id.startsWith('slice_')), 'request ids are slice-scoped');
  assert.strictEqual(collectAwaitingClientBatch(first.state).requests.length, 2);

  const second = await advanceArchitectRun(state, {
    clientResult: { results: [{ data: { a: 1 } }, { data: { b: 2 } }] },
    runAgentStepFn: mock.runAgentStepFn,
    maxParallel: 2
  });
  assert.strictEqual(second.control, 'done');
  assert.deepStrictEqual(seenResumes.map(r => r.sliceId).sort(), ['a', 'b']);
  assert.strictEqual(seenResumes[0].results.length, 1, 'slice a receives only its staged result');
  assert.strictEqual(seenResumes[1].results.length, 1, 'slice b receives only its staged result');
  assert.strictEqual(mock.clientPeak(), 2, 'client-result resumes are stepped concurrently');
  assert.strictEqual(second.state.metrics.clientRoundTrips, 1);
  assert.strictEqual(second.state.metrics.llmRoundTrips, 2);
  console.log('OK architect stepwise batches client reads across slices and routes responses back');
}

async function testActionsTakePriorityOverReads() {
  const state = initArchitectRun(blueprint(baseSlices().slice(0, 2)));
  const mock = makeStepMock((agent) => {
    if (agent.sliceId === 'a') {
      return {
        state: { ...agent, status: 'running', iteration: agent.iteration + 1 },
        control: 'emit_actions',
        payload: { actions: [{ type: 'setCellRange', sheet: 'A', cells: { A1: 'x' } }] }
      };
    }
    return {
      state: {
        ...agent,
        status: 'awaiting_client',
        pending: { kind: 'single', requests: [{ id: 'r1', toolName: 'workbook.readSheet', params: { sheet: 'B' } }] },
        iteration: agent.iteration + 1
      },
      control: 'await_client',
      payload: { requests: [{ id: 'r1', toolName: 'workbook.readSheet', params: { sheet: 'B' } }] }
    };
  });

  const first = await advanceArchitectRun(state, {
    context: {},
    initAgentRunFn: initAgentRunMock,
    runAgentStepFn: mock.runAgentStepFn,
    maxParallel: 2
  });
  assert.strictEqual(first.control, 'emit_actions', 'writes are applied before reads');
  assert.strictEqual(first.payload.actions.length, 1);

  const second = await advanceArchitectRun(state, {
    context: {},
    initAgentRunFn: initAgentRunMock,
    runAgentStepFn: mock.runAgentStepFn,
    maxParallel: 2
  });
  assert.strictEqual(second.control, 'await_client', 'pending read is re-emitted after actions apply');
  assert.strictEqual(second.payload.requests.length, 1);
  assert.strictEqual(second.payload.requests[0].sliceId, 'b');
  assert.strictEqual(second.state.metrics.actionBatches, 1);
  console.log('OK architect stepwise applies writes before serving parallel read requests');
}

async function testDenseMaterialWriteAutoCompletesSlice() {
  const state = initArchitectRun(blueprint([
    {
      id: 'dense',
      title: 'Dense Schedule',
      deps: [],
      scope: { sheets_owned: ['Dense'], ranges_owned: ['Dense!A1:G1005'], may_read_from: [] },
      instructions: 'Build dense schedule with copyToRange.',
      estimated_iters: 12
    },
    {
      id: 'final',
      title: 'Format and Verify',
      deps: ['dense'],
      scope: { sheets_owned: [], ranges_owned: [], may_read_from: [] },
      instructions: 'Verify.',
      estimated_iters: 3
    }
  ]));
  const mock = makeStepMock((agent) => {
    if (agent.sliceId === 'dense') {
      return {
        state: { ...agent, status: 'running', iteration: agent.iteration + 1 },
        control: 'emit_actions',
        payload: {
          actions: [
            {
              type: 'setCellRange',
              sheet: 'Dense',
              cells: {
                A1: { value: 'Dense Schedule' },
                A6: { formula: '=ROW()-5' }
              },
              copyToRange: 'A6:G1005'
            }
          ]
        }
      };
    }
    return {
      state: { ...agent, status: 'completed', summary: 'final done', iteration: agent.iteration + 1 },
      control: 'done',
      payload: { summary: 'final done' }
    };
  });

  const first = await advanceArchitectRun(state, {
    context: {},
    initAgentRunFn: initAgentRunMock,
    runAgentStepFn: mock.runAgentStepFn,
    maxParallel: 1
  });
  assert.strictEqual(first.control, 'emit_actions');
  assert.strictEqual(first.state.sliceStates.dense, 'succeeded');
  assert.strictEqual(first.state.sliceResults.dense.status, 'completed_after_material_write');
  assert.ok(first.state.sliceResults.dense.cells >= 800);

  const second = await advanceArchitectRun(state, {
    context: {},
    initAgentRunFn: initAgentRunMock,
    runAgentStepFn: mock.runAgentStepFn,
    maxParallel: 1
  });
  assert.strictEqual(second.control, 'done');
  console.log('OK dense material writes auto-complete slice without waiting for ceremonial done');
}

async function testWritableSliceDoneWithoutWritesFails() {
  const state = initArchitectRun(blueprint([
    {
      id: 'empty',
      title: 'Empty Writer',
      deps: [],
      scope: { sheets_owned: ['Empty'], ranges_owned: ['Empty!A1:B10'], may_read_from: [] },
      instructions: 'Write real cells before done.',
      estimated_iters: 4
    },
    {
      id: 'downstream',
      title: 'Downstream',
      deps: ['empty'],
      scope: { sheets_owned: ['Downstream'], ranges_owned: ['Downstream!A1:B10'], may_read_from: ['Empty!A1:B10'] },
      instructions: 'Depends on Empty.',
      estimated_iters: 4
    }
  ]));
  const mock = makeStepMock((agent) => ({
    state: { ...agent, status: 'completed', summary: 'claimed done', iteration: 2 },
    control: 'done',
    payload: { summary: 'claimed done' }
  }));

  const result = await advanceArchitectRun(state, {
    context: {},
    initAgentRunFn: initAgentRunMock,
    runAgentStepFn: mock.runAgentStepFn,
    maxParallel: 1
  });

  assert.strictEqual(result.control, 'done');
  assert.strictEqual(result.state.sliceStates.empty, 'failed');
  assert.strictEqual(result.state.sliceResults.empty.status, 'failed_no_writes');
  assert.match(result.state.sliceResults.empty.error, /without writing any cells/);
  assert.strictEqual(result.state.sliceStates.downstream, 'skipped');
  console.log('OK writable slice done without writes fails and skips dependents');
}

async function testSliceWorkerPromptForcesReadBeforeWriteAndBansOfficeJs() {
  const bp = blueprint([
    { id: 'a',  title: 'A', deps: [], scope: { sheets_owned: ['A'], may_read_from: [] }, instructions: 'Build A', estimated_iters: 4 },
    { id: 'b',  title: 'B', deps: ['a'], scope: { sheets_owned: ['B'], may_read_from: ['A!A1:D20'] }, instructions: 'Build B referencing A', estimated_iters: 4 }
  ]);
  const sliceA = bp.slices.find(s => s.id === 'a');
  const sliceB = bp.slices.find(s => s.id === 'b');

  const promptA = buildSliceWorkerPrompt(sliceA, bp);
  const promptB = buildSliceWorkerPrompt(sliceB, bp);

  assert.ok(!/READ BEFORE YOU WRITE/.test(promptA), 'root slice with no upstream skips the read-first directive');
  assert.ok(/READ BEFORE YOU WRITE/.test(promptB), 'downstream slice gets the read-first directive');
  assert.ok(/execute_office_js is BLOCKED/.test(promptA), 'every slice is told execute_office_js is blocked');
  assert.ok(/execute_office_js is BLOCKED/.test(promptB), 'every slice is told execute_office_js is blocked');
  assert.ok(/copyToRange is FORMULAS ONLY/.test(promptA), 'every slice gets the copyToRange-text-flood guard');
  console.log('OK slice worker prompt enforces read-before-write on dependents and bans execute_office_js');
}

async function testDeterministicSliceActionsBypassWorkerLlm() {
  const prev = process.env.ALLOW_DETERMINISTIC_SLICES;
  process.env.ALLOW_DETERMINISTIC_SLICES = 'true';
  const state = initArchitectRun(blueprint([
    {
      id: 'det',
      title: 'Deterministic',
      deps: [],
      scope: { sheets_owned: ['Deterministic'], may_read_from: [] },
      instructions: 'Actions are authoritative',
      estimated_iters: 3,
      actions: [
        { tool: 'bulk_create_sheets', params: { names: ['Deterministic'] } },
        {
          tool: 'bulk_set_cell_ranges',
          params: {
            writes: [
              { sheet: 'Deterministic', cells: { A1: { value: 'Driver' }, B1: { value: 'Value' } } }
            ]
          }
        }
      ]
    }
  ]));
  if (prev === undefined) delete process.env.ALLOW_DETERMINISTIC_SLICES;
  else process.env.ALLOW_DETERMINISTIC_SLICES = prev;

  const first = await advanceArchitectRun(state, {
    context: {},
    initAgentRunFn: () => {
      throw new Error('initAgentRun must not be called for deterministic slice');
    },
    runAgentStepFn: async () => {
      throw new Error('runAgentStep must not be called for deterministic slice');
    },
    maxParallel: 1
  });

  assert.strictEqual(first.control, 'emit_actions');
  assert.strictEqual(first.payload.actions.length, 2);
  assert.deepStrictEqual(first.payload.actions.map(a => a.type), ['createSheet', 'setCellRange']);
  assert.ok(first.payload.actions.every(a => a._sliceId === 'det'));
  assert.strictEqual(first.state.sliceStates.det, 'succeeded');
  assert.strictEqual(first.state.metrics.llmRoundTrips, 0);
  assert.strictEqual(first.state.metrics.sliceStepCalls, 0);
  assert.strictEqual(first.state.metrics.deterministicSlices, 1);

  const second = await advanceArchitectRun(state, { context: {}, maxParallel: 1 });
  assert.strictEqual(second.control, 'done');
  console.log('OK deterministic slice actions bypass worker LLM and emit Excel actions directly');
}

async function testLegacySliceWithoutActionsUsesWorkerLlm() {
  const state = initArchitectRun(blueprint([
    { id: 'legacy', title: 'Legacy', deps: [], scope: { sheets_owned: ['Legacy'], may_read_from: [] }, instructions: 'Build via worker', estimated_iters: 4 }
  ]));
  const mock = makeStepMock((agent) => ({
    state: { ...agent, status: 'completed', summary: 'legacy done', iteration: agent.iteration + 1 },
    control: 'done',
    payload: { summary: 'legacy done' }
  }));

  const result = await advanceArchitectRun(state, {
    context: {},
    initAgentRunFn: initAgentRunMock,
    runAgentStepFn: mock.runAgentStepFn,
    maxParallel: 1
  });

  assert.strictEqual(result.control, 'done');
  assert.strictEqual(mock.calls.length, 1, 'legacy actionless slice should call runAgentStep');
  assert.strictEqual(result.state.metrics.llmRoundTrips, 1);
  assert.strictEqual(result.state.metrics.deterministicSlices, 0);
  console.log('OK legacy slice without actions still uses worker LLM');
}

(async function main() {
  await testParallelRootsThenFinal();
  await testMultiSliceClientReadBatch();
  await testActionsTakePriorityOverReads();
  await testDenseMaterialWriteAutoCompletesSlice();
  await testWritableSliceDoneWithoutWritesFails();
  await testSliceWorkerPromptForcesReadBeforeWriteAndBansOfficeJs();
  await testDeterministicSliceActionsBypassWorkerLlm();
  await testLegacySliceWithoutActionsUsesWorkerLlm();
  console.log('\narchitect stepwise tests completed.');
})().catch(err => {
  console.error('FAIL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
