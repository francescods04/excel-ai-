'use strict';

const fs = require('fs');
const path = require('path');
const { callLLM, resetUsageStats, getUsageStats } = require('../server/tools/llm');
const { listSkills, readSkill } = require('../server/skills/loader');
const logger = require('../server/utils/logger');

const PROMPTS_DIR = path.join(__dirname, 'prompts');

function loadPrompt(name) {
  return fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf-8');
}

function selectSkills(objective) {
  const skills = listSkills();
  const lower = objective.toLowerCase();
  const matches = [];

  const triggers = {
    'dcf-model': ['dcf', 'discounted cash flow', 'valutazione', 'wacc', 'terminal value', 'npv'],
    'lbo-model': ['lbo', 'leveraged buyout', 'private equity', 'debt schedule'],
    'business-plan': ['business plan', 'startup', 'p&l', 'profit and loss', 'fast-food', 'catena', 'ricavi'],
    'real-estate-dev-italy': ['immobiliare', 'vairano', 'costruzione', 'piano', 'mq', 'progetto immobiliare', 'sviluppo immobiliare', 'residenziale'],
    'three-statement': ['3-statement', 'three statement', 'balance sheet', 'stato patrimoniale'],
    'comps-analysis': ['comps', 'comparables', 'multiples', 'trading'],
    'wacc-model': ['wacc', 'weighted average cost', 'capm', 'beta'],
    'formatting-finance': ['formattazione', 'formatting', 'ib grade'],
    'audit-xls': ['audit', 'check', 'verify', 'errori', 'error check'],
  };

  for (const skill of skills) {
    const words = triggers[skill.name] || [];
    const triggered = words.some(w => lower.includes(w));
    if (triggered) matches.push(skill.name);
  }

  return matches.slice(0, 3);
}

async function planWorkbook(objective, context, options = {}) {
  const { callLLMFn = callLLM, modelOverride = null } = options;
  const systemPrompt = loadPrompt('planner');
  const skillNames = selectSkills(objective);
  let skillContent = '';

  if (skillNames.length > 0) {
    const loaded = skillNames.map(n => readSkill(n)).filter(Boolean);
    skillContent = loaded.map(s =>
      `### Domain Skill: ${s.name}\n${(s.content || '').slice(0, 3000)}`
    ).join('\n\n');
  }

  const contextStr = buildContextSummary(context);
  const userPrompt = [
    '## User Objective',
    objective,
    '',
    '## Workbook Context',
    contextStr || '(empty workbook — build from scratch)',
    '',
    skillContent ? '## Domain Knowledge' : '',
    skillContent,
    '',
    'Generate a detailed CODE PLAN for building this workbook. Be specific about formulas, density, formatting, and cross-sheet dependencies.',
  ].filter(Boolean).join('\n');

  resetUsageStats();
  const start = Date.now();

  // Planner: pro is more accurate on exported_cells discipline but ~2x slower.
  // Default to user override or pro since planner is the highest-leverage call.
  const { MODEL_TIERS } = require('./modelRouter');
  const plannerModel = process.env.CF_MODEL_ALL === 'flash' ? MODEL_TIERS.flash : (modelOverride || MODEL_TIERS.pro);
  const result = await callLLMFn({
    system: systemPrompt,
    userText: userPrompt,
    timeoutMs: Number(process.env.CF_PLANNER_TIMEOUT_MS) || 180000,
    modelOverride: plannerModel,
    role: null,
    thinkingDisabled: true,
    jsonMode: true,
    label: 'codefirst_planner',
  });

  const plan = result;
  const usage = getUsageStats();

  logger.info(`[Enhanced] Planner done (${Date.now() - start}ms): ${plan?.sections?.length || 0} sections, ${plan?.estimated_cells || '?'} cells`);

  return {
    plan,
    planTokens: usage,
    planTimeMs: Date.now() - start,
    skillNames,
  };
}

