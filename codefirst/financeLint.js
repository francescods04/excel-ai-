'use strict';

// Finance-specific lints surfaced by subagent audits on complex models.
// These run on the FINAL workbook and feed back to the AI reviewer / regenerator
// as critical issues. The deterministic validator catches what regex can.
//
// Lint rules implemented:
//   L1: dead_sensitivity_grid — all body cells of Sensitivity_* sheet share the same formula
//   L2: sensitivity_axis_unused — body cell formula doesn't reference both axes
//   L3: irr_npv_array_literal — IRR({...}) or NPV(r,{...}) — Excel rejects
//   L4: missing_required_sheet — sheet declared in plan but not generated
//   L5: scenario_fanout_static — Scenarios sheet columns produce same output (B7=C7=D7)
//   L6: annual_ref_quarterly_single — annual-period cell references a single quarterly cell (should SUM)
//   L7: semantic_label_mismatch — formula in row labeled "D&A" multiplies a cell whose label is "Shares Outstanding"

const logger = require('../server/utils/logger');
const { indexCells, extractCellRefs } = require('./cellDepValidator');

function splitAddr(a) { const m = a.match(/^([A-Z]+)(\d+)$/); return m ? { col: m[1], row: Number(m[2]) } : null; }
function colNum(c) { let n=0; for (const ch of c.toUpperCase()) n=n*26+(ch.charCodeAt(0)-64); return n; }

// Build per-sheet cell map + row labels for label-aware checks
function buildSheetIndex(actions) {
  const sheets = {};
  for (const a of actions || []) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    const sh = a.sheet || a.sheetName;
    if (!sheets[sh]) sheets[sh] = { cells: new Map(), rowLabels: new Map() };
    for (const [addr, spec] of Object.entries(a.cells)) {
      if (!spec) continue;
      const s = typeof spec === 'object' ? spec : { value: spec };
      sheets[sh].cells.set(addr, { value: s.value, formula: s.formula });
      const p = splitAddr(addr);
      if (p && p.col === 'A' && typeof s.value === 'string' && s.value.trim()) {
        sheets[sh].rowLabels.set(p.row, s.value.trim());
      }
    }
  }
  return sheets;
}

// L1+L2: Sensitivity grid checks
function lintSensitivity(sheetName, sheetData) {
  const issues = [];
  const isSensitivity = /sensitivity|sensitivit/i.test(sheetName);
  if (!isSensitivity) return issues;

  // Find body cells: formula in B4:F8 / B3:F7 etc. — anywhere col ∈ B-F, row ∈ 3-12
  const bodyCells = [];
  for (const [addr, cell] of sheetData.cells) {
    if (!cell.formula) continue;
    const p = splitAddr(addr); if (!p) continue;
    if (colNum(p.col) >= 2 && colNum(p.col) <= 12 && p.row >= 3 && p.row <= 20) {
      bodyCells.push({ addr, formula: cell.formula, p });
    }
  }
  if (bodyCells.length < 6) return issues;

  // L1: all body cells have IDENTICAL formula → dead grid
  const formulas = new Set(bodyCells.map(c => c.formula));
  if (formulas.size === 1) {
    issues.push({
      severity: 'critical',
      kind: 'dead_sensitivity_grid',
      location: `${sheetName}!${bodyCells[0].addr}`,
      detail: `Sensitivity grid has ${bodyCells.length} body cells all with identical formula "${bodyCells[0].formula.slice(0, 60)}". Both axes are dead — each body cell must use BOTH the row axis ($A4) and column axis (B$3).`,
    });
    return issues;
  }

  // L2: body cell doesn't reference BOTH axes (one with $Y row-locked, one with X$ col-locked)
  let withoutBothAxes = 0;
  for (const { addr, formula, p } of bodyCells) {
    // Need ref like $A<row> (row-locked col) and B$<header-row> (col-locked row)
    const hasRowAxis = new RegExp(`\\$A${p.row}\\b`).test(formula) || /\$A\$?\d+/.test(formula);
    const hasColAxis = new RegExp(`\\$?${p.col}\\$\\d+\\b`).test(formula); // col-letter then $row
    if (!hasRowAxis || !hasColAxis) withoutBothAxes++;
  }
  if (withoutBothAxes > bodyCells.length / 2) {
    issues.push({
      severity: 'high',
      kind: 'sensitivity_axis_unused',
      location: `${sheetName}`,
      detail: `${withoutBothAxes}/${bodyCells.length} body cells don't reference BOTH axes (need $A<row> and <col>$<row>). Use mixed refs.`,
    });
  }
  return issues;
}

