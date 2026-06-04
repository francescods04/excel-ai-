'use strict';

const assert = require('assert');
const { validateFormulas, extractCellRefs, buildWorkbookIndex } = require('../../codefirst/formulaValidator');

let passed = 0, failed = 0;
function t(label, fn) {
  try { fn(); passed++; console.log(`  ok ${label}`); }
  catch (e) { failed++; console.error(`  FAIL ${label}: ${e.message}`); process.exitCode = 1; }
}

console.log('test_formula_validator');

// ═══════════════════════ extractCellRefs ═══════════════════════

t('cross-sheet + local refs in a single formula', () => {
  const refs = extractCellRefs('=Assumptions!$B$3*B2+SUM(C2:C10)');
  const xsh = refs.filter(r => r.kind === 'xsheet');
  const loc = refs.filter(r => r.kind === 'local');
  assert.strictEqual(xsh.length, 1);
  assert.strictEqual(xsh[0].sheet, 'Assumptions');
  assert.strictEqual(xsh[0].col1, 'B');
  assert.strictEqual(xsh[0].row1, 3);
  assert.ok(loc.length >= 2);
});

t('quoted sheet name with space', () => {
  const refs = extractCellRefs("='My Assumptions'!$B$3");
  const xsh = refs.filter(r => r.kind === 'xsheet');
  assert.strictEqual(xsh.length, 1);
  assert.strictEqual(xsh[0].sheet, 'My Assumptions');
  assert.strictEqual(xsh[0].col1, 'B');
  assert.strictEqual(xsh[0].row1, 3);
});

t('cross-sheet range ref SUM(Assumptions!B1:B10)', () => {
  const refs = extractCellRefs('=SUM(Assumptions!B1:B10)');
  const xsh = refs.filter(r => r.kind === 'xsheet');
  assert.strictEqual(xsh.length, 1);
  assert.strictEqual(xsh[0].sheet, 'Assumptions');
  assert.strictEqual(xsh[0].col1, 'B');
  assert.strictEqual(xsh[0].row1, 1);
  assert.strictEqual(xsh[0].col2, 'B');
  assert.strictEqual(xsh[0].row2, 10);
});

t('quoted cross-sheet range ref', () => {
  const refs = extractCellRefs("=SUM('Proj Assumptions'!C5:C20)");
  const xsh = refs.filter(r => r.kind === 'xsheet');
  assert.strictEqual(xsh.length, 1);
  assert.strictEqual(xsh[0].sheet, 'Proj Assumptions');
  assert.strictEqual(xsh[0].col1, 'C');
  assert.strictEqual(xsh[0].col2, 'C');
});

t('absolute ref with dollar signs', () => {
  const refs = extractCellRefs('=Data!$B$3');
  const xsh = refs.filter(r => r.kind === 'xsheet');
  assert.strictEqual(xsh.length, 1);
  assert.strictEqual(xsh[0].col1, 'B');
  assert.strictEqual(xsh[0].row1, 3);
});

t('mixed absolute/relative ref', () => {
  const refs = extractCellRefs('=Data!$B3');
  const xsh = refs.filter(r => r.kind === 'xsheet');
  assert.strictEqual(xsh.length, 1);
  assert.strictEqual(xsh[0].col1, 'B');
});

t('sheet name with underscore works', () => {
  const refs = extractCellRefs('=My_Sheet!A1');
  const xsh = refs.filter(r => r.kind === 'xsheet');
  assert.strictEqual(xsh.length, 1);
  assert.strictEqual(xsh[0].sheet, 'My_Sheet');
});

t('sheet name with numbers works', () => {
  const refs = extractCellRefs('=Sheet42!X99');
  const xsh = refs.filter(r => r.kind === 'xsheet');
  assert.strictEqual(xsh.length, 1);
  assert.strictEqual(xsh[0].sheet, 'Sheet42');
});

