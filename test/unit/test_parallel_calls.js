const assert = require('assert');
const Module = require('module');

// ---------------------------------------------------------------------------
// Stub the tool registry before agentLoop loads it. Each test resets state.
// Supports synchronous responses, thrown errors, and timed delays so we can
// verify true parallelism via wall-clock.
// ---------------------------------------------------------------------------
const calls = [];                     // every dispatched (toolName, params)
const responses = new Map();          // toolName → response | { __throw } | { __delayMs, __value }
let stubInflight = 0;
let stubPeakInflight = 0;

const stubExecute = async (toolName, params) => {
  calls.push({ toolName, params });
  const r = responses.get(toolName);
  if (!r) return { data: { __echo: true, tool: toolName } };
  if (r && typeof r === 'object' && r.__throw) throw new Error(r.__throw);
  if (r && typeof r === 'object' && typeof r.__delayMs === 'number') {
    stubInflight++;
    stubPeakInflight = Math.max(stubPeakInflight, stubInflight);
    try {
      await new Promise(res => setTimeout(res, r.__delayMs));
    } finally {
      stubInflight--;
    }
    return { data: r.__value !== undefined ? r.__value : { delayed: r.__delayMs } };
  }
  return { data: r };
};

function resetStub() {
  responses.clear();
  calls.length = 0;
  stubInflight = 0;
  stubPeakInflight = 0;
}

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

const baseCtx = { messages: [], iteration: 0 };
const run = (params) => executeAgentTool('parallel_calls', params, baseCtx, null);

// ---------------------------------------------------------------------------
// Test cases (small helpers return a 1-line label printed on success).
// ---------------------------------------------------------------------------

async function test_happy_path_three_read_only() {
  resetStub();
  responses.set('openbb.equity.profile', { sector: 'Tech' });
  responses.set('openbb.fixedincome.treasury', [{ tenor: '10y', y: 4.5 }]);
  responses.set('openbb.economy.cpi', [{ y: 2024, cpi: 3.1 }]);

  const t0 = Date.now();
  const r = await run({
    calls: [
      { tool: 'openbb_equity_profile', params: { symbol: 'AAPL' } },
      { tool: 'openbb_treasury_rates', params: {} },
      { tool: 'openbb_cpi', params: { country: 'united_states' } }
    ]
  });
  const dt = Date.now() - t0;

  assert.ok(Array.isArray(r.results) && r.results.length === 3);
  assert.deepStrictEqual(r.summary, { total: 3, ok: 3, errors: 0 });
  assert.strictEqual(r.results[0].tool, 'openbb_equity_profile');
  assert.strictEqual(r.results[0].ok, true);
  assert.deepStrictEqual(r.results[0].value, { sector: 'Tech' });
  assert.strictEqual(r.results[1].tool, 'openbb_treasury_rates');
  assert.deepStrictEqual(r.results[1].value, [{ tenor: '10y', y: 4.5 }]);
  assert.strictEqual(r.results[2].tool, 'openbb_cpi');
  assert.deepStrictEqual(r.results[2].value, [{ y: 2024, cpi: 3.1 }]);
  assert.ok(dt < 200, `should complete fast in stub mode, got ${dt}ms`);
  return `3 read-only tools (${dt}ms)`;
}

async function test_true_parallelism_wall_clock() {
  // 5 tools, each delays 30ms. If serial → ≥150ms. Parallel → ~30ms + overhead.
  // Use 80ms cap to catch serialization bugs while absorbing event-loop jitter.
  resetStub();
  const DELAY = 30;
  const tools = ['openbb_equity_profile', 'openbb_treasury_rates', 'openbb_cpi',
                 'openbb_fed_rate', 'openbb_unemployment'];
  const stubKey = t => t.replace(/^openbb_/, 'openbb.').replace('treasury_rates', 'fixedincome.treasury')
    .replace('cpi', 'economy.cpi').replace('fed_rate', 'economy.fed_rate')
    .replace('unemployment', 'economy.unemployment').replace('equity_profile', 'equity.profile');
  for (const t of tools) responses.set(stubKey(t), { __delayMs: DELAY, __value: { tool: t } });

  const t0 = Date.now();
  const r = await run({ calls: tools.map(t => ({ tool: t, params: {} })) });
  const dt = Date.now() - t0;

  assert.strictEqual(r.summary.ok, 5);
  assert.strictEqual(r.summary.errors, 0);
  assert.ok(stubPeakInflight >= 4,
    `expected ≥4 concurrent stub calls, saw peak=${stubPeakInflight}`);
  assert.ok(dt < DELAY * 5 - 30,
    `serial would be ${DELAY * 5}ms; parallel must be much less, got ${dt}ms`);
  return `5×${DELAY}ms tools in ${dt}ms, peak=${stubPeakInflight}`;
}

