/**
 * Architect: AI-driven blueprint generator.
 *
 * One LLM call that returns a DAG of slices. Each slice has:
 *   - id (unique snake_case)
 *   - title
 *   - deps[] (other slice ids it must wait for)
 *   - scope: { sheets_owned[], ranges_owned[], may_read_from[] }
 *   - instructions (free-form build instructions for that slice)
 *   - estimated_iters (rough iteration budget for the slice)
 *
 * The LLM decides the slicing dynamically — no templates, no presets.
 * The blueprint is validated (DAG-ness, exclusive ownership within waves)
 * before being returned to the executor.
 */

const { callLLM } = require('../tools/llm');
const logger = require('../utils/logger');

const ARCHITECT_SYSTEM_PROMPT = `You are an architect for Excel financial models and workbook builds.
Given a user objective and the current workbook state, produce a BLUEPRINT: a directed acyclic graph (DAG) of build slices that can be executed in parallel waves by independent agent workers.

KEY PRINCIPLES:
- Each slice owns an EXCLUSIVE set of sheets/ranges. Two slices in the same dependency wave must NEVER overlap their sheets_owned or ranges_owned.
- A slice may read from other slices' outputs via may_read_from, but only if those slices are in its deps[] (transitively).
- Prefer 3-8 slices for complex tasks. Don't over-fragment.
- Slices should be COHERENT units of work (e.g., "build the Assumptions sheet", "build IS revenue & EBITDA rows", "build Debt Schedule"), not micro-steps.
- Cross-sheet circular dependencies (e.g., LBO Debt Schedule ↔ IS Interest ↔ Cash Flow) cannot be parallelized — put them in the same sequential slice, OR split into an explicit first-pass and a second-pass slice.
- ALWAYS end with a dedicated final slice (id like "format_and_verify", deps = ALL other slices) that runs alone in the LAST wave. It chooses formatting from the user's request and the workbook structure created by previous slices, applies it across every sheet with explicit bulk_set_format actions, adds notes to assumption/input cells (bulk_set_notes), then verifies with read_format_summary and issues at most ONE targeted repair batch. Formatting and notes belong in THIS final wave — do NOT interleave them into data-build slices (it slows workers and risks write conflicts). Because it runs alone, this slice may list ALL sheets in sheets_owned.
- MODEL TIER: set "tier":"flash" for every build and formatting worker (fast — this is the default). Use "tier":"pro" ONLY for a final audit/verification slice that needs deep cross-checking. Routine formatting is flash. Most blueprints are flash for everything.

OUTPUT JSON SCHEMA (strict, no extras):
{
  "objective_restated": "<one-line restatement of what you're building>",
  "global_layout_notes": "<conventions used across slices: year headers in row 3, blue font for inputs, currency format, etc>",
  "slices": [
    {
      "id": "<snake_case_unique>",
      "title": "<human title>",
      "deps": ["<slice_id>", ...],            // empty array for root slices
      "scope": {
        "sheets_owned": ["<exact sheet name>"],
        "ranges_owned": ["<sheet>!<A1 range>", ...],  // optional, use when slice shares a sheet with another slice (e.g., IS has multiple slices)
        "may_read_from": ["<sheet>!<A1 range or label>", ...]
      },
      "instructions": "<concrete build instructions for the worker: which sections, which formulas at which cells, what data layout. The worker WILL follow these literally — be specific>",
      "estimated_iters": <int 3-15>,
      "tier": "flash"                              // "flash" (default — all build/format workers) or "pro" (reserve for a final audit slice only)
    }
  ]
}

Reply with ONLY the JSON object. No markdown fences. No prose outside JSON.`;

function buildArchitectUserContent({ objective, context = {}, triage = null }) {
  const sheetNames = (context.workbookSheets || context.allSheets || (context.allSheetsData ? Object.keys(context.allSheetsData) : [])).slice(0, 30);
  const activeSheet = context.activeSheet || 'unknown';
  const sheetSummaries = [];
  if (context.allSheetsData && typeof context.allSheetsData === 'object') {
    for (const [name, data] of Object.entries(context.allSheetsData).slice(0, 8)) {
      const preview = (() => {
        if (!data) return '(empty)';
        if (typeof data === 'string') return data.slice(0, 200);
        if (Array.isArray(data)) return JSON.stringify(data.slice(0, 5));
        if (data.used) return `used: ${data.used}`;
        if (data.cellCount != null) return `${data.cellCount} cells`;
        return '(opaque)';
      })();
      sheetSummaries.push(`  - ${name}: ${preview}`);
    }
  }

  const lines = [
    `OBJECTIVE: ${String(objective || '').slice(0, 4000)}`,
    ``,
    `WORKBOOK STATE:`,
    `- sheets present (${sheetNames.length}): ${sheetNames.join(', ') || '(empty)'}`,
    `- active sheet: ${activeSheet}`,
    sheetSummaries.length ? `- sheet contents:\n${sheetSummaries.join('\n')}` : null,
  ].filter(Boolean);

  if (triage) {
    lines.push('');
    lines.push(`TRIAGE DECISION:`);
    lines.push(`- complexity: ${triage.complexity}`);
    lines.push(`- parallelizable: ${triage.parallelizable}`);
    lines.push(`- expected iterations (single-agent baseline): ${triage.estimated_iterations}`);
    lines.push(`- reasoning: ${triage.reasoning}`);
  }

  lines.push('');
  lines.push('Produce the blueprint now.');
  return lines.join('\n');
}

