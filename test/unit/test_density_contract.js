'use strict';

// Tests for density-contract enforcement (sliceLoop.checkDensityContract via
// validateSliceActions) and snap-to-edge ref remap (refRepair.snapRefsToEdge).

const assert = require('assert');
const { validateSliceActions } = require('../../codefirst/sliceLoop');
const { snapRefsToEdge } = require('../../codefirst/refRepair');

function cells(sheet, spec) {
  return { type: 'setCellRange', sheet, cells: spec };
}

function seriesRow(sheet, row, fromCol, toCol, make) {
  const out = {};
  for (let c = fromCol; c <= toCol; c++) {
    const col = String.fromCharCode(64 + c);
    out[`${col}${row}`] = make ? make(col) : { value: c };
  }
  return cells(sheet, out);
}

// --- density contract: exported range violated ---
{
  const section = {
    sheet: 'Operating_Model',
    is_time_series: true,
    periods: 24,
    exported_cells: ['B4:Y4 = EBITDA'],
  };
  // Row 4 written only B..M (cols 2..13) — contract says through Y (25)
  const actions = [
    cells('Operating_Model', { A4: { value: 'EBITDA' } }),
    seriesRow('Operating_Model', 4, 2, 13),
  ];
  const issues = validateSliceActions(actions, [], 'Operating_Model', section);
  const density = issues.filter(i => i.kind === 'density_contract');
  assert.ok(density.length >= 1, 'expected density_contract issue for short exported row');
  assert.ok(density.some(i => i.severity === 'critical'), 'exported-range violation must be critical');
  assert.ok(density[0].detail.includes('Y'), 'detail should name the required end column');
}

// --- density contract: satisfied ---
{
  const section = {
    sheet: 'Operating_Model',
    is_time_series: true,
    periods: 12,
    exported_cells: ['B4:M4 = EBITDA'],
  };
  const actions = [
    cells('Operating_Model', { A4: { value: 'EBITDA' } }),
    seriesRow('Operating_Model', 4, 2, 13), // B..M = full 12 periods
  ];
  const issues = validateSliceActions(actions, [], 'Operating_Model', section);
  assert.strictEqual(issues.filter(i => i.kind === 'density_contract').length, 0, 'full row must not be flagged');
}

// --- density contract: single-value rows ignored ---
{
  const section = { sheet: 'Assumptions', is_time_series: true, periods: 24, exported_cells: [] };
  const actions = [cells('Assumptions', { A3: { value: 'Tax Rate' }, B3: { value: 0.24 } })];
  const issues = validateSliceActions(actions, [], 'Assumptions', section);
  assert.strictEqual(issues.filter(i => i.kind === 'density_contract').length, 0, 'single-value rows are not series');
}

// --- density contract: series row short of declared periods → high ---
{
  const section = { sheet: 'PnL', is_time_series: true, periods: 24, exported_cells: [] };
  const actions = [seriesRow('PnL', 7, 2, 10)]; // B..J only, 24 periods declared (through Y)
  const issues = validateSliceActions(actions, [], 'PnL', section);
  const density = issues.filter(i => i.kind === 'density_contract');
  assert.ok(density.length === 1, 'short series row flagged once');
  assert.strictEqual(density[0].severity, 'high');
}

// --- snap-to-edge: past-the-edge cross-sheet ref snapped to last written col ---
{
  const actions = [
    seriesRow('Operating_Model', 4, 2, 13), // B4..M4 written
    cells('Exit_Analysis', {
      B3: { formula: '=Assumptions_Deal!$B$16*Operating_Model!$X$4' },
      B9: { formula: '=Operating_Model!X4' },
    }),
  ];
  const n = snapRefsToEdge(actions);
  assert.strictEqual(n, 2, `expected 2 formulas snapped, got ${n}`);
  const ea = actions[1].cells;
  assert.strictEqual(ea.B3.formula, '=Assumptions_Deal!$B$16*Operating_Model!$M$4');
  assert.strictEqual(ea.B9.formula, '=Operating_Model!M4');
}

// --- snap-to-edge: existing target untouched; non-series rows untouched ---
{
  const actions = [
    seriesRow('Operating_Model', 4, 2, 13),
    cells('Assumptions', { B16: { value: 10 } }), // single-value row
    cells('Exit_Analysis', {
      B1: { formula: '=Operating_Model!M4' },     // valid — must not change
      B2: { formula: '=Assumptions!Z16' },        // non-series row — must not guess
      B4: { formula: '=Returns!X9' },             // unknown row — must not change
    }),
  ];
  const n = snapRefsToEdge(actions);
  assert.strictEqual(n, 0, 'no snapping expected');
  const ea = actions[2].cells;
  assert.strictEqual(ea.B1.formula, '=Operating_Model!M4');
  assert.strictEqual(ea.B2.formula, '=Assumptions!Z16');
  assert.strictEqual(ea.B4.formula, '=Returns!X9');
}

// --- snap-to-edge: same-sheet refs ignored (handled by autofill/stub) ---
{
  const actions = [
    seriesRow('PnL', 3, 2, 13),
    cells('PnL', { B5: { formula: '=PnL!X3+X3' } }),
  ];
  // Qualified same-sheet ref: localSheet === targetSheet → skip
  const n = snapRefsToEdge(actions);
  assert.strictEqual(n, 0, 'same-sheet refs are not snapped');
}

console.log('[test_density_contract] All tests passed');
