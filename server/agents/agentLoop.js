const fs = require('fs');
const path = require('path');
const { callLLM, callLLMStreaming, getLLMConfig } = require('../tools/llm');
const logger = require('../utils/logger');
const { executeTool, registry } = require('../tools/registry');
const SHARED_SCHEMAS = require('../tools/schemas');
const { validateTaskOutput } = require('./critic');
const streaming = require('./streaming');
const { initializeTools } = require('../utils/toolSearch');
const { detectSkills } = require('../utils/skillSuggest');
const clientReadCache = require('../utils/clientReadCache');
const { normalizeFormatOptions } = require('../utils/formatOptions');

// Tools that mutate the workbook. After any of these runs, the per-agent
// workbook-read cache must be invalidated so the next read sees fresh state.
const MUTATION_TOOLS = new Set([
  'set_cell_range',
  'bulk_set_cell_ranges',
  'execute_office_js',
  'execute_python',
  'create_sheet',
  'bulk_create_sheets',
  'rename_sheet',
  'delete_sheet',
  'duplicate_sheet',
  'copy_range',
  'create_named_range',
  'bulk_create_named_ranges',
  'execute_excel_formula',
  'set_format',
  'bulk_set_format',
  'format_workbook',
  'bulk_set_notes',
  'add_chart',
  'suspend_calculation',
  'resume_calculation'
]);

const AGENT_REASONING_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT_AGENT || 'high';
const AGENT_POSTWRITE_CRITIC = process.env.AGENT_POSTWRITE_CRITIC === 'true';
const AGENT_POSTWRITE_CRITIC_TIMEOUT_MS = Number(process.env.AGENT_POSTWRITE_CRITIC_TIMEOUT_MS) || 8000;
const AGENT_POSTWRITE_CRITIC_MIN_ACTIONS = Number(process.env.AGENT_POSTWRITE_CRITIC_MIN_ACTIONS) || 10;
const AGENT_AUTO_FORMAT_ON_DONE = process.env.AGENT_AUTO_FORMAT_ON_DONE === 'true';
const BULK_SET_FORMAT_MAX = Math.max(32, Number(process.env.AGENT_BULK_FORMAT_MAX) || 96);

// When a tool is disabled per-run (e.g. slice workers can't call execute_office_js),
// surface a redirection hint to the LLM so it picks the structured replacement
// instead of looping on "the tool isn't responding".
const TOOL_DISABLED_REDIRECTS = Object.freeze({
  execute_office_js: 'Use the structured tools: set_cell_range / bulk_set_cell_ranges for data + formulas, bulk_set_format for formatting, create_sheet / rename_sheet / delete_sheet for sheet ops, execute_excel_formula for one-off formulas. execute_office_js is gated off for slice workers because hand-written Office.js routinely throws on numberFormat dimension mismatches and rolls back fill/font writes silently.'
});
const POSTWRITE_CRITIC_TOOLS = new Set([
  'set_cell_range',
  'bulk_set_cell_ranges',
  'execute_office_js',
  'execute_excel_formula'
]);
// Agent-loop thinking defaults to OFF: the cost/quality benchmark (2026-05-29) showed
// flash no-thinking beat flash full-thinking on quality (72 vs 60), speed (183s vs 448s
// per scenario) and tokens (13.3M vs 20.1M). Re-enable per-knob via env if needed.
// (Architect/planner role thinking is separate — unchanged.)
const AGENT_THINKING_FIRST_ITER = process.env.AGENT_THINKING_FIRST_ITER === 'true';
const AGENT_THINKING_EVERY_ITER = process.env.AGENT_THINKING_EVERY_ITER === 'true';
const AGENT_THINKING_INTERVAL = Math.max(0, Number(process.env.AGENT_THINKING_INTERVAL) || 0);
const AGENT_FORCE_THINKING_AFTER_ERROR = process.env.AGENT_FORCE_THINKING_AFTER_ERROR === 'true';
const AGENT_USE_STREAMING = process.env.AGENT_USE_STREAMING !== 'false';
const AGENT_LOOP_FAST_MODEL = process.env.AGENT_LOOP_FAST_MODEL || process.env.DEEPSEEK_FALLBACK_MODEL || 'deepseek-v4-flash';
const AGENT_LOOP_DEFAULT_MODEL = process.env.AGENT_LOOP_MODEL || process.env.DEEPSEEK_FALLBACK_MODEL || 'deepseek-v4-flash';
const STAGNATION_WATCH_TOOLS = new Set([
  'read_workbook',
  'read_sheet',
  'get_range_as_csv',
  'get_cell_ranges',
  'build_workbook_graph',
  'execute_office_js',
  'read_format_summary'
]);
const STAGNATION_MAX_REPEAT = Math.max(3, Number(process.env.AGENT_STAGNATION_MAX_REPEAT) || 4);
const STAGNATION_ALT_CYCLES = Math.max(2, Number(process.env.AGENT_STAGNATION_ALT_CYCLES) || 3);
const STAGNATION_MAX_TRAIL = Math.max(8, (STAGNATION_ALT_CYCLES * 2) + 2);
// Read-thrash: when the agent runs N consecutive read-only tool calls without
// any mutation in between, it's stuck in a "verify → re-verify → re-verify"
// loop. Triggered repeatedly after the formula_not_landing confusion that
// killed the LBO run on 2026-05-30: 8+ reads on the same area while convinced
// writes weren't taking effect. We treat any stretch of READS_WITHOUT_WRITE
// pure reads as terminal stagnation — bigger than the per-signature repeat
// limit because read params often differ slightly between iterations.
// Bumped from 5 → 8 (2026-05-30 fast-food run): slice workers got the new
// READ-BEFORE-YOU-WRITE directive plus had to inspect multiple upstream sheets
// (Assumptions, Revenue, Capex). opex_and_ebitda legitimately needed 5 reads
// just to sample Assumptions sections + the Revenue total row before writing,
// and was killed before its first write. 8 allows the inspection phase without
// re-allowing the LBO-style "verify → re-verify" loop we originally guarded.
const READS_WITHOUT_WRITE_LIMIT = Math.max(4, Number(process.env.AGENT_READS_WITHOUT_WRITE_LIMIT) || 8);
const READ_ONLY_TOOLS_FOR_STAGNATION = new Set([
  'read_workbook',
  'read_sheet',
  'get_range_as_csv',
  'get_cell_ranges',
  'build_workbook_graph',
  'read_format_summary'
]);

function resolveAgentLoopModel(modelOverride, promptVariant) {
  if (modelOverride) return modelOverride;
  if (promptVariant === 'fast') return AGENT_LOOP_FAST_MODEL;
  return AGENT_LOOP_DEFAULT_MODEL;
}

// Tools whose follow-up iteration almost never needs thinking — pure UI / read /
// scaffolding. Lets the loop skip the reasoning_effort=high cost for those.
const CHEAP_FOLLOWUP_TOOLS = new Set([
  'todo_write',
  'ask_user_question',
  'context_snip',
  'retrieve_snipped',
  'read_skill',
  'read_instructions',
  'list_named_ranges',
  'search_tools',
  'create_sheet',
  'bulk_create_sheets',
  'create_named_range',
  'bulk_create_named_ranges',
  'suspend_calculation',
  'resume_calculation'
]);

function shouldUseAgentThinking(iteration, state = {}) {
  if (AGENT_THINKING_EVERY_ITER) return true;
  if (state.forceThinkingNext) return true;
  // Skip thinking right after a "cheap" tool — the model just needs to pick
  // the next obvious step, not reason hard. Wins ~1-3s per iteration on those.
  if (state.lastToolName && CHEAP_FOLLOWUP_TOOLS.has(state.lastToolName)) return false;
  if (AGENT_THINKING_FIRST_ITER && iteration === 1) return true;
  if (AGENT_THINKING_INTERVAL > 0 && iteration % AGENT_THINKING_INTERVAL === 0) return true;
  if (AGENT_FORCE_THINKING_AFTER_ERROR && ((state.consecutiveErrors || 0) > 0 || (state.parseFailureStreak || 0) > 0)) {
    return true;
  }
  return false;
}

function normalizeOpenBBSymbolParams(params = {}) {
  if (!params || typeof params !== 'object') return params;
  if (params.symbol || !params.ticker) return params;
  const next = { ...params, symbol: params.ticker };
  delete next.ticker;
  return next;
}

/* ---------- Legacy style presets ----------
 * Kept for compatibility with older traces and persisted states. New plans
 * should prefer explicit, structure-aware bulk_set_format actions.
 */
const STYLE_PRESETS = Object.freeze({
  // --- structural ---
  header: {
    cellStyles: { bold: true, backgroundColor: '#1F4E78', fontColor: '#FFFFFF', fontSize: 14, horizontalAlignment: 'Left' }
  },
  subheader: {
    cellStyles: { bold: true, backgroundColor: '#E8EEF4', fontColor: '#0D1F2D' }
  },
  table_header: {
    cellStyles: { bold: true, backgroundColor: '#404040', fontColor: '#FFFFFF', fontSize: 10, horizontalAlignment: 'Center' }
  },
  section: {
    cellStyles: { bold: true, backgroundColor: '#D9E1F2', fontColor: '#000000', borderTopColor: '#000000' }
  },
  label: {
    cellStyles: { fontColor: '#333333', horizontalAlignment: 'Left' }
  },
  // --- inputs (blue font, light blue bg) ---
  input: {
    cellStyles: { fontColor: '#0000FF', backgroundColor: '#E6F2FF', numberFormat: '#,##0.00_);(#,##0.00);-_)' }
  },
  input_pct: {
    cellStyles: { fontColor: '#0000FF', backgroundColor: '#E6F2FF', numberFormat: '0.0%' }
  },
  input_int: {
    cellStyles: { fontColor: '#0000FF', backgroundColor: '#E6F2FF', numberFormat: '#,##0' }
  },
  input_eur: {
    cellStyles: { fontColor: '#0000FF', backgroundColor: '#E6F2FF', numberFormat: '#,##0.0" €"' }
  },
  input_usd: {
    cellStyles: { fontColor: '#0000FF', backgroundColor: '#E6F2FF', numberFormat: '$#,##0.0' }
  },
  // --- formulas (black font, white bg) ---
  formula: {
    cellStyles: { fontColor: '#000000', backgroundColor: '#FFFFFF', numberFormat: '#,##0.00_);(#,##0.00);-_)' }
  },
  formula_pct: {
    cellStyles: { fontColor: '#000000', backgroundColor: '#FFFFFF', numberFormat: '0.0%' }
  },
  formula_int: {
    cellStyles: { fontColor: '#000000', backgroundColor: '#FFFFFF', numberFormat: '#,##0' }
  },
  formula_eur: {
    cellStyles: { fontColor: '#000000', backgroundColor: '#FFFFFF', numberFormat: '#,##0.0" €"' }
  },
  formula_usd: {
    cellStyles: { fontColor: '#000000', backgroundColor: '#FFFFFF', numberFormat: '$#,##0.0' }
  },
  // --- outputs (bold, light grey bg) ---
  output: {
    cellStyles: { bold: true, fontColor: '#000000', backgroundColor: '#F2F2F2', numberFormat: '#,##0.00_);(#,##0.00);-_)' }
  },
  output_pct: {
    cellStyles: { bold: true, fontColor: '#000000', backgroundColor: '#F2F2F2', numberFormat: '0.0%' }
  },
  output_eur: {
    cellStyles: { bold: true, fontColor: '#000000', backgroundColor: '#F2F2F2', numberFormat: '#,##0.0" €"' }
  },
  output_usd: {
    cellStyles: { bold: true, fontColor: '#000000', backgroundColor: '#F2F2F2', numberFormat: '$#,##0.0' }
  },
  output_multiple: {
    cellStyles: { bold: true, fontColor: '#000000', backgroundColor: '#F2F2F2', numberFormat: '0.0x' }
  },
  output_per_share: {
    cellStyles: { bold: true, fontColor: '#000000', backgroundColor: '#F2F2F2', numberFormat: '$#,##0.00' }
  },
  // --- totals ---
  total: {
    cellStyles: { bold: true, fontColor: '#000000', backgroundColor: '#F2F2F2', numberFormat: '#,##0_);(#,##0);-_)', borderTopColor: '#000000' }
  },
  subtotal: {
    cellStyles: { bold: true, fontColor: '#000000', backgroundColor: '#F9F9F9', numberFormat: '#,##0_);(#,##0);-_)' }
  },
  // --- links ---
  internal_link: {
    cellStyles: { fontColor: '#008000', backgroundColor: '#FFFFFF' }
  },
  external_link: {
    cellStyles: { fontColor: '#FF0000', backgroundColor: '#FFFFFF' }
  },
  // --- checks ---
  check_ok: {
    cellStyles: { fontColor: '#006100', backgroundColor: '#C6EFCE', italic: true }
  },
  check_warn: {
    cellStyles: { fontColor: '#9C6500', backgroundColor: '#FFEB9C', italic: true }
  },
  check_error: {
    cellStyles: { fontColor: '#9C0006', backgroundColor: '#FFC7CE', italic: true }
  },
  // --- scenarios ---
  scenario_base: {
    cellStyles: { fontColor: '#000000', backgroundColor: '#FFFFFF' }
  },
  scenario_upside: {
    cellStyles: { fontColor: '#006100', backgroundColor: '#C6EFCE' }
  },
  scenario_downside: {
    cellStyles: { fontColor: '#9C0006', backgroundColor: '#FFC7CE' }
  },
  // --- standalone formats (no semantic color) ---
  currency: {
    cellStyles: { numberFormat: '$#,##0.00_);($#,##0.00);-_)' }
  },
  percent: {
    cellStyles: { numberFormat: '0.0%' }
  },
  multiple: {
    cellStyles: { numberFormat: '0.0x' }
  },
  per_share: {
    cellStyles: { numberFormat: '$#,##0.00' }
  },
  date: {
    cellStyles: { numberFormat: 'mmm-yyyy' }
  },
  year: {
    cellStyles: { numberFormat: '0000', horizontalAlignment: 'Center', bold: true, backgroundColor: '#404040', fontColor: '#FFFFFF' }
  },
  assumption: {
    cellStyles: { fontColor: '#0000FF', backgroundColor: '#FFFF00', numberFormat: '#,##0.00_);(#,##0.00);-_)' }
  }
});

/** Merge a preset (if present) into a cell spec or format options object.
 *  Caller-provided styles win over the preset (preset = defaults). */
function expandStylePreset(spec) {
  if (!spec || typeof spec !== 'object') return spec;
  const presetName = spec.style_preset || spec.preset;
  if (!presetName) {
    if (spec.cellStyles && typeof spec.cellStyles === 'object') {
      const normalized = normalizeFormatOptions(spec.cellStyles);
      return { ...spec, cellStyles: normalized.options };
    }
    return spec;
  }
  const preset = STYLE_PRESETS[String(presetName).toLowerCase()];
  if (!preset) {
    if (spec.cellStyles && typeof spec.cellStyles === 'object') {
      const normalized = normalizeFormatOptions(spec.cellStyles);
      return { ...spec, cellStyles: normalized.options };
    }
    return spec;
  }
  const merged = { ...spec };
  delete merged.style_preset;
  delete merged.preset;
  merged.cellStyles = normalizeFormatOptions({ ...(preset.cellStyles || {}), ...(spec.cellStyles || {}) }).options;
  return merged;
}

/** Apply expandStylePreset across a `cells` map (A1 -> spec). */
function expandPresetsInCells(cells) {
  if (!cells || typeof cells !== 'object') return cells;
  const out = {};
  for (const [addr, spec] of Object.entries(cells)) {
    out[addr] = expandStylePreset(spec);
  }
  return out;
}

/* ---------- Anti-flood-fill guard ----------
 *
 * Rejects payloads where a single non-formula scalar (label / text) would be
 * replicated across many cells via a multi-cell range key or a wide copyToRange.
 * This catches the "MEAT CREW × 120 cells" bug where the LLM treats copyToRange
 * or range-keys as a way to paint a heading across a whole dashboard area.
 *
 * Returns { ok, reason } — { ok: true } means safe to proceed.
 *
 * Single-cell repeats (e.g. "A1:A1") and formulas (relative refs adjust on
 * copyFrom / reshape) are always allowed. Numbers are allowed too — the bug
 * is specific to text labels propagated as decoration.
 */
function rangeAddrCellCount(addr) {
  if (typeof addr !== 'string') return 1;
  const raw = addr.replace(/\$/g, '');
  const withoutSheet = raw.includes('!') ? raw.split('!').pop() : raw;
  const m = withoutSheet.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
  if (!m) return 1;
  const colNum = (s) => {
    let n = 0;
    for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
  };
  const c1 = colNum(m[1]);
  const r1 = Number(m[2]);
  const c2 = m[3] ? colNum(m[3]) : c1;
  const r2 = m[4] ? Number(m[4]) : r1;
  return (Math.abs(r2 - r1) + 1) * (Math.abs(c2 - c1) + 1);
}

const FLOOD_FILL_CELL_THRESHOLD = 20;

function isFormulaSpec(spec) {
  if (!spec || typeof spec !== 'object') return false;
  if (spec.formula != null) return true;
  if (typeof spec.value === 'string' && spec.value.startsWith('=')) return true;
  return false;
}

function isTextScalar(spec) {
  if (!spec || typeof spec !== 'object') return false;
  if (spec.formula != null) return false;
  const v = spec.value;
  if (v == null) return false;
  if (typeof v === 'number' || typeof v === 'boolean') return false;
  if (Array.isArray(v)) return false;
  if (typeof v === 'string' && v.startsWith('=')) return false;
  return typeof v === 'string';
}

function detectScalarTextFloodFill(cells, copyToRange) {
  if (!cells || typeof cells !== 'object') return { ok: true };

  for (const [addr, spec] of Object.entries(cells)) {
    if (!isTextScalar(spec)) continue;
    const n = rangeAddrCellCount(addr);
    if (n > FLOOD_FILL_CELL_THRESHOLD) {
      return {
        ok: false,
        reason: `set_cell_range rejected: cell key "${addr}" expands to ${n} cells but value is a single text label ("${String(spec.value).slice(0, 40)}"). Excel will paint that label across every cell, which is rarely what you want. If you need a header, write it to ONE cell (e.g. "${addr.split(':')[0]}"). If you need repetition, use a formula. If you need a merged title, use execute_office_js + range.merge().`
      };
    }
  }

  if (copyToRange) {
    const destCount = rangeAddrCellCount(copyToRange);
    if (destCount > 1) {
      // The source cell of copyToRange is the FIRST written cell (see
      // execSetCellRange in writers.js). If that source is a text scalar with
      // no formula, copyToRange will paint the label across the destination —
      // the staffing_and_labor "Total" / F3:J6 bug from the 2026-05-30 run.
      const entries = Object.entries(cells);
      if (entries.length > 0) {
        const [srcAddr, srcSpec] = entries[0];
        if (isTextScalar(srcSpec)) {
          return {
            ok: false,
            reason: `set_cell_range rejected: copyToRange "${copyToRange}" (${destCount} cells) uses "${srcAddr}" as the source, but that cell holds a text label ("${String(srcSpec.value).slice(0, 40)}"). Excel would paint the label across every destination cell. copyToRange is for FORMULAS with relative refs (e.g. "=B2*(1+C$1)"). To fill a section with computed values, put the formula in "${srcAddr}" first; for a repeated label, write it once and use a formula like "=$${srcAddr.replace(/(\\d+)/, '$$$1')}" in destinations.`
          };
        }
      }
    }
  }

  return { ok: true };
}

/** Expand for format-tool options: preset goes through cellStyles too. */
function expandPresetInOptions(options) {
  if (!options || typeof options !== 'object') return options;
  const presetName = options.style_preset || options.preset;
  if (!presetName) return normalizeFormatOptions(options).options;
  const preset = STYLE_PRESETS[String(presetName).toLowerCase()];
  if (!preset || !preset.cellStyles) return normalizeFormatOptions(options).options;
  // set_format options live at top level (backgroundColor, fontColor, etc.)
  // so merge the preset's cellStyles fields into them.
  const merged = { ...preset.cellStyles, ...options };
  delete merged.style_preset;
  delete merged.preset;
  return normalizeFormatOptions(merged).options;
}

/* ---------- Message ID helpers for context_snip targeting ---------- */
function generateMsgId() {
  return Math.random().toString(36).slice(2, 8).toLowerCase();
}
function makeUserMessage(content) {
  const id = generateMsgId();
  return { role: 'user', content: `[id:${id}] ${content}` };
}
function extractMsgId(content) {
  const m = String(content).match(/^\[id:([a-z0-9]{6})\]\s*/);
  return m ? m[1] : null;
}
function stripMsgId(content) {
  return String(content).replace(/^\[id:[a-z0-9]{6}\]\s*/, '');
}

/* ---------- Snipped content store (global, per-process) ---------- */
const snippedStore = new Map(); // key: "from_id:to_id" -> { summary, content, timestamp }
const MAX_SNIP_AGE_MS = 30 * 60 * 1000; // 30 min

function cleanupOldSnips() {
  const now = Date.now();
  for (const [key, entry] of snippedStore.entries()) {
    if (now - entry.timestamp > MAX_SNIP_AGE_MS) {
      snippedStore.delete(key);
    }
  }
}

function snipContext(messages, fromId, toId, summary) {
  const indices = [];
  let fromIdx = -1;
  let toIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const id = extractMsgId(messages[i].content);
    if (id === fromId) fromIdx = i;
    if (id === toId) toIdx = i;
  }
  if (fromIdx === -1 || toIdx === -1 || fromIdx > toIdx) {
    return { ok: false, error: `IDs not found or invalid range: ${fromId} -> ${toId}` };
  }
  const snippedContent = messages.slice(fromIdx, toIdx + 1)
    .map(m => `[${m.role}] ${stripMsgId(m.content || '')}`)
    .join('\n');
  const key = `${fromId}:${toId}`;
  snippedStore.set(key, { summary, content: snippedContent, timestamp: Date.now() });
  // Replace snipped range with placeholder
  const placeholder = makeUserMessage(`[snipped: ${summary}] (use retrieve_snipped to expand)`);
  const newMessages = [
    ...messages.slice(0, fromIdx),
    placeholder,
    ...messages.slice(toIdx + 1)
  ];
  messages.length = 0;
  messages.push(...newMessages);
  return { ok: true, removed: toIdx - fromIdx + 1, key };
}

function retrieveSnipped(fromId, search, maxChars = 4000) {
  cleanupOldSnips();
  const results = [];
  for (const [key, entry] of snippedStore.entries()) {
    if (fromId && !key.startsWith(fromId)) continue;
    if (!search || entry.content.toLowerCase().includes(search.toLowerCase()) || entry.summary.toLowerCase().includes(search.toLowerCase())) {
      results.push({ key, summary: entry.summary, content: entry.content.slice(0, maxChars) });
    }
  }
  if (results.length === 0) {
    return { found: false, message: `No snipped content found${search ? ` for "${search}"` : ''}` };
  }
  return { found: true, count: results.length, results };
}

/* ---------- Load System Prompt from file (variant-aware) ---------- */
const PROMPT_VARIANTS = {
  default: 'system-prompt-har.md',
  har: 'system-prompt-har.md',
  legacy: 'system-prompt-ib-grade.md',
  fast: 'system-prompt-ib-fast.md',
  analyst: 'system-prompt-analyst.md',
  copilot: 'system-prompt-copilot.md'
};
const PROMPT_CACHE = {};

function loadPromptVariant(variant) {
  if (PROMPT_CACHE[variant]) return PROMPT_CACHE[variant];
  const file = PROMPT_VARIANTS[variant] || PROMPT_VARIANTS.default;
  const filePath = path.join(__dirname, '..', '..', 'docs', file);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    logger.info(`[AgentLoop] Loaded prompt variant "${variant}" from ${filePath} (${content.length} chars)`);
    PROMPT_CACHE[variant] = content;
    return content;
  } catch (e) {
    logger.warn(`[AgentLoop] Could not load prompt "${variant}": ${e.message}. Falling back to inline.`);
    return `You are an expert analyst and spreadsheet builder embedded directly in Microsoft Excel.`;
  }
}

const { getAvailableSkillsForPrompt, readSkill } = require('../skills/loader');
const { updateInstructions, getInstructionsForPrompt } = require('../utils/instructions');

