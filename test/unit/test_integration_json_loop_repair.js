'use strict';

const assert = require('assert');
const { tryRecoverTruncatedAgentJson, tryRecoverMissingCommas } = require('../../server/agents/jsonRecovery');
const {
  detectToolStagnation, detectNoProgress, detectSameToolRejectLoop,
  hasRecentBulkRejections, buildToolStagnationSignature, extractSheetHint,
} = require('../../server/agents/loopDetectors');
const { detectSilentFailures, countSetCellRangeCells, buildSlices } = require('../../codefirst/enhanced');

let passed = 0, failed = 0;
function t(label, fn) {
  try { fn(); passed++; console.log(`  ok ${label}`); }
  catch (e) { failed++; console.error(`  FAIL ${label}: ${e.message}`); process.exitCode = 1; }
}

console.log('test_integration_json_loop_repair');

function sig(tool, params) {
  return { toolName: tool, signature: buildToolStagnationSignature(tool, params), sheetHint: extractSheetHint(params) };
}

function toolResult(tool, result) { return { type: 'tool', tool, result }; }
function errResult(tool, msg) { return toolResult(tool, { error: msg }); }
function okResult(tool) { return toolResult(tool, { ok: true, applied: 1, actions: [{}] }); }

function cellsAction(count) {
  const cells = {};
  for (let i = 1; i <= count; i++) cells[`A${i}`] = { value: i };
  return { type: 'setCellRange', cells };
}

function sheetAction(name) { return { type: 'createSheet', sheet: name }; }

function sliceResult(label, sheet, actions, estCells = 100) {
  return { actions, slice: { label, sheet, section: {}, estCells, id: `${sheet}_0` } };
}

// ═══════════════════════ SCENARIO: Broken LLM pipeline recovery ═══════════════════════
//
// Simulates a realistic multi-step LLM agent interaction:
//
// Step 1: The LLM emits a truncated JSON tool call (token-cap hit mid-stream).
//         → jsonRecovery recovers it successfully.
//
// Step 2: After recovery, the agent enters a read-thrash loop: it reads the same
//         sheet 8 times without writing anything useful.
//         → loopDetectors catch it (detectToolStagnation → read_thrash).
//
// Step 3: After loop-break guidance, the agent produces a slice with only 2 cells
//         (a "silent failure").
//         → detectSilentFailures flags it.
//
// ═══════════════════════════════════════════════════════════════════════

// ─── Step 1: JSON Recovery ───

t('scenario: recovers truncated bulk_set_cell_ranges from stream cap', () => {
  const raw = '{"thought":"Writing DCF","tool":"bulk_set_cell_ranges","params":{"writes":[{"sheet":"DCF","cells":{"B2":{"formula":"=B1*(1+0.1)"}}';
  const recovered = tryRecoverTruncatedAgentJson(raw);
  assert.ok(recovered, 'Should recover truncated JSON');
  assert.strictEqual(recovered.tool, 'bulk_set_cell_ranges');
});

t('scenario: recovers missing-comma payload after recovery hint', () => {
  const raw = '{"tool":"set_cell_range" "params":{"cells":{"A1":{"value":100}}}}';
  const recovered = tryRecoverMissingCommas(raw);
  assert.ok(recovered, 'Should recover with comma injected between key-value pairs');
  assert.strictEqual(recovered.tool, 'set_cell_range');
});

t('scenario: escaped control chars + recovery → valid tool call', () => {
  const raw = '{"thought":"Revenue line 1\nRevenue line 2","tool":"set_cell_range","params":{"cells":{"A1":{"value":1}}}}';
  const recovered = tryRecoverTruncatedAgentJson(raw);
  assert.ok(recovered, 'Should recover despite raw newline in string');
  assert.strictEqual(recovered.tool, 'set_cell_range');
  assert.ok(recovered.thought.includes('Revenue'), 'Thought preserved');
});

// ─── Step 2: Loop Detection ───

t('scenario: read-thrash detected after agent re-reads same sheet', () => {
  const trail = [
    sig('get_cell_ranges', { sheet: 'DCF', ranges: [{ sheet: 'DCF', target: 'A1:B20' }] }),
    sig('get_cell_ranges', { sheet: 'DCF', ranges: [{ sheet: 'DCF', target: 'A1:B20' }] }),
    sig('get_cell_ranges', { sheet: 'DCF', ranges: [{ sheet: 'DCF', target: 'A1:B20' }] }),
    sig('read_sheet', { sheet: 'DCF' }),
    sig('read_sheet', { sheet: 'DCF' }),
    sig('read_sheet', { sheet: 'DCF' }),
    sig('read_sheet', { sheet: 'DCF' }),
    sig('get_cell_ranges', { sheet: 'DCF', ranges: [{ sheet: 'DCF', target: 'A1:B20' }] }),
  ];
  const stagnation = detectToolStagnation(trail);
  assert.ok(stagnation, 'Should detect stagnation');
  assert.strictEqual(stagnation.pattern, 'read_thrash');
});

