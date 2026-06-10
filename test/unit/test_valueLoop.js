'use strict';

const assert = require('assert');
const { buildComputedSnapshot } = require('../../codefirst/valueLoop');

function cells(sheet, spec) {
  return { type: 'setCellRange', sheet, cells: spec };
}

// --- snapshot computes formulas and renders labeled rows ---
{
  const actions = [
    cells('Assumptions', {
      A2: { value: 'Revenue Y1' }, B2: { value: 1000000 },
      A3: { value: 'Growth' }, B3: { value: 0.1 },
    }),
    cells('PnL', {
      A2: { value: 'Revenue' },
      B2: { formula: '=Assumptions!B2' },
      C2: { formula: '=B2*(1+Assumptions!B3)' },
      A3: { value: 'EBITDA' },
      B3: { formula: '=B2*0.3' },
      C3: { formula: '=C2*0.3' },
    }),
  ];
  const snap = buildComputedSnapshot(actions);
  assert.ok(snap.includes('=== Assumptions ==='), 'sheet header present');
  assert.ok(snap.includes('"Revenue Y1"'), 'label rendered');
  assert.ok(snap.includes('B=1.00M'), `computed value formatted: ${snap}`);
  assert.ok(snap.includes('C=1.10M'), `cross-cell formula computed: ${snap}`);
  assert.ok(snap.includes('B=300.0k') || snap.includes('B=0.30M'), `EBITDA computed: ${snap}`);
}

// --- long series rows get head…tail elision ---
{
  const spec = { A5: { value: 'Quarterly Revenue' } };
  for (let c = 2; c <= 25; c++) {
    const col = String.fromCharCode(64 + c);
    spec[`${col}5`] = { value: c * 100 };
  }
  const snap = buildComputedSnapshot([cells('OpModel', spec)]);
  assert.ok(snap.includes('…'), 'elision marker for 24-col row');
  assert.ok(snap.includes('Y=2500'), 'last column shown');
  assert.ok(snap.includes('B=200'), 'first column shown');
}

// --- unlabeled rows and empty sheets skipped ---
{
  const snap = buildComputedSnapshot([
    cells('Data', { B1: { value: 5 }, C1: { value: 6 } }), // no col-A label
  ]);
  assert.strictEqual(snap, '', 'no labeled rows → empty snapshot');
}

// --- error markers surface ---
{
  const snap = buildComputedSnapshot([
    cells('X', { A2: { value: 'Bad' }, B2: { formula: '=NOSUCHFN(1)' } }),
  ]);
  assert.ok(snap.includes('#ERR') || snap.includes('#NOEVAL'), `error marker rendered: ${snap}`);
}

console.log('[test_valueLoop] All tests passed');
