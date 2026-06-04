'use strict';

import { parseTargetReference } from './parseTarget.js';
import { ensureWorksheet } from './sheetOps.js';
import { formatActionTarget } from '../utils/html.js';
import { addLog } from '../ui/executionLog.js';
import state from '../store/state.js';

function normalizeBatch(batch) {
  if (Array.isArray(batch)) return { actions: batch, meta: null };
  if (batch && Array.isArray(batch.actions)) {
    return {
      actions: batch.actions,
      meta: batch.meta || null,
      onBatchComplete: batch.onBatchComplete || null
    };
  }
  return null;
}

function enqueueActions(actions, excelActionQueue, showActionsPreview, hideActionsPreview, executeActions, onBatchComplete) {
  const batch = normalizeBatch(actions);
  if (!batch || batch.actions.length === 0) return;
  batch.onBatchComplete = onBatchComplete || batch.onBatchComplete || null;
  excelActionQueue.push(batch);
  scheduleQueueProcessing(excelActionQueue, showActionsPreview, hideActionsPreview, executeActions);
}

let isExecutingQueue = false;
let queueProcessTimer = null;
const queueIdleResolvers = [];

function isExcelQueueIdle(excelActionQueue) {
  if (isExecutingQueue) return false;
  if (queueProcessTimer) return false;
  if (Array.isArray(excelActionQueue) && excelActionQueue.length > 0) return false;
  return true;
}

function resolveQueueIdleIfNeeded(excelActionQueue) {
  if (isExecutingQueue || (excelActionQueue && excelActionQueue.length > 0)) return;
  const resolvers = queueIdleResolvers.splice(0, queueIdleResolvers.length);
  resolvers.forEach(resolve => resolve(true));
}

function waitForActionQueueIdle(excelActionQueue, timeoutMs = 120000) {
  if (!isExecutingQueue && (!excelActionQueue || excelActionQueue.length === 0)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const idx = queueIdleResolvers.indexOf(done);
      if (idx >= 0) queueIdleResolvers.splice(idx, 1);
      resolve(false);
    }, timeoutMs);
    function done(value) {
      clearTimeout(timer);
      resolve(value);
    }
    queueIdleResolvers.push(done);
  });
}

async function reportBatchComplete(onBatchComplete, payload) {
  if (!onBatchComplete) return;
  try {
    await onBatchComplete(payload);
  } catch (err) {
    addLog('Errore salvataggio esito azioni Excel: ' + err.message, 'warn');
  }
}

function scheduleQueueProcessing(excelActionQueue, showActionsPreview, hideActionsPreview, executeActions) {
  if (isExecutingQueue || queueProcessTimer) return;
  queueProcessTimer = setTimeout(() => {
    queueProcessTimer = null;
    processQueue(excelActionQueue, showActionsPreview, hideActionsPreview, executeActions);
  }, QUEUE_DRAIN_WINDOW_MS);
}

async function processQueue(excelActionQueue, showActionsPreview, hideActionsPreview, executeActions) {
  if (isExecutingQueue) return;
  if (queueProcessTimer) {
    clearTimeout(queueProcessTimer);
    queueProcessTimer = null;
  }
  isExecutingQueue = true;
  let chunksProcessed = 0;
  // Inter-chunk yield so Office.js context.sync settles before the next batch.
  // Prevents the "Excel froze / crashed" pattern when parallel slice workers
  // emit actions back-to-back faster than Office.js can apply them.
  const INTER_CHUNK_YIELD_MS = Number(typeof window !== 'undefined' && window.EXCEL_INTER_CHUNK_YIELD_MS) || 80;
  try {
    while (excelActionQueue.length > 0) {
      const group = takeNextQueueGroup(excelActionQueue);
      if (!group || group.actions.length === 0) continue;
      if (chunksProcessed > 0 && INTER_CHUNK_YIELD_MS > 0) {
        await new Promise(r => setTimeout(r, INTER_CHUNK_YIELD_MS));
      }
      chunksProcessed += 1;
      try {
        showActionsPreview(group.actions);
        if (group.batches.length > 1) {
          addLog(`Coda Excel: drenati ${group.batches.length} eventi in un unico batch (${group.actions.length} azioni, ~${group.cellCount} celle, costo ~${Math.round(group.costCount)}).`);
        }
        const result = await executeActions(group.actions);
        const errors = Array.isArray(result?.errors) ? result.errors : [];
        const errorCount = Number(result?.errorCount) || errors.length || 0;
        const executionResult = {
          actionCount: Number(result?.actionCount) || group.actions.length,
          errorCount,
          errors,
          ok: errorCount === 0
        };
        for (const entry of group.batches) {
          await reportBatchComplete(entry.batch.onBatchComplete, buildBatchCompletion(entry, executionResult));
        }
      } catch (err) {
        addLog('Errore azioni Excel: ' + err.message, 'error');
        for (const entry of group.batches) {
          await reportBatchComplete(entry.batch.onBatchComplete, {
            ok: false,
            meta: entry.batch.meta,
            actionCount: entry.batch.actions.length,
            errorCount: entry.batch.actions.length || 1,
            error: err.message,
            errors: []
          });
        }
      } finally {
        try { hideActionsPreview(); } catch (err) {}
      }
    }
  } finally {
    isExecutingQueue = false;
    resolveQueueIdleIfNeeded(excelActionQueue);
  }
}

// ---------- Undo Snapshots ----------

const MUTATION_TYPES = new Set([
  'setCellValue', 'runFormula', 'fillRange', 'writeRange', 'setCellRange',
  'setCellFormat', 'addConditionalFormat', 'setConditionalFormat'
]);
const MAX_SNAPSHOT_TARGETS = 120;
const MAX_SNAPSHOT_CELLS_PER_TARGET = 2000;
const MAX_SNAPSHOT_BATCH_CELLS = 1200;
// Lowered from 12 → 4 so suspendApiCalculation kicks in on most non-trivial
// batches. Without suspend, Excel would re-evaluate dirty formulas between
// each action inside Excel.run, even though we don't need the intermediate
// values — only the final state. Triggers cost ~0 when not needed, so
// erring on the suspend side is cheap.
const HEAVY_BATCH_ACTIONS = 4;
const HEAVY_BATCH_CELLS = 100;
const HEAVY_BATCH_SNAPSHOT_TARGETS = 80;
const MAX_EXCEL_CHUNK_ACTIONS = 32;
const MAX_EXCEL_CHUNK_CELLS = 250;
const MAX_SET_CELL_RANGE_KEYS_PER_CHUNK = 80;
const QUEUE_DRAIN_WINDOW_MS = 20;
const MAX_QUEUE_GROUP_ACTIONS = MAX_EXCEL_CHUNK_ACTIONS;
const MAX_QUEUE_GROUP_CELLS = MAX_EXCEL_CHUNK_CELLS;
const BASE_EXCEL_CHUNK_COST = 220;
const MIN_EXCEL_CHUNK_COST = 90;
const MAX_EXCEL_CHUNK_COST = 340;
const SLOW_CHUNK_MS = 5000;
const FAST_CHUNK_MS = 800;
const UI_YIELD_MS = 16;
const MAX_NATIVE_NOTE_ATTEMPTS_PER_BATCH = 8;
const MAX_DIRECT_FORMAT_CELLS = 12000;
// Above this, autoFill on a single-cell-key formula spec is risky: Office.js
// has been observed to reject the sync with a generic "argument invalid"
// when the destination span × cols is in the thousands. We fall back to a
// matrix-fill (identical formula in every cell) which is predictable. The
// downside is relative references won't auto-adjust per row — the LLM should
// use copyToRange for that pattern instead.
const MAX_AUTOFILL_CELLS_PER_RANGE = Math.max(500, Number(typeof window !== 'undefined' && window.EXCEL_MAX_AUTOFILL_CELLS) || 2000);
const QUEUE_BATCH_KEY = '__excelQueueBatchKey';
let adaptiveChunkCostLimit = BASE_EXCEL_CHUNK_COST;

function isMutationAction(action) {
  return action && MUTATION_TYPES.has(action.type);
}

function colToNumber(col) {
  let n = 0;
  for (const ch of String(col || '').toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return null;
    n = n * 26 + (code - 64);
  }
  return n || null;
}

function numberToCol(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function addrToCell(addr) {
  const m = String(addr || '').replace(/\$/g, '').match(/^([A-Z]+)(\d+)$/i);
  if (!m) return null;
  const col = colToNumber(m[1]);
  const row = Number(m[2]);
  if (!col || !Number.isFinite(row)) return null;
  return { col, row };
}

// Pure logic so test_bulk_write_format can exercise it without Office.js.
// Returns { srcAddr, skipReason } — srcAddr is the A1 (or A1:A1) range to use
// as autoFill source; skipReason set when source isn't anchored at the
// destination top-left (caller should skip autoFill and only write cells).
function pickAutoFillSource(resolvedAddrs, copyToRange) {
  if (!copyToRange || !Array.isArray(resolvedAddrs) || resolvedAddrs.length === 0) {
    return { srcAddr: null, skipReason: 'no-input' };
  }
  const destAddr = String(copyToRange).includes('!')
    ? String(copyToRange).split('!').slice(1).join('!')
    : String(copyToRange);
  const destBounds = boundsFromA1(destAddr);
  let sourceAddrs;
  if (destBounds) {
    const inside = resolvedAddrs
      .map(a => ({ addr: a, cell: addrToCell(a) }))
      .filter(x => x.cell &&
        x.cell.col >= destBounds.c1 && x.cell.col <= destBounds.c2 &&
        x.cell.row >= destBounds.r1 && x.cell.row <= destBounds.r2);
    sourceAddrs = inside.map(x => x.addr);
    if (sourceAddrs.length === 0) {
      return { srcAddr: `${numberToCol(destBounds.c1)}${destBounds.r1}`, skipReason: null };
    }
  } else {
    sourceAddrs = resolvedAddrs.slice();
  }
  if (sourceAddrs.length === 1) {
    return { srcAddr: sourceAddrs[0], skipReason: null };
  }
  let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
  for (const a of sourceAddrs) {
    const c = addrToCell(a);
    if (!c) continue;
    if (c.col < minCol) minCol = c.col;
    if (c.col > maxCol) maxCol = c.col;
    if (c.row < minRow) minRow = c.row;
    if (c.row > maxRow) maxRow = c.row;
  }
  if (destBounds && (minCol !== destBounds.c1 || minRow !== destBounds.r1)) {
    return { srcAddr: null, skipReason: `seed not anchored at ${numberToCol(destBounds.c1)}${destBounds.r1}` };
  }
  return {
    srcAddr: `${numberToCol(minCol)}${minRow}:${numberToCol(maxCol)}${maxRow}`,
    skipReason: null
  };
}

function boundsFromA1(target) {
  const raw = String(target || '').replace(/\$/g, '');
  const withoutSheet = raw.includes('!') ? raw.split('!').pop() : raw;
  if (!withoutSheet) return null;
  const match = withoutSheet.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
  if (!match) return null;
  const c1 = colToNumber(match[1]);
  const r1 = Number(match[2]);
  const c2 = match[3] ? colToNumber(match[3]) : c1;
  const r2 = match[4] ? Number(match[4]) : r1;
  if (!c1 || !c2 || !Number.isFinite(r1) || !Number.isFinite(r2)) return null;
  return {
    c1: Math.min(c1, c2),
    c2: Math.max(c1, c2),
    r1: Math.min(r1, r2),
    r2: Math.max(r1, r2)
  };
}

// Office.js requires numberFormat (and values/formulas) to be a 2D array whose
// dimensions match the target range exactly — a 1x1 [[fmt]] on a multi-cell range
// throws InvalidArgument. These helpers size the matrix to the range.
const MAX_NUMBERFORMAT_CELLS = 50000;

function buildMatrix(rows, cols, value) {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => value));
}

