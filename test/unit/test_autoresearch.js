'use strict';

const assert = require('assert');
const { applyPatches } = require('../../codefirst/repairAgent');
const { structuralValidation } = require('../../codefirst/financialCritic');

function testApplyPatches() {
  const base = [
    { type: 'setCellRange', sheet: 'DCF', cells: { 'A1': { value: 'Rev' }, 'B1': { value: 100 } } },
  ];
  const patches = [
    { type: 'setCellRange', sheet: 'DCF', cells: { 'B1': { formula: '=Assumptions!B1' } } },
    { type: 'setCellRange', sheet: 'DCF', cells: { 'C1': { value: 200 } } },
  ];

  const merged = applyPatches(base, patches);

  assert.strictEqual(merged.length, 1, 'Should merge into one setCellRange per sheet');
  const dcf = merged.find(a => a.sheet === 'DCF');
  assert.ok(dcf, 'DCF action should exist');
  assert.strictEqual(dcf.cells['B1'].formula, '=Assumptions!B1', 'Patch should override B1');
  assert.strictEqual(dcf.cells['C1'].value, 200, 'New cell C1 should be added');
  assert.strictEqual(dcf.cells['A1'].value, 'Rev', 'Unpatched A1 should remain');

  console.log('✓ testApplyPatches');
}

function testStructuralValidation() {
  // Test 1: suspicious margin (percent format with value >2)
  const actions1 = [{
    type: 'setCellRange',
    sheet: 'Assumptions',
    cells: {
      'B3': { value: 0.25, cellStyles: { numberFormat: '0.0%' } },
      'B4': { value: 60, cellStyles: { numberFormat: '0.0%' } },
    }
  }];
  const issues1 = structuralValidation(actions1);
  const suspicious = issues1.filter(i => i.kind === 'suspicious_margin');
  assert.strictEqual(suspicious.length, 1, 'Should flag 60 as suspicious margin (6000%)');
  assert.strictEqual(suspicious[0].severity, 'high');

  // Test 2: cross-sheet ref to missing sheet
  const actions2 = [{
    type: 'createSheet', sheet: 'DCF'
  }, {
    type: 'setCellRange',
    sheet: 'DCF',
    cells: { 'B5': { formula: '=MissingSheet!B2' } }
  }];
  const issues2 = structuralValidation(actions2);
  const missing = issues2.filter(i => i.kind === 'missing_sheet_ref');
  assert.strictEqual(missing.length, 1);
  assert.strictEqual(missing[0].severity, 'critical');

  // Test 3: stale time series
  const actions3 = [{
    type: 'setCellRange',
    sheet: 'Proj',
    cells: {
      'B2': { value: 100 },
      'C2': { value: 100 },
      'D2': { value: 100 },
      'E2': { value: 100 },
      'F2': { value: 100 },
    }
  }];
  const issues3 = structuralValidation(actions3);
  const stale = issues3.filter(i => i.kind === 'stale_time_series');
  assert.strictEqual(stale.length, 1);
  assert.strictEqual(stale[0].severity, 'high');

  console.log('✓ testStructuralValidation');
}

function testApplyPatchesCreatesNewAction() {
  const base = [
    { type: 'setCellRange', sheet: 'Sheet1', cells: { 'A1': { value: 'X' } } },
  ];
  const patches = [
    { type: 'setCellRange', sheet: 'Sheet2', cells: { 'A1': { value: 'Y' } } },
  ];

  const merged = applyPatches(base, patches);
  assert.strictEqual(merged.length, 2, 'Should create new action for new sheet');
  assert.ok(merged.some(a => a.sheet === 'Sheet2'));

  console.log('✓ testApplyPatchesCreatesNewAction');
}

(async function main() {
  try {
    testApplyPatches();
    testStructuralValidation();
    testApplyPatchesCreatesNewAction();
    console.log('\nAll autoresearch unit tests passed.');
    process.exit(0);
  } catch (err) {
    console.error('Test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
