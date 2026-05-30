'use strict';

const assert = require('assert');
const {
  initArchitectRun,
  advanceArchitectRun,
  collectAwaitingClientBatch
} = require('../../server/agents/architectStepwise');
const { validateBlueprint } = require('../../server/agents/architect');

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

(async function main() {
  await testParallelRootsThenFinal();
  await testMultiSliceClientReadBatch();
  await testActionsTakePriorityOverReads();
  console.log('\narchitect stepwise tests completed.');
})().catch(err => {
  console.error('FAIL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