// Reshape any value (scalar / 1D / 2D) into a 2D matrix matching {rows,cols},
// filling row-major and padding with '' — so Office.js never rejects a dimension
// mismatch when the LLM uses a range key (e.g. "A5:A104") with the wrong shape.
function reshapeTo(dims, value) {
  const flat = [];
  (function pushFlat(a) { for (const x of a) Array.isArray(x) ? pushFlat(x) : flat.push(x); })(Array.isArray(value) ? value : [value]);
  const out = [];
  let i = 0;
  for (let r = 0; r < dims.rows; r++) {
    const row = [];
    for (let c = 0; c < dims.cols; c++) row.push(i < flat.length ? flat[i++] : '');
    out.push(row);
  }
  return out;
}

function isUnboundedA1(target) {
  const raw = String(target || '').replace(/\$/g, '');
  const withoutSheet = raw.includes('!') ? raw.split('!').pop() : raw;
  return /^[A-Z]+:[A-Z]+$/i.test(withoutSheet) || /^\d+:\d+$/.test(withoutSheet);
}

// Returns {rows, cols} for a bounded A1 range, or null when the size cannot be
// derived from the address alone (named range, or unbounded like "A:A").
function dimsFromA1(target) {
  const raw = String(target || '').replace(/\$/g, '');
  const withoutSheet = raw.includes('!') ? raw.split('!').pop() : raw;
  if (!withoutSheet || isUnboundedA1(withoutSheet)) return null;
  const match = withoutSheet.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
  if (!match) return null;
  const c1 = colToNumber(match[1]);
  const r1 = Number(match[2]);
  const c2 = match[3] ? colToNumber(match[3]) : c1;
  const r2 = match[4] ? Number(match[4]) : r1;
  if (!c1 || !c2 || !Number.isFinite(r1) || !Number.isFinite(r2)) return null;
  return { rows: Math.abs(r2 - r1) + 1, cols: Math.abs(c2 - c1) + 1 };
}

function estimateTargetCells(target) {
  const raw = String(target || '').replace(/\$/g, '');
  const withoutSheet = raw.includes('!') ? raw.split('!').pop() : raw;
  if (!withoutSheet) return 1;
  if (/^[A-Z]+:[A-Z]+$/i.test(withoutSheet) || /^\d+:\d+$/.test(withoutSheet)) return Infinity;
  const match = withoutSheet.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
  if (!match) return 1;
  const c1 = colToNumber(match[1]);
  const r1 = Number(match[2]);
  const c2 = match[3] ? colToNumber(match[3]) : c1;
  const r2 = match[4] ? Number(match[4]) : r1;
  if (!c1 || !c2 || !Number.isFinite(r1) || !Number.isFinite(r2)) return 1;
  return (Math.abs(r2 - r1) + 1) * (Math.abs(c2 - c1) + 1);
}

function estimateActionCells(action) {
  if (!action) return 1;
  if (action.type === 'setCellRange' && action.cells) {
    let total = 0;
    for (const addr of Object.keys(action.cells)) {
      const parsed = parseTargetReference(addr);
      const n = estimateTargetCells(parsed.rangeAddress || addr);
      if (!Number.isFinite(n)) return Infinity;
      total += n;
    }
    if (action.copyToRange) {
      const parsedCopy = parseTargetReference(action.copyToRange);
      const copyCells = estimateTargetCells(parsedCopy.rangeAddress || action.copyToRange);
      if (!Number.isFinite(copyCells)) return Infinity;
      total += copyCells;
    }
    return Math.max(1, total);
  }
  if (action.type === 'setNotes' && Array.isArray(action.notes)) {
    return Math.max(1, action.notes.length);
  }
  const matrix = Array.isArray(action.formulas) ? action.formulas : action.values;
  if (Array.isArray(matrix)) {
    const rows = matrix.length;
    const cols = Array.isArray(matrix[0]) ? matrix[0].length : 1;
    return Math.max(1, rows * cols);
  }
  return estimateTargetCells(action.target);
}

function estimateBatchCells(actions = []) {
  return actions.reduce((sum, action) => {
    const n = estimateActionCells(action);
    if (!Number.isFinite(n)) return Infinity;
    return sum + n;
  }, 0);
}

// Human-friendly count for log lines. Avoids the "~Infinity celle" garble seen
// in the 2026-06-01 Vairano run when an action targeted a whole column/row
// (e.g. "A:A"), which is unbounded by nature. We still keep the numeric
// estimate available for limit comparisons; this just keeps the log readable.
function formatCellCount(n) {
  if (!Number.isFinite(n)) return 'range illimitato (intera colonna/riga)';
  return String(n);
}

const FORMULA_ERROR_RE = /^#(?:REF!|VALUE!|NAME\?|DIV\/0!|NUM!|N\/A|NULL!)$/i;
const MAX_FORMULA_VERIFY_TARGETS = 180;
const MAX_FORMULA_VERIFY_CELLS = 3000;

function isFormulaString(value) {
  return typeof value === 'string' && value.trim().startsWith('=');
}

function cellSpecHasFormula(spec) {
  if (!spec || typeof spec !== 'object') return false;
  if (spec.formula != null) return true;
  return isFormulaString(spec.value);
}

function pushFormulaCheckTarget(out, action, sheet, target) {
  if (!target) return;
  const parsed = parseTargetReference(target);
  const resolvedSheet = parsed.sheetName || sheet || action.sheet || action.sheetName || null;
  const resolvedTarget = parsed.rangeAddress || target;
  const cells = estimateTargetCells(resolvedTarget);
  if (!Number.isFinite(cells) || cells > MAX_FORMULA_VERIFY_CELLS) {
    addLog(`Verifica formule saltata su ${resolvedSheet || 'foglio attivo'}!${resolvedTarget}: range troppo grande.`, 'warn');
    return;
  }
  out.push({
    sheet: resolvedSheet,
    target: resolvedTarget,
    actionType: action.type,
    queueBatchKey: action[QUEUE_BATCH_KEY] || null
  });
}

function collectFormulaCheckTargets(action, out) {
  if (!action || typeof action !== 'object') return;
  const parsedTarget = parseTargetReference(action.target);
  const actionSheet = action.sheet || action.sheetName || parsedTarget.sheetName || null;
  const actionTarget = parsedTarget.rangeAddress || action.target;

  switch (action.type) {
    case 'setCellValue':
    case 'fillRange':
      if (isFormulaString(action.value)) pushFormulaCheckTarget(out, action, actionSheet, actionTarget);
      break;
    case 'runFormula':
      pushFormulaCheckTarget(out, action, actionSheet, actionTarget);
      break;
    case 'writeRange':
      if (Array.isArray(action.formulas) || isFormulaString(action.value)) {
        pushFormulaCheckTarget(out, action, actionSheet, actionTarget);
      }
      break;
    case 'setCellRange': {
      const cells = action.cells || {};
      const entries = Object.entries(cells);
      for (const [addr, spec] of entries) {
        if (cellSpecHasFormula(spec)) pushFormulaCheckTarget(out, action, actionSheet, addr);
      }
      if (action.copyToRange && entries.length > 0 && cellSpecHasFormula(entries[0][1])) {
        const firstParsed = parseTargetReference(entries[0][0]);
        pushFormulaCheckTarget(out, action, firstParsed.sheetName || actionSheet, action.copyToRange);
      }
      break;
    }
    case 'copyRange':
      if (action.to || action.target) {
        pushFormulaCheckTarget(out, action, action.toSheet || action.fromSheet || action.sheet || null, action.to || action.target);
      }
      break;
    default:
      break;
  }
}

