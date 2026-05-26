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
   - "institutional"  — full models (DCF, LBO, 3-statement, comps, M&A), multi-sheet with circular/sequential deps (~40+ actions)

2. parallelizable: true when the work decomposes naturally into independent sheet/section slices
   that can be built concurrently without conceptual conflicts. False for tightly coupled work
   or simple linear edits.

3. mode:
   - "single_agent"             — straight agent_loop, fast, small max_iter (use for trivial/moderate)
   - "architect_then_parallel"  — generate blueprint first, then spawn parallel workers per slice (use for complex/institutional with parallelizable=true)
   - "single_deep_plan"         — sequential structured DAG planner (complex/institutional NOT parallelizable, or when ordering is strictly required)

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

function validateTriageDecision(decision, objective) {
  const complexity = VALID_COMPLEXITY.has(decision.complexity) ? decision.complexity : 'moderate';
  let mode = VALID_MODE.has(decision.mode) ? decision.mode : 'single_agent';
  const parallelizable = decision.parallelizable === true;
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

  return {
    complexity,
    parallelizable,
    mode,
    estimated_iterations: estimated,
    reasoning: String(decision.reasoning || '').slice(0, 400) || `Auto-classified as ${complexity}.`,
    objective_excerpt: String(objective).slice(0, 200)
  };
}

function buildSafeFallback(objective, latencyMs, errorTag) {
  // No LLM available / parse failed. Be conservative: use moderate single_agent which is what the system did before.
  return {
    complexity: 'moderate',
    parallelizable: false,
    mode: 'single_agent',
    estimated_iterations: 15,
    reasoning: `Fallback: triage LLM unavailable (${errorTag}); defaulting to single_agent loop.`,
    objective_excerpt: String(objective).slice(0, 200),
    _meta: { latencyMs, model: null, raw: null, fallback: true, errorTag }
  };
}

module.exports = {
  triageObjective,
  // exported for tests
  TRIAGE_SYSTEM_PROMPT,
  buildTriageUserContent,
  extractTriageJson,
  validateTriageDecision,
  buildSafeFallback
};