t('empty formula → no refs', () => {
  assert.strictEqual(extractCellRefs('').length, 0);
  assert.strictEqual(extractCellRefs(null).length, 0);
  assert.strictEqual(extractCellRefs(undefined).length, 0);
});

t('numeric formula (no refs) → empty', () => {
  assert.strictEqual(extractCellRefs('=1+2').length, 0);
  assert.strictEqual(extractCellRefs('=100*3.14').length, 0);
});

t('function-only formula (no cell refs) → empty', () => {
  assert.strictEqual(extractCellRefs('=TODAY()').length, 0);
  assert.strictEqual(extractCellRefs('=PI()').length, 0);
  assert.strictEqual(extractCellRefs('=RAND()').length, 0);
});

t('VLOOKUP with cross-sheet table array', () => {
  const refs = extractCellRefs('=VLOOKUP(B2, Assumptions!A1:C10, 2, FALSE)');
  const xsh = refs.filter(r => r.kind === 'xsheet');
  assert.strictEqual(xsh.length, 1);
  assert.strictEqual(xsh[0].sheet, 'Assumptions');
  assert.strictEqual(xsh[0].col1, 'A');
  assert.strictEqual(xsh[0].col2, 'C');
  const loc = refs.filter(r => r.kind === 'local');
  assert.ok(loc.some(r => r.col === 'B' && r.row === 2), 'VLOOKUP key B2 should be found as local ref');
});

t('multiple cross-sheet refs in one formula', () => {
  const refs = extractCellRefs('=Sheet1!A1+Sheet2!B2+Sheet3!C3');
  const xsh = refs.filter(r => r.kind === 'xsheet');
  assert.strictEqual(xsh.length, 3);
  assert.strictEqual(xsh[0].sheet, 'Sheet1');
  assert.strictEqual(xsh[1].sheet, 'Sheet2');
  assert.strictEqual(xsh[2].sheet, 'Sheet3');
});

t('string literal formula → no refs', () => {
  assert.strictEqual(extractCellRefs('="Hello World"').length, 0);
  assert.strictEqual(extractCellRefs('="Revenue"').length, 0);
});

t('local ref with dollar signs', () => {
  const refs = extractCellRefs('=$B$2');
  const loc = refs.filter(r => r.kind === 'local');
  assert.strictEqual(loc.length, 1);
  assert.strictEqual(loc[0].col, 'B');
  assert.strictEqual(loc[0].row, 2);
});

// ═══════════════════════ buildWorkbookIndex ═══════════════════════

t('buildWorkbookIndex: merges existing context + new actions', () => {
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

t('buildWorkbookIndex: registers sheets from workbookSheets context', () => {
  const ctx = { workbookSheets: ['SheetA', 'SheetB', 'SheetC'] };
  const { sheets } = buildWorkbookIndex([], ctx);
  assert.ok(sheets.has('SheetA'));
  assert.ok(sheets.has('SheetB'));
  assert.ok(sheets.has('SheetC'));
});

t('buildWorkbookIndex: registers sheets from allSheets context', () => {
  const ctx = { allSheets: ['Foo', 'Bar'] };
  const { sheets } = buildWorkbookIndex([], ctx);
  assert.ok(sheets.has('Foo'));
  assert.ok(sheets.has('Bar'));
});

t('buildWorkbookIndex: registers sheets from allSheetsData keys', () => {
  const ctx = { allSheetsData: { Baz: {}, Qux: {} } };
  const { sheets } = buildWorkbookIndex([], ctx);
  assert.ok(sheets.has('Baz'));
  assert.ok(sheets.has('Qux'));
});

t('buildWorkbookIndex: sheetName property as alternative to sheet', () => {
  const actions = [
    { type: 'createSheet', sheetName: 'AltName' },
    { type: 'setCellRange', sheetName: 'AltName', cells: { A1: { value: 42 } } },
  ];
  const { sheets, cellsBySheet } = buildWorkbookIndex(actions);
  assert.ok(sheets.has('AltName'));
  assert.ok(cellsBySheet.get('AltName').has('A1'));
});

t('buildWorkbookIndex: empty actions and null context → empty index', () => {
  const { sheets, cellsBySheet } = buildWorkbookIndex([], null);
  assert.strictEqual(sheets.size, 0);
  assert.strictEqual(cellsBySheet.size, 0);
});

t('buildWorkbookIndex: createSheet without sheet name → skipped gracefully', () => {
  const actions = [
    { type: 'createSheet' },
  ];
  const { sheets } = buildWorkbookIndex(actions);
  assert.strictEqual(sheets.size, 0);
});

// ═══════════════════════ validateFormulas ═══════════════════════

t('validateFormulas: unknown sheet → critical', () => {
  const actions = [
    { type: 'createSheet', sheet: 'A' },
    { type: 'setCellRange', sheet: 'A', cells: { B1: { formula: '=Ghost!$A$1' } } },
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'unknown_sheet_ref' && i.severity === 'critical'));
});

t('validateFormulas: self-reference → critical', () => {
  const actions = [
    { type: 'createSheet', sheet: 'A' },
    { type: 'setCellRange', sheet: 'A', cells: { B1: { formula: '=B1+1' } } },
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'self_reference'));
});

