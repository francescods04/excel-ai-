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
  processQueue(excelActionQueue, showActionsPreview, hideActionsPreview, executeActions);
}

let isExecutingQueue = false;
const queueIdleResolvers = [];

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

async function processQueue(excelActionQueue, showActionsPreview, hideActionsPreview, executeActions) {
  if (isExecutingQueue) return;
  isExecutingQueue = true;
  try {
    while (excelActionQueue.length > 0) {
      const batch = normalizeBatch(excelActionQueue.shift());
      if (!batch || batch.actions.length === 0) continue;
      const { actions, meta, onBatchComplete } = batch;
      let completion = {
        ok: true,
        meta,
        actionCount: actions.length,
        errorCount: 0,
        errors: []
      };
      try {
        showActionsPreview(actions);
        const result = await executeActions(actions);
        const errors = Array.isArray(result?.errors) ? result.errors : [];
        const errorCount = Number(result?.errorCount) || errors.length || 0;
        completion = {
          ...completion,
          actionCount: Number(result?.actionCount) || actions.length,
          errorCount,
          errors,
          ok: errorCount === 0
        };
      } catch (err) {
        completion = {
          ...completion,
          ok: false,
          error: err.message,
          errorCount: actions.length || 1
        };
        addLog('Errore azioni Excel: ' + err.message, 'error');
      } finally {
        try { hideActionsPreview(); } catch (err) {}
        await reportBatchComplete(onBatchComplete, completion);
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
const MAX_SNAPSHOT_TARGETS = 300;
const MAX_SNAPSHOT_CELLS_PER_TARGET = 2000;
const HEAVY_BATCH_ACTIONS = 12;
const HEAVY_BATCH_SNAPSHOT_TARGETS = 80;

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
  if (action.type === 'setCellRange' && action.cells) return Object.keys(action.cells).length;
  const matrix = Array.isArray(action.formulas) ? action.formulas : action.values;
  if (Array.isArray(matrix)) {
    const rows = matrix.length;
    const cols = Array.isArray(matrix[0]) ? matrix[0].length : 1;
    return Math.max(1, rows * cols);
  }
  return estimateTargetCells(action.target);
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
      if (t.isFormat) {
        range.load('format/fill/color,format/font/color,format/font/bold,numberFormat');
      } else {
        range.load('values,formulas');
      }
      ranges.push({ target: t.target, range, isFormat: t.isFormat });
    }
    await context.sync();

    for (const r of ranges) {
      snapshot.entries.push({
        sheet: sheetName === '__default__' ? null : sheetName,
        target: r.target,
        previousValues: r.isFormat ? null : r.range.values,
        previousFormulas: r.isFormat ? null : r.range.formulas,
        previousFormat: r.isFormat ? {
          fillColor: r.range.format.fill.color,
          fontColor: r.range.format.font.color,
          bold: r.range.format.font.bold,
          numberFormat: r.range.numberFormat
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

  let focusLost = false;
  const result = await Excel.run(async (context) => {
    const actionErrors = [];
    const defaultSheet = context.workbook.worksheets.getActiveWorksheet();
    const sheetCache = new Map();

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
    if (snapshotPlan.skipped > 0) {
      addLog(`Snapshot undo parziale: ${snapshotPlan.skipped} target troppo grandi saltati per proteggere Excel.`, 'warn');
    }
    let snapshot = null;
    if (mutationTargets.length > MAX_SNAPSHOT_TARGETS) {
      addLog(`Snapshot undo saltato: ${mutationTargets.length} target superano il limite sicuro (${MAX_SNAPSHOT_TARGETS}).`, 'warn');
    } else if (mutationTargets.length > 0) {
      snapshot = await captureSnapshot(context, mutationTargets);
    }

    const mutationActionCount = actions.filter(isMutationAction).length;
    if (mutationActionCount >= HEAVY_BATCH_ACTIONS || mutationTargets.length >= HEAVY_BATCH_SNAPSHOT_TARGETS) {
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
          default:
            console.warn('Azione non supportata:', action.type);
        }
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
        actionErrors.push({
          type: action.type,
          sheet: action.sheet || action.sheetName || null,
          target: action.target || null,
          message: detail
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

    // 3. Store snapshot for undo (after successful sync)
    if (snapshot && snapshot.entries.length > 0) {
      if (!state.undoStack) state.undoStack = [];
      state.undoStack.push(snapshot);
      // Keep only last 10 snapshots to avoid memory bloat
      if (state.undoStack.length > 10) state.undoStack.shift();
      addLog(`Snapshot salvato: ${snapshot.entries.length} celle (undo stack: ${state.undoStack.length})`);
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
  applyRangeFormat(range, action.options || {});
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

function applyRangeFormat(range, fmt = {}) {
  if (fmt.backgroundColor) range.format.fill.color = fmt.backgroundColor;
  if (fmt.fontColor) range.format.font.color = fmt.fontColor;
  if (fmt.bold !== undefined) range.format.font.bold = fmt.bold;
  if (fmt.italic !== undefined) range.format.font.italic = fmt.italic;
  if (fmt.fontSize !== undefined) range.format.font.size = Number(fmt.fontSize);
  if (fmt.fontName) range.format.font.name = fmt.fontName;
  if (fmt.numberFormat) range.numberFormat = [[fmt.numberFormat]];
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

async function execFillRange(context, sheetCache, defaultSheet, action) {
  const { sheet, target } = await resolveSheetAndTarget(context, sheetCache, defaultSheet, action);
  const range = sheet.getRange(target);
  if (Array.isArray(action.value)) {
    range.values = action.value;
  } else {
    range.values = [[action.value]];
  }
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

  for (const { cellSheet, cellAddr, spec } of resolved) {
    const cell = cellSheet.getRange(cellAddr);
    if (spec.formula) {
      cell.formulas = [[spec.formula]];
    } else if (spec.value !== undefined) {
      cell.values = [[spec.value]];
    }
    // Excel comments can fail late during context.sync and abort the whole batch.
    // Keep notes out of the write path until comments have a dedicated safe action.
    if (spec.cellStyles) {
      applyRangeFormat(cell, spec.cellStyles);
    }
  }

  // Activate the sheet of the first written cell (best-effort UX)
  try { (resolved[0]?.cellSheet || fallbackSheet).activate(); } catch (_) {}

  if (copyToRange && resolved.length > 0) {
    const first = resolved[0];
    const parsedDest = parseTargetReference(copyToRange);
    const destSheet = parsedDest.sheetName
      ? await ensureWorksheet(context, sheetCache, parsedDest.sheetName, { createIfMissing: true })
      : first.cellSheet;
    const firstCell = first.cellSheet.getRange(first.cellAddr);
    const destRange = destSheet.getRange(parsedDest.rangeAddress || copyToRange);
    destRange.copyFrom(firstCell, Excel.RangeCopyType.all);
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
  isRunJavaScriptEnabled
};
