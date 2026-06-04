'use strict';

const logger = require('../server/utils/logger');

/**
 * Cross-Slice Consistency Validator
 *
 * After stepwise generation, different slices may produce formulas that reference
 * cells from other slices. This validator checks that cross-sheet references are
 * consistent and that the overall model has no structural gaps.
 *
 * Returns issues with severity/location/detail, consumable by the repair agent.
 */

function validateCrossSliceConsistency(actions, plan) {
  const issues = [];
  const sheets = new Map(); // sheet -> Set of cell addresses
  const formulas = [];      // { sheet, addr, formula }
  const assumptions = new Map(); // sheet -> Map(addr -> value)

  // Index all cells and formulas
  for (const a of actions) {
    const sh = a.sheet || a.sheetName || 'Sheet1';
    if (a.type === 'createSheet') {
      if (!sheets.has(sh)) sheets.set(sh, new Set());
      continue;
    }
    if (!sheets.has(sh)) sheets.set(sh, new Set());

    if (a.type === 'setCellRange' && a.cells) {
      for (const [addr, spec] of Object.entries(a.cells)) {
        const bare = addr.includes('!') ? addr.split('!').pop() : addr;
        sheets.get(sh).add(bare.toUpperCase());

        if (spec?.formula) {
          formulas.push({ sheet: sh, addr: bare.toUpperCase(), formula: spec.formula });
        }
        if (spec?.value !== undefined && !spec?.formula) {
          if (!assumptions.has(sh)) assumptions.set(sh, new Map());
          assumptions.get(sh).set(bare.toUpperCase(), spec.value);
        }
      }
    }
  }

  // 1. Check that every cross-sheet reference points to an existing sheet
  const xsheetRe = /(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))!(\$?)([A-Z]+)(\$?)(\d+)/g;
  for (const { sheet, addr, formula } of formulas) {
    let m;
    while ((m = xsheetRe.exec(formula)) !== null) {
      const targetSheet = m[1] || m[2];
      const targetCell = `${m[4]}${m[6]}`;
      if (!sheets.has(targetSheet)) {
        issues.push({
          severity: 'critical',
          kind: 'missing_xsheet_target',
          location: `${sheet}!${addr}`,
          detail: `Formula references sheet "${targetSheet}" which is never created`,
        });
      } else if (!sheets.get(targetSheet).has(targetCell.toUpperCase())) {
        // The target cell might be in a different slice that hasn't been indexed yet,
        // or it might genuinely be missing. We flag it as high but not critical
        // because some references are intentionally to external/context cells.
        issues.push({
          severity: 'high',
          kind: 'empty_xsheet_cell',
          location: `${sheet}!${addr}`,
          detail: `Formula references ${targetSheet}!${targetCell} which has no value in the generated actions`,
        });
      }
    }
  }

  // 2. Check that Assumptions sheet actually has all the key drivers the plan expects
  const assumptionSheets = [...sheets.keys()].filter(s => /assumptions?|drivers?|inputs?/i.test(s));
  if (assumptionSheets.length === 0) {
    issues.push({
      severity: 'critical',
      kind: 'missing_assumptions_sheet',
      location: 'global',
      detail: 'No assumptions/driver sheet found in generated actions',
    });
  } else {
    for (const ash of assumptionSheets) {
      const cells = sheets.get(ash);
      if (cells.size < 5) {
        issues.push({
          severity: 'high',
          kind: 'sparse_assumptions',
          location: ash,
          detail: `Assumptions sheet only has ${cells.size} cells; expected at least 5 driver values`,
        });
      }
    }
  }

  // 3. Check that DCF / Valuation slices reference Projection/WACC cells
  const dcfSheets = [...sheets.keys()].filter(s => /dcf|valuation|npv|ev/i.test(s));
  const projSheets = [...sheets.keys()].filter(s => /projection|forecast|fcff|ufcf/i.test(s));
  const waccSheets = [...sheets.keys()].filter(s => /wacc/i.test(s));

  if (dcfSheets.length > 0) {
    for (const dcf of dcfSheets) {
      const dcfFormulas = formulas.filter(f => f.sheet === dcf);
      const hasProjRef = projSheets.some(ps =>
        dcfFormulas.some(f => f.formula.includes(ps))
      );
      const hasWaccRef = waccSheets.some(ws =>
        dcfFormulas.some(f => f.formula.includes(ws))
      );
      if (!hasProjRef) {
        issues.push({
          severity: 'critical',
          kind: 'dcf_missing_projection_ref',
          location: dcf,
          detail: `DCF sheet "${dcf}" has no references to any projection sheet`,
        });
      }
      if (!hasWaccRef) {
        issues.push({
          severity: 'high',
          kind: 'dcf_missing_wacc_ref',
          location: dcf,
          detail: `DCF sheet "${dcf}" has no references to any WACC sheet`,
        });
      }
    }
  }

  // 4. Check that sensitivity table references exist
  const sensSheets = [...sheets.keys()].filter(s => /sensitiv/i.test(s));
  for (const sens of sensSheets) {
    const sensFormulas = formulas.filter(f => f.sheet === sens);
    // Sensitivity tables should have formulas (not hardcoded values)
    const hardcodedCount = sensFormulas.filter(f => {
      const cell = actions.find(a => a.sheet === sens && a.cells && a.cells[f.addr]);
      return cell && cell.cells[f.addr].value !== undefined && !cell.cells[f.addr].formula;
    }).length;
    if (hardcodedCount > 0) {
      issues.push({
        severity: 'high',
        kind: 'sensitivity_hardcoded',
        location: sens,
        detail: `Sensitivity table has ${hardcodedCount} hardcoded values instead of formulas`,
      });
    }
  }

  // 5. Check that Revenue/EBITDA build chains reference Assumptions for growth rates
  const revSheets = [...sheets.keys()].filter(s => /revenue|projection|build/i.test(s));
  for (const rs of revSheets) {
    const rsFormulas = formulas.filter(f => f.sheet === rs);
    const hasGrowthRef = assumptionSheets.some(as =>
      rsFormulas.some(f => f.formula.includes(as))
    );
    if (!hasGrowthRef && rsFormulas.length > 0) {
      issues.push({
        severity: 'high',
        kind: 'revenue_missing_assumption_ref',
        location: rs,
        detail: `Revenue/projection sheet "${rs}" formulas do not reference any assumptions sheet`,
      });
    }
  }

  logger.info(`[CrossSliceValidator] ${issues.length} issues (${issues.filter(i => i.severity === 'critical').length} critical)`);
  return issues;
}

module.exports = {
  validateCrossSliceConsistency,
};
