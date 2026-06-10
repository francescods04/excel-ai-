'use strict';

// Agentic per-slice loop: write → validate → identify issues → patch → re-validate.
// Inspired by harness-style coding loops: generate, run tests, analyze, fix.
//
// Each slice gets up to N iterations where:
//   1. Generate actions (LLM call)
//   2. Run deterministic validators (cell-dep, structural, density)
//   3. If issues found, re-prompt LLM with EXPLICIT issue list + ask for fixed version
//   4. Stop when validators pass OR iteration cap hit

const { callLLM, resetUsageStats, getUsageStats } = require('../server/tools/llm');
const logger = require('../server/utils/logger');
const { validateCellDeps, indexCells, extractCellRefs } = require('./cellDepValidator');

const { runFinanceLints } = require('./financeLint');

function colToNum(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function numToCol(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Density contract: the plan promises per-row column extents (exported_cells ranges
// like "B4:Y4 = EBITDA", or is_time_series with periods=N). Downstream sheets TRUST
// those extents — if the slice writes fewer columns, downstream formulas land on
// empty cells (dominant mega-scenario bug class). Enforce the contract here so the
// slice loop retries with a precise "extend row X through col Y" instruction.
function checkDensityContract(sliceActions, sliceSection, expectedSheet) {
  const issues = [];
  if (!sliceSection || !expectedSheet) return issues;

  // Index actual written cells: per row → set of col numbers
  const rowCols = {};
  for (const a of sliceActions) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    if (a.sheet && a.sheet !== expectedSheet) continue;
    for (const addr of Object.keys(a.cells)) {
      const m = addr.match(/^([A-Z]+)(\d+)$/); if (!m) continue;
      const row = Number(m[2]);
      if (!rowCols[row]) rowCols[row] = new Set();
      rowCols[row].add(colToNum(m[1]));
    }
  }

  // 1. Exported-cells range contracts (hard promises other sheets rely on)
  const exported = Array.isArray(sliceSection.exported_cells) ? sliceSection.exported_cells : [];
  for (const e of exported) {
    if (typeof e !== 'string') continue;
    const m = e.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)/);
    if (!m || m[2] !== m[4]) continue; // single-row ranges only
    const row = Number(m[2]);
    const startCol = colToNum(m[1]);
    const endCol = colToNum(m[3]);
    if (endCol - startCol < 2) continue;
    const written = rowCols[row];
    if (!written || written.size === 0) continue; // row entirely missing → other checks
    const maxWritten = Math.max(...written);
    if (maxWritten < endCol) {
      issues.push({
        severity: 'critical',
        kind: 'density_contract',
        location: `${expectedSheet}!${m[1]}${row}`,
        detail: `plan exports range ${e.slice(0, 60)} but row ${row} is only written through col ${numToCol(maxWritten)}. Other sheets WILL reference up to col ${m[3]}. Write EVERY column ${m[1]}..${m[3]} on row ${row}.`,
      });
    }
  }

  // 2. Time-series period contract: rows that look like series (>=3 period cells)
  //    must reach the declared period count.
  const periods = Number(sliceSection.periods) || 0;
  if (sliceSection.is_time_series && periods >= 4) {
    const expectedEnd = 1 + periods; // B=2 is period 1 → last period col = 1+periods
    const flagged = issues.length;
    for (const [row, cols] of Object.entries(rowCols)) {
      const periodCols = [...cols].filter(c => c >= 2);
      if (periodCols.length < 3) continue; // single-value/label rows are fine
      const maxWritten = Math.max(...periodCols);
      // Tolerate one missing trailing col (totals layouts vary)
      if (maxWritten < expectedEnd - 1 && !issues.some(i => i.location === `${expectedSheet}!B${row}` || i.location.endsWith(`${row}`))) {
        issues.push({
          severity: 'high',
          kind: 'density_contract',
          location: `${expectedSheet}!B${row}`,
          detail: `series row ${row} stops at col ${numToCol(maxWritten)} but section declares ${periods} periods (through col ${numToCol(expectedEnd)}). Fill the row through col ${numToCol(expectedEnd)}.`,
        });
      }
      if (issues.length - flagged >= 8) break; // cap prompt noise
    }
  }

  return issues;
}

