const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

async function test(name, fn) {
  try { await fn(); console.log(`OK ${name}`); }
  catch (e) { console.error(`FAIL ${name}`); console.error(e); process.exitCode = 1; }
}

const src = fs.readFileSync(require.resolve('../../server/agents/agentLoop.js'), 'utf8');
function extractFn(name) {
  const re = new RegExp(`(function ${name}\\([\\s\\S]*?\\n\\})\\n`);
  const m = src.match(re);
  if (!m) throw new Error(`fn ${name} not found`);
  return m[1];
}
const sb = { module: {}, exports: {} };
vm.createContext(sb);
const code = `
${extractFn('extractSheetHintFromToolResult')}
${extractFn('collectBlockingErrors')}
module.exports = { collectBlockingErrors };
`;
vm.runInContext(code, sb);
const { collectBlockingErrors } = sb.module.exports;

async function main() {
  await test('empty results → ok', () => {
    const r = collectBlockingErrors([]);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.blockingErrors.length, 0);
  });

  await test('single error blocks', () => {
    const r = collectBlockingErrors([
      { type: 'tool', tool: 'set_cell_range', params: { sheet: 'S' }, result: { error: 'invalid range' } }
    ]);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blockingErrors.length, 1);
  });

  await test('later successful write on same sheet supersedes earlier error', () => {
    // Real-world: set_cell_range rejected (copyToRange text label), then
    // successful set_cell_range or bulk_set_cell_ranges on same sheet.
    const results = [
      { type: 'tool', tool: 'set_cell_range', params: { sheet: 'Projections' }, result: { error: 'copyToRange rejected' } },
      { type: 'tool', tool: 'set_cell_range', params: { sheet: 'Projections' }, result: { ok: true, actions: [{ sheet: 'Projections' }] } }
    ];
    const r = collectBlockingErrors(results);
    assert.strictEqual(r.ok, true, `expected supersession, got blocking=${JSON.stringify(r.blockingErrors)}`);
  });

  await test('successful bulk supersedes earlier set_cell_range error (same family)', () => {
    const results = [
      { type: 'tool', tool: 'set_cell_range', params: { sheet: 'Projections' }, result: { error: 'foo' } },
      { type: 'tool', tool: 'bulk_set_cell_ranges', params: { writes: [{ sheet: 'Projections' }] }, result: { ok: true, actions: [{ sheet: 'Projections' }] } }
    ];
    const r = collectBlockingErrors(results);
    assert.strictEqual(r.ok, true);
  });

  await test('later success on DIFFERENT sheet does NOT supersede', () => {
    const results = [
      { type: 'tool', tool: 'set_cell_range', params: { sheet: 'Projections' }, result: { error: 'foo' } },
      { type: 'tool', tool: 'set_cell_range', params: { sheet: 'Assumptions' }, result: { ok: true, actions: [{ sheet: 'Assumptions' }] } }
    ];
    const r = collectBlockingErrors(results);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blockingErrors.length, 1);
  });

  await test('format error not superseded by write success (different family)', () => {
    const results = [
      { type: 'tool', tool: 'bulk_set_format', params: { formats: [{ sheet: 'S' }] }, result: { error: 'missing options' } },
      { type: 'tool', tool: 'set_cell_range', params: { sheet: 'S' }, result: { ok: true, actions: [{ sheet: 'S' }] } }
    ];
    const r = collectBlockingErrors(results);
    assert.strictEqual(r.ok, false, 'write success in different family must not clear format error');
  });

  await test('per-entry errors superseded by later success', () => {
    const results = [
      { type: 'tool', tool: 'bulk_set_cell_ranges', params: { writes: [{ sheet: 'Projections' }] }, result: { errors: [{ sheet: 'Projections', target: 'B2', reason: 'bad formula' }] } },
      { type: 'tool', tool: 'bulk_set_cell_ranges', params: { writes: [{ sheet: 'Projections' }] }, result: { ok: true, actions: [{ sheet: 'Projections' }] } }
    ];
    const r = collectBlockingErrors(results);
    assert.strictEqual(r.ok, true);
  });

  await test('most recent error remains blocking even if earlier success exists', () => {
    const results = [
      { type: 'tool', tool: 'set_cell_range', params: { sheet: 'S' }, result: { ok: true, actions: [{ sheet: 'S' }] } },
      { type: 'tool', tool: 'set_cell_range', params: { sheet: 'S' }, result: { error: 'new failure' } }
    ];
    const r = collectBlockingErrors(results);
    assert.strictEqual(r.ok, false, 'recent error must block');
  });
}

main();