function dedupeFormulaCheckTargets(targets = []) {
  const seen = new Set();
  const out = [];
  for (const t of targets) {
    const key = `${t.sheet || '__active__'}!${t.target}|${t.queueBatchKey || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_FORMULA_VERIFY_TARGETS) {
      addLog(`Verifica formule limitata ai primi ${MAX_FORMULA_VERIFY_TARGETS} range per proteggere Excel.`, 'warn');
      break;
    }
  }
  return out;
}

function valueLooksLikeFormulaError(value) {
  return typeof value === 'string' && FORMULA_ERROR_RE.test(value.trim());
}

function formulaLooksBroken(formula) {
  return typeof formula === 'string' && /#(?:REF!|VALUE!|NAME\?|DIV\/0!|NUM!|N\/A|NULL!)/i.test(formula);
}

async function inspectWrittenFormulaErrors(context, sheetCache, defaultSheet, targets = []) {
  const checks = dedupeFormulaCheckTargets(targets);
  if (checks.length === 0) return [];
  const rangeLoads = [];

  // Previously this called `calculate(Excel.CalculationType.full)` which
  // forces a FULL workbook recalc — every single cell, regardless of dirty
  // state. On a workbook with cross-sheet schedules (e.g. RevenueSchedule
  // → PerFloorDetail → P&L) this recalc costs seconds, and because it ran
  // ONCE PER CHUNK, the adaptive chunker would shrink chunks on slow
  // timings, producing MORE chunks and MORE full-recalcs in a vicious
  // cycle (observed: 21s/chunk for 118 cells = ~5 cells/sec). Excel
  // recalcs dirty cells naturally on the post-write sync — the explicit
  // full recalc was redundant. Removing it cuts per-batch latency by
  // roughly 80% on dense schedules.
  // If you ever need to force a recalc here (e.g. for volatile refs that
  // didn't propagate), use `Excel.CalculationType.recalculate` — scoped
  // to dirty cells only — never `.full`.

  for (const check of checks) {
    try {
      const sheet = check.sheet
        ? await ensureWorksheet(context, sheetCache, check.sheet, { createIfMissing: false })
        : defaultSheet;
      const range = sheet.getRange(check.target);
      range.load('values,formulas,address,rowCount,columnCount');
      rangeLoads.push({ ...check, range, sheetName: check.sheet || null });
    } catch (err) {
      rangeLoads.push({
        ...check,
        sheetName: check.sheet || null,
        loadError: err && err.message ? err.message : String(err)
      });
    }
  }

  await context.sync();

  const errors = [];
  for (const item of rangeLoads) {
    if (item.loadError) {
      errors.push({
        type: 'formulaError',
        sheet: item.sheetName,
        target: item.target,
        message: `Formula verification could not read target: ${item.loadError}`,
        queueBatchKey: item.queueBatchKey || null
      });
      continue;
    }
    const values = Array.isArray(item.range.values) ? item.range.values : [];
    const formulas = Array.isArray(item.range.formulas) ? item.range.formulas : [];
    for (let r = 0; r < Math.max(values.length, formulas.length); r++) {
      const valueRow = values[r] || [];
      const formulaRow = formulas[r] || [];
      for (let c = 0; c < Math.max(valueRow.length, formulaRow.length); c++) {
        const value = valueRow[c];
        const formula = formulaRow[c];
        const hasFormula = isFormulaString(formula);
        if (!hasFormula && !formulaLooksBroken(formula)) continue;
        if (!valueLooksLikeFormulaError(value) && !formulaLooksBroken(formula)) continue;
        const errorValue = valueLooksLikeFormulaError(value) ? String(value).trim() : 'formula error';
        errors.push({
          type: 'formulaError',
          sheet: item.sheetName,
          target: `${item.target}${values.length > 1 || valueRow.length > 1 ? ` [r${r + 1}c${c + 1}]` : ''}`,
          message: `Excel evaluated written formula to ${errorValue}`,
          formula: typeof formula === 'string' ? formula.slice(0, 300) : null,
          value: value == null ? null : String(value).slice(0, 80),
          queueBatchKey: item.queueBatchKey || null
        });
      }
    }
  }
  return errors.slice(0, 50);
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function countSetCellRangeDecorations(action) {
  let styleFields = 0;
  let notes = 0;
  const cells = action?.cells || {};
  for (const spec of Object.values(cells)) {
    if (!spec || typeof spec !== 'object') continue;
    if (spec.note != null && spec.note !== '') notes++;
    if (spec.cellStyles && typeof spec.cellStyles === 'object') {
      styleFields += Math.max(1, Object.keys(spec.cellStyles).length);
    }
    if (spec.borderStyles && typeof spec.borderStyles === 'object') {
      styleFields += Math.max(1, Object.keys(spec.borderStyles).length * 2);
    }
  }
  return { styleFields, notes };
}

function estimateActionCost(action) {
  if (!action) return 1;
  const cells = estimateActionCells(action);
  if (!Number.isFinite(cells)) return Infinity;

  switch (action.type) {
    case 'setCellRange': {
      const keys = action.cells ? Object.keys(action.cells).length : 1;
      const { styleFields, notes } = countSetCellRangeDecorations(action);
      const copyCost = action.copyToRange ? Math.max(8, cells * 0.25) : 0;
      return Math.max(1, cells + keys * 0.75 + styleFields * 2 + notes * 6 + copyCost);
    }
    case 'setCellFormat': {
      const fields = action.options && typeof action.options === 'object'
        ? Object.keys(action.options).length
        : 1;
      return Math.max(8, cells * 1.4 + fields * 4);
    }
    case 'addConditionalFormat':
    case 'setConditionalFormat':
      return Math.max(12, cells * 2);
    case 'setNotes':
      return Math.max(8, (Array.isArray(action.notes) ? action.notes.length : 1) * 10);
    case 'createChart':
      return 90;
    case 'copyRange':
      return Math.max(40, cells * 1.2);
    case 'duplicateSheet':
      return 120;
    case 'createSheet':
    case 'deleteSheet':
    case 'renameSheet':
      return 45;
    case 'runJavaScript':
      return 160;
    case 'createNamedRange':
      return 4;
    default:
      return Math.max(1, cells);
  }
}

function estimateBatchCost(actions = []) {
  return actions.reduce((sum, action) => {
    const n = estimateActionCost(action);
    if (!Number.isFinite(n)) return Infinity;
    return sum + n;
  }, 0);
}

function currentChunkCostLimit() {
  return adaptiveChunkCostLimit;
}

function recordChunkTiming(durationMs, actions = []) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  const previous = adaptiveChunkCostLimit;
  const cost = estimateBatchCost(actions);
  if (durationMs > SLOW_CHUNK_MS) {
    adaptiveChunkCostLimit = Math.floor(clampNumber(previous * 0.75, MIN_EXCEL_CHUNK_COST, MAX_EXCEL_CHUNK_COST));
  } else if (durationMs < FAST_CHUNK_MS && Number.isFinite(cost) && cost >= previous * 0.75) {
    adaptiveChunkCostLimit = Math.ceil(clampNumber(previous * 1.08, MIN_EXCEL_CHUNK_COST, MAX_EXCEL_CHUNK_COST));
  }

  if (durationMs > SLOW_CHUNK_MS) {
    addLog(
      `Chunk lento: ${Math.round(durationMs / 1000)}s, ${actions.length} azioni, ~${formatCellCount(estimateBatchCells(actions))} celle → adatto finestra a ~${adaptiveChunkCostLimit}.`,
      'warn'
    );
  }
}

function yieldToHost(delayMs = 0) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

// Adaptive inter-chunk yield. Previously returned 0 for fast chunks, which let
// Excel.run runs stack back-to-back with no UI breathing room — Office.js
// crashed under heavy parallel-worker payloads. Always give at least UI_YIELD_MS
// so the host can repaint and Office.js queues drain; scale with cells and run
// duration to throttle big batches.
function yieldDelayForChunk(durationMs, cellCount = 0) {
  const baseRaw = (typeof window !== 'undefined' && Number(window.EXCEL_INTER_RUN_BASE_MS));
  const base = Number.isFinite(baseRaw) && baseRaw >= 0 ? baseRaw : UI_YIELD_MS;
  let ms = base;
  if (cellCount > 150) ms += 40;
  if (durationMs > 1500) ms += 80;
  if (durationMs > SLOW_CHUNK_MS) ms += 200;
  const capRaw = (typeof window !== 'undefined' && Number(window.EXCEL_INTER_RUN_MAX_MS));
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : 320;
  return Math.min(ms, cap);
}

// ---------- Cells-per-second token bucket ----------
// Smooths the burstiness reported by the Vairano bench (peaks of 24 actions /
// ~5k+ cells in <1s) into a sustainable rate. Per-second refill keeps long
// runs honest; the wider capacity preserves short bursts so small batches still
// feel snappy. Mega writeRange actions (>BYPASS_CELLS) bypass the bucket — they
// can't be split, and forcing them to wait only delays without protecting.
const RATE_CAPACITY_CELLS_DEFAULT = 5000;
const RATE_REFILL_PER_SEC_DEFAULT = 3000;
const RATE_BYPASS_CELLS_DEFAULT = 1250;
const rateBucket = { tokens: RATE_CAPACITY_CELLS_DEFAULT, lastRefill: Date.now() };

function rateConfig() {
  const w = typeof window !== 'undefined' ? window : {};
  const cap = Number(w.EXCEL_RATE_CAPACITY_CELLS);
  const refill = Number(w.EXCEL_RATE_REFILL_PER_SEC);
  const bypass = Number(w.EXCEL_RATE_BYPASS_CELLS);
  return {
    capacity: Number.isFinite(cap) && cap > 0 ? cap : RATE_CAPACITY_CELLS_DEFAULT,
    refill: Number.isFinite(refill) && refill > 0 ? refill : RATE_REFILL_PER_SEC_DEFAULT,
    bypass: Number.isFinite(bypass) && bypass > 0 ? bypass : RATE_BYPASS_CELLS_DEFAULT
  };
}

async function acquireRateBudget(cells) {
  const cfg = rateConfig();
  if (!Number.isFinite(cells) || cells <= 0) return 0;
  if (cells > cfg.bypass) return 0; // atomic mega-writes bypass the bucket
  const now = Date.now();
  const elapsedSec = Math.max(0, (now - rateBucket.lastRefill) / 1000);
  rateBucket.tokens = Math.min(cfg.capacity, rateBucket.tokens + elapsedSec * cfg.refill);
  rateBucket.lastRefill = now;
  if (rateBucket.tokens >= cells) {
    rateBucket.tokens -= cells;
    return 0;
  }
  const deficit = cells - rateBucket.tokens;
  const waitMs = Math.ceil((deficit / cfg.refill) * 1000);
  await yieldToHost(waitMs);
  rateBucket.tokens = 0;
  rateBucket.lastRefill = Date.now();
  return waitMs;
}

// ---------- Rolling queue telemetry (60s window) ----------
const QUEUE_STATS_WINDOW_MS = 60_000;
const queueStats = {
  runs: [],    // { ts, actionCount, cellCount, runMs, waitedMs }
  totals: { runs: 0, actions: 0, cells: 0, runMs: 0, waitedMs: 0 }
};

function recordRunStat(entry) {
  queueStats.runs.push(entry);
  queueStats.totals.runs += 1;
  queueStats.totals.actions += entry.actionCount || 0;
  queueStats.totals.cells += entry.cellCount || 0;
  queueStats.totals.runMs += entry.runMs || 0;
  queueStats.totals.waitedMs += entry.waitedMs || 0;
  const cutoff = Date.now() - QUEUE_STATS_WINDOW_MS;
  while (queueStats.runs.length > 0 && queueStats.runs[0].ts < cutoff) {
    queueStats.runs.shift();
  }
}

if (typeof window !== 'undefined') {
  window.__excelQueueStats = queueStats;
}

// Subscribers (e.g. healthScan) that want to know when a batch finished so
// they can throttle their own Excel.run calls. Kept as a simple array of
// callbacks to avoid a hard import dependency on a specific scanner module.
const onBatchFinishedSubscribers = [];
function subscribeBatchFinished(fn) {
  if (typeof fn === 'function') onBatchFinishedSubscribers.push(fn);
}
function notifyBatchFinished() {
  for (const fn of onBatchFinishedSubscribers) {
    try { fn(); } catch (_) {}
  }
}

function queueBatchKey(batch, index) {
  const meta = batch?.meta || {};
  const base = meta.itemId || meta.taskId || `batch-${Date.now()}`;
  return `${base}:${index}`;
}

function tagQueuedAction(action, key) {
  if (!action || typeof action !== 'object') return action;
  return { ...action, [QUEUE_BATCH_KEY]: key };
}

function canMergeQueuedBatches(first, next, currentActions, currentCells, currentCost) {
  if (!first || !next || !Array.isArray(next.actions) || next.actions.length === 0) return false;
  if (first.meta?.isUndo || next.meta?.isUndo) return false;
  if (first.onBatchComplete || next.onBatchComplete) {
    if (first.onBatchComplete !== next.onBatchComplete) return false;
    if ((first.meta?.turnId || null) !== (next.meta?.turnId || null)) return false;
  }

  const nextCells = estimateBatchCells(next.actions);
  const nextCost = estimateBatchCost(next.actions);
  if (!Number.isFinite(currentCells) || !Number.isFinite(nextCells) ||
      !Number.isFinite(currentCost) || !Number.isFinite(nextCost)) return false;
  if (currentActions + next.actions.length > MAX_QUEUE_GROUP_ACTIONS) return false;
  if (currentCells + nextCells > MAX_QUEUE_GROUP_CELLS) return false;
  return currentCost + nextCost <= currentChunkCostLimit();
}

function takeNextQueueGroup(excelActionQueue) {
  const first = normalizeBatch(excelActionQueue.shift());
  if (!first || first.actions.length === 0) return null;

  const batches = [];
  const actions = [];
  let actionCount = 0;
  let cellCount = estimateBatchCells(first.actions);
  let costCount = estimateBatchCost(first.actions);

  function append(batch) {
    const key = queueBatchKey(batch, batches.length);
    const entry = { batch, key };
    batches.push(entry);
    for (const action of batch.actions) actions.push(tagQueuedAction(action, key));
    actionCount += batch.actions.length;
  }

  append(first);
  while (excelActionQueue.length > 0) {
    const next = normalizeBatch(excelActionQueue[0]);
    if (!canMergeQueuedBatches(first, next, actionCount, cellCount, costCount)) break;
    excelActionQueue.shift();
    append(next);
    cellCount += estimateBatchCells(next.actions);
    costCount += estimateBatchCost(next.actions);
  }

  return { batches, actions, cellCount, costCount };
}

function buildBatchCompletion(entry, executionResult) {
  const errors = Array.isArray(executionResult.errors) ? executionResult.errors : [];
  const unknownErrors = errors.filter(error => !error?.queueBatchKey);
  const batchErrors = errors.filter(error => error?.queueBatchKey === entry.key);
  const scopedErrors = unknownErrors.length > 0 ? [...unknownErrors, ...batchErrors] : batchErrors;
  const fallbackErrorCount = executionResult.errorCount > 0 && errors.length === 0 ? executionResult.errorCount : 0;
  const errorCount = scopedErrors.length || fallbackErrorCount;
  return {
    ok: errorCount === 0,
    meta: entry.batch.meta,
    actionCount: entry.batch.actions.length,
    errorCount,
    errors: scopedErrors
  };
}

function splitSetCellRangeAction(action) {
  if (!action || action.type !== 'setCellRange' || !action.cells || typeof action.cells !== 'object') {
    return [action];
  }

  const entries = Object.entries(action.cells);
  if (entries.length === 0) {
    return [action];
  }
  if (action.copyToRange) {
    return [action];
  }

  const chunks = [];
  let current = [];
  let currentCells = 0;
  let currentCost = 0;

  function flush() {
    if (current.length === 0) return;
    const idx = chunks.length + 1;
    const cells = Object.fromEntries(current);
    chunks.push({
      ...action,
      cells,
      explanation: action.explanation
        ? `${action.explanation} (${idx})`
        : undefined
    });
    current = [];
    currentCells = 0;
    currentCost = 0;
  }

  for (const entry of entries) {
    const [addr, spec] = entry;
    const singleAction = { ...action, cells: { [addr]: spec } };
    const entryCells = estimateActionCells(singleAction);
    const entryCost = estimateActionCost(singleAction);
    const finiteCells = Number.isFinite(entryCells) ? entryCells : MAX_EXCEL_CHUNK_CELLS;
    const finiteCost = Number.isFinite(entryCost) ? entryCost : currentChunkCostLimit();
    const wouldOverflowKeys = current.length >= MAX_SET_CELL_RANGE_KEYS_PER_CHUNK;
    const wouldOverflowCells = current.length > 0 && currentCells + finiteCells > MAX_EXCEL_CHUNK_CELLS;
    const wouldOverflowCost = current.length > 0 && currentCost + finiteCost > currentChunkCostLimit();

    if (wouldOverflowKeys || wouldOverflowCells || wouldOverflowCost) flush();
    current.push(entry);
    currentCells += finiteCells;
    currentCost += finiteCost;

    if (!Number.isFinite(entryCells) ||
        finiteCells >= MAX_EXCEL_CHUNK_CELLS ||
        finiteCost >= currentChunkCostLimit()) {
      flush();
    }
  }
  flush();
  return chunks;
}

function splitActionsIntoSafeChunks(actions = []) {
  const expanded = [];
  for (const action of actions) {
    expanded.push(...splitSetCellRangeAction(action));
  }

  const chunks = [];
  let current = [];
  let currentCells = 0;
  let currentCost = 0;

  function flush() {
    if (current.length > 0) chunks.push(current);
    current = [];
    currentCells = 0;
    currentCost = 0;
  }

  for (const action of expanded) {
    const actionCells = estimateActionCells(action);
    const actionCost = estimateActionCost(action);
    const finiteCells = Number.isFinite(actionCells) ? actionCells : MAX_EXCEL_CHUNK_CELLS;
    const finiteCost = Number.isFinite(actionCost) ? actionCost : currentChunkCostLimit();
    const wouldOverflowActions = current.length >= MAX_EXCEL_CHUNK_ACTIONS;
    const wouldOverflowCells = current.length > 0 && currentCells + finiteCells > MAX_EXCEL_CHUNK_CELLS;
    const wouldOverflowCost = current.length > 0 && currentCost + finiteCost > currentChunkCostLimit();

    if (wouldOverflowActions || wouldOverflowCells || wouldOverflowCost) flush();
    current.push(action);
    currentCells += finiteCells;
    currentCost += finiteCost;

    if (!Number.isFinite(actionCells) ||
        !Number.isFinite(actionCost) ||
        finiteCells >= MAX_EXCEL_CHUNK_CELLS ||
        finiteCost >= currentChunkCostLimit()) {
      flush();
    }
  }

  flush();
  return chunks.length > 0 ? chunks : [actions];
}

function shouldSkipSnapshotTarget(action, target) {
  const estimated = action?.type === 'setCellRange' ? 1 : estimateActionCells({ ...action, target });
  return estimated > MAX_SNAPSHOT_CELLS_PER_TARGET;
}

function isRunJavaScriptEnabled() {
  if (typeof window === 'undefined') return false;
  if (window.EXCEL_AI_ALLOW_RUN_JAVASCRIPT === false) return false;
  try {
    return window.localStorage?.getItem('excelAi.allowRunJavaScript') !== 'false';
  } catch (err) {
    return true;
  }
}

function extractSnapshotTargets(actions) {
  const targets = []; // { sheet, target, actionType }
  let skipped = 0;
  for (const action of actions) {
    if (!isMutationAction(action)) continue;
    const parsedTarget = parseTargetReference(action.target);
    const sheet = action.sheet || action.sheetName || parsedTarget.sheetName;
    const target = parsedTarget.rangeAddress || action.target;

    if (action.type === 'setCellRange' && action.cells) {
      for (const addr of Object.keys(action.cells)) {
        const parsedAddr = parseTargetReference(addr);
        const cellSheet = parsedAddr.sheetName || sheet;
        const cellTarget = parsedAddr.rangeAddress || addr;
        targets.push({ sheet: cellSheet, target: cellTarget, actionType: action.type });
      }
      continue;
    }
    if (action.type === 'setCellFormat' && action.options) {
      if (shouldSkipSnapshotTarget(action, target)) {
        skipped++;
        continue;
      }
      targets.push({ sheet, target, actionType: action.type, isFormat: true });
      continue;
    }
    if (target) {
      if (shouldSkipSnapshotTarget(action, target)) {
        skipped++;
        continue;
      }
      targets.push({ sheet, target, actionType: action.type });
    }
  }
  return { targets, skipped };
}

async function captureSnapshot(context, targets) {
  const snapshot = { timestamp: Date.now(), entries: [] };
  if (targets.length === 0) return snapshot;

  // Group by sheet for efficient reading
  const bySheet = new Map();
  for (const t of targets) {
    const key = t.sheet || '__default__';
    if (!bySheet.has(key)) bySheet.set(key, []);
    bySheet.get(key).push(t);
  }

  for (const [sheetName, sheetTargets] of bySheet) {
    const worksheet = sheetName === '__default__'
      ? context.workbook.worksheets.getActiveWorksheet()
      : context.workbook.worksheets.getItemOrNullObject(sheetName);
    if (sheetName !== '__default__') worksheet.load('name');

    const ranges = [];
    for (const t of sheetTargets) {
      const range = worksheet.getRange(t.target);
      let props = null;
      if (t.isFormat) {
        props = range.getCellProperties({
          format: { font: { color: true, bold: true }, fill: { color: true } },
          numberFormat: true
        });
      } else {
        range.load('values,formulas');
      }
      ranges.push({ target: t.target, range, isFormat: t.isFormat, props });
    }
    await context.sync();

    for (const r of ranges) {
      const formatCell = r.isFormat
        ? (((r.props && r.props.value) || [])[0] || [])[0] || {}
        : null;
      const formatInfo = formatCell?.format || {};
      snapshot.entries.push({
        sheet: sheetName === '__default__' ? null : sheetName,
        target: r.target,
        previousValues: r.isFormat ? null : r.range.values,
        previousFormulas: r.isFormat ? null : r.range.formulas,
        previousFormat: r.isFormat ? {
          fillColor: formatInfo.fill?.color || null,
          fontColor: formatInfo.font?.color || null,
          bold: formatInfo.font?.bold,
          numberFormat: formatCell.numberFormat || null
        } : null
      });
    }
  }
  return snapshot;
}

export async function undoLastSnapshot() {
  if (!state.undoStack || state.undoStack.length === 0) {
    addLog('Nessuna azione da annullare', 'warn');
    return false;
  }
  const snapshot = state.undoStack.pop();
  addLog(`Undo: ripristino ${snapshot.entries.length} celle`);

  return Excel.run(async (context) => {
    for (const entry of snapshot.entries) {
      const worksheet = entry.sheet
        ? context.workbook.worksheets.getItem(entry.sheet)
        : context.workbook.worksheets.getActiveWorksheet();
      const range = worksheet.getRange(entry.target);

      // Restore formulas/values when the snapshot captured cell contents.
      if (Array.isArray(entry.previousFormulas) && entry.previousFormulas.some(row => row.some(f => f && f.startsWith('=')))) {
        range.formulas = entry.previousFormulas;
      } else if (Array.isArray(entry.previousValues)) {
        range.values = entry.previousValues;
      }

      // Restore format if captured
      if (entry.previousFormat) {
        const fmt = entry.previousFormat;
        if (fmt.fillColor) range.format.fill.color = fmt.fillColor;
        if (fmt.fontColor) range.format.font.color = fmt.fontColor;
        if (fmt.bold !== undefined) range.format.font.bold = fmt.bold;
        if (fmt.numberFormat) range.numberFormat = fmt.numberFormat;
      }
    }
    await context.sync();
    addLog('Undo completato');
    return true;
  });
}

async function resolveSheetAndTarget(context, sheetCache, defaultSheet, action) {
  const parsedTarget = parseTargetReference(action.target);
  const explicitSheet = action.sheet || action.sheetName || parsedTarget.sheetName;
  if (!explicitSheet) {
    addLog(`Azione ${action.type} senza sheet → uso foglio attivo. Se atteso altro foglio, l'agent ha omesso il param sheet.`, 'warn');
  }
  const sheet = explicitSheet
    ? await ensureWorksheet(context, sheetCache, explicitSheet, { createIfMissing: false })
    : defaultSheet;
  return { sheet, target: parsedTarget.rangeAddress || action.target };
}

