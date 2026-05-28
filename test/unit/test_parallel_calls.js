const assert = require('assert');
const Module = require('module');

// Stub the tool registry before agentLoop loads it
const calls = [];
const responses = new Map();
const stubExecute = async (toolName, params) => {
  calls.push({ toolName, params });
  const r = responses.get(toolName);
  if (!r) return { data: { __echo: true, tool: toolName } };
  if (r && r.__throw) throw new Error(r.__throw);
  return { data: r };
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (parent && parent.filename && parent.filename.endsWith('/agents/agentLoop.js')) {
    if (request === '../tools/registry' || request === '../tools/registry.js') {
      return { executeTool: stubExecute, meta: () => null, has: () => false };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { executeAgentTool } = require('../../server/agents/agentLoop.js');

(async function main() {
  // 1) Happy path: 3 read-only tools dispatched in parallel, results in input order
  responses.clear(); calls.length = 0;
  responses.set('openbb.equity.profile', { sector: 'Tech' });
  responses.set('openbb.fixedincome.treasury', [{ tenor: '10y', y: 4.5 }]);
  responses.set('openbb.economy.cpi', [{ y: 2024, cpi: 3.1 }]);

  const t0 = Date.now();
  const r = await executeAgentTool(
    'parallel_calls',
    {
      calls: [
        { tool: 'openbb_equity_profile', params: { symbol: 'AAPL' } },
        { tool: 'openbb_treasury_rates', params: {} },
        { tool: 'openbb_cpi', params: { country: 'united_states' } }
      ]
    },
    { messages: [], iteration: 0 },
    null
  );
  const dt = Date.now() - t0;

  assert.ok(Array.isArray(r.results) && r.results.length === 3, 'three results returned');
  assert.strictEqual(r.summary.ok, 3);
  assert.strictEqual(r.summary.errors, 0);
  assert.strictEqual(r.results[0].tool, 'openbb_equity_profile');
  assert.strictEqual(r.results[0].ok, true);
  assert.deepStrictEqual(r.results[0].value, { sector: 'Tech' });
  assert.strictEqual(r.results[1].tool, 'openbb_treasury_rates');
  assert.deepStrictEqual(r.results[1].value, [{ tenor: '10y', y: 4.5 }]);
  assert.ok(dt < 200, `should complete fast in stub mode, got ${dt}ms`);
  console.log(`OK parallel_calls dispatched 3 read-only tools in parallel (${dt}ms)`);

  // 2) Mutation tool inside batch is rejected with explicit error
  responses.clear(); calls.length = 0;
  const r2 = await executeAgentTool(
    'parallel_calls',
    {
      calls: [
        { tool: 'openbb_equity_profile', params: { symbol: 'AAPL' } },
        { tool: 'set_cell_range', params: { sheet: 'X', cells: { A1: { value: 1 } } } }
      ]
    },
    { messages: [], iteration: 0 },
    null
  );
  assert.strictEqual(r2.results[0].ok, true, 'safe tool still executes');
  assert.strictEqual(r2.results[1].ok, false, 'mutation rejected');
  assert.match(r2.results[1].error, /not allowed/);
  // Mutation tool must NOT have been dispatched
  const dispatched = calls.map(c => c.toolName);
  assert.ok(!dispatched.includes('excel.setCellRange'), 'mutation tool never reached registry');
  console.log('OK parallel_calls blocks mutation tools without dispatching them');

  // 3) Nested parallel_calls forbidden
  const r3 = await executeAgentTool(
    'parallel_calls',
    {
      calls: [
        { tool: 'parallel_calls', params: { calls: [] } },
        { tool: 'openbb_treasury_rates', params: {} }
      ]
    },
    { messages: [], iteration: 0 },
    null
  );
  assert.strictEqual(r3.results[0].ok, false);
  assert.match(r3.results[0].error, /nested/);
  console.log('OK parallel_calls cannot be nested');

  // 4) Partial failure: one tool throws, others still complete
  responses.clear(); calls.length = 0;
  responses.set('openbb.equity.profile', { sector: 'Tech' });
  responses.set('openbb.fixedincome.treasury', { __throw: 'provider 503' });
  responses.set('openbb.economy.cpi', [{ y: 2024, cpi: 3.1 }]);
  const r4 = await executeAgentTool(
    'parallel_calls',
    {
      calls: [
        { tool: 'openbb_equity_profile', params: { symbol: 'AAPL' } },
        { tool: 'openbb_treasury_rates', params: {} },
        { tool: 'openbb_cpi', params: { country: 'united_states' } }
      ]
    },
    { messages: [], iteration: 0 },
    null
  );
  assert.strictEqual(r4.results[0].ok, true);
  assert.strictEqual(r4.results[1].ok, false);
  assert.match(r4.results[1].error, /503/);
  assert.strictEqual(r4.results[2].ok, true);
  assert.strictEqual(r4.summary.ok, 2);
  assert.strictEqual(r4.summary.errors, 1);
  console.log('OK parallel_calls surfaces per-call errors without blocking the rest');

  // 5) Cap: > 8 calls rejected as a whole
  const tooMany = Array.from({ length: 9 }, () => ({ tool: 'openbb_treasury_rates', params: {} }));
  const r5 = await executeAgentTool(
    'parallel_calls',
    { calls: tooMany },
    { messages: [], iteration: 0 },
    null
  );
  assert.match(r5.error, /max 8/, 'over-cap batch rejected');
  console.log('OK parallel_calls enforces max 8 calls per batch');

  // 6) Empty / missing calls -> soft error, no dispatch
  const r6 = await executeAgentTool(
    'parallel_calls',
    { calls: [] },
    { messages: [], iteration: 0 },
    null
  );
  assert.match(r6.error, /non-empty/);
  console.log('OK parallel_calls rejects empty batch');

  console.log('\nparallel_calls tests completed.');
})().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
