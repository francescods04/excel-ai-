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

const Ajv = require('ajv');
const { callLLM } = require('../tools/llm');
const { TOOL_DEFINITIONS } = require('./agentLoop');
const logger = require('../utils/logger');

const ARCHITECT_ACTION_TOOLS = new Set([
  'bulk_create_sheets',
  'delete_sheet',
  'set_cell_range',
  'bulk_set_cell_ranges',
  'bulk_set_format',
  'bulk_set_notes',
  'create_named_range',
  'bulk_create_named_ranges',
  'copy_range'
]);

const ACTION_ALLOWED_KEYS = new Set(['tool', 'params']);
const ACTION_BANNED_PARAM_KEYS = new Set(['control', 'message', 'thought', 'payload']);
const actionAjv = new Ajv({ allErrors: true, strict: false, useDefaults: false, coerceTypes: false });
const actionSchemaValidators = new Map();

function getAgentToolSchema(toolName) {
  const def = (TOOL_DEFINITIONS || []).find(t => t?.function?.name === toolName);
  return def?.function?.parameters || null;
}

function validateAgentToolParams(toolName, params) {
  const schema = getAgentToolSchema(toolName);
  if (!schema) return { ok: false, errors: [`tool "${toolName}" has no schema`] };
  let validator = actionSchemaValidators.get(toolName);
  if (!validator) {
    validator = actionAjv.compile(schema);
    actionSchemaValidators.set(toolName, validator);
  }
  const valid = validator(params);
  if (!valid) {
    return {
      ok: false,
      errors: (validator.errors || []).map(e => `${e.instancePath || '/'} ${e.message}`)
    };
  }
  return { ok: true, errors: [] };
}

function validateActionSemanticShape(toolName, params) {
  const errors = [];
  if (toolName === 'set_cell_range') {
    if (!params.cells || typeof params.cells !== 'object' || Array.isArray(params.cells) || Object.keys(params.cells).length === 0) {
      errors.push('params.cells must be a non-empty object');
    }
  }
  if (toolName === 'bulk_set_cell_ranges') {
    const writes = Array.isArray(params.writes) ? params.writes : [];
    writes.forEach((write, index) => {
      if (!write.cells || typeof write.cells !== 'object' || Array.isArray(write.cells) || Object.keys(write.cells).length === 0) {
        errors.push(`params.writes[${index}].cells must be a non-empty object`);
      }
    });
  }
  if (toolName === 'bulk_set_format') {
    const formats = Array.isArray(params.formats) ? params.formats : [];
    formats.forEach((format, index) => {
      if (!format.options || typeof format.options !== 'object' || Array.isArray(format.options) || Object.keys(format.options).length === 0) {
        errors.push(`params.formats[${index}].options must be a non-empty object`);
      }
    });
  }
  return errors;
}

function validateSliceActions(sliceId, actions) {
  const errors = [];
  if (actions == null) return { ok: true, actions: [] };
  if (!Array.isArray(actions)) {
    return { ok: false, errors: [`slice ${sliceId}: actions must be an array when present`] };
  }
  if (actions.length === 0) return { ok: true, actions: [] };

  const normalized = [];
  actions.forEach((action, index) => {
    const prefix = `slice ${sliceId} actions[${index}]`;
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      errors.push(`${prefix}: action must be an object`);
      return;
    }
    const extraKeys = Object.keys(action).filter(key => !ACTION_ALLOWED_KEYS.has(key));
    if (extraKeys.length > 0) {
      errors.push(`${prefix}: unsupported field(s): ${extraKeys.join(', ')}`);
    }
    const tool = action.tool;
    if (!tool || typeof tool !== 'string') {
      errors.push(`${prefix}: tool must be a non-empty string`);
      return;
    }
    if (!ARCHITECT_ACTION_TOOLS.has(tool)) {
      errors.push(`${prefix}: tool "${tool}" is not allowed in deterministic slice actions`);
      return;
    }
    const params = action.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      errors.push(`${prefix} (${tool}): params must be an object`);
      return;
    }
    for (const key of Object.keys(params)) {
      if (ACTION_BANNED_PARAM_KEYS.has(key)) {
        errors.push(`${prefix} (${tool}): params contains forbidden field "${key}"`);
      }
    }
    const schemaValidation = validateAgentToolParams(tool, params);
    if (!schemaValidation.ok) {
      errors.push(...schemaValidation.errors.map(err => `${prefix} (${tool}): ${err}`));
      return;
    }
    const semanticErrors = validateActionSemanticShape(tool, params);
    if (semanticErrors.length > 0) {
      errors.push(...semanticErrors.map(err => `${prefix} (${tool}): ${err}`));
      return;
    }
    normalized.push({ tool, params: JSON.parse(JSON.stringify(params)) });
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, actions: normalized };
}

function formulaLiteralFromCellSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;
  if (spec.formula != null) return spec.formula;
  if (typeof spec.value === 'string' && spec.value.trim().startsWith('=')) return spec.value;
  return null;
}

function normalizeFormulaSheetName(raw) {
  let name = String(raw || '').trim();
  if (!name) return '';
  if (name.startsWith("'") && name.endsWith("'")) {
    name = name.slice(1, -1).replace(/''/g, "'");
  }
  return name.trim();
}

