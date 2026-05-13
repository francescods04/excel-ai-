'use strict';

import { parseTargetReference } from './parseTarget.js';

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

  return Excel.run(async (context) => {
    const worksheets = context.workbook.worksheets;
    worksheets.load('items/name');
    const activeSheet = context.workbook.worksheets.getActiveWorksheet();
    activeSheet.load('name');
    const selectedRange = context.workbook.getSelectedRange();
    selectedRange.load('address,values,formulas,rowCount,columnCount');
    await context.sync();

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
      selectedValues: selectedRange.values,
      selectedFormulas: selectedRange.formulas,
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
    range.load('address,values,formulas,rowCount,columnCount,numberFormat');
    await context.sync();

    return {
      sheet: worksheet.name,
      target: target,
      address: range.address,
      values: range.values,
      formulas: range.formulas,
      numberFormat: range.numberFormat,
      rowCount: range.rowCount,
      columnCount: range.columnCount
    };
  });
}

async function readRangeAsCsv(params) {
  const options = params || {};
  const parsedTarget = parseTargetReference(options.target);
  const sheetName = options.sheet || options.sheetName || parsedTarget.sheetName;
  const maxRows = Number(options.maxRows) || 0; // 0 = no limit (read all rows in range)

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
    range.load('values,rowCount,columnCount');
    await context.sync();

    const rowsToRead = maxRows > 0 ? Math.min(range.rowCount, maxRows) : range.rowCount;
    let values = range.values;
    if (rowsToRead < range.rowCount) {
      const limitedRange = worksheet.getRange(target).getCell(0, 0).getResizedRange(rowsToRead - 1, range.columnCount - 1);
      limitedRange.load('values');
      await context.sync();
      values = limitedRange.values;
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
      sheet: worksheet.name,
      target: target,
      csv: csv,
      rowCount: rowsToRead,
      columnCount: range.columnCount,
      truncated: rowsToRead < range.rowCount
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

    // Second pass: create all range proxies and load data
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
        const range = worksheet.getRange(target);
        if (isCsv) {
          range.load('values,rowCount,columnCount');
        } else {
          range.load('address,values,formulas,rowCount,columnCount,numberFormat');
        }
        rangeProxies.push({
          requestId: req.id,
          worksheet,
          range,
          isCsv,
          sheetName: worksheet.name || sheetName,
          target,
          maxRows: req.maxRows || (isCsv ? 0 : 100) // 0 = no limit
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

    // Third pass: build results from loaded proxies
    const results = [];
    for (const proxy of rangeProxies) {
      if (proxy.error) {
        results.push({ requestId: proxy.requestId, error: proxy.error });
        continue;
      }
      if (!proxy.range) continue;

      const { range, isCsv, sheetName, target, maxRows } = proxy;

      if (isCsv) {
        const totalRows = range.rowCount;
        const rowsToRead = maxRows > 0 ? Math.min(totalRows, maxRows) : totalRows;
        let values = range.values;
        if (rowsToRead < totalRows) {
          const limitedRange = proxy.worksheet.getRange(target).getCell(0, 0).getResizedRange(rowsToRead - 1, range.columnCount - 1);
          limitedRange.load('values');
          await context.sync();
          values = limitedRange.values;
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
        results.push({
          requestId: proxy.requestId,
          data: {
            sheet: sheetName,
            target: target,
            csv: csv,
            rowCount: rowsToRead,
            columnCount: range.columnCount,
            truncated: rowsToRead < totalRows
          }
        });
      } else {
        // Snapshot format
        const finalRows = maxRows > 0 ? Math.min(range.rowCount, maxRows) : range.rowCount;
        let values = range.values;
        let formulas = range.formulas;
        if (finalRows < range.rowCount) {
          const limitedRange = proxy.worksheet.getRange(target).getCell(0, 0).getResizedRange(finalRows - 1, range.columnCount - 1);
          limitedRange.load('values,formulas');
          await context.sync();
          values = limitedRange.values;
          formulas = limitedRange.formulas;
        }
        results.push({
          requestId: proxy.requestId,
          data: {
            sheet: sheetName,
            target: range.address,
            values: values,
            formulas: formulas,
            numberFormat: range.numberFormat,
            rowCount: finalRows,
            columnCount: range.columnCount
          }
        });
      }
    }
    return results;
  });
}

export { worksheetExists, readWorkbookSnapshot, readSheetSnapshot, readRangeSnapshot, readRangeAsCsv, readNamedRanges, readMultiRangeBatch };