async function generateWithPlan(objective, context, plan, options = {}) {
  const { callLLMFn = callLLM, modelOverride = null, sliceFocus = null, timeoutMs = 180000, label = 'codefirst_codegen_v3', researchContext = null, maxRetries = 2 } = options;

  const systemPrompt = loadPrompt('codegen-v3');
  const planSummary = JSON.stringify(plan, null, 2);
  const contextStr = buildContextSummary(context);

  const userPrompt = [
    '## User Objective',
    objective,
    '',
    '## Workbook Context',
    contextStr || '(empty workbook — build from scratch)',
    '',
    '## CODE PLAN (follow this structure exactly)',
    '```json',
    planSummary,
    '```',
    '',
    sliceFocus ? `## FOCUS — Generate ONLY the "${sliceFocus}" sheet section. Other sheets exist or will be generated separately; reference them with cross-sheet refs as needed.` : '',
    '',
    '## Instructions',
    'Generate JSON actions that implement this plan. Follow the formatting conventions specified in the plan.',
    'CRITICAL: Every computed value MUST use "formula", never hardcoded "value".',
    'CRITICAL: Match the density specified in the plan. If plan says 60 months, generate ALL 60.',
    'CRITICAL: Apply formatting as specified per section (header style, input style, formula style).',
    'Return ONLY {"actions": [...]}',
  ].filter(Boolean).join('\n');

  resetUsageStats();
  const start = Date.now();
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await callLLMFn({
        system: systemPrompt,
        userText: userPrompt,
        timeoutMs,
        modelOverride,
        role: null,
        thinkingDisabled: true,
        jsonMode: true,
        label: attempt === 0 ? label : `${label}_retry${attempt}`,
      });

      let actions = null;
      let code = null;

      if (result && typeof result === 'object') {
        if (Array.isArray(result.actions)) {
          actions = result.actions;
        } else if (Array.isArray(result)) {
          actions = result;
        }
        if (result.code && typeof result.code === 'string') code = result.code;
      }

      if (!actions && result && typeof result === 'string') {
        try { const parsed = JSON.parse(result); actions = parsed.actions || parsed; } catch (_) {}
      }

      const usage = getUsageStats();

      if (!actions || actions.length === 0) {
        if (attempt < maxRetries - 1) {
          logger.warn(`[Enhanced] CodeGen attempt ${attempt + 1} returned empty actions, retrying in ${(attempt + 1) * 2000}ms...`);
          await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
          continue;
        }
      }

      logger.info(`[Enhanced] CodeGen done (${Date.now() - start}ms, attempt ${attempt + 1}): ${actions ? actions.length : 0} actions`);

      return {
        actions,
        code,
        codeTokens: usage,
        codeTimeMs: Date.now() - start,
      };
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        const delay = (attempt + 1) * 3000;
        logger.warn(`[Enhanced] CodeGen attempt ${attempt + 1} failed: ${error.message}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  logger.error(`[Enhanced] CodeGen failed after ${maxRetries} attempts: ${lastError ? lastError.message : 'no actions'}`);
  return { actions: null, error: lastError ? lastError.message : 'no actions after retries' };
}

function planComplexity(plan) {
  if (!plan?.sections) return { sections: 0, estCells: 0 };
  const sections = plan.sections.length;
  const estCells = Number(plan.estimated_cells) || sections * 30;
  return { sections, estCells };
}

function buildSlices(plan) {
  const sections = plan?.sections || [];
  // Default 10 to fit Vercel 270s budget. Override with FORCE_MAX_SLICES env.
  // For mega scenarios (institutional) bump via env: FORCE_MAX_SLICES=25.
  const MAX_SLICES = Number(process.env.FORCE_MAX_SLICES) || 10;
  const limited = sections.slice(0, MAX_SLICES);
  if (sections.length > MAX_SLICES) {
    logger.warn(`[Enhanced] Plan has ${sections.length} sections; limiting to ${MAX_SLICES} to keep generation fast.`);
  }
  const slices = [];
  for (let i = 0; i < limited.length; i++) {
    const s = limited[i];
    const sheet = s.sheet || 'Sheet1';
    const rawEst = Number(s.estimated_cells) || 0;
    const est = rawEst || (s.is_time_series && s.periods ? Math.min(s.periods * 8, 480) : 60);
    slices.push({
      id: `${sheet}_${i}`,
      label: s.title ? `${sheet} — ${s.title}` : sheet,
      sheet,
      section: s,
      estCells: est,
    });
  }
  return slices;
}

function countSetCellRangeCells(actions) {
  if (!Array.isArray(actions)) return 0;
  return actions.reduce((sum, a) =>
    sum + (a.type === 'setCellRange' && a.cells ? Object.keys(a.cells).length : 0), 0);
}

function detectSilentFailures(sliceResults, { threshold = 5 } = {}) {
  if (!Array.isArray(sliceResults) || sliceResults.length === 0) return [];
  const silentFails = [];
  for (const r of sliceResults) {
    if (!r || !Array.isArray(r.actions)) {
      silentFails.push(r);
      continue;
    }
    const dataCells = countSetCellRangeCells(r.actions);
    if (dataCells < threshold && r.actions.length < 3) {
      silentFails.push(r);
    }
  }
  return silentFails;
}

// Build a pre-agreed cell address "contract" from the planner's exported_cells.
// The planner specifies exact row numbers upfront; all slices use ONLY these addresses.
// This prevents #REF! even when slices run in full parallel — no guessing needed.
function buildPreAgreedCellMap(plan, sheetFilter = null) {
  if (!plan?.sections) return '';
  const lines = [];
  for (const s of plan.sections) {
    const sheet = s.sheet || 'Sheet1';
    if (sheetFilter && !sheetFilter.has(sheet)) continue;
    const exported = Array.isArray(s.exported_cells) ? s.exported_cells : [];
    if (exported.length === 0) continue;
    lines.push(`\n=== '${sheet}' ===`);
    for (const e of exported) {
      if (typeof e !== 'string' || e.length === 0) continue;
      // Normalise "B5 = Monthly Revenue" → "'Sheet'!$B$5 = Monthly Revenue"
      const abs = e.replace(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?/, (_, c1, r1, c2, r2) =>
        c2 ? `$${c1}$${r1}:$${c2}$${r2}` : `$${c1}$${r1}`
      );
      lines.push(`'${sheet}'!${abs}`);
    }
  }
  return lines.join('\n');
}

// Build a SYMBOL-LIKE cell map with semantic concept tags so downstream slices
// can pick the right row by concept name, not by guessing the row number.
// Maps both directions: concept name → address AND address → concept.
// Concepts derived from row labels via fuzzy match.
const CONCEPT_PATTERNS = {
  wacc: /\bwacc|cost of capital|discount rate/i,
  tax_rate: /\btax rate|aliquota|imposta/i,
  cogs_pct: /\bcogs\s*%|food cost/i,
  ebitda_margin: /ebitda\s*margin/i,
  capex: /\bcapex\b|capital expenditure|initial capex/i,
  d_and_a: /\bd&a|depreciation|amortization/i,
  daily_traffic: /daily traffic|daily customers|covers|footfall/i,
  conversion: /conversion\s*rate|conv\s*%/i,
  aov: /\baov\b|average order value|scontrino|average check|ticket/i,
  operating_days: /operating days|giorni operativi|days per year/i,
  growth_y1: /growth.*y1|y1.*growth|crescita.*1/i,
  exit_multiple: /exit multiple|terminal multiple/i,
  terminal_growth: /terminal growth|gordon/i,
  inflation: /inflation/i,
  shares: /shares\s*outstanding|share count|sharecount/i,
  ev: /enterprise value|^ev$/i,
  equity: /\bequity\s*purchase|equity value/i,
};

function colToNum(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function extractSymbolMap(sheetName, actions) {
  const lines = [];
  for (const a of actions) {
    if (a.type !== 'setCellRange' || a.sheet !== sheetName || !a.cells) continue;
    const rowMap = {};
    for (const [addr, cell] of Object.entries(a.cells)) {
      const m = addr.match(/^([A-Z]+)(\d+)$/); if (!m) continue;
      if (!rowMap[m[2]]) rowMap[m[2]] = {};
      rowMap[m[2]][m[1]] = cell;
    }
    for (const row of Object.keys(rowMap).sort((a, b) => Number(a) - Number(b))) {
      const a1 = rowMap[row].A?.value;
      const bCell = rowMap[row].B;
      if (typeof a1 !== 'string' || a1.length < 2 || !bCell) continue;
      // Formula rows (computed lines like EBITDA) must appear in the map too —
      // downstream sheets reference them. Skipping them made the LLM invent
      // addresses (observed mega failure class: exit_analysis_wrong_column).
      const b1 = bCell.value !== undefined ? bCell.value : (bCell.formula ? '(formula)' : undefined);
      if (b1 === undefined) continue;
      // Try to tag this row with a known concept
      let concept = null;
      for (const [name, pat] of Object.entries(CONCEPT_PATTERNS)) {
        if (pat.test(a1)) { concept = name; break; }
      }
      const tag = concept ? `[@${concept}]` : '';
      // Column extent: time-series rows span B..lastCol. Downstream sheets need the
      // last period column (exit year, terminal value).
      const cols = Object.keys(rowMap[row]).filter(c => c !== 'A').sort((x, y) => colToNum(x) - colToNum(y));
      const lastCol = cols[cols.length - 1];
      const extent = lastCol && lastCol !== 'B' ? ` [spans B${row}:${lastCol}${row}, last period col ${lastCol}]` : '';
      lines.push(`${sheetName}!$B$${row} = "${a1}" ${tag} (val: ${b1})${extent}`);
    }
  }
  return lines.join('\n');
}

// Extract a cell-address map from a generated Assumptions-style sheet.
// Returns lines like: "Assumptions!$B$4 = "Operating Days per Year" (value: 360)"
// These are injected into downstream slice prompts so formulas use correct addresses.
function extractCellMap(sheetName, actions) {
  const rowData = {};
  for (const a of actions) {
    if (a.type !== 'setCellRange' || a.sheet !== sheetName || !a.cells) continue;
    for (const [addr, cell] of Object.entries(a.cells)) {
      const m = addr.match(/^([A-Z]+)(\d+)$/);
      if (!m) continue;
      const [, col, row] = m;
      if (!rowData[row]) rowData[row] = {};
      // Only store non-formula values for the map
      if (!cell.formula && cell.value !== undefined && cell.value !== null && cell.value !== '') {
        rowData[row][col] = cell.value;
      }
    }
  }
  const lines = [];
  for (const row of Object.keys(rowData).sort((a, b) => Number(a) - Number(b))) {
    const cols = rowData[row];
    if (cols['A'] && typeof cols['A'] === 'string' && cols['B'] != null) {
      const label = String(cols['A']).trim();
      if (label.length > 2 && !label.startsWith('#')) {
        lines.push(`${sheetName}!$B$${row} = "${label}" (value: ${cols['B']})`);
      }
    }
  }
  return lines.join('\n');
}

// Heuristic layer assignment by sheet name patterns. Used as fallback when planner doesn't
// emit cross_sheet_deps. Layer 0 = pure inputs; later layers = consolidation/derivative.
const LAYER_PATTERNS = [
  // L0: pure inputs
  ['assumptions', 'assunzioni', 'input', 'inputs', 'key assumptions', 'parametri', 'dati', 'menu', 'menumix', 'menueconomics', 'dealstructure', 'sourcesuses', 'sources_uses', 'pricing', 'transactions', 'personnel', 'staffing'],
  // L1: intermediate builds
  ['revenue', 'sales', 'costs', 'costi', 'ricavi', 'opex', 'staffingopex', 'acquirerstandalone', 'targetstandalone', 'standalone', 'synergies', 'debtschedule', 'workingcapital'],
  // L2: consolidation
  ['pnl', 'p&l', 'profitloss', 'incomestatement', 'is', 'proforma', 'consolidated', 'contoeconomico'],
  // L3: derivative
  ['cashflow', 'cash', 'balancesheet', 'bs'],
  // L4: terminal calcs
  ['returns', 'valuation', 'indici', 'investorreturns', 'accretion_dilution', 'accretiondilution', 'eps', 'fundinguse', 'funding'],
  // L5: what-if
  ['sensitivity', 'sensitivityaccrdil', 'sensitivityirr', 'scaleup', 'scenarios', 'breakeven', 'summary', 'executivesummary'],
];

function heuristicLayer(sheetName) {
  const k = String(sheetName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (let i = 0; i < LAYER_PATTERNS.length; i++) {
    if (LAYER_PATTERNS[i].some(p => k.includes(p))) return i;
  }
  return 1; // unknown → middle
}

const INPUT_SHEET_PATTERNS = ['assumptions', 'assunzioni', 'input', 'inputs', 'key assumptions', 'parametri', 'dati'];

function isInputSheet(sheetName) {
  const lower = (sheetName || '').toLowerCase();
  return INPUT_SHEET_PATTERNS.some(p => lower.includes(p));
}

async function generateStepwise(objective, context, plan, options = {}) {
  const { modelOverride = null, onProgress = null, parallel = true, maxConcurrency = 12, validateSlice = null, researchContext = null } = options;
  const slices = buildSlices(plan);
  if (slices.length === 0) return { actions: [], codeTokens: { promptTokens: 0, completionTokens: 0, calls: 0 }, codeTimeMs: 0, sliceResults: [], stepwise: true };

  const allSheets = [...new Set(slices.map(s => s.sheet))];
  logger.info(`[Enhanced] Stepwise codegen: ${slices.length} slices across ${allSheets.length} sheets [${allSheets.join(', ')}]`);

  const createActions = allSheets.map(s => ({ type: 'createSheet', sheet: s }));
  const sheetCreated = new Set(allSheets);

  const totals = { promptTokens: 0, completionTokens: 0, calls: 0 };
  let totalMs = 0;

  // Agentic loop: generate → validate → identify issues → patch → re-validate.
  // Inspired by harness-style coding loops. Each slice retries up to N iterations
  // when the deterministic validator finds issues, feeding errors back to the LLM.
  const { runSliceLoop } = require('./sliceLoop');

  async function runSlice(slice, idx, objectiveOverride = null, upstreamActions = []) {
    const eff = objectiveOverride || objective;
    // Pick best model for this slice: pro for consolidation/sensitivity/returns, flash for routine
    const { pickModelForSlice } = require('./modelRouter');
    const sliceModel = pickModelForSlice(slice, modelOverride);
    if (onProgress) onProgress('generating', { message: `Building "${slice.label}" (${idx + 1}/${slices.length})...` });
    const subPlan = {
      sections: [slice.section],
      global_conventions: plan.global_conventions || {},
      model_type: plan.model_type,
      cross_sheet_deps: plan.cross_sheet_deps,
      estimated_cells: slice.estCells,
    };
    const isHeavyTimeSeries = slice.section.is_time_series && (slice.section.periods || 0) >= 24;
    const verstcap = process.env.VERCEL ? 90000 : null;
    let baseTimeout = slice.estCells > 400 || isHeavyTimeSeries ? 300000 : (slice.estCells > 200 ? 180000 : 120000);
    if (verstcap && baseTimeout > verstcap) baseTimeout = verstcap;
    const exported = slice.section.exported_cells || [];
    const exportedNote = exported.length > 0 ? ` CRITICAL: This sheet MUST expose these cells for other sheets: ${exported.join(', ')}.` : '';
    const focusLine = `the "${slice.label}" section in sheet "${slice.sheet}"${slice.section.row_range ? ` rows ${slice.section.row_range}` : ''}. This section MUST contain at least ${slice.estCells} cells (formulas, values, and labels combined). Do not skip rows or summarize; emit every cell.${exportedNote}`;

    // The generateFn closure used by runSliceLoop. extraInstructions is the patch-prompt
    // appended on retry iterations. If consensus is enabled and this slice is critical,
    // generate N parallel attempts and pick the best by validator score.
    let iterCounter = 0;
    async function generateFn(extraInstructions) {
      iterCounter++;
      const label = iterCounter === 1 ? `cf_slice_${slice.id}` : `cf_slice_${slice.id}_iter${iterCounter}`;
      const fullObjective = extraInstructions ? `${eff}\n${extraInstructions}` : eff;
      const callerOpts = {
        modelOverride: sliceModel,
        sliceFocus: focusLine,
        timeoutMs: baseTimeout,
        label,
        researchContext,
      };
      if (useConsensus && iterCounter === 1) {
        const { consensusGenerate } = require('./consensusGen');
        const gens = Array.from({ length: consensusN }, (_, i) => () => generateWithPlan(
          fullObjective, context, subPlan, { ...callerOpts, label: `${label}_n${i}` }
        ));
        const consensusResult = await consensusGenerate(gens, slice.sheet);
        if (rejectionSamplingOn && consensusResult.actions) {
          const { judgeAndPick } = require('./consensusGen');
          const judged = await judgeAndPick(
            consensusResult.rawResults || [{ actions: consensusResult.actions }],
            slice.sheet,
            modelOverride
          );
          if (judged && judged.actions) {
            return { ...consensusResult, actions: judged.actions, judged: true };
          }
        }
        return consensusResult;
      }
      return generateWithPlan(fullObjective, context, subPlan, callerOpts);
    }

    // Micro-step: huge time-series slices split into 2 LLM calls. EXPERIMENTAL —
    // benchmark showed expansion step produces too-small outputs (LLM doesn't track
    // skeleton context well). Disabled by default; enable with CF_MICRO_STEP=1.
    const { shouldMicroStep, runMicroStep } = require('./microStep');
    const microStepOn = !!process.env.CF_MICRO_STEP && shouldMicroStep(slice);
    if (microStepOn) {
      const ms = await runMicroStep({
        slice,
        baseObjective: eff,
        context,
        subPlan,
        modelOverride: sliceModel,
        generateWithPlanFn: generateWithPlan,
        baseTimeout,
      });
      totals.promptTokens += ms.totals.promptTokens;
      totals.completionTokens += ms.totals.completionTokens;
      totals.calls += ms.totals.calls;
      totalMs += ms.totalMs;
      if (ms.actions && ms.actions.length > 0) {
        return { slice, actions: ms.actions, error: null, microStep: true };
      }
    }

    // Multi-LLM consensus: parallel codegen calls, pick best by validator score.
    // Used on input/consolidation slices where errors cascade most. Enable with
    // CF_CONSENSUS_N=2 (or 3). Default OFF — costs N× tokens.
    const consensusN = Number(process.env.CF_CONSENSUS_N) || 1;
    // Heuristic for "critical" slices that benefit most from consensus
    const isCriticalSlice = /assumptions|menu|input|pnl|p&l|incomestatement|proforma|consolidated|revenue/i.test(slice.sheet);
    const useConsensus = consensusN > 1 && isCriticalSlice;

    // Decide whether to use agentic loop. Default ON; disable with CF_DISABLE_SLICE_LOOP.
    const sliceLoopOn = !process.env.CF_DISABLE_SLICE_LOOP;
    // Huge slices (>250 cells, like 60-month P&L): the LLM can't reliably fix 60-cell
    // refs in 2 iterations — but density-contract violations (row stops short of the
    // promised column extent) DO fix reliably with a precise instruction, and they're
    // the dominant mega bug. So big slices get a retry restricted to those kinds.
    const isHugeSlice = slice.estCells > 250;
    const maxIterations = process.env.CF_SLICE_MAX_ITER ? Number(process.env.CF_SLICE_MAX_ITER) : 2;
    const retryOnlyKinds = isHugeSlice ? ['density_contract', 'silent_slice', 'empty_output'] : null;

    if (sliceLoopOn) {
      // AI reviewer: experimental peer-review LLM. Adds quality on simple scenarios
      // but regresses complex ones (generator can't fix many issues at once).
      // Opt-in via CF_AI_REVIEWER=1. Use pro via CF_REVIEWER_PRO=1.
      const { MODEL_TIERS: MR_TIERS } = require('./modelRouter');
      const aiReviewerEnabled = !!process.env.CF_AI_REVIEWER;
      const aiReviewerModel = process.env.CF_REVIEWER_PRO ? MR_TIERS.pro : MR_TIERS.flash;
      const loopResult = await runSliceLoop({
        sliceLabel: slice.label,
        sliceSheet: slice.sheet,
        sliceSection: slice.section,
        objectiveBase: eff,
        context,
        subPlan,
        upstreamActions,
        generateFn,
        maxIterations,
        timeoutMs: baseTimeout,
        expectedMinCells: Math.max(10, Math.floor(slice.estCells * 0.5)),
        aiReviewerEnabled,
        aiReviewerModel,
        retryOnlyKinds,
      });
      if (loopResult.totals) {
        totals.promptTokens += loopResult.totals.promptTokens || 0;
        totals.completionTokens += loopResult.totals.completionTokens || 0;
        totals.calls += loopResult.totals.calls || 0;
      }
      totalMs += loopResult.totalMs || 0;
      if (loopResult.actions && loopResult.actions.length > 0) {
        return { slice, actions: loopResult.actions, error: null, iterations: loopResult.iterations };
      }
    }

    if (sliceModel !== modelOverride) {
      logger.info(`[ModelRouter] Slice "${slice.label}" → ${sliceModel}`);
    }
    // Fallback path: single-shot codegen if loop disabled or empty result
    const fallback = await generateFn('');
    if (fallback.codeTokens) {
      totals.promptTokens += fallback.codeTokens.promptTokens || 0;
      totals.completionTokens += fallback.codeTokens.completionTokens || 0;
      totals.calls += fallback.codeTokens.calls || 0;
    }
    totalMs += fallback.codeTimeMs || 0;
    return { slice, actions: fallback.actions || [], error: fallback.error };
  }

  // Helper: fire onProgress for a completed slice + push to sliceResults
  function emitSliceDone(slice, r) {
    completedSlices++;
    if (onProgress) {
      const cells = countSetCellRangeCells(r.actions);
      onProgress('slice_complete', {
        message: `Done "${slice.label}" — ${cells} cells (${completedSlices}/${slices.length})`,
        sliceLabel: slice.label,
        sliceSheet: slice.sheet,
        sliceActions: r.actions || [],
        completedSlices,
        totalSlices: slices.length,
      });
    }
    sliceResults.push(r);
  }

  // --- Layered topological generation ---
  // Layer 0: sheets nothing depends on (or input sheets). Layer 1: depends only on layer 0. Etc.
  // Within a layer: parallel. Between layers: sequential, so downstream slices see
  // the actual generated cell addresses of their upstream deps.

  // Pre-agreed cell map: extracted from planner's exported_cells BEFORE any LLM call.
  const preAgreedMap = buildPreAgreedCellMap(plan);
  if (preAgreedMap) {
    logger.info(`[Enhanced] Pre-agreed cell map: ${preAgreedMap.split('\n').filter(l => l.trim()).length} entries`);
  }

  // Topological layering: prefer explicit cross_sheet_deps; fallback to name heuristic.
  function buildSheetLayers() {
    const sheetSet = new Set(slices.map(s => s.sheet));
    const deps = plan.cross_sheet_deps || {};
    // Count actual declared deps
    let depCount = 0;
    for (const sheet of sheetSet) {
      const readsFrom = (deps[sheet] && Array.isArray(deps[sheet].reads_from)) ? deps[sheet].reads_from : [];
      depCount += readsFrom.filter(s => sheetSet.has(s) && s !== sheet).length;
    }
    // If planner gave us substantial deps (>= sheetCount-1), use topological.
    // Otherwise use name-heuristic layering — more reliable than dumping everything into L0.
    const useTopological = depCount >= sheetSet.size - 1 && depCount > 0;

    if (!useTopological) {
      // Name-pattern layering
      const byLayer = [[], [], [], [], [], []];
      for (const sheet of sheetSet) {
        const li = Math.min(heuristicLayer(sheet), byLayer.length - 1);
        byLayer[li].push(sheet);
      }
      // Drop empty layers
      return byLayer.filter(l => l.length > 0);
    }

    // Topological by declared deps
    const reads = {};
    for (const sheet of sheetSet) {
      const readsFrom = (deps[sheet] && Array.isArray(deps[sheet].reads_from)) ? deps[sheet].reads_from : [];
      reads[sheet] = new Set(readsFrom.filter(s => sheetSet.has(s) && s !== sheet));
    }
    const layers = [];
    const placed = new Set();
    const layer0 = [];
    for (const sheet of sheetSet) {
      if (isInputSheet(sheet) || reads[sheet].size === 0) {
        layer0.push(sheet);
        placed.add(sheet);
      }
    }
    if (layer0.length === 0) {
      for (const s of sheetSet) { layer0.push(s); placed.add(s); }
    }
    layers.push(layer0);
    let guard = 0;
    while (placed.size < sheetSet.size && guard++ < 10) {
      const next = [];
      for (const sheet of sheetSet) {
        if (placed.has(sheet)) continue;
        const allDepsPlaced = [...reads[sheet]].every(d => placed.has(d));
        if (allDepsPlaced) next.push(sheet);
      }
      if (next.length === 0) {
        for (const sheet of sheetSet) if (!placed.has(sheet)) next.push(sheet);
      }
      for (const s of next) placed.add(s);
      layers.push(next);
    }
    return layers;
  }

  const sheetLayers = buildSheetLayers();
  logger.info(`[Enhanced] Sheet layers: ${sheetLayers.map((l, i) => `L${i}=[${l.join(',')}]`).join(' | ')}`);

  let completedSlices = 0;
  const sliceResults = [];
  const runtimeCellMaps = {};
  const symbolLayerOn = !!process.env.CF_SYMBOL_LAYER;
  let runtimeSymbolTables = {};
  const sensitivityDslOn = !!process.env.CF_SENSITIVITY_DSL;
  const skeletonFillOn = !!process.env.CF_SKELETON_FILL;
  const invariantsOn = !!process.env.CF_INVARIANTS;
  const rejectionSamplingOn = !!process.env.CF_REJECTION_SAMPLING;

  // Context diet: each slice only sees RUNTIME maps of sheets it declares it reads
  // from (plan.cross_sheet_deps[sheet].reads_from) plus its own sheet. The compact
  // pre-agreed map stays FULL for every slice — planner reads_from lists are often
  // incomplete, and without an anchor for undeclared sheets the LLM invents
  // addresses (observed: broken_cell_ref retries). Sheets with no declared deps
  // get full context (safe fallback). CF_FULL_CONTEXT=1 reverts.
  function depSheetsFor(sliceSheet) {
    if (process.env.CF_FULL_CONTEXT) return null;
    const d = (plan.cross_sheet_deps || {})[sliceSheet];
    if (!d || !Array.isArray(d.reads_from)) return null;
    return new Set([...d.reads_from, sliceSheet]);
  }

  function buildCombinedObjective(base, slice) {
    const filter = slice ? depSheetsFor(slice.sheet) : null;
    const parts = [];
    if (preAgreedMap) {
      parts.push(`## PRE-AGREED CELL MAP (from plan — use ONLY these exact addresses)\n${preAgreedMap}`);
    }
    const runtimeEntries = Object.entries(runtimeCellMaps)
      .filter(([sheet, map]) => map && (!filter || filter.has(sheet)))
      .map(([sheet, map]) => `=== ${sheet} ===\n${map}`);
    if (runtimeEntries.length > 0) {
      parts.push(`## RUNTIME CELL MAP (actual generated addresses from prior layers)\n${runtimeEntries.join('\n\n')}`);
    }
    if (symbolLayerOn && Object.keys(runtimeSymbolTables).length > 0) {
      const { buildSymbolResolutionPrompt } = require('./symbolLayer');
      const tables = filter
        ? Object.fromEntries(Object.entries(runtimeSymbolTables).filter(([sheet]) => filter.has(sheet)))
        : runtimeSymbolTables;
      const symPrompt = Object.keys(tables).length > 0 ? buildSymbolResolutionPrompt(tables) : '';
      if (symPrompt) parts.push(symPrompt);
    }
    if (parts.length === 0) return base;
    return `${base}\n\n${parts.join('\n\n')}`;
  }

  async function runLayer(layerSheets) {
    const layerSlices = slices.filter(s => layerSheets.includes(s.sheet));
    if (layerSlices.length === 0) return;
    const layerResults = [];
    if (parallel) {
      let cursor = 0;
      async function worker() {
        while (true) {
          const idx = cursor++;
          if (idx >= layerSlices.length) return;
          const slice = layerSlices[idx];
          const globalIdx = slices.indexOf(slice);
          try {
            // Build upstream snapshot for slice's agentic loop to validate cross-refs
            const upstreamSnapshot = [...createActions];
            for (const sr of sliceResults) {
              for (const a of (sr.actions || [])) upstreamSnapshot.push(a);
            }
            const r = await runSlice(slice, globalIdx, buildCombinedObjective(objective, slice), upstreamSnapshot);
            layerResults.push(r);
            emitSliceDone(slice, r);
          } catch (e) {
            completedSlices++;
            if (onProgress) onProgress('generating', { message: `Failed "${slice.label}" (${completedSlices}/${slices.length})` });
            const errR = { slice, actions: [], error: e.message };
            layerResults.push(errR);
            sliceResults.push(errR);
          }
        }
      }
      const workers = Array.from({ length: Math.min(maxConcurrency, layerSlices.length) }, () => worker());
      await Promise.all(workers);
    } else {
      for (let i = 0; i < layerSlices.length; i++) {
        const slice = layerSlices[i];
        const globalIdx = slices.indexOf(slice);
        try {
          const r = await runSlice(slice, globalIdx, buildCombinedObjective(objective, slice));
          layerResults.push(r);
          emitSliceDone(slice, r);
        } catch (e) {
          completedSlices++;
          if (onProgress) onProgress('generating', { message: `Failed "${slice.label}" (${completedSlices}/${slices.length})` });
          const errR = { slice, actions: [], error: e.message };
          layerResults.push(errR);
          sliceResults.push(errR);
        }
      }
    }
    // Update runtime cell map from this layer's outputs so next layer can ref them.
    // Use symbol map (with concept tags) when available — better grounding for downstream LLM.
    for (const r of layerResults) {
      if (!r.actions || r.actions.length === 0) continue;
      const sheetName = r.slice.sheet;
      const symMap = extractSymbolMap(sheetName, r.actions);
      const map = symMap || extractCellMap(sheetName, r.actions);
      if (map) runtimeCellMaps[sheetName] = runtimeCellMaps[sheetName] ? `${runtimeCellMaps[sheetName]}\n${map}` : map;
      if (symbolLayerOn) {
        const { buildSymbolTable } = require('./symbolLayer');
        runtimeSymbolTables[sheetName] = buildSymbolTable(sheetName, r.actions);
      }
    }
  }

  // Inline layer supervisor: senior-analyst critic runs after each layer. EXPERIMENTAL:
  // currently disabled by default because subagent audit showed the LLM patches Y1
  // cells correctly but breaks Y2-Y5 (uses wrong assumption rows for later periods).
  // Enable via CF_LAYER_SUPERVISOR=1 to opt in. The single-pass semantic critic
  // (Phase 4c) gives most of the value with less regression risk.
  const layerSupervisorOn = !!process.env.CF_LAYER_SUPERVISOR;
  const { superviseLayer, applyLayerFixes } = require('./layerSupervisor');

  for (let li = 0; li < sheetLayers.length; li++) {
    if (onProgress) onProgress('generating', { message: `Layer ${li + 1}/${sheetLayers.length}: ${sheetLayers[li].join(', ')}` });
    await runLayer(sheetLayers[li]);
    const mapLineCount = Object.values(runtimeCellMaps).reduce((s, m) => s + m.split('\n').length, 0);
    if (mapLineCount > 0) {
      logger.info(`[Enhanced] After layer ${li}: ${mapLineCount} runtime map lines across ${Object.keys(runtimeCellMaps).length} sheets`);
    }

    // Deep mode (default): supervise EVERY layer for max quality. Adds ~60s wall
    // but catches consolidation/derivative/sensitivity bugs at source.
    // Fast mode: only supervise L0 + L1 (~15s). Set CF_SUPERVISOR_MODE=fast to enable.
    const supervisorMode = process.env.CF_SUPERVISOR_MODE || 'deep';
    const supervisorOK = supervisorMode === 'deep'
      ? true
      : new Set([0, 1]).has(li);
    if (layerSupervisorOn && supervisorOK) {
      if (onProgress) onProgress('reviewing', { message: `Layer ${li + 1} supervisor review...` });
      const upstreamSheets = sheetLayers.slice(0, li).flat();
      // Build the current actions snapshot for supervisor
      const snapshotActions = [...createActions];
      for (const r of sliceResults) {
        for (const a of (r.actions || [])) snapshotActions.push(a);
      }
      try {
        const sup = await superviseLayer({
          layerIdx: li,
          totalLayers: sheetLayers.length,
          layerSheets: sheetLayers[li],
          allActions: snapshotActions,
          upstreamSheets,
          modelOverride,
          timeoutMs: 45000,
        });
        if (sup.issues && sup.issues.length > 0) {
          // Apply fixes IN-PLACE to sliceResults (which feed the next layer's prompt
          // via extractCellMap → runtimeCellMapContext).
          let appliedTotal = 0;
          for (const r of sliceResults) {
            const fixesForThisSlice = sup.issues.filter(i => i.fix && i.fix.sheet === r.slice.sheet);
            if (fixesForThisSlice.length === 0) continue;
            appliedTotal += applyLayerFixes(r.actions, fixesForThisSlice);
          }
          // For fixes addressed to sheets not yet in sliceResults, append a synthetic slice
          const extraFixes = sup.issues.filter(i => i.fix && i.fix.sheet && !sliceResults.some(r => r.slice.sheet === i.fix.sheet));
          if (extraFixes.length > 0) {
            const synthActions = [];
            for (const issue of extraFixes) {
              const f = issue.fix;
              const spec = f.formula ? { formula: f.formula } : (f.value !== undefined ? { value: f.value } : null);
              if (!spec) continue;
              synthActions.push({ type: 'setCellRange', sheet: f.sheet, cells: { [f.addr]: spec } });
              appliedTotal++;
            }
            if (synthActions.length > 0) {
              sliceResults.push({ slice: { sheet: '__supervisor__', label: `L${li}_fix` }, actions: synthActions, error: null });
            }
          }
          logger.info(`[LayerSupervisor] L${li}: ${sup.issues.length} issues, ${appliedTotal} fixes applied (${sup.elapsedMs}ms)`);
          // Re-extract runtime cell map after fixes so next layer sees updated addresses
          for (const k of Object.keys(runtimeCellMaps)) delete runtimeCellMaps[k];
          for (const r of sliceResults) {
            if (!r.actions || r.actions.length === 0) continue;
            const map = extractCellMap(r.slice.sheet, r.actions);
            if (map) runtimeCellMaps[r.slice.sheet] = runtimeCellMaps[r.slice.sheet] ? `${runtimeCellMaps[r.slice.sheet]}\n${map}` : map;
          }
        } else {
          logger.info(`[LayerSupervisor] L${li}: clean (${sup.elapsedMs}ms)`);
        }
      } catch (e) {
        logger.warn(`[LayerSupervisor] L${li} failed: ${e.message}`);
      }
    }
  }

  // Phase 2 hook: Sensitivity DSL deterministic generation
  if (sensitivityDslOn) {
    const { generateSensitivityActions, detectSensitivitySpec } = require('./sensitivityGen');
    for (const r of sliceResults) {
      const section = r.slice?.section;
      if (!section) continue;
      const isSens = /^Sensitivity/i.test(r.slice.sheet) || !!section.sensitivity_spec;
      if (isSens && section.sensitivity_spec) {
        const sensActions = generateSensitivityActions(section, runtimeSymbolTables);
        if (sensActions) {
          r.actions = sensActions;
          logger.info(`[Enhanced] Sensitivity DSL applied for ${r.slice.sheet}`);
        }
      } else if (isSens && !section.sensitivity_spec) {
        const detected = detectSensitivitySpec(r.actions, r.slice.sheet);
        if (detected && detected.sensitivity_spec) {
          const sensActions = generateSensitivityActions(detected, runtimeSymbolTables);
          if (sensActions) {
            r.actions = sensActions;
            logger.info(`[Enhanced] Sensitivity DSL fallback applied for ${r.slice.sheet}`);
          }
        }
      }
    }
  }

  // Phase 4 hook: Invariant enforcement
  if (invariantsOn && plan.invariants) {
    const { checkInvariants, buildInvariantFixes } = require('./invariantChecker');
    const allActions = [...createActions];
    for (const r of sliceResults) {
      for (const a of r.actions || []) allActions.push(a);
    }
    const invIssues = checkInvariants(allActions, plan.invariants);
    if (invIssues.length > 0) {
      logger.warn(`[Enhanced] Invariant violations: ${invIssues.length}`);
      const fixes = buildInvariantFixes(allActions, invIssues);
      if (fixes.length > 0) {
        for (const fix of fixes) {
          sliceResults.push({ slice: { sheet: fix.sheet || 'InvariantFix', label: 'invariant_fix' }, actions: [fix], error: null });
        }
      }
    }
  }

  // Post-codegen quality gate:
  // 1. Silent failures: slice with <5 data cells
  // 2. Low density: slice with <50% of estimated cells
  const SILENT_FAIL_THRESHOLD = 5;
  const LOW_DENSITY_RATIO = 0.5;
  const slicesToRetry = [];
  for (const r of sliceResults) {
    const cells = countSetCellRangeCells(r.actions);
    if (cells < SILENT_FAIL_THRESHOLD) {
      slicesToRetry.push({ r, slice: r.slice, reason: `silent (${cells} cells)` });
    } else if (r.slice.estCells > 20 && cells < r.slice.estCells * LOW_DENSITY_RATIO) {
      slicesToRetry.push({ r, slice: r.slice, reason: `low density (${cells}/${r.slice.estCells})` });
    }
  }
  // Skip retry pass if we're running on Vercel (budget-tight) to fit in 270s.
  // The repair LLM calls double time. Auto-stub handles the missing cells anyway.
  const skipRetryForBudget = !!process.env.VERCEL;
  if (slicesToRetry.length > 0 && skipRetryForBudget) {
    logger.warn(`[Enhanced] ${slicesToRetry.length} slices low-density but skipping retry on Vercel (budget-tight). Auto-stub will fill gaps.`);
  } else if (slicesToRetry.length > 0) {
    logger.warn(`[Enhanced] ${slicesToRetry.length} slices need retry: ${slicesToRetry.map(s => s.slice.label + ' ' + s.reason).join('; ')}`);
    if (onProgress) onProgress('finalizing', { message: `Repairing ${slicesToRetry.length} low-density sections...` });
    await Promise.all(slicesToRetry.map(async ({ r }) => {
      const slice = r.slice;
      const subPlan = {
        sections: [slice.section],
        global_conventions: plan.global_conventions || {},
        model_type: plan.model_type,
        estimated_cells: slice.estCells,
      };
      const repair = await generateWithPlan(
        `${buildCombinedObjective(objective)}\n\nCRITICAL: previous attempt for "${slice.label}" produced too few cells (${countSetCellRangeCells(r.actions)} vs expected ${slice.estCells}). You MUST emit at least ${slice.estCells} setCellRange cells with formulas/values for this section. Do not skip rows, periods, or formulas.`,
        context, subPlan,
        {
          modelOverride,
          sliceFocus: `the "${slice.label}" section in sheet "${slice.sheet}". MUST contain at least ${slice.estCells} cells.`,
          timeoutMs: 180000,
          label: `cf_slice_${slice.id}_density_repair`,
          researchContext,
        }
      );
      if (repair.codeTokens) {
        totals.promptTokens += repair.codeTokens.promptTokens || 0;
        totals.completionTokens += repair.codeTokens.completionTokens || 0;
        totals.calls += repair.codeTokens.calls || 0;
      }
      totalMs += repair.codeTimeMs || 0;
      if (repair.actions && repair.actions.length > 0) {
        const repairCells = countSetCellRangeCells(repair.actions);
        if (repairCells >= slice.estCells * LOW_DENSITY_RATIO) {
          r.actions = repair.actions;
          r.repaired = true;
        }
      }
    }));
  }

  const allActions = [...createActions];
  for (const r of sliceResults) {
    for (const a of r.actions) {
      if (a.type === 'createSheet' && sheetCreated.has(a.sheet)) continue;
      if (a.type === 'createSheet') sheetCreated.add(a.sheet);
      allActions.push(a);
    }
  }

  const failedSlices = sliceResults.filter(r => !r.actions || r.actions.length === 0);
  const repairedCount = sliceResults.filter(r => r.repaired).length;
  if (onProgress) onProgress('finalizing', { message: `Assembling ${allActions.length} actions across ${sliceResults.length - failedSlices.length}/${sliceResults.length} sections...` });
  logger.info(`[Enhanced] Stepwise done: ${sliceResults.length - failedSlices.length}/${sliceResults.length} slices OK${repairedCount ? `, ${repairedCount} repaired` : ''}, ${allActions.length} actions, ${totals.calls} LLM calls`);

  return {
    actions: allActions,
    codeTokens: totals,
    codeTimeMs: totalMs,
    sliceResults: sliceResults.map(r => ({ slice: r.slice.label, actionCount: r.actions.length, error: r.error })),
    stepwise: true,
  };
}