const DEFAULT_PROMPT_VARIANT = process.env.AGENT_PROMPT_VARIANT || 'default';
let AGENT_SYSTEM_PROMPT = loadPromptVariant(DEFAULT_PROMPT_VARIANT);

/* Common output format suffix appended to ANY variant.
 *
 * KEEP THIS SLIM. The HAR-based system prompt is self-contained and authoritative.
 * Suffix only carries deployment-specific operational reminders, NOT redundant
 * prescriptions (no "BATCH RULE", no "ATOMIC FORMAT", no "SPEED RULE" — those
 * are anti-patterns we learned from logs and the HAR analysis).
 */
const AGENT_SYSTEM_PROMPT_SUFFIX = `\n\n---\n\nDEPLOYMENT REMINDERS (this Excel add-in only):\n\n- **End with done.** When the task is complete, call \`done\` with a summary. Do NOT keep calling tools after the work is finished.\n- **Python is sandboxed.** \`execute_python\` is for math on data you pass in as variables. It does NOT have filesystem access — no openpyxl, no /tmp/*.xlsx paths. To read/write the workbook, use the Excel tools.\n- **Live data first.** For market/regulatory/news facts that could have changed, verify with finance tools or \`web_search\` before writing assumptions. Training memory is for stable methodology only.\n- **Skills.** \`<available_skills>\` lists loadable instructions. Before a complex build (DCF, LBO, comps, 3-statement, audit), call \`read_skill\` for the relevant one. Max 2 per task.\n- **Citation hint.** When referencing cells in chat, use the citation link format from the prompt: \`[A1:D1](<citation:Sheet!A1:D1>)\`.\n- **Industry add-ins.** If the user mentions Bloomberg/FactSet/CapIQ/Refinitiv, prefer the native formula syntax (BDP/BDH, FDS/FDSH, CIQ/CIQH, TR) per the Custom Function Integrations section of the prompt. On #VALUE! fallback, switch to web_search.\n- **Whole-workbook formatting.** First inspect the relevant sheets, then apply one explicit \`bulk_set_format\` pass based on the observed workbook structure. Use \`format_workbook\` only as an emergency cleanup helper when the user asks for broad generic cleanup; do not rely on hidden templates. Do NOT hand-write formatting via \`execute_office_js\` — \`range.format.fill.color\` writes are silently rolled back when a later \`numberFormat = [["x"]]\` 1x1 matrix throws on a multi-cell range during the same \`context.sync\`, leaving column widths visible but colors missing. If \`bulk_set_format\` returns "missing options", the entries used the wrong key — its options can also be passed as \`format\`, \`style\`, \`cellStyles\`, \`styles\`, or \`formatting\`; retry with one of those, do not switch tools.\n- **Cannot do.** VBA macros, file downloads, scheduled automations, =TABLE() data tables. Build sensitivity with direct per-cell formulas instead.`;

const ACTIVE_AGENT_SYSTEM_PROMPT_SUFFIX = AGENT_SYSTEM_PROMPT_SUFFIX;

AGENT_SYSTEM_PROMPT += ACTIVE_AGENT_SYSTEM_PROMPT_SUFFIX;

function getSystemPrompt(variant) {
  const v = variant || DEFAULT_PROMPT_VARIANT;
  const base = loadPromptVariant(v);
  // Return ONLY the frozen base + suffix — no dynamic skills/instructions attached.
  // Dynamic content (skills index, user instructions) goes into the first user message
  // to keep the system prompt immutable across iterations, enabling DeepSeek context caching.
  return base + ACTIVE_AGENT_SYSTEM_PROMPT_SUFFIX;
}

