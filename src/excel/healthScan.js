'use strict';

// Periodic workbook sanity scanner. Runs in the background while a turn is
// active, looking for cells that ended up with Excel evaluation errors
// (#VALUE!, #REF!, #NAME?, #DIV/0!, #N/A, #NULL!) so the main agent sees them
// in its next iteration and can correct.
//
// Design goals (in order of priority):
//  1. NEVER slow down the main agent. Scan only when the Excel action queue
//     is fully idle. Use a soft cooldown after the last batch sync so the
//     workbook has time to recalc before we read.
//  2. NEVER call the LLM here. This module is a passive observer. The main
//     agent already knows how to react to Excel write errors — we just
//     surface workbook-wide ones it would otherwise miss (errors caused in
//     sheet A by a write to sheet B, for example).
//  3. Bounded cost. Scan ≤ N sheets, ≤ M cells per sheet, ≤ K errors per
//     report. The point is signal, not an exhaustive catalog.

import state from '../store/state.js';
import { addLog } from '../ui/executionLog.js';
import { isExcelQueueIdle, subscribeBatchFinished } from './writers.js';

let batchSubscribed = false;

const ERROR_MARKERS = new Set([
  '#REF!', '#VALUE!', '#NAME?', '#DIV/0!', '#N/A', '#NULL!', '#NUM!'
]);
const SCAN_INTERVAL_MS_DEFAULT = 12000;
const COOLDOWN_AFTER_BATCH_MS_DEFAULT = 2500;
const MAX_SHEETS_PER_SCAN_DEFAULT = 30;
const MAX_CELLS_PER_SHEET_DEFAULT = 4000;
const MAX_ERRORS_PER_REPORT_DEFAULT = 30;
const MAX_FORMULA_CHARS = 240;

const scannerState = {
  timer: null,
  lastScanAt: 0,
  lastBatchAt: 0,
  running: false,
  turnId: null,
  scansRun: 0,
  errorsReported: 0,
  reporter: null
};

