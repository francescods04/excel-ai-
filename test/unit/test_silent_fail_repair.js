'use strict';

const assert = require('assert');
const {
  detectSilentFailures,
  countSetCellRangeCells,
  buildSlices
} = require('../../codefirst/enhanced');

let passed = 0, failed = 0;
function t(label, fn) {
  try { fn(); passed++; console.log(`  ok ${label}`); }
  catch (e) { failed++; console.error(`  FAIL ${label}: ${e.message}`); process.exitCode = 1; }
}

console.log('test_silent_fail_repair');

function cellsAction(count) {
  const cells = {};
  for (let i = 1; i <= count; i++) cells[`A${i}`] = { value: i };
  return { type: 'setCellRange', cells };
}

function codeAction() { return { type: 'setCellRange', cells: {} }; }

function sheetAction(name) { return { type: 'createSheet', sheet: name }; }

function actionsResult(actions) {
  return { actions, slice: { label: 'Test', sheet: 'Test', section: {}, estCells: 100, id: 'test_0' } };
}

// ═══════════════════════ countSetCellRangeCells ═══════════════════════

t('countSetCellRangeCells: empty → 0', () => {
  assert.strictEqual(countSetCellRangeCells([]), 0);
  assert.strictEqual(countSetCellRangeCells(null), 0);
  assert.strictEqual(countSetCellRangeCells(undefined), 0);
});

t('countSetCellRangeCells: single action with 5 cells', () => {
  const count = countSetCellRangeCells([cellsAction(5)]);
  assert.strictEqual(count, 5);
});

t('countSetCellRangeCells: mixed actions (formula + value + createSheet)', () => {
  const actions = [
    sheetAction('Sheet1'),
    { type: 'setCellRange', cells: { A1: { value: 1 }, B1: { formula: '=1+2' } } },
    { type: 'setCellRange', cells: { C1: { value: 3 } } },
  ];
  assert.strictEqual(countSetCellRangeCells(actions), 3);
});

t('countSetCellRangeCells: createSheet-only actions → 0', () => {
  assert.strictEqual(countSetCellRangeCells([sheetAction('A')]), 0);
  assert.strictEqual(countSetCellRangeCells([sheetAction('A'), sheetAction('B')]), 0);
});

t('countSetCellRangeCells: null cells → 0', () => {
  const actions = [
    { type: 'setCellRange' },
    { type: 'setCellRange', cells: null },
  ];
  assert.strictEqual(countSetCellRangeCells(actions), 0);
});

t('countSetCellRangeCells: large action with 100 cells', () => {
  const actions = [cellsAction(100)];
  assert.strictEqual(countSetCellRangeCells(actions), 100);
});

// ═══════════════════════ detectSilentFailures ═══════════════════════

t('detectSilentFailures: empty/null input → []', () => {
  assert.deepStrictEqual(detectSilentFailures([]), []);
  assert.deepStrictEqual(detectSilentFailures(null), []);
  assert.deepStrictEqual(detectSilentFailures(undefined), []);
});

t('detectSilentFailures: 0 cells, 1 action → flagged (should be silent fail)', () => {
  const results = [actionsResult([sheetAction('A')])];
  const fails = detectSilentFailures(results);
  assert.strictEqual(fails.length, 1);
});

t('detectSilentFailures: 0 cells, 0 actions → flagged', () => {
  const results = [actionsResult([])];
  const fails = detectSilentFailures(results);
  assert.strictEqual(fails.length, 1);
});

t('detectSilentFailures: 4 cells, 1 action (<5, <3 actions) → flagged', () => {
  const results = [actionsResult([cellsAction(4)])];
  const fails = detectSilentFailures(results);
  assert.strictEqual(fails.length, 1);
});

t('detectSilentFailures: 5 cells, 1 action (at threshold) → NOT flagged', () => {
  const results = [actionsResult([cellsAction(5)])];
  const fails = detectSilentFailures(results);
  assert.strictEqual(fails.length, 0);
});

t('detectSilentFailures: 4 cells, 3 actions (<5 cells, ≥3 actions) → NOT flagged', () => {
  const results = [actionsResult([
    cellsAction(1),
    cellsAction(2),
    cellsAction(1),
  ])];
  const fails = detectSilentFailures(results);
  assert.strictEqual(fails.length, 0);
});

t('detectSilentFailures: 10 cells, 1 action → NOT flagged', () => {
  const results = [actionsResult([cellsAction(10)])];
  const fails = detectSilentFailures(results);
  assert.strictEqual(fails.length, 0);
});

t('detectSilentFailures: 0 cells, 2 actions (just createSheets) → flagged', () => {
  const results = [actionsResult([sheetAction('A'), sheetAction('B')])];
  const fails = detectSilentFailures(results);
  assert.strictEqual(fails.length, 1);
});