async function reviewCode(actionsOrCode, objective, plan, options = {}) {
  const { callLLMFn = callLLM, modelOverride = null } = options;
  const systemPrompt = loadPrompt('critic-v3');

  const actionsJson = Array.isArray(actionsOrCode)
    ? JSON.stringify(actionsOrCode).slice(0, 15000)
    : String(actionsOrCode).slice(0, 15000);

  const userPrompt = [
    '## User Objective',
    objective.slice(0, 2000),
    '',
    '## Code Plan',
    JSON.stringify(plan?.sections?.map(s => ({ sheet: s.sheet, title: s.title, key_formulas: s.key_formulas })) || {}, null, 2).slice(0, 3000),
    '',
    '## Generated Actions',
    '```json',
    actionsJson,
    '```',
    '',
    'Review these actions. Report issues. Return JSON.',
  ].join('\n');

  resetUsageStats();
  const start = Date.now();

  try {
    const result = await callLLMFn({
      system: systemPrompt,
      userText: userPrompt,
      timeoutMs: 60000,
      modelOverride,
      role: null,
      thinkingDisabled: true,
      jsonMode: true,
      label: 'codefirst_critic',
    });

    const usage = getUsageStats();

    logger.info(`[Enhanced] Critic done (${Date.now() - start}ms): approved=${result?.approved}, score=${result?.score}, issues=${result?.issues?.length || 0}`);

    return {
      review: result,
      reviewTokens: usage,
      reviewTimeMs: Date.now() - start,
    };
  } catch (error) {
    logger.warn(`[Enhanced] Critic failed (non-blocking): ${error.message}`);
    return { review: null };
  }
}

