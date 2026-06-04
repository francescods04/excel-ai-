'use strict';

const assert = require('assert');
const {
  detectToolStagnation,
  detectNoProgress,
  detectSameToolRejectLoop,
  hasRecentBulkRejections,
  detectSemanticErrorLoop,
  formatToolStagnationReason,
  buildToolStagnationSignature,
  extractSheetHint,
  extractReadTargetKey,
  normalizeStagnationValue,
  STAGNATION_WATCH_TOOLS,
  READ_ONLY_TOOLS_FOR_STAGNATION,
  PRODUCTIVE_TOOLS,
  WRITE_TOOLS_FOR_REJECT_GUARD
} = require('../../server/agents/loopDetectors');

let passed = 0, failed = 0;
function t(label, fn) {
  try { fn(); passed++; console.log(`  ✓ ${label}`); }
  catch (e) { failed++; console.log(`  ✗ ${label}\n     ${e.message}`); process.exitCode = 1; }
}

function sig(tool, params) {
  return { toolName: tool, signature: buildToolStagnationSignature(tool, params), sheetHint: extractSheetHint(params) };
}

function toolResult(tool, result) { return { type: 'tool', tool, result }; }
function errResult(tool, msg) { return toolResult(tool, { error: msg }); }
function okResult(tool) { return toolResult(tool, { ok: true, applied: 1, actions: [{}] }); }

console.log('test_loop_detectors_edge');

// ═══════════════ detectToolStagnation ═══════════════

// ── Empty / invalid input ──

t('detectToolStagnation: empty trail returns null', () => {
  assert.strictEqual(detectToolStagnation([]), null);
});

t('detectToolStagnation: null trail returns null', () => {
  assert.strictEqual(detectToolStagnation(null), null);
});

t('detectToolStagnation: undefined trail returns null', () => {
  assert.strictEqual(detectToolStagnation(undefined), null);
});

t('detectToolStagnation: trail entries without toolName are handled safely', () => {
  const trail = [{}, { toolName: 'read_sheet' }];
  assert.strictEqual(detectToolStagnation(trail, 4), null);
});

// ── Non-watched tools do not trigger ──

t('detectToolStagnation: non-watched tool repeated 10 times does not fire', () => {
  const trail = Array.from({ length: 10 }, (_, i) => ({
    toolName: 'set_cell_range',
    signature: `x:${i}`
  }));
  assert.strictEqual(detectToolStagnation(trail, 4, 3), null);
});

// ── Repeat pattern ──

t('detectToolStagnation: repeat pattern exactly at threshold', () => {
  const params = { ranges: [{ sheet: 'DCF', target: 'B5' }] };
  const trail = Array.from({ length: 4 }, () => sig('get_cell_ranges', params));
  const r = detectToolStagnation(trail, 4, 3);
  assert.ok(r);
  assert.strictEqual(r.pattern, 'repeat');
});

t('detectToolStagnation: repeat pattern fires with custom maxRepeat=3', () => {
  const params = { sheet: 'S' };
  const trail = Array.from({ length: 3 }, () => sig('read_sheet', params));
  const r = detectToolStagnation(trail, 3, 3);
  assert.ok(r);
  assert.strictEqual(r.pattern, 'repeat');
});

t('detectToolStagnation: repeat below threshold does not fire', () => {
  const params = { sheet: 'S' };
  const trail = Array.from({ length: 3 }, () => sig('read_sheet', params));
  assert.strictEqual(detectToolStagnation(trail, 4, 3), null);
});

// ── Alternating pattern ──

t('detectToolStagnation: alternates between two different watched tools', () => {
  const r1 = sig('get_cell_ranges', { ranges: [{ sheet: 'A' }] });
  const r2 = sig('execute_office_js', { code: 'await Excel.run(async (ctx) => {});' });
  const trail = [r1, r2, r1, r2, r1, r2];
  const stagnation = detectToolStagnation(trail, 4, 3);
  assert.ok(stagnation);
  assert.strictEqual(stagnation.pattern, 'alternating');
});

t('detectToolStagnation: alternating with different signatures in pair does not fire', () => {
  const r1a = sig('read_sheet', { sheet: 'A' });
  const r1b = sig('read_sheet', { sheet: 'B' });
  const r2 = sig('execute_office_js', { code: 'x' });
  const trail = [r1a, r2, r1b, r2, r1a, r2];
  // The even entries have different signatures, so the alternating pattern won't match
  const r = detectToolStagnation(trail, 4, 3);
  assert.strictEqual(r, null, 'different even signatures break alternating pattern');
});

