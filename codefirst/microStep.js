'use strict';

// Codex-inspired micro-step subdivision: very large time-series slices
// (PnL 60-month, RevenueBuild 60-month) are split into 2-3 smaller calls.
// Each step has narrow scope so the LLM doesn't lose track of column ranges
// or skip rows. Steps are reviewed independently.
//
// Pattern:
//   Step 1: SKELETON — header row + Y1 monthly columns only (B:M, ~12 cols)
//   Step 2: EXPANSION — extend Y1 pattern to Y2-Y5 (N:BI for monthly, or BJ:BN for annual roll-up)
//   Step 3 (only if both prior succeeded): aggregate/annual rows
//
// Each step uses the previous as context so the LLM transcribes patterns
// rather than re-inventing them.

const logger = require('../server/utils/logger');
const { countSetCellRangeCells } = (() => {
  try { return require('./enhanced'); } catch { return { countSetCellRangeCells: () => 0 }; }
})();

// Heuristic: should this slice be micro-stepped?
function shouldMicroStep(slice) {
  if (!slice) return false;
  const isLongTimeSeries = slice.section?.is_time_series && (slice.section?.periods || 0) >= 24;
  const isHuge = slice.estCells > 400;
  return isLongTimeSeries || isHuge;
}

// Build the SKELETON sub-objective: only Y1 monthly columns + headers.
function buildSkeletonFocus(slice) {
  const baseLabel = slice.label || slice.sheet;
  const exported = slice.section?.exported_cells || [];
  const exportedNote = exported.length > 0
    ? ` Expose these cells: ${exported.slice(0, 6).join(', ')}.`
    : '';
  return `STEP 1 of 2: SKELETON for "${baseLabel}" in sheet "${slice.sheet}". Generate ONLY:
- The header row (row 1 or 2 — month/year column labels: Jan, Feb, ..., Dec, Annual)
- The label column A (one label per metric row)
- Y1 monthly columns B:M (the FIRST 12 monthly periods only)
- Use formulas with proper Assumptions refs (e.g. =Assumptions!$B$5)
- Use copyToRange C2:M2 to fill across when applicable
NO Y2-Y5 columns yet. NO annual roll-up columns yet. Keep output under 150 cells.${exportedNote}`;
}

// Build the EXPANSION sub-objective: extend Y1 pattern to Y2-Y5.
function buildExpansionFocus(slice, skeletonSummary) {
  const baseLabel = slice.label || slice.sheet;
  return `STEP 2 of 2: EXPANSION for "${baseLabel}" in sheet "${slice.sheet}".

The SKELETON (Y1, columns B:M) was already written:
${skeletonSummary}

Now ONLY ADD:
- Y2-Y5 monthly columns (N:BI for 60-month) — use the SAME formula pattern as B:M shifted by 12*year_index, applying growth where stated
- Y1-Y5 ANNUAL TOTAL columns (e.g. BJ:BN) — SUM the monthly columns per year
- Subtotal/aggregate rows (totals at the bottom) if part of the section

Do NOT regenerate cells B:M (already written). Do NOT touch the header. Keep formulas consistent with the skeleton — same Assumptions refs, same metric definitions.`;
}

// Run micro-step for a huge slice.
async function runMicroStep({
  slice,
  baseObjective,
  context,
  subPlan,
  modelOverride,
  generateWithPlanFn,
  baseTimeout = 90000,
}) {
  const totals = { promptTokens: 0, completionTokens: 0, calls: 0 };
  let totalMs = 0;

  // Step 1: skeleton
  const skeletonFocus = buildSkeletonFocus(slice);
  logger.info(`[MicroStep] ${slice.label} step 1/2: skeleton`);
  const step1 = await generateWithPlanFn(baseObjective, context, subPlan, {
    modelOverride,
    sliceFocus: skeletonFocus,
    timeoutMs: baseTimeout,
    label: `cf_slice_${slice.id}_micro1`,
  });
  if (step1.codeTokens) {
    totals.promptTokens += step1.codeTokens.promptTokens || 0;
    totals.completionTokens += step1.codeTokens.completionTokens || 0;
    totals.calls += step1.codeTokens.calls || 0;
  }
  totalMs += step1.codeTimeMs || 0;
  const skeletonActions = step1.actions || [];
  if (skeletonActions.length === 0) {
    logger.warn(`[MicroStep] ${slice.label} skeleton failed; falling back to single-shot`);
    return { actions: [], totals, totalMs, error: step1.error || 'skeleton empty' };
  }

  // Build a compact skeleton summary for the expansion prompt
  const skeletonSummary = summarizeSkeletonForPrompt(skeletonActions, slice.sheet);

  // Step 2: expansion
  const expansionFocus = buildExpansionFocus(slice, skeletonSummary);
  logger.info(`[MicroStep] ${slice.label} step 2/2: expansion`);
  const step2 = await generateWithPlanFn(baseObjective, context, subPlan, {
    modelOverride,
    sliceFocus: expansionFocus,
    timeoutMs: baseTimeout,
    label: `cf_slice_${slice.id}_micro2`,
  });
  if (step2.codeTokens) {
    totals.promptTokens += step2.codeTokens.promptTokens || 0;
    totals.completionTokens += step2.codeTokens.completionTokens || 0;
    totals.calls += step2.codeTokens.calls || 0;
  }
  totalMs += step2.codeTimeMs || 0;

  const mergedActions = [...skeletonActions, ...(step2.actions || [])];
  logger.info(`[MicroStep] ${slice.label} done: ${skeletonActions.length}+${(step2.actions || []).length}=${mergedActions.length} actions in ${totalMs}ms`);
  return { actions: mergedActions, totals, totalMs };
}

// Summarize the skeleton's cells for the expansion prompt. Keep it tight.
function summarizeSkeletonForPrompt(skeletonActions, expectedSheet) {
  const lines = [];
  for (const a of skeletonActions) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    if (expectedSheet && (a.sheet || a.sheetName) !== expectedSheet) continue;
    for (const [addr, spec] of Object.entries(a.cells)) {
      if (!spec) continue;
      const s = typeof spec === 'object' ? spec : { value: spec };
      const v = s.formula ? `f: ${s.formula}` : (s.value !== undefined ? `v: ${JSON.stringify(s.value)}` : '');
      lines.push(`${addr}: ${v}`);
    }
  }
  // Cap to keep prompt small
  return lines.slice(0, 80).join('\n');
}

module.exports = { runMicroStep, shouldMicroStep };