async function refineCode(actionsOrCode, objective, plan, criticIssues, options = {}) {
  const { callLLMFn = callLLM, modelOverride = null } = options;

  const systemPrompt = loadPrompt('codegen-v3');
  const planSummary = JSON.stringify(plan, null, 2).slice(0, 4000);
  const issuesSummary = criticIssues
    .filter(i => i.severity === 'critical' || i.severity === 'high')
    .map(i => `[${i.severity}] ${i.location}: ${i.description}\n  FIX: ${i.fix}`)
    .join('\n');

  const actionsJson = Array.isArray(actionsOrCode)
    ? JSON.stringify(actionsOrCode).slice(0, 8000)
    : String(actionsOrCode).slice(0, 8000);

  const userPrompt = [
    '## Original Objective',
    objective,
    '',
    '## Code Plan',
    '```json', planSummary, '```',
    '',
    '## Previous Actions (needs fixes)',
    '```json', actionsJson, '```',
    '',
    '## CRITIC ISSUES TO FIX',
    issuesSummary,
    '',
    '## Instructions',
    'Fix ALL the critical and high-severity issues listed above. Keep everything else the same.',
    'Return ONLY {"actions": [...]}',
  ].join('\n');

  resetUsageStats();
  const start = Date.now();

  try {
    const result = await callLLMFn({
      system: systemPrompt,
      userText: userPrompt,
      timeoutMs: 180000,
      modelOverride,
      role: null,
      thinkingDisabled: true,
      jsonMode: true,
      label: 'codefirst_refiner',
    });

    let actions = null;
    if (result && typeof result === 'object') {
      if (Array.isArray(result.actions)) actions = result.actions;
      else if (Array.isArray(result)) actions = result;
    }
    if (!actions && result && typeof result === 'string') {
      try { const parsed = JSON.parse(result); actions = parsed.actions || parsed; } catch (_) {}
    }

    const usage = getUsageStats();
    logger.info(`[Enhanced] Refiner done (${Date.now() - start}ms): ${actions ? actions.length : 0} actions`);

    return { actions, refinerTokens: usage, refinerTimeMs: Date.now() - start };
  } catch (error) {
    logger.warn(`[Enhanced] Refiner failed: ${error.message}`);
    return { actions: null };
  }
}