const FOCUS_LOST_RE = /multiple workbooks|lost focus/i;
const FOCUS_MAX_RETRIES = 2;
const FOCUS_RETRY_DELAY_MS = 600;

async function executeActions(actions, updateStepsPanel, _attempt = 0) {
  if (!actions || actions.length === 0) return { actionCount: 0, errorCount: 0, errors: [] };

  if (_attempt === 0) {
      const chunks = splitActionsIntoSafeChunks(actions);
      // Even when there's only one chunk, route through the loop so that the
      // per-chunk failure isolation (bisect into per-action Excel.run) kicks in.
      // Without this, a single-chunk batch that fails at context.sync() lost all
      // info on WHICH action was bad and the agent loop re-emitted the payload.
      if (chunks.length >= 1 && (chunks.length > 1 || actions.length > 1)) {
        const aggregate = {
          actionCount: actions.length,
          errorCount: 0,
          errors: []
        };
        const totalCells = chunks.reduce((sum, c) => sum + estimateBatchCells(c), 0);
        let snapshotsTaken = 0;
        let slowChunks = 0;
        // Cross-chunk error dedup. inspectWrittenFormulaErrors runs per chunk
        // and on dense workbooks the same downstream broken cells get reported
        // for every chunk that touches them — previous run logged "Verifica
        // formule: 37 errori" 30+ times for the same payload, with the agent
        // loop receiving 1148 errors that were really 37 unique cells. Keep
        // a Set across the loop and drop already-seen keys.
        const seenChunkErrKeys = new Set();
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const chunkCells = estimateBatchCells(chunk);
          const started = nowMs();
          let result;
          try {
            result = await executeActions(chunk, updateStepsPanel, 1);
          } catch (chunkErr) {
            // context.sync() rejected the whole chunk — typically because
            // ONE action's range/formula was malformed and Office.js can
            // only report a generic "argument invalid" for the whole batch.
            // Re-run each action in its own Excel.run so we can identify
            // and report the offender. Without this, the agent loop sees
            // "N of N failed" and re-emits the same bad payload forever.
            if (chunk.length > 1) {
              addLog(`Chunk Excel fallito (${chunkErr.message}). Isolazione per azione…`, 'warn');
              result = { actionCount: chunk.length, errorCount: 0, errors: [] };
              for (const single of chunk) {
                try {
                  const r = await executeActions([single], updateStepsPanel, 1);
                  result.errorCount += Number(r?.errorCount) || 0;
                  if (Array.isArray(r?.errors)) result.errors.push(...r.errors);
                } catch (singleErr) {
                  result.errorCount += 1;
                  const targetHint = single.target
                    || (single.cells && typeof single.cells === 'object'
                      ? Object.keys(single.cells).slice(0, 4).join(',')
                      : null);
                  const sheetHint = single.sheet || single.sheetName || null;
                  // Extract first formula/value so the LLM gets actionable
                  // context rather than just "argument invalid". Without this
                  // the agent loop iterates blindly retrying the same payload.
                  let formulaHint = null;
                  let valueHint = null;
                  let copyToHint = single.copyToRange || null;
                  if (single.cells && typeof single.cells === 'object') {
                    const firstKey = Object.keys(single.cells)[0];
                    const spec = firstKey ? single.cells[firstKey] : null;
                    if (spec) {
                      if (spec.formula) formulaHint = String(spec.formula).slice(0, 200);
                      else if (typeof spec.value === 'string' && spec.value.startsWith('=')) formulaHint = spec.value.slice(0, 200);
                      else if (spec.value !== undefined) valueHint = String(spec.value).slice(0, 80);
                    }
                  } else if (single.formula) {
                    formulaHint = String(single.formula).slice(0, 200);
                  } else if (single.value !== undefined) {
                    valueHint = String(single.value).slice(0, 80);
                  }
                  result.errors.push({
                    type: single.type,
                    sheet: sheetHint,
                    target: targetHint,
                    formula: formulaHint,
                    value: valueHint,
                    copyToRange: copyToHint,
                    message: singleErr.message,
                    queueBatchKey: single[QUEUE_BATCH_KEY] || null
                  });
                  const extra = formulaHint
                    ? ` formula="${formulaHint.slice(0, 80)}"`
                    : (valueHint ? ` value="${valueHint.slice(0, 40)}"` : '');
                  const copy = copyToHint ? ` copyTo=${copyToHint}` : '';
                  addLog(`Azione ${single.type} fallita isolata (sheet=${sheetHint || '?'}, target=${targetHint || '?'}${extra}${copy}): ${singleErr.message}`, 'error');
                }
              }
            } else {
              throw chunkErr;
            }
          }
          const durationMs = nowMs() - started;
          const prevCost = adaptiveChunkCostLimit;
          recordChunkTiming(durationMs, chunk);
          if (adaptiveChunkCostLimit < prevCost) slowChunks++;
          const rawErrors = Array.isArray(result?.errors) ? result.errors : [];
          const newErrors = [];
          for (const e of rawErrors) {
            const k = `${e?.type || ''}|${e?.sheet || ''}|${e?.target || ''}|${e?.formula || ''}|${e?.message || ''}`;
            if (seenChunkErrKeys.has(k)) continue;
            seenChunkErrKeys.add(k);
            newErrors.push(e);
          }
          aggregate.errorCount += Number(result?.errorCount) || rawErrors.length || 0;
          aggregate.errors.push(...newErrors);
          if (result && result._snapshotsTaken) snapshotsTaken += result._snapshotsTaken;
          if (i < chunks.length - 1) {
            await yieldToHost(yieldDelayForChunk(durationMs, chunkCells));
          }
        }
        const slowNote = slowChunks > 0 ? ` (${slowChunks} lenti)` : '';
        addLog(`Batch Excel: ${actions.length} azioni in ${chunks.length} chunk (~${formatCellCount(totalCells)} celle)${slowNote}.`);
        aggregate._snapshotsTaken = snapshotsTaken;
        return aggregate;
      }
  }

  let focusLost = false;
  const runActionCount = actions.length;
  const runCellCount = estimateBatchCells(actions);
  const waitedMs = await acquireRateBudget(runCellCount);
  const runStarted = nowMs();
  const result = await Excel.run(async (context) => {
    const actionErrors = [];
    const formulaCheckTargets = [];
    const defaultSheet = context.workbook.worksheets.getActiveWorksheet();
    const sheetCache = new Map();
    const pendingNotes = [];

    // Pre-load sheet existence (also from cell-key prefixes "Sheet!Addr")
    const sheetNames = new Set();
    for (const action of actions) {
      const parsedTarget = parseTargetReference(action.target);
      const explicitSheet = action.sheet || action.sheetName || parsedTarget.sheetName;
      if (explicitSheet) sheetNames.add(explicitSheet);
      if (action.type === 'setCellRange' && action.cells) {
        for (const addr of Object.keys(action.cells)) {
          const p = parseTargetReference(addr);
          if (p.sheetName) sheetNames.add(p.sheetName);
        }
      }
      if (action.type === 'copyRange') {
        if (action.fromSheet) sheetNames.add(action.fromSheet);
        if (action.toSheet) sheetNames.add(action.toSheet);
      }
    }
    if (sheetNames.size > 0) {
      const sheetProxies = [];
      for (const name of sheetNames) {
        const proxy = context.workbook.worksheets.getItemOrNullObject(name);
        proxy.load('name');
        sheetProxies.push({ name, proxy });
      }
      await context.sync();
      for (const { name, proxy } of sheetProxies) {
        if (!proxy.isNullObject) sheetCache.set(name, proxy);
      }
    }

    // 1. Capture pre-mutation snapshot for undo
    const snapshotPlan = extractSnapshotTargets(actions);
    const mutationTargets = snapshotPlan.targets;
    const estimatedBatchCells = estimateBatchCells(actions);
    if (snapshotPlan.skipped > 0) {
      addLog(`Snapshot undo parziale: ${snapshotPlan.skipped} target troppo grandi saltati per proteggere Excel.`, 'warn');
    }
    let snapshot = null;
    if (mutationTargets.length > MAX_SNAPSHOT_TARGETS) {
      addLog(`Snapshot undo saltato: ${mutationTargets.length} target superano il limite sicuro (${MAX_SNAPSHOT_TARGETS}).`, 'warn');
    } else if (estimatedBatchCells > MAX_SNAPSHOT_BATCH_CELLS) {
      addLog(`Snapshot undo saltato: batch troppo grande (~${formatCellCount(estimatedBatchCells)} celle, limite ${MAX_SNAPSHOT_BATCH_CELLS}).`, 'warn');
    } else if (mutationTargets.length > 0) {
      snapshot = await captureSnapshot(context, mutationTargets);
    }

    const mutationActionCount = actions.filter(isMutationAction).length;
    const isHeavyBatch =
      mutationActionCount >= HEAVY_BATCH_ACTIONS ||
      mutationTargets.length >= HEAVY_BATCH_SNAPSHOT_TARGETS ||
      (Number.isFinite(estimatedBatchCells) && estimatedBatchCells >= HEAVY_BATCH_CELLS);
    if (isHeavyBatch) {
      try {
        if (context.application && typeof context.application.suspendApiCalculationUntilNextSync === 'function') {
          context.application.suspendApiCalculationUntilNextSync();
        }
      } catch (_) {}
      try {
        if (context.application && typeof context.application.suspendScreenUpdatingUntilNextSync === 'function') {
          context.application.suspendScreenUpdatingUntilNextSync();
        }
      } catch (_) {}
    }

    // 2. Apply all actions
    for (const action of actions) {
      collectNotes(action, pendingNotes);
      try {
        switch (action.type) {
          case 'setCellValue':
            await execSetCellValue(context, sheetCache, defaultSheet, action);
            break;
          case 'runFormula':
            await execRunFormula(context, sheetCache, defaultSheet, action);
            break;
          case 'setCellFormat':
            await execSetCellFormat(context, sheetCache, defaultSheet, action);
            break;
          case 'fillRange':
            await execFillRange(context, sheetCache, defaultSheet, action);
            break;
          case 'writeRange':
            await execWriteRange(context, sheetCache, defaultSheet, action);
            break;
          case 'setCellRange':
            await execSetCellRange(context, sheetCache, defaultSheet, action);
            break;
          case 'createChart':
            await execCreateChart(context, sheetCache, defaultSheet, action);
            break;
          case 'createSheet':
            await execCreateSheet(context, sheetCache, action);
            break;
          case 'renameSheet':
            await execRenameSheet(context, sheetCache, action);
            break;
          case 'deleteSheet':
            await execDeleteSheet(context, sheetCache, action);
            break;
          case 'duplicateSheet':
            await execDuplicateSheet(context, sheetCache, action);
            break;
          case 'copyRange':
            await execCopyRange(context, sheetCache, action);
            break;
          case 'createNamedRange':
            await execCreateNamedRange(context, sheetCache, action);
            break;
          case 'runJavaScript':
            await execRunJavaScript(context, action);
            break;
          case 'suspendCalculation':
            await execSuspendCalculation(context);
            break;
          case 'resumeCalculation':
            await execResumeCalculation(context);
            break;
          case 'addConditionalFormat':
            await execAddConditionalFormat(context, sheetCache, defaultSheet, action);
            break;
          case 'setConditionalFormat':
            await execAddConditionalFormat(context, sheetCache, defaultSheet, action);
            break;
          case 'todoWrite':
            if (updateStepsPanel && action.todos) updateStepsPanel(action.todos);
            break;
          case 'setNotes':
            // Notes are collected above and applied in the isolated post-sync phase.
            break;
          default:
            console.warn('Azione non supportata:', action.type);
        }
        collectFormulaCheckTargets(action, formulaCheckTargets);
      } catch (actionErr) {
        console.error('Errore azione', action.type, actionErr);
        const detail = actionErr && actionErr.message ? actionErr.message : String(actionErr);
        const where = action.sheet ? ` (sheet=${action.sheet})` : '';
        if (FOCUS_LOST_RE.test(detail) && _attempt < FOCUS_MAX_RETRIES) {
          focusLost = true;
          addLog(`Azione ${action.type} fallita per focus workbook perso, riprovo batch`, 'warn');
          break;
        }
        addLog(`Azione ${action.type} fallita${where}: ${detail}`, 'error');
        const targetHint = action.target
          || (action.cells && typeof action.cells === 'object' ? Object.keys(action.cells).slice(0, 8).join(',') : null);
        actionErrors.push({
          type: action.type,
          sheet: action.sheet || action.sheetName || null,
          target: targetHint,
          message: detail,
          queueBatchKey: action[QUEUE_BATCH_KEY] || null
        });
      }
    }

    try {
      await context.sync();
    } catch (syncErr) {
      const detail = syncErr && syncErr.message ? syncErr.message : String(syncErr);
      if (FOCUS_LOST_RE.test(detail) && _attempt < FOCUS_MAX_RETRIES) {
        focusLost = true;
        addLog(`context.sync fallito per focus perso, riprovo batch`, 'warn');
      } else {
        throw syncErr;
      }
    }

    if (!focusLost && formulaCheckTargets.length > 0) {
      // Estimate total cells we'd load for verification. On huge batches the
      // background health scanner (runs periodically across the whole
      // workbook with dedup) catches these errors anyway, so skip the
      // per-batch inspection cost. Saves multi-second sync per chunk on
      // dense schedules without losing observability.
      const inspectCellsBudget = formulaCheckTargets.reduce((sum, t) => {
        const n = estimateTargetCells(t.target);
        return sum + (Number.isFinite(n) ? n : 0);
      }, 0);
      const MAX_INSPECTION_CELLS = Number(typeof window !== 'undefined' && window.EXCEL_MAX_INSPECT_CELLS) || 3000;
      if (inspectCellsBudget > MAX_INSPECTION_CELLS) {
        addLog(`Verifica formule saltata (batch ~${inspectCellsBudget} celle > ${MAX_INSPECTION_CELLS}): delego al background scanner.`, 'info');
      } else {
      try {
        const formulaErrors = await inspectWrittenFormulaErrors(context, sheetCache, defaultSheet, formulaCheckTargets);
        if (formulaErrors.length > 0) {
          actionErrors.push(...formulaErrors);
          addLog(`Verifica formule: ${formulaErrors.length} errore/i Excel rilevati dopo la scrittura.`, 'error');
        }
      } catch (err) {
        actionErrors.push({
          type: 'formulaVerification',
          sheet: null,
          target: null,
          message: `Formula verification failed: ${err && err.message ? err.message : String(err)}`
        });
      }
      }
    }

    // 3. Store snapshot for undo (after successful sync)
    if (snapshot && snapshot.entries.length > 0) {
      if (!state.undoStack) state.undoStack = [];
      state.undoStack.push(snapshot);
      if (state.undoStack.length > 10) state.undoStack.shift();
    }

    // 4. Apply notes in an isolated phase AFTER the data sync. Never lets a bad
    //    comment abort the value/formula writes that already succeeded above.
    if (pendingNotes.length > 0) {
      try {
        const r = await applyNotes(context, pendingNotes);
        addLog(`Note: ${r.applied}/${pendingNotes.length} applicate${r.fallback ? `, ${r.fallback} su ${ASSUMPTION_NOTES_SHEET}` : ''}.`);
      } catch (err) {
        addLog(`Applicazione note fallita (scritture dati non toccate): ${err.message}`, 'warn');
      }
    }

    return {
      actionCount: actions.length,
      errorCount: actionErrors.length,
      errors: actionErrors
    };
  });

  if (focusLost && _attempt < FOCUS_MAX_RETRIES) {
    addLog(`Retry batch Excel dopo focus perso (tentativo ${_attempt + 2}/${FOCUS_MAX_RETRIES + 1})`, 'warn');
    await new Promise(resolve => setTimeout(resolve, FOCUS_RETRY_DELAY_MS));
    return executeActions(actions, updateStepsPanel, _attempt + 1);
  }

  const runDurationMs = nowMs() - runStarted;
  if (_attempt === 0) {
    recordChunkTiming(runDurationMs, actions);
  }
  recordRunStat({
    ts: Date.now(),
    actionCount: runActionCount,
    cellCount: Number.isFinite(runCellCount) ? runCellCount : 0,
    runMs: runDurationMs,
    waitedMs
  });
  notifyBatchFinished();

  return result;
}

