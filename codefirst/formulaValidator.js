'use strict';

const { numToCol } = require('./actionSanitizer');

// Validate that formulas in setCellRange actions reference cells/sheets that
// actually exist in the workbook (or will exist after the actions execute).
// Returns issues without modifying the actions — caller decides whether to
// retry, repair, or accept.

function extractCellRefs(formula) {
  if (!formula || typeof formula !== 'string') return [];
  const refs = [];
  // Cross-sheet refs:  SheetName!A1  or  'Sheet Name'!A1  or  SheetName!A1:B2
  const reXSheet = /(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))!(\$?)([A-Z]+)(\$?)(\d+)(?::(\$?)([A-Z]+)(\$?)(\d+))?/g;
  let m;
  while ((m = reXSheet.exec(formula)) !== null) {
    const sheet = m[1] || m[2];
    const col1 = m[4], row1 = Number(m[6]);
    const col2 = m[8] || null, row2 = m[10] ? Number(m[10]) : null;
    refs.push({ kind: 'xsheet', sheet, col1, row1, col2, row2, raw: m[0] });
  }
  // Strip cross-sheet matches before scanning local refs to avoid double counting.
  const localOnly = formula.replace(reXSheet, '');
  const reLocal = /(?<![A-Za-z!])(\$?)([A-Z]+)(\$?)(\d+)(?:!|\(|:)?/g;
  while ((m = reLocal.exec(localOnly)) !== null) {
    const col = m[2], row = Number(m[4]);
    refs.push({ kind: 'local', col, row, raw: m[0] });
  }
  return refs;
}

function buildWorkbookIndex(actions, existingContext = null) {
  // Map sheet name → Set of addresses written or readable.
  // Includes: cells from setCellRange actions, cells from prior context.
  const cellsBySheet = new Map();
  const sheets = new Set();

  if (existingContext && Array.isArray(existingContext.sheets)) {
    for (const s of existingContext.sheets) {
      sheets.add(s.name);
      const cells = cellsBySheet.get(s.name) || new Set();
      const preview = s.preview || [];
      for (let r = 0; r < preview.length; r++) {
        const row = preview[r] || [];
        for (let c = 0; c < row.length; c++) {
          if (row[c] !== '' && row[c] !== null && row[c] !== undefined) {
            cells.add(`${numToCol(c + 1)}${r + 1}`);
          }
        }
      }
      cellsBySheet.set(s.name, cells);
    }
  }

  // Also register sheets from context workbookSheets / allSheets
  if (existingContext) {
    const contextSheets = existingContext.workbookSheets
      || existingContext.allSheets
      || (existingContext.allSheetsData ? Object.keys(existingContext.allSheetsData) : null);
    if (Array.isArray(contextSheets)) {
      for (const s of contextSheets) sheets.add(String(s));
    }
  }

  for (const a of actions || []) {
    if (a.type === 'createSheet' && a.sheet) sheets.add(a.sheet);
    const sh = a.sheet || a.sheetName;
    if (sh) sheets.add(sh);
    if (a.type === 'setCellRange' && a.cells) {
      if (!sh) continue;
      const cells = cellsBySheet.get(sh) || new Set();
      for (const addr of Object.keys(a.cells)) {
        const bare = addr.includes('!') ? addr.split('!').pop() : addr;
        cells.add(bare.toUpperCase());
      }
      cellsBySheet.set(sh, cells);
    }
  }
  return { sheets, cellsBySheet };
}

function validateFormulas(actions, existingContext = null) {
  const { sheets, cellsBySheet } = buildWorkbookIndex(actions, existingContext);
  const issues = [];

  for (const a of actions || []) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    const currentSheet = a.sheet || a.sheetName;
    for (const [addr, spec] of Object.entries(a.cells)) {
      if (!spec || typeof spec !== 'object' || !spec.formula) continue;
      const refs = extractCellRefs(spec.formula);
      for (const ref of refs) {
        if (ref.kind === 'xsheet') {
          if (!sheets.has(ref.sheet)) {
            issues.push({
              severity: 'critical',
              kind: 'unknown_sheet_ref',
              location: `${currentSheet}!${addr}`,
              formula: spec.formula,
              detail: `references sheet "${ref.sheet}" which is never created`,
            });
            continue;
          }
          // Warn if target cell(s) are empty in plan & context, regardless of single-cell or range.
          const sheetCells = cellsBySheet.get(ref.sheet);
          if (sheetCells) {
            if (!ref.col2 && !ref.row2) {
              const target = `${ref.col1}${ref.row1}`;
              if (!sheetCells.has(target)) {
                issues.push({
                  severity: 'medium',
                  kind: 'empty_xsheet_ref',
                  location: `${currentSheet}!${addr}`,
                  formula: spec.formula,
                  detail: `references ${ref.sheet}!${target} which has no value in plan or context (will read 0)`,
                });
              }
            } else if (ref.col2 && ref.row2) {
              // Range ref: check if ALL terminals are empty
              const allEmpty = !sheetCells.has(`${ref.col1}${ref.row1}`)
                && !sheetCells.has(`${ref.col2}${ref.row2}`);
              if (allEmpty && sheetCells.size > 0) {
                issues.push({
                  severity: 'medium',
                  kind: 'empty_xsheet_range_ref',
                  location: `${currentSheet}!${addr}`,
                  formula: spec.formula,
                  detail: `references range ${ref.sheet}!${ref.col1}${ref.row1}:${ref.col2}${ref.row2} whose endpoints have no value in plan or context`,
                });
              }
            }
          }
        }
      }

      // Detect circular self-references.
      const localRefs = refs.filter(r => r.kind === 'local');
      const bareAddr = addr.toUpperCase();
      for (const lr of localRefs) {
        const refAddr = `${lr.col}${lr.row}`;
        if (refAddr === bareAddr) {
          issues.push({
            severity: 'critical',
            kind: 'self_reference',
            location: `${currentSheet}!${addr}`,
            formula: spec.formula,
            detail: `formula references its own cell ${refAddr}`,
          });
        }
      }

      // Detect cross-sheet self-references (e.g. Sheet1!A1 = Sheet1!A1 + 1)
      const xsheetRefs = refs.filter(r => r.kind === 'xsheet');
      for (const xr of xsheetRefs) {
        if (!xr.col2 && !xr.row2 && xr.sheet === currentSheet) {
          const target = `${xr.col1}${xr.row1}`;
          if (target === bareAddr) {
            issues.push({
              severity: 'critical',
              kind: 'self_reference_xsheet',
              location: `${currentSheet}!${addr}`,
              formula: spec.formula,
              detail: `cross-sheet formula references its own cell via ${xr.sheet}!${target}`,
            });
          }
        }
      }

      // Detect division by hardcoded 0, 0.0, .0 (handles /0, /0.0, /.0, /(0), / (0.0), etc.)
      if (/\/\s*\(?\s*\.?0+(?:\.0+)?(?:\s*(?:\)|[^.\w]|$))/.test(spec.formula)) {
        issues.push({
          severity: 'high',
          kind: 'div_by_zero',
          location: `${currentSheet}!${addr}`,
          formula: spec.formula,
          detail: 'division by literal 0',
        });
      }
    }
  }

  return issues;
}

module.exports = { validateFormulas, extractCellRefs, buildWorkbookIndex };