function actionsFromResult(actions) {
  if (!actions || !Array.isArray(actions)) return { actions: [], cellCount: 0 };
  const cellCount = actions.reduce((sum, a) => {
    if (a.type === 'setCellRange' && a.cells) return sum + Object.keys(a.cells).length;
    return sum;
  }, 0);
  return { actions, cellCount };
}

function looksLikeEdit(objective, context) {
  if (!context) return false;
  const sheets = context.workbookSheets || context.allSheets || (context.allSheetsData ? Object.keys(context.allSheetsData) : []);
  if (!sheets || sheets.length === 0) return false;
  if (!objective || typeof objective !== 'string') return false;
  const lo = objective.toLowerCase();
  // Skip if it looks like a "create from scratch" request even with context present.
  const createSignals = ['crea ', 'create ', 'genera ', 'build ', 'da zero', 'from scratch', 'nuovo foglio', 'new sheet'];
  if (createSignals.some(s => lo.includes(s))) return false;
  const editSignals = [
    'cambia', 'modifica', 'aggiorna', 'imposta', 'metti', 'porta',
    'change', 'update', ' set ', 'modify', 'adjust', 'increase', 'decrease',
    'invece di', 'al posto di', 'aumenta', 'diminuisci', 'riduci',
    'now change', 'ma ora', 'fai diventare', 'rendi ', 'sostituisci',
    'ora il', 'ora la', 'ora porta', 'ora cambia',
  ];
  // Word-boundary check so "set" doesn't match inside other words.
  return editSignals.some(s => lo.startsWith(s) || lo.includes(' ' + s) || lo.includes(s + ' '));
}