async function execSetCellValue(context, sheetCache, defaultSheet, action) {
  const { sheet, target } = await resolveSheetAndTarget(context, sheetCache, defaultSheet, action);
  const range = sheet.getRange(target);
  if (typeof action.value === 'string' && action.value.startsWith('=')) {
    range.formulas = [[action.value]];
  } else {
    range.values = [[action.value]];
  }
}

async function execRunFormula(context, sheetCache, defaultSheet, action) {
  const { sheet, target } = await resolveSheetAndTarget(context, sheetCache, defaultSheet, action);
  const range = sheet.getRange(target);
  range.formulas = [[action.value]];
}

async function execSetCellFormat(context, sheetCache, defaultSheet, action) {
  const { sheet, target } = await resolveSheetAndTarget(context, sheetCache, defaultSheet, action);
  const range = sheet.getRange(target);
  const opts = action.options || {};
  const dims = dimsFromA1(target);
  const estimatedCells = estimateTargetCells(target);
  const formatKeys = Object.keys(opts || {});
  const unboundedAllowed = formatKeys.length > 0 && formatKeys.every(k => ['columnWidth', 'rowHeight'].includes(k));

  if (!Number.isFinite(estimatedCells) && !unboundedAllowed) {
    addLog(`Formattazione saltata su ${target}: range non limitato (usa A1 finito, non colonne/righe intere).`, 'warn');
    return;
  }
  if (Number.isFinite(estimatedCells) && estimatedCells > MAX_DIRECT_FORMAT_CELLS) {
    addLog(`Formattazione saltata su ${target}: ${estimatedCells} celle supera il limite ${MAX_DIRECT_FORMAT_CELLS}. Dividi in blocchi piu piccoli.`, 'warn');
    return;
  }

  // numberFormat must be a matrix matching the range. When dims can't be derived
  // from the A1 address (named range or unbounded "A:A"), measure the range —
  // binding to the used range for unbounded targets to avoid a million-row matrix.
  if (opts.numberFormat && !dims) {
    const { numberFormat, ...rest } = opts;
    if (Object.keys(rest).length) applyRangeFormat(range, rest);
    const measured = isUnboundedA1(target) ? range.getUsedRangeOrNullObject(true) : range;
    measured.load('rowCount,columnCount');
    await context.sync();
    if (!measured.isNullObject && measured.rowCount > 0 &&
        measured.rowCount * measured.columnCount <= MAX_NUMBERFORMAT_CELLS) {
      measured.numberFormat = buildMatrix(measured.rowCount, measured.columnCount, numberFormat);
    } else {
      addLog(`numberFormat saltato su ${target}: range vuoto o troppo grande (>${MAX_NUMBERFORMAT_CELLS} celle).`, 'warn');
    }
    return;
  }

  applyRangeFormat(range, opts, dims);
}

