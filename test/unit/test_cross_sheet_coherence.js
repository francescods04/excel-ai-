'use strict';

const assert = require('assert');
const { absolutifyCrossSheetRefs, sanitizeActions, validateActionsStrict } = require('../../codefirst/actionSanitizer');
const { validateFormulas, extractCellRefs } = require('../../codefirst/formulaValidator');
const { malformedRangeRefs } = require('../../server/agents/critic');

let passed = 0, failed = 0;
function t(label, fn) {
  try { fn(); passed++; console.log(`  ok ${label}`); }
  catch (e) { failed++; console.error(`  FAIL ${label}: ${e.message}`); process.exitCode = 1; }
}

console.log('test_cross_sheet_coherence');

function cells(sheet, spec) {
  return { type: 'setCellRange', sheet, cells: spec };
}

// ═══════════════════════ absolutifyCrossSheetRefs ═══════════════════════

t('absolutify: converts SheetName!A1 to SheetName!$A$1', () => {
  assert.strictEqual(absolutifyCrossSheetRefs('=Assumptions!B3'), '=Assumptions!$B$3');
});

t('absolutify: already-absolute $B$3 stays unchanged', () => {
  assert.strictEqual(absolutifyCrossSheetRefs('=Data!$B$3'), '=Data!$B$3');
});

t('absolutify: mixed absolute col / relative row → fully absolutified', () => {
  assert.strictEqual(absolutifyCrossSheetRefs('=Data!$B3'), '=Data!$B$3');
});

t('absolutify: relative col / absolute row → fully absolutified', () => {
  assert.strictEqual(absolutifyCrossSheetRefs('=Data!B$3'), '=Data!$B$3');
});

t('absolutify: range ref (col:row) is NOT absolutified', () => {
  assert.strictEqual(absolutifyCrossSheetRefs('=SUM(Assumptions!B3:B10)'), '=SUM(Assumptions!B3:B10)');
});

t('absolutify: multiple cross-sheet single-cell refs in one formula', () => {
  assert.strictEqual(
    absolutifyCrossSheetRefs('=Assumptions!B3+Assumptions!C5'),
    '=Assumptions!$B$3+Assumptions!$C$5'
  );
});

t('absolutify: mix of absolute and relative cross-sheet refs', () => {
  assert.strictEqual(
    absolutifyCrossSheetRefs('=Assumptions!B3+Assumptions!$C$5'),
    '=Assumptions!$B$3+Assumptions!$C$5'
  );
});

t('absolutify: sheet name with underscore', () => {
  assert.strictEqual(absolutifyCrossSheetRefs('=My_Sheet!A1'), '=My_Sheet!$A$1');
});

t('absolutify: sheet name with numbers', () => {
  assert.strictEqual(absolutifyCrossSheetRefs('=Sheet42!X99'), '=Sheet42!$X$99');
});

t('absolutify: ref without sheet qualifier stays unchanged', () => {
  assert.strictEqual(absolutifyCrossSheetRefs('=B2+B3'), '=B2+B3');
});

t('absolutify: empty string returns empty string', () => {
  assert.strictEqual(absolutifyCrossSheetRefs(''), '');
});

t('absolutify: null returns null', () => {
  assert.strictEqual(absolutifyCrossSheetRefs(null), null);
});

t('absolutify: undefined returns undefined', () => {
  assert.strictEqual(absolutifyCrossSheetRefs(undefined), undefined);
});

t('absolutify: number input returns unchanged', () => {
  assert.strictEqual(absolutifyCrossSheetRefs(42), 42);
});

t('absolutify: range with quoted sheet name untouched', () => {
  const f = "=SUM('My Assumptions'!B1:B10)";
  assert.strictEqual(absolutifyCrossSheetRefs(f), f);
});

t('absolutify: single-cell ref inside function call gets absolutified', () => {
  assert.strictEqual(
    absolutifyCrossSheetRefs('=IF(Assumptions!B3>0, Revenue!C5, 0)'),
    '=IF(Assumptions!$B$3>0, Revenue!$C$5, 0)'
  );
});