t('validateFormulas: div by literal 0 → high', () => {
  const actions = [
    { type: 'setCellRange', sheet: 'A', cells: { B1: { formula: '=A1/0' } } },
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'div_by_zero'));
});

t('validateFormulas: div by 0.0 → high (edge: decimal zero)', () => {
  const actions = [
    { type: 'setCellRange', sheet: 'A', cells: { B1: { formula: '=A1/0.0' } } },
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'div_by_zero'), '0.0 should be caught');
});

t('validateFormulas: div by .0 → high (edge: leading dot zero)', () => {
  const actions = [
    { type: 'setCellRange', sheet: 'A', cells: { B1: { formula: '=A1/.0' } } },
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'div_by_zero'), '.0 should be caught');
});

t('validateFormulas: div by 0 followed by paren → high', () => {
  const actions = [
    { type: 'setCellRange', sheet: 'A', cells: { B1: { formula: '=A1/(0)' } } },
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'div_by_zero'));
});

t('validateFormulas: clean workbook → no critical issues', () => {
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

t('validateFormulas: empty xsheet target → medium', () => {
  const actions = [
    { type: 'createSheet', sheet: 'Assumptions' },
    { type: 'createSheet', sheet: 'Projections' },
    { type: 'setCellRange', sheet: 'Assumptions', cells: { B2: { value: 0.1 } } },
    { type: 'setCellRange', sheet: 'Projections', cells: { B2: { formula: '=Assumptions!$B$99' } } },
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'empty_xsheet_ref'));
});

t('validateFormulas: empty xsheet range ref → medium', () => {
  const actions = [
    { type: 'createSheet', sheet: 'Data' },
    { type: 'createSheet', sheet: 'Calc' },
    { type: 'setCellRange', sheet: 'Data', cells: { A1: { value: 1 }, Z99: { value: 99 } } },
    { type: 'setCellRange', sheet: 'Calc', cells: { B1: { formula: '=SUM(Data!B1:B10)' } } },
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'empty_xsheet_range_ref'),
    `Expected empty_xsheet_range_ref, got: ${JSON.stringify(issues.map(i => i.kind))}`);
});

t('validateFormulas: range ref partially filled → no empty warning', () => {
  const actions = [
    { type: 'createSheet', sheet: 'Src' },
    { type: 'createSheet', sheet: 'Tgt' },
    { type: 'setCellRange', sheet: 'Src', cells: { B1: { value: 100 } } },
    { type: 'setCellRange', sheet: 'Tgt', cells: { A1: { formula: '=SUM(Src!B1:B10)' } } },
  ];
  const issues = validateFormulas(actions);
  const emptyRange = issues.filter(i => i.kind === 'empty_xsheet_range_ref');
  assert.strictEqual(emptyRange.length, 0,
    `Should not flag when B1 endpoint exists: ${JSON.stringify(emptyRange)}`);
});

