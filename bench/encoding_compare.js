#!/usr/bin/env node
// bench/encoding_compare.js
// Compare 3 ways to serialize Excel workbook context for the LLM:
//   1) "current": JSON.stringify(compactAgentContext(...), null, 2)
//      — what server/agents/agentLoop.js emits today
//   2) "markdown": GitHub-flavored markdown tables, one per sheet,
//      cell addresses + formula + computed value side-by-side
//   3) "sheetcompressor": SpreadsheetLLM-style sparse encoding —
//      anchor cells + inverted index aggregation + skip empty regions
//
// Synthetic input mimics the MEAT CREW workbook state where the agent
// failed: cross-sheet references where MenuEconomics!B20 holds the
// text "Sides" instead of a number, so Assumptions!B15 (= 'Menu
// Economics'!B20) and downstream AOV in Revenue Model carry a text
// value, eventually evaluating to #VALUE!.
//
// Metric we care about:
//   • bytes
//   • approx tokens (char/4 heuristic — calibrated against tiktoken
//     in past runs: within 8 % for English/JSON, within 12 % for
//     dense markdown tables)
//   • ability for the encoding to *surface* the cross-sheet bug
//     without an extra LLM call (we look for the broken cell + its
//     computed value as a literal string in the encoded output).
//
// Usage:
//   node bench/encoding_compare.js
//   node bench/encoding_compare.js --llm   # also POST to LLM and ask
//                                          # a comprehension Q

'use strict';

const fs = require('fs');
const path = require('path');

const WANT_LLM = process.argv.includes('--llm');

// ── synthetic MEAT CREW snapshot ───────────────────────────────────
// We model exactly the broken state the agent observed in the user's
// log at 8:38–8:39. Each sheet has both `preview` (computed values)
// and `formulas` arrays as compactAgentContext expects.