t('absolutify: VLOOKUP with cross-sheet table array stays as range', () => {
  assert.strictEqual(
    absolutifyCrossSheetRefs('=VLOOKUP(B2, Assumptions!A1:C10, 2, FALSE)'),
    '=VLOOKUP(B2, Assumptions!A1:C10, 2, FALSE)'
  );
});

// ═══════════════════════ Dedup slice collisions ═══════════════════════

t('dedup: same sheet, same cell → last write wins', () => {
  const { actions } = sanitizeActions([
    cells('S', { A1: { value: 1 }, B1: { value: 2 } }),
    cells('S', { A1: { value: 99 } }),
  ]);
  const a1 = actions.find(a => a.cells && a.cells.A1);
  const b1 = actions.find(a => a.cells && a.cells.B1);
  assert.strictEqual(a1.cells.A1.value, 99);
  assert.strictEqual(b1.cells.B1.value, 2);
});

t('dedup: same sheet, different cells → no dedup', () => {
  const { actions, stats } = sanitizeActions([
    cells('S', { A1: { value: 1 } }),
    cells('S', { B1: { value: 2 } }),
    cells('S', { C1: { value: 3 } }),
  ]);
  assert.strictEqual(stats.deduped, 0);
  assert.strictEqual(actions.length, 3);
});

t('dedup: different sheets, same address → no dedup', () => {
  const { actions, stats } = sanitizeActions([
    cells('Sheet1', { A1: { value: 1 } }),
    cells('Sheet2', { A1: { value: 2 } }),
  ]);
  assert.strictEqual(stats.deduped, 0);
  assert.strictEqual(actions.length, 2);
});

t('dedup: cellStyles merged non-destructively on collision', () => {
  const { actions } = sanitizeActions([
    cells('S', { A1: { value: 1, cellStyles: { bold: true, fontSize: 10 } } }),
    cells('S', { A1: { value: 99, cellStyles: { numberFormat: '0.00%' } } }),
  ]);
  const a1 = actions.find(a => a.cells && a.cells.A1);
  assert.ok(a1);
  assert.strictEqual(a1.cells.A1.value, 99);
  assert.strictEqual(a1.cells.A1.cellStyles.bold, true);
  assert.strictEqual(a1.cells.A1.cellStyles.fontSize, 10);
  assert.strictEqual(a1.cells.A1.cellStyles.numberFormat, '0.00%');
});

t('dedup: three slices, first and third collide, middle untouched', () => {
  const { actions } = sanitizeActions([
    cells('S', { A1: { value: 1 }, X1: { value: 'first' } }),
    cells('S', { B2: { value: 2 } }),
    cells('S', { A1: { value: 3 } }),
  ]);
  const x1Cells = actions.filter(a => a.cells && a.cells.X1);
  assert.strictEqual(x1Cells.length, 1, 'X1 from first slice preserved since it did not collide');
  const a1 = actions.find(a => a.cells && a.cells.A1);
  assert.strictEqual(a1.cells.A1.value, 3);
  const b2 = actions.find(a => a.cells && a.cells.B2);
  assert.strictEqual(b2.cells.B2.value, 2);
});

t('dedup: empty setCellRange after dedup is removed', () => {
  const { actions, stats } = sanitizeActions([
    cells('S', { A1: { value: 1 } }),
    cells('S', { A1: { value: 99 } }),
  ]);
  assert.ok(stats.deduped > 0);
  const setCellActions = actions.filter(a => a.type === 'setCellRange');
  assert.strictEqual(setCellActions.length, 1);
});

t('dedup: multiple collisions in same slice', () => {
  const { actions, stats } = sanitizeActions([
    cells('S', { A1: { value: 1 }, A2: { value: 2 }, A3: { value: 3 } }),
    cells('S', { A1: { value: 10 }, A2: { value: 20 }, A3: { value: 30 } }),
  ]);
  assert.strictEqual(stats.deduped, 3);
  const a1 = actions.find(a => a.cells && a.cells.A1);
  const a2 = actions.find(a => a.cells && a.cells.A2);
  const a3 = actions.find(a => a.cells && a.cells.A3);
  assert.strictEqual(a1.cells.A1.value, 10);
  assert.strictEqual(a2.cells.A2.value, 20);
  assert.strictEqual(a3.cells.A3.value, 30);
});

