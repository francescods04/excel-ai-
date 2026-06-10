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

// L8: Sources_Uses balance — sum of sources should equal sum of uses
function lintSourcesUses(sheetName, sheetData) {
  const issues = [];
  if (!/source.*use|sources?_?uses?|sources?.?and.?uses?/i.test(sheetName)) return issues;
  // Look for "Total Sources" and "Total Uses" rows by label
  let totalSourcesRow = null, totalUsesRow = null;
  for (const [row, label] of sheetData.rowLabels) {
    const lab = label.toLowerCase();
    if (/total\s*sources?/.test(lab)) totalSourcesRow = row;
    if (/total\s*uses?/.test(lab)) totalUsesRow = row;
  }
  if (!totalSourcesRow || !totalUsesRow) return issues;
  const srcCell = sheetData.cells.get(`B${totalSourcesRow}`);
  const useCell = sheetData.cells.get(`B${totalUsesRow}`);
  if (!srcCell || !useCell) return issues;
  // Look for explicit "Check" row that subtracts them
  let hasCheck = false;
  for (const [row, label] of sheetData.rowLabels) {
    if (/\bcheck\b|\bbalance\b/i.test(label)) {
      const cc = sheetData.cells.get(`B${row}`);
      if (cc?.formula && (/B\d+\s*[-=]\s*B\d+/.test(cc.formula))) { hasCheck = true; break; }
    }
  }
  if (!hasCheck) {
    issues.push({
      severity: 'high',
      kind: 'sources_uses_no_check',
      location: `${sheetName}!B${totalSourcesRow}`,
      detail: `Sources_Uses sheet lacks a Check row formula (=Total_Sources - Total_Uses). Add it to verify balance.`,
    });
  }
  // Both should be formulas (not hardcoded). If both are values, possibly hardcoded balance.
  if (srcCell.value !== undefined && useCell.value !== undefined && !srcCell.formula && !useCell.formula) {
    if (Number(srcCell.value) !== Number(useCell.value)) {
      issues.push({
        severity: 'critical',
        kind: 'sources_uses_imbalance',
        location: `${sheetName}`,
        detail: `Hardcoded Total Sources (${srcCell.value}) != Total Uses (${useCell.value}). Should balance.`,
      });
    }
  }
  return issues;
}

// L9: Balance Sheet — Total Assets row should equal Total Liabilities + Equity row
function lintBalanceSheet(sheetName, sheetData) {
  const issues = [];
  if (!/balance.?sheet|bs|stato.?patrimon/i.test(sheetName)) return issues;
  let totalAssetsRow = null, totalLiabEqRow = null;
  for (const [row, label] of sheetData.rowLabels) {
    const lab = label.toLowerCase();
    if (/total\s*assets?/.test(lab) || /totale\s*attiv/.test(lab)) totalAssetsRow = row;
    if (/total\s*(liab|liabilities).*equity|total\s*l\s*\+\s*e|totale\s*passiv/.test(lab)) totalLiabEqRow = row;
  }
  if (totalAssetsRow && !totalLiabEqRow) {
    issues.push({
      severity: 'high',
      kind: 'bs_no_check',
      location: `${sheetName}`,
      detail: `Balance Sheet has "Total Assets" but no "Total Liab + Equity" row. Cannot verify balance.`,
    });
  }
  return issues;
}

// L10: Missing-required-sheet — caller can pass expected sheets list via opts
function lintMissingSheets(allSheets, expectedSheets) {
  const issues = [];
  if (!Array.isArray(expectedSheets)) return issues;
  const canon = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const present = new Set(Object.keys(allSheets).map(canon));
  for (const exp of expectedSheets) {
    const c = canon(exp);
    let found = false;
    for (const p of present) { if (p === c || p.includes(c) || c.includes(p)) { found = true; break; } }
    if (!found) {
      issues.push({
        severity: 'high',
        kind: 'missing_required_sheet',
        location: exp,
        detail: `Required sheet "${exp}" missing from output. Planner declared it but codegen didn't produce it.`,
      });
    }
  }
  return issues;
}