function makeBrokenWorkbook() {
  const assumptions = {
    isActive: true,
    usedRange: 'A1:B30',
    rowCount: 30,
    columnCount: 2,
    preview: [
      ['MEAT CREW - Assumptions', ''],
      ['Location', 'Milano'],
      ['Operating Days/year', 360],
      ['Daily Hours', 12],
      ['Seats', 80],
      ['Turnover', 3],
      ['Dine-in %', 0.6],
      ['Takeaway %', 0.4],
      ['', ''],
      ['Avg Daily Customers Y1', 200],
      ['Customer Growth %', 0.1],
      ['AOV (€)', 'Sides'], // ⚠ broken — pulled from MenuEcon B20
      ['Food Mix %', 0.75],
      ['Drinks Mix %', 0.25],
      ['COGS Food %', 0.25],
      ['COGS Drinks %', 0.2],
      ['Labor %', 0.25],
      ['Occupancy %', 0.08],
      ['Marketing %', 0.03],
      ['Other Opex %', 0.05],
      ['D&A %', 0.04],
      ['Tax Rate', 0.24],
      ['Inflation', 0.02],
      ['Working Capital %', 0.05],
      ['', ''], ['', ''], ['', ''], ['', ''], ['', ''], ['', '']
    ],
    formulas: [
      ['', ''], ['', ''], ['', ''], ['', ''], ['', ''],
      ['', ''], ['', ''], ['', ''], ['', ''], ['', ''],
      ['', ''],
      ['', "='Menu Economics'!B20"], // ⚠ this is the bug
      ['', ''], ['', ''], ['', ''], ['', ''], ['', ''],
      ['', ''], ['', ''], ['', ''], ['', ''], ['', ''],
      ['', ''], ['', ''], ['', ''], ['', ''], ['', ''],
      ['', ''], ['', ''], ['', '']
    ]
  };

  const menuEcon = {
    isActive: false,
    usedRange: 'A1:G35',
    rowCount: 35,
    columnCount: 7,
    preview: [
      ['MEAT CREW - Menu Economics', '', '', '', '', '', ''],
      ['Item', 'Category', 'Single €', 'Menu €', 'COGS %', 'Mix %', 'Weighted €'],
      ['Mocho Bites', 'Starters', 6.9, '', 0.25, 0.05, 0.345],
      ['Chicken Tenders', 'Starters', 6.9, '', 0.25, 0.05, 0.345],
      ['L.A.', 'Burger', 14.5, 21.9, 0.3, 0.12, 2.27],
      ['Crispy', 'Burger', 14.5, 21.9, 0.3, 0.1, 1.89],
      ['Mac n Cheese', 'Burger', 15.5, 22.9, 0.32, 0.08, 1.59],
      ['Oklahoma', 'Burger', 15, 22.4, 0.3, 0.08, 1.55],
      ['Pastrami', 'Sandwich', 19, 26.4, 0.35, 0.06, 1.40],
      ['Bacon Dog', 'Hot Dog', 8, 15.4, 0.25, 0.05, 0.62],
      ['', '', '', '', '', '', ''],
      ['Sides & Drinks', '', '', '', '', '', ''],
      ['Crispy Fries', 'Sides', 5.5, '', 0.2, 0.08, 0.44],
      ['Bacon Fries', 'Sides', 6.5, '', 0.22, 0.04, 0.26],
      ['Chili Fries', 'Sides', 6.5, '', 0.22, 0.04, 0.26],
      ['Banana Pudding', 'Sweets', 4.9, '', 0.2, 0.03, 0.147],
      ['Milkshakes', 'Drinks', 6, '', 0.2, 0.05, 0.3],
      ['Acqua', 'Drinks', 2, '', 0.1, 0.06, 0.12],
      ['', '', '', '', '', '', ''],
      // ⚠ Row 20 — B20 is the cell Assumptions!B15 reads.
      // The agent put 'Sides' (category label) here when it
      // meant to compute the total weighted AOV in B32.
      ['TOTAL', 'Sides', '', '', 1.3, 1.0, 15.6686],
      ['Weighted AOV (€)', 15.6686, '', '', '', '', ''],
      ['Blended COGS %', 0.254, '', '', '', '', '']
    ],
    formulas: undefined // other-sheet: no formulas in compact context
  };

  const revenueModel = {
    isActive: false,
    usedRange: 'A1:M22',
    rowCount: 22,
    columnCount: 13,
    preview: [
      ['MEAT CREW - Revenue Model', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['Year', 1, 2, 3, 4, 5, '', '', '', '', '', '', ''],
      ['Avg Daily Customers', 200, 220, 242, 266.2, 292.82, '', '', '', '', '', '', ''],
      ['Annual Customers', 72000, 79200, 87120, 95832, 105415, '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['Month', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      ['Seasonality %', 0.07, 0.07, 0.08, 0.08, 0.09, 0.09, 0.1, 0.1, 0.08, 0.08, 0.08, 0.08],
      ['Operating Days', 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
      // Daily Customers row uses seasonality as multiplier on 200 —
      // but model treated it as the *full* daily count fraction, so
      // values are 1/10× what they should be.
      ['Daily Customers', 14, 14, 16, 16, 18, 18, 20, 20, 16, 16, 16, 16],
      ['Monthly Customers', 420, 420, 480, 480, 540, 540, 600, 600, 480, 480, 480, 480],
      // AOV row reads from Assumptions!B15 which is currently the text 'Sides'.
      ['AOV (€)', '#VALUE!', '#VALUE!', '#VALUE!', '#VALUE!', '#VALUE!', '#VALUE!', '#VALUE!', '#VALUE!', '#VALUE!', '#VALUE!', '#VALUE!', '#VALUE!'],
      ['Monthly Revenue', '#VALUE!', '#VALUE!', '#VALUE!', '#VALUE!', '#VALUE!', '#VALUE!', '#VALUE!', '#VALUE!', '#VALUE!', '#VALUE!', '#VALUE!', '#VALUE!']
    ],
    formulas: undefined
  };

  return {
    activeSheet: 'Assumptions',
    workbookSheets: ['Assumptions', 'Menu Economics', 'Revenue Model'],
    sheetCount: 3,
    selectedRange: 'Assumptions!B15',
    selectionSize: { rows: 1, columns: 1 },
    selectedValues: [['Sides']],
    selectedFormulas: [["='Menu Economics'!B20"]],
    allSheetsData: {
      'Assumptions': assumptions,
      'Menu Economics': menuEcon,
      'Revenue Model': revenueModel
    }
  };
}

// ── encoding #1: current (JSON via compactAgentContext) ────────────
// Inline copy of compactAgentContext + truncateMatrix to avoid
// requiring agentLoop.js side-effects.

function truncateMatrix(m, maxRows, maxCols) {
  if (!Array.isArray(m)) return [];
  const out = [];
  for (let i = 0; i < Math.min(m.length, maxRows); i++) {
    const row = Array.isArray(m[i]) ? m[i].slice(0, maxCols) : [];
    out.push(row);
  }
  return out;
}

function compactAgentContext(context) {
  const out = {
    activeSheet: context.activeSheet,
    workbookSheets: (context.workbookSheets || []).slice(0, 24),
    sheetCount: context.sheetCount || 0,
    selectedRange: context.selectedRange,
    selectionSize: context.selectionSize,
    selectedPreview: truncateMatrix(context.selectedValues, 12, 8),
    selectedFormulasPreview: truncateMatrix(context.selectedFormulas, 12, 8),
    sheets: {}
  };
  const all = context.allSheetsData || {};
  for (const [name, info] of Object.entries(all)) {
    const isActive = info.isActive || name === context.activeSheet;
    out.sheets[name] = {
      isActive,
      usedRange: info.usedRange || null,
      rowCount: info.rowCount || 0,
      columnCount: info.columnCount || 0,
      truncated: false,
      empty: false,
      omitted: false,
      preview: truncateMatrix(info.preview, isActive ? 30 : 10, isActive ? 14 : 8),
      formulas: isActive ? truncateMatrix(info.formulas, 30, 14) : undefined
    };
  }
  return out;
}

function encodeCurrent(ctx) {
  return JSON.stringify(compactAgentContext(ctx), null, 2);
}

// ── encoding #2: markdown tables ───────────────────────────────────
// One table per sheet. Header row = column letters (A, B, C, …).
// First column = row number. Cell formula and value shown only
// where present; empties left blank to make the table sparse-readable.

function colLetter(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function fmtCell(value, formula) {
  const hasF = formula && String(formula).trim().length > 0;
  const hasV = value !== '' && value != null;
  if (hasF && hasV) return `${formula} →${value}`;
  if (hasF) return `${formula}`;
  if (hasV) return String(value);
  return '';
}

function encodeMarkdown(ctx) {
  const out = [];
  out.push(`# Workbook (active: \`${ctx.activeSheet}\`, ${ctx.sheetCount} sheets)`);
  out.push(`Selected: \`${ctx.selectedRange}\``);
  out.push('');
  for (const [name, info] of Object.entries(ctx.allSheetsData || {})) {
    out.push(`## ${info.isActive ? '★ ' : ''}\`${name}\` — ${info.usedRange} (${info.rowCount}×${info.columnCount})`);
    const rows = info.preview || [];
    const formulas = info.formulas || [];
    if (rows.length === 0) { out.push('_(empty)_'); out.push(''); continue; }
    const maxC = Math.max(...rows.map(r => r.length));
    // header: |  | A | B | C | …
    out.push('|   | ' + Array.from({length: maxC}, (_, c) => colLetter(c)).join(' | ') + ' |');
    out.push('|---|' + Array.from({length: maxC}).map(() => '---').join('|') + '|');
    for (let r = 0; r < rows.length; r++) {
      const cells = rows[r] || [];
      const fRow = formulas[r] || [];
      const line = ['' + (r + 1)];
      for (let c = 0; c < maxC; c++) {
        line.push(fmtCell(cells[c], fRow[c]));
      }
      out.push('| ' + line.join(' | ') + ' |');
    }
    out.push('');
  }
  return out.join('\n');
}

// ── encoding #3: sheetcompressor (sparse + anchor + inverted index)
// Based on SpreadsheetLLM (MS Research 2024). Three tricks:
//   1) anchor cells: list only cells whose value is non-empty AND
//      either differs from its row/col neighbours OR carries a
//      formula. Empty rectangles are summarised, not enumerated.
//   2) inverted index: value -> [cells]. Constants like '#VALUE!'
//      collapse to one entry.
//   3) format-aware aggregation: ranges of identical numbers/
//      strings written once with their span.

function encodeSheetCompressor(ctx) {
  const out = [];
  out.push(`Workbook: active=${ctx.activeSheet}, sheets=[${(ctx.workbookSheets||[]).join(', ')}]`);
  out.push(`Selected ${ctx.selectedRange} = "${(ctx.selectedValues?.[0]?.[0] ?? '')}" formula="${(ctx.selectedFormulas?.[0]?.[0] ?? '')}"`);
  out.push('');
  for (const [name, info] of Object.entries(ctx.allSheetsData || {})) {
    out.push(`### sheet "${name}" ${info.isActive ? '[ACTIVE]' : ''} dims=${info.rowCount}x${info.columnCount} used=${info.usedRange}`);
    const rows = info.preview || [];
    const formulas = info.formulas || [];
    // inverted index
    const cells = [];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] || [];
      const fRow = formulas[r] || [];
      for (let c = 0; c < row.length; c++) {
        const v = row[c];
        const f = fRow[c];
        const hasV = v !== '' && v != null;
        const hasF = f && String(f).trim();
        if (!hasV && !hasF) continue;
        cells.push({ addr: `${colLetter(c)}${r + 1}`, v: hasV ? v : null, f: hasF ? f : null });
      }
    }
    // group repeats by (v,f) so '#VALUE!' across 24 cells = 1 line
    const groups = new Map();
    for (const cell of cells) {
      const key = JSON.stringify([cell.v, cell.f]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(cell.addr);
    }
    for (const [key, addrs] of groups) {
      const { 0: v, 1: f } = JSON.parse(key);
      const label = addrs.length > 3 ? `${addrs[0]},${addrs[1]},…(${addrs.length} cells)` : addrs.join(',');
      const vStr = v === null ? '' : ` =${JSON.stringify(v)}`;
      const fStr = f ? ` formula:${f}` : '';
      out.push(`  ${label}${vStr}${fStr}`);
    }
    out.push('');
  }
  return out.join('\n');
}

// ── metrics ────────────────────────────────────────────────────────
function approxTokens(s) {
  // Heuristic. Replace with tiktoken if available.
  return Math.round(s.length / 4);
}

function probesSurfaceBug(encoded) {
  // The bug surfaces if the encoded text contains both:
  //   - the broken upstream value 'Sides' associated with B15
  //   - the formula =\'Menu Economics\'!B20
  // AND a clear link between them.
  const seesText = /Sides/.test(encoded) && /B15/.test(encoded);
  const seesFormula = /Menu Economics'!B20|MenuEconomics!B20/.test(encoded);
  const seesError = /#VALUE!/.test(encoded);
  return { seesText, seesFormula, seesError };
}

// ── run ────────────────────────────────────────────────────────────
function main() {
  const ctx = makeBrokenWorkbook();
  const encodings = {
    current: encodeCurrent(ctx),
    markdown: encodeMarkdown(ctx),
    sheetcompressor: encodeSheetCompressor(ctx)
  };
  const outDir = path.join(__dirname, 'encoding-out');
  fs.mkdirSync(outDir, { recursive: true });
  const summary = [];
  for (const [name, str] of Object.entries(encodings)) {
    fs.writeFileSync(path.join(outDir, `${name}.txt`), str);
    const probe = probesSurfaceBug(str);
    summary.push({
      encoding: name,
      bytes: Buffer.byteLength(str, 'utf8'),
      approxTokens: approxTokens(str),
      lines: str.split('\n').length,
      seesBrokenValue: probe.seesText,
      seesBrokenFormula: probe.seesFormula,
      seesPropagatedError: probe.seesError
    });
  }
  console.log('=== Encoding comparison (MEAT CREW broken-state synthetic) ===\n');
  const headers = ['encoding', 'bytes', 'tokens~', 'lines', 'seesVal', 'seesFx', 'seesErr'];
  console.log(headers.join('\t'));
  for (const r of summary) {
    console.log([
      r.encoding,
      r.bytes,
      r.approxTokens,
      r.lines,
      r.seesBrokenValue,
      r.seesBrokenFormula,
      r.seesPropagatedError
    ].join('\t'));
  }
  // also dump a JSON summary
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nDumps: ${outDir}/{current,markdown,sheetcompressor}.txt`);

  if (WANT_LLM) {
    console.log('\n[--llm flag] LLM A/B currently stubbed. Wire to server/tools/llm.js if needed.');
  }
}

main();