function extractSheetNameFromReference(ref) {
  const text = String(ref || '').trim();
  if (!text) return null;
  if (text.includes('!')) {
    const left = text.split('!')[0];
    return normalizeFormulaSheetName(left);
  }
  if (/^[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?$/i.test(text)) return null;
  if (/^[A-Z]+:[A-Z]+$/i.test(text) || /^\d+:\d+$/.test(text)) return null;
  return normalizeFormulaSheetName(text);
}

function extractFormulaSheetRefs(formula) {
  if (formula == null) return [];
  const text = String(formula);
  if (!text.trim().startsWith('=')) return [];
  const refs = new Set();
  const quoted = /'((?:[^']|'')+)'!/g;
  let match;
  while ((match = quoted.exec(text))) {
    const name = normalizeFormulaSheetName(`'${match[1]}'`);
    if (name) refs.add(name);
  }
  // Excluded from the "separator" class: A-Za-z0-9_.'] AND now &- because those
  // chars are valid inside sheet names. Past failure: formula "=P&L!B5" was
  // unquoted (architect bug) and the regex matched "&L!" extracting "L" as a
  // fake sheet ref, producing the cryptic 'references sheet "L"' validation
  // error. Now we skip such broken refs here and let the dedicated
  // detectUnquotedSheetNamesWithSpecialChars check emit a clearer error.
  const unquoted = /(^|[^A-Za-z0-9_.'\]&-])([A-Za-z_][A-Za-z0-9_.]*)!/g;
  while ((match = unquoted.exec(text))) {
    const name = normalizeFormulaSheetName(match[2]);
    if (name) refs.add(name);
  }
  return [...refs];
}

// Catch the actual bug: architect emitted "=P&L!B5" / "=Cash-Flow!A1" instead
// of the quoted "='P&L'!B5" / "='Cash-Flow'!A1". Walk the formula outside any
// single-quoted segment and look for "name<&|-|space>name!" patterns.
function detectUnquotedSheetNamesWithSpecialChars(formula) {
  if (formula == null) return [];
  const text = String(formula);
  if (!text.trim().startsWith('=')) return [];
  const quotedSpans = [];
  const quotedRe = /'(?:[^']|'')+'/g;
  let qm;
  while ((qm = quotedRe.exec(text))) {
    quotedSpans.push([qm.index, qm.index + qm[0].length]);
  }
  const isInsideQuotes = (idx) => quotedSpans.some(([s, e]) => idx >= s && idx < e);
  const out = [];
  const susp = /([A-Za-z_][A-Za-z0-9_]*(?:[\s&-][A-Za-z_][A-Za-z0-9_]*)+)\s*!/g;
  let m;
  while ((m = susp.exec(text))) {
    if (isInsideQuotes(m.index)) continue;
    out.push(m[1].trim());
  }
  return out;
}

function collectActionSheetNames(action, out) {
  if (!action || !action.params) return;
  const p = action.params;
  switch (action.tool) {
    case 'bulk_create_sheets':
      (Array.isArray(p.names) ? p.names : []).forEach(name => out.add(String(name)));
      break;
    case 'delete_sheet':
      if (p.name) out.add(String(p.name));
      break;
    case 'set_cell_range':
      if (p.sheet) out.add(String(p.sheet));
      break;
    case 'bulk_set_cell_ranges':
      (Array.isArray(p.writes) ? p.writes : []).forEach(write => {
        if (write?.sheet) out.add(String(write.sheet));
      });
      break;
    case 'bulk_set_format':
      (Array.isArray(p.formats) ? p.formats : []).forEach(format => {
        if (format?.sheet) out.add(String(format.sheet));
      });
      break;
    case 'bulk_set_notes':
      (Array.isArray(p.notes) ? p.notes : []).forEach(note => {
        if (note?.sheet) out.add(String(note.sheet));
      });
      break;
    case 'copy_range':
      if (p.from_sheet) out.add(String(p.from_sheet));
      if (p.to_sheet) out.add(String(p.to_sheet));
      break;
    default:
      break;
  }
}

function collectActionFormulaRefs(action, out) {
  if (!action || !action.params) return;
  const p = action.params;
  if (action.tool === 'set_cell_range') {
    for (const spec of Object.values(p.cells || {})) {
      const formula = formulaLiteralFromCellSpec(spec);
      extractFormulaSheetRefs(formula).forEach(ref => out.push({ formula: String(formula), ref }));
    }
    return;
  }
  if (action.tool === 'bulk_set_cell_ranges') {
    for (const write of Array.isArray(p.writes) ? p.writes : []) {
      for (const spec of Object.values(write?.cells || {})) {
        const formula = formulaLiteralFromCellSpec(spec);
        extractFormulaSheetRefs(formula).forEach(ref => out.push({ formula: String(formula), ref }));
      }
    }
    return;
  }
  if (action.tool === 'create_named_range') {
    extractFormulaSheetRefs(p.refers_to).forEach(ref => out.push({ formula: String(p.refers_to), ref }));
    return;
  }
  if (action.tool === 'bulk_create_named_ranges') {
    for (const range of Array.isArray(p.ranges) ? p.ranges : []) {
      extractFormulaSheetRefs(range?.refers_to).forEach(ref => out.push({ formula: String(range.refers_to), ref }));
    }
  }
}

