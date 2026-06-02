// Layer C: architect blueprint must reject plans where two slices declare
// owned sheets that differ only in case/whitespace/punctuation.

const assert = require('assert');
const { validateBlueprint } = require('../../server/agents/architect');

function blueprint(slices) {
  return { slices };
}

function main() {
  // 1) Clean blueprint with distinct sheet names passes
  const ok = validateBlueprint(blueprint([
    { id: 'assumptions',   title: 'Assumptions', deps: [], scope: { sheets_owned: ['Assumptions'], ranges_owned: [], may_read_from: [] }, instructions: 'write inputs' },
    { id: 'cost_breakdown', title: 'Costs',     deps: ['assumptions'], scope: { sheets_owned: ['Cost Breakdown'], ranges_owned: [], may_read_from: ['Assumptions!A1:B100'] }, instructions: 'enumerate costs' }
  ]));
  assert.strictEqual(ok.ok, true, 'clean blueprint should pass: ' + JSON.stringify(ok.errors));
  console.log('OK clean blueprint passes');

  // 2) Two slices owning sheets that differ only in whitespace → rejected
  const dup = validateBlueprint(blueprint([
    { id: 'cost_a', title: 'A', deps: [], scope: { sheets_owned: ['Cost Breakdown'], ranges_owned: [], may_read_from: [] }, instructions: 'one' },
    { id: 'cost_b', title: 'B', deps: [], scope: { sheets_owned: ['CostBreakdown'], ranges_owned: [], may_read_from: [] }, instructions: 'two' }
  ]));
  assert.strictEqual(dup.ok, false);
  assert.ok(Array.isArray(dup.errors) && dup.errors.length > 0);
  assert.ok(dup.errors.some(e => /near-duplicate/i.test(e) && /Cost Breakdown/.test(e) && /CostBreakdown/.test(e)));
  console.log('OK near-duplicate Cost Breakdown vs CostBreakdown rejected');

  // 3) Case-only collision rejected
  const caseDup = validateBlueprint(blueprint([
    { id: 'a', title: 'A', deps: [], scope: { sheets_owned: ['Revenue Schedule'], ranges_owned: [], may_read_from: [] }, instructions: 'one' },
    { id: 'b', title: 'B', deps: [], scope: { sheets_owned: ['revenue schedule'], ranges_owned: [], may_read_from: [] }, instructions: 'two' }
  ]));
  assert.strictEqual(caseDup.ok, false);
  console.log('OK case-only collision rejected');

  // 4) Punctuation-only collision rejected
  const punctDup = validateBlueprint(blueprint([
    { id: 'a', title: 'A', deps: [], scope: { sheets_owned: ['P&L'], ranges_owned: [], may_read_from: [] }, instructions: 'one' },
    { id: 'b', title: 'B', deps: [], scope: { sheets_owned: ['PL'], ranges_owned: [], may_read_from: [] }, instructions: 'two' }
  ]));
  assert.strictEqual(punctDup.ok, false);
  console.log('OK punctuation-only collision rejected');

  // 5) Same slice declaring same sheet twice is fine (just one canonical)
  const sameSliceTwice = validateBlueprint(blueprint([
    { id: 'a', title: 'A', deps: [], scope: { sheets_owned: ['Cost Breakdown'], ranges_owned: [], may_read_from: [] }, instructions: 'one' }
  ]));
  assert.strictEqual(sameSliceTwice.ok, true);
  console.log('OK single slice with one sheet passes');

  console.log('\nLayer C blueprint dup-sheet tests completed.');
}

main();