async function test_order_preserved_under_jitter() {
  // Slow tool at index 0, fast tool at index 1. Results MUST still come back
  // in the original input order regardless of which finishes first.
  resetStub();
  responses.set('openbb.equity.profile',     { __delayMs: 40, __value: { i: 0, name: 'slow' } });
  responses.set('openbb.fixedincome.treasury',{ __delayMs: 2,  __value: { i: 1, name: 'fast' } });
  responses.set('openbb.economy.cpi',        { __delayMs: 20, __value: { i: 2, name: 'mid' } });

  const r = await run({
    calls: [
      { tool: 'openbb_equity_profile', params: {} },
      { tool: 'openbb_treasury_rates', params: {} },
      { tool: 'openbb_cpi',            params: {} }
    ]
  });
  assert.strictEqual(r.results[0].value.name, 'slow', 'index 0 preserved');
  assert.strictEqual(r.results[1].value.name, 'fast');
  assert.strictEqual(r.results[2].value.name, 'mid');
  return 'input-order preserved despite jitter';
}

async function test_mutation_blocked_without_dispatch() {
  resetStub();
  const r = await run({
    calls: [
      { tool: 'openbb_equity_profile', params: { symbol: 'AAPL' } },
      { tool: 'set_cell_range', params: { sheet: 'X', cells: { A1: { value: 1 } } } },
      { tool: 'apply_formats', params: { sheet: 'X' } }
    ]
  });
  assert.strictEqual(r.results[0].ok, true);
  assert.strictEqual(r.results[1].ok, false);
  assert.match(r.results[1].error, /not allowed/);
  assert.strictEqual(r.results[2].ok, false);
  assert.match(r.results[2].error, /not allowed/);
  assert.strictEqual(r.summary.errors, 2);
  const dispatched = calls.map(c => c.toolName);
  assert.ok(!dispatched.includes('excel.setCellRange'), 'mutation never reached registry');
  assert.ok(!dispatched.includes('excel.applyFormats'),  'mutation never reached registry');
  return 'mutations rejected before dispatch';
}

async function test_nested_parallel_calls_rejected() {
  resetStub();
  const r = await run({
    calls: [
      { tool: 'parallel_calls', params: { calls: [] } },
      { tool: 'openbb_treasury_rates', params: {} }
    ]
  });
  assert.strictEqual(r.results[0].ok, false);
  assert.match(r.results[0].error, /nested/);
  assert.strictEqual(r.results[1].ok, true);
  // Recursive call must never have entered the executor with nested parallel_calls.
  assert.ok(!calls.some(c => c.toolName === 'parallel_calls'));
  return 'nesting rejected';
}

async function test_partial_failure_does_not_block_rest() {
  resetStub();
  responses.set('openbb.equity.profile', { sector: 'Tech' });
  responses.set('openbb.fixedincome.treasury', { __throw: 'provider 503' });
  responses.set('openbb.economy.cpi', [{ y: 2024, cpi: 3.1 }]);
  const r = await run({
    calls: [
      { tool: 'openbb_equity_profile', params: {} },
      { tool: 'openbb_treasury_rates', params: {} },
      { tool: 'openbb_cpi',            params: {} }
    ]
  });
  assert.strictEqual(r.results[0].ok, true);
  assert.strictEqual(r.results[1].ok, false);
  assert.match(r.results[1].error, /503/);
  assert.strictEqual(r.results[2].ok, true);
  assert.deepStrictEqual(r.summary, { total: 3, ok: 2, errors: 1 });
  return 'partial failures isolated';
}

async function test_all_fail() {
  resetStub();
  responses.set('openbb.equity.profile',      { __throw: 'boom 1' });
  responses.set('openbb.fixedincome.treasury',{ __throw: 'boom 2' });
  const r = await run({
    calls: [
      { tool: 'openbb_equity_profile', params: {} },
      { tool: 'openbb_treasury_rates', params: {} }
    ]
  });
  assert.strictEqual(r.summary.ok, 0);
  assert.strictEqual(r.summary.errors, 2);
  assert.match(r.results[0].error, /boom 1/);
  assert.match(r.results[1].error, /boom 2/);
  return 'all-fail batch reports all errors';
}

async function test_over_cap_rejected() {
  resetStub();
  const tooMany = Array.from({ length: 9 }, () => ({ tool: 'openbb_treasury_rates', params: {} }));
  const r = await run({ calls: tooMany });
  assert.match(r.error, /max 8/);
  assert.strictEqual(calls.length, 0, 'nothing dispatched on over-cap rejection');
  return '>8 batch rejected wholesale';
}

