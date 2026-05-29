'use strict';

import { parseTargetReference } from './parseTarget.js';

const DEFAULT_SELECTION_PREVIEW_ROWS = 40;
const DEFAULT_SELECTION_PREVIEW_COLS = 16;
const DEFAULT_RANGE_MAX_ROWS = 200;
const DEFAULT_RANGE_MAX_COLS = 50;
const DEFAULT_CSV_MAX_ROWS = 500;
const DEFAULT_CSV_MAX_COLS = 80;
const HARD_RANGE_MAX_ROWS = 1200;
const HARD_RANGE_MAX_COLS = 160;
const HARD_LARGE_RANGE_MAX_ROWS = 3000;
const HARD_LARGE_RANGE_MAX_COLS = 240;

function isLargeReadAllowed(options = {}) {
  return options.allowLargeRead === true || options.allowLargeRead === 'true';
}

function positiveInt(value, fallback, hardMax) {
  const n = Number(value);
  const base = Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  return Math.max(1, Math.min(base, hardMax));
}

function getReadCaps(options = {}, defaults = {}) {
  const large = isLargeReadAllowed(options);
  const hardRows = large ? HARD_LARGE_RANGE_MAX_ROWS : HARD_RANGE_MAX_ROWS;
  const hardCols = large ? HARD_LARGE_RANGE_MAX_COLS : HARD_RANGE_MAX_COLS;
  return {
    maxRows: positiveInt(options.maxRows, defaults.maxRows, hardRows),
    maxCols: positiveInt(options.maxCols, defaults.maxCols, hardCols)
  };
}

