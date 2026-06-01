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
const { extractScaleHints } = require('./triage');
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
const ARCHITECT_MAX_LITERAL_WRITE_KEYS = Math.max(50, Number(process.env.AGENT_MAX_LITERAL_WRITE_KEYS) || 1200);
const ARCHITECT_MAX_WRITE_ACTION_CELLS = Math.max(1000, Number(process.env.AGENT_MAX_WRITE_ACTION_CELLS) || 12000);
const ARCHITECT_MAX_BULK_WRITE_CELLS = Math.max(ARCHITECT_MAX_WRITE_ACTION_CELLS, Number(process.env.AGENT_MAX_BULK_WRITE_CELLS) || 12000);
const ARCHITECT_MAX_FORMAT_TARGET_CELLS = Math.max(1000, Number(process.env.AGENT_MAX_FORMAT_TARGET_CELLS) || 12000);
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

function architectColToIndex(col) {
  let n = 0;
  for (const ch of String(col || '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function architectIndexToCol(index) {
  let n = Number(index);
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseA1Bounds(addr) {
  if (typeof addr !== 'string') return null;
  const raw = addr.replace(/\$/g, '').trim();
  const withoutSheet = raw.includes('!') ? raw.split('!').pop() : raw;
  if (!withoutSheet || withoutSheet.includes(',')) return null;
  const m = withoutSheet.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
  if (!m) return null;
  const startCol = architectColToIndex(m[1]);
  const startRow = Number(m[2]);
  const endCol = m[3] ? architectColToIndex(m[3]) : startCol;
  const endRow = m[4] ? Number(m[4]) : startRow;
  return {
    startCol: Math.min(startCol, endCol),
    endCol: Math.max(startCol, endCol),
    startRow: Math.min(startRow, endRow),
    endRow: Math.max(startRow, endRow),
  };
}

function getA1RangeStats(addr) {
  if (typeof addr !== 'string') return { cells: 1, maxRow: null, bounded: true, valid: true };
  const raw = addr.replace(/\$/g, '').trim();
  const withoutSheet = raw.includes('!') ? raw.split('!').pop() : raw;
  if (!withoutSheet || withoutSheet.includes(',')) return { cells: Infinity, maxRow: null, bounded: false, valid: false };
  if (/^[A-Z]+:[A-Z]+$/i.test(withoutSheet) || /^\d+:\d+$/i.test(withoutSheet)) {
    return { cells: Infinity, maxRow: null, bounded: false, valid: true };
  }
  const m = withoutSheet.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
  if (!m) return { cells: Infinity, maxRow: null, bounded: false, valid: false };
  const c1 = architectColToIndex(m[1]);
  const r1 = Number(m[2]);
  const c2 = m[3] ? architectColToIndex(m[3]) : c1;
  const r2 = m[4] ? Number(m[4]) : r1;
  return {
    cells: (Math.abs(r2 - r1) + 1) * (Math.abs(c2 - c1) + 1),
    maxRow: Math.max(r1, r2),
    bounded: true,
    valid: true
  };
}

function inferFormulaCopyRange(seedAddr, copyToRange) {
  const seed = parseA1Bounds(seedAddr);
  const dest = parseA1Bounds(copyToRange);
  if (!seed || !dest || seed.startCol !== seed.endCol || seed.startRow !== seed.endRow) return null;
  const seedCol = seed.startCol;
  const seedRow = seed.startRow;
  if (seedRow === dest.startRow - 1 && seedCol >= dest.startCol && seedCol <= dest.endCol) {
    const col = architectIndexToCol(seedCol);
    return `${col}${dest.startRow}:${col}${dest.endRow}`;
  }
  if (seedCol === dest.startCol - 1 && seedRow >= dest.startRow && seedRow <= dest.endRow) {
    return `${architectIndexToCol(dest.startCol)}${seedRow}:${architectIndexToCol(dest.endCol)}${seedRow}`;
  }
  if (seedRow === dest.startRow && seedCol === dest.startCol) {
    return copyToRange;
  }
  return null;
}

function splitBulkWritesByCellLimit(writes) {
  const chunks = [];
  let current = [];
  let currentCells = 0;
  for (const write of writes) {
    const writeCells = estimateCellMapCells(write.cells, write.copyToRange);
    if (current.length > 0 && Number.isFinite(writeCells) && currentCells + writeCells > ARCHITECT_MAX_BULK_WRITE_CELLS) {
      chunks.push(current);
      current = [];
      currentCells = 0;
    }
    current.push(write);
    currentCells += Number.isFinite(writeCells) ? writeCells : ARCHITECT_MAX_BULK_WRITE_CELLS + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function normalizeBulkCopyWrite(write) {
  if (!write?.copyToRange || !write.cells || typeof write.cells !== 'object' || Array.isArray(write.cells)) {
    return [write];
  }
  if (isFormulaCellSpec(firstCellSpec(write.cells))) return [write];

  const formulaEntries = Object.entries(write.cells)
    .filter(([, spec]) => isFormulaCellSpec(spec))
    .map(([addr, spec]) => ({ addr, spec, copyToRange: inferFormulaCopyRange(addr, write.copyToRange) }))
    .filter(entry => entry.copyToRange);
  if (formulaEntries.length === 0) return [write];

  const staticWrite = { ...write };
  delete staticWrite.copyToRange;
  const out = [staticWrite];
  for (const entry of formulaEntries) {
    out.push({
      sheet: write.sheet,
      cells: { [entry.addr]: entry.spec },
      copyToRange: entry.copyToRange
    });
  }
  return out;
}

function normalizeDeterministicAction(tool, params) {
  if (tool !== 'bulk_set_cell_ranges') return [{ tool, params }];
  const expandedWrites = [];
  for (const write of Array.isArray(params.writes) ? params.writes : []) {
    expandedWrites.push(...normalizeBulkCopyWrite(write));
  }
  return splitBulkWritesByCellLimit(expandedWrites).map(writes => ({
    tool,
    params: { ...params, writes }
  }));
}

function estimateCellMapCells(cells, copyToRange) {
  if (!cells || typeof cells !== 'object') return 0;
  let total = 0;
  for (const addr of Object.keys(cells)) {
    const stats = getA1RangeStats(addr);
    if (!Number.isFinite(stats.cells)) return Infinity;
    total += stats.cells;
  }
  if (copyToRange) {
    const copyStats = getA1RangeStats(copyToRange);
    if (!Number.isFinite(copyStats.cells)) return Infinity;
    total += copyStats.cells;
  }
  return total;
}

function firstCellSpec(cells) {
  const entries = Object.entries(cells || {});
  return entries.length ? entries[0][1] : null;
}

function isFormulaCellSpec(spec) {
  return !!formulaLiteralFromCellSpec(spec);
}

function validateWriteDensityShape({ cells, copyToRange, label }) {
  const errors = [];
  const literalKeys = cells && typeof cells === 'object' ? Object.keys(cells).length : 0;
  if (literalKeys > ARCHITECT_MAX_LITERAL_WRITE_KEYS) {
    errors.push(`${label}: too many explicit cell entries (${literalKeys}, max ${ARCHITECT_MAX_LITERAL_WRITE_KEYS}); use a seed formula plus copyToRange`);
  }
  if (copyToRange && !isFormulaCellSpec(firstCellSpec(cells))) {
    errors.push(`${label}: copyToRange must copy a formula seed cell, not a text/value seed`);
  }
  const cellsTotal = estimateCellMapCells(cells, copyToRange);
  if (!Number.isFinite(cellsTotal)) {
    errors.push(`${label}: unbounded or invalid A1 range detected; use finite ranges like A1:J1000 and never comma-separated target lists`);
  } else if (cellsTotal > ARCHITECT_MAX_WRITE_ACTION_CELLS) {
    errors.push(`${label}: write covers ${cellsTotal} cells (max ${ARCHITECT_MAX_WRITE_ACTION_CELLS}); split the schedule into smaller finite copyToRange blocks`);
  }
  return { errors, cellsTotal };
}

function formatOptionsAllowUnboundedTarget(options = {}) {
  const keys = Object.keys(options || {});
  return keys.length > 0 && keys.every(key => key === 'columnWidth' || key === 'rowHeight');
}

function validateActionSemanticShape(toolName, params) {
  const errors = [];
  if (toolName === 'set_cell_range') {
    if (!params.cells || typeof params.cells !== 'object' || Array.isArray(params.cells) || Object.keys(params.cells).length === 0) {
      errors.push('params.cells must be a non-empty object');
    } else {
      errors.push(...validateWriteDensityShape({
        cells: params.cells,
        copyToRange: params.copyToRange,
        label: 'set_cell_range'
      }).errors);
    }
  }
  if (toolName === 'bulk_set_cell_ranges') {
    const writes = Array.isArray(params.writes) ? params.writes : [];
    let aggregateCells = 0;
    writes.forEach((write, index) => {
      if (!write.cells || typeof write.cells !== 'object' || Array.isArray(write.cells) || Object.keys(write.cells).length === 0) {
        errors.push(`params.writes[${index}].cells must be a non-empty object`);
        return;
      }
      const check = validateWriteDensityShape({
        cells: write.cells,
        copyToRange: write.copyToRange,
        label: `bulk_set_cell_ranges writes[${index}]`
      });
      errors.push(...check.errors);
      aggregateCells += Number.isFinite(check.cellsTotal) ? check.cellsTotal : ARCHITECT_MAX_BULK_WRITE_CELLS + 1;
    });
    if (aggregateCells > ARCHITECT_MAX_BULK_WRITE_CELLS) {
      errors.push(`bulk_set_cell_ranges: aggregate write covers ${aggregateCells} cells (max ${ARCHITECT_MAX_BULK_WRITE_CELLS}); split dense sheets across multiple actions`);
    }
  }
  if (toolName === 'bulk_set_format') {
    const formats = Array.isArray(params.formats) ? params.formats : [];
    formats.forEach((format, index) => {
      if (!format.options || typeof format.options !== 'object' || Array.isArray(format.options) || Object.keys(format.options).length === 0) {
        errors.push(`params.formats[${index}].options must be a non-empty object`);
        return;
      }
      const stats = getA1RangeStats(format.target);
      if (!stats.valid || !stats.bounded || !Number.isFinite(stats.cells)) {
        if (!formatOptionsAllowUnboundedTarget(format.options)) {
          errors.push(`params.formats[${index}].target must be one finite A1 range, not "${format.target}"`);
        }
      } else if (stats.cells > ARCHITECT_MAX_FORMAT_TARGET_CELLS) {
        errors.push(`params.formats[${index}].target covers ${stats.cells} cells (max ${ARCHITECT_MAX_FORMAT_TARGET_CELLS})`);
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
    const normalizedActions = normalizeDeterministicAction(tool, JSON.parse(JSON.stringify(params)));
    for (const normalizedAction of normalizedActions) {
      const semanticErrors = validateActionSemanticShape(normalizedAction.tool, normalizedAction.params);
      if (semanticErrors.length > 0) {
        errors.push(...semanticErrors.map(err => `${prefix} (${tool}): ${err}`));
        return;
      }
      normalized.push(normalizedAction);
    }
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
    const candidate = m[1].trim();
    if (/^[A-Z]+\d+\s*-\s*[A-Za-z_][A-Za-z0-9_]*$/i.test(candidate)) continue;
    out.push(candidate);
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

function collectBlueprintWriteDensity(slices) {
  const bySheet = new Map();
  const ensure = (sheet) => {
    const key = String(sheet || '').trim();
    if (!key) return null;
    if (!bySheet.has(key)) bySheet.set(key, { maxRow: 0, copyToRangeCount: 0, writeActions: 0 });
    return bySheet.get(key);
  };
  const touch = (sheet, cells = {}, copyToRange = null) => {
    const entry = ensure(sheet);
    if (!entry) return;
    entry.writeActions += 1;
    for (const addr of Object.keys(cells || {})) {
      const stats = getA1RangeStats(addr);
      if (Number.isFinite(stats.maxRow || 0)) entry.maxRow = Math.max(entry.maxRow, stats.maxRow || 0);
    }
    if (copyToRange) {
      const stats = getA1RangeStats(copyToRange);
      if (Number.isFinite(stats.maxRow || 0)) entry.maxRow = Math.max(entry.maxRow, stats.maxRow || 0);
      entry.copyToRangeCount += 1;
    }
  };
  const touchRange = (rangeText, instructions = '') => {
    const text = String(rangeText || '').trim();
    if (!text.includes('!')) return;
    const bang = text.indexOf('!');
    const sheet = text.slice(0, bang).replace(/^'|'$/g, '');
    const range = text.slice(bang + 1);
    const entry = ensure(sheet);
    if (!entry) return;
    const stats = getA1RangeStats(range);
    if (Number.isFinite(stats.maxRow || 0)) entry.maxRow = Math.max(entry.maxRow, stats.maxRow || 0);
    if (stats.cells >= 200 && /copyToRange|copy[- ]?to[- ]?range|formula[- ]?copy|fill|relative/i.test(String(instructions || ''))) {
      entry.copyToRangeCount += 1;
    }
  };

  for (const slice of slices || []) {
    const scope = slice.scope || {};
    for (const range of Array.isArray(scope.ranges_owned) ? scope.ranges_owned : []) {
      touchRange(range, slice.instructions || '');
    }
    for (const action of slice.actions || []) {
      if (action.tool === 'set_cell_range') {
        touch(action.params?.sheet, action.params?.cells, action.params?.copyToRange);
      }
      if (action.tool === 'bulk_set_cell_ranges') {
        for (const write of Array.isArray(action.params?.writes) ? action.params.writes : []) {
          touch(write.sheet, write.cells, write.copyToRange);
        }
      }
    }
  }

  return bySheet;
}

function isMajorDensitySheet(sheetName) {
  const name = String(sheetName || '').toLowerCase();
  return !!name && !/(assumptions?|inputs?|format|verify|notes?|summary)/i.test(name);
}

function validateDensityCoverage(slices, context = {}) {
  const objective = context.objective || context.sourceObjective || '';
  const scale = extractScaleHints(objective);
  const targetRows = scale.rowsPerSheetRequested || 0;
  if (targetRows < 500) return [];

  const errors = [];
  const densityBySheet = collectBlueprintWriteDensity(slices);
  const majorEntries = [...densityBySheet.entries()].filter(([sheet]) => isMajorDensitySheet(sheet));
  const denseThreshold = Math.floor(targetRows * (targetRows >= 1000 ? 0.8 : 0.6));
  const denseSheets = majorEntries.filter(([, info]) => info.maxRow >= denseThreshold);
  const copyToRangeCount = majorEntries.reduce((sum, [, info]) => sum + info.copyToRangeCount, 0);
  const minDenseSheets = targetRows >= 1000 ? 4 : 2;
  const minCopies = targetRows >= 1000 ? 4 : 2;

  if (denseSheets.length < Math.min(minDenseSheets, Math.max(1, majorEntries.length))) {
    const observed = majorEntries.map(([sheet, info]) => `${sheet}:${info.maxRow}`).join(', ') || 'none';
    errors.push(`density coverage failed: only ${denseSheets.length} major sheet(s) reach ~${denseThreshold}+ rows; observed max rows by sheet: ${observed}`);
  }
  if (copyToRangeCount < minCopies) {
    errors.push(`density coverage failed: only ${copyToRangeCount} copyToRange schedule(s); dense workbooks need at least ${minCopies} finite formula-copy blocks`);
  }
  return errors;
}

function sliceOwnsWritableScope(slice) {
  const scope = slice?.scope || {};
  return (Array.isArray(scope.sheets_owned) && scope.sheets_owned.length > 0) ||
    (Array.isArray(scope.ranges_owned) && scope.ranges_owned.length > 0);
}

function isFinalVerificationSlice(slice) {
  const id = String(slice?.id || '').toLowerCase();
  const title = String(slice?.title || '').toLowerCase();
  if (/format.*verify|verify.*format|finali[sz]e|audit|review/.test(`${id} ${title}`)) return true;
  return !sliceOwnsWritableScope(slice) && /format|verify|final|audit|review/.test(`${id} ${title}`);
}

function isAssumptionLikeSlice(slice) {
  const text = [
    slice?.id,
    slice?.title,
    ...(slice?.scope?.sheets_owned || [])
  ].join(' ').toLowerCase();
  return /assumptions?|inputs?|drivers?/.test(text);
}

function isScaffoldLikeSlice(slice) {
  const idTitle = [slice?.id, slice?.title].join(' ').toLowerCase();
  const instructions = String(slice?.instructions || '').toLowerCase();
  if (/(assumptions?|inputs?|drivers?)/.test(idTitle)) return false;
  if (/(scaffold|workbook[\s_-]*(setup|structure|skeleton)|sheet[\s_-]*setup|tab[\s_-]*setup)/.test(idTitle)) {
    return true;
  }
  return /(create|crea).{0,50}(tabs?|sheets?|fogli).{0,50}(only|solo)/i.test(instructions) &&
    !/(formula|revenue|cost|construction|financing|cash flow|valuation|driver table|assumptions?)/i.test(instructions);
}

function uniqueScaffoldId(slices) {
  const ids = new Set((slices || []).map(slice => slice.id));
  if (!ids.has('workbook_scaffold')) return 'workbook_scaffold';
  let index = 2;
  while (ids.has(`workbook_scaffold_${index}`)) index += 1;
  return `workbook_scaffold_${index}`;
}

function collectDeclaredWorkbookSheets(slices, context = {}) {
  const existing = new Set((context.workbookSheets || context.sheets || []).map(String));
  const names = new Set();
  for (const slice of slices || []) {
    const scope = slice?.scope || {};
    for (const sheet of Array.isArray(scope.sheets_owned) ? scope.sheets_owned : []) {
      if (sheet) names.add(String(sheet));
    }
    for (const ref of Array.isArray(scope.ranges_owned) ? scope.ranges_owned : []) {
      const sheet = extractSheetNameFromReference(ref);
      if (sheet) names.add(sheet);
    }
    for (const ref of Array.isArray(scope.may_read_from) ? scope.may_read_from : []) {
      const sheet = extractSheetNameFromReference(ref);
      if (sheet) names.add(sheet);
    }
    for (const action of Array.isArray(slice.actions) ? slice.actions : []) {
      const actionSheets = new Set();
      collectActionSheetNames(action, actionSheets);
      for (const sheet of actionSheets) names.add(sheet);
    }
  }
  return [...names]
    .map(name => String(name || '').trim())
    .filter(name => name && !existing.has(name));
}

function appendDenseParallelInstruction(slice, targetRows) {
  const current = String(slice.instructions || '');
  const already = /Dense parallel build:/i.test(current);
  if (already) return current;
  const parts = [
    current,
    '',
    `Dense parallel build: this workbook is scaffolded before content workers start. If may_read_from sheets are blank, do not wait; write formulas to the declared absolute addresses and let Excel recalculate when the referenced slice fills its sheet. Use formula seeds plus copyToRange for schedules through roughly row ${targetRows || 1000}.`
  ];
  if (isAssumptionLikeSlice(slice)) {
    parts.push('Assumptions speed contract: write the complete two-column driver table in one bulk_set_cell_ranges call, apply at most one bulk_set_format pass, then call done. Do not drip-feed assumptions row by row.');
  }
  return parts.join('\n').slice(0, 8000);
}

function shouldParallelizeDenseBlueprint(slices, context = {}) {
  if (process.env.ARCHITECT_DENSE_PARALLELISM === 'false') return false;
  const objective = context.objective || context.sourceObjective || '';
  const scale = extractScaleHints(objective);
  const targetRows = scale.rowsPerSheetRequested || 0;
  if (targetRows < 500) return false;
  const contentSlices = (slices || []).filter(slice =>
    sliceOwnsWritableScope(slice) &&
    !isFinalVerificationSlice(slice) &&
    !isScaffoldLikeSlice(slice)
  );
  if (contentSlices.length < 4) return false;
  const sheetNames = collectDeclaredWorkbookSheets(slices, context);
  return sheetNames.length >= 4;
}

function normalizeDenseBlueprintParallelism(slices, context = {}) {
  if (!shouldParallelizeDenseBlueprint(slices, context)) return { slices, addedScaffold: false };

  const objective = context.objective || context.sourceObjective || '';
  const scale = extractScaleHints(objective);
  const targetRows = scale.rowsPerSheetRequested || scale.rowsRequested || 1000;
  const sheetNames = collectDeclaredWorkbookSheets(slices, context);
  const keptSlices = slices.filter(slice => !isScaffoldLikeSlice(slice));
  const scaffoldId = uniqueScaffoldId(keptSlices);
  const scaffoldActionValidation = validateSliceActions(scaffoldId, [
    { tool: 'bulk_create_sheets', params: { names: sheetNames } }
  ]);
  if (!scaffoldActionValidation.ok) {
    logger.warn({ errors: scaffoldActionValidation.errors }, '[Architect] Dense scaffold action validation failed; keeping original DAG');
    return { slices, addedScaffold: false };
  }

  const scaffold = {
    id: scaffoldId,
    title: 'Workbook Scaffold',
    deps: [],
    scope: { sheets_owned: [], ranges_owned: [], may_read_from: [] },
    instructions: `Create the declared workbook tabs only: ${sheetNames.join(', ')}. Do not write values, formulas, formats, or notes; this slice exists so parallel content workers can safely write cross-sheet formulas.`,
    estimated_iters: 3,
    tier: 'flash',
    actions: scaffoldActionValidation.actions
  };

  const cloned = keptSlices.map(slice => ({
    ...slice,
    deps: Array.isArray(slice.deps) ? [...slice.deps] : [],
    scope: {
      sheets_owned: [...(slice.scope?.sheets_owned || [])],
      ranges_owned: [...(slice.scope?.ranges_owned || [])],
      may_read_from: [...(slice.scope?.may_read_from || [])]
    },
    actions: Array.isArray(slice.actions) ? [...slice.actions] : []
  }));
  const materialIds = cloned
    .filter(slice => !isFinalVerificationSlice(slice))
    .map(slice => slice.id);
  const allContentIds = cloned.map(slice => slice.id);

  for (const slice of cloned) {
    if (isFinalVerificationSlice(slice)) {
      slice.deps = [scaffoldId, ...allContentIds.filter(id => id !== slice.id)];
      continue;
    }
    slice.deps = [scaffoldId];
    slice.instructions = appendDenseParallelInstruction(slice, targetRows);
  }

  return {
    slices: [scaffold, ...cloned],
    addedScaffold: true,
    materialIds
  };
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

const ARCHITECT_SYSTEM_PROMPT = `You are an architect for AI-built Excel workbooks.
Given a user objective and current workbook state, produce one compact BLUEPRINT: a directed acyclic graph (DAG) of focused worker slices.

EXECUTION MODEL:
- Default is AI-only worker execution. Leave slice.actions as [] unless deterministic actions are explicitly required by validation/source fidelity.
- Do not prebuild the workbook in the blueprint. The blueprint is a routing contract: sheets, ranges, dependencies, and concise instructions for specialist workers.
- Workers have structured Excel tools and will create sheets, write formulas, use copyToRange, format, read upstream ranges, and verify their own output.

DAG RULES:
- Each slice owns an exclusive set of sheets/ranges. Two slices in the same wave must not overlap writable sheets/ranges.
- A slice may read/reference upstream outputs only when those upstream slice ids are in deps[].
- Maximize parallelism. For large dense workbooks, create a workbook scaffold first, then let cost, revenue, construction, financing, cash flow, P&L, valuation, and sensitivity run in parallel using formula references to declared ranges.
- Prefer 2-3 waves for dense builds: workbook scaffold -> parallel content schedules -> format_and_verify. Do not serialize revenue -> cash flow -> P&L unless the user explicitly requires a manual sign-off between sheets.
- Keep one final format_and_verify slice with no owned sheets.

DENSITY RULES:
- Match the user's requested scale. "1000 righe per foglio" means major operating sheets need ranges ending near row 1000.
- For dense sheets, put finite ranges in scope.ranges_owned, e.g. "Revenue Schedule!A1:BI1005".
- In instructions, explicitly tell workers to use formula patterns and copyToRange for dense schedules. Do not ask them to enumerate 1000 unique rows by hand.
- For real estate/project finance, include assumptions, per-floor/unit detail, cost breakdown, revenue/absorption, construction schedule, financing/debt, cash flow, P&L or returns, valuation/sensitivity, and formatting/audit.
- If four or more major sheets need ~1000 rows, make at least four slices own finite ranges reaching ~800+ rows.

ZERO-DETERMINISTIC-FILL POLICY (CRITICAL — applied server-side, violations rejected):
- "1000 righe" means 1000 rows of REAL data, NOT 10 real rows + 990 padding/filler. If the domain only supports N meaningful rows (e.g. 10 piani × 36 mesi = 360 rows), write exactly N rows and stop. Never duplicate a row to "reach the target".
- A guard rejects any write where the same scalar value appears in ≥20 distinct rows of one column. Past failure (Vairano 2026-06-01): Per-Floor Detail wrote "Scavi e movimentazione terra" + "10000" in 600 contiguous rows to pad to ~1000 — the result was junk that polluted SUMIFs downstream.
- Cash Flow MUST be 1 row per period across the full horizon (e.g. 1 row per month for 36 months × 10 piani = 360 rows, OR a wide pivot of months as columns × line items as rows). Do NOT write sentinel rows at month 1, 37, 73, 109 only and leave the rest blank — past failure produced a Cash Flow with 10 valid rows and 352 empty rows.
- P&L MUST have a complete row per year over the model horizon (typically 4-6 years for a construction project, with Anno 0 = pre-construction). All cost categories from Cost Breakdown roll up annually.
- Valuation/Returns slices MUST find Equity / Debito / WACC / Costo Capitale on Assumptions. If the architect plan does NOT include explicit rows for these on Assumptions, ADD THEM to the assumptions slice instructions BEFORE planning a valuation slice. The valuation slice may not invent these numbers.

FORMULA/LAYOUT RULES:
- Assumptions should be a stable two-column driver sheet: column A label, column B value, with section headers.
- Dependent slices must read upstream ranges first when may_read_from is non-empty, then write formulas against actual addresses.
- In a scaffolded parallel build, may_read_from ranges may exist but be blank when a worker starts. That is okay: write formulas against the declared addresses instead of waiting for another worker.
- Quote sheet names with spaces/punctuation in formulas.
- Use absolute references for drivers (e.g. =Assumptions!$B$12) and relative references only where copyToRange should drag.

INSTRUCTIONS STYLE:
- Be specific enough that a worker can build the slice without asking the user.
- Include target row/column extents, major row groups, formula families, and upstream references.
- Keep each slice instruction under about 900 words. Do not include huge JSON payloads.

OPTIONAL ACTIONS:
- actions[] is only for tiny deterministic source-fidelity tables or tests. Normal workbook content slices should use [].
- If actions are present, use only: bulk_create_sheets, delete_sheet, set_cell_range, bulk_set_cell_ranges, bulk_set_format, bulk_set_notes, create_named_range, bulk_create_named_ranges, copy_range.
- Action params must use canonical keys only and finite A1 ranges.

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
      "tier": "flash",
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
  if (scale && (scale.rowsRequested || scale.rowsPerSheetRequested || scale.periods || scale.units || scale.detailLevel)) {
    lines.push('');
    lines.push(`SCALE TARGETS (parsed from user objective — match this density in the blueprint):`);
    if (scale.rowsPerSheetRequested) lines.push(`- target row density: ~${scale.rowsPerSheetRequested} rows PER MAJOR SHEET, not just across the whole workbook`);
    if (scale.rowsRequested) lines.push(`- target row count: ~${scale.rowsRequested} data rows across the workbook`);
    if (scale.periods) lines.push(`- period schedule: ${scale.periods} ${scale.periodGranularity || 'periods'} (use copyToRange for the time axis)`);
    else if (scale.periodGranularity) lines.push(`- period granularity: ${scale.periodGranularity} (size the schedule to the project horizon)`);
    if (scale.units) lines.push(`- unit-level detail: ${scale.units} unit rows (per floor / apartment / space — one row per unit)`);
    if (scale.detailLevel === 'high') lines.push(`- detail level: HIGH — user explicitly requested granular / row-by-row output`);
    const target = scale.rowsPerSheetRequested || scale.rowsRequested || 0;
    if (target >= 1000) {
      lines.push(`- guidance: build dense schedules. Use copyToRange aggressively. Use enough coherent slices for the workbook scope, but density per major sheet matters more than slice count. Summary-only blueprints will be rejected as "missed the brief".`);
      lines.push(`- validation floor: at least four major operating sheets must reach ~${Math.floor(target * 0.8)}+ rows via finite copyToRange ranges; do not put all row density into one detail sheet.`);
    } else if (target >= 500) {
      lines.push(`- guidance: include 2-3 dense schedules (monthly / per-unit). Plan 8-12 slices. Do NOT collapse the horizon into single-cell totals.`);
    } else if (target >= 200) {
      lines.push(`- guidance: include at least one multi-period schedule built with copyToRange. Plan 6-10 slices.`);
    } else {
      lines.push(`- guidance: free choice on density, but still build period schedules where the objective implies them.`);
    }
  }

  // Auto-load a domain skill when objective hints at a known specialty.
  // Codex-style: surface domain knowledge to the planner BEFORE it commits to
  // a slice graph, so it puts the right sheets / categories in the blueprint.
  const skill = autoLoadDomainSkill(objective);
  if (skill) {
    lines.push('');
    lines.push(`DOMAIN SKILL (auto-loaded — incorporate this taxonomy into slice instructions; downstream workers will see it too):`);
    lines.push('---');
    lines.push(skill.content.slice(0, 8000));
    lines.push('---');
  }

  lines.push('');
  lines.push('Produce the blueprint now.');
  return lines.join('\n');
}

// Heuristic: scan objective for domain keywords, return the matching skill
// file content. Cheap regex match — no LLM call.
function autoLoadDomainSkill(objective) {
  const text = String(objective || '').toLowerCase();
  const matchers = [
    { skill: 'real-estate-dev-italy', re: /(immobiliar|piani|costruzion|promozione immobil|oneri urbanizz|mq2?\b|vairano|caserta|sviluppo immobil|btc\/btl|prezzo\s*\/\s*mq)/i },
    { skill: 'business-plan', re: /(business plan|ristorant|food|menu|location ownership)/i },
    { skill: 'dcf-model', re: /(dcf|valutazione azienda|company valuation|free cash flow)/i },
    { skill: 'lbo-model', re: /(\blbo\b|leverage buyout|sponsor return|moic|debt schedule)/i },
    { skill: 'comps-analysis', re: /(\bcomps\b|comparable compan|trading multiples)/i },
    { skill: 'three-statement', re: /(three statement|3-statement|balance sheet.*income.*cash)/i },
  ];
  for (const { skill, re } of matchers) {
    if (re.test(text)) {
      try {
        const fs = require('fs');
        const path = require('path');
        const file = path.join(__dirname, '..', '..', 'skills', `${skill}.md`);
        if (fs.existsSync(file)) {
          return { skill, content: fs.readFileSync(file, 'utf8') };
        }
      } catch (_) {}
    }
  }
  return null;
}

// Bumped 60s→120s after benchmark: institutional prompts (real estate IT,
// 10-piano, 1000-righe-per-sheet) routinely take 28-32s per attempt; with 2
// retries the original 60s often timed out the WHOLE attempt → fallback to
// single agent_loop, losing parallel slicing entirely.
const ARCHITECT_DEFAULT_TIMEOUT_MS = Math.max(60000, Number(process.env.ARCHITECT_TIMEOUT_MS) || 120000);
const ARCHITECT_MAX_REPAIR_ATTEMPTS = Math.max(1, Number(process.env.ARCHITECT_MAX_REPAIR_ATTEMPTS) || 2);

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
  const validation = validateBlueprint(parsed, {
    workbookSheets: context.workbookSheets || [],
    objective,
    stripDeterministicActions: process.env.ALLOW_DETERMINISTIC_SLICES !== 'true'
  });
  if (!validation.ok) {
    let lastValidation = validation;
    let lastRaw = llmRaw;
    let repaired = false;
    for (let repairAttempt = 1; repairAttempt <= ARCHITECT_MAX_REPAIR_ATTEMPTS; repairAttempt++) {
      const retryable = lastValidation.errors.some(err => /verbatim menu coverage|formula references sheet|unquoted sheet reference|density coverage failed|actions\[\d+\]|copyToRange|unbounded|invalid A1 range|format target|finite A1 range/i.test(err));
      if (!retryable) break;
      const repairUserContent = `${userContent}\n\nVALIDATION FAILED${repairAttempt > 1 ? ` AGAIN (repair attempt ${repairAttempt})` : ''}. Regenerate the full JSON blueprint fixing these errors:\n- ${lastValidation.errors.join('\n- ')}\n\nMake the smallest structural change that fixes the errors; do not add thin filler slices.\nFor menu coverage errors, add a deterministic Menu/Menu Detail slice whose actions write every extracted item and price exactly, then build revenue formulas from that sheet.\nFor density coverage errors, make at least four major operating sheets reach the requested row depth with finite formula copyToRange blocks (for example A6:G1005). Do not satisfy a 1000-rows-per-sheet request with only one dense detail sheet.\nFor action-shape errors, emit only finite single A1 ranges; split disjoint formats into multiple formats instead of comma-separated targets. copyToRange source cells must be formulas, so write static headers/labels in a separate action and copy formulas only.\nFor formula reference errors, use the exact declared sheet names from scope/actions. If the sheet is "Cost Breakdown", formulas must reference ='Cost Breakdown'!A1 or 'Cost Breakdown'!A1, never CostBreakdown!A1.`;
      let repairRaw;
      try {
        repairRaw = await callLLMFn({
          system: ARCHITECT_SYSTEM_PROMPT,
          userText: repairUserContent,
          timeoutMs: ARCHITECT_DEFAULT_TIMEOUT_MS,
          fallbackTimeoutMs: ARCHITECT_DEFAULT_TIMEOUT_MS,
          modelOverride: modelOverride || undefined,
          role: 'architect',
          label: repairAttempt === 1 ? 'Architect blueprint retry' : `Architect blueprint retry ${repairAttempt}`
        });
      } catch (err) {
        throw new Error(`Architect blueprint validation failed and retry ${repairAttempt} failed: ${lastValidation.errors.join('; ')}; retry error: ${err.message}`);
      }
      const repairParsed = extractArchitectJson(repairRaw);
      if (!repairParsed) throw new Error(`Architect blueprint validation failed and retry ${repairAttempt} produced unparseable JSON: ${lastValidation.errors.join('; ')}`);
      lastValidation = validateBlueprint(repairParsed, {
        workbookSheets: context.workbookSheets || [],
        objective,
        stripDeterministicActions: process.env.ALLOW_DETERMINISTIC_SLICES !== 'true'
      });
      lastRaw = repairRaw;
      repaired = true;
      if (lastValidation.ok) {
        lastValidation.blueprint._meta = {
          latencyMs: Date.now() - start,
          model: lastRaw?._model || null,
          repaired,
          repairAttempts: repairAttempt
        };
        return lastValidation.blueprint;
      }
    }
    throw new Error(`Architect blueprint validation failed${repaired ? ' after retry' : ''}: ${lastValidation.errors.join('; ')}`);
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
  let normalizedSlices = [];
  for (const s of raw.slices) {
    const deps = Array.isArray(s.deps) ? s.deps.filter(d => sliceMap.has(d) && d !== s.id) : [];
    const scope = (s.scope && typeof s.scope === 'object') ? s.scope : {};
    const sheetsOwned = Array.isArray(scope.sheets_owned) ? scope.sheets_owned.map(String) : [];
    const rangesOwned = Array.isArray(scope.ranges_owned) ? scope.ranges_owned.map(String) : [];
    const mayReadFrom = Array.isArray(scope.may_read_from) ? scope.may_read_from.map(String) : [];
    const estIters = Number(s.estimated_iters);
    // Default tier flipped to 'flash' (2026-05-31 bench: flash beat pro on
    // Vairano 10-piano IT real-estate prompt — 4 sheet × 1000 rows, ~38K
    // formulas, 15min. Pro fallback path hit architect timeout + JSON parse
    // errors and produced 71 formulas total. Flash + skill IT delivers
    // dense output at ~1/10 the cost per token). 'pro' remains opt-in via
    // explicit slice.tier='pro' in the architect blueprint.
    const tier = s.tier === 'pro' ? 'pro' : 'flash';

    // When ALLOW_DETERMINISTIC is off (default), strip ALL pre-baked actions
    // so each content slice runs through an LLM worker. Even a single
    // bulk_create_sheets action would mark the slice "deterministic complete"
    // and the orchestrator would skip the worker entirely — so the LLM never
    // gets to fill the sheet. Workers create their own sheets via
    // bulk_create_sheets when needed (idempotent if sheet already exists).
    const ALLOW_DETERMINISTIC = context.stripDeterministicActions === false ||
      process.env.ALLOW_DETERMINISTIC_SLICES === 'true';
    const preStripActions = Array.isArray(s.actions) ? s.actions : [];
    const actionsToValidate = ALLOW_DETERMINISTIC ? preStripActions : [];

    const actionValidation = validateSliceActions(s.id, actionsToValidate);
    if (!actionValidation.ok) {
      errors.push(...actionValidation.errors);
      continue;
    }

    const finalActions = actionValidation.actions;

    normalizedSlices.push({
      id: s.id,
      title: String(s.title || s.id),
      deps,
      scope: { sheets_owned: sheetsOwned, ranges_owned: rangesOwned, may_read_from: mayReadFrom },
      instructions: String(s.instructions || '').slice(0, 8000),
      estimated_iters: Number.isFinite(estIters) ? Math.max(3, Math.min(20, Math.round(estIters))) : 10,
      tier,
      actions: finalActions
    });
  }
  if (errors.length) return { ok: false, errors };

  const parallelized = normalizeDenseBlueprintParallelism(normalizedSlices, context);
  normalizedSlices = parallelized.slices;
  const normalizedSliceMap = new Map(normalizedSlices.map(s => [s.id, s]));

  // ── DEPENDENCY INFERENCE FROM may_read_from ─────────────────────────────
  // The architect prompt (and emitted blueprints) routinely set every content
  // slice to depend only on the scaffold, leaving runtime cross-sheet reads
  // racing against the writes that populate the upstream sheet. Observed in
  // the 2026-06-01 Vairano run: Revenue, Construction, Financing, Cash Flow,
  // P&L, Valuation, Sensitivity all parallel after scaffold, all referencing
  // Assumptions which hadn't been written yet → cascade of #VALUE! errors,
  // health-scan injected blocking errors, valuation_returns trapped in
  // done_blocked_by_errors forever.
  //
  // Auto-infer: if slice A's may_read_from points at a sheet (or sub-range)
  // owned by slice B, and B is not already in A.deps, add B to A.deps. Kahn's
  // algorithm below will recompute waves, naturally pushing dependent slices
  // into later waves while preserving parallelism between independent slices.
  //
  // Skip self-references and same-sheet cases where A also owns part of the
  // sheet via ranges_owned (shared-sheet slices use range partitioning, not
  // ordering). Skip the scaffold-like slices as sources of dependency: they
  // create empty sheets, so depending on the scaffold is already covered.
  const sheetOwners = new Map();   // exact sheet name → slice id that fully owns it
  const rangeOwners = new Map();   // exact "Sheet!A1:B9" → slice id
  for (const s of normalizedSlices) {
    if (isScaffoldLikeSlice(s)) continue;
    for (const sh of s.scope.sheets_owned) {
      const sharesByRange = s.scope.ranges_owned.some(r => r.startsWith(sh + '!'));
      if (!sharesByRange && !sheetOwners.has(sh)) sheetOwners.set(sh, s.id);
    }
    for (const r of s.scope.ranges_owned) {
      if (!rangeOwners.has(r)) rangeOwners.set(r, s.id);
    }
  }
  const inferredDepCount = { added: 0, byTarget: new Map() };
  for (const slice of normalizedSlices) {
    if (!Array.isArray(slice.scope.may_read_from) || slice.scope.may_read_from.length === 0) continue;
    const ownDeps = new Set(slice.deps);
    for (const readRef of slice.scope.may_read_from) {
      const trimmed = String(readRef || '').trim();
      if (!trimmed) continue;
      // Pull sheet name. Support "Sheet", "Sheet!A1:B2", "'Sheet Name'!A1".
      const refSheet = trimmed.includes('!')
        ? trimmed.split('!')[0].replace(/^'/, '').replace(/'$/, '')
        : trimmed.replace(/^'/, '').replace(/'$/, '');
      let owner = sheetOwners.get(refSheet) || null;
      if (!owner) {
        // Maybe matches an explicit range-owner entry
        for (const [rng, oid] of rangeOwners.entries()) {
          if (rng === trimmed || rng.startsWith(refSheet + '!')) { owner = oid; break; }
        }
      }
      if (!owner) continue;
      if (owner === slice.id) continue;
      if (ownDeps.has(owner)) continue;
      // If the slice itself owns a range on the same sheet, treat as shared-sheet (skip)
      const slicePartialOnSheet = slice.scope.ranges_owned.some(r => r.startsWith(refSheet + '!'));
      const sliceOwnsSheet = slice.scope.sheets_owned.includes(refSheet);
      if (slicePartialOnSheet || sliceOwnsSheet) continue;
      ownDeps.add(owner);
      inferredDepCount.added++;
      const key = `${slice.id}<-${owner}`;
      inferredDepCount.byTarget.set(key, (inferredDepCount.byTarget.get(key) || 0) + 1);
    }
    slice.deps = [...ownDeps];
  }
  if (inferredDepCount.added > 0) {
    logger.info(`[Architect] inferred ${inferredDepCount.added} dependency edge(s) from may_read_from → sheets_owned overlap. Sample: ${[...inferredDepCount.byTarget.keys()].slice(0, 6).join(', ')}`);
  }

  // Cycle detection via Kahn's algorithm
  const indeg = new Map(normalizedSlices.map(s => [s.id, 0]));
  const adj = new Map(normalizedSlices.map(s => [s.id, []]));
  for (const s of normalizedSlices) {
    for (const d of s.deps) {
      if (!adj.has(d)) continue;
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
    const slice = normalizedSliceMap.get(id);
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

  // Within each wave, sheets/ranges must be disjoint — except scaffold-like
  // slices which create empty sheets and pre-list ranges that content
  // workers will fill. Past failure: the LLM-emitted blueprint put both
  // a `scaffold` slice and `populate_assumptions` slice at wave 1 with
  // overlapping `ranges_owned`, validator rejected, run fell back to the
  // single-agent loop (1 action per iteration → stagnation). Scaffold's
  // ranges_owned is an informational scope, not a write claim, so exclude
  // it from overlap registration.
  for (let w = 0; w < waves.length; w++) {
    const seenSheets = new Map(); // sheet → slice_id
    const seenRanges = new Map(); // range → slice_id
    for (const sid of waves[w]) {
      const slice = normalizedSlices.find(x => x.id === sid);
      if (isScaffoldLikeSlice(slice)) continue;
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
  errors.push(...validateDensityCoverage(normalizedSlices, context));
  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    blueprint: {
      objective_restated: String(raw.objective_restated || '').slice(0, 500),
      global_layout_notes: [
        String(raw.global_layout_notes || '').slice(0, 3600),
        parallelized.addedScaffold
          ? 'Dense parallel execution: a scaffold slice creates all declared tabs first; content slices may reference scaffolded sheets before values are populated.'
          : null
      ].filter(Boolean).join('\n').slice(0, 4000),
      slices: normalizedSlices,
      waves: waves.map(w => [...w])
    }
  };
}

/**
 * Build the system prompt addendum that constrains a worker to its slice scope.
 * The worker is otherwise the regular runAgentLoop with full tools.
 */
function isValuationLikeSlice(slice) {
  const text = `${slice?.id || ''} ${slice?.title || ''} ${slice?.instructions || ''}`.toLowerCase();
  return /(valuation|valutaz|\birr\b|\bnpv\b|\bwacc\b|\bdscr\b|\bmoic\b|payback|cost of equity|costo equity|equity invest|debit[oa] total|capital structure|servizio debito)/i.test(text);
}

function buildSliceWorkerPrompt(slice, blueprint, userObjective = '') {
  const scope = slice.scope;
  const hasUpstream = scope.may_read_from.length > 0;
  const isValuation = isValuationLikeSlice(slice);
  const valuationGate = isValuation
    ? `
- ZERO-DETERMINISTIC POLICY (this is a valuation/returns slice). You MUST locate the following inputs on Assumptions BEFORE writing any IRR/NPV/WACC/DSCR formula:
  • Equity Investito (or "equity", "capitale proprio")
  • Debito Totale (or "debito", "mutuo", "loan")
  • Tasso WACC / Costo capitale (or compute via LTC/LTV + costo equity + costo debito + tax shield — but ALL the inputs must be on Assumptions, no hardcoded numbers)
  • Tasso sconto / discount rate (or WACC reused)
  • Orizzonte / Horizon (anni o mesi)
  If ANY of these inputs is missing from Assumptions, DO NOT fabricate a number (no "5000", no "0.08" hardcoded, no shadow value). Instead:
    1. Write a clearly-labelled placeholder row on YOUR own sheet (e.g. "MANCA: Equity Investito" + value 0) so the model is visibly incomplete.
    2. Write IRR/NPV/etc cells as "=IFERROR(<formula referencing Assumptions!$B$X>, \\"INPUT MANCANTE\\")" so they display the gap, not a fake number.
    3. In your done summary, list the missing keys EXACTLY: "Missing on Assumptions: <key1>, <key2>". The orchestrator will surface these to the user.
  Past failure (2026-06-01 Vairano #2): valuation slice couldn't find Equity/Debito on Assumptions, fabricated 5000/140000 as fallback. Result: WACC = -24M, IRR Equity = -63.7%, DSCR = -190. The numbers looked computed but were nonsense, and the user had no signal that the inputs were missing. NEVER repeat this pattern.`
    : '';
  const userBlock = userObjective && String(userObjective).trim()
    ? `\n\nORIGINAL USER REQUEST (verbatim — this is the SOURCE OF TRUTH for all domain data: exact menu items, names, prices, list entries, numbers explicitly given. Architect's instructions may have summarized; if you would otherwise invent any item/price/name/category that COULD be derived from this text, you MUST use the literal value from here instead):
"""
${String(userObjective).slice(0, 8000)}
"""\n`
    : '';
  // Auto-attach domain skill so worker has the taxonomy without needing
  // read_skill (which would burn an iteration). Codex-style: hand the worker
  // the exact reference material it needs at slice start.
  const skill = autoLoadDomainSkill(userObjective);
  const skillBlock = skill
    ? `\n\nDOMAIN SKILL (${skill.skill} — use this taxonomy verbatim; do NOT substitute generic English labels):\n---\n${skill.content.slice(0, 8000)}\n---\n`
    : '';
  return `<slice-context>${skillBlock}
You are a focused worker building ONE slice of a larger blueprint. Other workers are building other slices in parallel.

SLICE: ${slice.id} — ${slice.title}
${userBlock}
YOUR EXCLUSIVE SCOPE (write here, nowhere else):
- sheets owned: ${scope.sheets_owned.length ? scope.sheets_owned.join(', ') : '(none — use ranges_owned)'}
- ranges owned: ${scope.ranges_owned.length ? scope.ranges_owned.join(', ') : '(full sheets above)'}

READ-ONLY references (completed upstream data or scaffolded parallel sheets you may reference, e.g. via formulas):
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
- ITER BUDGET IS TIGHT (~${20}). Consolidate writes: assumptions/driver tables should be ONE bulk_set_cell_ranges call; a P&L / cash-flow / balance-sheet slice should be ONE bulk_set_cell_ranges call (up to 32 writes per call) for ALL section rows, then ONE bulk_set_format pass for formatting. Sequential per-row set_cell_range calls burn the budget and cascade-kill downstream waves.
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
- Range targets must be finite single A1 ranges. Split disjoint formatting into multiple entries; do not use comma-separated targets like "A3,A8" or whole-column targets like "A:J" for normal formatting.
- DO NOT call done until you have actually written cells in your owned scope. A done with zero writes will be rejected as a failed slice and cascade-kill downstream slices. If you're stuck, write what you can with absolute references and explain in the done summary what is incomplete.
- NO PADDING ROWS. If the workbook target is "~1000 righe per foglio" but you only have meaningful data for N rows (e.g. 10 piani, 36 mesi), write exactly N rows. Do NOT repeat the same literal value (e.g. "Scavi e movimentazione terra" × 600) to "reach the target". A guard server-side will reject any single column that contains the same scalar in ≥20 rows, costing you an iteration. Real data only — use formulas/copyToRange/index arithmetic to produce variation across rows, or stop at the real row count.${valuationGate}
- When this slice is done, call the "done" tool with a one-line summary describing what you wrote. If a valuation slice has missing inputs (above), the summary MUST start with "Missing on Assumptions: ..." so the gap is visible.
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
