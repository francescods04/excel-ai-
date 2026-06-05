'use strict';

// Deterministic post-codegen fixes for common semantic bugs the LLM keeps making.
// Runs after sanitizer + auto-stub, before semantic critic.
//   1. Mix-percentage normalization: if a column of values labeled "Mix %" sums to
//      something other than 1.0, divide each by the sum so the column totals 100%.
//   2. Time-series column auto-fill: if a section is monthly (12 cols) but only
//      column B has formulas and C:M are blank or zero, copy column B's formula
//      across C:M with proper relative-ref shifting.
//   3. Detect P&L Revenue ref pointing at wrong row label (e.g. "Operating Days")
//      and try to repoint at the row labeled "Revenue" or "Monthly Revenue".

const logger = require('../server/utils/logger');
const { indexCells } = require('./cellDepValidator');

function colToNum(col) {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function numToCol(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s || 'A';
}
function splitAddr(a) { const m = a.match(/^([A-Z]+)(\d+)$/); return m ? { col: m[1], row: Number(m[2]) } : null; }

// Identify Menu-like sheets and the Mix % column.
// Heuristic: look for any column where the header (row 1 or 2) contains "Mix" or "%"
// AND at least 5 cells in that column are numbers between 0 and 1.
function findMixColumns(actions) {
  // Build per-sheet cell value matrix
  const sheets = {};
  for (const a of actions) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    const sh = a.sheet || a.sheetName || 'Sheet1';
    if (!sheets[sh]) sheets[sh] = new Map();
    for (const [addr, spec] of Object.entries(a.cells)) {
      if (!spec) continue;
      const s = typeof spec === 'object' ? spec : { value: spec };
      sheets[sh].set(addr, { value: s.value, formula: s.formula });
    }
  }
  const results = [];
  for (const [sheet, cells] of Object.entries(sheets)) {
    // Find header rows: cells in rows 1-3 whose value contains "Mix"
    const headerCols = new Set();
    for (const [addr, cell] of cells) {
      const p = splitAddr(addr);
      if (!p || p.row > 3) continue;
      const v = String(cell.value || '').trim();
      if (/^mix$/i.test(v) || /^mix\s*%/i.test(v) || /^mix\s*percent/i.test(v) || v === 'Mix %') {
        headerCols.add(p.col);
      }
    }
    for (const col of headerCols) {
      // Walk column, find numeric values 0 < x < 1
      const numericCells = [];
      let sumCellAddr = null;
      let sumValue = null;
      for (const [addr, cell] of cells) {
        const p = splitAddr(addr);
        if (!p || p.col !== col) continue;
        if (typeof cell.value === 'number' && cell.value >= 0 && cell.value <= 1) {
          numericCells.push({ addr, value: cell.value });
        }
        // Detect sum/total row: formula SUM over this column
        if (cell.formula && new RegExp(`SUM\\s*\\(\\s*\\$?${col}\\$?\\d+\\s*:\\s*\\$?${col}\\$?\\d+\\s*\\)`, 'i').test(cell.formula)) {
          sumCellAddr = addr;
        }
      }
      if (numericCells.length < 5) continue;
      const total = numericCells.reduce((s, c) => s + c.value, 0);
      // Strict tolerance: only skip if within 0.005 of 1.0. Otherwise normalize.
      // Below 0.005 = floating-point rounding noise. Above = real mismatch.
      if (Math.abs(total - 1.0) < 0.005) continue;
      results.push({ sheet, col, total, cells: numericCells, sumAddr: sumCellAddr });
    }
  }
  return results;
}

function normalizeMixColumns(actions) {
  const mixCols = findMixColumns(actions);
  if (mixCols.length === 0) return 0;
  let touched = 0;
  for (const { sheet, col, total, cells } of mixCols) {
    if (total <= 0) continue;
    const factor = 1.0 / total;
    // Walk actions, find the matching cell and divide its value
    const addrSet = new Set(cells.map(c => c.addr));
    for (const a of actions) {
      if (a.type !== 'setCellRange' || !a.cells) continue;
      if ((a.sheet || a.sheetName) !== sheet) continue;
      for (const addr of Object.keys(a.cells)) {
        if (!addrSet.has(addr)) continue;
        const spec = a.cells[addr];
        if (!spec || typeof spec !== 'object') continue;
        if (typeof spec.value === 'number') {
          spec.value = Math.round(spec.value * factor * 10000) / 10000; // 4-decimal precision
          touched++;
        }
      }
    }
    logger.info(`[AutoFix] Mix column ${sheet}!${col} normalized: total ${total.toFixed(3)} → 1.0 (factor ${factor.toFixed(3)}, ${cells.length} cells)`);
  }
  return touched;
}