function escapeCsvValue(val) {
  if (val == null) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function matrixToCsv(values) {
  return (values || []).map(row => row.map(escapeCsvValue).join(',')).join('\n');
}

function stripSheetPrefix(addr) {
  const s = String(addr || '').replace(/\$/g, '');
  return s.includes('!') ? s.split('!').pop() : s;
}

function isDefaultFill(c) { return !c || c === '' || String(c).toUpperCase() === '#FFFFFF'; }
function isDefaultFontColor(c) { return !c || c === '' || String(c).toUpperCase() === '#000000'; }
function isDefaultNumberFormat(f) { return !f || f === 'General'; }

async function worksheetExists(sheetName) {
  if (!sheetName) return false;
  return Excel.run(async (context) => {
    const worksheet = context.workbook.worksheets.getItemOrNullObject(sheetName);
    worksheet.load('name');
    await context.sync();
    return !worksheet.isNullObject;
  });
}

async function readWorkbookSnapshot(params) {
  const options = params || {};
  const maxRows = Number(options.maxRows) || 20;
  const maxCols = Number(options.maxCols) || 10;
  const includeFormulas = options.includeFormulas !== false;
  const includeNumberFormats = options.includeNumberFormats === true;
  const selectionRows = positiveInt(options.selectionMaxRows, DEFAULT_SELECTION_PREVIEW_ROWS, HARD_RANGE_MAX_ROWS);
  const selectionCols = positiveInt(options.selectionMaxCols, DEFAULT_SELECTION_PREVIEW_COLS, HARD_RANGE_MAX_COLS);

  return Excel.run(async (context) => {
    const worksheets = context.workbook.worksheets;
    worksheets.load('items/name');
    const activeSheet = context.workbook.worksheets.getActiveWorksheet();
    activeSheet.load('name');
    const selectedRange = context.workbook.getSelectedRange();
    selectedRange.load('address,rowCount,columnCount,rowIndex,columnIndex');
    await context.sync();

    const selectionPreviewRange = activeSheet.getRangeByIndexes(
      selectedRange.rowIndex,
      selectedRange.columnIndex,
      Math.min(selectedRange.rowCount, selectionRows),
      Math.min(selectedRange.columnCount, selectionCols)
    );
    selectionPreviewRange.load(includeFormulas ? 'values,formulas' : 'values');

    const sheetRefs = worksheets.items.map((sheet) => {
      const usedRange = sheet.getUsedRangeOrNullObject(true);
      usedRange.load('address,rowCount,columnCount,rowIndex,columnIndex');
      return { sheet, usedRange, previewRange: null };
    });
    await context.sync();

    for (const ref of sheetRefs) {
      if (ref.usedRange.isNullObject) continue;
      ref.previewRange = ref.sheet.getRangeByIndexes(
        ref.usedRange.rowIndex,
        ref.usedRange.columnIndex,
        Math.min(ref.usedRange.rowCount, maxRows),
        Math.min(ref.usedRange.columnCount, maxCols)
      );
      const loadProps = ['values'];
      if (includeFormulas) loadProps.push('formulas');
      if (includeNumberFormats) loadProps.push('numberFormat');
      ref.previewRange.load(loadProps.join(','));
    }
    await context.sync();

    return {
      activeSheet: activeSheet.name,
      workbookSheets: worksheets.items.map(ws => ws.name),
      selectedRange: selectedRange.address,
      selectionSize: { rows: selectedRange.rowCount, columns: selectedRange.columnCount },
      selectedValues: selectionPreviewRange.values,
      selectedFormulas: includeFormulas ? selectionPreviewRange.formulas : [],
      selectedRangeTruncated: selectedRange.rowCount > selectionRows || selectedRange.columnCount > selectionCols,
      sheets: sheetRefs.map(({ sheet, usedRange, previewRange }) => ({
        name: sheet.name,
        usedRange: usedRange.isNullObject ? null : usedRange.address,
        rowCount: usedRange.isNullObject ? 0 : usedRange.rowCount,
        columnCount: usedRange.isNullObject ? 0 : usedRange.columnCount,
        preview: usedRange.isNullObject || !previewRange ? [] : previewRange.values,
        formulas: usedRange.isNullObject || !previewRange || !includeFormulas ? [] : previewRange.formulas,
        numberFormat: usedRange.isNullObject || !previewRange || !includeNumberFormats ? [] : previewRange.numberFormat
      }))
    };
  });
}

async function readSheetSnapshot(params) {
  const options = params || {};
  const sheetName = options.sheet || options.sheetName;
  const maxRows = Number(options.maxRows) || 30;
  const maxCols = Number(options.maxCols) || 12;

  return Excel.run(async (context) => {
    const worksheet = sheetName
      ? context.workbook.worksheets.getItem(sheetName)
      : context.workbook.worksheets.getActiveWorksheet();
    worksheet.load('name');

    const usedRange = worksheet.getUsedRangeOrNullObject(true);
    usedRange.load('address,rowCount,columnCount,rowIndex,columnIndex');
    await context.sync();

    if (usedRange.isNullObject) {
      return {
        sheet: worksheet.name,
        usedRange: null,
        values: [],
        formulas: [],
        rowCount: 0,
        columnCount: 0
      };
    }

    const previewRange = worksheet.getRangeByIndexes(
      usedRange.rowIndex,
      usedRange.columnIndex,
      Math.min(usedRange.rowCount, maxRows),
      Math.min(usedRange.columnCount, maxCols)
    );
    previewRange.load('values,formulas');
    await context.sync();

    return {
      sheet: worksheet.name,
      usedRange: usedRange.address,
      values: previewRange.values,
      formulas: previewRange.formulas,
      rowCount: usedRange.rowCount,
      columnCount: usedRange.columnCount
    };
  });
}

async function readRangeSnapshot(params) {
  const options = params || {};
  const parsedTarget = parseTargetReference(options.target);
  const sheetName = options.sheet || options.sheetName || parsedTarget.sheetName;
  const caps = getReadCaps(options, { maxRows: DEFAULT_RANGE_MAX_ROWS, maxCols: DEFAULT_RANGE_MAX_COLS });
  const includeNumberFormats = options.includeNumberFormats !== false;

  return Excel.run(async (context) => {
    const worksheet = sheetName
      ? context.workbook.worksheets.getItem(sheetName)
      : context.workbook.worksheets.getActiveWorksheet();
    worksheet.load('name');
    let target = parsedTarget.rangeAddress || options.target;
    if (!target) {
      const selectedRange = context.workbook.getSelectedRange();
      selectedRange.load('address');
      await context.sync();
      target = selectedRange.address;
    }

    const range = worksheet.getRange(target);
    range.load('address,rowCount,columnCount');
    await context.sync();

    const rowsToRead = Math.min(range.rowCount, caps.maxRows);
    const colsToRead = Math.min(range.columnCount, caps.maxCols);
    const limitedRange = range.getCell(0, 0).getResizedRange(rowsToRead - 1, colsToRead - 1);
    const loadProps = ['address', 'values', 'formulas', 'rowCount', 'columnCount'];
    if (includeNumberFormats) loadProps.push('numberFormat');
    limitedRange.load(loadProps.join(','));
    await context.sync();

    return {
      sheet: worksheet.name,
      target: target,
      address: limitedRange.address,
      values: limitedRange.values,
      formulas: limitedRange.formulas,
      numberFormat: includeNumberFormats ? limitedRange.numberFormat : [],
      rowCount: rowsToRead,
      columnCount: colsToRead,
      totalRowCount: range.rowCount,
      totalColumnCount: range.columnCount,
      truncated: rowsToRead < range.rowCount || colsToRead < range.columnCount
    };
  });
}

// Reads the VISUAL format of a range so the agent can verify styling (plain reads
// only return values/formulas/numberFormat, never colors/bold/notes). Uses
// getCellProperties for true per-cell format (range.format.*.color collapses to ""
// when cells differ). Returns only non-default cells + notes to keep the payload small.
async function readFormatSummary(params) {
  const options = params || {};
  const parsedTarget = parseTargetReference(options.target);
  const sheetName = options.sheet || options.sheetName || parsedTarget.sheetName;
  const caps = getReadCaps(options, { maxRows: 50, maxCols: 26 });

  return Excel.run(async (context) => {
    const worksheet = sheetName
      ? context.workbook.worksheets.getItem(sheetName)
      : context.workbook.worksheets.getActiveWorksheet();
    worksheet.load('name');
    let target = parsedTarget.rangeAddress || options.target;
    if (!target) {
      const selectedRange = context.workbook.getSelectedRange();
      selectedRange.load('address');
      await context.sync();
      target = selectedRange.address;
    }

    const range = worksheet.getRange(target);
    range.load('address,rowCount,columnCount');
    await context.sync();

    const rowsToRead = Math.min(range.rowCount, caps.maxRows);
    const colsToRead = Math.min(range.columnCount, caps.maxCols);
    const limited = range.getCell(0, 0).getResizedRange(rowsToRead - 1, colsToRead - 1);
    limited.load('address');
    const props = limited.getCellProperties({
      address: true,
      format: { font: { color: true, bold: true }, fill: { color: true } },
      numberFormat: true
    });
    const comments = worksheet.comments;
    comments.load('items/cellAddress,items/content');
    await context.sync();

    const noteMap = {};
    for (const cm of comments.items) {
      const a = stripSheetPrefix(cm.cellAddress || '');
      if (a) noteMap[a] = String(cm.content || '').slice(0, 120);
    }

    const styled = [];
    const grid = props.value || [];
    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < (grid[r] || []).length; c++) {
        const cell = grid[r][c] || {};
        const fmt = cell.format || {};
        const font = fmt.font || {};
        const fill = fmt.fill || {};
        const addr = stripSheetPrefix(cell.address || '');
        const note = addr ? noteMap[addr] : undefined;
        const hasFill = !isDefaultFill(fill.color);
        const hasFontColor = !isDefaultFontColor(font.color);
        const hasNumFmt = !isDefaultNumberFormat(cell.numberFormat);
        if (!font.bold && !hasFill && !hasFontColor && !hasNumFmt && note === undefined) continue;
        const entry = { addr };
        if (hasFontColor) entry.fontColor = font.color;
        if (hasFill) entry.fillColor = fill.color;
        if (font.bold) entry.bold = true;
        if (hasNumFmt) entry.numberFormat = cell.numberFormat;
        if (note !== undefined) entry.note = note;
        styled.push(entry);
      }
    }

    return {
      sheet: worksheet.name,
      target: limited.address,
      rowCount: rowsToRead,
      columnCount: colsToRead,
      totalRowCount: range.rowCount,
      totalColumnCount: range.columnCount,
      truncated: rowsToRead < range.rowCount || colsToRead < range.columnCount,
      styledCellCount: styled.length,
      noteCountInSheet: Object.keys(noteMap).length,
      styledCells: styled
    };
  });
}

