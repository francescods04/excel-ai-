'use strict';

// Auditor coherence detectors:
//   - detectCrossSheetCoherence — same label appearing in multiple sheets
//     with mismatched numeric neighbours (MEAT CREW: Revenue Y1 = 94K
//     in P&L vs 1.128M in Dashboard).
//   - detectDuplicateRowLabels  — same label repeated within ONE sheet
//     in the SAME column with conflicting neighbours (MEAT CREW: P&L
//     "Net Income" row written twice with opposite-sign values).

const assert = require('assert');
const {
  detectCrossSheetCoherence,
  detectDuplicateRowLabels,
  auditStatic
} = require('../../server/agents/auditor');

// Helper: build sheetCells the way agentLoop ingests them.
function cell(value, formula) { return { v: value, f: formula || null }; }

// ── 1) cross-sheet mismatch fires on MEAT CREW canonical case ──
{
  const sheetCells = {
    'PnL': {
      'A2': cell('Revenue Y1'),
      'B2': cell(94011)
    },
    'Dashboard': {
      'A3': cell('Revenue Y1'),
      'B3': cell(1128139)
    }
  };
  const issues = detectCrossSheetCoherence(sheetCells);
  assert.strictEqual(issues.length, 1, 'expected exactly 1 cross-sheet issue');
  const iss = issues[0];
  assert.strictEqual(iss.type, 'cross_sheet_coherence');
  assert.strictEqual(iss.severity, 'fail'); // 12× delta is way over 10 %
  assert.ok(iss.sheets.includes('PnL') && iss.sheets.includes('Dashboard'));
  assert.ok(iss.values.includes(94011) && iss.values.includes(1128139));
  console.log('OK detectCrossSheetCoherence flags MEAT CREW Revenue Y1 mismatch');
}

// ── 2) labels within tolerance → no issue ──
{
  const sheetCells = {
    'PnL': { 'A2': cell('EBITDA'), 'B2': cell(31566.20) },
    'Dashboard': { 'A3': cell('EBITDA'), 'B3': cell(31566.50) } // 0.001 % delta
  };
  assert.deepStrictEqual(detectCrossSheetCoherence(sheetCells), []);
  console.log('OK detectCrossSheetCoherence ignores within-tolerance values');
}

// ── 3) only 1 sheet has the label → not a cross-sheet issue ──
{
  const sheetCells = {
    'PnL': { 'A2': cell('Revenue Y1'), 'B2': cell(94011) }
  };
  assert.deepStrictEqual(detectCrossSheetCoherence(sheetCells), []);
  console.log('OK detectCrossSheetCoherence requires ≥2 sheets');
}

// ── 4) generic labels (Year, Total, Month) do not trigger noise ──
{
  const sheetCells = {
    'A': { 'A1': cell('Year'), 'B1': cell(2024) },
    'B': { 'A1': cell('Year'), 'B1': cell(2030) }
  };
  assert.deepStrictEqual(detectCrossSheetCoherence(sheetCells), [],
    'generic labels should be allowlist-filtered');
  console.log('OK detectCrossSheetCoherence skips generic non-financial labels');
}

// ── 5) duplicate-row-label fires on MEAT CREW P&L Net Income twice ──
{
  const sheetCells = {
    'PnL': {
      'A14': cell('Net Income'),
      'B14': cell(21132.36),
      'A15': cell('Net Income'),
      'B15': cell(-14458.98) // the shadow row
    }
  };
  const issues = detectDuplicateRowLabels(sheetCells);
  assert.strictEqual(issues.length, 1, 'expected exactly 1 duplicate-row issue');
  assert.strictEqual(issues[0].type, 'duplicate_row_label');
  assert.strictEqual(issues[0].severity, 'fail');
  assert.deepStrictEqual(issues[0].rows.sort((a, b) => a - b), [14, 15]);
  console.log('OK detectDuplicateRowLabels flags MEAT CREW Net Income twice');
}

// ── 6) same label same value → not flagged (one cell stylistic dup) ──
{
  const sheetCells = {
    'PnL': {
      'A14': cell('EBITDA'),
      'B14': cell(31566.2),
      'A20': cell('EBITDA'), // restated in a summary block
      'B20': cell(31566.2)
    }
  };
  assert.deepStrictEqual(detectDuplicateRowLabels(sheetCells), []);
  console.log('OK detectDuplicateRowLabels skips matching-value duplicates');
}

// ── 7) auditStatic integrates both new detectors ──
{
  const sheetCells = {
    'PnL': {
      'A14': cell('Net Income'), 'B14': cell(21132),
      'A15': cell('Net Income'), 'B15': cell(-14459)
    },
    'Dashboard': {
      'A3': cell('Net Income'), 'B3': cell(21132)
    }
  };
  const audit = auditStatic(sheetCells);
  const all = [...audit.fails, ...audit.warns];
  const types = new Set(all.map(i => i.type));
  assert.ok(types.has('duplicate_row_label'),
    'auditStatic should surface duplicate_row_label');
  // Cross-sheet may also fire — PnL has TWO values (21132 and -14459) and
  // Dashboard has 21132. The detector picks the spread between min and
  // max across all sheets → fail.
  console.log('OK auditStatic invokes new detectors (types: ' + [...types].join(', ') + ')');
}

console.log('\ncoherence detector tests completed.');