t('detectSilentFailures: multiple results, some silent some not', () => {
  const results = [
    actionsResult([cellsAction(20)]),           // 20 cells → not silent
    actionsResult([sheetAction('B')]),          // 0 cells → silent
    actionsResult([cellsAction(3)]),            // 3 cells → silent
    actionsResult([cellsAction(50)]),           // 50 cells → not silent
    actionsResult([cellsAction(4), sheetAction('C'), codeAction()]), // 4 cells 3 actions → not silent
  ];
  const fails = detectSilentFailures(results);
  assert.strictEqual(fails.length, 2, `Expected 2 silent fails, got ${fails.length}`);
});

t('detectSilentFailures: all silent → all flagged', () => {
  const results = [
    actionsResult([]),
    actionsResult([sheetAction('A')]),
    actionsResult([cellsAction(2)]),
  ];
  const fails = detectSilentFailures(results);
  assert.strictEqual(fails.length, 3);
});

t('detectSilentFailures: all ok → none flagged', () => {
  const results = [
    actionsResult([cellsAction(10)]),
    actionsResult([cellsAction(15)]),
    actionsResult([cellsAction(50)]),
  ];
  const fails = detectSilentFailures(results);
  assert.strictEqual(fails.length, 0);
});

t('detectSilentFailures: null/invalid actions → flagged', () => {
  const results = [
    { actions: null, slice: { label: 'Broken' } },
    { actions: undefined, slice: { label: 'Broken2' } },
  ];
  const fails = detectSilentFailures(results);
  assert.strictEqual(fails.length, 2);
});

t('detectSilentFailures: custom threshold=2', () => {
  const results = [
    actionsResult([cellsAction(1)]),  // 1 < 2 → silent
    actionsResult([cellsAction(2)]),  // 2 >= 2 → not silent
    actionsResult([cellsAction(0)]),  // 0 < 2 → silent
  ];
  const fails = detectSilentFailures(results, { threshold: 2 });
  assert.strictEqual(fails.length, 2);
});

t('detectSilentFailures: null entry in sliceResults → flagged', () => {
  const results = [null, actionsResult([cellsAction(50)])];
  const fails = detectSilentFailures(results);
  assert.strictEqual(fails.length, 1);
  assert.strictEqual(fails[0], null);
});

t('detectSilentFailures: combine createSheet + empty setCellRange = 0 cells 2 actions → flagged', () => {
  const results = [actionsResult([
    sheetAction('A'),
    { type: 'setCellRange', cells: {} },
  ])];
  const fails = detectSilentFailures(results);
  assert.strictEqual(fails.length, 1);
});

// ═══════════════════════ buildSlices ═══════════════════════

t('buildSlices: empty plan → []', () => {
  assert.deepStrictEqual(buildSlices({}), []);
  assert.deepStrictEqual(buildSlices({ sections: [] }), []);
  assert.deepStrictEqual(buildSlices(null), []);
});

t('buildSlices: single section with default sheet', () => {
  const slices = buildSlices({ sections: [{ title: 'Revenue' }] });
  assert.strictEqual(slices.length, 1);
  assert.strictEqual(slices[0].sheet, 'Sheet1');
  assert.strictEqual(slices[0].estCells, 60);
});

t('buildSlices: time series with periods', () => {
  const slices = buildSlices({
    sections: [{ sheet: 'P&L', title: 'Revenue', is_time_series: true, periods: 60 }],
  });
  assert.strictEqual(slices.length, 1);
  assert.strictEqual(slices[0].estCells, 480);
});

t('buildSlices: time series with few periods → capped calculation', () => {
  const slices = buildSlices({
    sections: [{ sheet: 'P&L', title: 'Short', is_time_series: true, periods: 12 }],
  });
  assert.strictEqual(slices[0].estCells, 96);
});

t('buildSlices: explicit estimated_cells overrides calculation', () => {
  const slices = buildSlices({
    sections: [{ sheet: 'Big', title: 'Large', is_time_series: true, periods: 120, estimated_cells: 200 }],
  });
  assert.strictEqual(slices[0].estCells, 200);
});

t('buildSlices: multiple sections get unique ids', () => {
  const slices = buildSlices({
    sections: [
      { sheet: 'A', title: 'First' },
      { sheet: 'B', title: 'Second' },
      { sheet: 'B', title: 'Third' },
    ],
  });
  assert.strictEqual(slices.length, 3);
  assert.strictEqual(slices[0].id, 'A_0');
  assert.strictEqual(slices[1].id, 'B_1');
  assert.strictEqual(slices[2].id, 'B_2');
});

t('buildSlices: labels include sheet + title', () => {
  const slices = buildSlices({
    sections: [{ sheet: 'Revenue', title: 'Annual Revenue' }],
  });
  assert.strictEqual(slices[0].label, 'Revenue — Annual Revenue');
});

t('buildSlices: time series period calculation bound to 480 max', () => {
  const slices = buildSlices({
    sections: [{ sheet: 'Huge', title: 'Many Periods', is_time_series: true, periods: 200 }],
  });
  assert.strictEqual(slices[0].estCells, 480);
});

console.log(`\n[test_silent_fail_repair] ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
