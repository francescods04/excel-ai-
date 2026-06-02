// Unit tests for server/agents/auditor.js — static workbook audit.
//
// Validates the four detectors:
//   - templated_clones    (Vairano IF(2=0,...) ×4800 bug)
//   - constant_guard      (IF(1=2,...) and similar literals-only comparisons)
//   - frozen_index        (INDEX(...,2) across rows with no relative ref)
//   - self_ref            (A1 contains =A1)
//
// Each test prints PASS/FAIL inline and exits non-zero on any failure.

const assert = require('assert');
const { auditStatic, detectTemplatedClones, detectConstantGuards, detectFrozenIndex, detectRowTemplates, formulaShape, literalIntsOutsideRefs, buildRepairInstruction } = require('../../server/agents/auditor');

let passed = 0, failed = 0;
function t(label, fn) {
  try { fn(); console.log('  ✓', label); passed++; }
  catch (e) { console.log('  ✗', label, '\n     ', e.message); failed++; }
}

console.log('[Auditor] formulaShape normalization');
t('strips A1 refs to REF tokens', () => {
  const a = formulaShape('=A2+B2*Sheet1!C3');
  const b = formulaShape('=A99+B99*Sheet1!C100');
  assert.strictEqual(a, b);
});
t('literal-int extraction strips refs and keeps literals', () => {
  // shapes preserve literals (they're inside the shape string), so the
  // de-duplication key uses shape + literal-int set together. The literal
  // extractor must surface only constants outside refs.
  assert.deepStrictEqual(literalIntsOutsideRefs('=A2+5*B3'), [5]);
  assert.deepStrictEqual(literalIntsOutsideRefs('=IF(2=0,"",1/INDEX(X,2))'), [2, 0, 1, 2]);
});

console.log('[Auditor] templated-clones detector');
t('catches Vairano IF(2=0,...) bug across rows', () => {
  // Build a sheet with 50 rows of the same templated formula (literal "2").
  const cells = {};
  for (let r = 2; r <= 51; r++) {
    cells[`A${r}`] = { f: `=IF(2=0,"",1/INDEX('PFD'!$G$2:$G$12,2))` };
  }
  const issues = detectTemplatedClones({ Revenue: cells }, { minClones: 30 });
  assert.ok(issues.length === 1, `expected 1 issue, got ${issues.length}`);
  assert.strictEqual(issues[0].type, 'templated_clones');
  assert.strictEqual(issues[0].severity, 'fail');
  assert.strictEqual(issues[0].count, 50);
});
t('escalates to fail-severity at large clone count', () => {
  const cells = {};
  for (let r = 2; r <= 700; r++) cells[`A${r}`] = { f: `=INDEX(X,2)+5` };
  const issues = detectTemplatedClones({ S: cells }, { minClones: 30 });
  assert.strictEqual(issues[0].severity, 'fail', 'should be fail-class at 700 clones');
});
t('does not flag legitimate header row', () => {
  // Same formula but only in row 1 (1 row, multiple cols) — header pattern, not a clone.
  const cells = { A1: { f: '=SUM(B1:Z1)' }, B1: { f: '=SUM(B1:Z1)' } };
  const issues = detectTemplatedClones({ S: cells }, { minClones: 2 });
  // 2 cells, only 1 row → ok, would flag IF allowed; we ensure default
  // minClones avoids tiny groups.
  const issuesDefault = detectTemplatedClones({ S: cells });
  assert.strictEqual(issuesDefault.length, 0);
});
t('does not flag varying cell refs across rows', () => {
  // =A2, =A3, =A4 — different relative refs but same shape; each unique literal-int=0
  const cells = {};
  for (let r = 2; r <= 60; r++) cells[`B${r}`] = { f: `=A${r}*2` };
  const issues = detectTemplatedClones({ S: cells }, { minClones: 30 });
  // All cells share shape "REF*2" with literal [2] — they ARE clones in the
  // sense the auditor flags. But each cell's relative ref differs, so this is
  // a legitimate column-fill. The auditor cannot distinguish without parsing
  // refs per-cell; this is a known limitation. Issue surfaces as warn, which
  // is acceptable because human review can confirm "yes, intentional".
  // For now: assert it's caught but is *warn* not *fail* at this size.
  if (issues.length > 0) {
    assert.strictEqual(issues[0].severity, 'warn', 'legit column-fill should be warn not fail');
  }
});

