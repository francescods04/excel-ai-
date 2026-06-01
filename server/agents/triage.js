/**
 * Triage: AI-driven complexity classifier.
 *
 * One cheap LLM call. Decides routing without regex/templates: the model judges
 * the objective + workbook context and returns a structured decision.
 *
 * Output shape:
 *   {
 *     complexity: "trivial" | "moderate" | "complex" | "institutional",
 *     parallelizable: boolean,
 *     mode: "single_agent" | "architect_then_parallel" | "single_deep_plan",
 *     estimated_iterations: number,   // rough budget for single agent path
 *     reasoning: string,
 *     _meta: { latencyMs, model, raw }
 *   }
 */

const { callLLM } = require('../tools/llm');
const logger = require('../utils/logger');

const TRIAGE_SYSTEM_PROMPT = `You are the routing classifier for an Excel AI agent.
Given a user objective and the current workbook state, decide:

1. complexity: one of
   - "trivial"        — single-cell edit, formula tweak, format change (<5 actions)
   - "moderate"       — single-sheet build, ~1 section (~5-15 actions)
   - "complex"        — multi-sheet work, cross-sheet refs, multiple sections (~15-40 actions)
   - "institutional"  — full models (DCF, LBO, 3-statement, comps, M&A, real-estate development / project-finance pro formas), multi-sheet with circular/sequential deps (~40+ actions)

2. parallelizable: true when the work decomposes naturally into independent sheet/section slices
   that can be built concurrently without conceptual conflicts. False for tightly coupled work
   or simple linear edits.

   STRONG BIAS toward parallelizable=true for multi-sheet financial models. Multi-sheet does
   NOT mean sequential. Typical financial builds (DCF, LBO, 3-statement, business plans, P&L
   + cash flow + balance sheet, comps, M&A models) follow a fan-out shape: ONE setup wave
   (assumptions / drivers / inputs) then EVERY downstream sheet (revenue, COGS, opex, capex,
   debt, equity, valuation, sensitivity) runs INDEPENDENTLY off those drivers. They are
   parallel-safe even if they later flow into a final P&L / valuation summary — the summary
   itself is just one more downstream slice.
   Only mark parallelizable=false when the whole task is a SINGLE conceptual artifact (one
   sheet, one waterfall, one schedule) that cannot be cleanly split into independent sections.

3. mode:
   - "single_agent"             — straight agent_loop, fast, small max_iter (use for trivial/moderate)
   - "architect_then_parallel"  — generate blueprint first, then spawn parallel workers per slice (DEFAULT for any complex / institutional build with multiple sheets — preferred whenever the work can be sliced)
   - "single_deep_plan"         — last-resort sequential structured DAG planner. Pick this ONLY if the work truly cannot be sliced. Avoid for any multi-sheet financial model.

4. estimated_iterations: integer 3-80, rough budget for the chosen mode.

5. reasoning: ONE concise sentence explaining the call. Mention any decisive signal you used.

Reply with ONLY a valid JSON object. No markdown fences. No prose outside JSON.

Schema:
{
  "complexity": "trivial|moderate|complex|institutional",
  "parallelizable": true|false,
  "mode": "single_agent|architect_then_parallel|single_deep_plan",
  "estimated_iterations": <int>,
  "reasoning": "<one sentence>"
}`;

function buildTriageUserContent({ objective, context = {}, parentSummary = '' }) {
  const sheetCount = Array.isArray(context.allSheets) ? context.allSheets.length
    : (Array.isArray(context.workbookSheets) ? context.workbookSheets.length
      : (context.allSheetsData ? Object.keys(context.allSheetsData).length : 0));
  const activeSheet = context.activeSheet || 'unknown';
  const usedRange = context.usedRange || context.activeSheetUsedRange || null;
  const sheetNames = (context.workbookSheets || context.allSheets || (context.allSheetsData ? Object.keys(context.allSheetsData) : [])).slice(0, 20);

  const lines = [
    `OBJECTIVE: ${String(objective || '').slice(0, 1500)}`,
    `WORKBOOK STATE:`,
    `- sheets present (${sheetCount}): ${sheetNames.join(', ') || '(empty workbook)'}`,
    `- active sheet: ${activeSheet}`,
    usedRange ? `- used range on active: ${usedRange}` : `- used range on active: empty`,
    context.selectedRange ? `- user selection: ${context.selectedRange}` : null,
  ].filter(Boolean);

  if (parentSummary) {
    lines.push('');
    lines.push(`PARENT TURN CONTEXT (continuation):`);
    lines.push(parentSummary.slice(0, 1500));
  }

  return lines.join('\n');
}

const TRIAGE_DEFAULT_TIMEOUT_MS = 15000;