function validateDeterministicFormulaReferences(slices, context = {}) {
  const allowedSheets = new Set();
  for (const name of context.workbookSheets || context.sheets || []) {
    if (name) allowedSheets.add(String(name));
  }
  for (const slice of slices) {
    for (const sheet of slice.scope?.sheets_owned || []) {
      if (sheet) allowedSheets.add(String(sheet));
    }
    for (const ref of slice.scope?.ranges_owned || []) {
      const sheet = extractSheetNameFromReference(ref);
      if (sheet) allowedSheets.add(sheet);
    }
    for (const ref of slice.scope?.may_read_from || []) {
      const sheet = extractSheetNameFromReference(ref);
      if (sheet) allowedSheets.add(sheet);
    }
    for (const action of slice.actions || []) {
      collectActionSheetNames(action, allowedSheets);
    }
  }

  const errors = [];
  for (const slice of slices) {
    const refs = [];
    for (const action of slice.actions || []) collectActionFormulaRefs(action, refs);
    const seenUnquoted = new Set();
    for (const item of refs) {
      const unquoted = detectUnquotedSheetNamesWithSpecialChars(item.formula);
      for (const name of unquoted) {
        const key = `${slice.id}:${name}`;
        if (seenUnquoted.has(key)) continue;
        seenUnquoted.add(key);
        errors.push(
          `slice ${slice.id}: formula contains unquoted sheet reference "${name}!" with a special character ('&', '-', or space). Excel requires single-quote wrapping: use '${name}'! instead.`
        );
      }
      if (unquoted.length > 0) continue;
      if (!allowedSheets.has(item.ref)) {
        errors.push(
          `slice ${slice.id}: formula references sheet "${item.ref}" but no slice scope/action declares that exact sheet name`
        );
      }
    }
  }
  return errors;
}

