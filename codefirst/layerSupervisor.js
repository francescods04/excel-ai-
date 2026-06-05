'use strict';

// Inline runtime supervisor. After each topological layer completes, this critic
// reviews the layer's output IN CONTEXT of what came before, and patches issues
// BEFORE the next layer runs. This means downstream slices reference already-
// correct cells, not garbage.
//
// Key idea: a senior analyst reviewing junior's work — catches the conceptual
// bugs (wrong revenue formula, mix not summing, capex pointing at exit multiple)
// at source, while the per-cell sanitizers only see syntactic problems.

const { callLLM, resetUsageStats, getUsageStats } = require('../server/tools/llm');
const logger = require('../server/utils/logger');
const { indexCells } = require('./cellDepValidator');

// Per-layer prompts — each layer has a different role and different checks.
const LAYER_PROMPTS = {
  input: `You audit Assumptions/Menu input sheets for a finance model.

CHECKS for each input sheet:
- Mix % column (if present) MUST sum to 1.0 exactly. If sum > 1.05 or < 0.95, generate divide-by-sum patches.
- Each value cell should be a NUMBER, not a formula (assumptions are inputs).
- Label row must be in col A, value in col B, units in col C.
- For menu sheets: prices realistic, COGS% between 15-40%, Mix% per item between 0.5% and 15%.
- For Assumptions: each row has clear concept (Daily Traffic, AOV, COGS%, etc.) in col A, numeric value in col B.

For each issue found, return a patch: {sheet, addr, formula} or {sheet, addr, value}.

If you see Mix % not summing to 1.0, normalize: patch EACH cell to (current_value / current_sum).

Return {"issues": [{"location":"Sheet!Addr", "kind":"...", "detail":"...", "fix": {...}}]}. Up to 25 issues.`,

  intermediate: `You audit Revenue/Cost build sheets for a finance model.

CRITICAL CHECKS:
- Revenue formula: Daily Customers × Days × AOV × Seasonality × Ramp. NO division by months.
- Daily Customers = Traffic × Conversion% (NOT Traffic / months).
- AOV in revenue must reference the SAME cell as Assumptions AOV — not a derived/inconsistent value.
- Monthly Revenue per month must be a FORMULA not a hardcoded number.
- For a 12-month time series, ALL 12 columns (B:M) must have formulas, not just column B.
- COGS% must reference Assumptions row labeled COGS%, not a different row.
- Staffing/Labor: Total Labor = Wages + Loaded%. Don't divide by single-month revenue.

For each issue, generate {fix: {sheet, addr, formula}}. Use cross-sheet refs like =Assumptions!$B$5.

Return {"issues":[...]} up to 25 issues.`,

  consolidation: `You audit P&L / Combined Income Statement sheets.

CRITICAL CHECKS:
- Revenue row should sum monthly RevenueBuild revenue row, NOT operating days, NOT mix %.
- COGS = Revenue × COGS% — if you see =Revenue×Marketing% that's wrong.
- Gross Profit = Revenue - COGS.
- EBITDA = Gross Profit - OpEx (Labor + Marketing + Utilities + ...).
- Tax = EBT × Tax_Rate.
- Net Income = EBT - Tax.
- For monthly P&L spanning 12+ columns: every column must have formulas, not zeros.
- For Y2-Y5 annual columns: must use COMPOUND growth (=prev_year*(1+growth)) not the same Year-1 value.

For M&A ProForma: if "Refinance Debt" exists in Sources_Uses, Combined Interest MUST exclude Target standalone interest (set Target interest to 0 in formula). Revenue synergies MUST flow into Combined EBITDA (add Net Synergy row).

Return {"issues":[...]} up to 25 issues.`,

  derivative: `You audit Cash Flow and Balance Sheet derivative sheets.

CHECKS:
- Operating CF = NI + D&A - ΔWC. Each month's CF should be a formula.
- Capex must reference Assumptions row labeled "Capex"/"Initial Capex", NOT "Exit Multiple" or "Days".
- Cumulative Cash Flow = previous month + current month.
- For 12+ month time series, all columns formulated.
- Balance Sheet: Cash plug, Total Assets = Total Liabilities + Equity (verify check formula).

Return {"issues":[...]} up to 25 issues.`,

  terminal: `You audit Returns / Valuation / Investor sheets.

CRITICAL CHECKS:
- IRR formula source range MUST be the FCF row (look for "Free Cash Flow" or "Net Cash Flow" label in the source sheet), NOT a Revenue-only row.
- NPV discount rate MUST reference Assumptions WACC/Discount Rate row, NOT "Operating Days" or random row.
- Terminal Value = FCF_final × (1+g) / (WACC - g).
- MOIC = Total Cash Returned / Initial Investment.
- For M&A Accretion/Dilution: Pro Forma EPS = Combined NI / (acquirer_shares + new_shares).

Return {"issues":[...]} up to 25 issues.`,

  whatif: `You audit Sensitivity and ScaleUp/Scenarios sheets.

CHECKS:
- Sensitivity tables: NEVER use =TABLE(). Each interior cell of the grid must be a CLOSED-FORM formula referencing the row/col headers via mixed refs (e.g. =B$3 * $A4 * Assumptions!$B$10).
- For 5×5 grid B4:F8, the formula in B4 should use B$3 (col header) and $A4 (row header).
- ScaleUp: should reference annual P&L rows (Revenue Y1-Y5), NOT random rows like labor or operating days.

Return {"issues":[...]} up to 25 issues.`,
};

