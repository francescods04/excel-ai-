'use strict';

// Execution-grounded value loop — the GENERAL quality mechanism.
//
// Instead of domain-specific lints, this loop:
//   1. COMPUTES the whole workbook locally (WorkbookEvaluator — pure math)
//   2. Shows the computed VALUES (not formulas) to a strong critic model,
//      which flags absurd or inconsistent numbers the way a human reviewer
//      would (garbage IRR, zero interest with debt outstanding, totals that
//      don't match parts) — no per-scenario rules
//   3. Re-checks the plan's own declared invariants numerically
//   4. Dispatches surgical targeted fixes per bug, then re-evaluates
//
// Generalizes to any model type: the planner declares what must hold for THIS
// task; the evaluator computes; the critic judges plausibility.

const { callLLM, resetUsageStats, getUsageStats } = require('../server/tools/llm');
const logger = require('../server/utils/logger');
const { WorkbookEvaluator } = require('./formulaEval');
const { checkInvariants } = require('./invariantChecker');
const { dispatchTargetedFixes } = require('./targetedFixer');
const { MODEL_TIERS } = require('./modelRouter');

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

function fmtVal(v) {
  if (v === null || v === undefined || v === '') return '·';
  if (v === '#ERR' || v === '#NOEVAL') return String(v);
  const n = Number(v);
  if (isNaN(n)) return String(v).slice(0, 18);
  if (!isFinite(n)) return '#INF';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  if (abs >= 100) return n.toFixed(0);
  if (abs >= 1) return n.toFixed(2);
  if (abs > 0) return n.toFixed(4);
  return '0';
}

// Compute the workbook and render a compact per-sheet snapshot of labeled rows:
//   PnL!7 "EBITDA": B=40.9M C=43.2M … Y=61.5M
// Caps keep the prompt bounded on 22-sheet workbooks.
function buildComputedSnapshot(actions, { maxRowsPerSheet = 30, maxColsPerRow = 12 } = {}) {
  const ev = new WorkbookEvaluator(actions);

  // Index: sheet → row → { label, cols: Set<colNum> } for rows with a col-A label
  const sheets = {};
  for (const a of actions) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    const sh = a.sheet || a.sheetName || 'Sheet1';
    if (!sheets[sh]) sheets[sh] = {};
    for (const [addr, spec] of Object.entries(a.cells)) {
      const m = addr.match(/^([A-Z]+)(\d+)$/); if (!m) continue;
      const row = Number(m[2]);
      if (!sheets[sh][row]) sheets[sh][row] = { label: null, cols: new Set() };
      const s = spec && typeof spec === 'object' ? spec : { value: spec };
      if (m[1] === 'A') {
        if (typeof s.value === 'string' && s.value.trim()) sheets[sh][row].label = s.value.trim();
      } else {
        sheets[sh][row].cols.add(colToNum(m[1]));
      }
    }
  }

  const lines = [];
  for (const [sh, rows] of Object.entries(sheets)) {
    const labeled = Object.entries(rows)
      .filter(([, r]) => r.label && r.cols.size > 0)
      .sort(([a], [b]) => Number(a) - Number(b))
      .slice(0, maxRowsPerSheet);
    if (labeled.length === 0) continue;
    lines.push(`=== ${sh} ===`);
    for (const [row, r] of labeled) {
      let cols = [...r.cols].sort((a, b) => a - b);
      if (cols.length > maxColsPerRow) {
        const head = cols.slice(0, Math.ceil(maxColsPerRow / 2));
        const tail = cols.slice(-Math.floor(maxColsPerRow / 2));
        cols = [...head, null, ...tail]; // null = ellipsis marker
      }
      const vals = cols.map(c => {
        if (c === null) return '…';
        const col = numToCol(c);
        return `${col}=${fmtVal(ev.getCell(`${sh}!${col}${row}`))}`;
      });
      lines.push(`${sh}!${row} "${r.label.slice(0, 40)}": ${vals.join(' ')}`);
    }
  }
  return lines.join('\n');
}

const CRITIC_SYSTEM = `You are a senior financial-model reviewer. You are shown the COMPUTED VALUES of every labeled row of a spreadsheet model (not the formulas). Judge the NUMBERS the way a partner reviewing a deliverable would:

- absurd magnitudes (an IRR of -17980671106276, revenue jumping 1000x between periods)
- impossible signs (negative revenue, positive interest EXPENSE reducing debt)
- zeros where the model clearly requires values (interest = 0 while debt > 0; an entire computed row stuck at 0)
- internal inconsistency (totals that visibly do not match their parts; EBITDA larger than revenue; balance-check rows that are not ~0)
- broken series (a quarterly row where one period is wildly off-pattern)
- #ERR / #NOEVAL markers in computed cells

Do NOT comment on style or formatting. Do NOT guess about business assumptions (a 32% margin is not a bug). Only flag values that are mathematically or financially incoherent ON THEIR FACE.

For each problem, identify the SINGLE cell most likely holding the broken formula (the cell whose value is wrong, e.g. "Returns!B12"), and explain the bug in one sentence including the observed value.

Return ONLY JSON:
{"issues":[{"severity":"critical|high","location":"Sheet!B12","detail":"IRR computes to -1.8e13 — the cashflow range likely mixes scales or references empty cells"}]}
Return {"issues":[]} if the numbers look coherent. Max 12 issues, most severe first.`;