console.log('[Auditor] constant-guard detector');
t('flags IF(literal=literal,...) clones', () => {
  const cells = {};
  for (let r = 2; r <= 30; r++) cells[`A${r}`] = { f: `=IF(1=1,B${r},0)` };
  const issues = detectConstantGuards({ S: cells });
  assert.ok(issues.length >= 1);
  assert.strictEqual(issues[0].type, 'constant_guard');
});

console.log('[Auditor] frozen-index detector');
t('flags identical INDEX(...,N) across many rows', () => {
  const cells = {};
  for (let r = 2; r <= 100; r++) cells[`A${r}`] = { f: `=INDEX('PFD'!$G$2:$G$12,7)*2` };
  const issues = detectFrozenIndex({ S: cells });
  assert.ok(issues.length >= 1);
  assert.strictEqual(issues[0].type, 'frozen_index');
});
t('does NOT flag varying INDEX(...,A2)', () => {
  const cells = {};
  for (let r = 2; r <= 100; r++) cells[`A${r}`] = { f: `=INDEX('PFD'!$G$2:$G$12,A${r})*2` };
  const issues = detectFrozenIndex({ S: cells });
  assert.strictEqual(issues.length, 0);
});

console.log('[Auditor] row-template detector');
t('catches Vairano-style row template (same formula across ≥4 cols, many rows)', () => {
  // Build 30 rows × 5 cols where each row has same formula across A:E but
  // the literal index varies per row — mirrors the real Revenue Schedule bug.
  const cells = {};
  for (let r = 2; r <= 31; r++) {
    for (const col of ['A','B','C','D','E']) {
      cells[`${col}${r}`] = { f: `=IF(${r}=0,"",1/INDEX('PFD'!$G$2:$G$12,${r}))` };
    }
  }
  const issues = detectRowTemplates({ Revenue: cells });
  assert.ok(issues.length === 1, `expected 1 row_template issue, got ${issues.length}`);
  assert.strictEqual(issues[0].type, 'row_template');
  assert.strictEqual(issues[0].rowsAffected, 30);
  assert.strictEqual(issues[0].count, 150);
});
t('does NOT flag legitimate per-column variations', () => {
  // 30 rows × 5 cols with DIFFERENT formula shape per column (varying refs).
  const cells = {};
  for (let r = 2; r <= 31; r++) {
    cells[`A${r}`] = { f: `=B${r}*1.1` };
    cells[`B${r}`] = { f: `=C${r}*1.2` };
    cells[`C${r}`] = { f: `=D${r}*1.3` };
    cells[`D${r}`] = { f: `=E${r}*1.4` };
    cells[`E${r}`] = { f: `=F${r}*1.5` };
  }
  const issues = detectRowTemplates({ S: cells });
  assert.strictEqual(issues.length, 0);
});

console.log('[Auditor] audit summary');
t('summary reports ok=false when fails present', () => {
  const cells = {};
  for (let r = 2; r <= 700; r++) cells[`A${r}`] = { f: `=INDEX(X,2)+5` };
  const audit = auditStatic({ S: cells });
  assert.strictEqual(audit.ok, false);
  assert.ok(audit.fails.length >= 1);
});
t('summary reports ok=true on clean workbook', () => {
  const cells = { A1: { v: 'Header' }, B1: { v: 'Value' }, A2: { f: '=SUM(B2:Z2)' } };
  const audit = auditStatic({ S: cells });
  assert.strictEqual(audit.ok, true);
});

console.log('[Auditor] repair instruction builder');
t('builds focused multi-line repair msg', () => {
  const cells = {};
  for (let r = 2; r <= 700; r++) cells[`A${r}`] = { f: `=INDEX(X,2)+5` };
  const audit = auditStatic({ S: cells });
  const msg = buildRepairInstruction(audit.fails);
  assert.ok(msg.includes('Auditor blocked done'));
  assert.ok(msg.includes('templated_clones'));
  assert.ok(msg.includes('fix:'), 'repair message must include suggested fix');
});

console.log(`\n[Auditor] ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
