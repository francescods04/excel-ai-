'use strict';

const assert = require('assert');
const { applyPlanPatches, summarizePlanForReview } = require('../../codefirst/planReview');

function freshPlan() {
  return {
    sections: [
      { sheet: 'Assumptions', title: 'Inputs', exported_cells: ['B3 = Tax Rate'] },
      { sheet: 'PnL', title: 'P&L', exported_cells: [] },
    ],
    cross_sheet_deps: { PnL: { reads_from: ['Assumptions'] } },
    invariants: [],
  };
}

// --- add_section: new sheet appended, duplicate ignored ---
{
  const plan = freshPlan();
  const stats = applyPlanPatches(plan, [
    { op: 'add_section', section: { sheet: 'CashFlow', title: 'Cash Flow', estimated_cells: 60 } },
    { op: 'add_section', section: { sheet: 'PnL', title: 'dup' } },
  ]);
  assert.strictEqual(stats.sectionsAdded, 1);
  assert.strictEqual(plan.sections.length, 3);
  assert.ok(plan.sections.some(s => s.sheet === 'CashFlow'));
}

// --- add_dep: merged, self/unknown sheets rejected ---
{
  const plan = freshPlan();
  const stats = applyPlanPatches(plan, [
    { op: 'add_dep', sheet: 'PnL', reads_from: ['Assumptions', 'PnL', 'GhostSheet'] },
  ]);
  assert.strictEqual(stats.depsAdded, 0, 'existing dep, self-dep and unknown sheet all rejected');
  const plan2 = freshPlan();
  plan2.sections.push({ sheet: 'Revenue' });
  applyPlanPatches(plan2, [{ op: 'add_dep', sheet: 'PnL', reads_from: ['Revenue'] }]);
  assert.deepStrictEqual(plan2.cross_sheet_deps.PnL.reads_from, ['Assumptions', 'Revenue']);
}

// --- add_exports + add_invariant ---
{
  const plan = freshPlan();
  const stats = applyPlanPatches(plan, [
    { op: 'add_exports', sheet: 'PnL', exported_cells: ['B10:F10 = EBITDA'] },
    { op: 'add_invariant', invariant: { kind: 'balance', left: 'A!Total Sources', right: 'A!Total Uses' } },
  ]);
  assert.strictEqual(stats.exportsAdded, 1);
  assert.strictEqual(stats.invariantsAdded, 1);
  assert.ok(plan.sections[1].exported_cells.includes('B10:F10 = EBITDA'));
  assert.strictEqual(plan.invariants.length, 1);
}

// --- malformed patches ignored, cap respected ---
{
  const plan = freshPlan();
  const junk = [null, {}, { op: 'add_exports', sheet: 'NoSuch', exported_cells: ['x'] }];
  const many = Array.from({ length: 20 }, (_, i) => ({ op: 'add_invariant', invariant: { kind: 'balance', left: `L${i}`, right: `R${i}` } }));
  const stats = applyPlanPatches(plan, [...junk, ...many]);
  assert.ok(stats.invariantsAdded <= 12, `cap respected: ${stats.invariantsAdded}`);
}

// --- summary is compact JSON ---
{
  const s = summarizePlanForReview(freshPlan());
  const parsed = JSON.parse(s);
  assert.ok(parsed.sections.length === 2 && parsed.cross_sheet_deps.PnL);
}

console.log('[test_planReview] All tests passed');