async function triageObjective({ objective, context = {}, parentSummary = '', callLLMFn = callLLM, modelOverride = null } = {}) {
  if (!objective || typeof objective !== 'string') {
    throw new Error('triageObjective: objective is required');
  }
  const userContent = buildTriageUserContent({ objective, context, parentSummary });
  const start = Date.now();
  let llmRaw;
  try {
    llmRaw = await callLLMFn({
      system: TRIAGE_SYSTEM_PROMPT,
      userText: userContent,
      timeoutMs: TRIAGE_DEFAULT_TIMEOUT_MS,
      fallbackTimeoutMs: TRIAGE_DEFAULT_TIMEOUT_MS,
      modelOverride: modelOverride || undefined,
      role: 'triage',
      label: 'Triage classifier'
    });
  } catch (err) {
    logger.warn(`[Triage] LLM call failed: ${err.message}. Falling back to safe default.`);
    return buildSafeFallback(objective, Date.now() - start, err.message);
  }

  const parsed = extractTriageJson(llmRaw);
  const latencyMs = Date.now() - start;

  if (!parsed) {
    logger.warn(`[Triage] Could not parse JSON from LLM response. Using safe fallback.`);
    return buildSafeFallback(objective, latencyMs, 'json_parse_failed');
  }

  const validated = validateTriageDecision(parsed, objective);
  validated._meta = { latencyMs, model: llmRaw?._model || null, raw: parsed };
  return validated;
}

function extractTriageJson(llmResult) {
  if (!llmResult) return null;
  // The callLLM utility may return either a parsed object or { raw, jsonError }.
  if (typeof llmResult === 'object' && !llmResult.raw && (llmResult.complexity || llmResult.mode)) {
    return llmResult;
  }
  const text = typeof llmResult === 'string'
    ? llmResult
    : (llmResult.raw || llmResult.content || llmResult.text || '');
  if (!text || typeof text !== 'string') return null;
  // Strip fences if any
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // Try to find first JSON object in text
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (__) { return null; }
    }
    return null;
  }
}

const VALID_COMPLEXITY = new Set(['trivial', 'moderate', 'complex', 'institutional']);
const VALID_MODE = new Set(['single_agent', 'architect_then_parallel', 'single_deep_plan']);

// Parse explicit scale signals from the user objective. These travel into the
// architect prompt so the blueprint actually matches the requested density
// instead of always defaulting to summary tables. Past failure mode: user
// asked for ~1000 rows, blueprint produced 7 slices of ~30 rows each.
function extractScaleHints(objective) {
  const text = String(objective || '');
  const hints = {
    rowsRequested: null,
    rowsPerSheetRequested: null,
    periods: null,
    periodGranularity: null,
    units: null,
    detailLevel: null
  };

  const rowsPerSheetPatterns = [
    /(?:ogni|ciascun[oa]?|per)\s+(?:foglio|sheet)\D{0,40}?(\d{2,5})\s*(?:rig?h?[ae]|rows?|linee?|voci|line[- ]?items?)\b/i,
    /(\d{2,5})\s*(?:rig?h?[ae]|rows?|linee?|voci|line[- ]?items?)\s*(?:per|ogni|each)\s+(?:foglio|sheet)\b/i
  ];
  for (const re of rowsPerSheetPatterns) {
    const match = text.match(re);
    if (match) {
      hints.rowsPerSheetRequested = Number(match[1]);
      break;
    }
  }

  const rowMatch = text.match(/(\d{2,5})\s*(?:rig?h?[ae]|rows?|linee?|voci|line[- ]?items?)\b/i);
  if (rowMatch && hints.rowsPerSheetRequested == null) hints.rowsRequested = Number(rowMatch[1]);

  const monthMatch = text.match(/(\d{1,3})\s*(?:mesi|months?)\b/i);
  const yearMatch = text.match(/(\d{1,2})\s*(?:anni|years?)\b/i);
  if (monthMatch) {
    hints.periods = Number(monthMatch[1]);
    hints.periodGranularity = 'monthly';
  } else if (/\b(monthly|mensile|ogni mese|per month)\b/i.test(text)) {
    hints.periodGranularity = 'monthly';
  } else if (/\b(quarterly|trimestrale|per quarter)\b/i.test(text)) {
    hints.periodGranularity = 'quarterly';
  }
  if (yearMatch) {
    const y = Number(yearMatch[1]);
    if (hints.periodGranularity === 'monthly' && hints.periods == null) hints.periods = y * 12;
    else if (hints.periods == null) {
      hints.periods = y;
      hints.periodGranularity = hints.periodGranularity || 'annual';
    }
  }

  const unitPatterns = [
    /(\d{1,4})\s*(?:piani|floors?|stori?ey?s?)\b/i,
    /(\d{1,4})\s*(?:units?|unit[aà]|appartamenti|apartments?)\b/i,
    /(\d{1,4})\s*(?:spazi|spaces|posti|seats?|parking)\b/i,
    /(\d{1,4})\s*(?:locations?|sedi|store)\b/i
  ];
  const unitCounts = unitPatterns
    .map(re => text.match(re))
    .filter(Boolean)
    .map(m => Number(m[1]));
  if (unitCounts.length > 0) hints.units = Math.max(...unitCounts);

  if (/\b(molto dettagliat|row by row|riga per riga|very detailed|granular|line[- ]?by[- ]?line|item[- ]?level|line[- ]?item)\b/i.test(text)) {
    hints.detailLevel = 'high';
  }

  if (hints.rowsRequested == null && hints.rowsPerSheetRequested == null) {
    let inferred = 0;
    if (hints.periods && hints.units) inferred = hints.periods * hints.units;
    else if (hints.periods) inferred = hints.periods * 10;
    else if (hints.units) inferred = hints.units * 15;
    if (inferred >= 200) hints.rowsRequested = inferred;
    if (hints.detailLevel === 'high' && (hints.rowsRequested || 0) < 500) hints.rowsRequested = Math.max(hints.rowsRequested || 0, 500);
  }
  return hints;
}

