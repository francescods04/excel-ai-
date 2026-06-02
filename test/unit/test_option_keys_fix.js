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

// Load via vm to extract internal helpers.
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
const FORMAT_TOOLS_FOR_LOOP_DETECTION = new Set(['set_format', 'bulk_set_format']);
${extractFn('summarizeFormatOptionsForHistory')}
${extractFn('compactToolParamsForHistory')}
${extractFn('detectFormatErrorLoop')}
function compactWriteForHistory(write) { return { sheet: write?.sheet, target: write?.target, cells: write?.cells || {} }; }
function shouldCompactCellMapForHistory(){ return false; }
function summarizeCellMapForHistory(){ return {}; }
module.exports = { summarizeFormatOptionsForHistory, compactToolParamsForHistory, detectFormatErrorLoop };
`;
vm.runInContext(code, sandbox);
const { summarizeFormatOptionsForHistory, compactToolParamsForHistory, detectFormatErrorLoop } = sandbox.module.exports;

async function main() {
  // ─── summarizeFormatOptionsForHistory ─────────────────────────────────
  await test('summarizeFormatOptionsForHistory passes through small objects', () => {
    const out = summarizeFormatOptionsForHistory({ bold: true, fontColor: '#666' });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { bold: true, fontColor: '#666' });
  });

  await test('summarizeFormatOptionsForHistory truncates oversize objects', () => {
    const big = {};
    for (let i = 0; i < 100; i++) big['k' + i] = 'very_long_value_string_'.repeat(5);
    const out = summarizeFormatOptionsForHistory(big);
    const serialized = JSON.stringify(out);
    assert.ok(serialized.length < 300, `expected truncation, got ${serialized.length}`);
    assert.strictEqual(out._truncated, true);
  });

  await test('summarizeFormatOptionsForHistory returns empty on falsy input', () => {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(summarizeFormatOptionsForHistory(null))), {});
    assert.deepStrictEqual(JSON.parse(JSON.stringify(summarizeFormatOptionsForHistory(undefined))), {});
    assert.deepStrictEqual(JSON.parse(JSON.stringify(summarizeFormatOptionsForHistory('str'))), {});
  });

  // ─── compactToolParamsForHistory uses "options" key, not "optionKeys" ──
  await test('compactToolParamsForHistory(set_format) emits "options" not "optionKeys"', () => {
    const out = compactToolParamsForHistory('set_format', {
      sheet: 'S1', target: 'A1:B2', options: { bold: true, fontColor: '#000' }
    });
    assert.ok(!('optionKeys' in out), 'must not emit optionKeys');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(out.options)), { bold: true, fontColor: '#000' });
  });

  await test('compactToolParamsForHistory(bulk_set_format) emits "options" per entry', () => {
    const out = compactToolParamsForHistory('bulk_set_format', {
      formats: [
        { sheet: 'S', target: 'A1', options: { bold: true } },
        { sheet: 'S', target: 'B2', style: { numberFormat: '#,##0' } }
      ]
    });
    assert.strictEqual(out.formatCount, 2);
    for (const f of out.formats) {
      assert.ok(!('optionKeys' in f), `expected "options", got ${Object.keys(f).join(',')}`);
      assert.ok('options' in f);
    }
    assert.deepStrictEqual(JSON.parse(JSON.stringify(out.formats[0].options)), { bold: true });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(out.formats[1].options)), { numberFormat: '#,##0' });
  });

  // ─── detectFormatErrorLoop ────────────────────────────────────────────
  await test('detectFormatErrorLoop returns null for non-format tools', () => {
    assert.strictEqual(detectFormatErrorLoop([], 'set_cell_range'), null);
  });

  await test('detectFormatErrorLoop returns null with <3 errors', () => {
    const results = [
      { type: 'tool', tool: 'bulk_set_format', result: { error: 'bulk_set_format: missing options.' } },
      { type: 'tool', tool: 'bulk_set_format', result: { error: 'bulk_set_format: missing options.' } }
    ];
    assert.strictEqual(detectFormatErrorLoop(results, 'bulk_set_format'), null);
  });

  await test('detectFormatErrorLoop fires after 3 consecutive missing-options errors', () => {
    const results = [
      { type: 'tool', tool: 'bulk_set_format', result: { error: 'missing options.' } },
      { type: 'tool', tool: 'bulk_set_format', result: { error: 'missing options.' } },
      { type: 'tool', tool: 'bulk_set_format', result: { error: 'missing options.' } }
    ];
    const nudge = detectFormatErrorLoop(results, 'bulk_set_format');
    assert.ok(nudge && typeof nudge === 'string', 'expected nudge string');
    assert.ok(nudge.includes('FORMAT-LOOP DETECTED'));
    assert.ok(nudge.includes('"options"'));
    assert.ok(nudge.includes('formats'));
  });

  await test('detectFormatErrorLoop fires for sub-error reasons in errors array', () => {
    const results = [
      { type: 'tool', tool: 'bulk_set_format', result: { errors: [{ reason: 'missing options. Keys seen: [optionKeys]' }] } },
      { type: 'tool', tool: 'bulk_set_format', result: { errors: [{ reason: 'missing options. Keys seen: [optionKeys]' }] } },
      { type: 'tool', tool: 'bulk_set_format', result: { errors: [{ reason: 'missing options. Keys seen: [optionKeys]' }] } }
    ];
    const nudge = detectFormatErrorLoop(results, 'bulk_set_format');
    assert.ok(nudge);
  });

  await test('detectFormatErrorLoop does NOT fire when a successful call breaks the streak', () => {
    const results = [
      { type: 'tool', tool: 'bulk_set_format', result: { error: 'missing options.' } },
      { type: 'tool', tool: 'bulk_set_format', result: { ok: true, applied: 4 } },
      { type: 'tool', tool: 'bulk_set_format', result: { error: 'missing options.' } },
      { type: 'tool', tool: 'bulk_set_format', result: { error: 'missing options.' } }
    ];
    assert.strictEqual(detectFormatErrorLoop(results, 'bulk_set_format'), null);
  });

  await test('detectFormatErrorLoop does NOT fire on unrelated errors', () => {
    const results = [
      { type: 'tool', tool: 'bulk_set_format', result: { error: 'rate limited' } },
      { type: 'tool', tool: 'bulk_set_format', result: { error: 'rate limited' } },
      { type: 'tool', tool: 'bulk_set_format', result: { error: 'rate limited' } }
    ];
    assert.strictEqual(detectFormatErrorLoop(results, 'bulk_set_format'), null);
  });
}

main();