function enumValue(enumObject, candidates, fallback) {
  if (!enumObject) return fallback;
  for (const candidate of candidates) {
    if (candidate && enumObject[candidate] !== undefined) return enumObject[candidate];
  }
  return fallback;
}

function applyBorder(range, edge, spec = {}) {
  try {
    const borderIndex = {
      top: enumValue(Excel.BorderIndex, ['edgeTop', 'EdgeTop'], 'EdgeTop'),
      bottom: enumValue(Excel.BorderIndex, ['edgeBottom', 'EdgeBottom'], 'EdgeBottom'),
      left: enumValue(Excel.BorderIndex, ['edgeLeft', 'EdgeLeft'], 'EdgeLeft'),
      right: enumValue(Excel.BorderIndex, ['edgeRight', 'EdgeRight'], 'EdgeRight'),
      insideHorizontal: enumValue(Excel.BorderIndex, ['insideHorizontal', 'InsideHorizontal'], 'InsideHorizontal'),
      insideVertical: enumValue(Excel.BorderIndex, ['insideVertical', 'InsideVertical'], 'InsideVertical')
    };
    const border = range.format.borders.getItem(borderIndex[edge] || edge);
    const style = String(spec.style || 'continuous').toLowerCase();
    border.style = enumValue(Excel.BorderLineStyle, [style, spec.style, 'continuous'], spec.style || 'Continuous');
    if (spec.color) border.color = spec.color;
    if (spec.weight) {
      const weight = String(spec.weight).toLowerCase();
      border.weight = enumValue(Excel.BorderWeight, [weight, spec.weight], spec.weight);
    }
  } catch (err) {
    console.warn('Border format not applied', edge, err);
  }
}

function applyRangeFormat(range, fmt = {}, dims = null) {
  if (fmt.backgroundColor) range.format.fill.color = fmt.backgroundColor;
  if (fmt.fontColor) range.format.font.color = fmt.fontColor;
  if (fmt.bold !== undefined) range.format.font.bold = fmt.bold;
  if (fmt.italic !== undefined) range.format.font.italic = fmt.italic;
  if (fmt.fontSize !== undefined) range.format.font.size = Number(fmt.fontSize);
  if (fmt.fontName) range.format.font.name = fmt.fontName;
  if (fmt.numberFormat) range.numberFormat = buildMatrix(dims?.rows || 1, dims?.cols || 1, fmt.numberFormat);
  if (fmt.horizontalAlignment) range.format.horizontalAlignment = fmt.horizontalAlignment;
  if (fmt.verticalAlignment) range.format.verticalAlignment = fmt.verticalAlignment;
  if (fmt.wrapText !== undefined) range.format.wrapText = !!fmt.wrapText;
  if (fmt.columnWidth !== undefined) range.format.columnWidth = Number(fmt.columnWidth);
  if (fmt.rowHeight !== undefined) range.format.rowHeight = Number(fmt.rowHeight);

  if (fmt.borderBottomColor) applyBorder(range, 'bottom', { color: fmt.borderBottomColor, style: 'continuous', weight: fmt.borderBottomWeight || 'Thin' });
  if (fmt.borderTopColor) applyBorder(range, 'top', { color: fmt.borderTopColor, style: 'continuous', weight: fmt.borderTopWeight || 'Thin' });
  if (fmt.borders && typeof fmt.borders === 'object') {
    for (const [edge, spec] of Object.entries(fmt.borders)) {
      applyBorder(range, edge, spec || {});
    }
  }
}