async function readRangeAsCsv(params) {
  const options = params || {};
  const parsedTarget = parseTargetReference(options.target);
  const sheetName = options.sheet || options.sheetName || parsedTarget.sheetName;
  const caps = getReadCaps(options, { maxRows: DEFAULT_CSV_MAX_ROWS, maxCols: DEFAULT_CSV_MAX_COLS });

  return Excel.run(async (context) => {
    const worksheet = sheetName
      ? context.workbook.worksheets.getItem(sheetName)
      : context.workbook.worksheets.getActiveWorksheet();
    worksheet.load('name');
    let target = parsedTarget.rangeAddress || options.target;
    if (!target) {
      const selectedRange = context.workbook.getSelectedRange();
      selectedRange.load('address');
      await context.sync();
      target = selectedRange.address;
    }

    const range = worksheet.getRange(target);
    range.load('address,rowCount,columnCount');
    await context.sync();

    const rowsToRead = Math.min(range.rowCount, caps.maxRows);
    const colsToRead = Math.min(range.columnCount, caps.maxCols);
    const limitedRange = range.getCell(0, 0).getResizedRange(rowsToRead - 1, colsToRead - 1);
    limitedRange.load('values');
    await context.sync();

    const csv = matrixToCsv(limitedRange.values);

    return {
      sheet: worksheet.name,
      target: target,
      csv: csv,
      rowCount: rowsToRead,
      columnCount: colsToRead,
      totalRowCount: range.rowCount,
      totalColumnCount: range.columnCount,
      truncated: rowsToRead < range.rowCount || colsToRead < range.columnCount
    };
  });
}