const ARCHITECT_DEFAULT_TIMEOUT_MS = 60000;

async function generateBlueprint({ objective, context = {}, triage = null, callLLMFn = callLLM, modelOverride = null } = {}) {
  if (!objective || typeof objective !== 'string') {
    throw new Error('generateBlueprint: objective is required');
  }
  const userContent = buildArchitectUserContent({ objective, context, triage });
  const start = Date.now();

  let llmRaw;
  try {
    llmRaw = await callLLMFn({
      system: ARCHITECT_SYSTEM_PROMPT,
      userText: userContent,
      timeoutMs: ARCHITECT_DEFAULT_TIMEOUT_MS,
      fallbackTimeoutMs: ARCHITECT_DEFAULT_TIMEOUT_MS,
      modelOverride: modelOverride || undefined,
      role: 'architect',
      label: 'Architect blueprint'
    });
  } catch (err) {
    throw new Error(`Architect LLM call failed: ${err.message}`);
  }

  const parsed = extractArchitectJson(llmRaw);
  if (!parsed) {
    throw new Error('Architect produced unparseable JSON');
  }
  const validation = validateBlueprint(parsed);
  if (!validation.ok) {
    throw new Error(`Architect blueprint validation failed: ${validation.errors.join('; ')}`);
  }
  validation.blueprint._meta = {
    latencyMs: Date.now() - start,
    model: llmRaw?._model || null
  };
  return validation.blueprint;
}

function extractArchitectJson(llmResult) {
  if (!llmResult) return null;
  if (typeof llmResult === 'object' && !llmResult.raw && Array.isArray(llmResult.slices)) {
    return llmResult;
  }
  const text = typeof llmResult === 'string'
    ? llmResult
    : (llmResult.raw || llmResult.content || llmResult.text || '');
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (__) { return null; }
    }
    return null;
  }
}

/**
 * Validate the blueprint:
 *  - slices is non-empty array, each has required fields
 *  - ids are unique
 *  - deps reference existing ids; no cycles (topological sort must succeed)
 *  - within each wave (slices with identical resolved depth), sheets_owned/ranges_owned must be disjoint
 *
 * Returns { ok: true, blueprint } or { ok: false, errors: [...] }.
 */