t('detectToolStagnation: alternating at exact altCycles=3 gives 6 entries', () => {
  const r1 = sig('read_sheet', { sheet: 'S' });
  const r2 = sig('execute_office_js', { code: 'x' });
  const trail = [r1, r2, r1, r2, r1, r2];
  const stagnation = detectToolStagnation(trail, 6, 3);
  assert.ok(stagnation);
  assert.strictEqual(stagnation.pattern, 'alternating');
});

// ── Read-thrash ──

t('detectToolStagnation: 6 identical reads of same sheet = repeat pattern', () => {
  const trail = Array.from({ length: 6 }, () => sig('get_cell_ranges',
    { ranges: [{ sheet: 'Revenue', target: 'A1' }] }));
  const r = detectToolStagnation(trail);
  assert.ok(r);
  assert.strictEqual(r.pattern, 'repeat');
});

t('detectToolStagnation: read-thrash does NOT fire on multi-sheet exploration', () => {
  const trail = [
    sig('read_sheet', { sheet: 'Revenue' }),
    sig('read_sheet', { sheet: 'WACC' }),
    sig('read_sheet', { sheet: 'Sensitivity' }),
    sig('read_sheet', { sheet: 'Costs' }),
    sig('read_sheet', { sheet: 'Summary' }),
    sig('read_sheet', { sheet: 'DCF' })
  ];
  const r = detectToolStagnation(trail);
  assert.strictEqual(r, null, '6 different sheets = legitimate exploration, not thrash');
});

t('detectToolStagnation: read-thrash with ≤2 distinct named sheets and dominant sheet fires', () => {
  const trail = [
    sig('read_sheet', { sheet: 'Revenue' }),
    sig('read_sheet', { sheet: 'Revenue' }),
    sig('read_sheet', { sheet: 'Revenue' }),
    sig('read_sheet', { sheet: 'Revenue' }),
    sig('read_sheet', { sheet: 'Costs' }),
    sig('read_sheet', { sheet: 'Revenue' })
  ];
  const r = detectToolStagnation(trail);
  assert.ok(r);
  assert.strictEqual(r.pattern, 'read_thrash');
});

t('detectToolStagnation: all-unknown-sheet identical reads = repeat, not read-thrash', () => {
  // build_workbook_graph has no sheetHint
  const trail = Array.from({ length: 6 }, () => ({
    toolName: 'build_workbook_graph',
    signature: 'build_workbook_graph:{}'
  }));
  const r = detectToolStagnation(trail);
  assert.strictEqual(r?.pattern, 'repeat', '6 identical calls = repeat loop');
});

// ── Tight read-thrash ──

t('detectToolStagnation: tight_read_thrash fires on 5 reads of same sheet+target', () => {
  const trail = [
    sig('get_cell_ranges', { ranges: [{ sheet: 'S', target: 'B5' }] }),
    sig('get_cell_ranges', { ranges: [{ sheet: 'S', target: 'B5' }] }),
    sig('get_cell_ranges', { ranges: [{ sheet: 'S', target: 'B5' }] }),
    sig('get_cell_ranges', { ranges: [{ sheet: 'S', target: 'B5' }] }),
    sig('get_cell_ranges', { ranges: [{ sheet: 'S', target: 'B5' }] }),
    sig('read_sheet', { sheet: 'S' }),
    sig('get_cell_ranges', { ranges: [{ sheet: 'S', target: 'B5' }] })
  ];
  const r = detectToolStagnation(trail);
  assert.ok(r);
  assert.strictEqual(r.pattern, 'tight_read_thrash');
});

t('detectToolStagnation: tight_read_thrash does not fire with only 4 same-target reads', () => {
  const trail = [
    sig('get_cell_ranges', { ranges: [{ sheet: 'S', target: 'B5' }] }),
    sig('get_cell_ranges', { ranges: [{ sheet: 'S', target: 'B5' }] }),
    sig('get_cell_ranges', { ranges: [{ sheet: 'S', target: 'B5' }] }),
    sig('get_cell_ranges', { ranges: [{ sheet: 'S', target: 'B5' }] })
  ];
  // Only 4 in window — below threshold 5
  const r = detectToolStagnation(trail);
  // might still be caught by read_thrash (6 reads)
  if (r) assert.notStrictEqual(r.pattern, 'tight_read_thrash', '4 reads should not fire tight_read_thrash');
  else assert.ok(true, 'no detection as expected');
});

// ── Destructive loop ──