async function valueCritic({ snapshot, objective, modelOverride = null, timeoutMs = 90000 }) {
  const MAX_SNAPSHOT_CHARS = 60000;
  const userText = [
    '## What the model was asked to build',
    String(objective || '').slice(0, 1500),
    '',
    '## COMPUTED VALUES (whole workbook, labeled rows)',
    snapshot.length > MAX_SNAPSHOT_CHARS ? snapshot.slice(0, MAX_SNAPSHOT_CHARS) + '\n…(truncated)' : snapshot,
    '',
    'Review the numbers. Return JSON only.',
  ].join('\n');

  resetUsageStats();
  const start = Date.now();
  let result = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      result = await callLLM({
        system: CRITIC_SYSTEM,
        userText,
        timeoutMs,
        modelOverride: modelOverride || MODEL_TIERS.pro,
        role: null,
        thinkingDisabled: true,
        jsonMode: true,
        label: attempt === 0 ? 'cf_value_critic' : 'cf_value_critic_retry',
      });
      break;
    } catch (e) {
      lastErr = e;
      logger.warn(`[ValueLoop] Critic attempt ${attempt + 1} failed: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  if (!result) throw lastErr || new Error('value critic failed');
  const tokens = getUsageStats();
  const issues = (result && Array.isArray(result.issues)) ? result.issues : [];
  const valid = issues.filter(i => i && typeof i.location === 'string' && /^[^!]+![A-Z]+\d+$/.test(i.location) && i.detail);
  logger.info(`[ValueLoop] Critic: ${valid.length} issues (${Date.now() - start}ms)`);
  return { issues: valid, tokens, elapsedMs: Date.now() - start };
}

// Map invariant violations to targeted-fixer bugs (only those with a concrete cell).
function invariantBugs(actions, invariants) {
  if (!Array.isArray(invariants) || invariants.length === 0) return [];
  const issues = checkInvariants(actions, invariants);
  return issues
    .filter(i => typeof i.location === 'string' && i.location.includes('!'))
    .map(i => ({ severity: 'critical', location: i.location, detail: i.detail }));
}

async function runValueLoop({ actions, objective, plan, modelOverride = null, maxPasses = 2, onProgress = null }) {
  const totals = { promptTokens: 0, completionTokens: 0, calls: 0 };
  const stats = { passes: 0, bugsFound: 0, patchesApplied: 0 };
  const criticModel = process.env.CF_VALUE_CRITIC_MODEL || modelOverride || MODEL_TIERS.pro;

  for (let pass = 0; pass < maxPasses; pass++) {
    stats.passes = pass + 1;
    if (onProgress) onProgress('reviewing', { message: `Numeric review pass ${pass + 1}/${maxPasses}...` });

    const snapshot = buildComputedSnapshot(actions);
    if (!snapshot) { logger.info('[ValueLoop] Empty snapshot — skipping'); break; }

    let criticIssues = [];
    try {
      const res = await valueCritic({ snapshot, objective, modelOverride: criticModel });
      criticIssues = res.issues;
      totals.promptTokens += res.tokens?.promptTokens || 0;
      totals.completionTokens += res.tokens?.completionTokens || 0;
      totals.calls += res.tokens?.calls || 0;
    } catch (e) {
      logger.warn(`[ValueLoop] Critic failed: ${e.message}`);
      break;
    }

    const invBugs = invariantBugs(actions, plan?.invariants);
    // Dedup by location, invariants first (they are the planner's own contract)
    const seen = new Set();
    const bugs = [];
    for (const b of [...invBugs, ...criticIssues]) {
      if (seen.has(b.location)) continue;
      seen.add(b.location);
      bugs.push(b);
      if (bugs.length >= 12) break;
    }

    if (bugs.length === 0) {
      logger.info(`[ValueLoop] Pass ${pass + 1}: numbers coherent — done`);
      break;
    }
    stats.bugsFound += bugs.length;
    logger.info(`[ValueLoop] Pass ${pass + 1}: ${bugs.length} bugs (${invBugs.length} invariant, ${criticIssues.length} critic) — dispatching targeted fixes`);

    try {
      const fixResult = await dispatchTargetedFixes({ bugs, actions, modelOverride });
      stats.patchesApplied += fixResult.applied || 0;
      if (fixResult.tokens) {
        totals.promptTokens += fixResult.tokens.promptTokens || 0;
        totals.completionTokens += fixResult.tokens.completionTokens || 0;
        totals.calls += fixResult.tokens.calls || 0;
      }
      if (!fixResult.applied) {
        logger.info('[ValueLoop] No patches applied — stopping');
        break;
      }
    } catch (e) {
      logger.warn(`[ValueLoop] Targeted fixes failed: ${e.message}`);
      break;
    }
  }

  return { ...stats, tokens: totals };
}

module.exports = { runValueLoop, buildComputedSnapshot, valueCritic };
