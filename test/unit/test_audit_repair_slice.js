// Layer A: final-verification slice should be promoted to a structured
// audit + repair protocol with deeper reasoning + extra iter budget.

const assert = require('assert');
const { validateBlueprint } = require('../../server/agents/architect');

function blueprint(slices, raw) {
  return { slices, ...(raw || {}) };
}

function findSlice(bp, id) {
  return bp.slices.find(s => s.id === id);
}

function main() {
  // 1) A "format_and_verify" slice gets audit protocol appended
  const result = validateBlueprint(blueprint([
    { id: 'assumptions', title: 'Assumptions', deps: [], scope: { sheets_owned: ['Assumptions'], ranges_owned: [], may_read_from: [] }, instructions: 'write inputs' },
    { id: 'format_and_verify', title: 'Format and Verify', deps: ['assumptions'], scope: { sheets_owned: [], ranges_owned: [], may_read_from: [] }, instructions: 'apply formatting' }
  ]));
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  const audit = findSlice(result.blueprint, 'format_and_verify');
  assert.ok(audit, 'format_and_verify slice should survive');
  assert.ok(/SELF-AUDIT \+ REPAIR PROTOCOL/.test(audit.instructions), 'should contain audit protocol header');
  assert.ok(/NEAR-DUPLICATE SHEETS/.test(audit.instructions));
  assert.ok(/EMPTY DECLARED SHEETS/.test(audit.instructions));
  assert.ok(/PHASE 1/.test(audit.instructions) && /PHASE 4/.test(audit.instructions));
  assert.ok(/apply formatting/.test(audit.instructions), 'original instructions preserved');
  console.log('OK final slice instructions injected with audit protocol');

  // 2) Tier promoted to pro
  assert.strictEqual(audit.tier, 'pro', 'audit slice should run on pro tier');
  console.log('OK audit slice promoted to pro tier');

  // 3) Iter budget bumped
  assert.ok(audit.estimated_iters >= 12, `audit iters should be ≥12, got ${audit.estimated_iters}`);
  console.log('OK audit slice iter budget ≥12');

  // 4) Content slices are NOT modified
  const content = findSlice(result.blueprint, 'assumptions');
  assert.strictEqual(content.instructions.includes('SELF-AUDIT'), false);
  console.log('OK content slice instructions unchanged');

  // 5) Audit slice with "audit" in name also recognized
  const altNames = validateBlueprint(blueprint([
    { id: 'data', title: 'Data', deps: [], scope: { sheets_owned: ['Sheet1'], ranges_owned: [], may_read_from: [] }, instructions: 'data' },
    { id: 'final_audit', title: 'Audit Review', deps: ['data'], scope: { sheets_owned: [], ranges_owned: [], may_read_from: [] }, instructions: 'review' }
  ]));
  assert.strictEqual(altNames.ok, true);
  const auditAlt = findSlice(altNames.blueprint, 'final_audit');
  assert.ok(/SELF-AUDIT \+ REPAIR PROTOCOL/.test(auditAlt.instructions));
  console.log('OK "audit" / "review" / "finalize" titled slices also promoted');

  // 6) Done summary fields named explicitly so the orchestrator can surface
  assert.ok(/missing_or_incomplete/.test(audit.instructions));
  assert.ok(/sheets_repaired/.test(audit.instructions));
  assert.ok(/merges_applied/.test(audit.instructions));
  console.log('OK done-summary fields specified');

  console.log('\nLayer A audit+repair slice tests completed.');
}

main();