t('dedup: collision with merge of empty previous styles', () => {
  const { actions } = sanitizeActions([
    cells('S', { A1: { value: 1 } }),
    cells('S', { A1: { value: 99, cellStyles: { bold: true } } }),
  ]);
  const a1 = actions.find(a => a.cells && a.cells.A1);
  assert.strictEqual(a1.cells.A1.value, 99);
  assert.strictEqual(a1.cells.A1.cellStyles.bold, true);
});

t('dedup: createSheet + setCellRange mixed with collisions', () => {
  const { actions } = sanitizeActions([
    { type: 'createSheet', sheet: 'Revenue' },
    cells('Revenue', { A1: { value: 1 } }),
    { type: 'createSheet', sheet: 'Costs' },
    cells('Revenue', { A1: { value: 42 } }),
  ]);
  const a1 = actions.find(a => a.cells && a.cells.A1);
  assert.strictEqual(a1.cells.A1.value, 42);
});

t('dedup: formula cells collide, last formula wins', () => {
  const { actions } = sanitizeActions([
    cells('S', { A1: { formula: '=B1+1' }, B1: { value: 5 } }),
    cells('S', { A1: { formula: '=B1*2' } }),
  ]);
  const a1 = actions.find(a => a.cells && a.cells.A1);
  assert.strictEqual(a1.cells.A1.formula, '=B1*2');
  const b1 = actions.find(a => a.cells && a.cells.B1);
  assert.strictEqual(b1.cells.B1.value, 5);
});

// ═══════════════════════ Self-ref detection ═══════════════════════

t('self-ref: A1 = A1+1 → detected', () => {
  const actions = [
    { type: 'createSheet', sheet: 'S' },
    { type: 'setCellRange', sheet: 'S', cells: { A1: { formula: '=A1+1' } } },
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'self_reference'));
});

t('self-ref: B2 = B2*2 → detected', () => {
  const actions = [
    { type: 'createSheet', sheet: 'S' },
    { type: 'setCellRange', sheet: 'S', cells: { B2: { formula: '=B2*2' } } },
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'self_reference'));
});

t('self-ref: B2 = A1+B2 → detected (self-ref among other refs)', () => {
  const actions = [
    { type: 'createSheet', sheet: 'S' },
    { type: 'setCellRange', sheet: 'S', cells: { B2: { formula: '=A1+B2+C3' } } },
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'self_reference'));
});

t('self-ref: X99 = X99 → detected', () => {
  const actions = [
    { type: 'createSheet', sheet: 'S' },
    { type: 'setCellRange', sheet: 'S', cells: { X99: { formula: '=X99' } } },
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'self_reference'));
});

t('self-ref: D10 = (D10*0.5)+5 → detected', () => {
  const actions = [
    { type: 'createSheet', sheet: 'S' },
    { type: 'setCellRange', sheet: 'S', cells: { D10: { formula: '=(D10*0.5)+5' } } },
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'self_reference'));
});

t('self-ref: B2 = B1+1 → NOT detected (different row)', () => {
  const actions = [
    { type: 'createSheet', sheet: 'S' },
    { type: 'setCellRange', sheet: 'S', cells: { B2: { formula: '=B1+1' } } },
  ];
  const issues = validateFormulas(actions);
  assert.strictEqual(issues.filter(i => i.kind === 'self_reference').length, 0);
});

t('self-ref: case-insensitive matching not supported by regex (lowercase ignored)', () => {
  const actions = [
    { type: 'createSheet', sheet: 'S' },
    { type: 'setCellRange', sheet: 'S', cells: { A1: { formula: '=a1+1' } } },
  ];
  const issues = validateFormulas(actions);
  const selfRefs = issues.filter(i => i.kind === 'self_reference');
  assert.strictEqual(selfRefs.length, 0, 'Lowercase ref not matched by [A-Z]+ regex');
});

t('self-ref: cross-sheet self-ref (Sheet1!A1 = Sheet1!A1+1) → detected', () => {
  const actions = [
    { type: 'createSheet', sheet: 'Sheet1' },
    { type: 'setCellRange', sheet: 'Sheet1', cells: { A1: { formula: '=Sheet1!A1+1' } } },
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'self_reference_xsheet'));
});