t('scenario: no-progress detected after 12 failed write attempts', () => {
  const results = Array.from({ length: 12 }, () =>
    errResult('bulk_set_cell_ranges', 'schema validation error'));
  const r = detectNoProgress(results);
  assert.ok(r, 'Should detect no progress');
  assert.strictEqual(r.pattern, 'no_progress');
});

t('scenario: same-tool reject loop detected after 5 consecutive bulk rejections', () => {
  const results = Array.from({ length: 5 }, () =>
    toolResult('bulk_set_cell_ranges', { errors: [{ index: 0, reason: 'invalid format' }] }));
  const r = detectSameToolRejectLoop(results);
  assert.ok(r, 'Should detect same-tool reject loop');
  assert.strictEqual(r.tool, 'bulk_set_cell_ranges');
});

// ─── Step 3: Silent Failure Detection ───

t('scenario: slice with 2 cells (< threshold 5) → flagged as silent fail', () => {
  const results = [sliceResult('DCF Projections', 'DCF', [cellsAction(2)], 100)];
  const fails = detectSilentFailures(results);
  assert.strictEqual(fails.length, 1, '2-cell slice should be flagged');
});

t('scenario: slice with 0 cells (just createSheet) → flagged as silent fail', () => {
  const results = [sliceResult('Empty Sheet', 'Empty', [sheetAction('Empty')], 60)];
  const fails = detectSilentFailures(results);
  assert.strictEqual(fails.length, 1, 'CreateSheet-only slice should be flagged');
});

t('scenario: repair slice now has 10 cells → passes threshold', () => {
  const results = [sliceResult('Repaired', 'Sheet1', [
    cellsAction(5),
    cellsAction(5),
  ], 100)];
  const fails = detectSilentFailures(results);
  assert.strictEqual(fails.length, 0, '10-cell repair should pass');
});

// ═══════════════════════ Full pipeline simulation ═══════════════════════

t('scenario: full pipeline — jsonRecovery → loop detection → silent fail repair', () => {
  // Step 1: Recover broken LLM JSON
  const brokenJson = '{"thought":"Generating DCF","tool":"set_cell_range","params":{"cells":{"A1":{"formula":"=Assumptions!$B$3"}}';
  const recovered = tryRecoverTruncatedAgentJson(brokenJson);
  assert.ok(recovered, 'Step 1: JSON recovered');
  assert.strictEqual(recovered.tool, 'set_cell_range');

  // Step 2: After recovery, agent re-reads same sheet 6 times (read-thrash)
  const trail = [
    sig('get_cell_ranges', { sheet: 'DCF', ranges: [{ sheet: 'DCF', target: 'B2:B20' }] }),
    sig('get_cell_ranges', { sheet: 'DCF', ranges: [{ sheet: 'DCF', target: 'B2:B20' }] }),
    sig('get_cell_ranges', { sheet: 'DCF', ranges: [{ sheet: 'DCF', target: 'B2:B20' }] }),
    sig('read_sheet', { sheet: 'DCF' }),
    sig('read_sheet', { sheet: 'DCF' }),
    sig('get_cell_ranges', { sheet: 'DCF', ranges: [{ sheet: 'DCF', target: 'B2:B20' }] }),
  ];
  const stagnation = detectToolStagnation(trail);
  assert.ok(stagnation, 'Step 2: Read-thrash detected');
  assert.strictEqual(stagnation.pattern, 'read_thrash');

  // Step 3: After guidance, agent produces silent-fail slice (only 2 cells)
  const results = [
    sliceResult('DCF Cash Flows', 'DCF', [
      sheetAction('DCF'),
      cellsAction(2),
    ], 200),
  ];
  const silentFails = detectSilentFailures(results);
  assert.strictEqual(silentFails.length, 1, 'Step 3: Silent failure detected');

  // Step 4: Repair actions produce sufficient cells (10)
  const repairedResults = [
    sliceResult('DCF Cash Flows (repaired)', 'DCF', [
      sheetAction('DCF'),
      cellsAction(10),
    ], 200),
  ];
  const repairedFails = detectSilentFailures(repairedResults);
  assert.strictEqual(repairedFails.length, 0, 'Step 4: Repair passes validation');
});

// ─── Edge: recovery fails → loop detected → silent fail anyway ───

t('scenario: unrecoverable JSON → no loop yet → later silent fail still caught', () => {
  const unrecoverable = 'not even json at all';
  assert.strictEqual(tryRecoverTruncatedAgentJson(unrecoverable), null, 'Unrecoverable returns null');

  const results = [
    sliceResult('Failed sheet', 'Fail', [sheetAction('Fail')], 50),
  ];
  const fails = detectSilentFailures(results);
  assert.strictEqual(fails.length, 1, 'Even after failed recovery, silent fail still detected');
});

// ─── Edge: valid JSON, no stagnation, healthy output ───