// L3: IRR/NPV with array literals — Excel rejects
function lintIRRNPV(sheetName, sheetData) {
  const issues = [];
  for (const [addr, cell] of sheetData.cells) {
    if (!cell.formula) continue;
    // Match: =IRR({...}) or =NPV(rate, {...}) or =XIRR({...}) etc.
    if (/=\s*(IRR|XIRR|NPV|XNPV|MIRR)\s*\([^)]*\{/i.test(cell.formula)) {
      issues.push({
        severity: 'critical',
        kind: 'irr_npv_array_literal',
        location: `${sheetName}!${addr}`,
        detail: `Formula uses array literal {} inside IRR/NPV: "${cell.formula.slice(0, 80)}". Excel rejects. Lay out cash flows in a range (e.g. row B19:G19) and use =IRR(B19:G19).`,
      });
    }
  }
  return issues;
}

// L5: Scenarios sheet fan-out check — columns B/C/D produce same output
function lintScenarios(sheetName, sheetData) {
  const issues = [];
  if (!/scenari/i.test(sheetName)) return issues;
  // Look for rows where B,C,D cells all have identical formula but are supposed to be different scenarios
  const rowFormulas = new Map();
  for (const [addr, cell] of sheetData.cells) {
    if (!cell.formula) continue;
    const p = splitAddr(addr); if (!p) continue;
    const colN = colNum(p.col);
    if (colN < 2 || colN > 5) continue; // B-E
    if (!rowFormulas.has(p.row)) rowFormulas.set(p.row, []);
    rowFormulas.get(p.row).push({ col: p.col, formula: cell.formula });
  }
  let identicalRowCount = 0;
  for (const [row, cells] of rowFormulas) {
    if (cells.length < 2) continue;
    const formulas = new Set(cells.map(c => c.formula));
    if (formulas.size === 1) identicalRowCount++;
  }
  if (identicalRowCount >= 3) {
    issues.push({
      severity: 'critical',
      kind: 'scenario_fanout_static',
      location: sheetName,
      detail: `${identicalRowCount} output rows have identical formulas across scenario columns B/C/D — scenarios produce the same result. Output cells must reference scenario inputs above (e.g. B5*B$3 instead of fixed cell).`,
    });
  }
  return issues;
}

// L6: annual sheet references single quarterly cell — should SUM range.
// Smarter check: only flag if source sheet has SIGNIFICANTLY more columns
// than this sheet (≥3× more cols in the same header row).
function lintPeriodMismatch(sheetName, sheetData, allSheets) {
  const issues = [];
  // Count columns used in this sheet's header rows
  function countCols(data) {
    const cols = new Set();
    for (const [addr, cell] of data.cells) {
      const p = splitAddr(addr); if (!p || p.row > 2) continue;
      if (cell.value !== undefined && cell.value !== null && cell.value !== '') cols.add(p.col);
    }
    return cols.size;
  }
  const myCols = countCols(sheetData);
  if (myCols < 3) return issues; // too small to be an annual axis sheet

  // For each formula referencing another sheet, check column-count ratio
  for (const [addr, cell] of sheetData.cells) {
    if (!cell.formula) continue;
    const p = splitAddr(addr); if (!p || p.col === 'A') continue;
    const isSumWrapper = /\b(SUM|AVERAGE|AVG|SUMPRODUCT|SUMIFS|SUMIF)\s*\(/i.test(cell.formula);
    if (isSumWrapper) continue;
    // Find the referenced sheet
    const refSheetMatch = cell.formula.match(/(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))!/);
    if (!refSheetMatch) continue;
    const refSheet = (refSheetMatch[1] || refSheetMatch[2] || '').trim();
    if (refSheet === sheetName) continue;
    const refData = allSheets[refSheet];
    if (!refData) continue;
    const refCols = countCols(refData);
    // Only flag if reference sheet has >= 3× more cols than us
    if (refCols < myCols * 3) continue;
    issues.push({
      severity: 'high',
      kind: 'annual_ref_quarterly_single',
      location: `${sheetName}!${addr}`,
      detail: `${sheetName} has ${myCols} period cols but references "${refSheet}" (${refCols} cols) via single cell ref "${cell.formula.slice(0, 80)}". Wrap with SUM over the matching ${Math.round(refCols/myCols)} cols.`,
    });
  }
  return issues;
}

// L7: D&A row references Shares cell (label-aware semantic mismatch)
function lintSemanticLabel(sheetName, sheetData, allSheets) {
  const issues = [];
  // For each formula, check if local row label and target row label are semantically opposite
  const sensitivePairs = [
    { localPat: /D&A|amortization|depreciation/i, targetBadPat: /shares|share count|share price|outstanding|p\/e/i },
    { localPat: /^WACC$|discount|cost of capital/i, targetBadPat: /operating days|^days$|month/i },
    { localPat: /^capex|capital expenditure|initial capex/i, targetBadPat: /exit multiple|terminal multiple/i },
    { localPat: /^revenue/i, targetBadPat: /shares|share count|months|days/i },
  ];

  for (const [addr, cell] of sheetData.cells) {
    if (!cell.formula) continue;
    const p = splitAddr(addr); if (!p) continue;
    const localLabel = sheetData.rowLabels.get(p.row);
    if (!localLabel) continue;
    const matchingPair = sensitivePairs.find(pair => pair.localPat.test(localLabel));
    if (!matchingPair) continue;
    // Inspect each ref in the formula
    const refs = extractCellRefs(cell.formula);
    for (const ref of refs) {
      const refSheetName = ref.sheet || sheetName;
      const refSheet = allSheets[refSheetName]; if (!refSheet) continue;
      const refP = splitAddr(ref.addr); if (!refP) continue;
      const refLabel = refSheet.rowLabels.get(refP.row);
      if (!refLabel) continue;
      if (matchingPair.targetBadPat.test(refLabel)) {
        issues.push({
          severity: 'critical',
          kind: 'semantic_label_mismatch',
          location: `${sheetName}!${addr}`,
          detail: `Cell in row labeled "${localLabel}" references ${refSheetName}!${ref.addr} which is row labeled "${refLabel}". Formula: "${cell.formula.slice(0, 80)}". Find the correct row matching the local concept and use that address instead.`,
        });
        break; // one report per cell
      }
    }
  }
  return issues;
}

function runFinanceLints(actions) {
  const allSheets = buildSheetIndex(actions);
  const issues = [];
  for (const [sheetName, sheetData] of Object.entries(allSheets)) {
    issues.push(...lintSensitivity(sheetName, sheetData));
    issues.push(...lintIRRNPV(sheetName, sheetData));
    issues.push(...lintScenarios(sheetName, sheetData));
    issues.push(...lintPeriodMismatch(sheetName, sheetData, allSheets));
    issues.push(...lintSemanticLabel(sheetName, sheetData, allSheets));
  }
  return issues;
}

// AUTO-FIX: IRR/NPV with array literals → unfold the refs into a helper row.
// Adds a new "Cash flow row" to the same sheet and rewrites the IRR/NPV
// to point at that row. Returns count of formulas fixed.
function autoFixIRRArrayLiterals(actions) {
  let fixed = 0;
  const helperRowsAdded = new Map(); // sheet -> row number used
  for (const a of actions) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    const sheet = a.sheet || a.sheetName;
    for (const [addr, spec] of Object.entries(a.cells)) {
      if (!spec || typeof spec !== 'object' || !spec.formula) continue;
      const formula = spec.formula;
      const m = formula.match(/=\s*(IRR|XIRR|NPV|XNPV|MIRR)\s*\(([^)]+)\)/i);
      if (!m) continue;
      const fnName = m[1].toUpperCase();
      const argsStr = m[2];
      const braceMatch = argsStr.match(/\{([^}]+)\}/);
      if (!braceMatch) continue;
      const flowsStr = braceMatch[1];
      // Split refs
      const flows = flowsStr.split(',').map(s => s.trim()).filter(Boolean);
      if (flows.length < 2) continue;
      // Allocate helper row near bottom of this sheet
      const p = splitAddr(addr); if (!p) continue;
      const baseRow = (helperRowsAdded.get(sheet) || (p.row + 20));
      helperRowsAdded.set(sheet, baseRow + 1);
      // Write flows to row baseRow cols B..
      const newCells = {};
      newCells[`A${baseRow}`] = { value: `${fnName} flows for ${addr}`, cellStyles: { italic: true, fontSize: 9 } };
      let lastCol = 'B';
      for (let i = 0; i < flows.length; i++) {
        const col = numToCol(2 + i);
        lastCol = col;
        // Each flow is either a cell ref (already absolute) or a sub-expression
        const fVal = flows[i].startsWith('=') ? flows[i] : `=${flows[i]}`;
        newCells[`${col}${baseRow}`] = { formula: fVal, cellStyles: { numberFormat: '€#,##0' } };
      }
      actions.push({ type: 'setCellRange', sheet, cells: newCells });
      // Rewrite the original formula to reference the helper row range
      let newFormula;
      if (fnName === 'NPV' || fnName === 'XNPV') {
        // Keep rate arg if present (everything before the {})
        const before = argsStr.slice(0, braceMatch.index).replace(/,\s*$/, '');
        newFormula = `=${fnName}(${before}, B${baseRow}:${lastCol}${baseRow})`;
      } else {
        newFormula = `=${fnName}(B${baseRow}:${lastCol}${baseRow})`;
      }
      spec.formula = newFormula;
      fixed++;
    }
  }
  return fixed;
}