function normalizeFactText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/[^a-z0-9+&.'/%\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseEuroPrice(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[^\d,.-]/g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function cleanMenuItemName(prefix) {
  let name = String(prefix || '').replace(/\s+/g, ' ').trim();
  // Strip recognized noise/annotation phrases BEFORE the splits so words like
  // "Menu" or "Plant Based" inside an annotation don't bleed across items.
  // Past failure: "TENDERS — 7,50 € Tenders Plant Based. (Menu non disponibile)
  // VEGGIE DELUXE — 14,50 €" → menuTitleSplit on \bMenu\b cut at "(Menu" leaving
  // "non disponibile) VEGGIE DELUXE" as the extracted name, which then never
  // matched the deterministic action literal and broke the architect.
  name = name
    .replace(/\(\s*Menu\s+non\s+disponibile\s*\)?\.?/gi, ' ')
    .replace(/\(\s*Plant\s+Based\s*\)/gi, ' ')
    .replace(/I\s+prezzi\s+sono\s+indicati[^.]*\.?/gi, ' ')
    .replace(/Prezzo\s+fisso:?[^.€]*\.?/gi, ' ')
    .replace(/Extra\s*\/\s*Top:?[^.€]*\.?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const categorySplit = name.split(/(?:🍟|🍔|🥪|🌭|🌱|🍰|🥤|⚠️|Starters|Burger & Smash|Sandwiches|Hot Dogs|Beyond Meat(?: \(Plant Based\))?|Sides|Sweets & Milkshakes|Dolci|Milkshakes|Drinks)/i);
  name = categorySplit[categorySplit.length - 1].trim();
  const menuTitleSplit = name.split(/\bMenu\b/i);
  name = menuTitleSplit[menuTitleSplit.length - 1].trim();
  const sentenceSplit = name.split(/\.\s+(?=[A-ZÀ-Ý0-9])/);
  name = sentenceSplit[sentenceSplit.length - 1].trim();
  const priorPriceSplit = name.split(/€\s*/);
  name = priorPriceSplit[priorPriceSplit.length - 1].trim();
  name = name
    .replace(/^[^\p{L}\p{N}+]+/u, '')
    .replace(/[^\p{L}\p{N}+&.'’‘/\s-]+$/u, '')
    .trim();
  return name;
}

function extractVerbatimMenuFacts(objective) {
  const text = String(objective || '');
  if (!/[€]|menu|burger|fast food/i.test(text)) return [];
  const facts = [];
  const seen = new Set();
  const pricePattern = /[—–-]\s*(\+?\d{1,3}(?:[,.]\d{2})?)\s*€/g;
  let match;
  let boundary = 0;
  while ((match = pricePattern.exec(text))) {
    const prefix = text.slice(boundary, match.index);
    const name = cleanMenuItemName(prefix);
    if (!name || name.length < 2 || name.length > 48) continue;
    if (/^(?:m|menu|singola|prezzo fisso)$/i.test(name)) continue;
    const basePrice = parseEuroPrice(match[1]);
    if (basePrice == null) continue;
    const after = text.slice(pricePattern.lastIndex, pricePattern.lastIndex + 40);
    const menuMatch = after.match(/^\s*\|\s*M\s*(\d{1,3}(?:[,.]\d{2})?)\s*€/i);
    const menuPrice = menuMatch ? parseEuroPrice(menuMatch[1]) : null;
    boundary = pricePattern.lastIndex + (menuMatch ? menuMatch[0].length : 0);
    pricePattern.lastIndex = boundary;
    const key = `${normalizeFactText(name)}|${basePrice}|${menuPrice == null ? '' : menuPrice}`;
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({
      name,
      basePrice,
      menuPrice,
      basePriceText: match[1],
      menuPriceText: menuMatch ? menuMatch[1] : null
    });
  }

  const fixedMilkshake = text.match(/Milkshakes\s+Prezzo\s+fisso:\s*(\d{1,3}(?:[,.]\d{2})?)\s*€/i);
  if (fixedMilkshake) {
    const basePrice = parseEuroPrice(fixedMilkshake[1]);
    const key = `milkshakes|${basePrice}`;
    if (basePrice != null && !seen.has(key)) {
      facts.push({
        name: 'Milkshakes',
        basePrice,
        menuPrice: null,
        basePriceText: fixedMilkshake[1],
        menuPriceText: null
      });
    }
  }
  return facts.slice(0, 80);
}

function collectActionLiteralCorpus(slices) {
  const textParts = [];
  const numbers = [];
  function addValue(value) {
    if (value == null) return;
    if (typeof value === 'number' && Number.isFinite(value)) {
      numbers.push(value);
      textParts.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(addValue);
      return;
    }
    if (typeof value === 'object') {
      textParts.push(JSON.stringify(value));
      return;
    }
    const str = String(value);
    textParts.push(str);
    const matches = str.match(/\+?\d{1,3}(?:[,.]\d{1,2})?/g) || [];
    for (const m of matches) {
      const n = parseEuroPrice(m);
      if (n != null) numbers.push(n);
    }
  }
  for (const slice of slices || []) {
    textParts.push(slice.title || '', slice.instructions || '');
    for (const action of slice.actions || []) {
      textParts.push(action.tool || '');
      const p = action.params || {};
      if (action.tool === 'bulk_create_sheets') (p.names || []).forEach(addValue);
      if (action.tool === 'set_cell_range') {
        addValue(p.sheet);
        for (const [addr, spec] of Object.entries(p.cells || {})) {
          addValue(addr);
          addValue(spec?.value);
          addValue(spec?.formula);
          addValue(spec?.note);
        }
      }
      if (action.tool === 'bulk_set_cell_ranges') {
        for (const write of p.writes || []) {
          addValue(write.sheet);
          for (const [addr, spec] of Object.entries(write.cells || {})) {
            addValue(addr);
            addValue(spec?.value);
            addValue(spec?.formula);
            addValue(spec?.note);
          }
        }
      }
      if (action.tool === 'bulk_set_notes') {
        for (const note of p.notes || []) {
          addValue(note.sheet);
          addValue(note.cell || note.addr);
          addValue(note.note || note.text);
        }
      }
    }
  }
  return { text: normalizeFactText(textParts.join(' ')), numbers };
}

function hasApproxNumber(numbers, expected) {
  return numbers.some(n => Math.abs(Number(n) - Number(expected)) < 0.005);
}

function validateVerbatimSourceFacts(slices, context = {}) {
  const facts = extractVerbatimMenuFacts(context.objective || context.sourceObjective || '');
  if (facts.length < 5) return [];
  const corpus = collectActionLiteralCorpus(slices);
  const missing = [];
  for (const fact of facts) {
    const nameOk = corpus.text.includes(normalizeFactText(fact.name));
    const baseOk = hasApproxNumber(corpus.numbers, fact.basePrice);
    const menuOk = fact.menuPrice == null || hasApproxNumber(corpus.numbers, fact.menuPrice);
    if (!nameOk || !baseOk || !menuOk) {
      const priceBits = [`€${fact.basePriceText}`];
      if (fact.menuPriceText) priceBits.push(`M €${fact.menuPriceText}`);
      missing.push(`${fact.name} (${priceBits.join(', ')})`);
    }
  }
  if (missing.length === 0) return [];
  const preview = missing.slice(0, 12).join('; ');
  return [
    `verbatim menu coverage failed: ${missing.length}/${facts.length} menu price item(s) from the user objective are not written in deterministic action literals. Missing: ${preview}`
  ];
}

const ARCHITECT_SYSTEM_PROMPT = `You are an architect and deterministic action compiler for Excel workbook builds.
Given a user objective and current workbook state, produce one BLUEPRINT: a directed acyclic graph (DAG) of slices.

NEW EXECUTION MODEL:
- Prefer deterministic slices: put the exact Excel tool calls in slice.actions[].
- A slice with non-empty actions[] is executed by a pure server executor with ZERO LLM calls. It will not read, infer, repair, or interpret prose. The actions must be complete and valid.
- A slice with missing or empty actions[] falls back to the legacy worker LLM. Use this only when the slice truly requires live read-back or reasoning after previous writes.
- If actions[] is present, invalid JSON/tool params fail blueprint validation. Do not emit approximate actions.

DAG RULES:
- Each slice owns an exclusive set of sheets/ranges. Two slices in the same dependency wave must never overlap sheets_owned or ranges_owned.
- A slice may read/reference upstream outputs only when those upstream slice ids are in deps[] transitively.
- Prefer 3-8 coherent slices for complex tasks. Do not micro-slice.
- Cross-sheet circular dependencies must be in one sequential slice, or split into explicit first-pass / second-pass slices.
- Keep a final format_and_verify slice in the last wave. It may be deterministic if ranges are fully known. If it needs live read_format_summary or visual repair, leave actions[] empty and use legacy instructions.

DETERMINISTIC ACTION TOOL ALLOWLIST:
- bulk_create_sheets: {"names":["Assumptions","Revenue"]}
- delete_sheet: {"name":"Old Sheet"}
- set_cell_range: {"sheet":"S","cells":{"A1":{"value":"Label"},"B1":{"formula":"=A1*2"}}}
- bulk_set_cell_ranges: {"writes":[{"sheet":"S","cells":{"A1":{"value":1}},"copyToRange":"B1:G1"}]}
- bulk_set_format: {"formats":[{"sheet":"S","target":"A1:B2","options":{"bold":true,"backgroundColor":"#0D1F2D","fontColor":"#FFFFFF"}}]}
- bulk_set_notes: {"notes":[{"sheet":"Assumptions","cell":"B5","note":"Rationale"}]}
- create_named_range: {"name":"TaxRate","refers_to":"=Assumptions!$B$12"}
- bulk_create_named_ranges: {"ranges":[{"name":"TaxRate","refers_to":"=Assumptions!$B$12"}]}
- copy_range: {"from_sheet":"Source","from":"A1:B10","to_sheet":"Dest","to":"A1"}

ACTION JSON RULES:
- Each action is exactly {"tool":"<allowed_tool>","params":{...}}. No thought, message, control, payload, or client action types.
- Tool names are the LLM-facing snake_case tools above, not client action names like setCellRange/createSheet.
- Params must use canonical keys only. Do not use aliases like sheetName, ranges for writes, entries for formats, fromSheet, refersTo.
- Use bulk_create_sheets even for one newly-created sheet so the action path stays uniform.
- Do not put formatting inside cellStyles unless absolutely necessary. Prefer bulk_set_format as a separate action.
- copyToRange is formulas only. Never use it when the source cell is a text label.

PRESERVE USER DATA VERBATIM:
- If the user objective contains domain-specific lists, names, menu items, prices, specific counts, regions, asset categories, or account names, write those exact values in actions cells. Do not invent generic substitutes.
- If a deterministic slice cannot fit every exact item in actions[], make it legacy and include the full verbatim data in instructions.
- If the objective contains a restaurant menu with prices, create a dedicated "Menu" or "Menu Detail" sheet and write one row per item with the exact item name, base price, and menu price when present. Revenue can aggregate from that Menu sheet, but category-only summaries are not enough.
- Never replace the user's menu with invented category mix percentages unless the exact line-item menu is also present in the workbook.

SCALE AND DENSITY (CRITICAL — prior failure mode):
- The blueprint MUST match the density the user asked for. A 7-slice, 80-row summary in response to "1000 righe" / "molto dettagliato" / "monthly schedule" / "per piano" is a failure, not a fast win.
- copyToRange is the volume lever. One write entry with a relative-reference formula + copyToRange="B5:B1000" fills 996 rows in a single deterministic action. Use it for any multi-period or multi-unit schedule.
- For real estate / construction / project finance objectives: include period-by-period schedules — monthly construction (24-36 rows), monthly debt drawdown / interest reserve, monthly cash flow, monthly absorption / sales velocity, per-floor or per-unit cost matrix, per-phase milestones. Do NOT collapse a multi-year build into a single "Total Cost" line.
- For institutional valuation (DCF / LBO / M&A): include period-by-period projections covering at least the explicit horizon (e.g. 60 months or 10 years × 4 quarters), terminal value calculation, debt schedule with interest expense by period, multi-axis sensitivity tables (3-5 axes × 5-7 steps each = 25-49 cells per table, plus 3-5 separate tables).
- Slice count scales with density: <200 rows → 5-8 slices; 200-1000 rows → 8-12 slices; >1000 rows → 10-15 slices with explicit per-period / per-unit detail.
- When the SCALE TARGETS section below contains a row count, period count, or unit count, you MUST allocate that volume across slices. Half-density blueprints will be rejected downstream as "missed the brief".

CRITICAL — HOW TO ACHIEVE DENSITY (anti-loop pattern):
- DO NOT enumerate individual rows as separate actions. Writing 1000 rows as 1000 individual JSON cell objects is NOT how you achieve density — it will cause the slice worker to hit max iterations (30 cap) after ~300 rows, fail, and skip every dependent slice. This is a KNOWN FAILURE MODE.
- INSTEAD, use formula patterns + copyToRange + aggregation:
  * Cost Breakdown: write 30-50 CATEGORY headers with subtotal formulas (=SUMIF, =SUMPRODUCT referencing a compact data table). Do NOT write 200 individual cost line items as deterministic actions. Leave the detailed line items to the legacy worker IF the user genuinely needs per-item granularity, but set estimated_iters high (15-20) and include instructions like "write 10-15 representative items per category, then summarize with subtotals."
  * Revenue Schedule: write month/year headers in row 1 and use ONE formula row + copyToRange for the time axis (60 months). Revenue per unit can be =Assumptions!$B$X * units_sold_by_month. Do NOT write 40 individual unit rows with 60 columns each.
  * Cash Flow: use cross-sheet formulas (=CostBreakdown!B100, =RevenueSchedule!B50). One formula row + copyToRange for the time axis.
  * Debt Schedule: use Excel PMT/IPMT/PPMT functions. One formula row + copyToRange.
- A slice that writes 50 well-structured rows with formulas is BETTER than one that writes 300 hardcoded rows and crashes. The formulas compute the remaining detail automatically in Excel.
- For ANY slice targeting >200 rows, the deterministic actions MUST use copyToRange with formula patterns. If the data is truly unique per row (like a menu), make it a legacy worker slice with estimated_iters ≥ 15.

PARALLELISM MAXIMIZATION:
- The DAG should maximize wave parallelism. A blueprint where every slice depends only on assumptions (root slice) is valid and FASTER than a deep sequential chain.
- Cost breakdown, revenue schedule, and financing schedule can ALL run in parallel in wave 2 (all depend only on assumptions). They do NOT depend on each other.
- Cash flow depends on cost+revenue+financing → wave 3. Valuation depends on cash flow → wave 4. Format at the end.
- Target: 3-4 waves total, not 6-7. Every extra wave adds a client round-trip and Vercel cold-start latency.
- When in doubt, remove a dependency. Two slices that both read Assumptions but don't write to each other's sheets are INDEPENDENT — put them in the same wave.

FORMULAS AND CELL MAPS:
- The architect is the single source of truth for cell addresses. Every formula written in actions[] must be a literal Excel formula string.
- Every cross-sheet reference in actions[] must exactly match a sheet declared in scope.sheets_owned, scope.may_read_from, or bulk_create_sheets.names. Never use shortened aliases: if the sheet is "Cash Flow - Single Location", formulas must use ='Cash Flow - Single Location'!B5, not =Cash Flow!B5.
- Quote every sheet name that contains spaces, punctuation, apostrophes, ampersands, or hyphens in formulas using Excel syntax: ='P&L - Single Location'!B10.
- For Assumptions, use a flat 2-column layout: column A = driver label, column B = driver value. Section headers may live in column A with blank B. Year headers belong on operating sheets, not Assumptions.
- Before emitting dependent formulas, verify every Assumptions!$B$X reference points to the row you actually wrote in the Assumptions actions.
- Do not write driver values inline on dependent sheets when they should reference Assumptions. Use absolute references like =Assumptions!$B$5.
- For time series, write the first formula and use copyToRange only when relative references should drag correctly.

EXAMPLE DETERMINISTIC SLICE:
{
  "id": "revenue",
  "title": "Revenue build",
  "deps": ["assumptions"],
  "scope": {
    "sheets_owned": ["Revenue"],
    "ranges_owned": [],
    "may_read_from": ["Assumptions!A1:B40"]
  },
  "instructions": "Deterministic revenue build. Actions are authoritative.",
  "estimated_iters": 3,
  "tier": "pro",
  "actions": [
    { "tool": "bulk_create_sheets", "params": { "names": ["Revenue"] } },
    { "tool": "bulk_set_cell_ranges", "params": { "writes": [
      { "sheet": "Revenue", "cells": {
        "A1": { "value": "Revenue" },
        "B3": { "value": 2025 },
        "C3": { "value": 2026 },
        "A5": { "value": "Net Revenue" },
        "B5": { "formula": "=Assumptions!$B$5*Assumptions!$B$6*Assumptions!$B$7" },
        "C5": { "formula": "=B5*(1+Assumptions!$B$8)" }
      }, "copyToRange": "C5:G5" }
    ] } },
    { "tool": "bulk_set_format", "params": { "formats": [
      { "sheet": "Revenue", "target": "A1:G1", "options": { "bold": true, "backgroundColor": "#0D1F2D", "fontColor": "#FFFFFF" } },
      { "sheet": "Revenue", "target": "B5:G20", "options": { "numberFormat": "#,##0" } }
    ] } }
  ]
}

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
      "instructions": "<legacy fallback instructions or concise deterministic summary>",
      "estimated_iters": <int 3-20>,
      "tier": "pro",
      "actions": [
        { "tool": "<allowed_tool>", "params": { } }
      ]
    }
  ]
}

Reply with ONLY the JSON object. No markdown fences. No prose outside JSON.`;

function buildArchitectUserContent({ objective, context = {}, triage = null }) {
  const sheetNames = (context.workbookSheets || context.allSheets || (context.allSheetsData ? Object.keys(context.allSheetsData) : [])).slice(0, 30);
  const activeSheet = context.activeSheet || 'unknown';
  const menuFacts = extractVerbatimMenuFacts(objective);
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
    menuFacts.length >= 5 ? [
      '',
      'VERBATIM MENU FACTS (hard requirement: write every row into workbook actions; category-only summaries fail validation):',
      'Item | Base price | Menu price',
      ...menuFacts.map(f => `${f.name} | ${f.basePriceText} EUR | ${f.menuPriceText ? `${f.menuPriceText} EUR` : ''}`)
    ].join('\n') : null,
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

  const scale = triage && triage.scale_hints ? triage.scale_hints : null;
  if (scale && (scale.rowsRequested || scale.periods || scale.units || scale.detailLevel)) {
    lines.push('');
    lines.push(`SCALE TARGETS (parsed from user objective — match this density in the blueprint):`);
    if (scale.rowsRequested) lines.push(`- target row count: ~${scale.rowsRequested} data rows across the workbook`);
    if (scale.periods) lines.push(`- period schedule: ${scale.periods} ${scale.periodGranularity || 'periods'} (use copyToRange for the time axis)`);
    else if (scale.periodGranularity) lines.push(`- period granularity: ${scale.periodGranularity} (size the schedule to the project horizon)`);
    if (scale.units) lines.push(`- unit-level detail: ${scale.units} unit rows (per floor / apartment / space — one row per unit)`);
    if (scale.detailLevel === 'high') lines.push(`- detail level: HIGH — user explicitly requested granular / row-by-row output`);
    const target = scale.rowsRequested || 0;
    if (target >= 1000) {
      lines.push(`- guidance: build dense schedules. Use copyToRange aggressively. Plan 10-15 slices with multi-period AND per-unit detail. Summary-only blueprints will be rejected as "missed the brief".`);
    } else if (target >= 500) {
      lines.push(`- guidance: include 2-3 dense schedules (monthly / per-unit). Plan 8-12 slices. Do NOT collapse the horizon into single-cell totals.`);
    } else if (target >= 200) {
      lines.push(`- guidance: include at least one multi-period schedule built with copyToRange. Plan 6-10 slices.`);
    } else {
      lines.push(`- guidance: free choice on density, but still build period schedules where the objective implies them.`);
    }
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
  const validation = validateBlueprint(parsed, { workbookSheets: context.workbookSheets || [], objective });
  if (!validation.ok) {
    const retryable = validation.errors.some(err => /verbatim menu coverage|formula references sheet|unquoted sheet reference/i.test(err));
    if (retryable) {
      const repairUserContent = `${userContent}\n\nVALIDATION FAILED. Regenerate the full JSON blueprint fixing these errors:\n- ${validation.errors.join('\n- ')}\n\nFor menu coverage errors, add a deterministic Menu/Menu Detail slice whose actions write every extracted item and price exactly, then build revenue formulas from that sheet.`;
      let retryRaw;
      try {
        retryRaw = await callLLMFn({
          system: ARCHITECT_SYSTEM_PROMPT,
          userText: repairUserContent,
          timeoutMs: ARCHITECT_DEFAULT_TIMEOUT_MS,
          fallbackTimeoutMs: ARCHITECT_DEFAULT_TIMEOUT_MS,
          modelOverride: modelOverride || undefined,
          role: 'architect',
          label: 'Architect blueprint retry'
        });
      } catch (err) {
        throw new Error(`Architect blueprint validation failed and retry failed: ${validation.errors.join('; ')}; retry error: ${err.message}`);
      }
      const retryParsed = extractArchitectJson(retryRaw);
      if (!retryParsed) throw new Error(`Architect blueprint validation failed and retry produced unparseable JSON: ${validation.errors.join('; ')}`);
      const retryValidation = validateBlueprint(retryParsed, { workbookSheets: context.workbookSheets || [], objective });
      if (!retryValidation.ok) {
        throw new Error(`Architect blueprint validation failed after retry: ${retryValidation.errors.join('; ')}`);
      }
      retryValidation.blueprint._meta = {
        latencyMs: Date.now() - start,
        model: retryRaw?._model || null,
        repaired: true
      };
      return retryValidation.blueprint;
    }
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
function validateBlueprint(raw, context = {}) {
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
    // Default tier is now 'pro'. Flash is opt-in (typically only format_and_verify).
    // Build slices have long prompts + multi-step reasoning over upstream layouts;
    // flash collapses on them (see 5 bandaid commits on 2026-05-30).
    const tier = s.tier === 'flash' ? 'flash' : 'pro';
    const actionValidation = validateSliceActions(s.id, s.actions);
    if (!actionValidation.ok) {
      errors.push(...actionValidation.errors);
      continue;
    }

    normalizedSlices.push({
      id: s.id,
      title: String(s.title || s.id),
      deps,
      scope: { sheets_owned: sheetsOwned, ranges_owned: rangesOwned, may_read_from: mayReadFrom },
      instructions: String(s.instructions || '').slice(0, 8000),
      estimated_iters: Number.isFinite(estIters) ? Math.max(3, Math.min(20, Math.round(estIters))) : 10,
      tier,
      actions: actionValidation.actions
    });
  }
  if (errors.length) return { ok: false, errors };

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

  errors.push(...validateDeterministicFormulaReferences(normalizedSlices, context));
  errors.push(...validateVerbatimSourceFacts(normalizedSlices, context));
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
function buildSliceWorkerPrompt(slice, blueprint, userObjective = '') {
  const scope = slice.scope;
  const hasUpstream = scope.may_read_from.length > 0;
  const userBlock = userObjective && String(userObjective).trim()
    ? `\n\nORIGINAL USER REQUEST (verbatim — this is the SOURCE OF TRUTH for all domain data: exact menu items, names, prices, list entries, numbers explicitly given. Architect's instructions may have summarized; if you would otherwise invent any item/price/name/category that COULD be derived from this text, you MUST use the literal value from here instead):
"""
${String(userObjective).slice(0, 8000)}
"""\n`
    : '';
  return `<slice-context>
You are a focused worker building ONE slice of a larger blueprint. Other workers are building other slices in parallel.

SLICE: ${slice.id} — ${slice.title}
${userBlock}
YOUR EXCLUSIVE SCOPE (write here, nowhere else):
- sheets owned: ${scope.sheets_owned.length ? scope.sheets_owned.join(', ') : '(none — use ranges_owned)'}
- ranges owned: ${scope.ranges_owned.length ? scope.ranges_owned.join(', ') : '(full sheets above)'}

READ-ONLY references (data from completed slices you may reference, e.g. via formulas):
${hasUpstream ? scope.may_read_from.map(r => '- ' + r).join('\n') : '(none)'}

GLOBAL LAYOUT CONVENTIONS (follow these across the model):
${blueprint.global_layout_notes || '(none specified)'}

YOUR INSTRUCTIONS (do exactly this, nothing more, nothing less):
${slice.instructions}

HARD RULES:
- DO NOT write to sheets or ranges outside your scope. If you need to reference data from another slice, use a formula referencing its known address from may_read_from.
- DO NOT call ask_user_question. Make reasonable defaults.${hasUpstream ? `
- READ BEFORE YOU WRITE: your first tool call MUST be a read (get_cell_ranges / read_sheet) against the upstream ranges listed above. Do NOT guess upstream layout from the slice instructions — in prod runs, workers that skipped this step wrote formulas pointing to wrong cells and had to redo the slice 4-8 times. Confirm exact addresses, then write your formulas against those exact addresses.
- IF a read returns suspiciously thin data (only A1, zero rows, sheet "doesn't exist"), it is a TOOL ISSUE — the upstream slice succeeded before yours started. Retry ONCE with read_sheet on the same sheet. If still thin, write your formulas anyway using the absolute address from may_read_from (e.g. =Assumptions!$B$5). DO NOT call done with reason "upstream not available" — that is a confabulation; the orchestrator will reject it.` : ''}
- ITER BUDGET IS TIGHT (~${20}). Consolidate writes: a P&L / cash-flow / balance-sheet slice should be ONE bulk_set_cell_ranges call (up to 32 writes per call) for ALL section rows, then ONE bulk_set_format pass for formatting. Sequential per-row set_cell_range calls burn the budget and cascade-kill downstream waves.
- TOOL PARAMS are not negotiable. Memorize these EXACT shapes (the wrong name burns one iteration every single time):
    bulk_create_sheets:    {"names":["Sheet1","Sheet2"]}                          — NOT "sheets"
    bulk_set_cell_ranges:  {"writes":[{"sheet":"S","cells":{"A1":{"value":1}}}]}  — NOT "entries"/"ranges"/"cells" at top level
    bulk_set_format:       {"formats":[{"sheet":"S","target":"A1:B2","options":{"bold":true}}]}  — NOT "writes"/"ranges" (formats is the canonical key; writes is bulk_set_cell_ranges)
    get_cell_ranges:       {"ranges":[{"sheet":"S","target":"A1:B40"}]}           — target MUST be a real range, NOT just "A1"
    set_cell_range:        {"sheet":"S","cells":{"A1":{"value":1,"formula":"=B1+C1"}}}
  bulk_set_format options keys: backgroundColor, fontColor, bold, italic, numberFormat, columnWidth, rowHeight, horizontalAlignment, borders. Flat keys, NOT nested under "font" / "fill".
- IF YOUR OWNED SHEET ALREADY EXISTS in the workbook (you can see it from the initial workbook overview), DELETE IT FIRST with delete_sheet, THEN create_sheet/bulk_create_sheets fresh. Past runs left old generic data mixed with the new specific data because workers wrote into existing rows without clearing — the result was Assumptions sheets with two different revenue growth rates side by side.
- DO NOT touch "Sheet1" or any sheet NOT in your owned scope. Sheet1 is the user's default placeholder; deleting it is NOT your job and burns an iteration (it often errors with "operation not permitted" on the last sheet anyway). Focus 100% of your iters on YOUR scope.
- IF AN UPSTREAM READ RETURNS A VALUE that doesn't match the slice instructions (e.g. instructions say "Assumptions!B20 = growth_rate (0.05)" but you read B20 = 10 with label "Depreciation Years"), DO NOT re-read multiple narrow ranges to triangulate. Issue ONE read_sheet on the upstream sheet (entire A:B range), scan column A for the label you need ("Growth Rate"), find its actual row, and use THAT address in your formulas. Cap layout-discovery at 2 reads total per slice; past runs spent 5+ iters re-reading and hit max_iter.
- SANITY CHECK before calling done: when you wrote a time series (e.g. revenue across 2025-2030), the year-over-year ratio should be roughly 1±0.5 (anything growing 50,000× year-over-year means you referenced the WRONG cell — most commonly multiplying by an absolute € amount instead of a percentage). Read back B6:G6 of your output, eyeball the ratios, and if a year is >10× the prior year, you MUST rewrite that formula using the LITERAL cell address from the slice instructions (architect provides it — do not invent). Also: if Net Revenue is identical for every year (no compounding visible), your formula chain is broken — fix before done.
- execute_office_js is BLOCKED for slice workers (and will be rejected before reaching Excel). Use set_cell_range / bulk_set_cell_ranges for data + formulas, bulk_set_format for formatting, create_sheet / bulk_create_sheets for sheet ops, execute_excel_formula for one-off formulas. Do NOT attempt execute_office_js — every attempt is a wasted iteration.
- copyToRange is FORMULAS ONLY (relative refs adjust per cell). Never use copyToRange with a text label as the source cell — it paints the label into every destination. For headers/titles, write to one cell and merge if you need it visually wide.
- DO NOT call done until you have actually written cells in your owned scope. A done with zero writes will be rejected as a failed slice and cascade-kill downstream slices. If you're stuck, write what you can with absolute references and explain in the done summary what is incomplete.
- When this slice is done, call the "done" tool with a one-line summary describing what you wrote.
</slice-context>`;
}

module.exports = {
  generateBlueprint,
  // exported for tests
  ARCHITECT_SYSTEM_PROMPT,
  buildArchitectUserContent,
  extractArchitectJson,
  validateBlueprint,
  validateSliceActions,
  extractFormulaSheetRefs,
  detectUnquotedSheetNamesWithSpecialChars,
  validateDeterministicFormulaReferences,
  extractVerbatimMenuFacts,
  validateVerbatimSourceFacts,
  buildSliceWorkerPrompt
};