// ---------- Notes / Comments (isolated post-sync phase) ----------

const ASSUMPTION_NOTES_SHEET = 'Assumption_Notes';

// Module-level cache: some Excel WebView builds (Mac, web) throw "This operation is not
// implemented" on workbook.comments.add. After the first such failure, skip the native
// attempt entirely and go straight to the Assumption_Notes fallback — avoids the
// per-note try/catch/sync round-trips that flood the log.
let _nativeCommentsUnsupported = false;
function looksLikeNotImplemented(err) {
  const m = (err && err.message ? String(err.message) : '').toLowerCase();
  return m.includes('not implemented') || m.includes('not supported');
}

// Pull notes out of mutation actions so they can be applied AFTER the value/formula
// sync. A failing comment must never abort the data writes.
function collectNotes(action, out) {
  if (!action) return;
  if (action.type === 'setNotes' && Array.isArray(action.notes)) {
    for (const n of action.notes) {
      const text = n && (n.text ?? n.note);
      if (n && n.addr && text != null && text !== '') {
        const parsed = parseTargetReference(n.addr);
        out.push({ sheet: parsed.sheetName || n.sheet || action.sheet || null, addr: parsed.rangeAddress || n.addr, text });
      }
    }
    return;
  }
  if (action.type === 'setCellRange' && action.cells) {
    for (const [addr, spec] of Object.entries(action.cells)) {
      if (spec && spec.note != null && spec.note !== '') {
        const parsed = parseTargetReference(addr);
        out.push({ sheet: parsed.sheetName || action.sheet || action.sheetName || null, addr: parsed.rangeAddress || addr, text: spec.note });
      }
    }
  }
}

// Apply notes as native Excel comments, one at a time with its own sync so a single
// bad comment is logged and skipped rather than aborting the batch. Anything that
// still fails is written to an Assumption_Notes sheet so the annotation is never lost.
function isAssumptionNotesFallbackEnabled() {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage?.getItem('excelAi.assumptionNotesFallback') === 'true'
      || window.EXCEL_AI_ASSUMPTION_NOTES_FALLBACK === true;
  } catch (_) { return false; }
}

async function applyNotes(context, notes) {
  let applied = 0;
  const failed = [];

  // If native comments are unavailable or the note batch is large, skip the
  // per-note sync loop. The fallback sheet (Assumption_Notes) is opt-in via
  // localStorage excelAi.assumptionNotesFallback=true. Default OFF — users on
  // Excel for Mac were getting a polluted workbook with a 3-column dump sheet
  // because every batch of 13-17 notes routed to the fallback.
  if (_nativeCommentsUnsupported || notes.length > MAX_NATIVE_NOTE_ATTEMPTS_PER_BATCH) {
    if (!_nativeCommentsUnsupported && notes.length > MAX_NATIVE_NOTE_ATTEMPTS_PER_BATCH) {
      addLog(`Note: batch ${notes.length} > soglia ${MAX_NATIVE_NOTE_ATTEMPTS_PER_BATCH}, salto le note (commenti nativi non affidabili in batch grandi).`, 'warn');
    }
    failed.push(...notes);
  } else {
    for (const n of notes) {
      const address = n.sheet ? `${n.sheet}!${n.addr}` : n.addr;
      try {
        context.workbook.comments.add(address, String(n.text));
        await context.sync();
        applied++;
      } catch (addErr) {
        if (looksLikeNotImplemented(addErr)) {
          // Excel build doesn't support native comments at all — flip the cache and
          // route this note + everything remaining in the batch to the fallback.
          _nativeCommentsUnsupported = true;
          addLog('Native Excel comments non supportati in questo workbook → uso solo il foglio Assumption_Notes per le note.', 'warn');
          failed.push(n);
          const idx = notes.indexOf(n);
          for (let i = idx + 1; i < notes.length; i++) failed.push(notes[i]);
          break;
        }
        try {
          // A comment likely already exists on this cell → update its content instead.
          const existing = context.workbook.comments.getItemByCell(address);
          existing.content = String(n.text);
          await context.sync();
          applied++;
        } catch (updErr) {
          failed.push(n);
          addLog(`Nota non applicata su ${address}: ${updErr.message || addErr.message}`, 'warn');
        }
      }
    }
  }
  let fallback = 0;
  if (failed.length > 0 && isAssumptionNotesFallbackEnabled()) {
    try {
      fallback = await writeNotesFallback(context, failed);
    } catch (err) {
      addLog(`Fallback ${ASSUMPTION_NOTES_SHEET} fallito: ${err.message}`, 'warn');
    }
  }
  return { applied, failed: failed.length, fallback };
}

async function writeNotesFallback(context, notes) {
  const sheetCache = new Map();
  const sheet = await ensureWorksheet(context, sheetCache, ASSUMPTION_NOTES_SHEET, { createIfMissing: true });
  const used = sheet.getUsedRangeOrNullObject(true);
  used.load('rowCount');
  await context.sync();
  let startRow = (!used.isNullObject && used.rowCount > 0) ? used.rowCount : 0;
  if (startRow === 0) {
    sheet.getRange('A1:C1').values = [['Sheet', 'Cell', 'Note']];
    startRow = 1;
  }
  const rows = notes.map(n => [n.sheet || '', n.addr, String(n.text)]);
  sheet.getRange(`A${startRow + 1}:C${startRow + rows.length}`).values = rows;
  await context.sync();
  return rows.length;
}

async function execFillRange(context, sheetCache, defaultSheet, action) {
  // Accept new schema {start, end, formula|value} from codefirst, plus legacy {target, value}
  const inferredTarget = action.target
    || (action.start && action.end ? `${action.start}:${action.end}` : null);
  const effective = { ...action, target: inferredTarget };
  if (!inferredTarget) throw new Error('fillRange: missing target (need either target or start+end)');

  const { sheet, target } = await resolveSheetAndTarget(context, sheetCache, defaultSheet, effective);
  const range = sheet.getRange(target);
  range.load('rowCount,columnCount');
  await context.sync();
  const rows = range.rowCount;
  const cols = range.columnCount;

  if (action.formula && typeof action.formula === 'string') {
    const matrix = Array.from({ length: rows }, () => Array(cols).fill(action.formula));
    range.formulas = matrix;
    return;
  }
  if (Array.isArray(action.value)) {
    range.values = action.value;
    return;
  }
  const v = action.value !== undefined ? action.value : '';
  range.values = Array.from({ length: rows }, () => Array(cols).fill(v));
}

async function execWriteRange(context, sheetCache, defaultSheet, action) {
  const { sheet, target } = await resolveSheetAndTarget(context, sheetCache, defaultSheet, action);
  const range = sheet.getRange(target);
  if (Array.isArray(action.formulas)) {
    range.formulas = action.formulas;
  } else if (Array.isArray(action.values)) {
    range.values = action.values;
  } else if (typeof action.value === 'string' && action.value.startsWith('=')) {
    range.formulas = [[action.value]];
  } else {
    range.values = [[action.value]];
  }
}

function sanitizeOfficeJsCode(raw) {
  let code = String(raw);
  // 1) Strip Excel.run(async (ctx) => { ... }) wrapper if LLM disobeyed instructions
  const runMatch = code.match(/Excel\.run\s*\(\s*async\s*(?:function\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>?\s*\{([\s\S]*)\}\s*\)\s*;?\s*$/);
  if (runMatch) {
    const ctxParam = runMatch[1];
    let inner = runMatch[2];
    // last closing brace before the wrapper close — heuristic: trim trailing whitespace then drop last "}"
    inner = inner.replace(/\}\s*$/, '');
    if (ctxParam !== 'context') {
      inner = inner.replace(new RegExp('\\b' + ctxParam + '\\b', 'g'), 'context');
    }
    code = inner;
  }
  // 2) Strip any top-level redeclaration of `context` (collides with our injected param)
  code = code.replace(/^[ \t]*(?:const|let|var)\s+context\s*=\s*[^;\n]+;?[ \t]*\n?/gm, '');
  return code;
}

async function execRunJavaScript(context, action) {
  const rawCode = action.code;
  if (!rawCode || typeof rawCode !== 'string') throw new Error('runJavaScript requires a "code" string');
  if (!isRunJavaScriptEnabled()) {
    throw new Error('runJavaScript is disabled. Remove localStorage excelAi.allowRunJavaScript=false (or set window.EXCEL_AI_ALLOW_RUN_JAVASCRIPT=true) to enable.');
  }
  const code = sanitizeOfficeJsCode(rawCode);
  // Use AsyncFunction to support await — new Function() creates synchronous functions
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  const fn = new AsyncFunction('context', code);
  const output = await fn(context);
  await context.sync();
  return output;
}

