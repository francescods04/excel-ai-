'use strict';

const { colToNum, numToCol, parseAddr } = require('./actionSanitizer');

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

  for (const a of actions || []) {
    if (a.type === 'createSheet' && a.sheet) sheets.add(a.sheet);
    if (a.sheet) sheets.add(a.sheet);
    if (a.type === 'setCellRange' && a.cells) {
      const sh = a.sheet || a.sheetName;
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
          // For single-cell xsheet refs, warn if the target cell is empty in plan & context.
          if (!ref.col2 && !ref.row2) {
            const sheetCells = cellsBySheet.get(ref.sheet);
            const target = `${ref.col1}${ref.row1}`;
            if (sheetCells && !sheetCells.has(target)) {
              issues.push({
                severity: 'medium',
                kind: 'empty_xsheet_ref',
                location: `${currentSheet}!${addr}`,
                formula: spec.formula,
                detail: `references ${ref.sheet}!${target} which has no value in plan or context (will read 0)`,
              });
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

      // Detect division by hardcoded 0.
      if (/\/\s*0(?:[^.\d]|$)/.test(spec.formula)) {
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