t('self-ref: cross-sheet to different cell on same sheet → NOT self-ref', () => {
  const actions = [
    { type: 'createSheet', sheet: 'Sheet1' },
    { type: 'setCellRange', sheet: 'Sheet1', cells: { A2: { formula: '=Sheet1!A1+1' } } },
  ];
  const issues = validateFormulas(actions);
  assert.strictEqual(issues.filter(i => i.kind === 'self_reference_xsheet').length, 0);
});

t('self-ref: cross-sheet to same address on different sheet → NOT self-ref', () => {
  const actions = [
    { type: 'createSheet', sheet: 'Sheet1' },
    { type: 'createSheet', sheet: 'Sheet2' },
    { type: 'setCellRange', sheet: 'Sheet1', cells: { A1: { formula: '=Sheet2!A1' } } },
  ];
  const issues = validateFormulas(actions);
  assert.strictEqual(issues.filter(i => i.kind === 'self_reference_xsheet').length, 0);
});

t('self-ref: value cell at same address (no formula) — not checked', () => {
  const actions = [
    { type: 'createSheet', sheet: 'S' },
    { type: 'setCellRange', sheet: 'S', cells: { A1: { value: 42 } } },
  ];
  const issues = validateFormulas(actions);
  assert.strictEqual(issues.length, 0);
});

t('self-ref: two formulas, one self-refs → only the self-ref flagged', () => {
  const actions = [
    { type: 'createSheet', sheet: 'S' },
    { type: 'setCellRange', sheet: 'S', cells: {
      A1: { formula: '=B1+1' },
      B1: { formula: '=B1+1' },
    }},
  ];
  const issues = validateFormulas(actions);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].kind, 'self_reference');
  assert.strictEqual(issues[0].location, 'S!B1');
});

// ═══════════════════════ validateActionsStrict (missing sheet in cross-sheet refs) ═══════════════════════

t('validateStrict: all sheets present → no errors', () => {
  const actions = [
    { type: 'createSheet', sheet: 'Assumptions' },
    { type: 'createSheet', sheet: 'Projections' },
    { type: 'setCellRange', sheet: 'Projections', cells: { B2: { formula: '=Assumptions!$B$3' } } },
  ];
  const errors = validateActionsStrict(actions);
  assert.strictEqual(errors.length, 0);
});

t('validateStrict: missing sheet → error reported', () => {
  const actions = [
    { type: 'createSheet', sheet: 'Projections' },
    { type: 'setCellRange', sheet: 'Projections', cells: { B2: { formula: '=Ghost!A1' } } },
  ];
  const errors = validateActionsStrict(actions);
  assert.ok(errors.some(e => e.sheet === 'Ghost'));
  assert.ok(errors.some(e => e.severity === 'high'));
});

t('validateStrict: multiple missing sheets → all reported', () => {
  const actions = [
    { type: 'setCellRange', sheet: 'S', cells: {
      A1: { formula: '=Ghost1!A1' },
      A2: { formula: '=Ghost2!B2' },
    }},
  ];
  const errors = validateActionsStrict(actions);
  assert.strictEqual(errors.filter(e => e.kind === 'missing_sheet').length, 2);
});

t('validateStrict: sheetName property not used by validateActionsStrict (only sheet)', () => {
  const actions = [
    { type: 'createSheet', sheetName: 'Revenue' },
    { type: 'setCellRange', sheetName: 'Revenue', cells: { B2: { formula: '=Revenue!$A$1' } } },
  ];
  const errors = validateActionsStrict(actions);
  assert.ok(errors.some(e => e.kind === 'missing_sheet' && e.sheet === 'Revenue'),
    'Revenue sheet registered only as sheetName, not sheet, so cross-sheet ref is flagged');
});

t('validateStrict: fillRange with cross-sheet formula is checked', () => {
  const actions = [
    { type: 'createSheet', sheet: 'Data' },
    { type: 'fillRange', sheet: 'Calc', start: 'A1', end: 'A5', formula: '=Data!B1' },
  ];
  const errors = validateActionsStrict(actions);
  assert.strictEqual(errors.length, 0);
});

t('validateStrict: fillRange with missing sheet ref is caught', () => {
  const actions = [
    { type: 'fillRange', sheet: 'Calc', start: 'A1', end: 'A5', formula: '=Ghost!B1' },
  ];
  const errors = validateActionsStrict(actions);
  assert.ok(errors.some(e => e.sheet === 'Ghost'));
});