function buildEditContext(context) {
  if (!context) return '(no workbook context provided)';
  const parts = [];
  const sheets = context.sheets || [];
  if (context.workbookSheets) parts.push(`Sheets: ${context.workbookSheets.join(', ')}`);
  if (context.activeSheet) parts.push(`Active: ${context.activeSheet}`);
  for (const s of sheets.slice(0, 12)) {
    parts.push(`\n--- ${s.name} (${s.rowCount || '?'} × ${s.columnCount || '?'}) ---`);
    const preview = s.preview || [];
    const formulas = s.formulas || [];
    for (let r = 0; r < Math.min(preview.length, 30); r++) {
      const row = preview[r] || [];
      const frow = formulas[r] || [];
      const cells = [];
      for (let c = 0; c < Math.min(row.length, 12); c++) {
        const v = row[c];
        const f = frow[c];
        const colLetter = String.fromCharCode(65 + c);
        const addr = `${colLetter}${r + 1}`;
        if (f && String(f).startsWith('=')) cells.push(`${addr}=${f}`);
        else if (v !== '' && v !== null && v !== undefined) cells.push(`${addr}:${v}`);
      }
      if (cells.length > 0) parts.push(cells.join(' | '));
    }
  }
  return parts.join('\n');
}

async function editPipeline(objective, context, options = {}) {
  const { modelOverride = null, onProgress = null } = options;
  const totalStart = Date.now();

  if (onProgress) onProgress('editing', { message: 'Identificazione celle da modificare...' });
  const systemPrompt = loadPrompt('edit');
  const ctxStr = buildEditContext(context);

  const userPrompt = [
    '## User Instruction',
    objective,
    '',
    '## Workbook Context (existing values + formulas)',
    ctxStr,
    '',
    '## Task',
    'Emit setCellRange actions for ONLY the cells that need to change. Return {"actions":[...], "explanation":"..."} or {"actions":[], "question":"..."} if ambiguous.',
  ].join('\n');

  resetUsageStats();
  let result;
  try {
    result = await callLLM({
      system: systemPrompt,
      userText: userPrompt,
      timeoutMs: 45000,
      modelOverride,
      role: null,
      thinkingDisabled: true,
      jsonMode: true,
      label: 'codefirst_edit',
    });
  } catch (e) {
    return { status: 'failed', error: e.message, totalMs: Date.now() - totalStart };
  }

  const actions = Array.isArray(result?.actions) ? result.actions : [];
  const usage = getUsageStats();
  logger.info(`[Enhanced] Edit done (${Date.now() - totalStart}ms): ${actions.length} actions, "${result?.explanation || ''}"`);

  if (actions.length === 0 && result?.question) {
    return {
      status: 'clarification_needed',
      question: result.question,
      explanation: result.explanation || null,
      totalMs: Date.now() - totalStart,
      totalTokens: usage,
    };
  }

  const { sanitizeActions } = require('./actionSanitizer');
  const sanitized = sanitizeActions(actions);

  return {
    status: 'ok',
    mode: 'edit',
    actions: sanitized.actions,
    cellCount: sanitized.actions.reduce((s, a) => s + (a.cells ? Object.keys(a.cells).length : 0), 0),
    explanation: result?.explanation || null,
    totalMs: Date.now() - totalStart,
    totalTokens: usage,
    sanitizerStats: sanitized.stats,
  };
}