function readKnob(name, fallback) {
  if (typeof window === 'undefined') return fallback;
  const v = Number(window[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function isErrorValue(v) {
  if (v == null) return false;
  if (typeof v !== 'string') return false;
  const trimmed = v.trim();
  return ERROR_MARKERS.has(trimmed.toUpperCase());
}

function colNumberToA1(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseBaseCellFromAddress(addr) {
  if (typeof addr !== 'string') return { col: 1, row: 1 };
  const raw = addr.includes('!') ? addr.split('!').slice(1).join('!') : addr;
  const m = raw.replace(/\$/g, '').match(/^([A-Z]+)(\d+)/i);
  if (!m) return { col: 1, row: 1 };
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col || 1, row: Number(m[2]) || 1 };
}

// Pure: scan a values/formulas matrix for cells whose evaluated value is an
// Excel error marker. Exported for unit testing.
function extractErrorsFromMatrix(sheetName, baseAddress, values, formulas, maxErrors = MAX_ERRORS_PER_REPORT_DEFAULT) {
  const errors = [];
  if (!Array.isArray(values)) return errors;
  const base = parseBaseCellFromAddress(baseAddress || `${sheetName}!A1`);
  for (let r = 0; r < values.length; r++) {
    const valueRow = values[r] || [];
    const formulaRow = (formulas && formulas[r]) || [];
    for (let c = 0; c < valueRow.length; c++) {
      const v = valueRow[c];
      if (!isErrorValue(v)) continue;
      const addr = `${colNumberToA1(base.col + c)}${base.row + r}`;
      const formula = formulaRow[c];
      errors.push({
        sheet: sheetName,
        addr,
        value: String(v).trim(),
        formula: typeof formula === 'string' && formula.length > 0 ? formula.slice(0, MAX_FORMULA_CHARS) : null
      });
      if (errors.length >= maxErrors) return errors;
    }
  }
  return errors;
}

// Extract cell references from a formula string. Returns up to maxRefs items
// in the form {sheet, addr}. Skips refs inside string literals "...". Handles
// quoted sheet names with special chars ('Sources & Uses'!A1).
function extractFormulaCellRefs(formula, maxRefs = 5) {
  const out = [];
  if (typeof formula !== 'string' || formula.length === 0) return out;
  // Strip "..." string literals so we don't capture refs inside text
  const stripped = formula.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const re = /(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!\$?([A-Z]+)\$?(\d+)/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(stripped))) {
    const sheet = (m[1] || m[2] || '').replace(/''/g, "'");
    const addr = `${m[3]}${m[4]}`;
    const key = `${sheet}!${addr}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sheet, addr });
    if (out.length >= maxRefs) break;
  }
  return out;
}

async function scanWorkbookErrors({
  maxSheets = MAX_SHEETS_PER_SCAN_DEFAULT,
  maxCellsPerSheet = MAX_CELLS_PER_SHEET_DEFAULT,
  maxErrors = MAX_ERRORS_PER_REPORT_DEFAULT,
  enrichRefs = true,
  maxEnrichTotal = 50
} = {}) {
  if (typeof Excel === 'undefined') return [];
  return await Excel.run(async (ctx) => {
    const sheets = ctx.workbook.worksheets;
    sheets.load('items/name');
    await ctx.sync();
    const targetSheets = sheets.items.slice(0, maxSheets);
    const sheetRefs = [];
    const sheetByName = new Map();
    for (const sheet of targetSheets) {
      const used = sheet.getUsedRangeOrNullObject(true);
      used.load('values,formulas,address,rowCount,columnCount,cellCount');
      sheetRefs.push({ name: sheet.name, used });
      sheetByName.set(sheet.name, sheet);
    }
    await ctx.sync();
    const allErrors = [];
    for (const { name, used } of sheetRefs) {
      if (used.isNullObject) continue;
      const cellCount = Number(used.cellCount) || 0;
      if (cellCount > maxCellsPerSheet) continue;
      const errs = extractErrorsFromMatrix(
        name,
        used.address || `${name}!A1`,
        Array.isArray(used.values) ? used.values : [],
        Array.isArray(used.formulas) ? used.formulas : [],
        maxErrors - allErrors.length
      );
      allErrors.push(...errs);
      if (allErrors.length >= maxErrors) break;
    }

    // Enrichment pass: for each error with a formula, look up the cells it
    // references and report their current value. Lets the agent loop see
    // "PnL!B7 → #VALUE! (formula =Assumptions!B97) — Assumptions!B97 is
    // currently empty" instead of guessing which upstream cell it meant.
    // Bounded by maxEnrichTotal so a single scan can never explode into
    // hundreds of extra loads.
    if (enrichRefs && allErrors.length > 0) {
      const pendingLoads = [];
      const refsPerError = new Map();
      let totalEnrichLoads = 0;
      for (let i = 0; i < allErrors.length; i++) {
        const err = allErrors[i];
        if (!err.formula) continue;
        const refs = extractFormulaCellRefs(err.formula, 3);
        const usable = [];
        for (const ref of refs) {
          if (totalEnrichLoads >= maxEnrichTotal) break;
          const refSheet = sheetByName.get(ref.sheet);
          if (!refSheet) continue;
          try {
            const range = refSheet.getRange(ref.addr);
            range.load('values,formulas');
            pendingLoads.push({ errorIndex: i, ref, range });
            usable.push(ref);
            totalEnrichLoads++;
          } catch (_) {}
        }
        if (usable.length > 0) refsPerError.set(i, usable);
      }
      if (pendingLoads.length > 0) {
        await ctx.sync();
        for (const { errorIndex, ref, range } of pendingLoads) {
          const v = (((range.values || [])[0]) || [])[0];
          const f = (((range.formulas || [])[0]) || [])[0];
          if (!allErrors[errorIndex].refs) allErrors[errorIndex].refs = [];
          allErrors[errorIndex].refs.push({
            sheet: ref.sheet,
            addr: ref.addr,
            value: v == null || v === '' ? null : String(v).slice(0, 80),
            formula: typeof f === 'string' && f.length > 0 ? f.slice(0, 160) : null
          });
        }
      }
    }
    return allErrors;
  });
}

function isQueueIdle() {
  return isExcelQueueIdle(state.excelActionQueue);
}

async function tick() {
  if (scannerState.running) return;
  const cooldown = readKnob('EXCEL_HEALTH_COOLDOWN_MS', COOLDOWN_AFTER_BATCH_MS_DEFAULT);
  const interval = readKnob('EXCEL_HEALTH_INTERVAL_MS', SCAN_INTERVAL_MS_DEFAULT);
  const now = Date.now();
  if (now - scannerState.lastScanAt < interval) return;
  if (now - scannerState.lastBatchAt < cooldown) return;
  if (!isQueueIdle()) return;
  if (!scannerState.turnId) return;
  if (typeof scannerState.reporter !== 'function') return;

  scannerState.running = true;
  try {
    const errors = await scanWorkbookErrors();
    scannerState.scansRun += 1;
    scannerState.lastScanAt = Date.now();
    if (errors.length === 0) return;
    try {
      await scannerState.reporter({ turnId: scannerState.turnId, errors });
      scannerState.errorsReported += errors.length;
    } catch (reportErr) {
      addLog(`Health scan: invio report fallito: ${reportErr.message}`, 'warn');
    }
  } catch (err) {
    addLog(`Health scan: errore (${err.message}). Skip ciclo.`, 'warn');
  } finally {
    scannerState.running = false;
  }
}

function noteBatchActivity() {
  scannerState.lastBatchAt = Date.now();
}

function startHealthScanner({ turnId, reporter, intervalMs }) {
  stopHealthScanner();
  if (!turnId || typeof reporter !== 'function') return;
  scannerState.turnId = String(turnId);
  scannerState.reporter = reporter;
  scannerState.lastScanAt = 0;
  scannerState.lastBatchAt = Date.now();
  if (!batchSubscribed) {
    subscribeBatchFinished(noteBatchActivity);
    batchSubscribed = true;
  }
  const cadence = Math.max(1500, Math.floor((intervalMs || readKnob('EXCEL_HEALTH_TICK_MS', 5000))));
  scannerState.timer = setInterval(() => { tick(); }, cadence);
  if (typeof window !== 'undefined') {
    window.__excelHealthScanner = scannerState;
  }
}

function stopHealthScanner() {
  if (scannerState.timer) {
    clearInterval(scannerState.timer);
    scannerState.timer = null;
  }
  scannerState.turnId = null;
  scannerState.reporter = null;
}

export {
  startHealthScanner,
  stopHealthScanner,
  noteBatchActivity,
  scanWorkbookErrors,
  // exposed for tests
  extractErrorsFromMatrix,
  extractFormulaCellRefs,
  isErrorValue,
  parseBaseCellFromAddress,
  colNumberToA1
};
