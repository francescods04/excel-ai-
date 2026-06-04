'use strict';

const assert = require('assert');
const { validateFormulas, extractCellRefs, buildWorkbookIndex } = require('../../codefirst/formulaValidator');

function ok(name, fn) {
  try { fn(); console.log(`  ok ${name}`); }
  catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

console.log('test_formula_validator');

ok('extractCellRefs: cross-sheet + local', () => {
  const refs = extractCellRefs('=Assumptions!$B$3*B2+SUM(C2:C10)');
  const xsh = refs.filter(r => r.kind === 'xsheet');
  const loc = refs.filter(r => r.kind === 'local');
  assert.strictEqual(xsh.length, 1);
  assert.strictEqual(xsh[0].sheet, 'Assumptions');
  assert.strictEqual(xsh[0].col1, 'B');
  assert.strictEqual(xsh[0].row1, 3);
  assert.ok(loc.length >= 2);
});

ok('validateFormulas: unknown sheet → critical', () => {
  const actions = [
    { type: 'createSheet', sheet: 'A' },
    { type: 'setCellRange', sheet: 'A', cells: { B1: { formula: '=Ghost!$A$1' } } },
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'unknown_sheet_ref' && i.severity === 'critical'));
});

ok('validateFormulas: self-reference → critical', () => {
  const actions = [
    { type: 'createSheet', sheet: 'A' },
    { type: 'setCellRange', sheet: 'A', cells: { B1: { formula: '=B1+1' } } },
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'self_reference'));
});

ok('validateFormulas: div by literal 0 → high', () => {
  const actions = [
    { type: 'setCellRange', sheet: 'A', cells: { B1: { formula: '=A1/0' } } },
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'div_by_zero'));
});

ok('validateFormulas: clean workbook → no critical issues', () => {
  const actions = [
    { type: 'createSheet', sheet: 'Assumptions' },
    { type: 'createSheet', sheet: 'Projections' },
    { type: 'setCellRange', sheet: 'Assumptions', cells: { B2: { value: 0.1 }, B3: { value: 0.2 } } },
    { type: 'setCellRange', sheet: 'Projections', cells: {
      B2: { formula: '=1000*(1+Assumptions!$B$2)' },
      C2: { formula: '=B2*(1+Assumptions!$B$2)' },
    }},
  ];
  const issues = validateFormulas(actions);
  const critical = issues.filter(i => i.severity === 'critical');
  assert.strictEqual(critical.length, 0, JSON.stringify(critical));
});

ok('validateFormulas: empty xsheet target → medium', () => {
  const actions = [
    { type: 'createSheet', sheet: 'Assumptions' },
    { type: 'createSheet', sheet: 'Projections' },
    // Assumptions has B2 but NOT B99
    { type: 'setCellRange', sheet: 'Assumptions', cells: { B2: { value: 0.1 } } },
    { type: 'setCellRange', sheet: 'Projections', cells: { B2: { formula: '=Assumptions!$B$99' } } },
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'empty_xsheet_ref'));
});

ok('buildWorkbookIndex: merges existing context + new actions', () => {
  const existingContext = {
    sheets: [
      { name: 'Existing', preview: [['x', 'y'], [1, 2]] },
    ],
  };
  const actions = [
    { type: 'setCellRange', sheet: 'New', cells: { A1: { value: 1 } } },
  ];
  const { sheets, cellsBySheet } = buildWorkbookIndex(actions, existingContext);
  assert.ok(sheets.has('Existing'));
  assert.ok(sheets.has('New'));
  assert.ok(cellsBySheet.get('Existing').has('A1'));
  assert.ok(cellsBySheet.get('Existing').has('B2'));
});

console.log(process.exitCode ? 'FAILED' : 'PASSED');