function shouldForceArchitectMode(objective, scale) {
  const text = String(objective || '');
  const realEstate = /\b(immobiliare|real estate|development|progetto immobiliare|costruzione|construction|palazzo|building|finanziament|loan|mutuo)\b/i.test(text);
  const largeRows = (scale.rowsPerSheetRequested || 0) >= 500 || (scale.rowsRequested || 0) >= 800;
  const detailedModel = scale.detailLevel === 'high' && ((scale.rowsRequested || 0) >= 500 || realEstate);
  const multiUnitRealEstate = realEstate && ((scale.units || 0) >= 5 || /costi|ricavi|finanziament|sensitivity|scenar/i.test(text));
  return largeRows || detailedModel || multiUnitRealEstate;
}

function validateTriageDecision(decision, objective) {
  let complexity = VALID_COMPLEXITY.has(decision.complexity) ? decision.complexity : 'moderate';
  let mode = VALID_MODE.has(decision.mode) ? decision.mode : 'single_agent';
  let parallelizable = decision.parallelizable === true;
  let estimated = Number(decision.estimated_iterations);
  if (!Number.isFinite(estimated) || estimated <= 0) {
    estimated = complexity === 'institutional' ? 50 : (complexity === 'complex' ? 25 : (complexity === 'moderate' ? 10 : 4));
  }
  estimated = Math.max(3, Math.min(80, Math.round(estimated)));

  // Coherence guard: parallel mode requires parallelizable=true. If incoherent, downgrade.
  if (mode === 'architect_then_parallel' && !parallelizable) {
    mode = 'single_deep_plan';
  }
  // Triviality guard: trivial work should never trigger heavy modes.
  if (complexity === 'trivial' && mode !== 'single_agent') {
    mode = 'single_agent';
  }
  const scaleHints = extractScaleHints(objective);
  if (shouldForceArchitectMode(objective, scaleHints)) {
    complexity = 'institutional';
    parallelizable = true;
    mode = 'architect_then_parallel';
    estimated = Math.max(estimated, 60);
  }

  return {
    complexity,
    parallelizable,
    mode,
    estimated_iterations: estimated,
    reasoning: String(decision.reasoning || '').slice(0, 400) || `Auto-classified as ${complexity}.`,
    objective_excerpt: String(objective).slice(0, 200),
    scale_hints: scaleHints
  };
}

function buildSafeFallback(objective, latencyMs, errorTag) {
  const scaleHints = extractScaleHints(objective);
  if (shouldForceArchitectMode(objective, scaleHints)) {
    return {
      complexity: 'institutional',
      parallelizable: true,
      mode: 'architect_then_parallel',
      estimated_iterations: 70,
      reasoning: `Fallback: triage LLM unavailable (${errorTag}); large-scale workbook build routed to architect mode.`,
      objective_excerpt: String(objective).slice(0, 200),
      scale_hints: scaleHints,
      _meta: { latencyMs, model: null, raw: null, fallback: true, errorTag }
    };
  }
  // No LLM available / parse failed. Be conservative for small edits, but large
  // workbook builds are handled above.
  return {
    complexity: 'moderate',
    parallelizable: false,
    mode: 'single_agent',
    estimated_iterations: 15,
    reasoning: `Fallback: triage LLM unavailable (${errorTag}); defaulting to single_agent loop.`,
    objective_excerpt: String(objective).slice(0, 200),
    scale_hints: scaleHints,
    _meta: { latencyMs, model: null, raw: null, fallback: true, errorTag }
  };
}

module.exports = {
  triageObjective,
  extractScaleHints,
  // exported for tests
  TRIAGE_SYSTEM_PROMPT,
  buildTriageUserContent,
  extractTriageJson,
  validateTriageDecision,
  buildSafeFallback
};