t('validateFormulas: cross-sheet self-reference → critical', () => {
  const actions = [
    { type: 'createSheet', sheet: 'Sheet1' },
    { type: 'setCellRange', sheet: 'Sheet1', cells: { B1: { formula: '=Sheet1!B1+1' } } },
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'self_reference_xsheet'),
    `Expected self_reference_xsheet, got: ${JSON.stringify(issues.map(i => i.kind))}`);
});

t('validateFormulas: cross-sheet ref to other cell on same sheet → ok (not self)', () => {
  const actions = [
    { type: 'createSheet', sheet: 'Sheet1' },
    { type: 'setCellRange', sheet: 'Sheet1', cells: { B2: { formula: '=Sheet1!B1+1' } } },
  ];
  const issues = validateFormulas(actions);
  const selfRefs = issues.filter(i => i.kind === 'self_reference' || i.kind === 'self_reference_xsheet');
  assert.strictEqual(selfRefs.length, 0, `Should not flag cross-sheet ref to different cell: ${JSON.stringify(selfRefs)}`);
});

t('validateFormulas: empty setCellRange → no issues', () => {
  const actions = [
    { type: 'setCellRange', sheet: 'A', cells: {} },
  ];
  const issues = validateFormulas(actions);
  assert.strictEqual(issues.length, 0);
});

t('validateFormulas: mixed formula and value cells → only formulas checked', () => {
  const actions = [
    { type: 'createSheet', sheet: 'A' },
    { type: 'setCellRange', sheet: 'A', cells: {
      B1: { value: 100 },
      B2: { formula: '=Unknown!X99' },
    }},
  ];
  const issues = validateFormulas(actions);
  assert.strictEqual(issues.length, 1, 'Only the formula cell should produce an issue');
  assert.strictEqual(issues[0].kind, 'unknown_sheet_ref');
});

t('validateFormulas: spec with non-object value → skipped', () => {
  const actions = [
    { type: 'setCellRange', sheet: 'A', cells: { B1: 'just a string' } },
  ];
  const issues = validateFormulas(actions);
  assert.strictEqual(issues.length, 0);
});

t('validateFormulas: multiple formulas in same setCellRange → all checked', () => {
  const actions = [
    { type: 'createSheet', sheet: 'A' },
    { type: 'setCellRange', sheet: 'A', cells: {
      B1: { formula: '=A1/0' },
      B2: { formula: '=B2+1' },
    }},
  ];
  const issues = validateFormulas(actions);
  assert.ok(issues.some(i => i.kind === 'div_by_zero'), 'div by 0 should be found');
  assert.ok(issues.some(i => i.kind === 'self_reference'), 'self ref should be found');
  assert.strictEqual(issues.length, 2);
});

t('validateFormulas: aggregate across multiple setCellRange actions', () => {
  const actions = [
    { type: 'createSheet', sheet: 'A' },
    { type: 'setCellRange', sheet: 'A', cells: { B1: { formula: '=Ghost!X1' } } },
    { type: 'setCellRange', sheet: 'A', cells: { B2: { formula: '=Ghost!X2' } } },
  ];
  const issues = validateFormulas(actions);
  assert.strictEqual(issues.filter(i => i.kind === 'unknown_sheet_ref').length, 2);
});

t('validateFormulas: existingContext provides sheet names for ref resolution', () => {
  const ctx = {
    sheets: [{ name: 'Existing', preview: [['a']] }],
  };
  const actions = [
    { type: 'setCellRange', sheet: 'A', cells: { B1: { formula: '=Existing!A1' } } },
  ];
  const issues = validateFormulas(actions, ctx);
  const unknown = issues.filter(i => i.kind === 'unknown_sheet_ref');
  assert.strictEqual(unknown.length, 0, `Existing sheet should resolve: ${JSON.stringify(unknown)}`);
});

