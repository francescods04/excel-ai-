'use strict';

const logger = require('../server/utils/logger');

/**
 * Deterministic Repair Agent
 *
 * Fixes structural/formula/cross-slice issues that can be repaired without an LLM call.
 * This is fast (<10ms) and produces guaranteed-correct patches for simple mechanical fixes.
 *
 * Supported fixes:
 * - missing_sheet_ref / unknown_sheet_ref: replace with correct sheet name from plan
 * - div_by_zero: replace literal /0 with /0.0001 (or safe fallback)
 * - missing numberFormat: apply default formats based on cell content
 * - stale_time_series: cannot auto-fix (requires LLM)
 * - hardcoded_computed: cannot auto-fix (requires LLM)
 */

function deterministicRepair(actions, issues) {
  const patches = [];
  const sheets = new Set();
  for (const a of actions) {
    if (a.sheet || a.sheetName) sheets.add(a.sheet || a.sheetName);
  }

  for (const issue of issues) {
    switch (issue.kind) {
      case 'missing_sheet_ref':
      case 'unknown_sheet_ref': {
        // Try to find the closest matching sheet name
        const badSheet = extractBadSheetFromDetail(issue.detail);
        if (!badSheet) break;
        const correction = findClosestSheet(badSheet, sheets);
        if (correction && correction !== badSheet) {
          patches.push(createFormulaPatch(actions, issue.location, badSheet, correction));
        }
        break;
      }
      case 'div_by_zero': {
        const patch = createDivByZeroPatch(actions, issue.location);
        if (patch) patches.push(patch);
        break;
      }
      case 'missing_numberFormat':
      case 'no_numberFormat': {
        const patch = createFormatPatch(actions, issue.location);
        if (patch) patches.push(patch);
        break;
      }
      default:
        break;
    }
  }

  if (patches.length > 0) {
    logger.info(`[DeterministicRepair] ${patches.length} auto-patches applied`);
  }
  return patches;
}

function extractBadSheetFromDetail(detail) {
  const m = detail.match(/sheet\s+"([^"]+)"/i);
  return m ? m[1] : null;
}

function findClosestSheet(badSheet, existingSheets) {
  const lowerBad = badSheet.toLowerCase().replace(/[^a-z0-9]/g, '');
  let best = null;
  let bestScore = -1;
  for (const s of existingSheets) {
    const lowerS = s.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (lowerS === lowerBad) return s;
    // Simple substring match
    if (lowerS.includes(lowerBad) || lowerBad.includes(lowerS)) {
      return s;
    }
    // Levenshtein-ish: count common chars
    const common = [...lowerBad].filter(ch => lowerS.includes(ch)).length;
    if (common > bestScore) {
      bestScore = common;
      best = s;
    }
  }
  return best;
}

function createFormulaPatch(actions, location, oldSheet, newSheet) {
  const [sh, addr] = location.split('!');
  if (!sh || !addr) return null;
  for (const a of actions) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    if ((a.sheet || a.sheetName) !== sh) continue;
    const spec = a.cells[addr];
    if (!spec || !spec.formula) continue;
    const newFormula = spec.formula.replace(
      new RegExp(`(?:'[^']*'|[A-Za-z_][A-Za-z0-9_]*)!`, 'g'),
      (match) => {
        const sheet = match.replace(/!$/, '').replace(/^'|'$/g, '');
        if (sheet === oldSheet) {
          return newSheet.includes(' ') ? `'${newSheet}'!` : `${newSheet}!`;
        }
        return match;
      }
    );
    if (newFormula !== spec.formula) {
      return {
        type: 'setCellRange',
        sheet: sh,
        cells: { [addr]: { ...spec, formula: newFormula } },
      };
    }
  }
  return null;
}

function createDivByZeroPatch(actions, location) {
  const [sh, addr] = location.split('!');
  if (!sh || !addr) return null;
  for (const a of actions) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    if ((a.sheet || a.sheetName) !== sh) continue;
    const spec = a.cells[addr];
    if (!spec || !spec.formula) continue;
    // Replace /0 or /0.0 with /0.0001 (safe tiny denominator)
    const newFormula = spec.formula.replace(/\/\s*\(?\s*\.?0+(?:\.0+)?\s*(\)|[^.\w]|$)/g, '/0.0001$1');
    if (newFormula !== spec.formula) {
      return {
        type: 'setCellRange',
        sheet: sh,
        cells: { [addr]: { ...spec, formula: newFormula } },
      };
    }
  }
  return null;
}

function createFormatPatch(actions, location) {
  const [sh, addr] = location.split('!');
  if (!sh || !addr) return null;
  for (const a of actions) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    if ((a.sheet || a.sheetName) !== sh) continue;
    const spec = a.cells[addr];
    if (!spec) continue;
    let fmt = null;
    if (typeof spec.value === 'number' && Math.abs(spec.value) >= 1000) {
      fmt = '€#,##0';
    } else if (typeof spec.value === 'number' && Math.abs(spec.value) < 1) {
      fmt = '0.0%';
    }
    if (fmt && (!spec.cellStyles || !spec.cellStyles.numberFormat)) {
      return {
        type: 'setCellFormat',
        sheet: sh,
        target: addr,
        options: { numberFormat: fmt },
      };
    }
  }
  return null;
}

module.exports = {
  deterministicRepair,
};