async function test_exactly_at_cap_succeeds() {
  // Boundary: 8 is the explicit limit and must succeed.
  resetStub();
  responses.set('openbb.economy.cpi', { ok: 1 });
  const eight = Array.from({ length: 8 }, () => ({ tool: 'openbb_cpi', params: {} }));
  const r = await run({ calls: eight });
  assert.strictEqual(r.summary.total, 8);
  assert.strictEqual(r.summary.ok, 8);
  return 'cap boundary (n=8) accepted';
}

async function test_empty_batch_rejected() {
  resetStub();
  const r = await run({ calls: [] });
  assert.match(r.error, /non-empty/);
  assert.strictEqual(calls.length, 0);

  // Missing `calls` field entirely should also be rejected.
  const r2 = await run({});
  assert.match(r2.error, /non-empty/);
  return 'empty/missing batch rejected';
}

async function test_missing_tool_field_marked_per_call() {
  // A single bad entry should not poison the whole batch.
  resetStub();
  responses.set('openbb.economy.cpi', { ok: 1 });
  const r = await run({
    calls: [
      { tool: '', params: {} },
      { params: { foo: 1 } },                          // no `tool` at all
      { tool: 'openbb_cpi', params: {} }
    ]
  });
  assert.strictEqual(r.results[0].ok, false);
  assert.match(r.results[0].error, /missing "tool"/);
  assert.strictEqual(r.results[1].ok, false);
  assert.match(r.results[1].error, /missing "tool"/);
  assert.strictEqual(r.results[2].ok, true);
  // Bad entries never reached registry.
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].toolName, 'openbb.economy.cpi');
  return 'malformed entries marked but do not block batch';
}

async function test_unknown_tool_rejected_by_allowlist() {
  resetStub();
  const r = await run({
    calls: [
      { tool: 'random_made_up_tool', params: {} },
      { tool: 'read_workbook', params: {} } // valid allowlisted (will go to client path → error, but allowed)
    ]
  });
  assert.strictEqual(r.results[0].ok, false);
  assert.match(r.results[0].error, /not allowed/);
  // The unknown tool must not have been sent to the registry.
  assert.ok(!calls.some(c => c.toolName === 'random_made_up_tool'));
  return 'unknown tool rejected pre-dispatch';
}

async function test_params_forwarded_intact() {
  resetStub();
  responses.set('openbb.equity.profile', { sector: 'X' });
  const params = { symbol: 'AAPL', period: 'annual', limit: 5 };
  await run({ calls: [{ tool: 'openbb_equity_profile', params }] });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].params, params);
  return 'inner params forwarded verbatim';
}

// ---------------------------------------------------------------------------
// Runner — sequential because tests share module-level stub state.
// ---------------------------------------------------------------------------
(async function main() {
  const suite = [
    ['happy path 3 read-only',         test_happy_path_three_read_only],
    ['true parallelism (wall-clock)',  test_true_parallelism_wall_clock],
    ['order preserved under jitter',   test_order_preserved_under_jitter],
    ['mutation blocked + no dispatch', test_mutation_blocked_without_dispatch],
    ['nested rejected',                test_nested_parallel_calls_rejected],
    ['partial failure isolated',       test_partial_failure_does_not_block_rest],
    ['all fail',                       test_all_fail],
    ['over-cap (>8) rejected',         test_over_cap_rejected],
    ['cap boundary (n=8)',             test_exactly_at_cap_succeeds],
    ['empty/missing batch',            test_empty_batch_rejected],
    ['malformed entries per-call',     test_missing_tool_field_marked_per_call],
    ['unknown tool rejected',          test_unknown_tool_rejected_by_allowlist],
    ['params forwarded intact',        test_params_forwarded_intact]
  ];

  const t0 = Date.now();
  let failed = 0;
  for (const [name, fn] of suite) {
    try {
      const note = await fn();
      console.log(`OK ${name} — ${note}`);
    } catch (err) {
      failed++;
      console.error(`FAIL ${name}:`, err && err.message);
      if (err && err.stack) console.error(err.stack.split('\n').slice(0, 5).join('\n'));
    }
  }
  const dt = Date.now() - t0;
  if (failed > 0) {
    console.error(`\n${failed}/${suite.length} parallel_calls tests FAILED in ${dt}ms`);
    process.exit(1);
  }
  console.log(`\nAll ${suite.length} parallel_calls tests passed in ${dt}ms.`);
})().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
