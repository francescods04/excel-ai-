'use strict';

// AI Reviewer: pro-tier LLM that reads slice output and flags SEMANTIC bugs that
// deterministic validators can't catch. Does NOT patch — just identifies issues.
// Generator then re-runs with explicit feedback list.
//
// Pattern (codex/opencode-inspired):
//   1. junior dev (flash) writes code
//   2. senior reviewer (pro) reads it, points out bugs
//   3. junior re-writes based on review
//   4. repeat until reviewer says OK or max iter
//
// The reviewer is given DOMAIN CONTEXT (the original task + the planner's intent)
// so it can spot logic bugs like "Revenue should be Customers × AOV not B2*B3*B4*B5".

const { callLLM, resetUsageStats, getUsageStats } = require('../server/tools/llm');
const logger = require('../server/utils/logger');

const SYSTEM_PROMPT = `You are a senior finance modeling reviewer. A junior wrote cells for one section. Your job: find SEMANTIC bugs that compile-time validators can't catch.

CRITICAL CHECKS for finance models:

REVENUE / SALES FORMULAS:
- Revenue = Daily Customers × Operating Days × AOV (× Seasonality × Ramp). It is NOT "= B2*B3*B4*B5*B6" multiplying random cells. Each reference must point at a clear concept: traffic, AOV, days, factor.
- AOV should be a SINGLE cell reference (=Assumptions!$B$N), not a derived multiplication.
- Daily Customers = Traffic × Conversion% (not divided by anything).

P&L STRUCTURE:
- COGS = Revenue × COGS%. Check the formula isn't =Revenue × Marketing% or similar misalignment.
- Gross Profit = Revenue - COGS.
- EBITDA = Gross Profit - OpEx.
- Tax = EBT × Tax_Rate (positive value). Net Income = EBT - Tax.

CROSS-SHEET REFS:
- Each formula referencing Assumptions/Inputs must point at the row whose LABEL matches the concept. If formula in "Capex" row references Assumptions!$B$10 but Assumptions!A10 says "Exit Multiple", FLAG IT.
- If you see =Assumptions!$B$5 in a row labeled "Labor Cost", check Assumptions!A5 actually says "Labor" not "Daily Traffic".

VALUATION:
- IRR(range): range must be Cash Flow row (not Revenue), and range should be SEQUENTIAL (B5:F5 not B9:F3 backward).
- NPV(rate, range): rate must be WACC/Discount Rate, NOT Operating Days or other random cell.
- Terminal Value = FCF × (1+g)/(WACC - g) — check WACC and g are actual rate references, not labels or units.

SENSITIVITY TABLES:
- Each interior cell of N×N grid must use BOTH axes (mixed refs: row header $A4 + col header B$3). If formula = scalar with no axis refs, it's broken.
- NEVER =TABLE(...) function — invalid.

ARITHMETIC SANITY:
- =-0, =/0, ridiculous expressions like "=B1+B2+B3+B4+B5+B6+B7" where labels suggest only some should sum.

TIME SERIES:
- Each metric row in monthly time series (B:M) should use formula in EVERY column (not 0 hardcoded for some months).
- Y2-Y5 cells must compound growth (=prev_year*(1+growth)) — not same as Y1 absolute reference.

Return JSON:
{
  "issues": [
    {"severity": "critical", "kind": "wrong_formula_structure", "location": "Revenue!B10", "detail": "Formula =B2*B3*B4*B5*B6 is multiplying 5 random cells. Revenue should be: =Daily_Customers*Days*AOV. Specifically: =B5*B6*Assumptions!$B$7 where B5=customers, B6=days, AOV=Assumptions!$B$7."},
    {"severity": "critical", "kind": "wrong_ref_row", "location": "Valuation!B5", "detail": "Discount rate references Assumptions!$B$12 but that row is Operating Days. WACC is at Assumptions!$B$9. Use =Assumptions!$B$9 instead."},
    {"severity": "high", "kind": "ts_columns_zero", "location": "PnL!M3:BB3", "detail": "Monthly revenue cells C3:BB3 are hardcoded 0 instead of formulas. Each should be =SUM of correct revenue cells or formula referencing RevenueBuild."}
  ]
}

Be SPECIFIC: quote the exact wrong formula, name the right cell address (with concept label), give the corrective formula. Up to 15 issues. If clean, return {"issues":[]}.`;