// Quick local validator that runs on JUST this slice's output, given upstream snapshot.
function validateSliceActions(sliceActions, upstreamActions = [], expectedSheet = null, sliceSection = null) {
  const issues = [];

  // 0a. Density contract vs plan promises (exported ranges, declared periods)
  issues.push(...checkDensityContract(sliceActions, sliceSection, expectedSheet));

  // 0. Finance-specific lints (sensitivity grid, IRR array literal, period mismatch, semantic labels)
  const lintIssues = runFinanceLints(sliceActions);
  for (const l of lintIssues) {
    if (!expectedSheet || l.location.startsWith(expectedSheet)) {
      issues.push(l);
    }
  }

  // 1. Cell-level dep validation (cross-slice + same-sheet)
  const combined = [...upstreamActions, ...sliceActions];
  const depIssues = validateCellDeps(combined);
  // Filter to issues whose location is in THIS slice's sheet.
  // Exclude same-sheet broken_cell_ref issues: autofix downstream stubs those
  // and they're noise during slice iteration (LLM can't reliably patch 60 cells).
  for (const d of depIssues) {
    if (!expectedSheet || d.location.startsWith(expectedSheet + '!')) {
      // Skip same-sheet broken refs (autofill / autostub handles them)
      if (d.kind === 'broken_cell_ref') {
        const m = d.detail.match(/refs unwritten ([^!]+)!/);
        const refSheet = m && m[1];
        if (refSheet && refSheet === expectedSheet) continue;
      }
      issues.push({ severity: d.severity, kind: d.kind, location: d.location, detail: d.detail });
    }
  }

  // 2. Density: did the slice generate anything at all?
  const cellCount = sliceActions.reduce((s, a) => {
    if (a.type === 'setCellRange' && a.cells) return s + Object.keys(a.cells).length;
    return s;
  }, 0);
  if (cellCount < 5) {
    issues.push({ severity: 'critical', kind: 'silent_slice', location: expectedSheet || 'slice', detail: `only ${cellCount} cells generated` });
  }

  // 3. Time series check: if section is marked time_series with periods=N,
  //    every metric row should have N period cells.
  // (Optional — skipped here for simplicity; let the auto-fill handle it)

  // 4. Mix sum: if a column appears to be mix %, sum of values should be 1.0±0.05
  for (const a of sliceActions) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    // Find rows where col A is "Mix %" header — meaning the same column on data rows holds %s
    // Heuristic only — too noisy here, skip
  }

  return issues;
}

// Format issues for the LLM patch prompt.
function formatIssuesForLLM(issues) {
  if (issues.length === 0) return '';
  const lines = ['## VALIDATOR ISSUES (must fix in next attempt)'];
  for (const i of issues.slice(0, 20)) {
    lines.push(`- [${i.severity}] ${i.kind} @ ${i.location}: ${i.detail.slice(0, 220)}`);
  }
  return lines.join('\n');
}

// Build upstream label index for AI reviewer
function buildUpstreamLabelsForReview(upstreamActions) {
  const map = {};
  for (const a of upstreamActions || []) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    const sh = a.sheet || a.sheetName;
    if (!map[sh]) map[sh] = [];
    for (const [addr, spec] of Object.entries(a.cells)) {
      const m = addr.match(/^([A-Z]+)(\d+)$/); if (!m) continue;
      if (!spec) continue;
      const s = typeof spec === 'object' ? spec : { value: spec };
      // Only col A labels with their adjacent col B value as context
      if (m[1] === 'A' && typeof s.value === 'string' && s.value.trim()) {
        map[sh].push({ row: Number(m[2]), label: s.value.trim() });
      }
    }
    if (map[sh]) map[sh].sort((a, b) => a.row - b.row);
  }
  // Cap to keep prompt small
  for (const sh of Object.keys(map)) {
    if (map[sh].length > 30) map[sh] = map[sh].slice(0, 30);
  }
  return map;
}