/* ---------- Tool Definitions (OpenAI function calling schema) ---------- */

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_workbook',
      description: 'Read the current Excel workbook structure and data. Returns the already-captured workbook context.',
      parameters: {
        type: 'object',
        properties: {
          maxRows: { type: 'number', description: 'Max rows to read per sheet' },
          maxCols: { type: 'number', description: 'Max cols to read per sheet' },
          includeFormulas: { type: 'boolean', description: 'Include formulas in each sheet preview (default true)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'build_workbook_graph',
      description: 'Build a semantic WorkbookGraph for the current workbook: sheet roles, detected tables, formulas, cross-sheet dependencies, Excel errors and financial objects. Use before audits, repairs, model completion and multi-sheet analysis.',
      parameters: {
        type: 'object',
        properties: {
          maxRows: { type: 'number', description: 'Max rows to scan per sheet' },
          maxCols: { type: 'number', description: 'Max cols to scan per sheet' },
          workbookName: { type: 'string', description: 'Optional workbook label' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_sheet',
      description: 'Read a specific Excel sheet',
      parameters: {
        type: 'object',
        properties: {
          sheet: { type: 'string', description: 'Sheet name' },
          maxRows: { type: 'number' },
          maxCols: { type: 'number' }
        },
        required: ['sheet']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_cell_ranges',
      description: 'Read specific cell ranges (values, formulas, formatting) across multiple sheets. Supports batch multi-range read in one call. Use this to read scattered data (e.g., headers and totals) efficiently.\n\nExample:\n{\n  "ranges": [\n    { "sheet": "SINTECO_S_R_L", "target": "A1:H1" },\n    { "sheet": "SINTECO_S_R_L", "target": "A1112:H1114" }\n  ]\n}',
      parameters: {
        type: 'object',
        properties: {
          ranges: {
            type: 'array',
            description: 'Array of range specs to read',
            items: {
              type: 'object',
              properties: {
                sheet: { type: 'string', description: 'Sheet name' },
                target: { type: 'string', description: 'Range in A1 notation (e.g. "A1:H100")' },
                maxRows: { type: 'number', description: 'Max rows per range (default 100)' }
              },
              required: ['sheet', 'target']
            }
          }
        },
        required: ['ranges']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_range_as_csv',
      description: 'Read a range as CSV string for pandas analysis. Preferred for large data. Set maxRows if you only need a preview (e.g. 100 for inspection). Omit maxRows to read ALL rows in the range.',
      parameters: {
        type: 'object',
        properties: {
          sheet: { type: 'string', description: 'Sheet name' },
          target: { type: 'string', description: 'Range (e.g. A1:D100)' },
          maxRows: { type: 'number', description: 'Max rows to return (omit to read ALL rows)' },
          includeHeaders: { type: 'boolean', description: 'Include header row' }
        },
        required: ['sheet', 'target']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_format_summary',
      description: `Read the VISUAL formatting of a range to VERIFY styling — font color, fill color, bold, number format, and cell notes. Plain reads (read_sheet/get_cell_ranges) return values/formulas only and CANNOT tell you whether colors or notes were applied. Returns only the non-default (styled) cells plus their notes, so it stays compact. Use after a formatting pass to confirm conventions (inputs colored, formulas plain, cross-sheet links green, headers bold/filled, assumptions carry notes) before calling done.\n\nExample: { "sheet": "Assumptions", "target": "A1:C20" }`,
      parameters: {
        type: 'object',
        properties: {
          sheet: { type: 'string', description: 'Sheet name' },
          target: { type: 'string', description: 'Range in A1 notation (e.g. "A1:C20"). Scope it to the block you are verifying.' },
          maxRows: { type: 'number', description: 'Max rows to inspect (default 50)' },
          maxCols: { type: 'number', description: 'Max cols to inspect (default 26)' }
        },
        required: ['sheet', 'target']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_sheet',
      description: 'Create a new Excel sheet. For multiple sheets in one go, prefer bulk_create_sheets (1 iteration vs N).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Sheet name' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'bulk_create_sheets',
      description: 'Create MANY sheets in one iteration. Pass the full list of sheet names. The client creates them all in a single batch. Use this at the start of any multi-sheet build (DCF, LBO, 3-statement, model scaffolding) instead of issuing N separate create_sheet calls — saves N-1 LLM round-trips.\n\nExample: { "names": ["Assumptions", "WACC", "DCF", "Sensitivity"] }',
      parameters: {
        type: 'object',
        required: ['names'],
        properties: {
          names: {
            type: 'array',
            minItems: 1,
            maxItems: 32,
            items: { type: 'string', description: 'Sheet name to create' }
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'bulk_create_named_ranges',
      description: 'Create MANY named ranges in one iteration. Pass an array of {name, refers_to} objects. Use this at setup of any model with multiple shared inputs (Revenue, WACC, TaxRate, etc.) instead of issuing N separate create_named_range calls.\n\nExample: { "ranges": [ { "name": "Revenue", "refers_to": "=Assumptions!B3" }, { "name": "TaxRate", "refers_to": "=Assumptions!B5" } ] }',
      parameters: {
        type: 'object',
        required: ['ranges'],
        properties: {
          ranges: {
            type: 'array',
            minItems: 1,
            maxItems: 32,
            items: {
              type: 'object',
              required: ['name', 'refers_to'],
              properties: {
                name: { type: 'string', description: 'Named range name (no spaces, no special chars)' },
                refers_to: { type: 'string', description: 'Cell reference (e.g. "=Assumptions!B3")' }
              }
            }
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rename_sheet',
      description: 'Rename an existing Excel sheet',
      parameters: {
        type: 'object',
        properties: {
          old_name: { type: 'string', description: 'Current sheet name' },
          new_name: { type: 'string', description: 'New sheet name' }
        },
        required: ['old_name', 'new_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_sheet',
      description: 'Delete an Excel sheet. WARNING: irreversible!',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Sheet name to delete' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'duplicate_sheet',
      description: 'Duplicate an existing sheet (exact copy)',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source sheet name to copy' },
          new_name: { type: 'string', description: 'Name for the new sheet (default: "Source (copy)")' }
        },
        required: ['source']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'copy_range',
      description: 'Copy a range from one sheet to another (formulas, values, formatting). Use for cross-sheet data movement.',
      parameters: {
        type: 'object',
        properties: {
          from_sheet: { type: 'string', description: 'Source sheet name' },
          from: { type: 'string', description: 'Source range in A1 notation (e.g. "A1:B10")' },
          to_sheet: { type: 'string', description: 'Destination sheet name' },
          to: { type: 'string', description: 'Destination range in A1 notation (e.g. "C5")' }
        },
        required: ['from_sheet', 'from', 'to_sheet', 'to']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_named_range',
      description: 'Create a named range/reference that can be used across ALL sheets in formulas. Ideal for shared inputs like "Revenue", "TaxRate", "Beta". Creates Excel defined names.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name for the reference (e.g. "Revenue", "WACC", "TaxRate")' },
          refers_to: { type: 'string', description: 'Cell reference (e.g. "=Assumptions!B3")' }
        },
        required: ['name', 'refers_to']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_named_ranges',
      description: 'List all named ranges in the workbook with their references',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_cell_range',
      description: `Write cells using a map of A1 addresses to {value, formula, note}. Supports copyToRange for pattern fill and allow_overwrite for overwrite protection. This is the PRIMARY write tool.\n\n**Workflow (preferred):** one logical section per call. Write values/formulas first, verify the returned formula_results, then run formatting in a final bulk_set_format pass. This is faster, more debuggable, and matches the institutional Excel patterns in the system prompt.\n\n**copyToRange** — set the pattern in the first row/col, then copyToRange fills the rest preserving relative/absolute refs. One call instead of N.\n\nExample (values + formulas, no inline formatting):\n{\n  "sheet": "DCF",\n  "cells": {\n    "A1": { "value": "Revenue Build" },\n    "A2": { "value": "Base revenue" },\n    "B2": { "value": 100 },\n    "B3": { "value": 0.05 },\n    "B4": { "formula": "=B2*(1+B3)" },\n    "B5": { "formula": "=SUM(B2:B4)" }\n  },\n  "copyToRange": "B4:F4",\n  "allow_overwrite": false\n}\n\n**Optional** cellStyles / borderStyles / style_preset per cell are still supported for back-compat. Use sparingly: a malformed inline format on a single cell can poison the whole batch with an opaque error. Prefer a separate bulk_set_format pass once data is verified.\n\n**❌ ANTI-PATTERN — DO NOT do this:**\n- \`{ "A1:F24": { "value": "MEAT CREW" } }\` — range key with a text scalar paints "MEAT CREW" into 144 cells. That's noise, not a dashboard.\n- \`{ "A1": { "value": "Title" } } + copyToRange: "A1:F24"\` — copyToRange with a text source replicates the label everywhere. copyToRange is for FORMULAS with relative refs.\n- These payloads are auto-rejected server-side.\n\n**✅ Correct alternatives:**\n- Header: write to ONE cell (\`"A1": { "value": "MEAT CREW — Dashboard" }\`) and merge with execute_office_js if you need it visually wide.\n- Repeated value: use a formula referencing one source cell (\`"=$A$1"\`) so updates flow from one place.\n- Filling a column with a pattern: write the formula in one cell + copyToRange with relative refs that adjust per row.`,
      // Schema sourced from server/tools/schemas.js (single source of truth, also used by registry.js)
      parameters: SHARED_SCHEMAS.SET_CELL_RANGE
    }
  },
  {
    type: 'function',
    function: {
      name: 'bulk_set_cell_ranges',
      description: `Write MANY independent ranges (same or different sheets) in ONE iteration. Each entry has the same shape as set_cell_range. Use when sections are tightly coupled (e.g., Assumptions feeding a Driver sheet) and you would otherwise need 2-3 sequential calls. Hard cap 32 entries.\n\n**When NOT to bulk:** if sections are independent and the user benefits from seeing them appear incrementally, prefer separate set_cell_range calls per section — visible progress beats a 1-call payload that completes in silence.\n\n**Formatting:** as with set_cell_range, prefer to write values/formulas here, then apply formatting in a separate bulk_set_format pass after the data is verified. style_preset/cellStyles per cell are accepted for back-compat but discouraged.\n\nExample (3 coupled sections, no inline formatting):\n{\n  "writes": [\n    { "sheet": "Assumptions", "cells": {\n        "A1": { "value": "Driver" }, "B1": { "value": "Value" },\n        "A2": { "value": "Revenue growth %" }, "B2": { "value": 0.08 }\n    } },\n    { "sheet": "Sources & Uses", "cells": {\n        "A1": { "value": "Sources" },\n        "A2": { "value": "Equity" }, "B2": { "value": 100 },\n        "A3": { "value": "Total Sources" }, "B3": { "formula": "=SUM(B2:B2)" }\n    } },\n    { "sheet": "Debt Schedule", "cells": {\n        "A1": { "value": "Year" }\n    }, "copyToRange": "A2:A6" }\n  ]\n}\n\nEach write may include copyToRange and allow_overwrite, identical to set_cell_range. Failures on individual writes do NOT abort the batch; they surface under "errors" in the result.`,
      parameters: {
        type: 'object',
        required: ['writes'],
        properties: {
          writes: {
            type: 'array',
            minItems: 1,
            maxItems: 32,
            items: {
              type: 'object',
              required: ['sheet', 'cells'],
              properties: {
                sheet: { type: 'string', description: 'Sheet name' },
                cells: { type: 'object', description: 'A1 address -> {value | formula, note?, cellStyles?, borderStyles?, style_preset?}. Prefer value/formula writes here and one explicit bulk_set_format pass after data is verified. style_preset remains accepted only for legacy compatibility.' },
                copyToRange: { type: 'string', description: 'Optional range to copy the pattern to (e.g. "B2:B100")' },
                allow_overwrite: { type: 'boolean', description: 'If false, fail when target cells are non-empty (default true)' }
              }
            }
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_format',
      description: 'Apply formatting to a cell range (colors, font, number format, alignment, widths/heights, borders). For MULTIPLE ranges in one shot, prefer bulk_set_format (1 iteration vs N).',
      parameters: {
        type: 'object',
        properties: {
          sheet: { type: 'string' },
          target: { type: 'string' },
          options: {
            type: 'object',
            properties: {
              backgroundColor: { type: 'string' },
              fontColor: { type: 'string' },
              bold: { type: 'boolean' },
              italic: { type: 'boolean' },
              fontSize: { type: 'number' },
              fontName: { type: 'string' },
              numberFormat: { type: 'string' },
              horizontalAlignment: { type: 'string' },
              verticalAlignment: { type: 'string' },
              wrapText: { type: 'boolean' },
              columnWidth: { type: 'number' },
              rowHeight: { type: 'number' },
              borderBottomColor: { type: 'string' },
              borderTopColor: { type: 'string' },
              borders: { type: 'object' },
              style_preset: { type: 'string', description: 'Legacy shortcut accepted for compatibility. Prefer explicit formatting options chosen from the workbook structure.' }
            }
          }
        },
        required: ['sheet', 'target', 'options']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'bulk_set_format',
      description: `Apply formatting to MANY ranges in ONE iteration. Each entry has the same shape as set_format. Use when finishing a multi-sheet model (headers, number formats, column widths, borders, etc.) instead of N consecutive set_format calls. Build the pass from the actual workbook structure you just wrote or inspected. Hard cap ${BULK_SET_FORMAT_MAX} entries per call.\n\nALWAYS use this for coloring/formatting; do NOT hand-write Office.js via execute_office_js — it bypasses normalization and frequently throws on numberFormat dimension mismatches, leaving column widths visible but colors silently rolled back.\n\nPER-ENTRY SHAPE: { sheet, target, options }. The options field is also accepted under any of these aliases: format, style, cellStyles, styles, formatting. Per-entry target also accepts: range, addr, address.\n\nExample:\n{\n  "formats": [\n    { "sheet": "Assumptions", "target": "A1:B1", "options": { "bold": true, "backgroundColor": "#0D1F2D", "fontColor": "#FFFFFF" } },\n    { "sheet": "DCF",         "target": "B2:F2",  "options": { "numberFormat": "#,##0" } },\n    { "sheet": "DCF",         "target": "A:A",     "options": { "columnWidth": 230 } }\n  ]\n}\n\nFailures on individual entries do NOT abort the batch.`,
      parameters: {
        type: 'object',
        required: ['formats'],
        properties: {
          formats: {
            type: 'array',
            minItems: 1,
            maxItems: BULK_SET_FORMAT_MAX,
            items: {
              type: 'object',
              required: ['sheet', 'target', 'options'],
              properties: {
                sheet: { type: 'string' },
                target: { type: 'string', description: 'Range in A1 notation (e.g. "A1:H10", "A:A", "5:5")' },
                options: {
                  type: 'object',
                  description: 'Same options object as set_format (backgroundColor, fontColor, bold, numberFormat, columnWidth, rowHeight, borders, etc.)'
                }
              }
            }
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'format_workbook',
      description: `Adaptive whole-workbook cleanup helper for MULTIPLE sheets in ONE call. Prefer explicit bulk_set_format when the workbook structure is known; use this only for broad generic cleanup where a semantic fallback is acceptable.\n\nDefaults to ALL sheets in the workbook when "sheets" is omitted. Pass a list to restrict to specific tabs.\n\nExamples:\n  { }                                          // format ALL sheets\n  { "sheets": ["Assumptions", "P&L", "DCF"] }  // format only these 3\n  { "mode": "institutional_finance" }          // explicit mode (default)`,
      parameters: {
        type: 'object',
        properties: {
          sheets: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of sheet names to format. Omit to format every sheet in the workbook.'
          },
          mode: {
            type: 'string',
            description: 'Format mode (default "institutional_finance").'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'bulk_set_notes',
      description: `Attach explanatory notes/comments to specific cells (assumption rationale, methodology, source/derivation). Notes apply as native Excel comments in an isolated phase that CANNOT corrupt or abort your data writes; if a comment can't be attached, it is recorded on an "Assumption_Notes" sheet instead so the rationale is never lost. Use this to annotate assumption INPUT cells and key outputs after writing them.\n\nExample:\n{\n  "notes": [\n    { "sheet": "Assumptions", "cell": "B3", "note": "WACC 9.2% = CAPM: rf 4.3% + beta 1.1 x ERP 4.5%" },\n    { "sheet": "Assumptions", "cell": "B4", "note": "Terminal growth 2.5% = long-run GDP proxy" }\n  ]\n}`,
      parameters: {
        type: 'object',
        required: ['notes'],
        properties: {
          notes: {
            type: 'array',
            minItems: 1,
            maxItems: 64,
            items: {
              type: 'object',
              required: ['cell', 'note'],
              properties: {
                sheet: { type: 'string', description: 'Sheet name (defaults to active sheet)' },
                cell: { type: 'string', description: 'A1 cell address, e.g. "B3"' },
                note: { type: 'string', description: 'Annotation text' }
              }
            }
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execute_excel_formula',
      description: 'Write an Excel formula to a cell for Excel engine evaluation (XIRR, XNPV, etc). Writes the formula, letting Excel compute the result.\n\nExample:\n{\n  "sheet": "Valuation",\n  "target": "B10",\n  "formula": "=XIRR(B2:B9,A2:A9,0.1)"\n}',
      parameters: {
        type: 'object',
        properties: {
          sheet: { type: 'string', description: 'Sheet name' },
          target: { type: 'string', description: 'Cell address in A1 notation (e.g. "B10")' },
          formula: { type: 'string', description: 'Excel formula with = prefix (e.g. "=SUM(A1:A10)")' },
          note: { type: 'string', description: 'Optional cell comment' }
        },
        required: ['sheet', 'target', 'formula']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_chart',
      description: 'Add a native Excel chart',
      parameters: {
        type: 'object',
        properties: {
          sheet: { type: 'string' },
          target: { type: 'string', description: 'Data range for the chart' },
          options: {
            type: 'object',
            properties: {
              chartType: { type: 'string', enum: ['ColumnClustered', 'Line', 'Pie', 'Scatter', 'BarClustered'] },
              title: { type: 'string' }
            }
          }
        },
        required: ['sheet', 'target', 'options']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execute_python',
      description: 'Execute Python code for complex calculations. Return result as string or JSON.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Python code to execute' }
        },
        required: ['code']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_user_question',
      description: `Ask the user a question with tappable options. Use for clarifications, plan approval, or mid-task check-ins.\n\nExample:\n{\n  "questions": [\n    {\n      "header": "Proceed?",\n      "question": "Should I proceed with the DCF build?",\n      "options": [\n        { "label": "Yes", "description": "Build the DCF" },\n        { "label": "No", "description": "Cancel" }\n      ]\n    }\n  ]\n}`,
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              required: ['question', 'options'],
              properties: {
                header: { type: 'string', description: 'Short heading shown above the question' },
                question: { type: 'string', description: 'The question text' },
                options: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 4,
                  items: {
                    type: 'object',
                    required: ['label', 'description'],
                    properties: {
                      label: { type: 'string', description: 'Tappable button label (short)' },
                      description: { type: 'string', description: 'One-line context shown under label' }
                    }
                  }
                },
                multiSelect: { type: 'boolean' }
              }
            }
          }
        },
        required: ['questions']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: `Update the task list shown to the user as a "Steps" panel. Wholesale replacement — pass the entire list every time.\n\nRULES:\n- Only ONE task in_progress at a time. Move to in_progress BEFORE starting work, completed IMMEDIATELY after.\n- Never mark completed if it failed or only partially done.\n- When all tasks completed, the panel auto-clears.\n- Skip for single-step or trivial tasks.\n\nFIELDS:\n- content: short imperative phrase (<10 words), e.g. "Build revenue projections"\n- activeForm: present-continuous shown as spinner text while in_progress, e.g. "Building revenue projections"\n- status: pending → in_progress → completed (or cancelled)\n\nExample:\n{\n  "todos": [\n    { "content": "Set up assumptions", "activeForm": "Setting up assumptions", "status": "completed" },\n    { "content": "Build revenue projections", "activeForm": "Building revenue projections", "status": "in_progress" }\n  ]\n}`,
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'Short imperative phrase (<10 words)' },
                activeForm: { type: 'string', description: 'Present-continuous form shown while in_progress' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
                priority: { type: 'string', enum: ['high', 'medium', 'low'] }
              },
              required: ['content', 'status']
            }
          }
        },
        required: ['todos']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execute_office_js',
      description: `Execute arbitrary Office.js JavaScript code on the Excel client. Use for complex formatting, sheet operations, charts, pivot tables, conditional formatting, data validation — anything not covered by structured tools.

PREFERRED over execute_python for ALL Excel-specific operations.

KEY PATTERNS:

1. BULK FORMULA WRITES (suspend calculation):
\`\`\`javascript
context.application.load("calculationMode");
await context.sync();
const savedMode = context.application.calculationMode;
context.application.calculationMode = Excel.CalculationMode.manual;
await context.sync();
try {
  // ... write all formulas ...
} finally {
  context.application.calculationMode = savedMode;
  await context.sync();
}
\`\`\`

2. FILL FORMULAS (autoFill):
\`\`\`javascript
sheet.getRange("C2").formulas = [["=A2+B2"]];
sheet.getRange("C2").autoFill("C2:C100", Excel.AutoFillType.fillDefault);
await context.sync();
\`\`\`

3. MERGE CELLS + FORMAT TITLE:
\`\`\`javascript
sheet.getRange("A1:H1").merge(false);
sheet.getRange("A1").format.fill.color = "#0D1F2D";
sheet.getRange("A1").format.font.color = "#FFFFFF";
sheet.getRange("A1").format.font.bold = true;
\`\`\`

4. COLUMN WIDTHS / FREEZE:
\`\`\`javascript
sheet.getRange("A:A").format.columnWidth = 230;
sheet.getRange("B:B").format.columnWidth = 85;
sheet.freezePanes.freezeAt("B2");
\`\`\`

5. BORDERS / ROW HEIGHTS / NUMBER FORMATS:
For number formats, PREFER set_format / bulk_set_format (they size the format matrix to the range for you). If you must set numberFormat in raw Office.js, the array MUST match the range dimensions exactly — a 1x1 [["0.0%"]] on a multi-cell range THROWS. For A10:D10 (1 row x 4 cols) you need 4 entries:
\`\`\`javascript
const r = sheet.getRange("A10:D10");
r.format.borders.getItem("EdgeBottom").style = "Continuous";
r.format.borders.getItem("EdgeBottom").color = "#B0C8D5";
r.format.rowHeight = 22;
r.numberFormat = [["0.0%", "0.0%", "0.0%", "0.0%"]];\`\`\`

6. CLEAR CELLS:
\`\`\`javascript
sheet.getRange("C2:C3").clear(Excel.ClearApplyTo.contents);
\`\`\`

7. VERIFY FORMULAS AFTER WRITE:
\`\`\`javascript
const check = sheet.getRange("B10:B20");
check.load(["values", "formulas"]);
await context.sync();
const errors = check.values.flat().filter(v => typeof v === "string" && v.startsWith("#"));
\`\`\`

IMPORTANT: DO NOT wrap in Excel.run yourself — it's already wrapped. Use 'context' parameter. Always load() before read, sync() before use. Return JSON-serializable results.

RETURN VALUE: The value you return from the script is delivered back to you as the tool result (under "value"), together with any console.log lines (under "logs"). Use return statements to bring data back into the loop instead of issuing a separate read_range right after. This avoids redundant round-trips.`,
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Office.js JavaScript code. Receives "context" param (Excel.RequestContext). DO NOT wrap in Excel.run(). Return JSON-serializable data to get it back in the tool result.' }
        },
        required: ['code']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'context_snip',
      description: 'Compress a range of previous messages to save context window. Provide from_id and to_id (message IDs like "abc123" from [id:abc123] tags) and a 1-sentence summary. The compressed content is stored and can be retrieved later with retrieve_snipped.',
      parameters: {
        type: 'object',
        properties: {
          from_id: { type: 'string', description: 'Start message ID (e.g. "abc123")' },
          to_id: { type: 'string', description: 'End message ID (e.g. "def456")' },
          summary: { type: 'string', description: 'One-sentence summary of what was snipped' }
        },
        required: ['from_id', 'to_id', 'summary']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'retrieve_snipped',
      description: 'Retrieve previously compressed message content by searching for a term. Use when you need details that were snipped earlier.',
      parameters: {
        type: 'object',
        properties: {
          from_id: { type: 'string', description: 'Optional: start message ID to narrow search' },
          search: { type: 'string', description: 'Keyword to search in snipped content' },
          max_chars: { type: 'number', description: 'Max characters to return (default 4000)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_instructions',
      description: 'Update persistent user preferences. Use for broad style changes ("use Oxford commas", "bold titles", "Italian language"). NOT for task-specific changes. Supports find/replace or append.',
      parameters: {
        type: 'object',
        properties: {
          find: { type: 'string', description: 'Text to find for replacement' },
          replace: { type: 'string', description: 'Replacement text' },
          append: { type: 'string', description: 'Text to append at end of instructions' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_instructions',
      description: 'Read the current persistent user preferences (style, formatting, language, defaults).',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_skill',
      description: 'Load a skill document on-demand before starting a complex task. Use for DCF, LBO, WACC, comps, 3-statement, audit, or data cleaning. Returns structured instructions and formulas.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name: dcf-model, wacc-model, lbo-model, comps-analysis, three-statement, clean-data, audit-xls' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: 'Signal that the task is complete',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Summary of what was accomplished' }
        }
      }
    }
  },
  /* ---------- OpenBB Financial Data Tools ---------- */
  {
    type: 'function',
    function: {
      name: 'openbb_equity_profile',
      description: 'Company profile: description, sector, market cap, employees, beta, dividend yield. Provider: yfinance (free)',
      parameters: {
        type: 'object', required: ['symbol'],
        properties: { symbol: { type: 'string', description: 'Ticker symbol (e.g. AAPL)' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'openbb_equity_metrics',
      description: 'Key financial metrics: PE ratio, forward PE, PEG, EV/EBITDA, ROE, ROA, margins, growth rates, debt/equity. Provider: yfinance (free)',
      parameters: {
        type: 'object', required: ['symbol'],
        properties: { symbol: { type: 'string' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'openbb_equity_balance',
      description: 'Balance sheet: cash, receivables, inventory, total assets, total debt, shareholders equity. Period: annual|quarter. Provider: yfinance (free)',
      parameters: {
        type: 'object', required: ['symbol'],
        properties: {
          symbol: { type: 'string' },
          period: { type: 'string', enum: ['annual', 'quarter'] }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'openbb_equity_income',
      description: 'Income statement: revenue, COGS, gross profit, EBITDA, EBIT, net income, EPS. Period: annual|quarter. Provider: yfinance (free)',
      parameters: {
        type: 'object', required: ['symbol'],
        properties: {
          symbol: { type: 'string' },
          period: { type: 'string', enum: ['annual', 'quarter'] }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'openbb_equity_cashflow',
      description: 'Cash flow statement: operating/investing/financing cash flows, free cash flow, CapEx. Provider: yfinance (free)',
      parameters: {
        type: 'object', required: ['symbol'],
        properties: {
          symbol: { type: 'string' },
          period: { type: 'string', enum: ['annual', 'quarter'] }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'openbb_treasury_rates',
      description: 'Current US Treasury rates for all maturities (1mo-30y). Use for risk-free rate in DCF/WACC. Provider: federal_reserve (free)',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'openbb_fed_rate',
      description: 'Effective Federal Funds Rate (Fed policy rate). Provider: federal_reserve (free)',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'openbb_cpi',
      description: 'Consumer Price Index (inflation) by country. Country: united_states, italy, etc. Provider: oecd (free). ALWAYS use this instead of guessing inflation.',
      parameters: {
        type: 'object',
        properties: { country: { type: 'string', description: 'Country name (e.g. united_states, italy)' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'openbb_gdp',
      description: 'Real GDP growth by country. Provider: oecd (free)',
      parameters: {
        type: 'object',
        properties: { country: { type: 'string' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'openbb_unemployment',
      description: 'Unemployment rate by country. Provider: oecd (free)',
      parameters: {
        type: 'object',
        properties: { country: { type: 'string' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finance_company_bundle',
      description: 'Fetch profile + metrics + balance + income + cashflow for one ticker IN PARALLEL and return them as a single merged object. Use this at the start of any company analysis instead of issuing five separate openbb_equity_* calls — saves ~4 LLM turns. Returns { symbol, period, profile, metrics, balance, income, cashflow, errors }. Datasets that fail are surfaced under errors but the rest is still returned.',
      parameters: {
        type: 'object',
        required: ['symbol'],
        properties: {
          symbol: { type: 'string', description: 'Ticker symbol (e.g. AAPL)' },
          period: { type: 'string', enum: ['annual', 'quarter'], description: 'Period for income/balance/cashflow (default annual)' },
          include: {
            type: 'array',
            description: 'Subset of datasets to fetch (default = all five). Items: profile|metrics|balance|income|cashflow',
            items: { type: 'string', enum: ['profile', 'metrics', 'balance', 'income', 'cashflow'] }
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'macro_snapshot',
      description: 'Fetch treasury rates + fed funds rate + CPI + GDP + unemployment IN PARALLEL for WACC / risk-free / inflation inputs. Returns { country, treasury, fed_rate, cpi, gdp, unemployment, errors }. Replaces ~4 sequential openbb_* macro calls.',
      parameters: {
        type: 'object',
        properties: {
          country: { type: 'string', description: 'Country for CPI/GDP/unemployment (default united_states)' },
          include: {
            type: 'array',
            description: 'Subset of macro series to fetch (default = all). Items: treasury|fed_rate|cpi|gdp|unemployment',
            items: { type: 'string', enum: ['treasury', 'fed_rate', 'cpi', 'gdp', 'unemployment'] }
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'suspend_calculation',
      description: 'Suspend Excel automatic calculation (switch to manual) before large bulk writes to prevent UI freeze and crashes. Always pair with resume_calculation.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'resume_calculation',
      description: 'Resume Excel automatic calculation after bulk operations are complete. Call this after suspend_calculation.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_tools',
      description: 'Search available tools by keyword or description. Use this when you are unsure which tool to use for a task, or to discover the correct tool name and its parameters. Returns the most relevant tools with descriptions and parameter schemas.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you want to do, e.g. "calculate WACC" or "download stock prices"' },
          top_k: { type: 'number', description: 'Max results to return (default 5)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'parallel_calls',
      description: `Execute MULTIPLE independent read-only tools in PARALLEL in a single iteration. Use this when you need several pieces of data that do NOT depend on each other (e.g. read three unrelated ranges, fetch profile + macro + named ranges at once). Cuts N independent LLM round-trips down to 1.

ONLY read / idempotent tools are allowed inside the batch. Mutations (set_cell_range, execute_office_js, execute_python, create_sheet, etc.), control flow (done, ask_user_question, todo_write), and context tools (context_snip) MUST run sequentially and are rejected here. Max 8 calls per batch.

Returns { results: [{ tool, ok, value | error }, ...] } where index matches the input order.

Example:
{
  "calls": [
    { "tool": "get_cell_ranges", "params": { "ranges": [{ "sheet": "DCF", "target": "A1:H10" }] } },
    { "tool": "openbb_treasury_rates", "params": {} },
    { "tool": "openbb_equity_profile", "params": { "symbol": "AAPL" } }
  ]
}`,
      parameters: {
        type: 'object',
        required: ['calls'],
        properties: {
          calls: {
            type: 'array',
            minItems: 2,
            maxItems: 8,
            items: {
              type: 'object',
              required: ['tool', 'params'],
              properties: {
                tool: { type: 'string', description: 'Name of an allowed read-only tool' },
                params: { type: 'object', description: 'Parameters for that tool' }
              }
            }
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_setting',
      description: 'Suggest a setting change to the user via an inline widget. Use this when you notice a mismatch between user intent and current settings (e.g., wrong currency, wrong date format, wrong decimal places). The user can accept or dismiss the suggestion.',
      parameters: {
        type: 'object',
        properties: {
          setting: { type: 'string', description: 'Setting key, e.g. "currency", "date_format", "decimal_places", "language"' },
          current_value: { type: 'string', description: 'Current value of the setting' },
          suggested_value: { type: 'string', description: 'Suggested new value' },
          reason: { type: 'string', description: 'Why this change is recommended' }
        },
        required: ['setting', 'current_value', 'suggested_value', 'reason']
      }
    }
  }
];

/* ---------- BM25 tool index ---------- */
initializeTools(TOOL_DEFINITIONS);

/* ---------- Context helpers ---------- */

function truncateMatrix(value, maxRows, maxCols) {
  if (!Array.isArray(value)) return value;
  return value.slice(0, maxRows).map(row =>
    Array.isArray(row) ? row.slice(0, maxCols) : row
  );
}

// Recursively trim very long arrays while preserving shape so the LLM can
// still reason about structure (head + tail with explicit "truncated" marker).
function trimDeepArrays(value, opts) {
  const maxItems = opts && opts.maxItems > 0 ? opts.maxItems : 12;
  const maxDepth = opts && opts.maxDepth > 0 ? opts.maxDepth : 8;
  function walk(v, depth) {
    if (depth > maxDepth) return v;
    if (Array.isArray(v)) {
      if (v.length <= maxItems) return v.map(item => walk(item, depth + 1));
      const headCount = Math.max(1, Math.floor(maxItems * 0.75));
      const tailCount = Math.max(1, maxItems - headCount - 1);
      const head = v.slice(0, headCount).map(item => walk(item, depth + 1));
      const tail = v.slice(v.length - tailCount).map(item => walk(item, depth + 1));
      const marker = { _truncated: true, _droppedItems: v.length - headCount - tailCount, _originalLength: v.length };
      return [...head, marker, ...tail];
    }
    if (v && typeof v === 'object') {
      const out = Array.isArray(v) ? [] : {};
      for (const k of Object.keys(v)) {
        out[k] = walk(v[k], depth + 1);
      }
      return out;
    }
    return v;
  }
  return walk(value, 0);
}

// Format a tool result for injection into the agent message history with a hard size cap.
// Strategy:
//   1) Honor _message override if the tool provides one.
//   2) If the compact JSON fits, use indented JSON (readable).
//   3) If too large, recursively trim long arrays and try again.
//   4) Last resort: hard truncate the compact JSON with an explicit marker.
function formatToolResultForMessages(toolResult, toolName, opts = {}) {
  if (toolResult && toolResult._message) {
    const msg = String(toolResult._message);
    const cap = Number(opts.maxChars) || Number(process.env.AGENT_TOOL_RESULT_MAX_CHARS) || 12000;
    return msg.length > cap ? msg.slice(0, cap) + `\n...[truncated ${msg.length - cap} chars]` : msg;
  }
  const cap = Number(opts.maxChars) || Number(process.env.AGENT_TOOL_RESULT_MAX_CHARS) || 12000;
  let compact;
  try { compact = JSON.stringify(toolResult); } catch (_) { compact = String(toolResult); }
  if (compact == null) compact = 'null';
  if (compact.length <= cap) {
    try {
      return `Tool result for ${toolName}:\n${JSON.stringify(toolResult, null, 2)}`;
    } catch (_) {
      return `Tool result for ${toolName}:\n${compact}`;
    }
  }
  // Try array trimming
  try {
    const trimmed = trimDeepArrays(toolResult, { maxItems: 10 });
    const trimmedJson = JSON.stringify(trimmed, null, 2);
    if (trimmedJson.length <= cap) {
      return `Tool result for ${toolName} (long arrays truncated; head + tail kept):\n${trimmedJson}`;
    }
    // Aggressive trim
    const aggressive = trimDeepArrays(toolResult, { maxItems: 5, maxDepth: 6 });
    const aggressiveJson = JSON.stringify(aggressive, null, 2);
    if (aggressiveJson.length <= cap) {
      return `Tool result for ${toolName} (arrays aggressively truncated):\n${aggressiveJson}`;
    }
  } catch (_) { /* fall through to hard cap */ }
  // Hard cap on compact form
  return `Tool result for ${toolName} [HARD-TRUNCATED ${compact.length} -> ${cap} chars; the original was too large to fit the agent context]:\n${compact.slice(0, cap)}\n...[truncated]`;
}

function compactAgentContext(context) {
  if (!context || typeof context !== 'object') return {};
  const out = {
    activeSheet: context.activeSheet,
    workbookSheets: Array.isArray(context.workbookSheets) ? context.workbookSheets.slice(0, 24) : [],
    sheetCount: context.sheetCount || (Array.isArray(context.workbookSheets) ? context.workbookSheets.length : 0),
    selectedRange: context.selectedRange,
    selectionSize: context.selectionSize,
    selectedPreview: truncateMatrix(context.selectedValues, 12, 8),
    selectedFormulasPreview: truncateMatrix(context.selectedFormulas, 12, 8),
    sheets: {}
  };
  const all = context.allSheetsData || {};
  for (const [name, info] of Object.entries(all)) {
    if (!info) continue;
    const isActive = info.isActive || name === context.activeSheet;
    out.sheets[name] = {
      isActive: !!isActive,
      usedRange: info.usedRange || null,
      rowCount: info.rowCount || 0,
      columnCount: info.columnCount || 0,
      truncated: !!info.truncated,
      empty: !!info.empty,
      omitted: !!info.omitted,
      preview: truncateMatrix(info.preview, isActive ? 30 : 10, isActive ? 14 : 8),
      formulas: isActive ? truncateMatrix(info.formulas, 30, 14) : undefined
    };
  }
  return out;
}

function buildWorkbookOverview(context) {
  if (!context || typeof context !== 'object') return 'Workbook overview: (no context)';
  const lines = [];
  lines.push(`Workbook overview — active sheet: "${context.activeSheet || '?'}", total sheets: ${context.sheetCount || (context.workbookSheets || []).length}`);
  const all = context.allSheetsData || {};
  for (const [name, info] of Object.entries(all)) {
    if (!info) continue;
    const tag = info.isActive || name === context.activeSheet ? ' [ACTIVE]' : '';
    if (info.empty) {
      lines.push(`  • "${name}"${tag}: empty`);
    } else if (info.omitted) {
      lines.push(`  • "${name}"${tag}: ${info.usedRange || '?'} (${info.rowCount}×${info.columnCount}) — preview omitted (sheet limit)`);
    } else {
      lines.push(`  • "${name}"${tag}: ${info.usedRange || '?'} (${info.rowCount}×${info.columnCount})${info.truncated ? ' [truncated]' : ''}`);
    }
  }
  if (lines.length === 1 && Array.isArray(context.workbookSheets)) {
    lines.push('  ' + context.workbookSheets.join(', '));
  }
  return lines.join('\n');
}

/* ---------- Auto-answer trivial questions to protect flow ---------- */

function normalizeQuestion(q) {
  if (typeof q === 'string') return { text: q, options: [] };
  if (!q || typeof q !== 'object') return { text: '', options: [] };
  const text = String(q.header || q.question || q.text || q.prompt || q.title || '');
  const opts = Array.isArray(q.options) ? q.options : [];
  return { text: text.toLowerCase(), options: opts };
}

function tryAutoAnswer(questionData, context, objective) {
  if (!Array.isArray(questionData)) questionData = [questionData];
  const answers = [];
  let autoAnsweredCount = 0;

  for (const rawQ of questionData) {
    const q = normalizeQuestion(rawQ);
    const text = q.text;
    let answer = null;

    // 1. Generic confirmations / proceed questions → always Yes
    const confirmationPatterns = [
      /should i proceed/, /shall i proceed/, /do you want me to proceed/, /want me to continue/,
      /should i continue/, /go ahead/, /proceed\?/, /continue\?/, /ok to proceed/,
      /vuoi che proceda/, /procedo\?/, /devo procedere/, /continuo\?/, /vado avanti/
    ];
    if (confirmationPatterns.some(p => p.test(text))) {
      answer = 'Yes';
    }

    // 2. Which sheet → default to active sheet
    if (!answer && /(which|what) sheet/.test(text)) {
      answer = context?.activeSheet || 'Active sheet';
    }
    if (!answer && /(quale|in quale) foglio/.test(text)) {
      answer = context?.activeSheet || 'Foglio attivo';
    }

    // 3. Ticker / company name already in objective
    if (!answer && /(ticker|symbol|company name|nome dell.azienda|titolo)/.test(text)) {
      const knownTickers = ['AAPL','MSFT','GOOGL','GOOG','TSLA','AMZN','META','NVDA','NFLX','JPM','V','WMT','DIS','BA','GE','IBM','INTC','AMD','CRM','UBER'];
      const objUpper = String(objective || '').toUpperCase();
      const matched = knownTickers.find(t => objUpper.includes(t));
      if (matched) answer = matched;
    }

    // 4. "What is the revenue / EBITDA / etc." when data is in context
    if (!answer && /(what is|what are|qual è|quali sono)/.test(text)) {
      const hasWorkbookData = context && (
        context.selectedValues?.length > 0 ||
        context.usedRangeData?.length > 0 ||
        Object.keys(context.allSheetsData || {}).length > 0
      );
      if (hasWorkbookData) {
        answer = 'Use the data already present in the workbook';
      }
    }

    // 5. Empty / malformed questions
    if (!answer && text.trim().length === 0) {
      answer = 'Please proceed with the available information.';
    }

    if (answer) {
      answers.push(answer);
      autoAnsweredCount++;
    } else {
      // Cannot auto-answer this one → abort whole auto-answer and let UI handle it
      return null;
    }
  }

  if (autoAnsweredCount === 0) return null;
  return answers.length === 1 ? answers[0] : answers.join(' | ');
}

function normalizeQuestionResponsePayload(response) {
  if (response == null) return { answers: [] };
  if (response.values && typeof response.values === 'object') return response.values;
  if (Array.isArray(response.answers)) return { answers: response.answers };
  if (typeof response.answers === 'string') return { answers: [response.answers] };
  if (typeof response === 'string') return { answers: [response] };
  return response;
}

function normalizeStagnationValue(value, depth = 0) {
  if (value == null) return value;
  if (depth >= 4) return '[depth-limit]';
  if (typeof value === 'string') {
    return value.length > 160 ? `${value.slice(0, 160)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 8).map(item => normalizeStagnationValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = normalizeStagnationValue(value[key], depth + 1);
      return acc;
    }, {});
  }
  return String(value);
}

function buildToolStagnationSignature(toolName, params = {}) {
  return `${toolName}:${JSON.stringify(normalizeStagnationValue(params))}`;
}

// Best-effort sheet name pulled from a tool-call params object, used by the
// read-thrash detector to distinguish "5 reads on the same sheet" (real loop)
// from "5 reads each on a different sheet" (legitimate multi-sheet exploration).
function extractSheetHint(params) {
  if (!params || typeof params !== 'object') return null;
  if (typeof params.sheet === 'string' && params.sheet) return params.sheet;
  if (typeof params.sheetName === 'string' && params.sheetName) return params.sheetName;
  if (typeof params.target === 'string' && params.target.includes('!')) {
    return params.target.split('!')[0].replace(/'/g, '');
  }
  if (Array.isArray(params.ranges)) {
    const first = params.ranges.find(r => typeof r === 'string' && r.includes('!'));
    if (first) return first.split('!')[0].replace(/'/g, '');
  }
  if (Array.isArray(params.calls)) {
    const sheets = params.calls.map(c => c && extractSheetHint(c.params || c)).filter(Boolean);
    if (sheets.length > 0) return sheets.join(','); // multi-sheet parallel batch
  }
  return null;
}

function detectToolStagnation(trail, maxRepeat = STAGNATION_MAX_REPEAT, altCycles = STAGNATION_ALT_CYCLES) {
  if (!Array.isArray(trail) || trail.length === 0) return null;
  const last = trail[trail.length - 1];
  if (!last || !STAGNATION_WATCH_TOOLS.has(last.toolName)) return null;

  // Read-thrash: last N reads with no write between them AND high overlap on
  // target sheet. "Different sheets each iteration" is legitimate multi-sheet
  // exploration (e.g. read 9 sheets to plan a formatting pass) — NOT thrash.
  // We only trip the guard when the agent keeps hammering the SAME area while
  // being confused that writes didn't land.
  if (trail.length >= READS_WITHOUT_WRITE_LIMIT) {
    const tail = trail.slice(-READS_WITHOUT_WRITE_LIMIT);
    if (tail.every(entry => READ_ONLY_TOOLS_FOR_STAGNATION.has(entry.toolName))) {
      // Count how many entries share the most common sheet hint. If the agent
      // is exploring distinct sheets, distinct hints will dominate and we
      // bail. Entries with no hint count toward the "unknown" bucket — if
      // ALL entries are unknown that's also fine (probably workbook-wide
      // reads like build_workbook_graph).
      const sheetCounts = new Map();
      for (const e of tail) {
        const key = e.sheetHint || '__unknown__';
        sheetCounts.set(key, (sheetCounts.get(key) || 0) + 1);
      }
      // Pick the most frequent NAMED sheet (ignore __unknown__).
      let topNamedSheet = null;
      let topNamedCount = 0;
      for (const [key, count] of sheetCounts) {
        if (key !== '__unknown__' && count > topNamedCount) {
          topNamedSheet = key;
          topNamedCount = count;
        }
      }
      const distinctNamedSheets = [...sheetCounts.keys()].filter(k => k !== '__unknown__').length;
      // Thrash only when a NAMED sheet captures ≥80% of the reads AND we have
      // ≤2 distinct named sheets. All-unknown trails get a separate guard: if
      // every signature is also identical we already catch that as `repeat`,
      // otherwise we let the agent explore.
      if (topNamedSheet && (topNamedCount / tail.length) >= 0.8 && distinctNamedSheets <= 2) {
        return {
          pattern: 'read_thrash',
          entries: tail
        };
      }
    }
  }

  if (trail.length >= maxRepeat) {
    const repeated = trail.slice(-maxRepeat);
    if (repeated.every(entry => entry.signature === last.signature)) {
      return {
        pattern: 'repeat',
        entries: repeated
      };
    }
  }

  const alternatingWindow = altCycles * 2;
  if (trail.length >= alternatingWindow) {
    const alternating = trail.slice(-alternatingWindow);
    const first = alternating[0];
    const second = alternating[1];
    if (
      first &&
      second &&
      first.signature !== second.signature &&
      STAGNATION_WATCH_TOOLS.has(first.toolName) &&
      STAGNATION_WATCH_TOOLS.has(second.toolName) &&
      alternating.every((entry, index) => (
        index % 2 === 0
          ? entry.signature === first.signature
          : entry.signature === second.signature
      ))
    ) {
      return {
        pattern: 'alternating',
        entries: alternating
      };
    }
  }

  return null;
}

function formatToolStagnationReason(stagnation) {
  if (!stagnation || !Array.isArray(stagnation.entries) || stagnation.entries.length === 0) {
    return 'stagnation_detected';
  }
  if (stagnation.pattern === 'repeat') {
    return `stagnation_repeat:${stagnation.entries[0].toolName}:x${stagnation.entries.length}`;
  }
  if (stagnation.pattern === 'alternating' && stagnation.entries.length >= 2) {
    const first = stagnation.entries[0].toolName;
    const second = stagnation.entries[1].toolName;
    return `stagnation_cycle:${first}->${second}:x${Math.floor(stagnation.entries.length / 2)}`;
  }
  if (stagnation.pattern === 'read_thrash') {
    const tools = stagnation.entries.map(e => e.toolName).join(',');
    return `stagnation_read_thrash:${stagnation.entries.length}_reads_no_write:[${tools}]`;
  }
  return `stagnation_${stagnation.pattern}`;
}

/* ---------- Post-write critic ---------- */

// Summarize emitted Excel actions into a compact string the critic LLM can scan.
// Strips noise (style objects, repeated keys); keeps formulas + values + sheet+target.
function summarizeActionsForCritic(actions) {
  const lines = [];
  for (let i = 0; i < actions.length && lines.length < 60; i++) {
    const a = actions[i] || {};
    if (a.type === 'setCellRange') {
      const sheet = a.sheet || '?';
      const cells = a.cells || {};
      const sample = Object.entries(cells).slice(0, 24).map(([addr, spec]) => {
        if (!spec || typeof spec !== 'object') return `${addr}=${JSON.stringify(spec).slice(0, 60)}`;
        if (spec.formula) {
          // Render with a space so a formula like "=SUM(A1:A5)" reads as
          // "C10 =SUM(A1:A5)" — NOT "C10==SUM(A1:A5)", which the critic
          // LLM kept misreading as a double-equals typo and flagging.
          const f = String(spec.formula).slice(0, 120);
          return `${addr} ${f}`;
        }
        if (spec.value !== undefined) return `${addr}:${JSON.stringify(spec.value).slice(0, 60)}`;
        return addr;
      });
      const extra = Object.keys(cells).length > 24 ? ` (+${Object.keys(cells).length - 24} more cells)` : '';
      lines.push(`[${i}] setCellRange ${sheet}: ${sample.join(' | ')}${extra}${a.copyToRange ? ` copyTo=${a.copyToRange}` : ''}`);
    } else if (a.type === 'runJavaScript') {
      const code = String(a.code || '').replace(/\s+/g, ' ').slice(0, 220);
      lines.push(`[${i}] runJavaScript: ${code}`);
    } else if (a.type === 'setCellFormat') {
      lines.push(`[${i}] setCellFormat ${a.sheet}!${a.target} opts=${JSON.stringify(a.options || {}).slice(0, 100)}`);
    } else {
      lines.push(`[${i}] ${a.type} ${JSON.stringify(a).slice(0, 140)}`);
    }
  }
  return lines.join('\n');
}

async function runPostWriteCritic(toolName, actions) {
  if (!Array.isArray(actions) || actions.length < AGENT_POSTWRITE_CRITIC_MIN_ACTIONS) return null;
  const summary = summarizeActionsForCritic(actions);
  if (!summary) return null;

  const prompt = `You are a fast strict critic for Excel agent writes. Scan the actions below for OBVIOUS errors only — do NOT speculate, do NOT make stylistic suggestions.

Flag ONLY:
- Unbalanced parentheses, missing leading "=" on formulas, obvious typos in function names
- Literal error markers in values/formulas: #VALUE!, #REF!, #NAME?, #DIV/0!, #NUM!, #N/A
- References to sheets that look wrong (e.g. "Sheet1!X1" when the action's sheet is "DCF" and the LBO context uses other names)
- Empty cells map / no-op writes
- Hard-coded magic numbers where a named-range / cross-sheet reference would be safer (low severity)

Respond with COMPACT JSON only, no markdown:
{ "ok": true } if nothing wrong.
Otherwise: { "ok": false, "issues": [ { "severity": "high"|"low", "message": "...", "suggestion": "..." } ] }

Tool: ${toolName}
Actions emitted (${actions.length}):
${summary}`;

  const start = Date.now();
  try {
    const llmResult = await callLLM({
      messages: [{ role: 'user', content: prompt }],
      modelOverride: AGENT_LOOP_FAST_MODEL,
      thinkingDisabled: true,
      reasoningEffort: 'low',
      timeoutMs: AGENT_POSTWRITE_CRITIC_TIMEOUT_MS,
      fallbackTimeoutMs: AGENT_POSTWRITE_CRITIC_TIMEOUT_MS,
      label: `PostWriteCritic ${toolName}`
    });
    const elapsed = Date.now() - start;
    if (!llmResult || typeof llmResult !== 'object') {
      logger.info(`[Critic] post-write returned no parsed result in ${elapsed}ms`);
      return null;
    }
    if (llmResult.ok === true || (Array.isArray(llmResult.issues) && llmResult.issues.length === 0)) {
      logger.info(`[Critic] post-write clean in ${elapsed}ms (${actions.length} actions)`);
      return null;
    }
    const issues = Array.isArray(llmResult.issues) ? llmResult.issues : [];
    logger.info(`[Critic] post-write found ${issues.length} issue(s) in ${elapsed}ms`);
    return { ok: false, issues };
  } catch (err) {
    logger.warn(`[Critic] post-write failed in ${Date.now() - start}ms: ${err.message}`);
    return null;
  }
}

/* ---------- Agent Loop ---------- */

async function runAgentLoop(objective, context, options = {}) {
  // No hard iteration cap by default. We trust:
  //   1) stagnation detection (detectToolStagnation) to break true infinite loops,
  //   2) maxConsecutiveErrors to break crash loops,
  //   3) per-call LLM timeouts to break frozen calls,
  //   4) outer turn timeouts on the caller side.
  // A user / scenario / env can still impose one via options.maxIterations
  // or AGENT_MAX_ITER. The very large default exists only as a paranoia
  // ceiling — under normal stagnation guards, runs end on their own.
  const explicitCap = options.maxIterations || Number(process.env.AGENT_MAX_ITER);
  const maxIterations = explicitCap && explicitCap > 0 ? explicitCap : 10000;
  const maxConsecutiveErrors = options.maxConsecutiveErrors || 4;
  const timeoutMs = options.timeoutMs || Number(process.env.AGENT_LLM_TIMEOUT_MS) || 300000;
  const fallbackTimeoutMs = options.fallbackTimeoutMs || Number(process.env.AGENT_LLM_FALLBACK_TIMEOUT_MS) || 180000;
  const onEvent = options.onEvent || (() => {});

  const FATAL_ERROR_PATTERNS = [
    /no api key configured/i,
    /invalid api key/i,
    /authentication failed/i,
    /unauthorized/i,
    /402/i,
    /payment required/i,
    /credit exhausted/i,
    /insufficient quota/i,
    /rate limit/i
  ];

  // Build enhanced user prompt with known-data hints for common companies
  const compactCtx = compactAgentContext(context);
  const overview = buildWorkbookOverview(context);
  let userPrompt = `Goal: ${objective}\n\n${overview}\n\nWorkbook context (compact JSON):\n${JSON.stringify(compactCtx, null, 2)}\n\nProceed step by step. When writing, ALWAYS pass an explicit "sheet" parameter — the active sheet at task start may NOT be where the user wants the data.`;
  const lowerObjective = objective.toLowerCase();
  if (lowerObjective.includes('apple') || lowerObjective.includes('aapl')) {
    userPrompt += `\n\nHINT — These publicly known Apple FY2024 figures are rough sanity-check anchors, not live sources:\n- Revenue: ~$394B\n- Net Income: ~$97B\n- EBITDA: ~$120B\n- CapEx: ~$10B\n- D&A: ~$12B\n- Shares Outstanding: ~15.5B\n- Cash & Equivalents: ~$70B\n- Total Debt: ~$110B\n- Tax Rate: ~16%\nVerify or update current market/filing inputs with tools when available, then build the model with visible sources and review flags.`;
  }

  const promptVariant = options.promptVariant || DEFAULT_PROMPT_VARIANT;
  const systemPromptForRun = getSystemPrompt(promptVariant);
  const modelForRun = resolveAgentLoopModel(options.modelOverride, promptVariant);
  logger.info(`[AgentLoop] Using prompt variant "${promptVariant}" (${systemPromptForRun.length} chars)`);

  // Auto-skill suggest: preload skill if user message matches known keywords
  const suggestedSkills = detectSkills(objective);
  let skillReminder = '';
  if (suggestedSkills.length > 0) {
    const loaded = suggestedSkills.map(name => readSkill(name)).filter(Boolean);
    if (loaded.length > 0) {
      skillReminder = `<system-reminder>\nPre-loaded skill${loaded.length > 1 ? 's' : ''} based on user request: ${suggestedSkills.join(', ')}.\n\n` +
        loaded.map(s => `--- ${s.name} ---\n${s.content.slice(0, 4000)}`).join('\n\n') +
        '\n</system-reminder>';
      logger.info(`[AgentLoop] Auto-preloaded skills: ${suggestedSkills.join(', ')}`);
    }
  }

  const systemPromptAddendum = typeof options.systemPromptAddendum === 'string' && options.systemPromptAddendum.trim()
    ? '\n\n' + options.systemPromptAddendum.trim()
    : '';
  // Inject dynamic content (skills index, user instructions, pre-loaded skill content)
  // into the first user message instead of the system prompt. This keeps the system
  // prompt immutable across iterations, enabling DeepSeek disk-based context caching.
  // Without this, the system prompt hash changes every call and caching is 0%.
  const skillsBlock = getAvailableSkillsForPrompt();
  const instructionsBlock = getInstructionsForPrompt();
  const dynamicPrefix = [
    skillsBlock ? `<available_skills>\n${skillsBlock}\n</available_skills>` : '',
    instructionsBlock ? `<user_instructions>\n${instructionsBlock}\n</user_instructions>` : '',
    systemPromptAddendum ? `<task_context>\n${systemPromptAddendum.trim()}\n</task_context>` : ''
  ].filter(Boolean).join('\n\n');
  const fullUserPrompt = [
    dynamicPrefix,
    skillReminder || '',
    `---\n\n${userPrompt}`
  ].filter(Boolean).join('\n\n');
  const messages = options.resumeMessages || [
    { role: 'system', content: systemPromptForRun },
    makeUserMessage(fullUserPrompt)
  ];

  const results = options.resumeResults || [];
  let iteration = options.resumeIteration || 0;
  let done = false;
  const codeLog = options.resumeCodeLog || [];
  // Track sheets touched by write actions. Hidden auto-format is opt-in now:
  // parallel architect runs already end with a dedicated format/verify slice,
  // and generic cleanup inside every data slice caused slow, conflicting passes.
  const touchedSheets = new Set(options.resumeTouchedSheets || []);
  const autoFormatOnDone = options.autoFormatOnDone === true ||
    (options.autoFormatOnDone !== false && AGENT_AUTO_FORMAT_ON_DONE);

  logger.info(`[AgentLoop] Starting loop for: ${objective}`);
  onEvent('agentStarted', { objective, iteration });

  let webSearchCount = options.resumeWebSearchCount || 0;
  const MAX_WEB_SEARCH = Number(process.env.AGENT_MAX_WEB_SEARCH) || 20;
  let consecutiveErrors = options.resumeConsecutiveErrors || 0;
  let lastErrorMessage = options.resumeLastErrorMessage || '';
  let aborted = false;
  let abortReason = '';
  let forceThinkingNext = options.resumeForceThinkingNext || false;
  let parseFailureStreak = options.resumeParseFailureStreak || 0;
  const pendingCritics = [];
  const loadedSkillNames = new Set(options.resumeLoadedSkillNames || []);
  const recentToolTrail = Array.isArray(options.resumeRecentToolTrail)
    ? [...options.resumeRecentToolTrail]
    : [];

  // Snapshot of every loop variable that must survive a pause/resume boundary.
  // Reads live values at call time (let counters + in-place-mutated arrays).
  // Sets serialize to arrays; arrays are copied so the snapshot can't be
  // mutated after capture.
  const captureResumableState = () => ({
    messages,
    results,
    iteration,
    codeLog,
    consecutiveErrors,
    lastErrorMessage,
    webSearchCount,
    parseFailureStreak,
    forceThinkingNext,
    loadedSkillNames: Array.from(loadedSkillNames),
    recentToolTrail: [...recentToolTrail]
  });

  while (!done && iteration < maxIterations) {
    iteration++;
    logger.info(`[AgentLoop] Iteration ${iteration}/${maxIterations}`);
    onEvent('iterationStart', { iteration, maxIterations });

    // Drain steering queue: messages user sent mid-execution are injected here
    // before the next LLM call. Classified upstream as ADDENDUM (context) or INTERRUPT (priority redirect).
    if (typeof options.pullSteerMessages === 'function') {
      try {
        const steerItems = options.pullSteerMessages() || [];
        for (const item of steerItems) {
          if (!item || !item.text) continue;
          const isInterrupt = item.kind === 'interrupt';
          const wrapped = isInterrupt
            ? `<user-interrupt iteration="${iteration}">\nThe user issued a mid-execution DIRECTIVE. Reassess immediately: drop in-progress steps that conflict with it. Acknowledge briefly in your next "thought" and act on the new directive.\n\nDirective: ${item.text}\n</user-interrupt>`
            : `<user-addendum iteration="${iteration}">\nAdditional info from the user (continue current work, integrate this into the ongoing task):\n${item.text}\n</user-addendum>`;
          messages.push(makeUserMessage(wrapped));
          recentToolTrail.length = 0;
          onEvent('agentSteered', { iteration, kind: item.kind, text: item.text });
          logger.info(`[AgentLoop] Steer injected (${item.kind}): ${item.text.slice(0, 120)}`);
        }
      } catch (steerErr) {
        logger.warn(`[AgentLoop] pullSteerMessages failed: ${steerErr.message}`);
      }
    }

    // Drain pending background critics: wait for any fire-and-forget post-write
    // critic to complete before the next LLM call so its findings are available.
    if (pendingCritics.length > 0) {
      try {
        await Promise.all(pendingCritics);
      } catch (_) {
        // Individual critic failures are already logged by their promise chain.
      } finally {
        pendingCritics.length = 0;
      }
    }

    try {
      // Caller can hard-disable thinking for "fast" mode regardless of the
      // smart gate (used by the user-facing speedMode=fast preset).
      const useThinking = options.forceThinkingDisabled === true
        ? false
        : shouldUseAgentThinking(iteration, {
            forceThinkingNext,
            consecutiveErrors,
            parseFailureStreak,
            lastToolName: recentToolTrail.length > 0 ? recentToolTrail[recentToolTrail.length - 1].toolName : null
          });
      const turnId = options.turnId || options.agentId;
      const callOpts = {
        messages,
        timeoutMs,
        fallbackTimeoutMs,
        label: `AgentLoop iter ${iteration}`,
        modelOverride: modelForRun,
        thinkingDisabled: !useThinking,
        // Reasoning effort for thinking iterations. Bench v3 (2026-05-28)
        // showed that downgrading thinking iter from 'high' to 'medium' as a
        // default lost bulk_set_cell_ranges adoption (6×→0×) and pushed
        // wallclock from 190s back to 388s. Keep 'high' as default — the
        // batch decision lives in the reasoning step. Set
        // DEEPSEEK_REASONING_EFFORT=medium to opt back into the cheaper
        // medium tier when latency-over-quality is acceptable (e.g. the
        // "fast" speed mode preset).
        reasoningEffort: useThinking
          ? (process.env.DEEPSEEK_REASONING_EFFORT || 'high')
          : AGENT_REASONING_EFFORT
      };

      let llmResult;
      if (AGENT_USE_STREAMING && turnId && !useThinking) {
        // Stream non-thinking responses for live UI feedback (thinking responses are JSON-only at end)
        const accumulated = await callLLMStreaming({
          ...callOpts,
          label: `AgentLoop iter ${iteration} stream`,
          onChunk: (delta, text, isDone) => {
            if (delta || isDone) {
              try { streaming.sendLLMProgress(turnId, text, isDone); } catch (_) {}
            }
          }
        });
        // Parse the streamed JSON
        try {
          llmResult = JSON.parse(accumulated);
        } catch (e) {
          llmResult = { raw: accumulated, jsonError: e.message };
        }
      } else {
        llmResult = await callLLM(callOpts);
      }

      // Detect JSON parse failure from LLM layer (raw payload returned, no parsed fields)
      const parseFailed = !!(llmResult && llmResult.raw && llmResult.jsonError);
      if (parseFailed) {
        parseFailureStreak++;
        if (AGENT_FORCE_THINKING_AFTER_ERROR) forceThinkingNext = true;
        logger.warn(`[AgentLoop] iter ${iteration} LLM JSON parse failed: ${llmResult.jsonError}`);
        onEvent('iterationError', { iteration, error: `LLM JSON parse failed: ${llmResult.jsonError}` });
        messages.push(makeUserMessage(
          `Your previous response was not valid JSON (${llmResult.jsonError}). Reply with ONLY a single JSON object {"thought","tool","params"} — no extra text, no trailing characters. Continue the task from where you left off.`
        ));
        continue;
      }
      parseFailureStreak = 0;
      if (useThinking) forceThinkingNext = false;

      // Extract thought and tool call from LLM response
      const thought = llmResult.thought || llmResult.reasoning || '';
      const toolName = llmResult.tool || llmResult.action || '';
      const params = llmResult.params || llmResult.parameters || llmResult.arguments || {};

      logger.info(`[AgentLoop] Thought: ${thought.slice(0, 120)}`);
      logger.info(`[AgentLoop] Tool: ${toolName}`);
      onEvent('thought', { iteration, thought: thought.slice(0, 300), tool: toolName });

      // Append assistant message
      messages.push({
        role: 'assistant',
        content: JSON.stringify({ thought, tool: toolName, params })
      });

      // Empty/noop tool — never auto-done. Force LLM to either call `done` or continue.
      if (!toolName || toolName === '' || toolName === 'noop' || toolName === 'none') {
        messages.push(makeUserMessage(
          'No tool was called. If task is complete, call tool "done" with a summary. Otherwise continue with the next tool.'
        ));
        continue;
      }

      // Enforce max web search attempts
      if (toolName === 'web_search' || toolName === 'web_fetch') {
        webSearchCount++;
        if (webSearchCount > MAX_WEB_SEARCH) {
          const blockMsg = `Maximum web search attempts (${MAX_WEB_SEARCH}) reached. Use the sourced information already gathered, label any remaining uncertain inputs as assumptions, and continue the model. Do NOT search again.`;
          logger.info(`[AgentLoop] ${blockMsg}`);
          messages.push(makeUserMessage(blockMsg));
          results.push({ type: 'error', error: blockMsg });
          onEvent('iterationError', { iteration, error: blockMsg });
          continue;
        }
      }

      // Handle done
      if (toolName === 'done') {
        done = true;
        // Optional auto-format pass for legacy single-agent runs.
        if (touchedSheets.size > 0 && autoFormatOnDone) {
          try {
            const { runFormatAgent } = require('./specialists');
            const sheets = Array.from(touchedSheets);
            logger.info(`[AgentLoop] auto-format on done: ${sheets.length} sheet(s) — ${sheets.join(', ')}`);
            const formatResult = await runFormatAgent(
              { sheets, mode: 'institutional_finance' },
              { results: results }
            );
            if (formatResult && Array.isArray(formatResult.actions) && formatResult.actions.length > 0) {
              const formatActions = formatResult.actions.map((a) => {
                if (!a.explanation) return { ...a, explanation: `auto-format ${a.sheet || ''}` };
                return a;
              });
              onEvent('actions', { tool: 'auto_format_on_done', actions: formatActions });
              logger.info(`[AgentLoop] auto-format emitted ${formatActions.length} actions`);
            }
          } catch (fmtErr) {
            logger.warn(`[AgentLoop] auto-format on done failed: ${fmtErr.message}`);
          }
        }
        results.push({ type: 'done', summary: params.summary || 'Task completed' });
        messages.push(makeUserMessage('Task completed successfully.'));
        onEvent('agentDone', { summary: params.summary || 'Task completed', iteration });
        break;
      }

      // Handle ask_user / ask_user_question — try auto-answer first, then pause only if needed
      if (toolName === 'ask_user' || toolName === 'ask_user_question') {
        let questionData = toolName === 'ask_user_question'
          ? params.questions
          : params.question;

        // Fallback: LLM might send singular 'question' instead of 'questions'
        if (!questionData && params.question) {
          questionData = Array.isArray(params.question) ? params.question : [params.question];
        }

        // Validate: if still no valid question data, tell LLM to retry
        if (!questionData || (Array.isArray(questionData) && questionData.length === 0)) {
          const retryMsg = 'You called ask_user_question with no valid questions. The "questions" parameter must be a non-empty array of objects with "question" (or "header") and "options" fields. Call ask_user_question again with a proper question.';
          logger.warn(`[AgentLoop] ask_user_question called with empty/invalid questions: ${JSON.stringify(params).slice(0, 200)}`);
          messages.push(makeUserMessage(retryMsg));
          continue;
        }

        // Try auto-answer to protect flow from trivial questions
        const autoAnswer = tryAutoAnswer(questionData, context, objective);
        if (autoAnswer) {
          logger.info(`[AgentLoop] Auto-answered question: "${JSON.stringify(questionData).slice(0, 120)}" → "${autoAnswer}"`);
          messages.push(makeUserMessage(
            `Auto-answered: ${autoAnswer}. Do NOT ask again unless absolutely critical. Proceed with the task.`
          ));
          results.push({ type: 'ask_user', question: questionData, autoAnswer });
          onEvent('agentAutoAnswer', { question: questionData, answer: autoAnswer, iteration });
          continue;
        }

        if (typeof options.requestQuestion === 'function') {
          logger.info(`[AgentLoop] requestQuestion callback handling ${Array.isArray(questionData) ? questionData.length : 1} prompt(s)`);
          onEvent('agentPaused', { reason: 'user_input_required', question: questionData, iteration, handledInline: true });
          const userResponse = await options.requestQuestion(questionData, { iteration, objective });
          const normalizedResponse = normalizeQuestionResponsePayload(userResponse);
          messages.push({
            role: 'user',
            content: `User response: ${JSON.stringify(normalizedResponse)}`
          });
          results.push({ type: 'ask_user', question: questionData, response: normalizedResponse });
          onEvent('agentResumed', { question: questionData, response: normalizedResponse, iteration });
          continue;
        }

        results.push({ type: 'ask_user', question: questionData });
        // SSE payload: only send what the client UI needs (not messages/results/codeLog)
        logger.info(`[AgentLoop] PAUSING loop — emitting agentPaused to ${typeof onEvent === 'function' ? 'client' : 'no one'}`);
        const eventPayload = { reason: 'user_input_required', question: questionData, iteration };
        onEvent('agentPaused', eventPayload);
        logger.info(`[AgentLoop] agentPaused emitted with question count=${Array.isArray(questionData) ? questionData.length : 1}`);
        return {
          status: 'paused',
          reason: 'user_input_required',
          question: questionData,
          context,
          ...captureResumableState()
        };
      }

      // Handle context_snip — managed directly in the loop (needs access to messages array)
      if (toolName === 'context_snip') {
        const snipResult = snipContext(messages, params.from_id, params.to_id, params.summary);
        logger.info(`[AgentLoop] context_snip: ${snipResult.ok ? 'removed ' + snipResult.removed + ' messages' : 'failed: ' + snipResult.error}`);
        messages.push(makeUserMessage(`Context snipped: ${params.summary}`));
        results.push({ type: 'context_snip', ...snipResult });
        onEvent('contextSnip', snipResult);
        continue;
      }

      // Handle retrieve_snipped — lookup in global store
      if (toolName === 'retrieve_snipped') {
        const retrieved = retrieveSnipped(params.from_id, params.search, params.max_chars);
        logger.info(`[AgentLoop] retrieve_snipped: ${retrieved.found ? retrieved.count + ' results' : 'none found'}`);
        messages.push(makeUserMessage(`Retrieved snipped context: ${JSON.stringify(retrieved.results?.map(r => r.summary) || [])}`));
        results.push({ type: 'retrieve_snipped', ...retrieved });
        onEvent('retrieveSnipped', retrieved);
        continue;
      }

      if (toolName === 'read_skill') {
        const skillName = String(params?.name || '').trim();
        if (skillName && loadedSkillNames.has(skillName)) {
          const duplicateSkillMsg = `Skill "${skillName}" is already loaded in context. Do not call read_skill again. Proceed with workbook/data/build tools.`;
          logger.info(`[AgentLoop] ${duplicateSkillMsg}`);
          results.push({ type: 'read_skill_duplicate', name: skillName });
          onEvent('iterationError', { iteration, error: duplicateSkillMsg });
          messages.push(makeUserMessage(duplicateSkillMsg));
          continue;
        }
      }

      // Execute tool
      const toolResult = await executeAgentTool(toolName, params, context, options.requestClientTool);

      if (toolName === 'read_skill') {
        const skillName = String(params?.name || '').trim();
        if (skillName) loadedSkillNames.add(skillName);
      }

      // Handle todo_write — pass to client as UI update, don't pause
      if (toolName === 'todo_write') {
        const todos = Array.isArray(params.todos) ? params.todos : [];
        results.push({ type: 'todo_write', todos });
        onEvent('todoWrite', { todos });
        if (todos.length > 0) {
          messages.push(makeUserMessage(
            `Task list updated: ${todos.map(t => `[${t.status}] ${t.content}`).join(', ')}`
          ));
        } else {
          messages.push(makeUserMessage('Task list updated.'));
        }
        continue;
      }

      // Handle preflight conflict (e.g. set_cell_range with allow_overwrite=false)
      if (toolResult && toolResult._preflight && toolResult._preflight.conflict) {
        logger.warn(`[AgentLoop] Preflight conflict blocked ${toolName}: ${toolResult._message}`);
        onEvent('preflightConflict', { tool: toolName, ...toolResult._preflight });
        results.push({ type: 'preflight_conflict', tool: toolName, ...toolResult._preflight });
        messages.push(makeUserMessage(toolResult._message));
        continue;
      }

      // Emit actions for Excel mutations
      if (toolResult && toolResult.actions && toolResult.actions.length > 0) {
        // Auto-add explanation + citation if missing (Anthropic pattern)
        const enrichedActions = toolResult.actions.map((a, idx) => {
          let enriched = a;
          if (!a.explanation) {
            const parts = [a.type];
            if (a.sheet) parts.push(`on ${a.sheet}`);
            if (a.target) parts.push(a.target);
            else if (a.cells) parts.push(`${Object.keys(a.cells).length} cells`);
            else if (a.name) parts.push(`"${a.name}"`);
            const explanation = parts.join(' ').slice(0, 50);
            enriched = { ...a, explanation };
          }
          // Propagate preflight metadata to client for trust UX
          if (idx === 0 && toolResult._preflight) {
            enriched = { ...enriched, _preflight: toolResult._preflight };
          }
          // Track sheets that received data so the auto-format pass on done
          // can target them. Only data writes (not pure-format actions) count.
          if (a && (a.type === 'setCellRange' || a.type === 'setCellValue' || a.type === 'writeRange' || a.type === 'fillRange' || a.type === 'createSheet')) {
            const sheetName = a.sheet || a.sheetName || a.name;
            if (sheetName && typeof sheetName === 'string') touchedSheets.add(sheetName);
          }
          return enriched;
        });
        onEvent('actions', { tool: toolName, actions: enrichedActions });
      }

      // Log code transparency
      if (toolName === 'execute_python') {
        codeLog.push({ type: 'python', code: params.code, result: toolResult });
        onEvent('codeLog', { code: params.code, result: toolResult });
      }

      // Invalidate workbook-read cache after any mutation so the next read
      // crosses the wire instead of returning a pre-write snapshot.
      if (MUTATION_TOOLS.has(toolName) && options.agentId) {
        try {
          const n = clientReadCache.invalidate(options.agentId);
          if (n > 0) logger.info(`[AgentLoop] read cache invalidated (${n} entries) after ${toolName}`);
        } catch (_) { /* defensive — cache is optional */ }
      }

      results.push({ type: 'tool', tool: toolName, params, result: toolResult });
      consecutiveErrors = 0;
      lastErrorMessage = '';

      // Append tool result — bounded by AGENT_TOOL_RESULT_MAX_CHARS to keep
      // the prompt size predictable across long iterations.
      // Strip the `actions` array before serializing for the LLM: the model
      // emitted those itself one iteration ago, the client already received
      // them on the dedicated 'actions' SSE channel, and they can balloon
      // the prompt by several KB per write (bulk_set_cell_ranges can carry
      // 16 nested cell maps). The model only needs the summary fields
      // (ok, applied, sheets, cellsTotal, errors).
      const toolResultForMessages = (toolResult && typeof toolResult === 'object' && Array.isArray(toolResult.actions))
        ? { ...toolResult, actions: undefined, _actionCount: toolResult.actions.length }
        : toolResult;
      const resultMsg = formatToolResultForMessages(toolResultForMessages, toolName);
      messages.push(makeUserMessage(resultMsg));
      onEvent('toolResult', { iteration, tool: toolName, result: toolResult });

      // Optional post-write critic: cheap flash LLM pass over the just-emitted
      // write actions, looking for obvious formula syntax errors or literal
      // error markers (#REF/#VALUE/#NAME/#DIV0). When it flags something, the
      // finding is injected as a user message so the next iteration can fix
      // it without waiting for a downstream verify. Per-turn flag wins over
      // the AGENT_POSTWRITE_CRITIC env default.
      const postWriteCriticOn = (options.postWriteCriticEnabled === true) || (options.postWriteCriticEnabled !== false && AGENT_POSTWRITE_CRITIC);
      if (postWriteCriticOn && POSTWRITE_CRITIC_TOOLS.has(toolName) && Array.isArray(toolResult?.actions) && toolResult.actions.length >= AGENT_POSTWRITE_CRITIC_MIN_ACTIONS) {
        // Fire-and-forget: run critic in background, inject findings before NEXT iteration's LLM call
        const criticPromise = runPostWriteCritic(toolName, toolResult.actions)
          .then(critique => {
            if (critique && Array.isArray(critique.issues) && critique.issues.length > 0) {
              const formatted = critique.issues.slice(0, 6).map((i, idx) =>
                `${idx + 1}. [${i.severity || 'note'}] ${i.message || '(no message)'}${i.suggestion ? ` — fix: ${i.suggestion}` : ''}`
              ).join('\n');
              const msg = `POST-WRITE CRITIC (fast pass, ${critique.issues.length} issue${critique.issues.length === 1 ? '' : 's'}):\n${formatted}\n\nAddress the high-severity issues in your next step before continuing the build.`;
              // Push into messages array; the loop will pick it up in the next iteration
              messages.push(makeUserMessage(msg));
              onEvent('postWriteCritic', { iteration, tool: toolName, issues: critique.issues });
              logger.info(`[AgentLoop] post-write critic flagged ${critique.issues.length} issue(s) after ${toolName}`);
            }
          })
          .catch(err => logger.warn(`[AgentLoop] post-write critic threw: ${err.message}`));
        // Track background job (don't await — let it resolve before next LLM call)
        pendingCritics.push(criticPromise);
      }

      recentToolTrail.push({
        iteration,
        toolName,
        signature: buildToolStagnationSignature(toolName, params),
        sheetHint: extractSheetHint(params)
      });
      if (recentToolTrail.length > STAGNATION_MAX_TRAIL) {
        recentToolTrail.splice(0, recentToolTrail.length - STAGNATION_MAX_TRAIL);
      }

      // Bulk nudge: if the model just emitted N≥2 consecutive single-write
      // tools of the SAME class, inject a one-line reminder so the next
      // iteration collapses them into a bulk_* call. Belt-and-suspenders for
      // the hard rule already in the system prompt — some model versions
      // ignore the rule on the first violation; this catches them on the
      // second. Disabled via AGENT_BULK_NUDGE=false.
      if (process.env.AGENT_BULK_NUDGE !== 'false') {
        const BULK_TRIGGER_RUN = 2;
        const lastN = recentToolTrail.slice(-BULK_TRIGGER_RUN).map(e => e.toolName);
        if (lastN.length === BULK_TRIGGER_RUN && lastN.every(n => n === 'set_cell_range')) {
          messages.push(makeUserMessage(
            'BATCH HINT: you just called set_cell_range twice in a row. Consolidate the upcoming writes into ONE bulk_set_cell_ranges call. Write data/formulas first; do one explicit bulk_set_format pass after the structure is in place.'
          ));
        } else if (lastN.length === BULK_TRIGGER_RUN && lastN.every(n => n === 'set_format')) {
          messages.push(makeUserMessage(
            'BATCH HINT: you just called set_format twice in a row. Consolidate the next formats into ONE bulk_set_format call based on the ranges you have already written or inspected.'
          ));
        } else if (lastN.length === BULK_TRIGGER_RUN && lastN.every(n => n === 'create_sheet')) {
          messages.push(makeUserMessage(
            'BATCH HINT: you just created two sheets one at a time. If more are coming, use bulk_create_sheets with the full list.'
          ));
        } else if (lastN.length === BULK_TRIGGER_RUN && lastN.every(n => n === 'create_named_range')) {
          messages.push(makeUserMessage(
            'BATCH HINT: you just created two named ranges one at a time. Use bulk_create_named_ranges with the full list of remaining inputs.'
          ));
        }
      }
      const stagnation = detectToolStagnation(recentToolTrail);
      if (stagnation) {
        aborted = true;
        abortReason = formatToolStagnationReason(stagnation);
        results.push({
          type: 'error',
          error: abortReason,
          stagnation: true,
          pattern: stagnation.pattern,
          tools: stagnation.entries.map(entry => entry.toolName)
        });
        logger.warn(`[AgentLoop] Stagnation detected (${abortReason})`);
        onEvent('iterationError', {
          iteration,
          error: abortReason,
          stagnation: true,
          pattern: stagnation.pattern
        });
        break;
      }

      // Auto-compact context if too large (LLM should also call context_snip explicitly)
      const AUTO_COMPACT_LIMIT = Number(process.env.AGENT_AUTO_COMPACT_LIMIT) || 80;
      if (messages.length > AUTO_COMPACT_LIMIT) {
        const keepCount = Number(process.env.AGENT_AUTO_COMPACT_KEEP) || 12;
        const toCompact = messages.slice(1, messages.length - keepCount);
        // Find first and last user message IDs in the range for snipContext
        const userMsgs = toCompact.filter(m => m.role === 'user');
        let snipApplied = false;
        if (userMsgs.length >= 2) {
          const firstId = extractMsgId(userMsgs[0].content);
          const lastId = extractMsgId(userMsgs[userMsgs.length - 1].content);
          if (firstId && lastId) {
            const snipResult = snipContext(messages, firstId, lastId, 'Auto-compacted history');
            if (snipResult.ok) {
              logger.info(`[AgentLoop] Auto-snipped ${snipResult.removed} messages (${firstId}..${lastId}). New length: ${messages.length}`);
              snipApplied = true;
            }
          }
        }
        // Fallback to old text summary if snipContext failed
        if (!snipApplied) {
          const compacted = toCompact.filter(m => {
            if (m.role === 'assistant') {
              try { const p = JSON.parse(m.content); return p.tool && !['done','todo_write','context_snip'].includes(p.tool); }
              catch (_) { return m.content.length > 50; }
            }
            return m.role === 'user' && !m.content.startsWith('Tool result') && !m.content.startsWith('CONVERSATION SUMMARY');
          });
          const compactLines = compacted.map(m => {
            if (m.role === 'assistant') {
              try { const p = JSON.parse(m.content); return `[${p.tool}] ${(p.thought||'').slice(0,100)}`; }
              catch (_) { return m.content.slice(0,100); }
            }
            return m.content.slice(0,100);
          });
          if (compactLines.length > 0) {
            const summary = 'AUTO-COMPACTED HISTORY (' + toCompact.length + ' msgs):\n' + compactLines.join('\n').slice(0, 3000);
            const newMsgs = [messages[0]];
            newMsgs.push(makeUserMessage(summary + '\n\nContinue from where you left off.'));
            newMsgs.push(...messages.slice(messages.length - keepCount));
            messages.length = 0;
            messages.push(...newMsgs);
            logger.info(`[AgentLoop] Auto-compacted ${toCompact.length} messages. New length: ${messages.length}`);
          }
        }
      }

    } catch (error) {
      logger.error(`[AgentLoop] Error iteration ${iteration}: ${error.message}`);
      const isFatal = FATAL_ERROR_PATTERNS.some(p => p.test(error.message || ''));
      if (isFatal) {
        aborted = true;
        abortReason = `fatal_error: ${error.message}`;
        results.push({ type: 'error', error: error.message, fatal: true });
        onEvent('iterationError', { iteration, error: error.message, fatal: true });
        logger.error(`[AgentLoop] Fatal error → abort: ${error.message}`);
        break;
      }
      if (error.message === lastErrorMessage) {
        consecutiveErrors++;
      } else {
        consecutiveErrors = 1;
        lastErrorMessage = error.message;
      }
      results.push({ type: 'error', error: error.message });
      onEvent('iterationError', { iteration, error: error.message });
      if (AGENT_FORCE_THINKING_AFTER_ERROR) forceThinkingNext = true;
      if (consecutiveErrors >= maxConsecutiveErrors) {
        aborted = true;
        abortReason = `repeated_error_x${consecutiveErrors}: ${error.message}`;
        logger.error(`[AgentLoop] Same error ${consecutiveErrors}x → abort: ${error.message}`);
        break;
      }
      messages.push(makeUserMessage(
        `Error: ${error.message}. Please try a different approach.`
      ));
    }
  }

  logger.info(`[AgentLoop] Completed after ${iteration} iterations${aborted ? ` (aborted: ${abortReason})` : ''}`);
  const finalStatus = done ? 'completed' : (aborted ? 'aborted' : 'max_iterations');
  const finalSummary = done
    ? results.find(r => r.type === 'done')?.summary
    : (aborted ? abortReason : 'Reached max iterations');

  return {
    status: finalStatus,
    summary: finalSummary,
    aborted,
    abortReason,
    ...captureResumableState()
  };
}

/* ---------- Tool Execution Router ---------- */

function normalizeAgentParams(toolName, params) {
  if (!params || typeof params !== 'object') return params || {};
  const p = { ...params };
  // Sheet aliases: LLM may emit sheetName / sheet_name / worksheet
  if (p.sheet === undefined) {
    if (p.sheetName !== undefined) p.sheet = p.sheetName;
    else if (p.sheet_name !== undefined) p.sheet = p.sheet_name;
    else if (p.worksheet !== undefined) p.sheet = p.worksheet;
    else if (p.worksheetName !== undefined) p.sheet = p.worksheetName;
  }
  // Target aliases: range / address / cell
  if (p.target === undefined) {
    if (p.range !== undefined) p.target = p.range;
    else if (p.address !== undefined) p.target = p.address;
    else if (p.cell !== undefined) p.target = p.cell;
  }
  // copy_range: snake/camel aliases
  if (toolName === 'copy_range') {
    if (p.from_sheet === undefined && p.fromSheet !== undefined) p.from_sheet = p.fromSheet;
    if (p.to_sheet === undefined && p.toSheet !== undefined) p.to_sheet = p.toSheet;
  }
  // rename_sheet
  if (toolName === 'rename_sheet') {
    if (p.old_name === undefined && p.oldName !== undefined) p.old_name = p.oldName;
    if (p.new_name === undefined && p.newName !== undefined) p.new_name = p.newName;
  }
  // duplicate_sheet
  if (toolName === 'duplicate_sheet') {
    if (p.new_name === undefined && p.newName !== undefined) p.new_name = p.newName;
  }
  // create_named_range
  if (toolName === 'create_named_range') {
    if (p.refers_to === undefined && p.refersTo !== undefined) p.refers_to = p.refersTo;
  }
  return p;
}

/* ---------- Preflight helpers for cell range bounding box ---------- */
function colToIndex(col) {
  let idx = 0;
  for (let i = 0; i < col.length; i++) {
    idx = idx * 26 + (col.charCodeAt(i) - 64);
  }
  return idx;
}
function indexToCol(idx) {
  let col = '';
  while (idx > 0) {
    const rem = (idx - 1) % 26;
    col = String.fromCharCode(65 + rem) + col;
    idx = Math.floor((idx - 1) / 26);
  }
  return col;
}
function getCellRangeBounds(cellMap) {
  const cells = Object.keys(cellMap || {});
  if (cells.length === 0) return null;
  let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
  for (const addr of cells) {
    const m = addr.match(/^([A-Z]+)(\d+)$/);
    if (!m) continue;
    const col = colToIndex(m[1]);
    const row = parseInt(m[2], 10);
    minCol = Math.min(minCol, col);
    maxCol = Math.max(maxCol, col);
    minRow = Math.min(minRow, row);
    maxRow = Math.max(maxRow, row);
  }
  if (minCol === Infinity) return null;
  return `${indexToCol(minCol)}${minRow}:${indexToCol(maxCol)}${maxRow}`;
}

// Allowlist of tool names that are safe to run inside parallel_calls.
// Strictly read-only / idempotent. Mutations, control flow, and context
// manipulation tools are excluded — they MUST run sequentially.
const PARALLEL_SAFE_TOOLS = new Set([
  'read_workbook',
  'read_sheet',
  'get_cell_ranges',
  'get_range_as_csv',
  'read_format_summary',
  'list_named_ranges',
  'build_workbook_graph',
  'read_instructions',
  'read_skill',
  'search_tools',
  'openbb_equity_profile',
  'openbb_equity_metrics',
  'openbb_equity_balance',
  'openbb_equity_income',
  'openbb_equity_cashflow',
  'openbb_treasury_rates',
  'openbb_fed_rate',
  'openbb_cpi',
  'openbb_gdp',
  'openbb_unemployment',
  'finance_company_bundle',
  'macro_snapshot'
]);

async function executeAgentTool(toolName, params, context, requestClientTool) {
  params = normalizeAgentParams(toolName, params);
  // Build a memory object compatible with registry.executeTool so that
  // workbook.* tools can access requestClientTool via memory.runtime.
  const toolMemory = { context };
  if (requestClientTool) toolMemory.runtime = { requestClientTool };
  switch (toolName) {
    case 'parallel_calls': {
      const callsInput = Array.isArray(params && params.calls) ? params.calls : [];
      if (callsInput.length === 0) {
        return { error: 'parallel_calls: "calls" must be a non-empty array' };
      }
      if (callsInput.length > 8) {
        return { error: `parallel_calls: max 8 calls per batch, got ${callsInput.length}` };
      }
      const planned = callsInput.map((c, idx) => {
        const tool = c && typeof c.tool === 'string' ? c.tool : '';
        const innerParams = c && typeof c.params === 'object' && c.params !== null ? c.params : {};
        if (!tool) {
          return { idx, tool, ok: false, error: 'missing "tool" field', skipped: true };
        }
        if (tool === 'parallel_calls') {
          return { idx, tool, ok: false, error: 'parallel_calls cannot be nested', skipped: true };
        }
        if (!PARALLEL_SAFE_TOOLS.has(tool)) {
          return { idx, tool, ok: false, error: `tool "${tool}" not allowed inside parallel_calls (read-only allowlist only)`, skipped: true };
        }
        return { idx, tool, params: innerParams };
      });
      const runnable = planned.filter(p => !p.skipped);
      const settled = await Promise.allSettled(runnable.map(p =>
        executeAgentTool(p.tool, p.params, context, requestClientTool)
      ));
      // Stitch results back in original input order.
      const results = new Array(callsInput.length);
      let runIdx = 0;
      for (const p of planned) {
        if (p.skipped) {
          results[p.idx] = { tool: p.tool, ok: false, error: p.error };
          continue;
        }
        const r = settled[runIdx++];
        if (r.status === 'fulfilled') {
          const val = r.value;
          if (val && val.error) {
            results[p.idx] = { tool: p.tool, ok: false, error: val.error };
          } else {
            results[p.idx] = { tool: p.tool, ok: true, value: val };
          }
        } else {
          const msg = r.reason && r.reason.message ? r.reason.message : String(r.reason);
          results[p.idx] = { tool: p.tool, ok: false, error: msg };
        }
      }
      const okCount = results.filter(r => r.ok).length;
      const errCount = results.length - okCount;
      return {
        results,
        summary: { total: results.length, ok: okCount, errors: errCount }
      };
    }
    case 'read_workbook': {
      // Try client round-trip for fresh data if available
      if (requestClientTool) {
        try {
          const data = await requestClientTool('workbook.readWorkbook', {
            maxRows: params.maxRows || 80,
            maxCols: params.maxCols || 32,
            includeFormulas: params.includeFormulas !== false
          });
          return {
            activeSheet: data.activeSheet || context?.activeSheet,
            workbookSheets: data.workbookSheets || [],
            selectedRange: data.selectedRange,
            selectedValues: data.selectedValues,
            selectedFormulas: data.selectedFormulas,
            allSheetsData: (data.sheets || []).reduce((acc, s) => {
              acc[s.name] = {
                usedRange: s.usedRange,
                rowCount: s.rowCount,
                columnCount: s.columnCount,
                preview: s.preview || [],
                formulas: s.formulas || []
              };
              return acc;
            }, {})
          };
        } catch (err) {
          logger.warn(`[AgentLoop] Client read failed for read_workbook: ${err.message}. Falling back to static context.`);
        }
      }
      return {
        activeSheet: context?.activeSheet,
        workbookSheets: context?.workbookSheets,
        selectedRange: context?.selectedRange,
        selectedValues: context?.selectedValues,
        usedRangeData: context?.usedRangeData,
        allSheetsData: context?.allSheetsData
      };
    }
    case 'build_workbook_graph': {
      let snapshot = context || {};
      if (requestClientTool) {
        try {
          snapshot = await requestClientTool('workbook.readWorkbook', {
            maxRows: params.maxRows || 160,
            maxCols: params.maxCols || 50,
            includeFormulas: true
          });
        } catch (err) {
          logger.warn(`[AgentLoop] Client read failed for build_workbook_graph: ${err.message}. Falling back to static context.`);
        }
      }
      const result = await executeTool('workbook.buildGraph', {
        snapshot,
        workbookName: params.workbookName,
        source: 'agent_loop'
      }, toolMemory);
      return result.data;
    }
    case 'read_sheet': {
      if (requestClientTool) {
        try {
          const data = await requestClientTool('workbook.readSheet', {
            sheet: params.sheet,
            maxRows: params.maxRows || 200,
            maxCols: params.maxCols || 20
          });
          return {
            sheet: data.sheet || params.sheet,
            usedRange: data.usedRange,
            usedRangeData: data.values || [],
            rowCount: data.rowCount || 0,
            columnCount: data.columnCount || 0
          };
        } catch (err) {
          logger.warn(`[AgentLoop] Client read failed for read_sheet: ${err.message}. Falling back to static context.`);
        }
      }
      // Fallback: try to get data from the specific sheet if available in allSheetsData
      if (params.sheet && context?.allSheetsData && context.allSheetsData[params.sheet]) {
        const sheetData = context.allSheetsData[params.sheet];
        return {
          sheet: params.sheet,
          usedRange: sheetData.usedRange || context?.usedRange,
          usedRangeData: sheetData.preview || [],
          rowCount: sheetData.rowCount || 0,
          columnCount: sheetData.columnCount || 0
        };
      }
      return {
        sheet: params.sheet || context?.activeSheet,
        usedRange: context?.usedRange,
        usedRangeData: context?.usedRangeData,
        rowCount: context?.totalRows || context?.usedRangeSize?.rows,
        columnCount: context?.totalColumns || context?.usedRangeSize?.columns
      };
    }
    case 'read_format_summary': {
      if (!requestClientTool) {
        return { error: 'read_format_summary requires a live Excel client (visual formatting has no static fallback).' };
      }
      try {
        return await requestClientTool('workbook.readFormatSummary', {
          sheet: params.sheet,
          target: params.target,
          maxRows: params.maxRows,
          maxCols: params.maxCols
        });
      } catch (err) {
        return { error: `read_format_summary failed: ${err.message}` };
      }
    }
    case 'get_range_as_csv': {
      // If requestClientTool is available, do a real client-side read
      // Otherwise fall back to static context (read-only agent, no UI open)
      if (requestClientTool) {
        try {
          const data = await requestClientTool('workbook.readRange', {
            sheet: params.sheet,
            target: params.target,
            maxRows: params.maxRows || 0,  // 0 = no limit
            format: 'csv'
          });
          return {
            sheet: data.sheet || params.sheet,
            target: data.target || params.target,
            csv: data.csv || '',
            rowCount: data.rowCount || 0,
            columnCount: data.columnCount || 0,
            truncated: data.truncated || false
          };
        } catch (err) {
          // Fall back to static context if client read fails
          logger.warn(`[AgentLoop] Client read failed for get_range_as_csv: ${err.message}. Falling back to static context.`);
        }
      }
      // Fallback: static context — build CSV from values if available
      let values = context?.selectedValues || context?.usedRangeData || [];
      let sourceSheet = params.sheet || context?.activeSheet;
      let targetRange = params.target || context?.selectedRange;
      let rowCount = values.length;
      let columnCount = values.length > 0 ? values[0].length : 0;

      // Try to get data from the specific sheet if available
      if (params.sheet && context?.allSheetsData && context.allSheetsData[params.sheet]) {
        const sheetData = context.allSheetsData[params.sheet];
        if (sheetData.preview && sheetData.preview.length > 0) {
          values = sheetData.preview;
          sourceSheet = params.sheet;
          targetRange = params.target || sheetData.usedRange;
          rowCount = sheetData.preview.length;
          columnCount = sheetData.preview.length > 0 ? sheetData.preview[0].length : 0;
        }
      }

      // Apply maxRows limit if specified
      const maxRows = Number(params.maxRows) || 500;
      if (values.length > maxRows) {
        values = values.slice(0, maxRows);
        rowCount = maxRows;
      }

      const escapeCsv = (val) => {
        if (val == null) return '';
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      };
      const csv = values.map(row => row.map(escapeCsv).join(',')).join('\n');
      return {
        sheet: sourceSheet,
        target: targetRange,
        csv,
        rowCount,
        columnCount,
        truncated: values.length < rowCount,
        _warning: 'Using stale static context (client read unavailable). Data may be truncated.'
      };
    }
    case 'get_cell_ranges': {
      const ranges = params.ranges || [];
      if (ranges.length === 0) {
        return { ranges: [], _warning: 'No ranges specified' };
      }
      // If requestClientTool is available, batch-read all ranges from client
      if (requestClientTool) {
        // Parallelize all range reads — sequential client round-trips waste 200-500ms each
        const readPromises = ranges.map(async (rangeSpec) => {
          try {
            const data = await requestClientTool('workbook.readRange', {
              sheet: rangeSpec.sheet,
              target: rangeSpec.target,
              maxRows: rangeSpec.maxRows || 100,
              format: 'snapshot'
            });
            return {
              sheet: data.sheet || rangeSpec.sheet,
              target: data.target || rangeSpec.target,
              values: data.values || [],
              formulas: data.formulas || [],
              rowCount: data.rowCount || 0,
              columnCount: data.columnCount || 0,
              error: null
            };
          } catch (err) {
            return {
              sheet: rangeSpec.sheet,
              target: rangeSpec.target,
              values: [],
              formulas: [],
              rowCount: 0,
              columnCount: 0,
              error: err.message
            };
          }
        });
        const settled = await Promise.allSettled(readPromises);
        const results = settled.map(r => r.status === 'fulfilled' ? r.value : {
          sheet: '', target: '', values: [], formulas: [], rowCount: 0, columnCount: 0,
          error: r.reason?.message || 'Promise rejected'
        });
        return { ranges: results };
      }
      // Fallback: extract from static context (allSheetsData or selectedValues)
      logger.warn('[AgentLoop] get_cell_ranges called without client connection. Using static context.');
      const fallbackRanges = [];
      for (const rangeSpec of ranges) {
        const sheetName = rangeSpec.sheet || context?.activeSheet;
        let values = [];
        let formulas = [];
        let rowCount = 0;
        let columnCount = 0;
        let resolvedTarget = rangeSpec.target;

        if (sheetName && context?.allSheetsData && context.allSheetsData[sheetName]) {
          const sheetData = context.allSheetsData[sheetName];
          if (sheetData.preview && sheetData.preview.length > 0) {
            values = sheetData.preview;
            rowCount = sheetData.preview.length;
            columnCount = sheetData.preview.length > 0 ? sheetData.preview[0].length : 0;
            resolvedTarget = rangeSpec.target || sheetData.usedRange;
          }
        } else if (context?.selectedValues && (!rangeSpec.sheet || rangeSpec.sheet === context?.activeSheet)) {
          values = context.selectedValues;
          rowCount = values.length;
          columnCount = values.length > 0 ? values[0].length : 0;
          resolvedTarget = rangeSpec.target || context?.selectedRange;
        }

        fallbackRanges.push({
          sheet: sheetName,
          target: resolvedTarget,
          values,
          formulas,
          rowCount,
          columnCount,
          error: null
        });
      }
      return {
        ranges: fallbackRanges,
        _warning: 'Using stale static context (client read unavailable). Data may be incomplete.'
      };
    }
    case 'create_sheet': {
      return {
        actions: [{ type: 'createSheet', name: params.name }]
      };
    }
    case 'bulk_create_sheets': {
      const names = Array.isArray(params && params.names) ? params.names.filter(n => typeof n === 'string' && n.trim()) : [];
      if (names.length === 0) {
        return { error: 'bulk_create_sheets: "names" must be a non-empty array of strings' };
      }
      if (names.length > 32) {
        return { error: `bulk_create_sheets: max 32 sheets per call, got ${names.length}` };
      }
      // Dedupe while preserving order
      const seen = new Set();
      const unique = [];
      for (const n of names) {
        const trimmed = n.trim();
        if (!seen.has(trimmed)) {
          seen.add(trimmed);
          unique.push(trimmed);
        }
      }
      return {
        ok: true,
        sheetsCreated: unique,
        count: unique.length,
        actions: unique.map(name => ({ type: 'createSheet', name }))
      };
    }
    case 'bulk_create_named_ranges': {
      const ranges = Array.isArray(params && params.ranges) ? params.ranges : [];
      if (ranges.length === 0) {
        return { error: 'bulk_create_named_ranges: "ranges" must be a non-empty array' };
      }
      if (ranges.length > 32) {
        return { error: `bulk_create_named_ranges: max 32 named ranges per call, got ${ranges.length}` };
      }
      const skipped = [];
      const accepted = [];
      const seen = new Set();
      for (const r of ranges) {
        const name = r && typeof r.name === 'string' ? r.name.trim() : '';
        const refersTo = r && typeof r.refers_to === 'string' ? r.refers_to.trim() : '';
        if (!name || !refersTo) {
          skipped.push({ name, reason: 'missing name or refers_to' });
          continue;
        }
        if (seen.has(name)) {
          skipped.push({ name, reason: 'duplicate name in batch' });
          continue;
        }
        seen.add(name);
        accepted.push({ name, refersTo });
      }
      if (accepted.length === 0) {
        return { error: 'bulk_create_named_ranges: no valid {name, refers_to} entries', skipped };
      }
      return {
        ok: true,
        rangesCreated: accepted.map(a => a.name),
        count: accepted.length,
        skipped: skipped.length ? skipped : undefined,
        actions: accepted.map(a => ({ type: 'createNamedRange', name: a.name, refersTo: a.refersTo }))
      };
    }
    case 'rename_sheet': {
      return {
        actions: [{ type: 'renameSheet', oldName: params.old_name, newName: params.new_name }]
      };
    }
    case 'delete_sheet': {
      // Accept any reasonable param name — the LLM regularly tries "name", "sheet",
      // "sheet_name", "sheetName". Picking one and rejecting the others wasted iters
      // in production (log shows agent retrying with different names).
      const sheetName = params.name || params.sheet || params.sheet_name || params.sheetName;
      if (!sheetName || typeof sheetName !== 'string') {
        return { error: 'delete_sheet: nome del foglio obbligatorio (usa "name" o "sheet").' };
      }
      return {
        actions: [{ type: 'deleteSheet', name: sheetName }]
      };
    }
    case 'duplicate_sheet': {
      return {
        actions: [{ type: 'duplicateSheet', source: params.source, newName: params.new_name || (params.source + ' (copy)') }]
      };
    }
    case 'copy_range': {
      return {
        actions: [{ type: 'copyRange', fromSheet: params.from_sheet, toSheet: params.to_sheet, from: params.from, to: params.to }]
      };
    }
    case 'create_named_range': {
      return {
        actions: [{ type: 'createNamedRange', name: params.name, refersTo: params.refers_to }]
      };
    }
    case 'list_named_ranges': {
      if (requestClientTool) {
        try {
          const data = await requestClientTool('workbook.listNamedRanges', params || {});
          return data;
        } catch (err) {
          logger.warn(`[AgentLoop] Client read failed for list_named_ranges: ${err.message}`);
          return { error: err.message, namedRanges: [] };
        }
      }
      // Fallback: try registry (may fail in agent mode without runtime)
      try {
        const r = await executeTool('workbook.listNamedRanges', params || {}, toolMemory);
        return r.data || r;
      } catch (err) {
        return { error: err.message, namedRanges: [] };
      }
    }
    case 'set_cell_range': {
      // Normalize copyToRange: accept string or {patternCell, range}
      let copyToRange = params.copyToRange;
      if (copyToRange && typeof copyToRange === 'object' && copyToRange.range) {
        copyToRange = copyToRange.range;
      }
      const targetSheet = params.sheet || context?.activeSheet;
      if (!params.sheet) {
        logger.warn(`[AgentLoop] set_cell_range called without 'sheet' param; defaulting to activeSheet="${targetSheet}". LLM should specify sheet explicitly.`);
      }

      // Anti-flood-fill guard — reject scalar text replicated across many cells
      const floodCheck = detectScalarTextFloodFill(params.cells, copyToRange);
      if (!floodCheck.ok) {
        logger.warn(`[AgentLoop] ${floodCheck.reason}`);
        return { error: floodCheck.reason };
      }

      // Preflight read: verify target cells are empty before writing (trust UX)
      if (params.allow_overwrite === false && requestClientTool && params.cells && Object.keys(params.cells).length > 0) {
        const bounds = getCellRangeBounds(params.cells);
        if (bounds) {
          try {
            const preflight = await requestClientTool('workbook.readRange', {
              sheet: targetSheet,
              target: bounds,
              format: 'snapshot'
            });
            const values = preflight.values || [];
            const nonEmpty = [];
            for (let r = 0; r < values.length && nonEmpty.length < 5; r++) {
              for (let c = 0; c < values[r].length && nonEmpty.length < 5; c++) {
                const v = values[r][c];
                if (v !== null && v !== undefined && v !== '') {
                  nonEmpty.push({ row: r + 1, col: indexToCol(colToIndex(bounds.match(/^([A-Z]+)/)[1]) + c), value: String(v).slice(0, 50) });
                }
              }
            }
            if (nonEmpty.length > 0) {
              const conflictMsg = `Preflight CONFLICT: ${nonEmpty.length}+ cells in ${targetSheet}!${bounds} already contain data. Use allow_overwrite:true to force, or choose a different range.`;
              logger.warn(`[AgentLoop] ${conflictMsg}`);
              return {
                actions: [],
                _preflight: { conflict: true, range: bounds, sample: nonEmpty },
                _message: conflictMsg
              };
            }
          } catch (err) {
            logger.warn(`[AgentLoop] Preflight read failed for set_cell_range: ${err.message}. Proceeding without check.`);
          }
        }
      }

      return {
        actions: [{
          type: 'setCellRange',
          sheet: targetSheet,
          cells: expandPresetsInCells(params.cells),
          copyToRange: copyToRange,
          allow_overwrite: params.allow_overwrite,
          explanation: `Write ${Object.keys(params.cells || {}).length} cells to ${targetSheet}`
        }]
      };
    }
    case 'set_format': {
      const targetSheet = params.sheet || context?.activeSheet;
      if (!params.sheet) logger.warn(`[AgentLoop] set_format without 'sheet'; defaulting to "${targetSheet}".`);
      if (!targetSheet) return { error: 'set_format: missing sheet and no active sheet in context' };
      const target = params.target || params.range || params.addr || params.address;
      if (!target || typeof target !== 'string') return { error: 'set_format: missing or invalid target (aliases: range, addr, address)' };
      const rawOptions = params.options || params.format || params.style
        || params.cellStyles || params.cell_styles || params.styles
        || params.formatting || params.props || params.properties;
      if (!rawOptions || typeof rawOptions !== 'object') {
        return { error: 'set_format: missing options. Accepted aliases: format, style, cellStyles, styles, formatting.' };
      }
      const options = expandPresetInOptions(rawOptions);
      if (!options || Object.keys(options).length === 0) {
        return { error: `set_format: no supported format options after normalization. Provided keys: [${Object.keys(rawOptions).join(', ') || 'none'}].` };
      }
      return {
        actions: [{
          type: 'setCellFormat',
          sheet: targetSheet,
          target,
          options
        }]
      };
    }
    case 'bulk_set_cell_ranges': {
      // LLM kept passing "ranges" instead of "writes". Accept either.
      const writes = Array.isArray(params && (params.writes || params.ranges)) ? (params.writes || params.ranges) : [];
      if (writes.length === 0) {
        return { error: 'bulk_set_cell_ranges: "writes" must be a non-empty array (alias: "ranges").' };
      }
      if (writes.length > 32) {
        return { error: `bulk_set_cell_ranges: max 32 writes per call, got ${writes.length}` };
      }
      const actions = [];
      const accepted = [];
      const errors = [];
      for (let i = 0; i < writes.length; i++) {
        const w = writes[i] || {};
        const sheet = w.sheet || context?.activeSheet;
        if (!sheet) {
          errors.push({ index: i, reason: 'missing sheet' });
          continue;
        }
        if (!w.cells || typeof w.cells !== 'object' || Object.keys(w.cells).length === 0) {
          errors.push({ index: i, sheet, reason: 'missing or empty cells map' });
          continue;
        }
        let copyToRange = w.copyToRange;
        if (copyToRange && typeof copyToRange === 'object' && copyToRange.range) {
          copyToRange = copyToRange.range;
        }
        const floodCheck = detectScalarTextFloodFill(w.cells, copyToRange);
        if (!floodCheck.ok) {
          logger.warn(`[AgentLoop] bulk_set_cell_ranges entry ${i} (${sheet}): ${floodCheck.reason}`);
          errors.push({ index: i, sheet, reason: floodCheck.reason });
          continue;
        }
        accepted.push({ sheet, cellCount: Object.keys(w.cells).length });
        actions.push({
          type: 'setCellRange',
          sheet,
          cells: expandPresetsInCells(w.cells),
          copyToRange,
          allow_overwrite: w.allow_overwrite,
          explanation: `Write ${Object.keys(w.cells).length} cells to ${sheet}`
        });
      }
      if (actions.length === 0) {
        return { error: 'bulk_set_cell_ranges: no valid writes', errors };
      }
      return {
        ok: true,
        applied: accepted.length,
        sheets: Array.from(new Set(accepted.map(a => a.sheet))),
        cellsTotal: accepted.reduce((s, a) => s + a.cellCount, 0),
        errors: errors.length ? errors : undefined,
        actions
      };
    }
    case 'bulk_set_format': {
      // Accept "formats" (canonical) plus the aliases the LLM kept trying:
      // ranges, items, entries. Each entry is still { sheet, target, options }.
      const formats = Array.isArray(params && (params.formats || params.ranges || params.items || params.entries))
        ? (params.formats || params.ranges || params.items || params.entries)
        : [];
      if (formats.length === 0) {
        return { error: 'bulk_set_format: "formats" must be a non-empty array of { sheet, target, options } (aliases: ranges, items, entries).' };
      }
      if (formats.length > BULK_SET_FORMAT_MAX) {
        return { error: `bulk_set_format: max ${BULK_SET_FORMAT_MAX} formats per call, got ${formats.length}` };
      }
      const actions = [];
      const errors = [];
      const accepted = [];
      for (let i = 0; i < formats.length; i++) {
        const f = formats[i] || {};
        const sheet = f.sheet || context?.activeSheet;
        if (!sheet) {
          errors.push({ index: i, reason: 'missing sheet' });
          continue;
        }
        // Accept target / range / addr / address — the LLM has tried them all.
        const target = f.target || f.range || f.addr || f.address;
        if (!target || typeof target !== 'string') {
          errors.push({ index: i, sheet, reason: 'missing or invalid target (aliases: range, addr, address)' });
          continue;
        }
        // Options aliases — the LLM nests under many names. Accept every shape
        // we have seen in production logs so it stays on this structured path
        // instead of falling back to brittle hand-written execute_office_js.
        const rawOptions = f.options || f.format || f.style
          || f.cellStyles || f.cell_styles || f.styles
          || f.formatting || f.props || f.properties;
        if (!rawOptions || typeof rawOptions !== 'object') {
          const seenKeys = Object.keys(f).filter(k => !['sheet', 'target', 'range', 'addr', 'address'].includes(k));
          errors.push({
            index: i,
            sheet,
            target,
            reason: `missing options. Pass the formatting as "options" (aliases also accepted: format, style, cellStyles, styles, formatting). Keys seen on this entry: [${seenKeys.join(', ') || 'none'}].`
          });
          continue;
        }
        const options = expandPresetInOptions(rawOptions);
        if (!options || Object.keys(options).length === 0) {
          errors.push({
            index: i,
            sheet,
            target,
            reason: `no supported format options after normalization. Provided keys: [${Object.keys(rawOptions).join(', ') || 'none'}]. Use backgroundColor / fontColor / bold / italic / numberFormat / columnWidth / rowHeight / horizontalAlignment / borders.`
          });
          continue;
        }
        accepted.push({ sheet, target });
        actions.push({
          type: 'setCellFormat',
          sheet,
          target,
          options
        });
      }
      if (actions.length === 0) {
        return { error: 'bulk_set_format: no valid formats', errors };
      }
      return {
        ok: true,
        applied: accepted.length,
        errors: errors.length ? errors : undefined,
        actions
      };
    }
    case 'format_workbook': {
      // One-shot semantic cleanup pass over many sheets. Defaults to ALL
      // sheets in the workbook when params.sheets is empty/missing.
      const explicitSheets = Array.isArray(params && params.sheets) ? params.sheets.filter(s => typeof s === 'string' && s) : [];
      const fallbackSheets = Array.isArray(context && context.workbookSheets) ? context.workbookSheets : [];
      const sheets = explicitSheets.length > 0 ? explicitSheets : fallbackSheets;
      if (sheets.length === 0) {
        return { error: 'format_workbook: no sheets to format (workbook context empty and no "sheets" arg given).' };
      }
      try {
        const { runFormatAgent } = require('./specialists');
        const result = await runFormatAgent(
          { sheets, mode: params.mode || 'institutional_finance' },
          { results: [] }
        );
        const actions = Array.isArray(result && result.actions) ? result.actions : [];
        if (actions.length === 0) {
          return { ok: true, sheets, actions: [], note: 'No format actions produced (sheets may be empty).' };
        }
        return {
          ok: true,
          sheets,
          mode: params.mode || 'institutional_finance',
          actionCount: actions.length,
          actions: actions.map(a => a.explanation ? a : ({ ...a, explanation: `format ${a.sheet || ''}` }))
        };
      } catch (err) {
        return { error: `format_workbook failed: ${err.message || String(err)}` };
      }
    }
    case 'bulk_set_notes': {
      const notes = Array.isArray(params && params.notes) ? params.notes : [];
      if (notes.length === 0) return { error: 'bulk_set_notes: "notes" must be a non-empty array' };
      if (notes.length > 64) return { error: `bulk_set_notes: max 64 notes per call, got ${notes.length}` };
      const collected = [];
      const errors = [];
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i] || {};
        const sheet = n.sheet || context?.activeSheet;
        if (!n.cell || typeof n.cell !== 'string') {
          errors.push({ index: i, reason: 'missing or invalid cell' });
          continue;
        }
        if (n.note == null || n.note === '') {
          errors.push({ index: i, cell: n.cell, reason: 'missing note text' });
          continue;
        }
        collected.push({ sheet, addr: n.cell, text: String(n.note) });
      }
      if (collected.length === 0) return { error: 'bulk_set_notes: no valid notes', errors };
      return {
        ok: true,
        applied: collected.length,
        errors: errors.length ? errors : undefined,
        actions: [{ type: 'setNotes', notes: collected }]
      };
    }
    case 'execute_excel_formula': {
      const targetSheet = params.sheet || context?.activeSheet;
      if (!params.sheet) logger.warn(`[AgentLoop] execute_excel_formula without 'sheet'; defaulting to "${targetSheet}".`);
      return {
        actions: [{
          type: 'setCellRange',
          sheet: targetSheet,
          cells: {
            [params.target]: {
              formula: params.formula,
              ...(params.note ? { note: params.note } : {})
            }
          }
        }]
      };
    }
    case 'add_chart': {
      const targetSheet = params.sheet || context?.activeSheet;
      if (!params.sheet) logger.warn(`[AgentLoop] add_chart without 'sheet'; defaulting to "${targetSheet}".`);
      return {
        actions: [{
          type: 'createChart',
          sheet: targetSheet,
          target: params.target,
          options: params.options
        }]
      };
    }
    case 'execute_python': {
      return await executePythonCode(params.code);
    }
    case 'web_search': {
      const searchResult = await executeTool('web.search', params || {}, toolMemory);
      return searchResult.data || searchResult;
    }
    case 'web_fetch': {
      const fetchResult = await executeTool('web.fetch', params || {}, toolMemory);
      return fetchResult.data || fetchResult;
    }
    case 'ask_user_question': {
      return {
        type: 'ask_user_question',
        questions: params.questions
      };
    }
    case 'todo_write': {
      return {
        type: 'todo_write',
        todos: params.todos
      };
    }
    case 'execute_office_js': {
      // RPC path: wait for the client to execute and return real values/logs/errors.
      // This avoids the legacy fire-and-forget echo, which forced the LLM to spend
      // extra iterations on read-after-write verification.
      // Accept common alias names for the code param — the LLM kept calling with
      // `params`, `script`, `js`, `source`, `body` and burning an iteration on
      // "wrong parameter name". Normalize them here.
      let code = params.code;
      if (code == null) code = params.script || params.js || params.source || params.body;
      // params.params is rare but appeared in prod logs (loops 17/21/25/43/62).
      // Only accept it when it's a string of code, not a nested object.
      if (code == null && typeof params.params === 'string') code = params.params;
      if (!code || typeof code !== 'string' || code.trim().length === 0) {
        return {
          error: 'execute_office_js: missing "code" param (string of JS to run). Accepted aliases: code, script, js, source, body. Do NOT pass the code inside a "params" object.'
        };
      }
      if (requestClientTool) {
        try {
          const rpc = await requestClientTool('runJavaScript', { code });
          // rpc shape from client: { ok, value, logs, error }
          if (rpc && rpc.error) {
            return {
              error: rpc.error,
              logs: Array.isArray(rpc.logs) ? rpc.logs : [],
              _message: `execute_office_js error: ${rpc.error}${Array.isArray(rpc.logs) && rpc.logs.length ? `\nLogs:\n${rpc.logs.join('\n').slice(0, 1500)}` : ''}`
            };
          }
          const value = rpc && Object.prototype.hasOwnProperty.call(rpc, 'value') ? rpc.value : null;
          const noReturn = value === null || value === undefined;
          return {
            ok: true,
            value,
            logs: rpc && Array.isArray(rpc.logs) ? rpc.logs : [],
            _message: noReturn
              ? 'execute_office_js: code executed successfully (no return value — your code did not explicitly return anything). Do NOT retry the same code. If you need to verify state, read it with get_cell_ranges / read_sheet.'
              : 'execute_office_js: code executed successfully.'
          };
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          logger.warn(`[AgentLoop] execute_office_js RPC failed (${msg})`);
          return {
            error: `execute_office_js failed: ${msg}. The runJavaScript tool may be unavailable on this client. Use structured tools (set_cell_range, create_sheet, set_format) instead.`,
            _message: `execute_office_js RPC failed: ${msg}. Use structured tools instead.`
          };
        }
      }
      // No client channel available — cannot execute Office.js code.
      return {
        error: 'execute_office_js: no client channel available. Use structured tools (set_cell_range, create_sheet, set_format) instead.'
      };
    }
    case 'context_snip': {
      // Trigger real context compaction if conversation is too long
      const COMPACT_THRESHOLD = 25;
      if (messages.length > COMPACT_THRESHOLD) {
        const keepCount = 8; // keep last 8 messages for continuity
        const toCompact = messages.slice(1, messages.length - keepCount); // skip system prompt, keep recent
        // Build a summary of compacted messages
        const summaryParts = [];
        for (const m of toCompact) {
          if (m.role === 'assistant') {
            try {
              const parsed = JSON.parse(m.content);
              if (parsed.tool && parsed.tool !== 'done' && parsed.tool !== 'todo_write' && parsed.tool !== 'context_snip') {
                summaryParts.push(`[${parsed.tool}]: ${(parsed.thought || '').slice(0, 80)}`);
              }
            } catch (_) {
              summaryParts.push(m.content.slice(0, 80));
            }
          } else if (m.role === 'user' && m.content.startsWith('Tool result')) {
            // Skip tool results in summary
            continue;
          }
        }
        const summary = summaryParts.length > 0
          ? 'CONVERSATION SUMMARY (compressed ' + toCompact.length + ' messages):\n' + summaryParts.join('\n').slice(0, 2000)
          : '';

        // Replace old messages: keep system prompt + summary + recent messages
        const newMessages = [messages[0]]; // system prompt
        if (summary) {
          newMessages.push(makeUserMessage(summary + '\n\nContinue from where you left off.'));
        }
        newMessages.push(...messages.slice(messages.length - keepCount));
        // Mutate the array in-place
        messages.length = 0;
        messages.push(...newMessages);
        logger.info(`[AgentLoop] Context compacted: ${toCompact.length} messages -> summary (${summary.length} chars). New length: ${messages.length}`);
      }
      return { ok: true, note: `Context snip applied. Messages: ${messages.length}` };
    }
    /* ---------- Bundled finance calls (parallel) ---------- */
    case 'finance_company_bundle': {
      const symbolNorm = normalizeOpenBBSymbolParams(params || {});
      const symbol = symbolNorm.symbol;
      if (!symbol) {
        return { error: 'finance_company_bundle: "symbol" is required' };
      }
      const period = (params && params.period) === 'quarter' ? 'quarter' : 'annual';
      const wanted = Array.isArray(params && params.include) && params.include.length
        ? new Set(params.include)
        : new Set(['profile', 'metrics', 'balance', 'income', 'cashflow']);
      const baseArgs = { ...symbolNorm };
      const periodArgs = { ...symbolNorm, period };
      const datasets = [
        wanted.has('profile')   && ['profile',  () => executeTool('openbb.equity.profile',                 baseArgs,   toolMemory)],
        wanted.has('metrics')   && ['metrics',  () => executeTool('openbb.equity.fundamentals.metrics',    baseArgs,   toolMemory)],
        wanted.has('balance')   && ['balance',  () => executeTool('openbb.equity.fundamentals.balance',    periodArgs, toolMemory)],
        wanted.has('income')    && ['income',   () => executeTool('openbb.equity.fundamentals.income',     periodArgs, toolMemory)],
        wanted.has('cashflow')  && ['cashflow', () => executeTool('openbb.equity.fundamentals.cash',       periodArgs, toolMemory)]
      ].filter(Boolean);
      const settled = await Promise.allSettled(datasets.map(([, fn]) => fn()));
      const out = { symbol, period, errors: {} };
      settled.forEach((res, idx) => {
        const key = datasets[idx][0];
        if (res.status === 'fulfilled') {
          out[key] = (res.value && res.value.data !== undefined) ? res.value.data : res.value;
        } else {
          const msg = res.reason && res.reason.message ? res.reason.message : String(res.reason);
          out.errors[key] = msg;
        }
      });
      if (Object.keys(out.errors).length === 0) delete out.errors;
      return out;
    }
    case 'macro_snapshot': {
      const country = (params && params.country) || 'united_states';
      const wanted = Array.isArray(params && params.include) && params.include.length
        ? new Set(params.include)
        : new Set(['treasury', 'fed_rate', 'cpi', 'gdp', 'unemployment']);
      const datasets = [
        wanted.has('treasury')     && ['treasury',     () => executeTool('openbb.fixedincome.treasury', {}, toolMemory)],
        wanted.has('fed_rate')     && ['fed_rate',     () => executeTool('openbb.fixedincome.effr',     {}, toolMemory)],
        wanted.has('cpi')          && ['cpi',          () => executeTool('openbb.economy.cpi',          { country }, toolMemory)],
        wanted.has('gdp')          && ['gdp',          () => executeTool('openbb.economy.gdp_real',     { country }, toolMemory)],
        wanted.has('unemployment') && ['unemployment', () => executeTool('openbb.economy.unemployment', { country }, toolMemory)]
      ].filter(Boolean);
      const settled = await Promise.allSettled(datasets.map(([, fn]) => fn()));
      const out = { country, errors: {} };
      settled.forEach((res, idx) => {
        const key = datasets[idx][0];
        if (res.status === 'fulfilled') {
          out[key] = (res.value && res.value.data !== undefined) ? res.value.data : res.value;
        } else {
          const msg = res.reason && res.reason.message ? res.reason.message : String(res.reason);
          out.errors[key] = msg;
        }
      });
      if (Object.keys(out.errors).length === 0) delete out.errors;
      return out;
    }
    /* ---------- OpenBB Financial Data ---------- */
    case 'openbb_equity_profile': {
      const r = await executeTool('openbb.equity.profile', normalizeOpenBBSymbolParams(params || {}), toolMemory);
      return r.data || r;
    }
    case 'openbb_equity_metrics': {
      const r = await executeTool('openbb.equity.fundamentals.metrics', normalizeOpenBBSymbolParams(params || {}), toolMemory);
      return r.data || r;
    }
    case 'openbb_equity_balance': {
      const r = await executeTool('openbb.equity.fundamentals.balance', normalizeOpenBBSymbolParams(params || {}), toolMemory);
      return r.data || r;
    }
    case 'openbb_equity_income': {
      const r = await executeTool('openbb.equity.fundamentals.income', normalizeOpenBBSymbolParams(params || {}), toolMemory);
      return r.data || r;
    }
    case 'openbb_equity_cashflow': {
      const r = await executeTool('openbb.equity.fundamentals.cash', normalizeOpenBBSymbolParams(params || {}), toolMemory);
      return r.data || r;
    }
    case 'openbb_treasury_rates': {
      const r = await executeTool('openbb.fixedincome.treasury', params || {}, toolMemory);
      return r.data || r;
    }
    case 'openbb_fed_rate': {
      const r = await executeTool('openbb.fixedincome.effr', params || {}, toolMemory);
      return r.data || r;
    }
    case 'openbb_cpi': {
      const r = await executeTool('openbb.economy.cpi', params || {}, toolMemory);
      return r.data || r;
    }
    case 'openbb_gdp': {
      const r = await executeTool('openbb.economy.gdp_real', params || {}, toolMemory);
      return r.data || r;
    }
    case 'openbb_unemployment': {
      const r = await executeTool('openbb.economy.unemployment', params || {}, toolMemory);
      return r.data || r;
    }
    case 'read_skill': {
      const skillData = readSkill(params && params.name);
      return skillData;
    }
    case 'update_instructions': {
      const result = updateInstructions(params);
      return { data: result, actions: [] };
    }
    case 'read_instructions': {
      const instr = require('../utils/instructions');
      return { data: { content: instr.loadInstructions() }, actions: [] };
    }
    default:
      // Fallback: try registry tool (e.g. yahoo.quote, llm.planLayout, etc.)
      if (registry.has(toolName)) {
        const result = await executeTool(toolName, params || {}, {
          runtime: { requestClientTool: requestClientTool || (async () => { throw new Error('Client tool not available'); }) }
        });
        return result.data || result;
      }
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

/* ---------- Python Execution ---------- */
const { executePython } = require('../tools/python');

async function executePythonCode(code) {
  logger.info(`[Python] Executing code (${code.length} chars)`);
  try {
    const result = await executePython(code);
    return { success: true, result: result.stdout, stderr: result.stderr, code };
  } catch (e) {
    return { success: false, error: e.message, code };
  }
}

/* ==========================================================================
 * STEPWISE AGENT ENGINE (serverless-friendly, client-driven)
 *
 * runAgentLoop (above) is the server-driven loop: it owns the while loop and
 * blocks on requestClientTool for every Excel read. That model dies on
 * serverless (background work killed after the HTTP response; 300s function
 * cap; in-memory state lost on reconnect).
 *
 * The stepwise engine inverts control: the CLIENT drives the loop, the server
 * does ONE iteration per HTTP request and is fully stateless across calls.
 * `runAgentStep(state, clientResult)` advances the loop by exactly one LLM
 * turn and returns a `control` telling the client what to do next:
 *   - continue       → call step again immediately
 *   - emit_actions   → apply payload.actions to Excel, then call step again
 *   - await_client   → run payload.requests (Excel reads), return results, step
 *   - paused         → show payload.question, return answer, step
 *   - done / aborted  → terminal
 *
 * Reuse strategy: executeAgentTool stays the single source of truth for tool
 * behavior + result formatting. We discover which client reads a tool needs by
 * a "dry-run collect" pass (placeholderBroker returns {} for each client call;
 * every read formatter guards with `|| default`, so the dry result is only
 * trusted when ZERO client calls were made). On resume we re-run the tool ONCE
 * with a replay broker that feeds the real client data back in call order.
 * parallel_calls is split explicitly so server sub-tools (openbb/web — side
 * effects) run exactly once and only client sub-tools are deferred.
 * ======================================================================== */

const CLIENT_READ_TOOLS = new Set([
  'read_workbook',
  'read_sheet',
  'get_cell_ranges',
  'get_range_as_csv',
  'list_named_ranges',
  'build_workbook_graph'
]);
// Tools that MAY need a client round-trip: reads + execute_office_js (runs JS
// on the client) + set_cell_range (conditional allow_overwrite preflight read).
const CLIENT_CAPABLE_TOOLS = new Set([
  ...CLIENT_READ_TOOLS,
  'set_cell_range',
  'execute_office_js'
]);

const STEP_FATAL_ERROR_PATTERNS = [
  /no api key configured/i,
  /invalid api key/i,
  /authentication failed/i,
  /unauthorized/i,
  /402/i,
  /payment required/i,
  /credit exhausted/i,
  /insufficient quota/i,
  /rate limit/i
];

// Build the initial serializable run state. Mirrors runAgentLoop's prompt
// construction (1547-1599) but produces a plain object that survives
// JSON round-trips through Supabase between HTTP requests.
function initAgentRun(objective, context, options = {}) {
  const promptVariant = options.promptVariant || DEFAULT_PROMPT_VARIANT;
  const systemPromptForRun = getSystemPrompt(promptVariant);

  const compactCtx = compactAgentContext(context);
  const overview = buildWorkbookOverview(context);
  let userPrompt = `Goal: ${objective}\n\n${overview}\n\nWorkbook context (compact JSON):\n${JSON.stringify(compactCtx, null, 2)}\n\nProceed step by step. When writing, ALWAYS pass an explicit "sheet" parameter — the active sheet at task start may NOT be where the user wants the data.`;
  const lowerObjective = String(objective || '').toLowerCase();
  if (lowerObjective.includes('apple') || lowerObjective.includes('aapl')) {
    userPrompt += `\n\nHINT — These publicly known Apple FY2024 figures are rough sanity-check anchors, not live sources:\n- Revenue: ~$394B\n- Net Income: ~$97B\n- EBITDA: ~$120B\n- CapEx: ~$10B\n- D&A: ~$12B\n- Shares Outstanding: ~15.5B\n- Cash & Equivalents: ~$70B\n- Total Debt: ~$110B\n- Tax Rate: ~16%\nVerify or update current market/filing inputs with tools when available, then build the model with visible sources and review flags.`;
  }

  let skillReminder = '';
  const suggestedSkills = detectSkills(objective);
  if (suggestedSkills.length > 0) {
    const loaded = suggestedSkills.map(name => readSkill(name)).filter(Boolean);
    if (loaded.length > 0) {
      skillReminder = `<system-reminder>\nPre-loaded skill${loaded.length > 1 ? 's' : ''} based on user request: ${suggestedSkills.join(', ')}.\n\n` +
        loaded.map(s => `--- ${s.name} ---\n${s.content.slice(0, 4000)}`).join('\n\n') +
        '\n</system-reminder>';
    }
  }
  const systemPromptAddendum = typeof options.systemPromptAddendum === 'string' && options.systemPromptAddendum.trim()
    ? '\n\n' + options.systemPromptAddendum.trim()
    : '';

  const explicitCap = options.maxIterations || Number(process.env.AGENT_MAX_ITER);
  const maxIterations = explicitCap && explicitCap > 0 ? explicitCap : 10000;

  return {
    objective,
    context,
    messages: [
      { role: 'system', content: systemPromptForRun + (skillReminder ? '\n\n' + skillReminder : '') + systemPromptAddendum },
      makeUserMessage(userPrompt)
    ],
    results: [],
    iteration: 0,
    codeLog: [],
    consecutiveErrors: 0,
    lastErrorMessage: '',
    webSearchCount: 0,
    parseFailureStreak: 0,
    forceThinkingNext: false,
    loadedSkillNames: [],
    recentToolTrail: [],
    touchedSheets: [],
    status: 'running',
    pending: null,
    summary: null,
    abortReason: null,
    config: {
      promptVariant,
      modelOverride: options.modelOverride || null,
      maxIterations,
      maxConsecutiveErrors: options.maxConsecutiveErrors || 4,
      timeoutMs: options.timeoutMs || Number(process.env.AGENT_LLM_TIMEOUT_MS) || 300000,
      fallbackTimeoutMs: options.fallbackTimeoutMs || Number(process.env.AGENT_LLM_FALLBACK_TIMEOUT_MS) || 180000,
      forceThinkingDisabled: options.forceThinkingDisabled === true,
      postWriteCriticEnabled: options.postWriteCriticEnabled,
      autoFormatOnDone: options.autoFormatOnDone === true ||
        (options.autoFormatOnDone !== false && AGENT_AUTO_FORMAT_ON_DONE),
      maxWebSearch: Number(process.env.AGENT_MAX_WEB_SEARCH) || 20,
      disabledTools: Array.isArray(options.disabledTools) ? options.disabledTools.filter(t => typeof t === 'string') : []
    }
  };
}

function markSkillLoaded(state, params) {
  const n = String((params && params.name) || '').trim();
  if (n && !state.loadedSkillNames.includes(n)) state.loadedSkillNames.push(n);
}

function terminalControl(state) {
  if (state.status === 'completed') return { state, control: 'done', payload: { summary: state.summary } };
  return { state, control: 'aborted', payload: { reason: state.abortReason } };
}

// Dry-run a tool to discover the client read requests it would make, without
// performing the real round-trip. Trust the dryResult ONLY when requests is
// empty (then no client was needed and the tool ran for real).
async function collectToolClientRequests(toolName, params, context) {
  const requests = [];
  const placeholderBroker = async (clientTool, clientParams) => {
    requests.push({
      id: `creq-${requests.length}-${Date.now().toString(36)}`,
      toolName: clientTool,
      params: clientParams || {}
    });
    return {};
  };
  let dryResult = null;
  try {
    dryResult = await executeAgentTool(toolName, params, context, placeholderBroker);
  } catch (e) {
    dryResult = { error: e && e.message ? e.message : String(e) };
  }
  return { requests, dryResult };
}

// Re-run a tool with pre-fetched client results. The replay broker returns
// staged data in the same order the tool calls requestClientTool.
async function runToolWithStagedResults(toolName, params, context, staged) {
  let i = 0;
  const replayBroker = async () => {
    const entry = staged[i++];
    if (entry && entry.error) throw new Error(entry.error);
    if (entry && entry.data !== undefined) return entry.data;
    return entry !== undefined && entry !== null ? entry : {};
  };
  return executeAgentTool(toolName, params, context, replayBroker);
}

// Normalize whatever the client sent back into an ordered [{data}|{error}] list.
function normalizeClientResults(clientResult) {
  if (!clientResult) return [];
  const arr = Array.isArray(clientResult)
    ? clientResult
    : Array.isArray(clientResult.results) ? clientResult.results : [];
  return arr.map(r => {
    if (r && typeof r === 'object') {
      if (r.response) return r.response;
      if (r.data !== undefined || r.error !== undefined) return r;
    }
    return { data: r };
  });
}

function bulkNudgeFor(lastN) {
  if (lastN.length !== 2) return null;
  if (lastN.every(n => n === 'set_cell_range')) {
    return 'BATCH HINT (HARD): you just called set_cell_range twice. Your NEXT write MUST be bulk_set_cell_ranges with ALL remaining sections in one call (cap 32 entries). Sequential set_cell_range calls in a slice worker burn the iter budget and have cascade-killed downstream waves in prior runs. After all data lands, run ONE bulk_set_format pass.';
  }
  if (lastN.every(n => n === 'set_format')) {
    return 'BATCH HINT: you just called set_format twice in a row. Consolidate the next formats into ONE bulk_set_format call based on the observed ranges.';
  }
  if (lastN.every(n => n === 'create_sheet')) {
    return 'BATCH HINT: you just created two sheets one at a time. If more are coming, use bulk_create_sheets with the full list.';
  }
  if (lastN.every(n => n === 'create_named_range')) {
    return 'BATCH HINT: you just created two named ranges one at a time. Use bulk_create_named_ranges with the full list of remaining inputs.';
  }
  return null;
}

// Mirror of runAgentLoop's auto-compaction (2006-2051), operating on state.messages.
function autoCompactMessages(state) {
  const messages = state.messages;
  const AUTO_COMPACT_LIMIT = Number(process.env.AGENT_AUTO_COMPACT_LIMIT) || 80;
  if (messages.length <= AUTO_COMPACT_LIMIT) return;
  const keepCount = Number(process.env.AGENT_AUTO_COMPACT_KEEP) || 12;
  const toCompact = messages.slice(1, messages.length - keepCount);
  const userMsgs = toCompact.filter(m => m.role === 'user');
  let snipApplied = false;
  if (userMsgs.length >= 2) {
    const firstId = extractMsgId(userMsgs[0].content);
    const lastId = extractMsgId(userMsgs[userMsgs.length - 1].content);
    if (firstId && lastId) {
      const snipResult = snipContext(messages, firstId, lastId, 'Auto-compacted history');
      if (snipResult.ok) snipApplied = true;
    }
  }
  if (snipApplied) return;
  const compacted = toCompact.filter(m => {
    if (m.role === 'assistant') {
      try { const p = JSON.parse(m.content); return p.tool && !['done', 'todo_write', 'context_snip'].includes(p.tool); }
      catch (_) { return m.content.length > 50; }
    }
    return m.role === 'user' && !m.content.startsWith('Tool result') && !m.content.startsWith('CONVERSATION SUMMARY');
  });
  const compactLines = compacted.map(m => {
    if (m.role === 'assistant') {
      try { const p = JSON.parse(m.content); return `[${p.tool}] ${(p.thought || '').slice(0, 100)}`; }
      catch (_) { return m.content.slice(0, 100); }
    }
    return m.content.slice(0, 100);
  });
  if (compactLines.length === 0) return;
  const summary = 'AUTO-COMPACTED HISTORY (' + toCompact.length + ' msgs):\n' + compactLines.join('\n').slice(0, 3000);
  const newMsgs = [messages[0], makeUserMessage(summary + '\n\nContinue from where you left off.'), ...messages.slice(messages.length - keepCount)];
  messages.length = 0;
  messages.push(...newMsgs);
}

async function callStepLLM(state, deps) {
  const doLLM = deps.callLLM || callLLM;
  const useThinking = state.config.forceThinkingDisabled
    ? false
    : shouldUseAgentThinking(state.iteration, {
        forceThinkingNext: state.forceThinkingNext,
        consecutiveErrors: state.consecutiveErrors,
        parseFailureStreak: state.parseFailureStreak,
        lastToolName: state.recentToolTrail.length > 0 ? state.recentToolTrail[state.recentToolTrail.length - 1].toolName : null
      });
  const modelForRun = resolveAgentLoopModel(state.config.modelOverride || undefined, state.config.promptVariant);
  const llmResult = await doLLM({
    messages: state.messages,
    timeoutMs: state.config.timeoutMs,
    fallbackTimeoutMs: state.config.fallbackTimeoutMs,
    label: `AgentStep iter ${state.iteration}`,
    modelOverride: modelForRun,
    thinkingDisabled: !useThinking,
    reasoningEffort: useThinking ? (process.env.DEEPSEEK_REASONING_EFFORT || 'high') : AGENT_REASONING_EFFORT
  });
  return { llmResult, useThinking };
}

function handleAskUser(state, toolName, params, thought, onProgress) {
  let questionData = toolName === 'ask_user_question' ? params.questions : params.question;
  if (!questionData && params.question) questionData = Array.isArray(params.question) ? params.question : [params.question];
  if (!questionData || (Array.isArray(questionData) && questionData.length === 0)) {
    state.messages.push(makeUserMessage('You called ask_user_question with no valid questions. The "questions" parameter must be a non-empty array of objects with "question" (or "header") and "options" fields. Call ask_user_question again with a proper question.'));
    return { state, control: 'continue', payload: { thought } };
  }
  const autoAnswer = tryAutoAnswer(questionData, state.context, state.objective);
  if (autoAnswer) {
    state.messages.push(makeUserMessage(`Auto-answered: ${autoAnswer}. Do NOT ask again unless absolutely critical. Proceed with the task.`));
    state.results.push({ type: 'ask_user', question: questionData, autoAnswer });
    onProgress('agentAutoAnswer', { question: questionData, answer: autoAnswer, iteration: state.iteration });
    return { state, control: 'continue', payload: { thought } };
  }
  state.results.push({ type: 'ask_user', question: questionData });
  state.status = 'paused';
  state.pending = { kind: 'question', question: questionData, thought };
  onProgress('agentPaused', { reason: 'user_input_required', question: questionData, iteration: state.iteration });
  return { state, control: 'paused', payload: { question: questionData } };
}

function handleStepError(state, error, onProgress) {
  const msg = error && error.message ? error.message : String(error);
  if (STEP_FATAL_ERROR_PATTERNS.some(p => p.test(msg))) {
    state.status = 'aborted';
    state.abortReason = `fatal_error: ${msg}`;
    state.results.push({ type: 'error', error: msg, fatal: true });
    onProgress('iterationError', { iteration: state.iteration, error: msg, fatal: true });
    return { state, control: 'aborted', payload: { reason: state.abortReason } };
  }
  if (msg === state.lastErrorMessage) state.consecutiveErrors++;
  else { state.consecutiveErrors = 1; state.lastErrorMessage = msg; }
  state.results.push({ type: 'error', error: msg });
  onProgress('iterationError', { iteration: state.iteration, error: msg });
  if (AGENT_FORCE_THINKING_AFTER_ERROR) state.forceThinkingNext = true;
  if (state.consecutiveErrors >= state.config.maxConsecutiveErrors) {
    state.status = 'aborted';
    state.abortReason = `repeated_error_x${state.consecutiveErrors}: ${msg}`;
    return { state, control: 'aborted', payload: { reason: state.abortReason } };
  }
  state.messages.push(makeUserMessage(`Error: ${msg}. Please try a different approach.`));
  return { state, control: 'continue', payload: {} };
}

function buildParallelPlan(callsInput) {
  return callsInput.map((c, idx) => {
    const tool = c && typeof c.tool === 'string' ? c.tool : '';
    // Accept both shapes the LLM may emit:
    //   { tool: "get_range_as_csv", params: { sheet, target } }
    //   { tool: "get_range_as_csv", sheet, target }            // flat — common LLM mistake
    // Without this dual handling, the flat form silently produced 8 reads of
    // the active sheet (Sensitivity), confirmed on the 2026-05-30 multi-sheet
    // format run.
    let innerParams;
    if (c && typeof c.params === 'object' && c.params !== null) {
      innerParams = c.params;
    } else if (c && typeof c === 'object') {
      const { tool: _t, ...rest } = c;
      innerParams = Object.keys(rest).length > 0 ? rest : {};
    } else {
      innerParams = {};
    }
    if (!tool) return { idx, tool, ok: false, error: 'missing "tool" field', skipped: true };
    if (tool === 'parallel_calls') return { idx, tool, ok: false, error: 'parallel_calls cannot be nested', skipped: true };
    if (!PARALLEL_SAFE_TOOLS.has(tool)) return { idx, tool, ok: false, error: `tool "${tool}" not allowed inside parallel_calls (read-only allowlist only)`, skipped: true };
    return { idx, tool, params: innerParams };
  });
}

async function assembleParallelResult(state, pending, staged) {
  const { planned, serverResults, clientPlan, callsLength } = pending;
  const results = new Array(callsLength);
  for (const p of planned) {
    if (p.skipped) results[p.idx] = { tool: p.tool, ok: false, error: p.error };
  }
  for (const idxStr of Object.keys(serverResults || {})) {
    const idx = Number(idxStr);
    const val = serverResults[idxStr];
    const p = planned.find(x => x.idx === idx);
    if (val && val.__error) results[idx] = { tool: p && p.tool, ok: false, error: val.__error };
    else if (val && val.error) results[idx] = { tool: p && p.tool, ok: false, error: val.error };
    else results[idx] = { tool: p && p.tool, ok: true, value: val };
  }
  for (const cp of (clientPlan || [])) {
    const sub = staged.slice(cp.reqStart, cp.reqStart + cp.reqCount);
    try {
      const val = await runToolWithStagedResults(cp.toolName, cp.params, state.context, sub);
      if (val && val.error) results[cp.idx] = { tool: cp.toolName, ok: false, error: val.error };
      else results[cp.idx] = { tool: cp.toolName, ok: true, value: val };
    } catch (e) {
      results[cp.idx] = { tool: cp.toolName, ok: false, error: e && e.message ? e.message : String(e) };
    }
  }
  const okCount = results.filter(r => r && r.ok).length;
  return { results, summary: { total: results.length, ok: okCount, errors: results.length - okCount } };
}

async function startParallelCalls(state, params, thought, deps, onProgress) {
  const callsInput = Array.isArray(params && params.calls) ? params.calls : [];
  if (callsInput.length === 0) {
    return finishToolExecution(state, 'parallel_calls', params, thought, { error: 'parallel_calls: "calls" must be a non-empty array' }, deps, onProgress);
  }
  if (callsInput.length > 8) {
    return finishToolExecution(state, 'parallel_calls', params, thought, { error: `parallel_calls: max 8 calls per batch, got ${callsInput.length}` }, deps, onProgress);
  }
  const planned = buildParallelPlan(callsInput);
  const serverResults = {};
  const clientPlan = [];
  const allRequests = [];
  for (const p of planned) {
    if (p.skipped) continue;
    if (CLIENT_READ_TOOLS.has(p.tool)) {
      const { requests } = await collectToolClientRequests(p.tool, p.params, state.context);
      clientPlan.push({ idx: p.idx, toolName: p.tool, params: p.params, reqStart: allRequests.length, reqCount: requests.length });
      for (const r of requests) allRequests.push(r);
    } else {
      try { serverResults[p.idx] = await executeAgentTool(p.tool, p.params, state.context, null); }
      catch (e) { serverResults[p.idx] = { __error: e && e.message ? e.message : String(e) }; }
    }
  }
  const pendingSpec = { planned, serverResults, clientPlan, callsLength: callsInput.length };
  if (allRequests.length === 0) {
    const toolResult = await assembleParallelResult(state, pendingSpec, []);
    return finishToolExecution(state, 'parallel_calls', params, thought, toolResult, deps, onProgress);
  }
  state.pending = { kind: 'parallel', params, thought, requests: allRequests, ...pendingSpec };
  state.status = 'awaiting_client';
  return { state, control: 'await_client', payload: { thought, requests: allRequests } };
}

async function finishToolExecution(state, toolName, params, thought, toolResult, deps, onProgress) {
  if (toolResult && toolResult._preflight && toolResult._preflight.conflict) {
    state.results.push({ type: 'preflight_conflict', tool: toolName, ...toolResult._preflight });
    state.messages.push(makeUserMessage(toolResult._message));
    onProgress('preflightConflict', { tool: toolName, ...toolResult._preflight });
    return { state, control: 'continue', payload: { thought } };
  }

  let actions = null;
  if (toolResult && Array.isArray(toolResult.actions) && toolResult.actions.length > 0) {
    if (!Array.isArray(state.touchedSheets)) state.touchedSheets = [];
    const touchedSet = new Set(state.touchedSheets);
    actions = toolResult.actions.map((a, idx) => {
      let enriched = a;
      if (!a.explanation) {
        const parts = [a.type];
        if (a.sheet) parts.push(`on ${a.sheet}`);
        if (a.target) parts.push(a.target);
        else if (a.cells) parts.push(`${Object.keys(a.cells).length} cells`);
        else if (a.name) parts.push(`"${a.name}"`);
        enriched = { ...a, explanation: parts.join(' ').slice(0, 50) };
      }
      if (idx === 0 && toolResult._preflight) enriched = { ...enriched, _preflight: toolResult._preflight };
      if (a && (a.type === 'setCellRange' || a.type === 'setCellValue' || a.type === 'writeRange' || a.type === 'fillRange' || a.type === 'createSheet')) {
        const sheetName = a.sheet || a.sheetName || a.name;
        if (sheetName && typeof sheetName === 'string') touchedSet.add(sheetName);
      }
      return enriched;
    });
    state.touchedSheets = Array.from(touchedSet);
  }

  if (toolName === 'execute_python') {
    state.codeLog.push({ type: 'python', code: params.code, result: toolResult });
    onProgress('codeLog', { code: params.code, result: toolResult });
  }

  state.results.push({ type: 'tool', tool: toolName, params, result: toolResult });
  state.consecutiveErrors = 0;
  state.lastErrorMessage = '';

  const trForMsg = (toolResult && typeof toolResult === 'object' && Array.isArray(toolResult.actions))
    ? { ...toolResult, actions: undefined, _actionCount: toolResult.actions.length }
    : toolResult;
  state.messages.push(makeUserMessage(formatToolResultForMessages(trForMsg, toolName)));
  onProgress('toolResult', { iteration: state.iteration, tool: toolName, result: toolResult });

  const criticOn = (state.config.postWriteCriticEnabled === true) ||
    (state.config.postWriteCriticEnabled !== false && AGENT_POSTWRITE_CRITIC);
  if (criticOn && POSTWRITE_CRITIC_TOOLS.has(toolName) && actions) {
    try {
      const critique = await runPostWriteCritic(toolName, actions);
      if (critique && Array.isArray(critique.issues) && critique.issues.length > 0) {
        const formatted = critique.issues.slice(0, 6).map((i, idx) =>
          `${idx + 1}. [${i.severity || 'note'}] ${i.message || '(no message)'}${i.suggestion ? ` — fix: ${i.suggestion}` : ''}`
        ).join('\n');
        state.messages.push(makeUserMessage(`POST-WRITE CRITIC (fast pass, ${critique.issues.length} issue${critique.issues.length === 1 ? '' : 's'}):\n${formatted}\n\nAddress the high-severity issues in your next step before continuing the build.`));
        onProgress('postWriteCritic', { iteration: state.iteration, tool: toolName, issues: critique.issues });
      }
    } catch (_) { /* critic is best-effort */ }
  }

  state.recentToolTrail.push({ iteration: state.iteration, toolName, signature: buildToolStagnationSignature(toolName, params), sheetHint: extractSheetHint(params) });
  if (state.recentToolTrail.length > STAGNATION_MAX_TRAIL) {
    state.recentToolTrail.splice(0, state.recentToolTrail.length - STAGNATION_MAX_TRAIL);
  }
  if (process.env.AGENT_BULK_NUDGE !== 'false') {
    const nudge = bulkNudgeFor(state.recentToolTrail.slice(-2).map(e => e.toolName));
    if (nudge) state.messages.push(makeUserMessage(nudge));
  }

  const stagnation = detectToolStagnation(state.recentToolTrail);
  if (stagnation) {
    state.stagnationStrikes = Number(state.stagnationStrikes || 0) + 1;
    // First strike: steer instead of aborting. Past failure: an institutional
    // fast-food run hit stagnation_repeat:execute_office_js:x4 and killed the
    // whole turn at iteration 37 even though the agent had already written
    // ~30 successful batches. Give one rescue chance: clear the trail, force
    // thinking on the next call, and push a loud corrective message.
    if (state.stagnationStrikes < 2) {
      const reason = formatToolStagnationReason(stagnation);
      const tools = stagnation.entries.map(e => e.toolName).join(' → ');
      const nudge = [
        `STAGNATION DETECTED: ${reason}. You just called the same tool ${stagnation.entries.length} times in a row (${tools}) without making progress.`,
        `STOP. Do NOT call ${stagnation.entries[stagnation.entries.length - 1].toolName} again with the same parameters.`,
        `Reset: think about what you actually need to do next. If you were verifying / reading, that's done — make the next WRITE. If you were trying to format, switch to bulk_set_format with explicit ranges. If execute_office_js keeps failing, abandon it and use the structured tools (set_cell_range / bulk_set_cell_ranges / bulk_set_format / get_cell_ranges) which have schema validation.`,
        `This is your ONE rescue. The next stagnation will abort the run.`
      ].join('\n');
      state.messages.push(makeUserMessage(nudge));
      state.recentToolTrail.length = 0;
      state.forceThinkingNext = true;
      onProgress('agentStagnationNudge', { iteration: state.iteration, pattern: stagnation.pattern, reason, strikes: state.stagnationStrikes });
      autoCompactMessages(state);
      if (actions) return { state, control: 'emit_actions', payload: { thought, actions } };
      return { state, control: 'continue', payload: { thought } };
    }
    state.status = 'aborted';
    state.abortReason = formatToolStagnationReason(stagnation);
    state.results.push({ type: 'error', error: state.abortReason, stagnation: true, pattern: stagnation.pattern, tools: stagnation.entries.map(e => e.toolName), strikes: state.stagnationStrikes });
    onProgress('iterationError', { iteration: state.iteration, error: state.abortReason, stagnation: true, pattern: stagnation.pattern, strikes: state.stagnationStrikes });
    return { state, control: 'aborted', payload: { reason: state.abortReason } };
  }

  autoCompactMessages(state);

  if (actions) return { state, control: 'emit_actions', payload: { thought, actions } };
  return { state, control: 'continue', payload: { thought } };
}

async function resumePendingTool(state, clientResult, deps, onProgress) {
  const pending = state.pending;

  if (pending.kind === 'question') {
    const raw = clientResult && clientResult.response !== undefined ? clientResult.response : clientResult;
    const normalized = normalizeQuestionResponsePayload(raw);
    state.messages.push({ role: 'user', content: `User response: ${JSON.stringify(normalized)}` });
    state.results.push({ type: 'ask_user', question: pending.question, response: normalized });
    state.pending = null;
    state.status = 'running';
    onProgress('agentResumed', { question: pending.question, response: normalized, iteration: state.iteration });
    return { state, control: 'continue', payload: {} };
  }

  const staged = normalizeClientResults(clientResult);
  const { toolName, params, thought } = pending;
  let toolResult;
  if (pending.kind === 'parallel') {
    toolResult = await assembleParallelResult(state, pending, staged);
  } else {
    toolResult = await runToolWithStagedResults(toolName, params, state.context, staged);
  }
  state.pending = null;
  state.status = 'running';
  return finishToolExecution(state, toolName || 'parallel_calls', params, thought, toolResult, deps, onProgress);
}

// Advance the agent by exactly ONE iteration. Stateless across HTTP requests:
// pass the prior `state` back in, plus `clientResult` when resuming an
// await_client / paused control. Returns { state, control, payload }.
async function runAgentStep(state, clientResult, deps = {}) {
  const onProgress = (t, d) => { try { (deps.onProgress || (() => {}))(t, d || {}); } catch (_) {} };

  if (state.status === 'completed') return { state, control: 'done', payload: { summary: state.summary } };
  if (state.status === 'aborted') return { state, control: 'aborted', payload: { reason: state.abortReason } };

  if (state.pending) {
    if (!clientResult) {
      return { state, control: state.pending.kind === 'question' ? 'paused' : 'await_client', payload: state.pending.kind === 'question' ? { question: state.pending.question } : { requests: state.pending.requests || [] } };
    }
    return resumePendingTool(state, clientResult, deps, onProgress);
  }

  if (Array.isArray(deps.steerMessages) && deps.steerMessages.length > 0) {
    for (const item of deps.steerMessages) {
      if (!item || !item.text) continue;
      const isInterrupt = item.kind === 'interrupt';
      const wrapped = isInterrupt
        ? `<user-interrupt iteration="${state.iteration}">\nThe user issued a mid-execution DIRECTIVE. Reassess immediately: drop in-progress steps that conflict with it. Acknowledge briefly in your next "thought" and act on the new directive.\n\nDirective: ${item.text}\n</user-interrupt>`
        : `<user-addendum iteration="${state.iteration}">\nAdditional info from the user (continue current work, integrate this into the ongoing task):\n${item.text}\n</user-addendum>`;
      state.messages.push(makeUserMessage(wrapped));
      state.recentToolTrail.length = 0;
      onProgress('agentSteered', { iteration: state.iteration, kind: item.kind, text: item.text });
    }
  }

  state.iteration++;
  if (state.iteration > state.config.maxIterations) {
    state.status = 'aborted';
    state.abortReason = 'Reached max iterations';
    return terminalControl(state);
  }
  onProgress('iterationStart', { iteration: state.iteration, maxIterations: state.config.maxIterations });

  try {
    const { llmResult } = await callStepLLM(state, deps);

    const parseFailed = !!(llmResult && llmResult.raw && llmResult.jsonError);
    if (parseFailed) {
      state.parseFailureStreak++;
      if (AGENT_FORCE_THINKING_AFTER_ERROR) state.forceThinkingNext = true;
      onProgress('iterationError', { iteration: state.iteration, error: `LLM JSON parse failed: ${llmResult.jsonError}` });
      state.messages.push(makeUserMessage(`Your previous response was not valid JSON (${llmResult.jsonError}). Reply with ONLY a single JSON object {"thought","tool","params"} — no extra text, no trailing characters. Continue the task from where you left off.`));
      // Refund up to 2 parse failures per slice. DeepSeek pro occasionally emits
      // truncated / malformed JSON that has nothing to do with the agent's task;
      // counting these toward maxIter pushed format_and_verify past cap in the
      // 2026-05-31 fast-food run and skipped the entire formatting pass.
      if (state.parseFailureStreak <= 2) {
        state.iteration = Math.max(0, state.iteration - 1);
      }
      return { state, control: 'continue', payload: {} };
    }
    state.parseFailureStreak = 0;
    state.forceThinkingNext = false;

    const thought = llmResult.thought || llmResult.reasoning || '';
    const toolName = llmResult.tool || llmResult.action || '';
    const params = llmResult.params || llmResult.parameters || llmResult.arguments || {};
    onProgress('thought', { iteration: state.iteration, thought: String(thought).slice(0, 300), tool: toolName });
    state.messages.push({ role: 'assistant', content: JSON.stringify({ thought, tool: toolName, params }) });

    if (!toolName || toolName === 'noop' || toolName === 'none') {
      state.messages.push(makeUserMessage('No tool was called. If task is complete, call tool "done" with a summary. Otherwise continue with the next tool.'));
      return { state, control: 'continue', payload: { thought } };
    }

    if (Array.isArray(state.config.disabledTools) && state.config.disabledTools.includes(toolName)) {
      const redirect = TOOL_DISABLED_REDIRECTS[toolName] || 'Use the structured tools instead.';
      const blockMsg = `Tool "${toolName}" is disabled in this run. ${redirect}`;
      state.messages.push(makeUserMessage(blockMsg));
      state.results.push({ type: 'error', error: blockMsg, blocked: true, tool: toolName });
      onProgress('iterationError', { iteration: state.iteration, error: blockMsg });
      // Refund the iteration counter — the LLM call returned but the tool was
      // rejected without touching Excel or the client. Charging it pushes the
      // slice toward maxIter for a no-op, which cascade-killed downstream
      // waves in the 2026-05-30 fast-food run. The redirect message is in
      // the message log so the LLM still learns from the mistake.
      state.iteration = Math.max(0, state.iteration - 1);
      return { state, control: 'continue', payload: { thought } };
    }

    // Hard-block sequential one-at-a-time tools after 2 attempts. The soft
    // BATCH HINT nudge was ignored 17 times in the 2026-05-30 run, burning
    // the whole iter budget on create_named_range one-by-one. Once the LLM
    // demonstrates the pattern, force the bulk alternative.
    const SEQUENTIAL_FORCE_BULK = {
      create_named_range: 'bulk_create_named_ranges',
      create_sheet: 'bulk_create_sheets',
      set_format: 'bulk_set_format'
    };
    const bulkReplacement = SEQUENTIAL_FORCE_BULK[toolName];
    if (bulkReplacement) {
      const recent = state.recentToolTrail.slice(-2).map(e => e.toolName);
      if (recent.length === 2 && recent.every(n => n === toolName)) {
        const forceMsg = `STAGNATION GUARD: "${toolName}" was called 3 times in a row. Your NEXT call MUST be "${bulkReplacement}" with ALL remaining items in one payload. Sequential one-at-a-time calls have killed prior slices by exhausting the iteration budget. This call is rejected; retry as ${bulkReplacement}.`;
        state.messages.push(makeUserMessage(forceMsg));
        state.results.push({ type: 'error', error: forceMsg, blocked: true, tool: toolName });
        onProgress('iterationError', { iteration: state.iteration, error: forceMsg });
        state.iteration = Math.max(0, state.iteration - 1);
        return { state, control: 'continue', payload: { thought } };
      }
    }

    if (toolName === 'web_search' || toolName === 'web_fetch') {
      state.webSearchCount++;
      if (state.webSearchCount > state.config.maxWebSearch) {
        const blockMsg = `Maximum web search attempts (${state.config.maxWebSearch}) reached. Use the sourced information already gathered, label any remaining uncertain inputs as assumptions, and continue the model. Do NOT search again.`;
        state.messages.push(makeUserMessage(blockMsg));
        state.results.push({ type: 'error', error: blockMsg });
        onProgress('iterationError', { iteration: state.iteration, error: blockMsg });
        return { state, control: 'continue', payload: { thought } };
      }
    }

    if (toolName === 'done') {
      state.status = 'completed';
      state.summary = params.summary || 'Task completed';
      // Optional legacy auto-format pass before exit.
      let autoFormatActions = null;
      if (state.config.autoFormatOnDone && Array.isArray(state.touchedSheets) && state.touchedSheets.length > 0) {
        try {
          const { runFormatAgent } = require('./specialists');
          const formatResult = await runFormatAgent(
            { sheets: state.touchedSheets, mode: 'institutional_finance' },
            { results: state.results }
          );
          if (formatResult && Array.isArray(formatResult.actions) && formatResult.actions.length > 0) {
            autoFormatActions = formatResult.actions.map((a) => a.explanation ? a : ({ ...a, explanation: `auto-format ${a.sheet || ''}` }));
            logger.info(`[AgentStep] auto-format on done: ${state.touchedSheets.length} sheet(s), ${autoFormatActions.length} actions`);
          }
        } catch (fmtErr) {
          logger.warn(`[AgentStep] auto-format on done failed: ${fmtErr.message}`);
        }
      }
      state.results.push({ type: 'done', summary: state.summary });
      state.messages.push(makeUserMessage('Task completed successfully.'));
      onProgress('agentDone', { summary: state.summary, iteration: state.iteration });
      // NOTE: do NOT call onProgress('actions', ...) for stepwise — in stepwise
      // the SSE 'actions' channel would double-apply on top of the done payload.
      // The client picks autoFormatActions up from the /step response below.
      return { state, control: 'done', payload: { summary: state.summary, autoFormatActions } };
    }

    if (toolName === 'todo_write') {
      const todos = Array.isArray(params.todos) ? params.todos : [];
      state.results.push({ type: 'todo_write', todos });
      onProgress('todoWrite', { todos });
      state.messages.push(makeUserMessage(todos.length > 0
        ? `Task list updated: ${todos.map(t => `[${t.status}] ${t.content}`).join(', ')}`
        : 'Task list updated.'));
      return { state, control: 'continue', payload: { thought } };
    }

    if (toolName === 'ask_user' || toolName === 'ask_user_question') {
      return handleAskUser(state, toolName, params, thought, onProgress);
    }

    if (toolName === 'context_snip') {
      const snipResult = snipContext(state.messages, params.from_id, params.to_id, params.summary);
      state.messages.push(makeUserMessage(`Context snipped: ${params.summary}`));
      state.results.push({ type: 'context_snip', ...snipResult });
      onProgress('contextSnip', snipResult);
      return { state, control: 'continue', payload: { thought } };
    }

    if (toolName === 'retrieve_snipped') {
      const retrieved = retrieveSnipped(params.from_id, params.search, params.max_chars);
      state.messages.push(makeUserMessage(`Retrieved snipped context: ${JSON.stringify((retrieved.results || []).map(r => r.summary))}`));
      state.results.push({ type: 'retrieve_snipped', ...retrieved });
      onProgress('retrieveSnipped', retrieved);
      return { state, control: 'continue', payload: { thought } };
    }

    if (toolName === 'read_skill') {
      const skillName = String((params && params.name) || '').trim();
      if (skillName && state.loadedSkillNames.includes(skillName)) {
        const dup = `Skill "${skillName}" is already loaded in context. Do not call read_skill again. Proceed with workbook/data/build tools.`;
        state.results.push({ type: 'read_skill_duplicate', name: skillName });
        onProgress('iterationError', { iteration: state.iteration, error: dup });
        state.messages.push(makeUserMessage(dup));
        return { state, control: 'continue', payload: { thought } };
      }
    }

    if (toolName === 'parallel_calls') {
      return startParallelCalls(state, params, thought, deps, onProgress);
    }

    if (CLIENT_CAPABLE_TOOLS.has(toolName)) {
      const { requests, dryResult } = await collectToolClientRequests(toolName, params, state.context);
      if (requests.length > 0) {
        state.pending = { kind: 'single', toolName, params, thought, requests };
        state.status = 'awaiting_client';
        return { state, control: 'await_client', payload: { thought, requests } };
      }
      if (toolName === 'read_skill') markSkillLoaded(state, params);
      return finishToolExecution(state, toolName, params, thought, dryResult, deps, onProgress);
    }

    const toolResult = await executeAgentTool(toolName, params, state.context, null);
    if (toolName === 'read_skill') markSkillLoaded(state, params);
    return finishToolExecution(state, toolName, params, thought, toolResult, deps, onProgress);

  } catch (error) {
    return handleStepError(state, error, onProgress);
  }
}

module.exports = {
  runAgentLoop,
  initAgentRun,
  runAgentStep,
  TOOL_DEFINITIONS,
  AGENT_SYSTEM_PROMPT,
  getSystemPrompt,
  PROMPT_VARIANTS,
  getCellRangeBounds,
  colToIndex,
  indexToCol,
  resolveAgentLoopModel,
  shouldUseAgentThinking,
  buildToolStagnationSignature,
  detectToolStagnation,
  formatToolStagnationReason,
  executeAgentTool,
  formatToolResultForMessages,
  trimDeepArrays,
  detectScalarTextFloodFill
};