async function readNamedRanges(params) {
  return Excel.run(async (context) => {
    const names = context.workbook.names;
    names.load('items');
    await context.sync();

    const result = [];
    for (const name of names.items) {
      name.load('name,comment,refersTo');
    }
    await context.sync();

    for (const name of names.items) {
      result.push({
        name: name.name,
        refersTo: name.refersTo,
        comment: name.comment || ''
      });
    }
    return result;
  });
}

// Batch multiple range reads into a single Excel.run() context (Claude/Anthropic pattern)
async function readMultiRangeBatch(requests) {
  if (!requests || requests.length === 0) return [];
  return Excel.run(async (context) => {
    const sheetProxies = new Map();
    const rangeProxies = [];

    // First pass: resolve all sheets and create range proxies
    for (const req of requests) {
      const sheetName = req.sheet || req.sheetName;
      if (!sheetProxies.has(sheetName || '__active__')) {
        const worksheet = sheetName
          ? context.workbook.worksheets.getItemOrNullObject(sheetName)
          : context.workbook.worksheets.getActiveWorksheet();
        worksheet.load('name');
        sheetProxies.set(sheetName || '__active__', worksheet);
      }
    }
    await context.sync();

    // Second pass: create all range proxies and load only metadata first.
    for (const req of requests) {
      const sheetName = req.sheet || req.sheetName || '__active__';
      const worksheet = sheetProxies.get(sheetName);
      if (!worksheet || worksheet.isNullObject) {
        rangeProxies.push({
          requestId: req.id,
          error: `Sheet "${req.sheet || 'active'}" not found`,
          data: null
        });
        continue;
      }

      const isCsv = req.format === 'csv';
      let target;
      try {
        target = req.target || req.range;
        if (!target) throw new Error('Range target is required for batched read');
        const range = worksheet.getRange(target);
        range.load('address,rowCount,columnCount');
        rangeProxies.push({
          requestId: req.id,
          worksheet,
          range,
          isCsv,
          sheetName: worksheet.name || sheetName,
          target,
          includeNumberFormats: req.includeNumberFormats !== false,
          caps: getReadCaps(req, isCsv
            ? { maxRows: DEFAULT_CSV_MAX_ROWS, maxCols: DEFAULT_CSV_MAX_COLS }
            : { maxRows: DEFAULT_RANGE_MAX_ROWS, maxCols: DEFAULT_RANGE_MAX_COLS })
        });
      } catch (err) {
        rangeProxies.push({
          requestId: req.id,
          error: `Invalid range "${target}": ${err.message}`,
          data: null
        });
      }
    }
    await context.sync();

    // Third pass: load only clipped ranges. This avoids pulling huge ranges into
    // the Excel WebView before applying maxRows/maxCols.
    const limitedProxies = [];
    for (const proxy of rangeProxies) {
      if (proxy.error || !proxy.range) continue;
      const rowsToRead = Math.min(proxy.range.rowCount, proxy.caps.maxRows);
      const colsToRead = Math.min(proxy.range.columnCount, proxy.caps.maxCols);
      const limitedRange = proxy.range.getCell(0, 0).getResizedRange(rowsToRead - 1, colsToRead - 1);
      if (proxy.isCsv) {
        limitedRange.load('values');
      } else {
        const loadProps = ['address', 'values', 'formulas'];
        if (proxy.includeNumberFormats) loadProps.push('numberFormat');
        limitedRange.load(loadProps.join(','));
      }
      limitedProxies.push({ ...proxy, limitedRange, rowsToRead, colsToRead });
    }
    if (limitedProxies.length > 0) {
      await context.sync();
    }

    // Fourth pass: build results from loaded clipped proxies
    const results = [];
    const limitedById = new Map(limitedProxies.map(proxy => [proxy.requestId, proxy]));
    for (const proxy of rangeProxies) {
      if (proxy.error) {
        results.push({ requestId: proxy.requestId, error: proxy.error });
        continue;
      }
      if (!proxy.range) continue;

      const loaded = limitedById.get(proxy.requestId);
      if (!loaded) continue;
      const { range, isCsv, sheetName, target, limitedRange, rowsToRead, colsToRead, includeNumberFormats } = loaded;

      if (isCsv) {
        const totalRows = range.rowCount;
        const totalCols = range.columnCount;
        const csv = matrixToCsv(limitedRange.values);
        results.push({
          requestId: proxy.requestId,
          data: {
            sheet: sheetName,
            target: target,
            csv: csv,
            rowCount: rowsToRead,
            columnCount: colsToRead,
            totalRowCount: totalRows,
            totalColumnCount: totalCols,
            truncated: rowsToRead < totalRows || colsToRead < totalCols
          }
        });
      } else {
        // Snapshot format
        results.push({
          requestId: proxy.requestId,
          data: {
            sheet: sheetName,
            target: limitedRange.address,
            values: limitedRange.values,
            formulas: limitedRange.formulas,
            numberFormat: includeNumberFormats ? limitedRange.numberFormat : [],
            rowCount: rowsToRead,
            columnCount: colsToRead,
            totalRowCount: range.rowCount,
            totalColumnCount: range.columnCount,
            truncated: rowsToRead < range.rowCount || colsToRead < range.columnCount
          }
        });
      }
    }
    return results;
  });
}

export { worksheetExists, readWorkbookSnapshot, readSheetSnapshot, readRangeSnapshot, readRangeAsCsv, readNamedRanges, readMultiRangeBatch, readFormatSummary };