t('validateFormulas: existingContext with workbookSheets as fallback', () => {
  const ctx = { workbookSheets: ['LegacySheet'] };
  const actions = [
    { type: 'setCellRange', sheet: 'A', cells: { B1: { formula: '=LegacySheet!A1' } } },
  ];
  const issues = validateFormulas(actions, ctx);
  const unknown = issues.filter(i => i.kind === 'unknown_sheet_ref');
  assert.strictEqual(unknown.length, 0);
});

t('validateFormulas: null/empty actions → no issues', () => {
  assert.strictEqual(validateFormulas(null).length, 0);
  assert.strictEqual(validateFormulas([]).length, 0);
  assert.strictEqual(validateFormulas(undefined).length, 0);
});

t('validateFormulas: non-setCellRange actions ignored', () => {
  const actions = [
    { type: 'createSheet', sheet: 'A' },
    { type: 'renameSheet', sheet: 'A', newName: 'B' },
  ];
  const issues = validateFormulas(actions);
  assert.strictEqual(issues.length, 0);
});

t('validateFormulas: ten cross-sheet refs to the same valid sheet → ok', () => {
  const actions = [
    { type: 'createSheet', sheet: 'Src' },
    { type: 'createSheet', sheet: 'Tgt' },
    { type: 'setCellRange', sheet: 'Src', cells: { A1: { value: 1 } } },
  ];
  for (let i = 0; i < 10; i++) {
    actions.push({
      type: 'setCellRange', sheet: 'Tgt',
      cells: { [`A${i + 1}`]: { formula: '=Src!$A$1' } },
    });
  }
  const issues = validateFormulas(actions);
  const critical = issues.filter(i => i.severity === 'critical');
  assert.strictEqual(critical.length, 0, `No critical expected: ${JSON.stringify(critical)}`);
});

t('validateFormulas: very long formula with many refs', () => {
  const parts = ['=A1'];
  for (let i = 2; i <= 50; i++) parts.push(`+B${i}`);
  const formula = parts.join('');
  const refs = extractCellRefs(formula);
  assert.ok(refs.length >= 50, `Expected >=50 refs, got ${refs.length}`);
});

t('validateFormulas: div by cell named 0 or A0 → NOT flagged', () => {
  const actions = [
    { type: 'setCellRange', sheet: 'A', cells: { B1: { formula: '=A1/A0' } } },
  ];
  const issues = validateFormulas(actions);
  const divs = issues.filter(i => i.kind === 'div_by_zero');
  assert.strictEqual(divs.length, 0, 'Division by cell A0 should NOT be flagged as div by literal 0');
});

t('validateFormulas: self-reference not triggered for cross-sheet ref to another sheet', () => {
  const actions = [
    { type: 'createSheet', sheet: 'Sheet1' },
    { type: 'createSheet', sheet: 'Sheet2' },
    { type: 'setCellRange', sheet: 'Sheet1', cells: { B1: { formula: '=Sheet2!B1' } } },
  ];
  const issues = validateFormulas(actions);
  const selfRefs = issues.filter(i => i.kind === 'self_reference' || i.kind === 'self_reference_xsheet');
  assert.strictEqual(selfRefs.length, 0);
});

t('validateFormulas: sheet created after formula ref → ok (actions before ref)', () => {
  // createSheet comes before setCellRange that references it
  const actions = [
    { type: 'createSheet', sheet: 'Late' },
    { type: 'setCellRange', sheet: 'Late', cells: { A1: { value: 1 } } },
    { type: 'createSheet', sheet: 'Early' },
    { type: 'setCellRange', sheet: 'Early', cells: { B1: { formula: '=Late!A1' } } },
  ];
  const issues = validateFormulas(actions);
  const unknown = issues.filter(i => i.kind === 'unknown_sheet_ref');
  assert.strictEqual(unknown.length, 0, `Late!A1 should resolve: ${JSON.stringify(unknown)}`);
});

console.log(`\n[test_formula_validator] ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
