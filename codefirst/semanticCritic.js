'use strict';

// Semantic critic: post-codegen pass that audits financial coherence.
// Catches bugs the structural validator misses:
//   - Mix % not summing to 100%
//   - Cross-sheet inconsistency (e.g. Assumptions AOV ≠ Menu blended AOV used by Revenue)
//   - Wrong formula structure (Daily Customers = traffic*conv*30, not traffic/months)
//   - Hardcoded numbers where formulas expected
//
// Uses a cheap LLM (flash) for speed. Returns patch actions to apply.

const { callLLM, resetUsageStats, getUsageStats } = require('../server/tools/llm');
const logger = require('../server/utils/logger');
const { indexCells } = require('./cellDepValidator');

const SYSTEM_PROMPT = `You are a finance model auditor. Given a workbook (list of cells per sheet), find SEMANTIC errors.

CHECKS:
1. Mix percentages must sum to EXACTLY 100% (1.0). If higher, normalize the sum row.
2. Blended AOV = SUMPRODUCT(prices, mix) / SUM(mix). If hardcoded, rewrite as formula.
3. Revenue = traffic × conversion × days × AOV. NEVER divided by months or years.
4. AOV stays CONSTANT across months unless explicit growth assumption. If AOV grows month-over-month (B<C<D...), wrong.
5. COGS = revenue × COGS%; Gross Profit = Revenue - COGS; EBITDA = GP - OpEx.
6. Cross-sheet refs to "AOV": Assumptions AOV value must equal Menu blended AOV. If different, one is wrong.
7. Sources = Uses balance. Sources_Uses sheet MUST have a "Check" cell = SUM(sources)-SUM(uses), expected 0.
8. M&A merger: if "Refinance Debt" appears in Sources_Uses, then ProForma Combined Interest MUST exclude TargetStandalone interest (set Target interest to 0 post-close).
9. M&A: ProForma EBITDA should include NET synergies (Synergies!Net_Synergy row), not just Cost Synergies.
10. IRR/NPV: source range must be the NET cash flow (FCF/FCFE) row, NOT a revenue-only row. If IRR points at a "Revenue" or "Ricavi" row, fix it to point at FCF row.
11. =TABLE(...) is INVALID. Replace with closed-form formula referencing both axes.
12. Hardcoded values where formulas expected (e.g. cell labeled "EBITDA" with value: 50000 instead of formula).

Return JSON:
{
  "issues": [
    {"location": "Sheet!A1", "kind": "mix_sum_wrong", "detail": "Mix sums to 1.55", "fix": {"sheet":"Menu", "addr":"F30", "formula":"=SUM(F3:F29)"}},
    {"location": "ProForma!B7", "kind": "double_count_interest", "detail": "post-refinance Target interest still added", "fix": {"sheet":"ProForma","addr":"B7","formula":"=AcquirerStandalone!$B$7+DebtSchedule!$B$7"}}
  ]
}

Each fix has {sheet, addr, formula} or {sheet, addr, value}. Use ONLY if highly confident. If unsure, skip.
Output up to 30 issues. Prioritize deal-breakers.`;

function buildAuditPayload(actions) {
  const idx = indexCells(actions);
  const bySheet = {};
  for (const [_k, cell] of idx) {
    if (!bySheet[cell.sheet]) bySheet[cell.sheet] = [];
    bySheet[cell.sheet].push({
      addr: cell.addr,
      ...(cell.formula ? { f: cell.formula } : { v: cell.value }),
    });
  }
  // Truncate per sheet to keep payload small
  for (const sheet of Object.keys(bySheet)) {
    if (bySheet[sheet].length > 80) bySheet[sheet] = bySheet[sheet].slice(0, 80);
  }
  return bySheet;
}

async function semanticAudit(actions, { modelOverride = null, timeoutMs = 60000 } = {}) {
  const start = Date.now();
  const payload = buildAuditPayload(actions);
  const sheetCount = Object.keys(payload).length;
  const cellCount = Object.values(payload).reduce((s, arr) => s + arr.length, 0);
  logger.info(`[SemanticCritic] Auditing ${sheetCount} sheets, ${cellCount} cells`);

  resetUsageStats();
  try {
    const result = await callLLM({
      system: SYSTEM_PROMPT,
      userText: '## Workbook\n```json\n' + JSON.stringify(payload, null, 2).slice(0, 24000) + '\n```\n\nReturn JSON with issues array.',
      timeoutMs,
      modelOverride,
      role: null,
      thinkingDisabled: true,
      jsonMode: true,
      label: 'semantic_critic',
    });
    const usage = getUsageStats();
    const issues = Array.isArray(result?.issues) ? result.issues : [];
    logger.info(`[SemanticCritic] Done (${Date.now() - start}ms): ${issues.length} issues`);
    return { issues, tokens: usage, elapsedMs: Date.now() - start };
  } catch (e) {
    logger.warn(`[SemanticCritic] Failed (non-blocking): ${e.message}`);
    return { issues: [], tokens: { promptTokens: 0, completionTokens: 0, calls: 0 }, elapsedMs: Date.now() - start, error: e.message };
  }
}

// Apply critic fixes to actions array (mutates). Returns count applied.
function applyCriticFixes(actions, issues) {
  if (!Array.isArray(issues) || issues.length === 0) return 0;
  let applied = 0;
  // Build sheet-addr lookup
  const cellRefs = new Map();
  for (const a of actions) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    for (const addr of Object.keys(a.cells)) {
      cellRefs.set(`${a.sheet}!${addr}`, { action: a, addr });
    }
  }
  for (const issue of issues) {
    const fix = issue.fix;
    if (!fix || !fix.sheet || !fix.addr) continue;
    const key = `${fix.sheet}!${fix.addr}`;
    const ref = cellRefs.get(key);
    if (ref) {
      // Patch existing
      const spec = ref.action.cells[ref.addr];
      if (spec && typeof spec === 'object') {
        if (fix.formula) { spec.formula = fix.formula; delete spec.value; }
        else if (fix.value !== undefined) { spec.value = fix.value; delete spec.formula; }
      }
    } else {
      // Add new setCellRange
      const cells = {};
      if (fix.formula) cells[fix.addr] = { formula: fix.formula };
      else if (fix.value !== undefined) cells[fix.addr] = { value: fix.value };
      else continue;
      actions.push({ type: 'setCellRange', sheet: fix.sheet, cells });
    }
    applied++;
  }
  return applied;
}

module.exports = { semanticAudit, applyCriticFixes };