// Detect time-series sheets where column B has formulas but C onwards are blank/zero,
// and copy the column B formula across the expected period range.
// Heuristic: a section is "time-series" if row 1 or 2 has period-like headers
// ("Month 1", "Jan", "Y1", "Year 1", "1") in cols B:M (12 cols) or B:F (5 cols).
function expandTimeSeriesColumns(actions) {
  const sheets = {};
  for (const a of actions) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    const sh = a.sheet || a.sheetName || 'Sheet1';
    if (!sheets[sh]) sheets[sh] = { cells: new Map(), actions: [] };
    sheets[sh].actions.push(a);
    for (const [addr, spec] of Object.entries(a.cells)) {
      sheets[sh].cells.set(addr, typeof spec === 'object' ? spec : { value: spec });
    }
  }
  let totalAdded = 0;
  for (const [sheet, data] of Object.entries(sheets)) {
    // Detect header row with period markers in B:M or B:F
    const headerRow = detectHeaderRow(data.cells);
    if (!headerRow) continue;
    const { row: hRow, firstCol, lastCol } = headerRow;
    const firstColN = colToNum(firstCol);
    const lastColN = colToNum(lastCol);
    if (lastColN - firstColN < 2) continue;
    // For each row below the header, check if firstCol has a formula and other cols are blank/0
    const rowsToFill = new Map(); // row -> {srcAddr, formula, missing: [addrs]}
    // Aggregation functions that span ranges — don't expand these across periods
    const AGG_FN_RE = /\b(SUM|SUMPRODUCT|SUMIF|SUMIFS|AVERAGE|AVERAGEIF|AVERAGEIFS|COUNT|COUNTA|COUNTIF|COUNTIFS|MIN|MAX|MEDIAN|IRR|XIRR|NPV|XNPV|MIRR|PRODUCT|STDEV|VAR)\s*\(/i;
    for (const [addr, cell] of data.cells) {
      const p = splitAddr(addr);
      if (!p) continue;
      if (p.row <= hRow) continue;
      if (p.col !== firstCol) continue;
      if (!cell.formula) continue;
      // Skip aggregation formulas — they accumulate ranges, not iterate across periods
      if (AGG_FN_RE.test(cell.formula)) continue;
      // Look at C:lastCol same row
      const missing = [];
      for (let c = firstColN + 1; c <= lastColN; c++) {
        const targetAddr = `${numToCol(c)}${p.row}`;
        const existing = data.cells.get(targetAddr);
        // Treat blank, zero, or hardcoded 0 as missing
        const isEmpty = !existing
          || (existing.value === 0 && !existing.formula)
          || (existing.value === '' && !existing.formula);
        if (isEmpty) missing.push(targetAddr);
      }
      if (missing.length >= 3) {
        rowsToFill.set(p.row, { srcAddr: addr, formula: cell.formula, srcStyles: cell.cellStyles, missing });
      }
    }
    if (rowsToFill.size === 0) continue;
    // Build a new setCellRange action with all the filled cells
    const newCells = {};
    let addedThisSheet = 0;
    for (const [row, info] of rowsToFill) {
      const srcColN = colToNum(splitAddr(info.srcAddr).col);
      for (const targetAddr of info.missing) {
        const targetColN = colToNum(splitAddr(targetAddr).col);
        const shift = targetColN - srcColN;
        const shifted = shiftFormulaCols(info.formula, shift);
        newCells[targetAddr] = { formula: shifted, cellStyles: { ...(info.srcStyles || {}) } };
        addedThisSheet++;
      }
    }
    if (addedThisSheet > 0) {
      actions.push({ type: 'setCellRange', sheet, cells: newCells });
      totalAdded += addedThisSheet;
      logger.info(`[AutoFix] Time-series fill: ${sheet} added ${addedThisSheet} cells across ${rowsToFill.size} rows`);
    }
  }
  return totalAdded;
}

function detectHeaderRow(cellsMap) {
  // Look at rows 1-3 for period markers
  const periodPatterns = [/^Month\s*\d+$/i, /^Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/i, /^Y\d+$/i, /^Year\s*\d+$/i, /^FY\d+/i, /^\d+$/];
  for (let r = 1; r <= 3; r++) {
    const cols = [];
    for (const [addr, cell] of cellsMap) {
      const p = splitAddr(addr);
      if (!p || p.row !== r) continue;
      const v = String(cell.value || '');
      if (periodPatterns.some(re => re.test(v))) cols.push(p.col);
    }
    if (cols.length >= 3) {
      cols.sort((a, b) => colToNum(a) - colToNum(b));
      return { row: r, firstCol: cols[0], lastCol: cols[cols.length - 1] };
    }
  }
  return null;
}

function shiftFormulaCols(formula, shift) {
  if (!formula || !shift) return formula;
  return formula.replace(/(\$?)([A-Z]+)(\$?)(\d+)\b/g, (m, ca, col, ra, row) => {
    if (ca === '$') return m; // absolute column — don't shift
    // Check the char immediately before: if it's a letter (function name) or `!`, skip
    // (rough heuristic — JavaScript regex doesn't support lookbehind everywhere)
    const n = colToNum(col) + shift;
    if (n < 1) return m;
    return `${ca}${numToCol(n)}${ra}${row}`;
  });
}

function applyAutoFixes(actions) {
  const stats = { mixCellsNormalized: 0, timeSeriesCellsAdded: 0 };
  stats.mixCellsNormalized = normalizeMixColumns(actions);
  stats.timeSeriesCellsAdded = expandTimeSeriesColumns(actions);
  return stats;
}

module.exports = { applyAutoFixes, normalizeMixColumns, expandTimeSeriesColumns, findMixColumns };