async function execSetCellRange(context, sheetCache, defaultSheet, action) {
  const fallbackName = action.sheet || action.sheetName;
  if (!fallbackName) {
    addLog(`setCellRange senza sheet → fallback su foglio attivo se le chiavi cells non hanno prefisso "Sheet!".`, 'warn');
  }
  const fallbackSheet = fallbackName
    ? await ensureWorksheet(context, sheetCache, fallbackName, { createIfMissing: true })
    : defaultSheet;
  const cells = action.cells || {};
  const copyToRange = action.copyToRange;
  const allowOverwrite = action.allow_overwrite !== false;
  const addresses = Object.keys(cells);
  if (addresses.length === 0 && !copyToRange) return;

  // Resolve per-cell sheet (cell key may carry "Sheet!Address" prefix)
  const resolved = [];
  for (const addr of addresses) {
    const parsed = parseTargetReference(addr);
    let cellSheet = fallbackSheet;
    if (parsed.sheetName) {
      cellSheet = await ensureWorksheet(context, sheetCache, parsed.sheetName, { createIfMissing: true });
    }
    resolved.push({ originalAddr: addr, cellSheet, cellAddr: parsed.rangeAddress || addr, spec: cells[addr] });
  }

  if (!allowOverwrite && resolved.length > 0) {
    const rangesToCheck = resolved.map(r => r.cellSheet.getRange(r.cellAddr));
    rangesToCheck.forEach(r => r.load('values'));
    await context.sync();
    const nonEmpty = resolved.filter((r, i) => {
      const val = rangesToCheck[i].values[0][0];
      return val !== '' && val !== null && val !== undefined;
    }).map(r => r.originalAddr);
    if (nonEmpty.length > 0) {
      throw new Error(`Would overwrite ${nonEmpty.length} non-empty cell(s): ${nonEmpty.slice(0, 5).join(', ')}. Retry with allow_overwrite=true.`);
    }
  }

  const cellWriteErrors = [];
  for (const { originalAddr, cellSheet, cellAddr, spec } of resolved) {
    try {
      const cell = cellSheet.getRange(cellAddr);
      const dims = dimsFromA1(cellAddr) || { rows: 1, cols: 1 };
      const single = dims.rows * dims.cols === 1;
      let formula = spec.formula;
      let value = spec.value;
      // LLM sometimes puts a formula string in the `value` field.
      if (formula == null && typeof value === 'string' && value.startsWith('=')) { formula = value; value = undefined; }

      if (formula != null) {
        if (Array.isArray(formula)) {
          cell.formulas = reshapeTo(dims, formula);
        } else if (single) {
          cell.formulas = [[String(formula)]];
        } else {
          // Same formula across a multi-cell range key → autoFill from the top-left
          // so relative references adjust (the usual "fill down/across" intent).
          // For very large destinations (>MAX_AUTOFILL_CELLS), Office.js'
          // autoFill can reject the whole sync as "argument invalid" and we
          // have no way to bisect inside Excel.run. Annotate the action so
          // the per-action isolation upstream can flag it cleanly, and fall
          // back to the matrix path which is more predictable for size.
          const totalCells = dims.rows * dims.cols;
          const src = cell.getCell(0, 0);
          src.formulas = [[String(formula)]];
          if (totalCells > MAX_AUTOFILL_CELLS_PER_RANGE) {
            addLog(`setCellRange ${originalAddr}: range autoFill enorme (${totalCells} celle). Uso matrix-fill diretto (refs relative non si aggiusteranno per riga).`, 'warn');
            cell.formulas = buildMatrix(dims.rows, dims.cols, String(formula));
          } else {
            try {
              src.autoFill(cell, Excel.AutoFillType.fillDefault);
            } catch (autoErr) {
              addLog(`setCellRange ${originalAddr}: autoFill fallita (${autoErr.message}). Provo fillFormulas.`, 'warn');
              try {
                src.autoFill(cell, Excel.AutoFillType.fillFormulas);
              } catch (auto2) {
                addLog(`setCellRange ${originalAddr}: fillFormulas anche fallita. Uso matrix-fill (formula "${String(formula).slice(0, 80)}").`, 'warn');
                cell.formulas = buildMatrix(dims.rows, dims.cols, String(formula));
              }
            }
          }
        }
      } else if (value !== undefined) {
        if (Array.isArray(value)) {
          cell.values = reshapeTo(dims, value);
        } else {
          const v = (value !== null && typeof value === 'object') ? JSON.stringify(value) : value;
          cell.values = single ? [[v]] : buildMatrix(dims.rows, dims.cols, v);
        }
      }

      // Notes are NOT applied here: Excel comments can fail late during context.sync
      // and abort the whole batch. They are collected and applied separately in a
      // post-sync, per-note isolated phase (see collectNotes / applyNotes).
      if (spec.cellStyles) {
        applyRangeFormat(cell, spec.cellStyles, dims);
      }
    } catch (cellErr) {
      cellWriteErrors.push(`${originalAddr}: ${cellErr.message}`);
    }
  }
  if (cellWriteErrors.length > 0 && cellWriteErrors.length === resolved.length) {
    throw new Error(`setCellRange: tutte le ${resolved.length} scritture cella fallite. Prime: ${cellWriteErrors.slice(0, 3).join(' | ')}`);
  }

  // Activate the sheet of the first written cell (best-effort UX)
  try { (resolved[0]?.cellSheet || fallbackSheet).activate(); } catch (_) {}

  if (copyToRange && resolved.length > 0) {
    const parsedDest = parseTargetReference(copyToRange);
    const destAddr = parsedDest.rangeAddress || copyToRange;
    const destSheet = parsedDest.sheetName
      ? await ensureWorksheet(context, sheetCache, parsedDest.sheetName, { createIfMissing: true })
      : resolved[0].cellSheet;
    const srcSheet = resolved[0].cellSheet;

    // Pick autoFill source from cells INSIDE copyToRange. Past bug: raw
    // firstAddr:lastAddr produced a 2-col source vs 36-col dest (e.g. seed
    // value in B4 + formula in C4 with copyToRange C4:AL4) and Office.js
    // threw "argument invalid". See pickAutoFillSource for details.
    const pick = pickAutoFillSource(resolved.map(r => r.cellAddr), destAddr);
    if (pick.skipReason) {
      addLog(`copyToRange ${destAddr}: ${pick.skipReason}; salto autoFill.`, 'warn');
    } else if (pick.srcAddr) {
      const srcRange = srcSheet.getRange(pick.srcAddr);
      const destRange = destSheet.getRange(destAddr);
      try {
        srcRange.autoFill(destRange, Excel.AutoFillType.fillDefault);
      } catch (autoFillErr) {
        addLog(`copyToRange autoFill fallita src=${pick.srcAddr} dest=${destAddr}: ${autoFillErr.message}. Provo fillFormulas.`, 'warn');
        try {
          srcRange.autoFill(destRange, Excel.AutoFillType.fillFormulas);
        } catch (e2) {
          throw new Error(`copyToRange src=${pick.srcAddr} dest=${destAddr}: ${e2.message}`);
        }
      }
    }
  }

  // The outer executeActions() performs the batch sync. Syncing here for every
  // setCellRange makes large AI-generated writes much more likely to freeze Excel.
}

async function execCreateChart(context, sheetCache, defaultSheet, action) {
  const { sheet, target } = await resolveSheetAndTarget(context, sheetCache, defaultSheet, action);
  const dataRange = sheet.getRange(target);
  const opts = action.options || {};
  const chartType = opts.chartType || 'ColumnClustered';
  const chart = sheet.charts.add(Excel.ChartType[chartType] || Excel.ChartType.columnClustered, dataRange, 'Auto');
  if (opts.title) chart.title.text = opts.title;
  chart.setPosition('A15', 'E30');
}

async function execCreateSheet(context, sheetCache, action) {
  const name = action.name || action.sheet || 'NuovoFoglio';
  await ensureWorksheet(context, sheetCache, name, { createIfMissing: true });
}

async function execRenameSheet(context, sheetCache, action) {
  const oldName = action.oldName || action.name;
  const newName = action.newName || action.to;
  if (!oldName || !newName) throw new Error('renameSheet requires oldName and newName');
  const sheet = await ensureWorksheet(context, sheetCache, oldName);
  sheet.name = newName;
  sheetCache.delete(oldName);
  sheetCache.set(newName, sheet);
}

async function execDeleteSheet(context, sheetCache, action) {
  const name = action.name || action.sheet;
  if (!name) throw new Error('deleteSheet requires name');
  const sheet = await ensureWorksheet(context, sheetCache, name);
  sheet.delete();
  sheetCache.delete(name);
}

async function execDuplicateSheet(context, sheetCache, action) {
  const sourceName = action.source || action.name;
  const newName = action.newName || sourceName + ' (copy)';
  if (!sourceName) throw new Error('duplicateSheet requires source name');
  const source = await ensureWorksheet(context, sheetCache, sourceName);
  source.copy(null).name = newName;
}

async function execCopyRange(context, sheetCache, action) {
  const fromSheetName = action.fromSheet || action.sheet;
  const toSheetName = action.toSheet || action.fromSheet;
  const fromRange = action.from || action.target;
  const toRange = action.to || action.from;
  if (!fromRange || !toRange) throw new Error('copyRange requires from and to addresses');
  const fromSheet = await ensureWorksheet(context, sheetCache, fromSheetName);
  const toSheet = await ensureWorksheet(context, sheetCache, toSheetName, { createIfMissing: true });
  const srcRange = fromSheet.getRange(fromRange);
  const dstRange = toSheet.getRange(toRange);
  srcRange.copyTo(dstRange);
}

async function execCreateNamedRange(context, sheetCache, action) {
  const name = action.name || action.ref;
  const refersTo = action.refersTo || `=${action.sheet}!${action.target}`;
  if (!name) throw new Error('createNamedRange requires a name');
  context.workbook.names.add(name, refersTo);
}

async function execSuspendCalculation(context) {
  context.application.calculationMode = Excel.CalculationMode.manual;
}

async function execResumeCalculation(context) {
  context.application.calculationMode = Excel.CalculationMode.automatic;
  context.application.calculate(Excel.CalculationType.full);
}

async function execAddConditionalFormat(context, sheetCache, defaultSheet, action) {
  const { sheet, target } = await resolveSheetAndTarget(context, sheetCache, defaultSheet, action);
  const range = sheet.getRange(target);
  const opts = action.options || {};
  if (opts.colorScale) {
    const cf = range.conditionalFormats.add(Excel.ConditionalFormatType.colorScale);
    cf.colorScale.criteria = opts.colorScale.criteria || {
      minimum: { formula: null, color: opts.colorScale.minColor || '#63BE7B', type: Excel.ConditionalFormatColorCriterionType.lowestValue },
      midpoint: { formula: null, color: opts.colorScale.midColor || '#FFEB84', type: Excel.ConditionalFormatColorCriterionType.percentile, percentile: 50 },
      maximum: { formula: null, color: opts.colorScale.maxColor || '#F8696B', type: Excel.ConditionalFormatColorCriterionType.highestValue }
    };
  }
  if (opts.dataBar) {
    const cf = range.conditionalFormats.add(Excel.ConditionalFormatType.dataBar);
    cf.dataBar.barColor = opts.dataBar.color || '#4472C4';
    if (opts.dataBar.showDataBarOnly !== undefined) cf.dataBar.showDataBarOnly = opts.dataBar.showDataBarOnly;
  }
  if (opts.iconSet) {
    const cf = range.conditionalFormats.add(Excel.ConditionalFormatType.iconSet);
    cf.iconSet.style = opts.iconSet.style || Excel.IconSet.threeTrafficLights1;
  }
  if (opts.cellValue) {
    const cf = range.conditionalFormats.add(Excel.ConditionalFormatType.cellValue);
    const rule = opts.cellValue;
    cf.cellValue.format.fill.color = rule.fillColor || '#C6EFCE';
    cf.cellValue.format.font.color = rule.fontColor || '#006100';
    cf.cellValue.rule = {
      formula1: rule.formula1 || '0',
      formula2: rule.formula2 || '',
      operator: rule.operator || Excel.ConditionalCellValueOperator.greaterThan
    };
  }
}

export {
  enqueueActions,
  executeActions,
  waitForActionQueueIdle,
  execRunJavaScript,
  sanitizeOfficeJsCode,
  isRunJavaScriptEnabled,
  pickAutoFillSource,
  isExcelQueueIdle,
  subscribeBatchFinished
};