// Build the user prompt: section plan + actual cells + upstream label index
function buildReviewPrompt({ sliceLabel, sliceSheet, sliceSection, sliceActions, upstreamLabels }) {
  const sectionDescription = JSON.stringify({
    sheet: sliceSection?.sheet,
    title: sliceSection?.title,
    description: sliceSection?.description,
    key_formulas: sliceSection?.key_formulas,
    exported_cells: sliceSection?.exported_cells,
    is_time_series: sliceSection?.is_time_series,
    periods: sliceSection?.periods,
  }, null, 2);

  // Compact slice cells: per-sheet, addr -> formula/value
  const cellsCompact = {};
  for (const a of sliceActions || []) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    const sh = a.sheet || a.sheetName;
    if (!cellsCompact[sh]) cellsCompact[sh] = [];
    for (const [addr, spec] of Object.entries(a.cells)) {
      if (!spec) continue;
      const s = typeof spec === 'object' ? spec : { value: spec };
      const entry = s.formula ? { addr, f: s.formula } : (s.value !== undefined ? { addr, v: s.value } : null);
      if (entry) cellsCompact[sh].push(entry);
    }
  }
  for (const sh of Object.keys(cellsCompact)) {
    if (cellsCompact[sh].length > 120) cellsCompact[sh] = cellsCompact[sh].slice(0, 120);
  }

  return [
    `## Task: Review the junior's cells for "${sliceLabel}" (sheet: ${sliceSheet})`,
    '',
    '### Section spec from the planner:',
    '```json',
    sectionDescription,
    '```',
    '',
    '### Upstream sheets — label index (so you can verify cross-sheet refs):',
    '```json',
    JSON.stringify(upstreamLabels || {}, null, 2).slice(0, 4000),
    '```',
    '',
    '### Junior\'s output (cells written for this section):',
    '```json',
    JSON.stringify(cellsCompact, null, 2).slice(0, 12000),
    '```',
    '',
    'Audit. Return JSON issues array with specific actionable feedback.',
  ].join('\n');
}

async function reviewSlice({ sliceLabel, sliceSheet, sliceSection, sliceActions, upstreamLabels, modelOverride = null, timeoutMs = 45000 }) {
  const start = Date.now();
  // Skip review if slice has too few cells (no meaningful work to review)
  const totalCells = (sliceActions || []).reduce((s, a) => {
    if (a.type === 'setCellRange' && a.cells) return s + Object.keys(a.cells).length;
    return s;
  }, 0);
  if (totalCells < 5) {
    return { issues: [], elapsedMs: Date.now() - start, skipped: true };
  }

  const userText = buildReviewPrompt({ sliceLabel, sliceSheet, sliceSection, sliceActions, upstreamLabels });

  resetUsageStats();
  try {
    const result = await callLLM({
      system: SYSTEM_PROMPT,
      userText,
      timeoutMs,
      modelOverride,
      role: null,
      thinkingDisabled: true,
      jsonMode: true,
      label: `ai_reviewer_${sliceSheet}`,
    });
    const usage = getUsageStats();
    const issues = Array.isArray(result?.issues) ? result.issues : [];
    return { issues, tokens: usage, elapsedMs: Date.now() - start };
  } catch (e) {
    logger.warn(`[AIReviewer] ${sliceSheet} failed: ${e.message}`);
    return { issues: [], elapsedMs: Date.now() - start, error: e.message };
  }
}

// Format issues for feeding back to the generator
function formatIssuesAsFeedback(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return '';
  const lines = ['## SENIOR REVIEWER FEEDBACK (must address in next attempt)'];
  for (const i of issues.slice(0, 15)) {
    lines.push(`- [${i.severity}] ${i.kind} @ ${i.location}: ${i.detail}`);
  }
  return lines.join('\n');
}

module.exports = { reviewSlice, formatIssuesAsFeedback, buildReviewPrompt };