// ═══════════════════════ Malformed refs (critic.js) ═══════════════════════

t('malformedRangeRefs: proper A1 range → returns []', () => {
  assert.deepStrictEqual(malformedRangeRefs('=SUM(A1:B10)'), []);
});

t('malformedRangeRefs: proper cross-sheet range → returns []', () => {
  assert.deepStrictEqual(malformedRangeRefs("=SUM('Data Sheet'!A1:Z100)"), []);
});

t('malformedRangeRefs: column-only ref (both endpoints same type) → not malformed', () => {
  const bad = malformedRangeRefs('=SUM(A:A)');
  assert.deepStrictEqual(bad, [], 'Same-type endpoints (column:column) pass');
});

t('malformedRangeRefs: row-only ref (both endpoints same type) → not malformed', () => {
  const bad = malformedRangeRefs('=SUM(1:1)');
  assert.deepStrictEqual(bad, [], 'Same-type endpoints (row:row) pass');
});

t('malformedRangeRefs: cross-sheet whole-column ref (both column) → not malformed', () => {
  const bad = malformedRangeRefs("=SUM('My Sheet'!A:Z)");
  assert.deepStrictEqual(bad, [], 'Same-type cross-sheet column refs pass');
});

t('malformedRangeRefs: mismatched endpoints (column:row) → malformed', () => {
  const bad = malformedRangeRefs('=SUM(A:5)');
  assert.ok(bad.some(r => r === 'A:5'));
});

t('malformedRangeRefs: mismatched endpoints (row:column) → malformed', () => {
  const bad = malformedRangeRefs('=SUM(3:G)');
  assert.ok(bad.some(r => r === '3:G'));
});

t('malformedRangeRefs: both endpoints same type (not mismatched) → no flag', () => {
  const bad = malformedRangeRefs('=SUM(A1:B10) + SUM(C:D)');
  assert.deepStrictEqual(bad, [], 'All range endpoints match types');
});

t('malformedRangeRefs: row-only ref (1:1) → valid row range, not malformed', () => {
  const bad = malformedRangeRefs('=SUM(1:1)');
  assert.deepStrictEqual(bad, [], '1:1 is a valid Excel row reference');
});

t('malformedRangeRefs: mismatched endpoints (column:row) → malformed', () => {
  const bad = malformedRangeRefs('=SUM(A:5)');
  assert.ok(bad.some(r => r === 'A:5'));
});

t('malformedRangeRefs: mismatched endpoints (row:column) → malformed', () => {
  const bad = malformedRangeRefs('=SUM(3:G)');
  assert.ok(bad.some(r => r === '3:G'));
});

t('malformedRangeRefs: cross-sheet whole-column ref (A:Z) → valid column range, not malformed', () => {
  const bad = malformedRangeRefs("=SUM('My Sheet'!A:Z)");
  assert.deepStrictEqual(bad, [], 'A:Z is a valid Excel column range');
});

t('malformedRangeRefs: non-range text → empty array', () => {
  assert.deepStrictEqual(malformedRangeRefs('=A1+B2'), []);
});

t('malformedRangeRefs: null/undefined → empty array', () => {
  assert.deepStrictEqual(malformedRangeRefs(null), []);
  assert.deepStrictEqual(malformedRangeRefs(undefined), []);
});

t('malformedRangeRefs: non-string → empty array', () => {
  assert.deepStrictEqual(malformedRangeRefs(42), []);
});

t('malformedRangeRefs: empty string → empty array', () => {
  assert.deepStrictEqual(malformedRangeRefs(''), []);
});

t('malformedRangeRefs: cross-sheet proper range with dollar signs → ok', () => {
  const bad = malformedRangeRefs('=SUM(Data!$A$1:$Z$100)');
  assert.deepStrictEqual(bad, []);
});

t('malformedRangeRefs: multiple ranges, all valid → empty array', () => {
  const bad = malformedRangeRefs('=SUM(A1:B10) + SUM(C:D)');
  assert.deepStrictEqual(bad, [], 'A1:B10 and C:D are both valid ranges');
});

console.log(`\n[test_cross_sheet_coherence] ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
