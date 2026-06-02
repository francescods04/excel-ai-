// Padding guard must NOT fire on short unit/category labels (€/mq, %, mq,
// cad, forfait, EUR). Otherwise the agent enters a loop trying to make
// every label unique ("€/mq1", "€/mq2", …) instead of writing the
// schema correctly.

const assert = require('assert');
const { detectPaddingRows } = require('../../server/agents/agentLoop');

function buildColumn(sheet, col, values) {
  const cells = {};
  values.forEach((v, i) => { cells[`${col}${i + 2}`] = { value: v }; });
  return { sheet, cells };
}

function main() {
  // 1) "€/mq" repeated 50 times in a Unit column → NOT padding
  const units = detectPaddingRows([
    buildColumn('CostBreakdown', 'C', Array(50).fill('€/mq'))
  ]);
  assert.strictEqual(units.ok, true, 'short unit label "€/mq" repeated should be allowed');
  console.log('OK €/mq repeated 50× allowed (short unit label)');

  // 2) "%" repeated 40 times → NOT padding
  const pcts = detectPaddingRows([
    buildColumn('CostBreakdown', 'C', Array(40).fill('%'))
  ]);
  assert.strictEqual(pcts.ok, true);
  console.log('OK "%" repeated 40× allowed');

  // 3) "forfait" (7 chars) repeated 25 times → NOT padding
  const forfait = detectPaddingRows([
    buildColumn('CostBreakdown', 'C', Array(25).fill('forfait'))
  ]);
  assert.strictEqual(forfait.ok, true);
  console.log('OK "forfait" repeated 25× allowed');

  // 4) Long text label repeated 30 times → IS padding (still blocked)
  const longText = detectPaddingRows([
    buildColumn('PerFloorDetail', 'B', Array(30).fill('Scavi e movimentazione terra'))
  ]);
  assert.strictEqual(longText.ok, false, 'long-text padding should still be rejected');
  assert.ok(/Scavi/.test(longText.reason));
  console.log('OK long-text padding still rejected');

  // 5) Numeric scalar repeated 30 times → IS padding (still blocked)
  const numericPad = detectPaddingRows([
    buildColumn('PerFloorDetail', 'D', Array(30).fill(10000))
  ]);
  assert.strictEqual(numericPad.ok, false, 'numeric padding should still be rejected');
  console.log('OK numeric padding still rejected');

  // 6) Numeric short string e.g. "100" repeated → still treated as numeric (rejected)
  const numericStr = detectPaddingRows([
    buildColumn('PerFloorDetail', 'D', Array(30).fill('100'))
  ]);
  assert.strictEqual(numericStr.ok, false, '"100"-style numeric strings still rejected');
  console.log('OK numeric strings still rejected');

  // 7) Mixed batch: short unit + numeric padding → numeric flagged, units pass
  const mixed = detectPaddingRows([
    buildColumn('Costs', 'C', Array(40).fill('mq')),
    buildColumn('Costs', 'D', Array(40).fill(500000))
  ]);
  assert.strictEqual(mixed.ok, false);
  assert.strictEqual(mixed.col, 'D');
  console.log('OK mixed batch: unit column passes, numeric column flagged');

  console.log('\npadding unit-exemption tests completed.');
}

main();
