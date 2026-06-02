const assert = require('assert');

async function test(name, fn) {
  try {
    await fn();
    console.log(`OK ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

// Pull recovery function via a lightweight require — agentLoop is heavy, so
// we load only the module and access internals through a property access.
// agentLoop.js doesn't export the helper; mirror it here for isolated testing.
// To keep this test honest, we re-extract it via runInThisContext.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'agents', 'agentLoop.js'), 'utf8');

function extractFn(name) {
  const re = new RegExp(`(function ${name}\\([\\s\\S]*?\\n\\})\\n`);
  const m = src.match(re);
  if (!m) throw new Error(`fn ${name} not found in agentLoop.js`);
  return m[1];
}

const sandbox = { module: {}, exports: {} };
vm.createContext(sandbox);
const code = `
${extractFn('tryRecoverExcessClosers')}
${extractFn('tryRecoverMissingCommas')}
${extractFn('tryRecoverTruncatedAgentJson')}
module.exports = { tryRecoverTruncatedAgentJson, tryRecoverMissingCommas, tryRecoverExcessClosers };
`;
vm.runInContext(code, sandbox);
const { tryRecoverTruncatedAgentJson, tryRecoverMissingCommas, tryRecoverExcessClosers } = sandbox.module.exports;

async function main() {
  await test('recovers truncated JSON (open brace)', () => {
    const raw = '{"tool":"set_cell_range","params":{"cells":{"A1":{"value":1}';
    const out = tryRecoverTruncatedAgentJson(raw);
    assert.ok(out, 'should recover');
    assert.strictEqual(out.tool, 'set_cell_range');
    assert.strictEqual(JSON.stringify(out.params.cells.A1), JSON.stringify({ value: 1 }));
  });

  await test('recovers missing comma between objects in array', () => {
    const raw = '{"tool":"bulk_set_cell_ranges","params":{"ranges":[{"sheet":"S","cells":{"A1":{"value":1}}} {"sheet":"S","cells":{"A2":{"value":2}}}]}}';
    const out = tryRecoverTruncatedAgentJson(raw);
    assert.ok(out, 'should recover');
    assert.strictEqual(out.tool, 'bulk_set_cell_ranges');
    assert.strictEqual(out.params.ranges.length, 2);
  });

  await test('recovers missing comma between key-value pairs', () => {
    const raw = '{"tool":"set_cell_range" "params":{"cells":{"A1":{"value":1}}}}';
    const out = tryRecoverTruncatedAgentJson(raw);
    assert.ok(out);
    assert.strictEqual(out.tool, 'set_cell_range');
  });

  await test('does not corrupt valid JSON containing string with brackets', () => {
    const raw = '{"tool":"x","params":{"text":"[hello]{world}"}}';
    // Valid JSON parse first; our helper should still produce a valid parse
    // even if invoked on syntactically clean input (returns null from
    // truncated path; from missing-comma path returns object).
    const out = tryRecoverMissingCommas(raw);
    assert.ok(out);
    assert.strictEqual(out.params.text, '[hello]{world}');
  });

  await test('returns null on unrecoverable garbage', () => {
    const raw = 'not even json';
    assert.strictEqual(tryRecoverTruncatedAgentJson(raw), null);
  });

  await test('recovers excess trailing closer (extra "}" at end)', () => {
    const raw = '{"tool":"set_cell_range","params":{"cells":{"A1":{"value":1}}}}}';
    const out = tryRecoverTruncatedAgentJson(raw);
    assert.ok(out, 'should recover');
    assert.strictEqual(out.tool, 'set_cell_range');
  });

  await test('recovers excess closer in middle (real DCF iter 7 shape)', () => {
    // Reproduction of the 2026-06-02 DCF E2E parse fail: one extra `}` between
    // the deepest object close and the array bracket.
    const raw = '{"thought":"x","tool":"bulk_set_cell_ranges","params":{"writes":[{"sheet":"V","cells":{"B3":{"formula":"=SUM(B3:F3)","cellStyles":{"fontColor":"#000","bold":true,"numberFormat":"#,##0.0"}}}}}]}}';
    const out = tryRecoverTruncatedAgentJson(raw);
    assert.ok(out, 'should recover surgically');
    assert.strictEqual(out.tool, 'bulk_set_cell_ranges');
    assert.strictEqual(out.params.writes[0].sheet, 'V');
  });

  await test('does not over-strip valid JSON', () => {
    const raw = '{"tool":"done","params":{"summary":"ok"}}';
    // Already valid → recovery shouldn't be invoked, but if it were, must be safe
    const out = tryRecoverExcessClosers(raw, 5);
    // Either null (no excess detected) or returns parsed shape — must not crash
    assert.ok(out === null || out.tool === 'done');
  });
}

main();