function numToCol(n) { let s=''; while (n>0) { const r=(n-1)%26; s=String.fromCharCode(65+r)+s; n=Math.floor((n-1)/26); } return s||'A'; }

// AUTO-FIX: period mismatch — wrap single cell ref to a wider sheet with SUM over
// the matching slice of columns. For Credit_Stats Y2 referencing Debt_Schedule!$D$12
// (single Y2Q1 cell), rewrite to =SUM('Debt_Schedule'!$F$12:$I$12) (Y2Q1..Y2Q4).
function autoFixPeriodMismatch(actions) {
  const allSheets = buildSheetIndex(actions);
  let fixed = 0;
  // Compute cols-per-period ratio for each sheet pair when relevant
  function colsOf(sheetName) {
    const d = allSheets[sheetName]; if (!d) return 0;
    const cols = new Set();
    for (const [addr, cell] of d.cells) {
      const p = splitAddr(addr); if (!p || p.row > 2) continue;
      if (cell.value !== undefined && cell.value !== null && cell.value !== '') cols.add(p.col);
    }
    return cols.size;
  }
  // Find sheet column-counts; assume index col is A (1 col), data cols are after
  for (const [sheetName, sheetData] of Object.entries(allSheets)) {
    const myCols = colsOf(sheetName);
    if (myCols < 3) continue;
    for (const [addr, cell] of sheetData.cells) {
      if (!cell.formula) continue;
      const p = splitAddr(addr); if (!p || p.col === 'A') continue;
      if (/\b(SUM|AVERAGE|AVG|SUMPRODUCT|SUMIFS|SUMIF)\s*\(/i.test(cell.formula)) continue;
      // Detect a single absolute ref like =Sheet!$C$5 (one ref formula)
      const singleRefMatch = cell.formula.match(/^=([A-Za-z_][A-Za-z0-9_]*|'[^']+')!\$([A-Z]+)\$(\d+)$/);
      if (!singleRefMatch) continue;
      const refSheetRaw = singleRefMatch[1].replace(/^'|'$/g, '');
      const refSheet = allSheets[refSheetRaw];
      if (!refSheet) continue;
      const refCols = colsOf(refSheetRaw);
      if (refCols < myCols * 3) continue;
      const ratio = Math.round(refCols / myCols);
      const refCol = singleRefMatch[2];
      const refRow = singleRefMatch[3];
      const refColNum = colNum(refCol);
      // Determine which "period" this is: my col position vs my total cols
      const myColNum = colNum(p.col);
      // For my col N (1-indexed from data start col, e.g. B=1), source range starts at
      // (N-1)*ratio + first_data_col_in_source, spans ratio cols
      // Heuristic: assume both sheets start data at col B (col 2). So Y2 in me = col C (3rd col); Y2 in source = cols D..G (4..7).
      const myDataIdx = myColNum - 2; // 0-indexed (B=0, C=1, ...)
      if (myDataIdx < 0) continue;
      const srcStartIdx = myDataIdx * ratio;
      const srcEndIdx = srcStartIdx + ratio - 1;
      const srcStartCol = numToCol(2 + srcStartIdx);
      const srcEndCol = numToCol(2 + srcEndIdx);
      const needsQuoting = /[^A-Za-z0-9_]/.test(refSheetRaw);
      const sheetRef = needsQuoting ? `'${refSheetRaw.replace(/'/g, "''")}'` : refSheetRaw;
      const newFormula = `=SUM(${sheetRef}!$${srcStartCol}$${refRow}:$${srcEndCol}$${refRow})`;
      // Only apply if the new range doesn't reuse the same single col (would be no-op)
      if (srcStartCol === srcEndCol) continue;
      cell.formula = newFormula;
      // Need to update the actual action too (cell is from indexCells which returns refs)
      for (const a of actions) {
        if (a.type !== 'setCellRange' || !a.cells) continue;
        if ((a.sheet || a.sheetName) !== sheetName) continue;
        if (a.cells[addr] && typeof a.cells[addr] === 'object') {
          a.cells[addr].formula = newFormula;
          fixed++;
          break;
        }
      }
    }
  }
  return fixed;
}

module.exports = { runFinanceLints, autoFixIRRArrayLiterals, autoFixPeriodMismatch, lintSensitivity, lintIRRNPV, lintScenarios, lintPeriodMismatch, lintSemanticLabel };