function pickLayerPrompt(layerIdx, totalLayers) {
  if (layerIdx === 0) return LAYER_PROMPTS.input;
  if (layerIdx === 1) return LAYER_PROMPTS.intermediate;
  if (layerIdx === 2) return LAYER_PROMPTS.consolidation;
  if (layerIdx === 3) return LAYER_PROMPTS.derivative;
  if (layerIdx === totalLayers - 1) return LAYER_PROMPTS.whatif;
  if (layerIdx === totalLayers - 2) return LAYER_PROMPTS.terminal;
  return LAYER_PROMPTS.derivative;
}

// Build a compact payload for the supervisor: only the layer's sheets, with cell
// labels and formulas. Plus a summary of upstream layers (just label index of input sheets).
function buildPayload(layerSheets, allActions, upstreamLabels) {
  const layerSet = new Set(layerSheets);
  const layerData = {};
  for (const a of allActions) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    const sh = a.sheet || a.sheetName;
    if (!layerSet.has(sh)) continue;
    if (!layerData[sh]) layerData[sh] = [];
    for (const [addr, spec] of Object.entries(a.cells)) {
      if (!spec) continue;
      const s = typeof spec === 'object' ? spec : { value: spec };
      layerData[sh].push({ addr, ...(s.formula ? { f: s.formula } : { v: s.value }) });
    }
  }
  // Cap to keep payload small
  for (const sh of Object.keys(layerData)) {
    if (layerData[sh].length > 100) layerData[sh] = layerData[sh].slice(0, 100);
  }
  return { layer: layerData, upstream: upstreamLabels };
}

// Extract upstream label index: for each input/upstream sheet, list "addr: label"
// so the supervisor can verify cross-sheet refs point at the right concept.
function buildUpstreamLabels(actions, upstreamSheets) {
  const map = {};
  const set = new Set(upstreamSheets);
  for (const a of actions) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    const sh = a.sheet || a.sheetName;
    if (!set.has(sh)) continue;
    if (!map[sh]) map[sh] = [];
    for (const [addr, spec] of Object.entries(a.cells)) {
      if (!spec) continue;
      const s = typeof spec === 'object' ? spec : { value: spec };
      const m = addr.match(/^([A-Z]+)(\d+)$/); if (!m) continue;
      // Only col A labels and col B values (typical layout)
      if (m[1] === 'A' && typeof s.value === 'string' && s.value.trim()) {
        map[sh].push({ row: Number(m[2]), label: s.value.trim() });
      }
    }
    if (map[sh]) map[sh].sort((a, b) => a.row - b.row);
  }
  return map;
}