t('scenario: healthy pipeline — no recovery needed, no stagnation, no silent fails', () => {
  const validJson = '{"tool":"set_cell_range","params":{"cells":{"A1":{"value":1}}}}';
  const recovered = tryRecoverTruncatedAgentJson(validJson);
  assert.ok(recovered, 'Valid JSON passes through recovery');

  const trail = [
    sig('read_sheet', { sheet: 'Revenue' }),
    sig('read_sheet', { sheet: 'Costs' }),
    sig('read_sheet', { sheet: 'WACC' }),
    sig('read_sheet', { sheet: 'Summary' }),
    sig('read_sheet', { sheet: 'DCF' }),
    sig('get_cell_ranges', { sheet: 'Revenue', ranges: [{ sheet: 'Revenue', target: 'A1:D20' }] }),
  ];
  const stagnation = detectToolStagnation(trail);
  assert.strictEqual(stagnation, null, 'Diverse reads = no stagnation');

  const results = [
    sliceResult('Revenue', 'Revenue', [cellsAction(20)], 60),
    sliceResult('Costs', 'Costs', [cellsAction(15)], 60),
    sliceResult('WACC', 'WACC', [cellsAction(8)], 30),
  ];
  const silentFails = detectSilentFailures(results);
  assert.strictEqual(silentFails.length, 0, 'All slices healthy');
});

// ─── Serial failures across multiple rounds ───

t('scenario: 3 rounds of recovery + loop break + silent repair for multi-sheet model', () => {
  let totalRecovered = 0;
  let totalLoops = 0;
  let totalSilentRepaired = 0;

  for (let round = 0; round < 3; round++) {
    const raw = `{"thought":"Round ${round}","tool":"bulk_set_cell_ranges","params":{"writes":[{"sheet":"Sheet${round}","cells":{"A1":{"value":${round}}}}]}`;
    const recovered = tryRecoverTruncatedAgentJson(raw);
    if (recovered && recovered.tool) totalRecovered++;
  }
  assert.strictEqual(totalRecovered, 3, 'All 3 rounds recovered');

  for (let round = 0; round < 3; round++) {
    const trail = [
      sig('read_sheet', { sheet: 'DCF' }),
      sig('read_sheet', { sheet: 'DCF' }),
      sig('read_sheet', { sheet: 'DCF' }),
      sig('read_sheet', { sheet: 'DCF' }),
      sig('read_sheet', { sheet: 'DCF' }),
      sig('read_sheet', { sheet: 'DCF' }),
    ];
    const stagnation = detectToolStagnation(trail);
    if (stagnation) totalLoops++;
  }
  assert.strictEqual(totalLoops, 3, 'All 3 rounds hit read-thrash');

  for (let round = 0; round < 3; round++) {
    const results = [sliceResult(`Sheet${round}`, `Sheet${round}`, [cellsAction(2)], 50)];
    const fails = detectSilentFailures(results);
    totalSilentRepaired += fails.length;
  }
  assert.strictEqual(totalSilentRepaired, 3, 'All 3 rounds flagged as silent fails');
});

// ─── Combined: no-progress + bulk rejection deadlock + silent fail ───

t('scenario: deadlock — bulk keeps failing, no progress, silent fail in results', () => {
  const results = Array.from({ length: 12 }, () =>
    errResult('bulk_set_cell_ranges', 'schema error'));

  const noProgress = detectNoProgress(results);
  assert.ok(noProgress, 'No progress detected');

  const bulkReject = hasRecentBulkRejections(results);
  assert.ok(bulkReject, 'Bulk rejection detected');

  const sliceOutput = [
    sliceResult('DCF', 'DCF', [sheetAction('DCF'), cellsAction(1)], 200),
  ];
  const silentFails = detectSilentFailures(sliceOutput);
  assert.strictEqual(silentFails.length, 1, 'Combined: silent fail still detected');
});

// ─── Count helpers across scenarios ───

t('scenario: countSetCellRangeCells with mixed formula + value actions', () => {
  const actions = [
    cellsAction(5),
    sheetAction('S'),
    { type: 'setCellRange', cells: { B1: { formula: '=A1*2' }, B2: { formula: '=A2*2' } } },
    cellsAction(3),
  ];
  assert.strictEqual(countSetCellRangeCells(actions), 10);
});

t('scenario: buildSlices from realistic DCF plan', () => {
  const plan = {
    sections: [
      { sheet: 'Assumptions', title: 'Key Assumptions', estimated_cells: 20 },
      { sheet: 'Revenue', title: 'Revenue Build', is_time_series: true, periods: 60 },
      { sheet: 'Costs', title: 'Cost Structure', is_time_series: true, periods: 60 },
      { sheet: 'DCF', title: 'Valuation Output', estimated_cells: 30 },
    ],
  };
  const slices = buildSlices(plan);
  assert.strictEqual(slices.length, 4);
  assert.strictEqual(slices[0].sheet, 'Assumptions');
  assert.strictEqual(slices[0].estCells, 20);
  assert.strictEqual(slices[1].estCells, 480);
  assert.strictEqual(slices[1].id, 'Revenue_1');
  assert.strictEqual(slices[3].id, 'DCF_3');
});

console.log(`\n[test_integration_json_loop_repair] ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