// L11: Tax formula on potentially negative base — needs MAX(...,0).
// Heuristic: any row labeled with tax/imposte that contains a multiplication
// of a P&L-like cell ref (likely EBT) by a rate cell ref, missing MAX, gets flagged.
function lintTaxNoMaxGuard(sheetName, sheetData) {
  const issues = [];
  for (const [addr, cell] of sheetData.cells) {
    if (!cell.formula) continue;
    const p = splitAddr(addr); if (!p) continue;
    const localLabel = sheetData.rowLabels.get(p.row);
    if (!localLabel) continue;
    if (!/\btax(es)?\b|income tax|imposte|tax expense|tax provision/i.test(localLabel)) continue;
    if (/tax rate|aliquota/i.test(localLabel)) continue; // skip the rate row itself
    // Multiplication of two refs without MAX, IF, or IFERROR guard
    const hasMul = /\*/.test(cell.formula);
    const hasGuard = /\bMAX\s*\(|\bIF\s*\(|\bIFERROR\s*\(/i.test(cell.formula);
    const refCount = (cell.formula.match(/\$?[A-Z]+\$?\d+/g) || []).length;
    if (hasMul && !hasGuard && refCount >= 2) {
      issues.push({
        severity: 'high',
        kind: 'tax_no_max_guard',
        location: `${sheetName}!${addr}`,
        detail: `Tax row "${localLabel}" formula "${cell.formula.slice(0,80)}" multiplies a P&L base by a rate without MAX(...,0). Negative pretax produces a negative tax (a credit) — institutional models wrap the base in MAX(EBT,0).`,
      });
    }
  }
  return issues;
}

// L12: Debt schedule ending balance is flat across periods (Bal_t = Bal_{t-1}).
// Flat is correct for a true bullet, but the audit penalises absence of an
// explicit "Principal Repayment" or "Amortization" row when leverage > 0.
// Flag only when the sheet has a balance row but NO matching amort row.
function lintDebtScheduleAmort(sheetName, sheetData) {
  const issues = [];
  if (!/debt[_ ]?schedule|debt[_ ]?roll/i.test(sheetName)) return issues;
  let balanceRows = [];
  let amortRows = 0;
  let repayRows = 0;
  for (const [row, label] of sheetData.rowLabels) {
    const l = label.toLowerCase();
    if (/balance|outstanding|principal\s*end|ending/i.test(l)) balanceRows.push(row);
    if (/\bamort|principal\s*(repay|payment)|scheduled\s*repay/i.test(l)) amortRows++;
    if (/cash\s*sweep|optional\s*prepay|prepayment|repayment\s*at\s*exit|bullet\s*repay/i.test(l)) repayRows++;
  }
  if (balanceRows.length > 0 && amortRows === 0 && repayRows === 0) {
    issues.push({
      severity: 'high',
      kind: 'debt_schedule_no_amort_row',
      location: sheetName,
      detail: `Debt schedule has ${balanceRows.length} balance row(s) but no Amortization / Cash Sweep / Repayment-at-Exit row. Even bullet structures need a final-period repayment row so the audit can verify the debt unwinds at exit.`,
    });
  }
  return issues;
}

// L12: PnL — EBITDA formula subtracts D&A (D&A must be BELOW EBITDA, not in it)
function lintPnLEBITDA(sheetName, sheetData) {
  const issues = [];
  if (!/pnl|p&l|income|profit.*loss|conto.*econom/i.test(sheetName)) return issues;
  let ebitdaRow = null;
  for (const [row, label] of sheetData.rowLabels) {
    if (/\bebitda\b/i.test(label)) { ebitdaRow = row; break; }
  }
  if (!ebitdaRow) return issues;
  for (const [addr, cell] of sheetData.cells) {
    const p = splitAddr(addr); if (!p || p.row !== ebitdaRow) continue;
    if (!cell.formula) continue;
    if (/d&a|depreciation|amortization|ammortament/i.test(cell.formula)) {
      issues.push({
        severity: 'critical',
        kind: 'pnl_ebitda_minus_dna',
        location: `${sheetName}!${addr}`,
        detail: `EBITDA formula "${cell.formula.slice(0,100)}" contains D&A subtraction. EBITDA = Gross Profit - OpEx. D&A is a SEPARATE line below EBITDA. EBIT = EBITDA - D&A.`,
      });
    }
  }
  return issues;
}

// L13: PnL — EBIT formula subtracts Capex (Capex is NOT a PnL expense)
function lintPnLEBIT(sheetName, sheetData) {
  const issues = [];
  if (!/pnl|p&l|income|profit.*loss|conto.*econom/i.test(sheetName)) return issues;
  let ebitRow = null;
  for (const [row, label] of sheetData.rowLabels) {
    if (/\bebit\b/i.test(label) && !/ebitda/i.test(label)) { ebitRow = row; break; }
  }
  if (!ebitRow) return issues;
  for (const [addr, cell] of sheetData.cells) {
    const p = splitAddr(addr); if (!p || p.row !== ebitRow) continue;
    if (!cell.formula) continue;
    if (/capex|capital expenditure|investiment/i.test(cell.formula)) {
      issues.push({
        severity: 'critical',
        kind: 'pnl_ebit_minus_capex',
        location: `${sheetName}!${addr}`,
        detail: `EBIT formula "${cell.formula.slice(0,100)}" contains Capex. Capex is a Cash Flow / Balance Sheet item, NEVER a PnL expense. EBIT = EBITDA - D&A.`,
      });
    }
  }
  return issues;
}

// L14: Debt Schedule — Ending Balance includes Interest Expense cash (only PIK capitalizes)
function lintDebtEndingInterest(sheetName, sheetData) {
  const issues = [];
  if (!/debt[_ ]?schedule|debt[_ ]?roll/i.test(sheetName)) return issues;
  // Find ending balance rows
  let endingRows = [];
  for (const [row, label] of sheetData.rowLabels) {
    if (/ending balance|end balance|principal end/i.test(label.toLowerCase())) endingRows.push(row);
  }
  if (endingRows.length === 0) return issues;
  // Find interest expense rows
  let interestRows = [];
  for (const [row, label] of sheetData.rowLabels) {
    if (/interest expense|interest.*cash|cash interest/i.test(label.toLowerCase())) interestRows.push(row);
  }
  for (const endRow of endingRows) {
    let firstBadCell = null;
    let badCount = 0;
    for (const [addr, cell] of sheetData.cells) {
      const p = splitAddr(addr); if (!p || p.row !== endRow) continue;
      if (!cell.formula) continue;
      // Check if formula references an interest expense row in the SAME sheet
      const hasInterestRef = interestRows.some(ir => {
        const refPat = new RegExp(`[A-Z]+${ir}\\b`, 'i');
        return refPat.test(cell.formula);
      });
      if (hasInterestRef) {
        badCount++;
        if (!firstBadCell) firstBadCell = { addr, formula: cell.formula };
      }
    }
    if (badCount > 0 && firstBadCell) {
      const label = sheetData.rowLabels.get(endRow) || 'Ending Balance';
      issues.push({
        severity: 'critical',
        kind: 'debt_ending_includes_interest_cash',
        location: `${sheetName}!${firstBadCell.addr}`,
        detail: `${label} row has ${badCount} cells referencing Interest Expense cash (e.g. ${firstBadCell.addr}: "${firstBadCell.formula.slice(0,100)}"). Interest Expense is a PnL/CF cost — it does NOT capitalize into principal. Only PIK interest adds to principal. FIX: replace "+InterestExpenseCell" with nothing. Ending Balance = Beginning + PIK - Repayment.`,
      });
    }
  }
  return issues;
}

// L15+L16+L17: Balance Sheet — Cash/PP&E/Equity must be cumulative
function lintBalanceSheetCumulative(sheetName, sheetData) {
  const issues = [];
  if (!/balance.?sheet|bs|stato.?patrimon/i.test(sheetName)) return issues;
  const rowsToCheck = [
    { pat: /\bcash\b/i, name: 'Cash', reason: 'Cash must be cumulative = previous Cash + Net Cash Flow. Not period-only flow.' },
    { pat: /pp&e|property|plant|equipment|fixed assets?/i, name: 'PP&E', reason: 'PP&E must be cumulative = previous PP&E + Capex - D&A. Not Capex/4.' },
    { pat: /\bequity\b/i, name: 'Equity', reason: 'Equity must grow with retained earnings = previous Equity + Net Income. Not static source value.' },
  ];
  for (const { pat, name, reason } of rowsToCheck) {
    let targetRow = null;
    for (const [row, label] of sheetData.rowLabels) {
      if (pat.test(label)) { targetRow = row; break; }
    }
    if (!targetRow) continue;
    let firstBadCell = null;
    let badCount = 0;
    let badKind = null;
    for (const [addr, cell] of sheetData.cells) {
      const p = splitAddr(addr); if (!p || p.row !== targetRow) continue;
      if (!cell.formula) {
        if (p.col !== 'A') {
          badCount++;
          if (!firstBadCell) { firstBadCell = { addr, formula: '(static value)' }; badKind = 'bs_row_static'; }
        }
        continue;
      }
      const f = cell.formula;
      if (name === 'Cash') {
        const hasPrevRef = new RegExp(`['"]${sheetName}['"]?![A-Z]+${targetRow}`, 'i').test(f) || /[A-Z]+\d+\s*[+\-]/.test(f);
        if (!hasPrevRef && !/sum|cumul/i.test(f)) {
          badCount++;
          if (!firstBadCell) { firstBadCell = { addr, formula: f }; badKind = 'bs_cash_not_cumulative'; }
        }
      }
      if (name === 'PP&E') {
        const hasPrevPPE = new RegExp(`['"]${sheetName}['"]?![A-Z]+${targetRow}`, 'i').test(f) || /[A-Z]+\d+\s*[+\-]/.test(f);
        if (!hasPrevPPE) {
          badCount++;
          if (!firstBadCell) { firstBadCell = { addr, formula: f }; badKind = 'bs_ppe_not_cumulative'; }
        }
      }
      if (name === 'Equity') {
        const hasNI = /net income|ni|pnl|p&l|income statement/i.test(f);
        const hasPrev = new RegExp(`['"]${sheetName}['"]?![A-Z]+${targetRow}`, 'i').test(f) || /[A-Z]+\d+\s*[+\-]/.test(f);
        if (!hasNI && !hasPrev) {
          badCount++;
          if (!firstBadCell) { firstBadCell = { addr, formula: f }; badKind = 'bs_equity_static'; }
        }
      }
    }
    if (badCount > 0 && firstBadCell) {
      issues.push({
        severity: 'high',
        kind: badKind,
        location: `${sheetName}!${firstBadCell.addr}`,
        detail: `${name} row has ${badCount} cells that are not cumulative/static (e.g. ${firstBadCell.addr}: "${firstBadCell.formula.slice(0,80)}"). ${reason}`,
      });
    }
  }
  return issues;
}

// L18: Returns — IRR must include initial negative equity outflow
function lintIRRStructure(sheetName, sheetData) {
  const issues = [];
  if (!/return|irr|moic|sponsor/i.test(sheetName)) return issues;
  for (const [addr, cell] of sheetData.cells) {
    if (!cell.formula) continue;
    const m = cell.formula.match(/=\s*(IRR|XIRR)\s*\(([^)]+)\)/i);
    if (!m) continue;
    const range = m[2].trim();
    // Check if range includes a negative initial value (outflow)
    // Heuristic: the range should be wide enough (multiple cols) and ideally
    // the first cell should reference a negative equity contribution
    const cellsInRange = range.match(/\$?[A-Z]+\$?\d+/g);
    if (!cellsInRange || cellsInRange.length < 2) {
      issues.push({
        severity: 'high',
        kind: 'irr_range_too_short',
        location: `${sheetName}!${addr}`,
        detail: `IRR formula "${cell.formula}" range "${range}" is too short. IRR needs at least an initial outflow + one return period.`,
      });
      continue;
    }
    // Check if the range starts with a cell that likely contains negative equity
    const firstCell = cellsInRange[0];
    const firstFormula = sheetData.cells.get(firstCell)?.formula || '';
    const hasNegative = /-\s*[A-Z]+|negative|outflow|contribution/i.test(firstFormula + cell.formula);
    const hasEquityRef = /equity|sponsor|contribution|investment/i.test(firstFormula + cell.formula);
    if (!hasNegative && !hasEquityRef) {
      issues.push({
        severity: 'high',
        kind: 'irr_missing_initial_outflow',
        location: `${sheetName}!${addr}`,
        detail: `IRR formula "${cell.formula}" range "${range}" does not appear to include an initial negative equity outflow. IRR requires a negative cash flow at t=0 (equity invested) to be mathematically valid.`,
      });
    }
  }
  return issues;
}

// L19: Exit Analysis — references must point to last operational period, not empty far-right column
function lintExitAnalysisColumn(sheetName, sheetData, allSheets) {
  const issues = [];
  if (!/exit|exit_analysis|exit_.*analysis/i.test(sheetName)) return issues;
  for (const [addr, cell] of sheetData.cells) {
    if (!cell.formula) continue;
    const refs = extractCellRefs(cell.formula);
    for (const ref of refs) {
      const refSheetName = ref.sheet || sheetName;
      const refSheet = allSheets[refSheetName]; if (!refSheet) continue;
      const refP = splitAddr(ref.addr); if (!refP) continue;
      const colN = colNum(refP.col);
      // Only flag refs whose target is actually EMPTY or a zero-stub. A written
      // formula/value cell near the edge is legitimate (exit quarter IS one of the
      // last columns) — flagging it was a false positive once density enforcement
      // started filling rows through the full declared extent.
      const target = refSheet.cells.get(ref.addr);
      const isEmpty = !target;
      const isZeroStub = !!target && !target.formula && (target.value === 0 || target.value === null || target.value === undefined);
      if (!isEmpty && !isZeroStub) continue;
      const maxColInRefSheet = Math.max(...Array.from(refSheet.cells.keys()).map(a => {
        const p = splitAddr(a); return p ? colNum(p.col) : 0;
      }).filter(n => n > 1));
      if (colN > maxColInRefSheet - 2 && colN > 20) {
        issues.push({
          severity: 'critical',
          kind: 'exit_analysis_wrong_column',
          location: `${sheetName}!${addr}`,
          detail: `Exit Analysis formula "${cell.formula.slice(0,100)}" references ${refSheetName}!${ref.addr} (col ${refP.col}). This column is near or past the edge of data in ${refSheetName} (max col used ~${numToCol(maxColInRefSheet)}). It likely points to an EMPTY cell. Use the LAST OPERATIONAL PERIOD column instead.`,
        });
      }
    }
  }
  return issues;
}

function runFinanceLints(actions, opts = {}) {
  const allSheets = buildSheetIndex(actions);
  const issues = [];
  for (const [sheetName, sheetData] of Object.entries(allSheets)) {
    issues.push(...lintSensitivity(sheetName, sheetData));
    issues.push(...lintIRRNPV(sheetName, sheetData));
    issues.push(...lintScenarios(sheetName, sheetData));
    issues.push(...lintPeriodMismatch(sheetName, sheetData, allSheets));
    issues.push(...lintSemanticLabel(sheetName, sheetData, allSheets));
    issues.push(...lintSourcesUses(sheetName, sheetData));
    issues.push(...lintBalanceSheet(sheetName, sheetData));
    issues.push(...lintTaxNoMaxGuard(sheetName, sheetData));
    issues.push(...lintDebtScheduleAmort(sheetName, sheetData));
    issues.push(...lintPnLEBITDA(sheetName, sheetData));
    issues.push(...lintPnLEBIT(sheetName, sheetData));
    issues.push(...lintDebtEndingInterest(sheetName, sheetData));
    issues.push(...lintBalanceSheetCumulative(sheetName, sheetData));
    issues.push(...lintIRRStructure(sheetName, sheetData));
    issues.push(...lintExitAnalysisColumn(sheetName, sheetData, allSheets));
  }
  if (opts.expectedSheets) {
    issues.push(...lintMissingSheets(allSheets, opts.expectedSheets));
  }
  return issues;
}

// AUTO-FIX: wrap tax formula base in MAX(base, 0).
// Returns count of formulas updated.
function autoFixTaxMax(actions) {
  let fixed = 0;
  const sheets = buildSheetIndex(actions);
  for (const a of actions) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    const sh = a.sheet || a.sheetName;
    const sheetData = sheets[sh];
    if (!sheetData) continue;
    for (const [addr, spec] of Object.entries(a.cells)) {
      if (!spec || typeof spec !== 'object' || !spec.formula) continue;
      const p = splitAddr(addr); if (!p) continue;
      const localLabel = sheetData.rowLabels.get(p.row);
      if (!localLabel) continue;
      if (!/\btax(es)?\b|income tax|imposte|tax expense|tax provision/i.test(localLabel)) continue;
      if (/tax rate|aliquota/i.test(localLabel)) continue;
      const f = spec.formula;
      if (/\bMAX\s*\(|\bIF\s*\(|\bIFERROR\s*\(/i.test(f)) continue;
      // Recognise simple `= A * B` or `= A * B * C` shape and wrap leftmost ref in MAX(ref,0)
      const m = f.match(/^=\s*([^*+-/]+?)\s*\*\s*(.+)$/);
      if (!m) continue;
      const leftToken = m[1].trim();
      const rest = m[2].trim();
      // leftToken should be a single cell ref OR a small expression — only wrap if it's a ref-like atom.
      if (!/^['A-Za-z0-9_!$]+$/.test(leftToken)) continue;
      spec.formula = `=MAX(${leftToken},0)*${rest}`;
      fixed++;
    }
  }
  return fixed;
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

// AUTO-FIX: Debt Schedule — Ending Balance includes Interest Expense cash.
// Pattern: =B4+B5+B6 where B5 is Interest Expense → replace with =B4+B6
function autoFixDebtEndingInterest(actions) {
  const sheets = buildSheetIndex(actions);
  let fixed = 0;
  for (const [sheetName, sheetData] of Object.entries(sheets)) {
    if (!/debt[_ ]?schedule|debt[_ ]?roll/i.test(sheetName)) continue;
    // Find interest expense rows
    let interestRows = [];
    for (const [row, label] of sheetData.rowLabels) {
      if (/interest expense|interest.*cash|cash interest/i.test(label.toLowerCase())) interestRows.push(row);
    }
    if (interestRows.length === 0) continue;
    // Find ending balance rows
    let endingRows = [];
    for (const [row, label] of sheetData.rowLabels) {
      if (/ending balance|end balance|principal end/i.test(label.toLowerCase())) endingRows.push(row);
    }
    for (const endRow of endingRows) {
      for (const [addr, cell] of sheetData.cells) {
        const p = splitAddr(addr); if (!p || p.row !== endRow) continue;
        if (!cell.formula) continue;
        // Check if formula references an interest expense row
        const hasInterestRef = interestRows.some(ir => {
          const refPat = new RegExp(`[A-Z]+${ir}\\b`, 'i');
          return refPat.test(cell.formula);
        });
        if (!hasInterestRef) continue;
        // Heuristic: remove the interest expense term from the sum
        // e.g. =B4+B5+B6 → find which term is the interest ref and remove it
        for (const ir of interestRows) {
          const interestPattern = new RegExp(`([+\\-])?([A-Z]+${ir})`, 'i');
          if (interestPattern.test(cell.formula)) {
            // Remove the interest term (including its +/-)
            let newFormula = cell.formula.replace(interestPattern, '');
            // Clean up leading + or double +-
            newFormula = newFormula.replace(/^=/, '').replace(/^\+/, '').replace(/\+\+/g, '+').replace(/\+\-/g, '-').replace(/\-\+/g, '-');
            newFormula = '=' + newFormula;
            // Apply to the actual action
            for (const a of actions) {
              if (a.type !== 'setCellRange' || !a.cells) continue;
              if ((a.sheet || a.sheetName) !== sheetName) continue;
              if (a.cells[addr] && typeof a.cells[addr] === 'object') {
                a.cells[addr].formula = newFormula;
                fixed++;
                break;
              }
            }
            break;
          }
        }
      }
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

module.exports = { runFinanceLints, autoFixIRRArrayLiterals, autoFixPeriodMismatch, autoFixTaxMax, autoFixDebtEndingInterest, lintSensitivity, lintIRRNPV, lintScenarios, lintPeriodMismatch, lintSemanticLabel, lintTaxNoMaxGuard, lintDebtScheduleAmort };
