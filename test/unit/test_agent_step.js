'use strict';

// Unit tests for the stepwise agent engine (initAgentRun + runAgentStep).
// The LLM is mocked via deps.callLLM; tool execution uses the real
// executeAgentTool through the collect/replay brokers (read formatters and
// write action builders need no registry/network), so these tests are hermetic.

const assert = require('assert');
const { initAgentRun, runAgentStep } = require('../../server/agents/agentLoop.js');

const CTX = { activeSheet: 'Sheet1', workbookSheets: ['Sheet1'] };

// Build a deps object whose callLLM yields the scripted responses in order.
function scripted(responses) {
  const queue = [...responses];
  return {
    callLLM: async () => {
      if (queue.length === 0) throw new Error('mock LLM: no more scripted responses');
      return queue.shift();
    }
  };
}

function assertSerializable(state, label) {
  let round;
  try { round = JSON.parse(JSON.stringify(state)); }
  catch (e) { throw new Error(`${label}: state not JSON-serializable: ${e.message}`); }
  assert.ok(round && typeof round === 'object', `${label}: round-trip produced object`);
}

(async function main() {
  /* 1) done → control 'done', status completed */
  {
    const state = initAgentRun('build a thing', CTX, { promptVariant: 'fast' });
    const deps = scripted([{ thought: 'finished', tool: 'done', params: { summary: 'all set' } }]);
    const { state: s, control, payload } = await runAgentStep(state, null, deps);
    assert.strictEqual(control, 'done', 'done → control done');
    assert.strictEqual(s.status, 'completed');
    assert.strictEqual(payload.summary, 'all set');
    assertSerializable(s, 'done');
    console.log('OK done → control=done, status=completed');
  }

  /* 2) write tool (set_cell_range) → emit_actions, no client round-trip */
  {
    const state = initAgentRun('write cells', CTX, { promptVariant: 'fast' });
    const deps = scripted([{
      thought: 'writing',
      tool: 'set_cell_range',
      params: { sheet: 'Sheet1', cells: { A1: 'hello', B1: 42 } }
    }]);
    const { state: s, control, payload } = await runAgentStep(state, null, deps);
    assert.strictEqual(control, 'emit_actions', 'write → emit_actions');
    assert.ok(Array.isArray(payload.actions) && payload.actions.length >= 1, 'actions emitted');
    assert.strictEqual(payload.actions[0].type, 'setCellRange');
    assert.ok(payload.actions[0].explanation, 'action auto-enriched with explanation');
    assert.strictEqual(s.pending, null, 'no pending after write');
    assertSerializable(s, 'write');
    console.log('OK set_cell_range → control=emit_actions');
  }

  /* 3) client read (read_sheet) → await_client → resume → continue */
  {
    const state = initAgentRun('read a sheet', CTX, { promptVariant: 'fast' });
    const deps = scripted([{ thought: 'reading', tool: 'read_sheet', params: { sheet: 'Sheet1' } }]);
    const first = await runAgentStep(state, null, deps);
    assert.strictEqual(first.control, 'await_client', 'read → await_client');
    assert.strictEqual(first.payload.requests.length, 1, 'one client request');
    assert.strictEqual(first.payload.requests[0].toolName, 'workbook.readSheet', 'mapped to client read tool');
    assert.ok(first.state.pending && first.state.pending.kind === 'single', 'pending single set');
    assert.strictEqual(first.state.status, 'awaiting_client');
    assertSerializable(first.state, 'await_client');

    // Resume with client-provided data. deps has no more scripted LLM calls —
    // a resume must NOT call the LLM (it only integrates the tool result).
    const clientResult = { results: [{ data: { sheet: 'Sheet1', values: [[1, 2], [3, 4]], rowCount: 2, columnCount: 2 } }] };
    const resumed = await runAgentStep(first.state, clientResult, deps);
    assert.strictEqual(resumed.control, 'continue', 'resume read → continue');
    assert.strictEqual(resumed.state.pending, null, 'pending cleared after resume');
    assert.strictEqual(resumed.state.status, 'running');
    const lastResult = resumed.state.results[resumed.state.results.length - 1];
    assert.strictEqual(lastResult.type, 'tool', 'tool result recorded');
    assert.strictEqual(lastResult.tool, 'read_sheet');
    console.log('OK read_sheet → await_client → resume → continue');
  }

  /* 4) re-emit when awaiting and resumed without clientResult */
  {
    const state = initAgentRun('read again', CTX, { promptVariant: 'fast' });
    const deps = scripted([{ thought: 'reading', tool: 'read_sheet', params: { sheet: 'Sheet1' } }]);
    const first = await runAgentStep(state, null, deps);
    assert.strictEqual(first.control, 'await_client');
    const reEmit = await runAgentStep(first.state, null, deps);
    assert.strictEqual(reEmit.control, 'await_client', 're-emit await_client when no clientResult');
    assert.strictEqual(reEmit.payload.requests.length, 1, 're-emit carries pending requests');
    console.log('OK await_client re-emits on missing clientResult');
  }

  /* 5) parse failure → continue, parseFailureStreak incremented */
  {
    const state = initAgentRun('parse fail', CTX, { promptVariant: 'fast' });
    const deps = scripted([{ raw: 'not json at all', jsonError: 'Unexpected token' }]);
    const { state: s, control } = await runAgentStep(state, null, deps);
    assert.strictEqual(control, 'continue', 'parse fail → continue');
    assert.strictEqual(s.parseFailureStreak, 1, 'streak incremented');
    console.log('OK parse failure → control=continue (streak=1)');
  }

  /* 6) empty tool → continue */
  {
    const state = initAgentRun('empty tool', CTX, { promptVariant: 'fast' });
    const deps = scripted([{ thought: 'hmm', tool: '', params: {} }]);
    const { control } = await runAgentStep(state, null, deps);
    assert.strictEqual(control, 'continue', 'empty tool → continue');
    console.log('OK empty tool → control=continue');
  }

  /* 7) parallel_calls of two client reads → await_client(2) → resume → continue */
  {
    const state = initAgentRun('parallel reads', CTX, { promptVariant: 'fast' });
    const deps = scripted([{
      thought: 'batch read',
      tool: 'parallel_calls',
      params: {
        calls: [
          { tool: 'read_sheet', params: { sheet: 'Sheet1' } },
          { tool: 'get_range_as_csv', params: { sheet: 'Sheet1', target: 'A1:B2' } }
        ]
      }
    }]);
    const first = await runAgentStep(state, null, deps);
    assert.strictEqual(first.control, 'await_client', 'parallel client reads → await_client');
    assert.strictEqual(first.payload.requests.length, 2, 'two client requests collected');
    assert.strictEqual(first.state.pending.kind, 'parallel', 'pending parallel');
    assertSerializable(first.state, 'parallel-await');

    const clientResult = {
      results: [
        { data: { sheet: 'Sheet1', values: [[1]], rowCount: 1, columnCount: 1 } },
        { data: { sheet: 'Sheet1', target: 'A1:B2', csv: '1,2\n3,4', rowCount: 2, columnCount: 2 } }
      ]
    };
    const resumed = await runAgentStep(first.state, clientResult, deps);
    assert.strictEqual(resumed.control, 'continue', 'parallel resume → continue');
    const last = resumed.state.results[resumed.state.results.length - 1];
    assert.strictEqual(last.tool, 'parallel_calls');
    assert.strictEqual(last.result.summary.total, 2, 'two sub-results stitched');
    assert.strictEqual(last.result.summary.ok, 2, 'both sub-reads ok');
    console.log('OK parallel_calls(reads) → await_client(2) → resume → continue');
  }

  /* 8) ask_user_question → paused (or auto-answered continue); paused resumes */
  {
    const state = initAgentRun('ask the user', CTX, { promptVariant: 'fast' });
    const deps = scripted([{
      thought: 'need input',
      tool: 'ask_user_question',
      params: { questions: [{ header: 'Pick', question: 'Which scenario?', options: [{ label: 'Base' }, { label: 'Bull' }] }] }
    }]);
    const first = await runAgentStep(state, null, deps);
    assert.ok(['paused', 'continue'].includes(first.control), 'ask → paused or auto-answered continue');
    if (first.control === 'paused') {
      assert.ok(first.payload.question, 'question payload present');
      assert.strictEqual(first.state.status, 'paused');
      const resumed = await runAgentStep(first.state, { response: { answers: ['Base'] } }, deps);
      assert.strictEqual(resumed.control, 'continue', 'question resume → continue');
      assert.strictEqual(resumed.state.pending, null, 'pending cleared after answer');
      console.log('OK ask_user_question → paused → resume → continue');
    } else {
      console.log('OK ask_user_question → auto-answered → continue');
    }
  }

  /* 9) todo_write → continue, recorded as todo_write result + todoWrite event */
  {
    const state = initAgentRun('plan todos', CTX, { promptVariant: 'fast' });
    let todoEvent = null;
    const deps = scripted([{ thought: 'planning', tool: 'todo_write', params: { todos: [{ status: 'in_progress', content: 'build IS' }] } }]);
    deps.onProgress = (t, d) => { if (t === 'todoWrite') todoEvent = d; };
    const { state: s, control } = await runAgentStep(state, null, deps);
    assert.strictEqual(control, 'continue', 'todo_write → continue');
    assert.ok(todoEvent && Array.isArray(todoEvent.todos), 'todoWrite progress event emitted');
    assert.strictEqual(s.results[s.results.length - 1].type, 'todo_write', 'todo_write result recorded');
    console.log('OK todo_write → control=continue + todoWrite event');
  }

  /* 10) web_search over cap → continue without executing (no network).
        Pre-seed the counter past the cap so the guard fires before dispatch. */
  {
    const state = initAgentRun('search web', CTX, { promptVariant: 'fast' });
    state.webSearchCount = state.config.maxWebSearch; // next web_search exceeds
    const deps = scripted([{ thought: 'searching', tool: 'web_search', params: { query: 'x' } }]);
    const { state: s, control } = await runAgentStep(state, null, deps);
    assert.strictEqual(control, 'continue', 'web cap → continue (not executed)');
    const last = s.results[s.results.length - 1];
    assert.strictEqual(last.type, 'error', 'cap recorded as error result');
    assert.match(last.error, /Maximum web search/, 'cap message');
    console.log('OK web_search over cap → control=continue (no network)');
  }

  /* 11) consecutive LLM errors → aborted after maxConsecutiveErrors */
  {
    const state = initAgentRun('flaky llm', CTX, { promptVariant: 'fast', maxConsecutiveErrors: 3 });
    const deps = { callLLM: async () => { throw new Error('provider boom'); } };
    let control;
    for (let i = 0; i < 3; i++) {
      ({ control } = await runAgentStep(state, null, deps));
    }
    assert.strictEqual(control, 'aborted', 'repeated identical errors → aborted');
    assert.match(state.abortReason, /repeated_error/, 'abort reason flags repeated error');
    console.log('OK consecutive LLM errors → control=aborted');
  }

  /* 12) set_cell_range allow_overwrite=false → preflight via client → conflict → continue */
  {
    const state = initAgentRun('safe write', CTX, { promptVariant: 'fast' });
    const deps = scripted([{
      thought: 'guarded write',
      tool: 'set_cell_range',
      params: { sheet: 'Sheet1', cells: { A1: 'new' }, allow_overwrite: false }
    }]);
    const first = await runAgentStep(state, null, deps);
    assert.strictEqual(first.control, 'await_client', 'preflight needs a client read');
    assert.strictEqual(first.payload.requests[0].toolName, 'workbook.readRange', 'preflight reads target range');

    // Client reports the target already has data → conflict path.
    const conflict = await runAgentStep(first.state, { results: [{ data: { values: [['existing']] } }] }, deps);
    assert.strictEqual(conflict.control, 'continue', 'conflict → continue (no actions emitted)');
    const last = conflict.state.results[conflict.state.results.length - 1];
    assert.strictEqual(last.type, 'preflight_conflict', 'conflict recorded');
    console.log('OK set_cell_range preflight conflict (via client) → continue');
  }

  console.log('\nagent step tests completed.');
})().catch(err => {
  console.error('FAIL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
