'use strict';

// Keep the automatic startup context intentionally small. Deep reads should be
// explicit client-tool requests, not part of every prompt bootstrap.
const ACTIVE_PREVIEW_ROWS = 80;
const ACTIVE_PREVIEW_COLS = 24;
const OTHER_PREVIEW_ROWS = 12;
const OTHER_PREVIEW_COLS = 8;
const MAX_OTHER_SHEETS = 8;
const SELECTION_PREVIEW_ROWS = 40;
const SELECTION_PREVIEW_COLS = 16;
const MAX_FORMULA_PREVIEW_CELLS = 800;

async function getExcelContext() {
  try {
    return await Excel.run(async (context) => {
      const worksheets = context.workbook.worksheets;
      worksheets.load('items/name,items/position,items/visibility');
      const activeSheet = context.workbook.worksheets.getActiveWorksheet();
      activeSheet.load('name');
      const selectedRange = context.workbook.getSelectedRange();
      selectedRange.load('address,rowCount,columnCount,rowIndex,columnIndex');
      await context.sync();

      // Snapshot of every worksheet's used range
      let otherPreviewCount = 0;
      const sheetEntries = worksheets.items.map((ws) => {
        const usedRange = ws.getUsedRangeOrNullObject(true);
        usedRange.load('address,rowCount,columnCount,rowIndex,columnIndex');
        const isActive = ws.name === activeSheet.name;
        const includePreview = isActive || otherPreviewCount++ < MAX_OTHER_SHEETS;
        return { ws, usedRange, isActive, includePreview, previewRange: null, formulasRange: null, loadedFormulas: false };
      });

      // Selection preview (clipped on active sheet)
      const selectionPreviewRange = activeSheet.getRangeByIndexes(
        selectedRange.rowIndex,
        selectedRange.columnIndex,
        Math.min(selectedRange.rowCount, SELECTION_PREVIEW_ROWS),
        Math.min(selectedRange.columnCount, SELECTION_PREVIEW_COLS)
      );
      const selectionPreviewCells =
        Math.min(selectedRange.rowCount, SELECTION_PREVIEW_ROWS) *
        Math.min(selectedRange.columnCount, SELECTION_PREVIEW_COLS);
      const loadSelectionFormulas = selectionPreviewCells <= MAX_FORMULA_PREVIEW_CELLS;
      selectionPreviewRange.load(loadSelectionFormulas ? 'values,formulas' : 'values');

      await context.sync();

      // Build preview ranges for each sheet (active gets larger window + formulas)
      for (const entry of sheetEntries) {
        if (entry.usedRange.isNullObject) continue;
        if (!entry.includePreview) continue;
        const maxR = entry.isActive ? ACTIVE_PREVIEW_ROWS : OTHER_PREVIEW_ROWS;
        const maxC = entry.isActive ? ACTIVE_PREVIEW_COLS : OTHER_PREVIEW_COLS;
        const r = Math.min(entry.usedRange.rowCount, maxR);
        const c = Math.min(entry.usedRange.columnCount, maxC);
        entry.previewRange = entry.ws.getRangeByIndexes(
          entry.usedRange.rowIndex,
          entry.usedRange.columnIndex,
          r,
          c
        );
        const previewCells = r * c;
        // Load formulas for every sheet whose preview fits the budget — not
        // just the active one. The markdown context encoder shows the model
        // formulas side-by-side with computed values so it can catch
        // cross-sheet bugs (e.g. an upstream formula evaluating to text
        // when a number was expected). Non-active sheets use the smaller
        // OTHER_PREVIEW_ROWS×COLS window (12×8=96 cells) so they easily
        // stay under MAX_FORMULA_PREVIEW_CELLS.
        if (previewCells <= MAX_FORMULA_PREVIEW_CELLS) {
          entry.previewRange.load('values,formulas');
          entry.loadedFormulas = true;
        } else {
          entry.previewRange.load('values');
        }
      }
      await context.sync();

      const ctx = {
        activeSheet: activeSheet.name,
        workbookSheets: worksheets.items.map(ws => ws.name),
        sheetCount: worksheets.items.length,
        selectedRange: selectedRange.address,
        selectionSize: { rows: selectedRange.rowCount, columns: selectedRange.columnCount },
        selectedValues: selectionPreviewRange.values,
        selectedFormulas: loadSelectionFormulas ? selectionPreviewRange.formulas : [],
        selectedRangeTruncated:
          selectedRange.rowCount > SELECTION_PREVIEW_ROWS ||
          selectedRange.columnCount > SELECTION_PREVIEW_COLS,
        allSheetsData: {},
        sheetData: {} // alias consumed by analyzeWorkbookContext
      };

      // Limit number of "other" sheets included to keep context size bounded
      let otherCount = 0;
      for (const entry of sheetEntries) {
        const name = entry.ws.name;
        if (entry.usedRange.isNullObject) {
          ctx.allSheetsData[name] = {
            usedRange: null,
            rowCount: 0,
            columnCount: 0,
            preview: [],
            formulas: [],
            isActive: entry.isActive,
            empty: true
          };
          continue;
        }
        if (!entry.isActive) {
          otherCount++;
          if (otherCount > MAX_OTHER_SHEETS) {
            ctx.allSheetsData[name] = {
              usedRange: entry.usedRange.address,
              rowCount: entry.usedRange.rowCount,
              columnCount: entry.usedRange.columnCount,
              preview: [],
              omitted: true
            };
            continue;
          }
        }
        const previewVals = entry.previewRange ? entry.previewRange.values : [];
        const previewForm = entry.loadedFormulas && entry.previewRange ? entry.previewRange.formulas : [];
        const truncated =
          entry.usedRange.rowCount > (entry.isActive ? ACTIVE_PREVIEW_ROWS : OTHER_PREVIEW_ROWS) ||
          entry.usedRange.columnCount > (entry.isActive ? ACTIVE_PREVIEW_COLS : OTHER_PREVIEW_COLS);
        ctx.allSheetsData[name] = {
          usedRange: entry.usedRange.address,
          rowCount: entry.usedRange.rowCount,
          columnCount: entry.usedRange.columnCount,
          preview: previewVals,
          formulas: previewForm,
          isActive: entry.isActive,
          truncated
        };
        ctx.sheetData[name] = previewVals;
      }

      // Backward-compat fields (consumed by older callers / planner)
      const activeEntry = sheetEntries.find(e => e.isActive);
      if (activeEntry && !activeEntry.usedRange.isNullObject) {
        ctx.usedRange = activeEntry.usedRange.address;
        ctx.usedRangeSize = {
          rows: activeEntry.usedRange.rowCount,
          columns: activeEntry.usedRange.columnCount
        };
        ctx.usedRangeData = activeEntry.previewRange ? activeEntry.previewRange.values : [];
        if (
          activeEntry.usedRange.rowCount > ACTIVE_PREVIEW_ROWS ||
          activeEntry.usedRange.columnCount > ACTIVE_PREVIEW_COLS
        ) {
          ctx.usedRangeTruncated = true;
          ctx.totalRows = activeEntry.usedRange.rowCount;
          ctx.totalColumns = activeEntry.usedRange.columnCount;
        }
      }

      return ctx;
    });
  } catch (e) {
    return { error: e.message };
  }
}

export { getExcelContext };