async function enhancedPipeline(objective, context = {}, options = {}) {
  const {
    modelOverride = null,
    skipCritic = true,
    onProgress = null,
    forceMode = null, // 'edit' | 'create' | null
  } = options;
  const { sanitizeActions } = require('./actionSanitizer');

  // Auto-route to edit mode when an existing workbook is present and the
  // instruction looks like an edit. Big speedup: single LLM call ~5-15s vs
  // full plan+codegen cycle ~60s+.
  const mode = forceMode || (looksLikeEdit(objective, context) ? 'edit' : 'create');
  if (mode === 'edit') {
    logger.info(`[Enhanced] Routing to edit mode: "${objective.slice(0, 80)}..."`);
    return editPipeline(objective, context, options);
  }

  const totalStart = Date.now();
  const pipeline = { phases: {} };

  // Phase 1: Plan
  if (onProgress) onProgress('planning', { message: 'Analyzing request and creating blueprint...' });
  const planResult = await planWorkbook(objective, context, { modelOverride });
  pipeline.phases.plan = planResult;

  if (!planResult.plan || !planResult.plan.sections) {
    logger.warn('[Enhanced] Plan failed or empty, falling back to direct codegen');
    const minimalPlan = { sections: [{ sheet: 'Sheet1', title: objective, key_formulas: [] }], global_conventions: {} };
    const directResult = await generateWithPlan(objective, context, minimalPlan, { modelOverride });
    if (directResult.actions && Array.isArray(directResult.actions)) {
      const sanitized = sanitizeActions(directResult.actions);
      const cellInfo = actionsFromResult(sanitized.actions);
      return {
        status: 'ok',
        actions: cellInfo.actions,
        cellCount: cellInfo.cellCount,
        plan: minimalPlan,
        review: null,
        pipeline: { phases: { plan: planResult, codegen: directResult }, mode: 'direct' },
        totalTokens: directResult.codeTokens,
        totalMs: Date.now() - totalStart,
        skillNames: [],
        sanitizerStats: sanitized.stats,
      };
    }
    return { status: 'failed', error: 'Code generation failed' };
  }

  // Phase 2: Code Generation. Stepwise per-sheet for big plans, single-shot for small.
  const cx = planComplexity(planResult.plan);
  const stepwiseOverride = options.stepwise; // null | true | false
  const useStepwise = stepwiseOverride === true
    || (stepwiseOverride !== false && (cx.sections > 4 || cx.estCells > 250));

  if (onProgress) onProgress('generating', { message: `Building ${cx.sections} sections${useStepwise ? ' (stepwise)' : ''}...` });

  let codeResult;
  if (useStepwise) {
    codeResult = await generateStepwise(objective, context, planResult.plan, {
      modelOverride,
      onProgress,
      parallel: options.parallelSlices !== false,
    });
  } else {
    codeResult = await generateWithPlan(objective, context, planResult.plan, { modelOverride });
  }
  pipeline.phases.codegen = codeResult;
  pipeline.codegenMode = useStepwise ? 'stepwise' : 'single-shot';

  if (!codeResult.actions || !Array.isArray(codeResult.actions) || codeResult.actions.length === 0) {
    return { status: 'failed', error: codeResult.error || 'Code generation failed', pipeline };
  }

  // Phase 3: Critic + Refine (disabled — unreliable on some models)
  if (!skipCritic) {
    if (onProgress) onProgress('reviewing', { message: 'Validating actions...' });
    const reviewResult = await reviewCode(codeResult.actions, objective, planResult.plan, { modelOverride });
    pipeline.phases.critic = reviewResult;

    const hasCritical = reviewResult.review && !reviewResult.review.approved
      && reviewResult.review.issues?.some(i => i.severity === 'critical');

    if (hasCritical && reviewResult.review.score < 40) {
      logger.warn(`[Enhanced] Critic found critical issues (score ${reviewResult.review.score}), refining...`);
      if (onProgress) onProgress('refining', { message: 'Fixing critical issues...' });

      const refined = await refineCode(codeResult.actions, objective, planResult.plan,
        reviewResult.review.issues, { modelOverride });
      pipeline.phases.refiner = refined;

      if (refined.actions && Array.isArray(refined.actions) && refined.actions.length >= codeResult.actions.length * 0.6) {
        codeResult.actions = refined.actions;
        logger.info(`[Enhanced] Refiner produced new actions (${refined.actions.length} total)`);
      } else {
        logger.warn(`[Enhanced] Refiner output too small (${refined.actions ? refined.actions.length : 0} vs ${codeResult.actions.length}), keeping original`);
      }
    } else if (reviewResult.review && !reviewResult.review.approved) {
      logger.info(`[Enhanced] Critic issues non-critical (score ${reviewResult.review.score}), skipping refiner`);
    }
  }

  // Phase 4: Sanitize actions (drop bad fillRange, bound whole-column targets, expand shorthand)
  const sanitized = sanitizeActions(codeResult.actions);
  if (sanitized.stats.dropped + sanitized.stats.expanded + sanitized.stats.bounded > 0) {
    logger.info(`[Enhanced] Sanitizer: dropped=${sanitized.stats.dropped} expanded=${sanitized.stats.expanded} bounded=${sanitized.stats.bounded} kept=${sanitized.stats.kept}`);
  }
  codeResult.actions = sanitized.actions;

  // Phase 4b: Auto-stub broken cell refs + auto-coerce string-in-arith.
  // Runs AFTER sanitizer so it sees the canonical sheet names and final cell layout.
  {
    const { indexCells, extractCellRefs } = require('./cellDepValidator');
    let idx = indexCells(codeResult.actions);
    const sheetSet = new Set();
    for (const a of codeResult.actions) {
      if (a.sheet) sheetSet.add(a.sheet);
      if (a.type === 'createSheet' && a.sheet) sheetSet.add(a.sheet);
    }
    const stubsBySheet = new Map();
    for (const [_key, cell] of idx) {
      if (!cell.formula) continue;
      const refs = extractCellRefs(cell.formula);
      for (const ref of refs) {
        const refSheet = ref.sheet || cell.sheet;
        if (!sheetSet.has(refSheet)) continue;
        const refKey = `${refSheet}!${ref.addr}`;
        if (idx.has(refKey)) continue;
        if (!stubsBySheet.has(refSheet)) stubsBySheet.set(refSheet, {});
        stubsBySheet.get(refSheet)[ref.addr] = { value: 0, cellStyles: { numberFormat: '#,##0' } };
      }
    }
    if (stubsBySheet.size > 0) {
      let totalStubs = 0;
      for (const [sheet, cells] of stubsBySheet) {
        totalStubs += Object.keys(cells).length;
        codeResult.actions.push({ type: 'setCellRange', sheet, cells });
      }
      logger.info(`[Enhanced] Auto-stubbed ${totalStubs} unwritten cells across ${stubsBySheet.size} sheets (eliminates #REF!)`);
    }
    // Re-index for string-in-arith coercion
    idx = indexCells(codeResult.actions);
    const coercedAddrsBySheet = new Map();
    for (const [_k, cell] of idx) {
      if (!cell.formula) continue;
      if (/^=\s*TABLE\s*\(/i.test(cell.formula)) continue;
      const isArith = /[+\-*/^]/.test(cell.formula.replace(/^=/, '')) || /\b(SUM|PRODUCT|AVERAGE|NPV|IRR|XIRR|XNPV|RATE|PMT|FV|PV|POWER)\s*\(/i.test(cell.formula);
      if (!isArith) continue;
      const refs = extractCellRefs(cell.formula);
      for (const ref of refs) {
        if (ref.positional) continue;
        const refSheet = ref.sheet || cell.sheet;
        const refKey = `${refSheet}!${ref.addr}`;
        const target = idx.get(refKey);
        if (!target || target.formula) continue;
        const v = target.value;
        if (typeof v !== 'string') continue;
        if (v.trim() === '' || /^-?\d+(\.\d+)?$/.test(v.trim()) || /^[€$£]?\s*-?\d/.test(v.trim())) continue;
        if (!coercedAddrsBySheet.has(refSheet)) coercedAddrsBySheet.set(refSheet, new Set());
        coercedAddrsBySheet.get(refSheet).add(ref.addr);
      }
    }
    if (coercedAddrsBySheet.size > 0) {
      let totalCoerced = 0;
      for (const a of codeResult.actions) {
        if (a.type !== 'setCellRange' || !a.cells) continue;
        const set = coercedAddrsBySheet.get(a.sheet);
        if (!set) continue;
        for (const addr of Object.keys(a.cells)) {
          if (!set.has(addr)) continue;
          const spec = a.cells[addr];
          if (!spec || typeof spec !== 'object') continue;
          spec.value = 0;
          if (!spec.cellStyles) spec.cellStyles = {};
          if (!spec.cellStyles.numberFormat) spec.cellStyles.numberFormat = '#,##0';
          totalCoerced++;
        }
      }
      if (totalCoerced > 0) logger.info(`[Enhanced] Auto-coerced ${totalCoerced} string cells to 0 (eliminates #VALUE! in arithmetic)`);
    }
  }

  // Phase 4b2: Deterministic auto-fixes — Mix% normalization, time-series column auto-fill, label-aware ref repair.
  {
    const { applyAutoFixes } = require('./semanticAutoFix');
    const { repairRefs, snapRefsToEdge } = require('./refRepair');
    const { autoFixIRRArrayLiterals, autoFixTaxMax, autoFixDebtEndingInterest } = require('./financeLint');
    // Run ref repair FIRST so subsequent fills propagate correct refs.
    const refsFixed = repairRefs(codeResult.actions);
    // Snap past-the-edge series refs BEFORE the zero-stub pass would hide them.
    const refsSnapped = snapRefsToEdge(codeResult.actions);
    const irrFixed = autoFixIRRArrayLiterals(codeResult.actions);
    const taxFixed = autoFixTaxMax(codeResult.actions);
    const debtFixed = autoFixDebtEndingInterest(codeResult.actions);
    const autoStats = applyAutoFixes(codeResult.actions);
    autoStats.refsRepaired = refsFixed;
    autoStats.refsSnapped = refsSnapped;
    autoStats.irrArrayFixed = irrFixed;
    autoStats.taxMaxFixed = taxFixed;
    autoStats.debtInterestFixed = debtFixed;
    if (autoStats.mixCellsNormalized + autoStats.timeSeriesCellsAdded + refsFixed + refsSnapped + irrFixed + taxFixed + debtFixed > 0) {
      logger.info(`[Enhanced] AutoFix: ${refsFixed} refs, ${refsSnapped} edge-snapped, ${irrFixed} IRR/NPV arrays, ${taxFixed} tax MAX, ${debtFixed} debt interest, ${autoStats.mixCellsNormalized} Mix, ${autoStats.timeSeriesCellsAdded} time-series filled`);
    }
    pipeline.autoFix = autoStats;
  }

  // Phase 4b3: Second auto-stub pass to catch refs introduced by time-series fill.
  // When fill expands B5 → C5:N5, the new shifted formulas reference C4:N4 (and so on)
  // which may not exist. Stub those zeros so user sees clean values not #REF!.
  {
    const { indexCells, extractCellRefs } = require('./cellDepValidator');
    const idx = indexCells(codeResult.actions);
    const sheetSet = new Set();
    for (const a of codeResult.actions) {
      if (a.sheet) sheetSet.add(a.sheet);
      if (a.type === 'createSheet' && a.sheet) sheetSet.add(a.sheet);
    }
    const stubsBySheet = new Map();
    for (const [_key, cell] of idx) {
      if (!cell.formula) continue;
      const refs = extractCellRefs(cell.formula);
      for (const ref of refs) {
        const refSheet = ref.sheet || cell.sheet;
        if (!sheetSet.has(refSheet)) continue;
        const refKey = `${refSheet}!${ref.addr}`;
        if (idx.has(refKey)) continue;
        if (!stubsBySheet.has(refSheet)) stubsBySheet.set(refSheet, {});
        stubsBySheet.get(refSheet)[ref.addr] = { value: 0, cellStyles: { numberFormat: '#,##0' } };
      }
    }
    if (stubsBySheet.size > 0) {
      let totalStubs = 0;
      for (const [sheet, cells] of stubsBySheet) {
        totalStubs += Object.keys(cells).length;
        codeResult.actions.push({ type: 'setCellRange', sheet, cells });
      }
      logger.info(`[Enhanced] Post-autofix stub pass: ${totalStubs} additional unwritten cells stubbed`);
    }
  }

  // Phase 4b4: TARGETED FIXER — code-agent-style per-bug patches.
  // Run finance lints + cellDepValidator on assembled workbook. For each bug
  // dispatch a focused LLM call (single cell, single fix). Like Claude Code:
  // tiny prompt, tiny scope, surgical patch.
  if (options.enableTargetedFixer !== false) {
    try {
      const { runFinanceLints } = require('./financeLint');
      const { validateCellDeps } = require('./cellDepValidator');
      const lintBugs = runFinanceLints(codeResult.actions);
      const depBugs = validateCellDeps(codeResult.actions).map(d => ({ severity: d.severity, kind: d.kind, location: d.location, detail: d.detail }));
      const allBugs = [...lintBugs, ...depBugs].filter(b => b.severity === 'critical' || b.severity === 'high');
      // Skip bug kinds the targeted fixer can't reliably handle:
      //   - broken_cell_ref: auto-stub fills with 0
      //   - missing_required_sheet / missing_sheet: needs codegen, not patch
      //   - duplicate_addresses: not a real bug (just notice)
      //   - unformatted_numbers: cosmetic
      //   - silent_slice / empty_output: empty slice, can't patch
      //   - too_many_hardcoded: warning, not a specific cell
      const SKIP_KINDS = new Set([
        'broken_cell_ref', 'silent_slice', 'empty_output',
        'missing_required_sheet', 'missing_sheet',
        'duplicate_addresses', 'unformatted_numbers', 'too_many_hardcoded',
        'sources_uses_no_check', 'bs_no_check', // structural advice, not single-cell fix
      ]);
      const semanticOnly = allBugs.filter(b => !SKIP_KINDS.has(b.kind));
      if (semanticOnly.length > 0) {
        const { dispatchTargetedFixes } = require('./targetedFixer');
        const { MODEL_TIERS: TF_TIERS } = require('./modelRouter');
        const fixerModel = process.env.CF_FIXER_PRO ? TF_TIERS.pro : TF_TIERS.flash;
        if (onProgress) onProgress('reviewing', { message: `Targeted fixer: ${semanticOnly.length} bugs to patch...` });
        const fixResult = await dispatchTargetedFixes({
          bugs: semanticOnly,
          actions: codeResult.actions,
          modelOverride: fixerModel,
          maxConcurrency: 6,
          timeoutMs: 25000,
        });
        logger.info(`[Enhanced] TargetedFixer: ${fixResult.applied} patches applied, ${fixResult.skipped} skipped (${semanticOnly.length} bugs total)`);
        pipeline.targetedFixer = { bugs: semanticOnly.length, applied: fixResult.applied, skipped: fixResult.skipped, tokens: fixResult.tokens };
      }
    } catch (e) {
      logger.warn(`[Enhanced] TargetedFixer skipped: ${e.message}`);
    }
  }

  // Phase 4c: Semantic critic — finance-aware audit of cross-sheet coherence.
  // Catches Mix % ≠ 100%, AOV inconsistency, wrong formula structure.
  // Single LLM call, ~30-60s, cheap model.
  if (options.enableSemanticCritic !== false) {
    try {
      if (onProgress) onProgress('reviewing', { message: 'Auditing financial coherence...' });
      const { semanticAudit, applyCriticFixes } = require('./semanticCritic');
      // Semantic critic: flash by default (fast, mostly catches things); pro opt-in.
      const { MODEL_TIERS } = require('./modelRouter');
      const criticModel = process.env.CF_PRO_CRITIC ? MODEL_TIERS.pro : (modelOverride || MODEL_TIERS.flash);
      const audit = await semanticAudit(codeResult.actions, { modelOverride: criticModel, timeoutMs: 60000 });
      if (audit.issues && audit.issues.length > 0) {
        const applied = applyCriticFixes(codeResult.actions, audit.issues);
        logger.info(`[Enhanced] Semantic critic: ${audit.issues.length} issues, ${applied} fixes applied`);
        pipeline.semanticCritic = { issueCount: audit.issues.length, fixesApplied: applied, tokens: audit.tokens };
      }
    } catch (e) {
      logger.warn(`[Enhanced] Semantic critic skipped: ${e.message}`);
    }
  }

  // Phase 4d: Execution-grounded value loop — compute the workbook, let a strong
  // critic judge the NUMBERS (no domain rules), re-check the planner's own
  // invariants numerically, patch surgically, re-evaluate. The general quality
  // mechanism for arbitrary complex tasks. Disable with CF_VALUE_LOOP=0.
  if (process.env.CF_VALUE_LOOP !== '0') {
    try {
      const sheetCount = new Set(codeResult.actions.filter(a => a.sheet).map(a => a.sheet)).size;
      if (sheetCount >= 4) {
        if (onProgress) onProgress('reviewing', { message: 'Computing model and reviewing the numbers...' });
        const { runValueLoop } = require('./valueLoop');
        const vl = await runValueLoop({
          actions: codeResult.actions,
          objective,
          plan: planResult.plan,
          modelOverride,
          maxPasses: Number(process.env.CF_VALUE_LOOP_PASSES) || 2,
          onProgress,
        });
        logger.info(`[Enhanced] ValueLoop: ${vl.passes} passes, ${vl.bugsFound} bugs, ${vl.patchesApplied} patches`);
        pipeline.valueLoop = vl;
      }
    } catch (e) {
      logger.warn(`[Enhanced] ValueLoop skipped: ${e.message}`);
    }
  }

  // Phase 5: Structural formula validation. Catches broken cross-sheet refs,
  // self-references, division-by-zero BEFORE Excel sees them.
  const { validateFormulas } = require('./formulaValidator');
  const validationIssues = validateFormulas(codeResult.actions, context);
  const criticalIssues = validationIssues.filter(i => i.severity === 'critical');
  if (validationIssues.length > 0) {
    logger.info(`[Enhanced] Validator: ${criticalIssues.length} critical, ${validationIssues.filter(i => i.severity === 'high').length} high, ${validationIssues.filter(i => i.severity === 'medium').length} medium`);
  }
  pipeline.validation = { issueCount: validationIssues.length, critical: criticalIssues.length, issues: validationIssues.slice(0, 20) };

  const cellInfo = actionsFromResult(codeResult.actions);
  pipeline.phases.execution = { ...cellInfo, executionMs: 0 };
  pipeline.sanitizer = sanitized.stats;

  const totalMs = Date.now() - totalStart;
  const totalTokens = {
    promptTokens: (planResult.planTokens?.promptTokens || 0) + (codeResult.codeTokens?.promptTokens || 0) + (pipeline.phases.critic?.reviewTokens?.promptTokens || 0),
    completionTokens: (planResult.planTokens?.completionTokens || 0) + (codeResult.codeTokens?.completionTokens || 0) + (pipeline.phases.critic?.reviewTokens?.completionTokens || 0),
    calls: (planResult.planTokens?.calls || 0) + (codeResult.codeTokens?.calls || 0) + (pipeline.phases.critic?.reviewTokens?.calls || 0),
  };

  logger.info(`[Enhanced] Pipeline complete (${totalMs}ms): ${cellInfo.cellCount} cells, ${totalTokens.promptTokens + totalTokens.completionTokens} tokens, ${totalTokens.calls} LLM calls`);

  return {
    status: 'ok',
    code: codeResult.code || null,
    codeLength: codeResult.code ? codeResult.code.length : 0,
    cellCount: cellInfo.cellCount,
    actions: cellInfo.actions,
    plan: planResult.plan,
    review: pipeline.phases.critic?.review || null,
    pipeline,
    totalTokens,
    totalMs,
    skillNames: planResult.skillNames,
  };
}

function buildContextSummary(context) {
  if (!context || Object.keys(context).length === 0) return '';
  const parts = [];
  const sheets = Array.isArray(context.workbookSheets) ? context.workbookSheets
    : (Array.isArray(context.allSheets) ? context.allSheets
      : (context.allSheetsData ? Object.keys(context.allSheetsData) : []));
  if (sheets.length > 0) {
    parts.push(`Existing sheets: ${sheets.slice(0, 20).join(', ')}`);
    if (context.activeSheet) parts.push(`Active sheet: ${context.activeSheet}`);
    if (context.sheets) {
      for (const s of context.sheets.slice(0, 8)) {
        parts.push(`  ${s.name}: ${s.usedRange?.rowCount || '?'} rows × ${s.usedRange?.columnCount || '?'} cols`);
      }
    }
  }
  if (context._researchContext) {
    parts.push('\n=== RESEARCH CONTEXT ===\n' + String(context._researchContext).slice(0, 6000));
  }
  return parts.join('\n');
}

module.exports = { enhancedPipeline, editPipeline, looksLikeEdit, planWorkbook, generateWithPlan, generateStepwise, reviewCode, selectSkills, detectSilentFailures, countSetCellRangeCells, buildSlices, buildContextSummary, actionsFromResult };
