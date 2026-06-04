'use strict';

const assert = require('assert');
const { deterministicRepair } = require('../../codefirst/deterministicRepair');

// Test 1: missing_sheet_ref auto-correction
{
  const actions = [
    { type: 'createSheet', sheet: 'Assumptions' },
    { type: 'createSheet', sheet: 'DCF' },
    { type: 'setCellRange', sheet: 'DCF', cells: {
      B5: { formula: "='Assumption'!B3" },
    }},
  ];
  const issues = [{
    severity: 'critical',
    kind: 'missing_sheet_ref',
    location: 'DCF!B5',
    detail: 'formula references sheet "Assumption" which is never created',
  }];
  const patches = deterministicRepair(actions, issues);
  assert.strictEqual(patches.length, 1, 'Should produce 1 patch for missing sheet ref');
  assert.strictEqual(patches[0].cells.B5.formula, "=Assumptions!B3", 'Should correct sheet name');
  console.log('✓ deterministicRepair fixes missing_sheet_ref');
}

// Test 2: div_by_zero auto-correction
{
  const actions = [
    { type: 'setCellRange', sheet: 'Projections', cells: {
      B10: { formula: '=A10/0' },
    }},
  ];
  const issues = [{
    severity: 'high',
    kind: 'div_by_zero',
    location: 'Projections!B10',
    detail: 'division by literal 0',
  }];
  const patches = deterministicRepair(actions, issues);
  assert.strictEqual(patches.length, 1, 'Should produce 1 patch for div_by_zero');
  assert.ok(patches[0].cells.B10.formula.includes('0.0001'), 'Should replace 0 with 0.0001');
  console.log('✓ deterministicRepair fixes div_by_zero');
}

// Test 3: no patch for unsupported issue kinds
{
  const actions = [
    { type: 'setCellRange', sheet: 'Projections', cells: { B5: { value: 100 } } },
  ];
  const issues = [{
    severity: 'medium',
    kind: 'possible_hardcoded_computed',
    location: 'Projections!B5',
    detail: 'numeric value without formula',
  }];
  const patches = deterministicRepair(actions, issues);
  assert.strictEqual(patches.length, 0, 'Should not patch unsupported issue kind');
  console.log('✓ deterministicRepair skips unsupported issues');
}

console.log('All deterministicRepair tests passed.');
process.exit(0);
