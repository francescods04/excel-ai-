const assert = require('assert');
const Module = require('module');

// --- Stub the tool registry BEFORE requiring agentLoop so executeTool() resolves to our spy ---
const callsByTool = new Map();
const responses = new Map();

function setResponse(tool, value) { responses.set(tool, value); }
function setError(tool, err) { responses.set(tool, { __error: err }); }
function recordCall(tool, params) {
  const list = callsByTool.get(tool) || [];
  list.push(params);
  callsByTool.set(tool, list);
}

const stubExecute = async (toolName, params) => {
  recordCall(toolName, params);
  const r = responses.get(toolName);
  if (!r) return { data: { __default: true, tool: toolName, params } };
  if (r && r.__error) throw new Error(r.__error);
  return { data: r };
};

const registryPath = require.resolve('../../server/tools/registry.js');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (parent && parent.filename && parent.filename.endsWith('/agents/agentLoop.js')) {
    if (request === '../tools/registry' || request === '../tools/registry.js') {
      return {
        executeTool: stubExecute,
        meta: () => null,
        has: () => false
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { executeAgentTool } = require('../../server/agents/agentLoop.js');

(async function main() {
  // 1) finance_company_bundle fans out 5 OpenBB calls in parallel
  responses.clear();
  callsByTool.clear();
  setResponse('openbb.equity.profile',               { sector: 'Tech', mcap: 1e12 });
  setResponse('openbb.equity.fundamentals.metrics',  { pe: 30 });
  setResponse('openbb.equity.fundamentals.balance',  [{ year: 2024, cash: 100 }]);
  setResponse('openbb.equity.fundamentals.income',   [{ year: 2024, revenue: 200 }]);
  setResponse('openbb.equity.fundamentals.cash',     [{ year: 2024, fcf: 50 }]);

  const t0 = Date.now();
  const bundle = await executeAgentTool(
    'finance_company_bundle',
    { symbol: 'AAPL' },
    { messages: [], iteration: 0 },
    null
  );
  const dtBundle = Date.now() - t0;

  assert.strictEqual(bundle.symbol, 'AAPL', 'symbol forwarded');
  assert.strictEqual(bundle.period, 'annual', 'default period = annual');
  assert.deepStrictEqual(bundle.profile,  { sector: 'Tech', mcap: 1e12 });
  assert.deepStrictEqual(bundle.metrics,  { pe: 30 });
  assert.deepStrictEqual(bundle.balance,  [{ year: 2024, cash: 100 }]);
  assert.deepStrictEqual(bundle.income,   [{ year: 2024, revenue: 200 }]);
  assert.deepStrictEqual(bundle.cashflow, [{ year: 2024, fcf: 50 }]);
  assert.strictEqual(bundle.errors, undefined, 'no error key when everything succeeds');

  assert.strictEqual(callsByTool.get('openbb.equity.profile').length, 1);
  assert.strictEqual(callsByTool.get('openbb.equity.fundamentals.metrics').length, 1);
  assert.strictEqual(callsByTool.get('openbb.equity.fundamentals.balance').length, 1);
  assert.strictEqual(callsByTool.get('openbb.equity.fundamentals.income').length, 1);
  assert.strictEqual(callsByTool.get('openbb.equity.fundamentals.cash').length, 1);
  assert.ok(dtBundle < 200, `bundle should complete fast (stubbed): ${dtBundle}ms`);
  console.log(`OK finance_company_bundle parallel-fetched 5 datasets in ${dtBundle}ms`);

  // 2) Partial failure → other datasets still returned, errors surface per dataset
  responses.clear();
  callsByTool.clear();
  setResponse('openbb.equity.profile',              { sector: 'Tech' });
  setError('openbb.equity.fundamentals.metrics',    'rate limited');
  setResponse('openbb.equity.fundamentals.balance', [{ y: 1 }]);
  setError('openbb.equity.fundamentals.income',     'provider down');
  setResponse('openbb.equity.fundamentals.cash',    [{ y: 2 }]);

  const partial = await executeAgentTool(
    'finance_company_bundle',
    { symbol: 'NVDA', period: 'quarter' },
    { messages: [], iteration: 0 },
    null
  );
  assert.strictEqual(partial.period, 'quarter');
  assert.deepStrictEqual(partial.profile,  { sector: 'Tech' });
  assert.deepStrictEqual(partial.balance,  [{ y: 1 }]);
  assert.deepStrictEqual(partial.cashflow, [{ y: 2 }]);
  assert.strictEqual(partial.metrics, undefined, 'failed datasets are absent');
  assert.strictEqual(partial.income,  undefined);
  assert.deepStrictEqual(Object.keys(partial.errors).sort(), ['income', 'metrics']);
  assert.strictEqual(partial.errors.metrics, 'rate limited');
  console.log('OK finance_company_bundle surfaces per-dataset errors without blocking the rest');

  // 3) Missing symbol → soft error, no network calls
  responses.clear();
  callsByTool.clear();
  const missingSymbol = await executeAgentTool(
    'finance_company_bundle',
    {},
    { messages: [], iteration: 0 },
    null
  );
  assert.match(missingSymbol.error, /symbol/, 'missing symbol surfaces helpful error');
  assert.strictEqual(callsByTool.size, 0, 'no network attempts when symbol missing');
  console.log('OK finance_company_bundle rejects missing symbol without firing requests');

  // 4) include filter limits the fan-out
  responses.clear();
  callsByTool.clear();
  setResponse('openbb.equity.profile', { sector: 'X' });
  setResponse('openbb.equity.fundamentals.metrics', { pe: 1 });
  const narrow = await executeAgentTool(
    'finance_company_bundle',
    { symbol: 'MSFT', include: ['profile', 'metrics'] },
    { messages: [], iteration: 0 },
    null
  );
  assert.ok(narrow.profile && narrow.metrics, 'requested datasets present');
  assert.strictEqual(narrow.balance, undefined);
  assert.strictEqual(narrow.income, undefined);
  assert.strictEqual(narrow.cashflow, undefined);
  assert.strictEqual(callsByTool.size, 2, 'only requested tools invoked');
  console.log('OK finance_company_bundle respects "include" filter');

  // 5) macro_snapshot fans out all 5 macro series in parallel
  responses.clear();
  callsByTool.clear();
  setResponse('openbb.fixedincome.treasury',  [{ tenor: '10y', yield: 4.5 }]);
  setResponse('openbb.fixedincome.effr',      [{ rate: 5.25 }]);
  setResponse('openbb.economy.cpi',           [{ y: 2024, cpi: 3.1 }]);
  setResponse('openbb.economy.gdp_real',      [{ y: 2024, gdp: 2.5 }]);
  setResponse('openbb.economy.unemployment',  [{ y: 2024, u: 3.8 }]);
  const macro = await executeAgentTool(
    'macro_snapshot',
    {},
    { messages: [], iteration: 0 },
    null
  );
  assert.strictEqual(macro.country, 'united_states', 'default country');
  assert.deepStrictEqual(macro.treasury,     [{ tenor: '10y', yield: 4.5 }]);
  assert.deepStrictEqual(macro.fed_rate,     [{ rate: 5.25 }]);
  assert.deepStrictEqual(macro.cpi,          [{ y: 2024, cpi: 3.1 }]);
  assert.deepStrictEqual(macro.gdp,          [{ y: 2024, gdp: 2.5 }]);
  assert.deepStrictEqual(macro.unemployment, [{ y: 2024, u: 3.8 }]);
  assert.strictEqual(macro.errors, undefined);
  console.log('OK macro_snapshot parallel-fetched 5 macro series');

  console.log('\nfinance bundle tests completed.');
})().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