t('detectToolStagnation: destructive loop fires on delete→create same sheet twice', () => {
  const trail = [
    sig('create_sheet', { sheet: 'Revenue' }),
    sig('read_sheet', { sheet: 'Revenue' }),
    sig('read_sheet', { sheet: 'Revenue' }),
    sig('delete_sheet', { sheet: 'Revenue' }),
    sig('create_sheet', { sheet: 'Revenue' }),
    sig('read_sheet', { sheet: 'Revenue' }),
    sig('delete_sheet', { sheet: 'Revenue' }),
    sig('create_sheet', { sheet: 'Revenue' })
  ];
  const r = detectToolStagnation(trail);
  assert.ok(r);
  assert.strictEqual(r.pattern, 'destructive_loop');
});

t('detectToolStagnation: destructive loop does not fire on single delete→create', () => {
  const trail = [
    sig('create_sheet', { sheet: 'Revenue' }),
    sig('read_sheet', { sheet: 'Revenue' }),
    sig('delete_sheet', { sheet: 'Revenue' }),
    sig('create_sheet', { sheet: 'Revenue' })
  ];
  const r = detectToolStagnation(trail);
  if (r) assert.notStrictEqual(r.pattern, 'destructive_loop');
});

// ── Confabulation guard: legitimate exploration should not fire ──

t('detectToolStagnation: complex multi-sheet exploration (confabulation guard)', () => {
  const trail = [
    sig('read_sheet', { sheet: 'Assumptions' }),
    sig('read_sheet', { sheet: 'Revenue' }),
    sig('get_cell_ranges', { ranges: [{ sheet: 'Assumptions', target: 'B2:B10' }] }),
    sig('read_sheet', { sheet: 'Capex' }),
    sig('get_cell_ranges', { ranges: [{ sheet: 'Revenue', target: 'A1:D20' }] }),
    sig('read_sheet', { sheet: 'WACC' }),
    sig('read_sheet', { sheet: 'Summary' }),
    sig('get_cell_ranges', { ranges: [{ sheet: 'Capex', target: 'A1:B15' }] })
  ];
  // 8 reads, mapped to distinct sheets → legitimate exploration
  const r = detectToolStagnation(trail);
  assert.strictEqual(r, null, 'multi-sheet exploration must not trigger false positive');
});

// ═══════════════ detectNoProgress ═══════════════

t('detectNoProgress: empty results returns null', () => {
  assert.strictEqual(detectNoProgress([]), null);
  assert.strictEqual(detectNoProgress(null), null);
});

t('detectNoProgress: all productive tools → no detection', () => {
  const results = Array.from({ length: 15 }, (_, i) => okResult('set_cell_range'));
  assert.strictEqual(detectNoProgress(results), null);
});

t('detectNoProgress: 12 unproductive iter returns no_progress', () => {
  const results = Array.from({ length: 12 }, (_, i) => errResult('set_cell_range', 'failed'));
  const r = detectNoProgress(results);
  assert.ok(r);
  assert.strictEqual(r.pattern, 'no_progress');
});

t('detectNoProgress: reads-only for 12 iters triggers no_progress', () => {
  const results = Array.from({ length: 12 }, () => toolResult('get_cell_ranges', { data: [] }));
  const r = detectNoProgress(results);
  assert.ok(r);
  assert.strictEqual(r.pattern, 'no_progress');
});

t('detectNoProgress: productive tool with action but also error field still resets', () => {
  // hasError is checked after PRODUCTIVE_TOOLS — if hasError, it's unproductive
  const results = Array.from({ length: 12 }, () => toolResult('set_cell_range', { error: 'some error', actions: [{ a: 1 }] }));
  const r = detectNoProgress(results);
  assert.ok(r, 'should fire because productive tool had error');
});

t('detectNoProgress: non-array results handled safely', () => {
  assert.strictEqual(detectNoProgress('garbage'), null);
  assert.strictEqual(detectNoProgress({}), null);
});

t('detectNoProgress: mixed productive/unproductive does not fire', () => {
  const results = [
    ...Array.from({ length: 5 }, () => toolResult('get_cell_ranges', { data: [] })),
    okResult('set_cell_range'),
    ...Array.from({ length: 5 }, () => toolResult('get_cell_ranges', { data: [] })),
    okResult('set_cell_range'),
    ...Array.from({ length: 5 }, () => toolResult('get_cell_ranges', { data: [] }))
  ];
  const r = detectNoProgress(results);
  assert.strictEqual(r, null);
});