async function superviseLayer({
  layerIdx,
  totalLayers,
  layerSheets,
  allActions,
  upstreamSheets,
  modelOverride = null,
  timeoutMs = 45000,
}) {
  const start = Date.now();
  const upstreamLabels = buildUpstreamLabels(allActions, upstreamSheets);
  const payload = buildPayload(layerSheets, allActions, upstreamLabels);
  const cellCount = Object.values(payload.layer || {}).reduce((s, arr) => s + arr.length, 0);
  if (cellCount === 0) return { issues: [], fixed: 0, elapsedMs: Date.now() - start };

  const systemPrompt = pickLayerPrompt(layerIdx, totalLayers);
  const userText = [
    `## Layer ${layerIdx + 1}/${totalLayers} sheets to audit: ${layerSheets.join(', ')}`,
    '',
    '## Upstream input sheets (for cross-ref correctness):',
    '```json',
    JSON.stringify(upstreamLabels, null, 2).slice(0, 6000),
    '```',
    '',
    '## This layer\'s cells:',
    '```json',
    JSON.stringify(payload.layer, null, 2).slice(0, 16000),
    '```',
    '',
    'Audit. Return JSON with issues + fix patches.',
  ].join('\n');

  resetUsageStats();
  try {
    const result = await callLLM({
      system: systemPrompt,
      userText,
      timeoutMs,
      modelOverride,
      role: null,
      thinkingDisabled: true,
      jsonMode: true,
      label: `layer_supervisor_${layerIdx}`,
    });
    const usage = getUsageStats();
    const issues = Array.isArray(result?.issues) ? result.issues : [];
    return { issues, tokens: usage, elapsedMs: Date.now() - start };
  } catch (e) {
    logger.warn(`[LayerSupervisor] Layer ${layerIdx} skipped: ${e.message}`);
    return { issues: [], elapsedMs: Date.now() - start, error: e.message };
  }
}

// Validate a proposed fix's formula refs don't point to clearly-nonexistent SAME-SHEET cells.
// Same-sheet refs to unwritten cells become #REF!. Cross-sheet refs are allowed because
// the referenced sheet may legitimately be in a future layer.
function isFixSafe(fix, cellRefs) {
  if (!fix.formula) return true;
  const sheets = new Set();
  const cellsBySheet = new Map();
  for (const k of cellRefs.keys()) {
    const [s, a] = k.split('!');
    sheets.add(s);
    if (!cellsBySheet.has(s)) cellsBySheet.set(s, new Set());
    cellsBySheet.get(s).add(a);
  }
  const targetSheet = fix.sheet;
  // Find SAME-SHEET single cell refs in the formula (not ranges).
  // For ranges: skip them because they often legitimately span unwritten cells (auto-stub fills).
  const sameSheetSingle = /(?<![A-Za-z_!.])(\$?)([A-Z]+)(\$?)(\d+)(?![:\d])/g;
  let m;
  while ((m = sameSheetSingle.exec(fix.formula))) {
    const addr = `${m[2]}${m[4]}`;
    const existsInTarget = cellsBySheet.get(targetSheet)?.has(addr);
    if (!existsInTarget) {
      // Check it's not actually a cross-sheet ref (preceded by !)
      const pre = fix.formula.slice(Math.max(0, m.index - 1), m.index);
      if (pre === '!') continue;
      return false;
    }
  }
  return true;
}

function applyLayerFixes(actions, issues) {
  if (!Array.isArray(issues) || issues.length === 0) return 0;
  let applied = 0, rejected = 0;
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
    if (!isFixSafe(fix, cellRefs)) { rejected++; continue; }
    const key = `${fix.sheet}!${fix.addr}`;
    const ref = cellRefs.get(key);
    if (ref) {
      const spec = ref.action.cells[ref.addr];
      if (spec && typeof spec === 'object') {
        if (fix.formula) { spec.formula = fix.formula; delete spec.value; }
        else if (fix.value !== undefined) { spec.value = fix.value; delete spec.formula; }
      }
    } else {
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

module.exports = { superviseLayer, applyLayerFixes };
