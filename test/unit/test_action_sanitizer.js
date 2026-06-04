'use strict';

const assert = require('assert');
const {
  sanitizeActions,
  shiftFormula,
  colToNum,
  numToCol,
  isWholeColumnOrRow,
  boundTarget,
  expandFillRangeToCells,
} = require('../../codefirst/actionSanitizer');

function ok(name, fn) {
  try { fn(); console.log(`  ok ${name}`); }
  catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

console.log('test_action_sanitizer');

ok('colToNum / numToCol roundtrip', () => {
  for (const c of ['A', 'B', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']) {
    assert.strictEqual(numToCol(colToNum(c)), c);
  }
});

ok('shiftFormula shifts relative cols only', () => {
  assert.strictEqual(shiftFormula('=B2*(1+Assumptions!$B$2)', 1, 0), '=C2*(1+Assumptions!$B$2)');
  assert.strictEqual(shiftFormula('=B2+C3', 2, 0), '=D2+E3');
  assert.strictEqual(shiftFormula('=$B2', 3, 0), '=$B2');
  assert.strictEqual(shiftFormula('=B$2', 0, 5), '=B$2');
  assert.strictEqual(shiftFormula('=B2', 1, 1), '=C3');
});

ok('isWholeColumnOrRow', () => {
  assert.strictEqual(isWholeColumnOrRow('A:Z'), true);
  assert.strictEqual(isWholeColumnOrRow('B:B'), true);
  assert.strictEqual(isWholeColumnOrRow('1:1'), true);
  assert.strictEqual(isWholeColumnOrRow('Sheet1!A:Z'), true);
  assert.strictEqual(isWholeColumnOrRow('A1:Z100'), false);
  assert.strictEqual(isWholeColumnOrRow('A1'), false);
});

ok('boundTarget bounds whole-column', () => {
  assert.strictEqual(boundTarget('A:Z'), 'A1:Z200');
  assert.strictEqual(boundTarget('Sheet1!A:Z'), 'Sheet1!A1:Z200');
  assert.strictEqual(boundTarget('A1:Z100'), 'A1:Z100');
});

ok('expandFillRangeToCells horizontal', () => {
  const exp = expandFillRangeToCells({
    type: 'fillRange', sheet: 'S', start: 'B2', end: 'F2',
    formula: '=B2*(1+Assumptions!$B$2)',
  });
  assert.strictEqual(exp.type, 'setCellRange');
  assert.deepStrictEqual(Object.keys(exp.cells).sort(), ['B2', 'C2', 'D2', 'E2', 'F2']);
  assert.strictEqual(exp.cells.B2.formula, '=B2*(1+Assumptions!$B$2)');
  assert.strictEqual(exp.cells.C2.formula, '=C2*(1+Assumptions!$B$2)');
  assert.strictEqual(exp.cells.F2.formula, '=F2*(1+Assumptions!$B$2)');
});

ok('expandFillRangeToCells vertical with value', () => {
  const exp = expandFillRangeToCells({
    type: 'fillRange', sheet: 'S', start: 'A1', end: 'A3', value: 42,
  });
  assert.strictEqual(Object.keys(exp.cells).length, 3);
  assert.deepStrictEqual(exp.cells.A1, { value: 42 });
  assert.deepStrictEqual(exp.cells.A3, { value: 42 });
});

ok('sanitizeActions: drops bad fillRange, expands good, bounds whole-column', () => {
  const { actions, stats } = sanitizeActions([
    { type: 'createSheet', sheet: 'Sheet1' },
    { type: 'fillRange', sheet: 'Sheet1', start: 'B2', end: 'F2', formula: '=B2+1' },
    { type: 'fillRange', sheet: 'Sheet1', formula: '=A1' },
    { type: 'setCellFormat', sheet: 'Sheet1', target: 'A:Z', options: { bold: true } },
    { type: 'setCellRange', sheet: 'Sheet1', cells: { A1: { value: 'Hi' } } },
  ]);
  assert.strictEqual(stats.expanded, 1);
  assert.strictEqual(stats.dropped, 1);
  assert.strictEqual(stats.bounded, 1);
  assert.strictEqual(stats.kept, 3);

  const fmt = actions.find(a => a.type === 'setCellFormat');
  assert.strictEqual(fmt.target, 'A1:Z200');

  const sc = actions.find(a => a.type === 'setCellRange' && a.cells.B2);
  assert.ok(sc);
  assert.strictEqual(sc.cells.C2.formula, '=C2+1');
});

ok('sanitizeActions: lifts value="=..." to formula', () => {
  const { actions } = sanitizeActions([
    { type: 'setCellRange', sheet: 'S', cells: { A1: { value: '=B1+C1' } } },
  ]);
  assert.strictEqual(actions[0].cells.A1.formula, '=B1+C1');
  assert.strictEqual(actions[0].cells.A1.value, undefined);
});

ok('sanitizeActions: drops whole-column setCellRange cells', () => {
  const { actions } = sanitizeActions([
    { type: 'setCellRange', sheet: 'S', cells: { 'A:Z': { value: 1 }, 'A1': { value: 2 } } },
  ]);
  assert.deepStrictEqual(Object.keys(actions[0].cells), ['A1']);
});

ok('sanitizeActions: absolutifies cross-sheet single-cell refs', () => {
  const { actions, stats } = sanitizeActions([
    { type: 'setCellRange', sheet: 'P', cells: {
      A1: { formula: '=Assumptions!B3+Assumptions!$C$5' },
      A2: { formula: '=SUM(Assumptions!B3:B10)' },
    }},
  ]);
  assert.strictEqual(actions[0].cells.A1.formula, '=Assumptions!$B$3+Assumptions!$C$5');
  assert.strictEqual(actions[0].cells.A2.formula, '=SUM(Assumptions!B3:B10)');
  assert.ok(stats.absolutified >= 1);
});

ok('sanitizeActions: dedupes overlapping addresses, last write wins, merges styles', () => {
  const { actions, stats } = sanitizeActions([
    { type: 'setCellRange', sheet: 'S', cells: {
      A1: { value: 1, cellStyles: { bold: true } },
      B1: { value: 2 },
    }},
    { type: 'setCellRange', sheet: 'S', cells: {
      A1: { value: 99, cellStyles: { numberFormat: '0.00' } },
    }},
  ]);
  assert.strictEqual(stats.deduped, 1);
  const a1 = actions.find(a => a.cells && a.cells.A1)?.cells.A1;
  assert.strictEqual(a1.value, 99);
  assert.strictEqual(a1.cellStyles.bold, true);
  assert.strictEqual(a1.cellStyles.numberFormat, '0.00');
});

console.log(process.exitCode ? 'FAILED' : 'PASSED');