t('detectNoProgress: done-blocked entries between unproductive writes count toward run', () => {
  const results = [];
  for (let i = 0; i < 6; i++) results.push(errResult('set_cell_range', 'fail'));
  results.push({ type: 'done', tool: 'done', result: {} }); // blocked done
  for (let i = 0; i < 6; i++) results.push(errResult('set_cell_range', 'fail'));
  const r = detectNoProgress(results);
  assert.ok(r);
  assert.strictEqual(r.pattern, 'no_progress');
});

t('detectNoProgress: custom limit of 5 fires earlier', () => {
  const results = Array.from({ length: 5 }, () => errResult('bulk_set_cell_ranges', 'bad'));
  const r = detectNoProgress(results, { limit: 5 });
  assert.ok(r);
});

t('detectNoProgress: non-tool entries are skipped in the run count', () => {
  const results = [
    { type: 'error', error: 'guard' },
    { type: 'error', error: 'guard' },
    ...Array.from({ length: 12 }, () => errResult('set_cell_range', 'bad'))
  ];
  const r = detectNoProgress(results);
  assert.ok(r);
});

t('detectNoProgress: empty-error-string productive tool still counts as unproductive', () => {
  const results = Array.from({ length: 12 }, () => toolResult('set_cell_range', { error: '', actions: [] }));
  const r = detectNoProgress(results);
  // error is empty string, hasError should be false since error.length === 0
  // But PRODUCTIVE_TOOLS check: tool is in set, and hasError is false → resets to null
  assert.strictEqual(r, null, 'empty error string with productive tool = progress');
});

// ═══════════════ detectSameToolRejectLoop ═══════════════

t('detectSameToolRejectLoop: error as array format counts as rejection', () => {
  const results = Array.from({ length: 5 }, () => toolResult('bulk_set_cell_ranges',
    { errors: [{ index: 0, reason: 'bad shape' }, { index: 1, reason: 'bad shape' }] }));
  const r = detectSameToolRejectLoop(results);
  assert.ok(r);
  assert.strictEqual(r.tool, 'bulk_set_cell_ranges');
});

t('detectSameToolRejectLoop: actions emitted during rejection do NOT count', () => {
  const results = Array.from({ length: 5 }, () => toolResult('bulk_set_cell_ranges',
    { error: 'partial fail', actions: [{ a: 1 }] }));
  const r = detectSameToolRejectLoop(results);
  assert.strictEqual(r, null, 'actions emitted = partial success, not a reject loop');
});

t('detectSameToolRejectLoop: different write tools in tail = not a loop', () => {
  const results = [
    toolResult('set_cell_range', { error: 'x' }),
    toolResult('set_format', { error: 'x' }),
    toolResult('set_cell_range', { error: 'x' }),
    toolResult('bulk_set_cell_ranges', { error: 'x' }),
    toolResult('set_cell_range', { error: 'x' })
  ];
  assert.strictEqual(detectSameToolRejectLoop(results), null);
});

// ═══════════════ hasRecentBulkRejections ═══════════════

t('hasRecentBulkRejections: empty results returns false', () => {
  assert.strictEqual(hasRecentBulkRejections([]), false);
  assert.strictEqual(hasRecentBulkRejections(null), false);
});

t('hasRecentBulkRejections: bulk with errors as array triggers rejection', () => {
  const results = [
    toolResult('bulk_set_cell_ranges', { errors: [{ index: 0, reason: 'bad' }], actions: [] }),
    toolResult('bulk_set_cell_ranges', { errors: [{ index: 0, reason: 'bad' }], actions: [] })
  ];
  assert.strictEqual(hasRecentBulkRejections(results), true);
});

t('hasRecentBulkRejections: recent successful non-bulk write does not short-circuit', () => {
  const results = [
    errResult('bulk_set_cell_ranges', 'bad1'),
    okResult('set_cell_range'), // not bulk, so doesn't reset
    errResult('bulk_set_cell_ranges', 'bad2')
  ];
  const r = hasRecentBulkRejections(results);
  assert.strictEqual(r, true);
});

t('hasRecentBulkRejections: custom tool parameter filters correctly', () => {
  const results = [
    errResult('set_cell_range', 'bad'),
    errResult('set_cell_range', 'bad')
  ];
  assert.strictEqual(hasRecentBulkRejections(results, { tool: 'set_cell_range', minRejects: 2 }), true);
});