function validateBlueprint(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['blueprint is not an object'] };
  }
  if (!Array.isArray(raw.slices) || raw.slices.length === 0) {
    return { ok: false, errors: ['slices is missing or empty'] };
  }

  const sliceMap = new Map();
  for (const s of raw.slices) {
    if (!s || typeof s !== 'object') { errors.push('a slice is not an object'); continue; }
    if (!s.id || typeof s.id !== 'string') { errors.push(`a slice has invalid id`); continue; }
    if (sliceMap.has(s.id)) errors.push(`duplicate slice id: ${s.id}`);
    sliceMap.set(s.id, s);
  }
  if (errors.length) return { ok: false, errors };

  // Normalize: ensure required fields exist with safe defaults
  const normalizedSlices = [];
  for (const s of raw.slices) {
    const deps = Array.isArray(s.deps) ? s.deps.filter(d => sliceMap.has(d) && d !== s.id) : [];
    const scope = (s.scope && typeof s.scope === 'object') ? s.scope : {};
    const sheetsOwned = Array.isArray(scope.sheets_owned) ? scope.sheets_owned.map(String) : [];
    const rangesOwned = Array.isArray(scope.ranges_owned) ? scope.ranges_owned.map(String) : [];
    const mayReadFrom = Array.isArray(scope.may_read_from) ? scope.may_read_from.map(String) : [];
    const estIters = Number(s.estimated_iters);
    const tier = s.tier === 'pro' ? 'pro' : 'flash';

    normalizedSlices.push({
      id: s.id,
      title: String(s.title || s.id),
      deps,
      scope: { sheets_owned: sheetsOwned, ranges_owned: rangesOwned, may_read_from: mayReadFrom },
      instructions: String(s.instructions || '').slice(0, 8000),
      estimated_iters: Number.isFinite(estIters) ? Math.max(3, Math.min(20, Math.round(estIters))) : 8,
      tier
    });
  }

  // Cycle detection via Kahn's algorithm
  const indeg = new Map(normalizedSlices.map(s => [s.id, 0]));
  const adj = new Map(normalizedSlices.map(s => [s.id, []]));
  for (const s of normalizedSlices) {
    for (const d of s.deps) {
      adj.get(d).push(s.id);
      indeg.set(s.id, indeg.get(s.id) + 1);
    }
  }
  const queue = normalizedSlices.filter(s => indeg.get(s.id) === 0).map(s => s.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of adj.get(id)) {
      const v = indeg.get(next) - 1;
      indeg.set(next, v);
      if (v === 0) queue.push(next);
    }
  }
  if (order.length !== normalizedSlices.length) {
    return { ok: false, errors: ['blueprint DAG has a cycle'] };
  }

  // Compute waves (longest dep depth from any root)
  const depth = new Map();
  for (const id of order) {
    const slice = sliceMap.get(id);
    const deps = (slice.deps || []).filter(d => depth.has(d));
    const d = deps.length === 0 ? 0 : Math.max(...deps.map(x => depth.get(x))) + 1;
    depth.set(id, d);
  }
  const waves = [];
  for (const s of normalizedSlices) {
    const d = depth.get(s.id);
    if (!waves[d]) waves[d] = [];
    waves[d].push(s.id);
  }

  // Within each wave, sheets/ranges must be disjoint
  for (let w = 0; w < waves.length; w++) {
    const seenSheets = new Map(); // sheet → slice_id
    const seenRanges = new Map(); // range → slice_id
    for (const sid of waves[w]) {
      const slice = normalizedSlices.find(x => x.id === sid);
      for (const sh of slice.scope.sheets_owned) {
        // If sheet appears in two slices in same wave AND both claim full sheet ownership (no specific ranges), conflict.
        // If at least one constrains via ranges_owned, allow sharing.
        const fullOwnership = !slice.scope.ranges_owned.some(r => r.startsWith(sh + '!'));
        if (fullOwnership && seenSheets.has(sh)) {
          errors.push(`wave ${w}: sheet "${sh}" claimed exclusively by ${seenSheets.get(sh)} and ${sid}`);
        } else if (fullOwnership) {
          seenSheets.set(sh, sid);
        }
      }
      for (const r of slice.scope.ranges_owned) {
        if (seenRanges.has(r)) {
          errors.push(`wave ${w}: range "${r}" claimed by ${seenRanges.get(r)} and ${sid}`);
        } else {
          seenRanges.set(r, sid);
        }
      }
    }
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    blueprint: {
      objective_restated: String(raw.objective_restated || '').slice(0, 500),
      global_layout_notes: String(raw.global_layout_notes || '').slice(0, 4000),
      slices: normalizedSlices,
      waves: waves.map(w => [...w])
    }
  };
}

/**
 * Build the system prompt addendum that constrains a worker to its slice scope.
 * The worker is otherwise the regular runAgentLoop with full tools.
 */
function buildSliceWorkerPrompt(slice, blueprint) {
  const scope = slice.scope;
  return `<slice-context>
You are a focused worker building ONE slice of a larger blueprint. Other workers are building other slices in parallel.

SLICE: ${slice.id} — ${slice.title}

YOUR EXCLUSIVE SCOPE (write here, nowhere else):
- sheets owned: ${scope.sheets_owned.length ? scope.sheets_owned.join(', ') : '(none — use ranges_owned)'}
- ranges owned: ${scope.ranges_owned.length ? scope.ranges_owned.join(', ') : '(full sheets above)'}

READ-ONLY references (data from completed slices you may reference, e.g. via formulas):
${scope.may_read_from.length ? scope.may_read_from.map(r => '- ' + r).join('\n') : '(none)'}

GLOBAL LAYOUT CONVENTIONS (follow these across the model):
${blueprint.global_layout_notes || '(none specified)'}

YOUR INSTRUCTIONS (do exactly this, nothing more, nothing less):
${slice.instructions}

HARD RULES:
- DO NOT write to sheets or ranges outside your scope. If you need to reference data from another slice, use a formula referencing its known address from may_read_from.
- DO NOT call ask_user_question. Make reasonable defaults.
- When this slice is done, call the "done" tool with a one-line summary.
</slice-context>`;
}

module.exports = {
  generateBlueprint,
  // exported for tests
  ARCHITECT_SYSTEM_PROMPT,
  buildArchitectUserContent,
  extractArchitectJson,
  validateBlueprint,
  buildSliceWorkerPrompt
};