// Run agentic loop on a slice. genSliceFn is the codegen function — takes (objective, opts) returns actions.
// Optional aiReviewerOpts enables a senior-reviewer AI pass after each iteration.
async function runSliceLoop({
  sliceLabel,
  sliceSheet,
  sliceSection,
  objectiveBase,
  context,
  subPlan,
  upstreamActions,
  generateFn,           // async (extraInstructions) => { actions, codeTokens, codeTimeMs, error }
  maxIterations = 2,
  timeoutMs = 90000,
  expectedMinCells = 10,
  aiReviewerEnabled = false,
  aiReviewerModel = null,
  retryOnlyKinds = null,  // if set, iterations past the first only happen for these issue kinds
}) {
  const totals = { promptTokens: 0, completionTokens: 0, calls: 0 };
  let totalMs = 0;
  let bestActions = [];
  let bestScore = -Infinity;   // higher is better
  let bestIssueCount = Infinity;
  let lastIssues = [];
  let aiReviewer = null;
  if (aiReviewerEnabled) {
    try { aiReviewer = require('./aiReviewer'); } catch (e) { logger.warn(`[SliceLoop] AI reviewer not available: ${e.message}`); }
  }
  const upstreamLabels = aiReviewer ? buildUpstreamLabelsForReview(upstreamActions) : null;

  for (let iter = 0; iter < maxIterations; iter++) {
    if (iter > 0 && Array.isArray(retryOnlyKinds)) {
      const worthRetry = lastIssues.some(i => retryOnlyKinds.includes(i.kind));
      if (!worthRetry) {
        logger.info(`[SliceLoop] ${sliceLabel} skipping retry — no ${retryOnlyKinds.join('/')} issues`);
        break;
      }
    }
    let extraInstructions = '';
    if (iter > 0 && lastIssues.length > 0) {
      // Cap to top 5 to avoid overwhelming the generator — too many issues = it gives up
      const topIssues = lastIssues.slice(0, 5);
      extraInstructions = '\n\n' + formatIssuesForLLM(topIssues) + '\n\nGenerate the COMPLETE corrected actions. Fix the top issues listed; keep cells that were already correct.';
    }

    const result = await generateFn(extraInstructions);
    if (result.codeTokens) {
      totals.promptTokens += result.codeTokens.promptTokens || 0;
      totals.completionTokens += result.codeTokens.completionTokens || 0;
      totals.calls += result.codeTokens.calls || 0;
    }
    totalMs += result.codeTimeMs || 0;

    const actions = result.actions || [];
    if (actions.length === 0) {
      logger.warn(`[SliceLoop] ${sliceLabel} iter ${iter + 1}: empty result (${result.error || 'no actions'})`);
      if (iter === maxIterations - 1) break;
      lastIssues = [{ severity: 'critical', kind: 'empty_output', location: sliceSheet, detail: 'no actions produced; regenerate with focus' }];
      continue;
    }
    // Deterministic validator (cell-dep, density, etc.)
    const detIssues = validateSliceActions(actions, upstreamActions, sliceSheet, sliceSection);
    const detCritical = detIssues.filter(i => i.severity === 'critical');
    const detHigh = detIssues.filter(i => i.severity === 'high');

    // AI reviewer — semantic bug finder (only if enabled AND deterministic passed)
    let aiIssues = [];
    if (aiReviewer && detCritical.length === 0 && actions.length > 0) {
      try {
        const review = await aiReviewer.reviewSlice({
          sliceLabel, sliceSheet, sliceSection,
          sliceActions: actions,
          upstreamLabels,
          modelOverride: aiReviewerModel,
          timeoutMs: 45000,
        });
        if (review.tokens) {
          totals.promptTokens += review.tokens.promptTokens || 0;
          totals.completionTokens += review.tokens.completionTokens || 0;
          totals.calls += review.tokens.calls || 0;
        }
        totalMs += review.elapsedMs || 0;
        aiIssues = Array.isArray(review.issues) ? review.issues : [];
        if (aiIssues.length > 0) {
          logger.info(`[SliceLoop] ${sliceLabel} iter ${iter + 1}: AI reviewer found ${aiIssues.length} semantic issues`);
        }
      } catch (e) {
        logger.warn(`[SliceLoop] AI reviewer error: ${e.message}`);
      }
    }

    const aiCritical = aiIssues.filter(i => i.severity === 'critical');
    const aiHigh = aiIssues.filter(i => i.severity === 'high');
    const allCritical = detCritical.length + aiCritical.length;
    const allHigh = detHigh.length + aiHigh.length;
    const totalIssues = allCritical + allHigh;

    // Score this iteration: more cells = better, fewer issues = better
    const cellCount = actions.reduce((s, a) => {
      if (a.type === 'setCellRange' && a.cells) return s + Object.keys(a.cells).length;
      return s;
    }, 0);
    const iterScore = cellCount * 0.5 - allCritical * 30 - allHigh * 5;

    // Keep BEST-OF: only replace bestActions if this iter scored higher
    if (iterScore > bestScore) {
      bestActions = actions;
      bestScore = iterScore;
      bestIssueCount = totalIssues;
    }

    if (allCritical === 0 && allHigh === 0) {
      logger.info(`[SliceLoop] ${sliceLabel} converged after ${iter + 1} iter(s) — ${actions.length} actions, no issues`);
      return { actions: bestActions, iterations: iter + 1, totals, totalMs, finalIssues: detIssues.concat(aiIssues) };
    }

    logger.info(`[SliceLoop] ${sliceLabel} iter ${iter + 1}: ${allCritical} critical (${detCritical.length} det + ${aiCritical.length} ai), ${allHigh} high — retrying (best score so far: ${bestScore.toFixed(1)})`);
    lastIssues = [...detCritical, ...aiCritical, ...detHigh, ...aiHigh]
      // density_contract first: the fix instruction is precise and high-yield
      .sort((a, b) => (b.kind === 'density_contract') - (a.kind === 'density_contract'));
  }

  logger.info(`[SliceLoop] ${sliceLabel} max iter reached — keeping best (score ${bestScore.toFixed(1)}, ${bestIssueCount} issues)`);
  return { actions: bestActions, iterations: maxIterations, totals, totalMs, finalIssues: lastIssues };
}

module.exports = { runSliceLoop, validateSliceActions, formatIssuesForLLM };