t('hasRecentBulkRejections: only tracks real tool-type entries', () => {
  const results = [
    { type: 'error', error: 'guard' },
    { type: 'error', error: 'guard' },
    errResult('bulk_set_cell_ranges', 'bad'),
    errResult('bulk_set_cell_ranges', 'bad')
  ];
  assert.strictEqual(hasRecentBulkRejections(results, { lookback: 4 }), true);
});

// ═══════════════ formatToolStagnationReason ═══════════════

t('formatToolStagnationReason: null stagnation returns generic string', () => {
  assert.strictEqual(formatToolStagnationReason(null), 'stagnation_detected');
});

t('formatToolStagnationReason: repeat pattern formats with count', () => {
  const entry = { pattern: 'repeat', entries: [{ toolName: 'read_sheet' }, { toolName: 'read_sheet' }, { toolName: 'read_sheet' }, { toolName: 'read_sheet' }] };
  const reason = formatToolStagnationReason(entry);
  assert.ok(reason.includes('stagnation_repeat'));
  assert.ok(reason.includes('read_sheet'));
  assert.ok(reason.includes('x4'));
});

t('formatToolStagnationReason: alternating pattern formats with both tool names', () => {
  const entry = { pattern: 'alternating', entries: [{ toolName: 'read_sheet' }, { toolName: 'execute_office_js' }] };
  const reason = formatToolStagnationReason(entry);
  assert.ok(reason.includes('stagnation_cycle'));
  assert.ok(reason.includes('read_sheet'));
  assert.ok(reason.includes('execute_office_js'));
});

t('formatToolStagnationReason: read_thrash formats with tool list', () => {
  const entry = { pattern: 'read_thrash', entries: [{ toolName: 'get_cell_ranges' }, { toolName: 'read_sheet' }] };
  const reason = formatToolStagnationReason(entry);
  assert.ok(reason.includes('stagnation_read_thrash'));
});

t('formatToolStagnationReason: tight_read_thrash formats with sheet and target', () => {
  const entry = { pattern: 'tight_read_thrash', entries: [{ toolName: 'x' }], sheet: 'Revenue', target: 'B5' };
  const reason = formatToolStagnationReason(entry);
  assert.ok(reason.includes('tight_read_thrash'));
  assert.ok(reason.includes('Revenue'));
});

t('formatToolStagnationReason: destructive_loop formats with sheet name', () => {
  const entry = { pattern: 'destructive_loop', entries: [{ toolName: 'delete_sheet' }], sheet: 'Revenue' };
  const reason = formatToolStagnationReason(entry);
  assert.ok(reason.includes('destructive_loop'));
});

t('formatToolStagnationReason: unknown pattern falls back to generic', () => {
  const entry = { pattern: 'unknown_pattern', entries: [{ toolName: 'x' }] };
  assert.ok(formatToolStagnationReason(entry).includes('stagnation_'));
});

// ═══════════════ extractSheetHint ═══════════════

t('extractSheetHint: extracts sheet from params.sheet', () => {
  assert.strictEqual(extractSheetHint({ sheet: 'Revenue' }), 'Revenue');
});

t('extractSheetHint: extracts from params.sheetName', () => {
  assert.strictEqual(extractSheetHint({ sheetName: 'Cost Model' }), 'Cost Model');
});

t('extractSheetHint: extracts from params.name', () => {
  assert.strictEqual(extractSheetHint({ name: 'Summary' }), 'Summary');
});

t('extractSheetHint: extracts from params.names array first element', () => {
  assert.strictEqual(extractSheetHint({ names: ['Sheet1', 'Sheet2'] }), 'Sheet1');
});

t('extractSheetHint: extracts from target with sheet ref', () => {
  assert.strictEqual(extractSheetHint({ target: 'Revenue!B5:C10' }), 'Revenue');
});

t('extractSheetHint: extracts from ranges array', () => {
  assert.strictEqual(extractSheetHint({ ranges: ['Cost!A1:B10'] }), 'Cost');
});

t('extractSheetHint: handles undefined/null params', () => {
  assert.strictEqual(extractSheetHint(null), null);
  assert.strictEqual(extractSheetHint(undefined), null);
  assert.strictEqual(extractSheetHint({}), null);
});

t('extractSheetHint: handles quoted sheet name in target', () => {
  assert.strictEqual(extractSheetHint({ target: "'Cost Model'!A1" }), 'Cost Model');
});

// ═══════════════ extractReadTargetKey ═══════════════

t('extractReadTargetKey: returns null on non-string input', () => {
  assert.strictEqual(extractReadTargetKey(null), null);
  assert.strictEqual(extractReadTargetKey(42), null);
});

