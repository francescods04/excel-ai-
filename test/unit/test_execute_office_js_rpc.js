const assert = require('assert');
const { executeAgentTool } = require('../../server/agents/agentLoop.js');

(async function main() {
  // 1. With requestClientTool available -> result is returned, no actions fired
  {
    const calls = [];
    const requestClientTool = async (toolName, params) => {
      calls.push({ toolName, params });
      return { ok: true, value: [[1, 2], [3, 4]], logs: ['[log] hi'] };
    };
    const result = await executeAgentTool(
      'execute_office_js',
      { code: 'return [[1,2],[3,4]];' },
      { messages: [], iteration: 0 },
      requestClientTool
    );
    assert.strictEqual(calls.length, 1, 'requestClientTool called exactly once');
    assert.strictEqual(calls[0].toolName, 'runJavaScript', 'RPC routed to runJavaScript');
    assert.strictEqual(calls[0].params.code, 'return [[1,2],[3,4]];', 'code forwarded verbatim');
    assert.strictEqual(result.ok, true, 'result.ok forwarded');
    assert.deepStrictEqual(result.value, [[1, 2], [3, 4]], 'result.value forwarded');
    assert.deepStrictEqual(result.logs, ['[log] hi'], 'logs forwarded');
    assert.strictEqual(result.actions, undefined, 'no actions emitted on successful RPC path');
    console.log('OK execute_office_js RPC delivers value + logs and skips legacy action dispatch');
  }

  // 2. RPC reports an error (not a throw) -> error shape propagated to LLM
  {
    const requestClientTool = async () => ({ ok: false, error: 'TypeError: x is undefined', logs: ['[error] boom'] });
    const result = await executeAgentTool(
      'execute_office_js',
      { code: 'broken' },
      { messages: [], iteration: 0 },
      requestClientTool
    );
    assert.strictEqual(result.error, 'TypeError: x is undefined', 'error surfaced from client');
    assert.deepStrictEqual(result.logs, ['[error] boom'], 'logs preserved alongside error');
    assert.match(result._message, /execute_office_js error: TypeError/, '_message readable by LLM');
    console.log('OK execute_office_js surfaces client error with logs');
  }

  // 3. requestClientTool throws -> fallback to legacy action dispatch (no silent loss)
  {
    const requestClientTool = async () => { throw new Error('Client read timeout (30s) for runJavaScript'); };
    const result = await executeAgentTool(
      'execute_office_js',
      { code: 'whatever' },
      { messages: [], iteration: 0 },
      requestClientTool
    );
    assert.ok(Array.isArray(result.actions) && result.actions.length === 1, 'fallback emits one action');
    assert.strictEqual(result.actions[0].type, 'runJavaScript');
    assert.strictEqual(result.actions[0].code, 'whatever');
    assert.match(result._message, /RPC failed/, 'fallback signals to LLM');
    console.log('OK execute_office_js falls back to legacy action when RPC transport fails');
  }

  // 4. No requestClientTool (server-only harness) -> legacy action dispatch
  {
    const result = await executeAgentTool(
      'execute_office_js',
      { code: 'console.log(1)' },
      { messages: [], iteration: 0 },
      null
    );
    assert.ok(Array.isArray(result.actions), 'legacy path emits actions');
    assert.strictEqual(result.actions[0].type, 'runJavaScript');
    assert.strictEqual(result.actions[0].code, 'console.log(1)');
    console.log('OK execute_office_js legacy path preserved when no RPC channel');
  }

  console.log('\nexecute_office_js RPC tests completed.');
})().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
