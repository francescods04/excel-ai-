// Layer D: intra-batch numeric outlier detector. Verifies that obvious
// unit-mix / wrong-row-reference values (e.g. €75B in a column of €1M-€20M
// peers) get flagged, while legitimate batches pass through.

const assert = require('assert');
const { detectNumericOutliers, buildOutlierError } = require('../../server/agents/agentLoop');

function cellSpec(value, formula) {
  return formula !== undefined ? { formula } : { value };
}

function buildColumn(sheet, col, rows, values) {
  const cells = {};
  for (let i = 0; i < rows; i++) cells[`${col}${i + 2}`] = cellSpec(values[i]);
  return { sheet, cells };
}

function main() {
  // 1) Homogeneous column → no outliers
  const homog = detectNumericOutliers([
    buildColumn('CostBreakdown', 'F', 10, [1500000, 135000, 50, 50, 22500, 45000, 9900, 5000, 20000, 10000])
  ]);
  assert.strictEqual(homog.length, 0, 'homogeneous column should not flag');
  console.log('OK homogeneous column passes');

  // 2) The Vairano €75B Direzione Lavori scenario — single huge value among millions
  const vairanoStyle = detectNumericOutliers([
    buildColumn('CostBreakdown', 'F', 10, [1500000, 135000, 22500, 45000, 75000, 75000, 75000000000, 10000, 3000, 50000])
  ]);
  assert.ok(vairanoStyle.length >= 1, `Vairano €75B should flag (got ${vairanoStyle.length})`);
  const flagged = vairanoStyle.find(o => o.value === 75000000000);
  assert.ok(flagged, 'the 75B cell should be in the flagged list');
  assert.strictEqual(flagged.sheet, 'CostBreakdown');
  assert.strictEqual(flagged.col, 'F');
  console.log('OK €75B outlier flagged in a column of €M peers');

  // 3) Small numbers (percentages) should NOT flag even if one is relatively bigger
  const pcts = detectNumericOutliers([
    buildColumn('Assumptions', 'B', 8, [0.01, 0.02, 0.015, 0.05, 0.10, 0.08, 0.50, 0.03])
  ]);
  assert.strictEqual(pcts.length, 0, 'percentages should never flag (abs threshold gates)');
  console.log('OK percentage column not flagged (abs threshold respected)');

  // 4) Group < 5 entries: no median/MAD computed
  const tinyGroup = detectNumericOutliers([
    buildColumn('CostBreakdown', 'B', 3, [100, 100, 75000000000])
  ]);
  assert.strictEqual(tinyGroup.length, 0, 'fewer than 5 values should skip the check');
  console.log('OK group <5 values not flagged (insufficient data)');

  // 5) Formula cells are ignored (post-eval data only)
  const formulaIgnored = detectNumericOutliers([{
    sheet: 'CashFlow',
    cells: {
      B2: { formula: '=SUM(Assumptions!A1:A10)' },
      B3: { value: 1000 },
      B4: { value: 1100 },
      B5: { value: 1200 },
      B6: { value: 1150 },
      B7: { value: 1050 }
    }
  }]);
  assert.strictEqual(formulaIgnored.length, 0, 'formula cells should be ignored');
  console.log('OK formula cells ignored');

  // 6) Cross-sheet writes in one bulk should be checked independently per sheet
  const multiSheet = detectNumericOutliers([
    buildColumn('Costs', 'F', 8, [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000]),
    buildColumn('Revenue', 'B', 8, [100000, 110000, 120000, 130000, 140000, 150000, 999000000000, 170000])
  ]);
  assert.strictEqual(multiSheet.length, 1, `cross-sheet check: expected 1 flag, got ${multiSheet.length}`);
  assert.strictEqual(multiSheet[0].sheet, 'Revenue');
  console.log('OK outlier flagged on correct sheet in multi-sheet bulk');

  // 7) Error message is informative
  const msg = buildOutlierError(vairanoStyle);
  assert.ok(typeof msg === 'string' && msg.length > 100);
  assert.ok(/Numerical outlier guard/.test(msg));
  assert.ok(/75000000000/.test(msg) || /75e/.test(msg) || /CostBreakdown!/.test(msg));
  assert.ok(/median/i.test(msg) && /MAD/i.test(msg));
  console.log('OK error message includes flagged cells + median/MAD context');

  // 8) Buildtin error with empty input returns null
  assert.strictEqual(buildOutlierError([]), null);
  assert.strictEqual(buildOutlierError(null), null);
  console.log('OK empty outlier list yields null error');

  console.log('\nLayer D numeric outlier tests completed.');
}

main();