t('extractReadTargetKey: returns null on signature without colon', () => {
  assert.strictEqual(extractReadTargetKey('getsomething'), null);
});

t('extractReadTargetKey: falls back through available keys', () => {
  const sig = buildToolStagnationSignature('get_cell_ranges', { ranges: [{ sheet: 'Revenue', target: 'B5' }] });
  const key = extractReadTargetKey(sig);
  assert.ok(key);
  assert.ok(key.includes('Revenue'));
});

// ═══════════════ normalizeStagnationValue ═══════════════

t('normalizeStagnationValue: truncates long strings to 160 chars', () => {
  const long = 'x'.repeat(200);
  const n = normalizeStagnationValue(long);
  assert.strictEqual(n.length, 161); // 160 + '…'
});

t('normalizeStagnationValue: truncates arrays to 8 items', () => {
  const arr = Array.from({ length: 20 }, (_, i) => i);
  const n = normalizeStagnationValue(arr);
  assert.strictEqual(n.length, 8);
});

t('normalizeStagnationValue: caps recursion depth at 4', () => {
  const deep = { a: { b: { c: { d: { e: 'value' } } } } };
  const n = normalizeStagnationValue(deep);
  assert.strictEqual(n.a.b.c.d, '[depth-limit]');
});

t('normalizeStagnationValue: handles null/undefined values', () => {
  assert.strictEqual(normalizeStagnationValue(null), null);
  assert.strictEqual(normalizeStagnationValue(undefined), undefined);
  assert.strictEqual(normalizeStagnationValue(true), true);
  assert.strictEqual(normalizeStagnationValue(42), 42);
});

// ═══════════════ detectSemanticErrorLoop edge ═══════════════

t('detectSemanticErrorLoop: empty healthSeen returns null', () => {
  assert.strictEqual(detectSemanticErrorLoop([]), null);
  assert.strictEqual(detectSemanticErrorLoop(null), null);
});

t('detectSemanticErrorLoop: entry without rootCause object is ignored', () => {
  const seen = [
    { sheet: 'A' },
    { sheet: 'B' },
    { sheet: 'C' }
  ];
  assert.strictEqual(detectSemanticErrorLoop(seen), null);
});

t('detectSemanticErrorLoop: same sheet, different rootCauses are separate buckets', () => {
  const seen = [
    { sheet: 'A', rootCause: 'string-in-numeric' },
    { sheet: 'A', rootCause: 'string-in-numeric' },
    { sheet: 'A', rootCause: 'empty-in-numeric' },
    { sheet: 'A', rootCause: 'empty-in-numeric' },
    { sheet: 'A', rootCause: 'empty-in-numeric' }
  ];
  // string-in-numeric bucket: 2 entries (<3) → below soft
  // empty-in-numeric bucket: 3 entries (=3) → soft
  const r = detectSemanticErrorLoop(seen);
  assert.ok(r);
  assert.strictEqual(r.rootCause, 'empty-in-numeric');
  assert.strictEqual(r.count, 3);
});

// ═══════════════ Race condition: deadlock between guards ═══════════════

t('Deadlock path: detectNoProgress fires when hasRecentBulkRejections is true', () => {
  // Simulate: bulk keeps failing, and no other tool succeeds
  const results = [
    // 8 bulk rejections in a row
    ...Array.from({ length: 8 }, () => errResult('bulk_set_cell_ranges', 'schema error')),
    // 4 more non-productive reads
    ...Array.from({ length: 4 }, () => toolResult('get_cell_ranges', { data: [] }))
  ];
  const noProgress = detectNoProgress(results);
  const bulkReject = hasRecentBulkRejections(results);
  assert.ok(noProgress, 'no progress should fire after 12 unproductive');
  assert.ok(bulkReject, 'bulk rejections should also be detected');
});

t('Deadlock path: successful small write resets noProgress but bulk still flagged', () => {
  const results = [
    ...Array.from({ length: 8 }, () => errResult('bulk_set_cell_ranges', 'bad')),
    okResult('set_cell_range'), // small write succeeds
    ...Array.from({ length: 6 }, () => errResult('bulk_set_cell_ranges', 'bad'))
  ];
  const noProgress = detectNoProgress(results);
  const bulkReject = hasRecentBulkRejections(results);
  assert.strictEqual(noProgress, null, 'successful small write resets counter');
  assert.ok(bulkReject, 'bulk continues to fail → stand-down guard should fire');
});

console.log(`\n[test_loop_detectors_edge] ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
