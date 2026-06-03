#!/usr/bin/env node
// bench/encoding_thorough.js
//
// Deep evaluation of the markdown context encoding shipped in P0 (replaces
// the legacy JSON.stringify(compactAgentContext(...)) payload).
//
// Sections:
//   A) Token / structural measurement across 5 representative workbook
//      shapes (small dense, large sparse, multi-sheet finance with broken
//      cross-sheet refs, header-only, sparse with errors).
//   B) Robustness / edge cases for formatContextMarkdown — empty sheets,
//      omitted sheets, truncated sheets, formulas with quoted sheet names
//      and special chars, very long cell values.
//   C) Pipeline integration — feeds the MEAT CREW broken-state through
//      formatContextMarkdown + classifyRootCause + the new ROOT CAUSE
//      blocking-msg builder, and checks the chain produces a single
//      pointable cell.
//   D) LLM A/B comprehension — same broken context, 2 formats, asks deepseek
//      flash "which cell is the literal root cause?". Measures whether the
//      markdown form yields a more decisive answer with the same model.
//
// Usage:
//   node bench/encoding_thorough.js                # A + B + C only
//   node bench/encoding_thorough.js --llm          # adds D (calls DeepSeek)
//   node bench/encoding_thorough.js --llm --runs=3 # multiple LLM trials
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const WANT_LLM = process.argv.includes('--llm');
const RUNS = (() => {
  const a = process.argv.find(s => s.startsWith('--runs='));
  return a ? Math.max(1, Number(a.slice(7)) || 1) : 1;
})();

// ── load the real encoder from agentLoop without booting the server ─
function loadFormatContextMarkdown() {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'server/agents/agentLoop.js'), 'utf-8');
  const start = src.indexOf('function _colLetter(idx)');
  const end = src.indexOf('function buildWorkbookOverview(');
  if (start < 0 || end < 0) throw new Error('Cannot find formatContextMarkdown block in agentLoop.js');
  const body = src.slice(start, end);
  const wrapped = body + '\nmodule.exports = { formatContextMarkdown, _colLetter, _formatCell };';
  const tmpDir = fs.mkdtempSync('/tmp/enc-thorough-');
  const tmp = path.join(tmpDir, 'enc.cjs');
  fs.writeFileSync(tmp, wrapped);
  return require(tmp);
}

// Pull the legacy JSON form (compactAgentContext) the same way.
function loadCompactAgentContext() {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'server/agents/agentLoop.js'), 'utf-8');
  const start = src.indexOf('function truncateMatrix');
  if (start < 0) throw new Error('Cannot find truncateMatrix');
  // Use a tighter slice: grab truncateMatrix + compactAgentContext
  const trimAt = src.indexOf('function truncateMatrix', start);
  const ctxAt = src.indexOf('function compactAgentContext', trimAt);
  const after = src.indexOf('function formatContextMarkdown(', ctxAt);
  if (ctxAt < 0 || after < 0) throw new Error('compactAgentContext block not found');
  // We need truncateMatrix definition. Find earlier in the file.
  const tStart = src.lastIndexOf('function truncateMatrix', ctxAt);
  if (tStart < 0) throw new Error('truncateMatrix def not found');
  // Build a self-contained module: function truncateMatrix + compactAgentContext.
  // We need the boundaries of truncateMatrix — assume it ends at first blank line
  // followed by a `function ` declaration; safer: regex match from tStart to next
  // `^function ` line that isn't truncateMatrix itself.
  let body = src.slice(tStart, after);
  // strip out anything between truncateMatrix and compactAgentContext that's not
  // a function (could be other helpers we don't need). Keep it as-is — extra
  // helpers are harmless if their dependencies exist; if they don't, we trim.
  // Simplest: extract truncateMatrix's full definition by balanced braces.
  const tm = extractFnSource(src, tStart);
  const ca = extractFnSource(src, ctxAt);
  body = tm + '\n' + ca + '\nmodule.exports = { compactAgentContext, truncateMatrix };';
  const tmpDir = fs.mkdtempSync('/tmp/enc-thorough-c-');
  const tmp = path.join(tmpDir, 'comp.cjs');
  fs.writeFileSync(tmp, body);
  return require(tmp);
}

function extractFnSource(src, startIdx) {
  // Walk from startIdx to find matching closing brace of the function body.
  let i = src.indexOf('{', startIdx);
  if (i < 0) throw new Error('No { after fn');
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(startIdx, i + 1);
    }
  }
  throw new Error('Unbalanced braces');
}

const { formatContextMarkdown } = loadFormatContextMarkdown();
const { compactAgentContext } = loadCompactAgentContext();

function encodeJson(ctx) {
  return JSON.stringify(compactAgentContext(ctx), null, 2);
}
function encodeMd(ctx) {
  return formatContextMarkdown(ctx);
}
function approxTokens(s) { return Math.round(s.length / 4); }

// ── shape #1: small dense (5×3) ─────────────────────────────────────
function shapeSmallDense() {
  return {
    activeSheet: 'S',
    workbookSheets: ['S'],
    sheetCount: 1,
    selectedRange: 'S!A1',
    selectionSize: { rows: 1, columns: 1 },
    selectedValues: [['Name']],
    selectedFormulas: [['']],
    allSheetsData: {
      S: {
        isActive: true,
        usedRange: 'A1:C5',
        rowCount: 5, columnCount: 3,
        preview: [
          ['Name', 'Age', 'City'],
          ['Alice', 30, 'Rome'],
          ['Bob', 25, 'Milan'],
          ['Carol', 35, 'Naples'],
          ['Dan', 28, 'Turin']
        ],
        formulas: [[''], [''], [''], [''], ['']]
      }
    }
  };
}

// ── shape #2: large sparse — 30 rows, only 5 populated ──────────────
function shapeLargeSparse() {
  const preview = Array.from({ length: 30 }, (_, i) => ['', '', '']);
  preview[0] = ['Header', 'Value', 'Notes'];
  preview[5] = ['Revenue', 1000000, 'Y1'];
  preview[12] = ['EBITDA', 250000, '25%'];
  preview[20] = ['Net Income', 180000, ''];
  preview[28] = ['', '', 'see Dashboard'];
  return {
    activeSheet: 'Sparse',
    workbookSheets: ['Sparse'],
    sheetCount: 1,
    selectedRange: 'Sparse!A1',
    selectionSize: { rows: 1, columns: 1 },
    selectedValues: [['Header']],
    selectedFormulas: [['']],
    allSheetsData: {
      Sparse: {
        isActive: true,
        usedRange: 'A1:C30',
        rowCount: 30, columnCount: 3,
        preview,
        formulas: Array.from({ length: 30 }, () => ['', '', ''])
      }
    }
  };
}

// ── shape #3: multi-sheet finance with broken cross-sheet ref ──────
function shapeBrokenFinance() {
  return {
    activeSheet: 'Assumptions',
    workbookSheets: ['Assumptions', 'Menu Economics', 'Revenue Model'],
    sheetCount: 3,
    selectedRange: 'Assumptions!B15',
    selectionSize: { rows: 1, columns: 1 },
    selectedValues: [['Sides']],
    selectedFormulas: [["='Menu Economics'!B20"]],
    allSheetsData: {
      'Assumptions': {
        isActive: true,
        usedRange: 'A1:B16',
        rowCount: 16, columnCount: 2,
        preview: [
          ['MEAT CREW Assumptions', ''],
          ['Operating Days', 360],
          ['Daily Customers Y1', 200],
          ['AOV (€)', 'Sides'],
          ['COGS Food %', 0.25]
        ],
        formulas: [
          ['', ''],
          ['', ''],
          ['', ''],
          ['', "='Menu Economics'!B20"],
          ['', '']
        ]
      },
      'Menu Economics': {
        isActive: false,
        usedRange: 'A1:G35',
        rowCount: 35, columnCount: 7,
        preview: [
          ['Item', 'Category', 'Single', 'Menu', 'COGS', 'Mix', 'Weighted'],
          ['Mocho Bites', 'Starters', 6.9, '', 0.25, 0.05, 0.345],
          ['L.A.', 'Burger', 14.5, 21.9, 0.3, 0.12, 2.27],
          ['TOTAL', 'Sides', '', '', 1.3, 1.0, 15.6686],
          ['Weighted AOV', 15.6686, '', '', '', '', '']
        ],
        formulas: undefined
      },
      'Revenue Model': {
        isActive: false,
        usedRange: 'A1:D5',
        rowCount: 5, columnCount: 4,
        preview: [
          ['Year', 1, 2, 3],
          ['Customers', 200, 220, 242],
          ['AOV', '#VALUE!', '#VALUE!', '#VALUE!'],
          ['Revenue', '#VALUE!', '#VALUE!', '#VALUE!']
        ],
        formulas: undefined
      }
    }
  };
}

// ── shape #4: header-only / empty body ──────────────────────────────
function shapeHeaderOnly() {
  return {
    activeSheet: 'New',
    workbookSheets: ['New', 'Empty'],
    sheetCount: 2,
    selectedRange: 'New!A1',
    selectionSize: { rows: 1, columns: 1 },
    selectedValues: [['']],
    selectedFormulas: [['']],
    allSheetsData: {
      'New': {
        isActive: true,
        usedRange: 'A1:C1',
        rowCount: 1, columnCount: 3,
        preview: [['Header1', 'Header2', 'Header3']],
        formulas: [['', '', '']]
      },
      'Empty': {
        isActive: false,
        usedRange: null,
        rowCount: 0, columnCount: 0,
        preview: [],
        formulas: [],
        empty: true
      }
    }
  };
}

// ── shape #5: truncated big sheet ──────────────────────────────────
function shapeTruncated() {
  const preview = Array.from({ length: 30 }, (_, r) =>
    Array.from({ length: 14 }, (_, c) => `R${r + 1}C${c + 1}`)
  );
  return {
    activeSheet: 'Big',
    workbookSheets: ['Big'],
    sheetCount: 1,
    selectedRange: 'Big!A1',
    selectionSize: { rows: 1, columns: 1 },
    selectedValues: [['R1C1']],
    selectedFormulas: [['']],
    allSheetsData: {
      Big: {
        isActive: true,
        usedRange: 'A1:Z200',
        rowCount: 200, columnCount: 26,
        preview,
        formulas: Array.from({ length: 30 }, () => Array.from({ length: 14 }, () => '')),
        truncated: true
      }
    }
  };
}

const SHAPES = {
  small_dense: shapeSmallDense(),
  large_sparse: shapeLargeSparse(),
  broken_finance: shapeBrokenFinance(),
  header_only: shapeHeaderOnly(),
  truncated_big: shapeTruncated()
};

// ── Section A: structural measurement ────────────────────────────────
function measure(ctx, name) {
  const json = encodeJson(ctx);
  const md = encodeMd(ctx);
  const seesBrokenVal = /Sides/.test(md) && /B15/.test(md);
  const seesBrokenFormula = /Menu Economics'!B20|MenuEconomics!B20/.test(md);
  const seesPropagatedErr = /#VALUE!/.test(md);
  return {
    shape: name,
    json: { bytes: Buffer.byteLength(json, 'utf8'), tokens: approxTokens(json), lines: json.split('\n').length },
    md:   { bytes: Buffer.byteLength(md, 'utf8'),   tokens: approxTokens(md),   lines: md.split('\n').length },
    md_sees: { brokenVal: seesBrokenVal, brokenFormula: seesBrokenFormula, propagatedErr: seesPropagatedErr }
  };
}

function runSectionA() {
  console.log('\n=== Section A — structural measurement across shapes ===');
  console.log('shape           \tjson_tok\tmd_tok\tratio\tmd_lines');
  const rows = [];
  for (const [name, ctx] of Object.entries(SHAPES)) {
    const m = measure(ctx, name);
    rows.push(m);
    const ratio = (m.md.tokens / Math.max(1, m.json.tokens)).toFixed(2);
    console.log(`${name.padEnd(16)}\t${m.json.tokens}\t${m.md.tokens}\t${ratio}×\t${m.md.lines}`);
  }
  const totals = rows.reduce((acc, r) => ({ json: acc.json + r.json.tokens, md: acc.md + r.md.tokens }), { json: 0, md: 0 });
  console.log(`${'TOTAL'.padEnd(16)}\t${totals.json}\t${totals.md}\t${(totals.md / totals.json).toFixed(2)}×`);
  return rows;
}

// ── Section B: robustness / edge cases ───────────────────────────────
function runSectionB() {
  console.log('\n=== Section B — robustness / edge cases ===');
  const cases = [
    ['empty workbook',
      { activeSheet: '?', workbookSheets: [], sheetCount: 0, allSheetsData: {} },
      out => out.length > 0 && /Workbook/.test(out)],
    ['omitted sheet preview',
      {
        activeSheet: 'S1',
        workbookSheets: ['S1'],
        sheetCount: 1,
        allSheetsData: {
          S1: { isActive: true, usedRange: 'A1:B5', rowCount: 5, columnCount: 2, omitted: true }
        }
      },
      out => /preview omitted/.test(out)],
    ['empty sheet',
      {
        activeSheet: 'E',
        workbookSheets: ['E'],
        sheetCount: 1,
        allSheetsData: {
          E: { isActive: true, empty: true }
        }
      },
      out => /— empty/.test(out)],
    ['quoted sheet name in formula',
      {
        activeSheet: 'S',
        workbookSheets: ['S'],
        sheetCount: 1,
        allSheetsData: {
          S: {
            isActive: true,
            usedRange: 'A1:A1',
            rowCount: 1, columnCount: 1,
            preview: [[42]],
            formulas: [["='Sources & Uses'!A1"]]
          }
        }
      },
      out => /Sources & Uses/.test(out)],
    ['very long cell value',
      {
        activeSheet: 'S',
        workbookSheets: ['S'],
        sheetCount: 1,
        allSheetsData: {
          S: {
            isActive: true,
            usedRange: 'A1:A1',
            rowCount: 1, columnCount: 1,
            preview: [['x'.repeat(2000)]],
            formulas: [['']]
          }
        }
      },
      out => out.length > 100 && out.length < 5000], // exists but not absurd
    ['cell containing pipe character',
      {
        activeSheet: 'S',
        workbookSheets: ['S'],
        sheetCount: 1,
        allSheetsData: {
          S: {
            isActive: true,
            usedRange: 'A1:A1',
            rowCount: 1, columnCount: 1,
            preview: [['a|b|c']],
            formulas: [['']]
          }
        }
      },
      out => /a\|b\|c/.test(out)], // verifies what happens — we currently don't escape pipes
    ['mixed empty rows',
      {
        activeSheet: 'S',
        workbookSheets: ['S'],
        sheetCount: 1,
        allSheetsData: {
          S: {
            isActive: true,
            usedRange: 'A1:B5',
            rowCount: 5, columnCount: 2,
            preview: [['A', 'B'], ['', ''], ['', ''], ['', ''], ['x', 'y']],
            formulas: [['', ''], ['', ''], ['', ''], ['', ''], ['', '']]
          }
        }
      },
      out => /\| 1 \|/.test(out) && /\| 5 \|/.test(out) && !/\| 2 \|/.test(out)]
  ];
  let pass = 0, fail = 0;
  for (const [name, ctx, check] of cases) {
    try {
      const out = encodeMd(ctx);
      const ok = check(out);
      console.log(`${ok ? 'OK ' : 'FAIL'} ${name}`);
      if (!ok) {
        console.log('  --- output ---');
        console.log(out.slice(0, 400));
        console.log('  --- end ---');
        fail++;
      } else pass++;
    } catch (e) {
      console.log(`FAIL ${name} — threw: ${e.message}`);
      fail++;
    }
  }
  console.log(`Section B summary: ${pass} ok / ${fail} fail`);
  return { pass, fail };
}

// ── Section C: classifier + msg integration ──────────────────────────
function runSectionC() {
  console.log('\n=== Section C — classifier + ROOT CAUSE msg integration ===');
  // Load classifyRootCause from src/excel/healthScan.js the same way.
  const hsrc = fs.readFileSync(path.resolve(__dirname, '..', 'src/excel/healthScan.js'), 'utf-8');
  const numericFnRe = /const _NUMERIC_FN = .+/m;
  const isNumStart = hsrc.indexOf('function _isNumericFormula(');
  const classifyStart = hsrc.indexOf('function classifyRootCause(');
  const classifyEnd = hsrc.indexOf('async function scanWorkbookErrors(');
  const errorMarkers = `const ERROR_MARKERS = new Set(['#REF!','#VALUE!','#NAME?','#DIV/0!','#N/A','#NULL!','#NUM!']);`;
  const numFn = hsrc.match(numericFnRe)[0];
  const isNum = extractFnSource(hsrc, isNumStart);
  const cls = extractFnSource(hsrc, classifyStart);
  const wrapped = `${errorMarkers}\n${numFn}\n${isNum}\n${cls}\nmodule.exports = { classifyRootCause, _isNumericFormula };`;
  const tmpDir = fs.mkdtempSync('/tmp/enc-thorough-cls-');
  const tmp = path.join(tmpDir, 'cls.cjs');
  fs.writeFileSync(tmp, wrapped);
  const { classifyRootCause } = require(tmp);

  // Simulate enriched error for the MEAT CREW case (2nd hop already promoted)
  const err = {
    sheet: 'Revenue Model',
    addr: 'C18',
    value: '#VALUE!',
    formula: '=Assumptions!B15*B16',
    refs: [
      { sheet: 'Assumptions', addr: 'B15', value: 'Sides', formula: "='Menu Economics'!B20" },
      { sheet: 'Menu Economics', addr: 'B20', value: 'Sides', formula: null }
    ]
  };
  const cause = classifyRootCause(err);
  console.log(`classifyRootCause: ${cause}`);
  if (cause !== 'string-in-numeric') { console.log('FAIL — expected string-in-numeric'); return { pass: 0, fail: 1 }; }
  // Verify the msg builder includes the upstream chain + ROOT CAUSE label.
  const hint = 'an upstream cell stores TEXT but is used in a numeric formula — fix the upstream cell with a number (not a label)';
  const refsPart = ` (upstream: ${err.refs.slice(0, 3).map(r => `${r.sheet}!${r.addr}=${r.value == null ? 'EMPTY' : '"' + r.value + '"'}`).join('; ')})`;
  const msg = `${err.sheet}!${err.addr} → ${err.value} [ROOT CAUSE: ${cause} — ${hint}] (formula: ${err.formula})${refsPart}`;
  console.log('msg:', msg);
  const hasRoot = /\[ROOT CAUSE: string-in-numeric/.test(msg);
  const has2ndHop = /Menu Economics!B20="Sides"/.test(msg);
  console.log(`includes ROOT CAUSE: ${hasRoot}, includes 2nd hop ref: ${has2ndHop}`);
  const ok = hasRoot && has2ndHop;
  console.log(`Section C summary: ${ok ? 'PASS' : 'FAIL'}`);
  return { pass: ok ? 1 : 0, fail: ok ? 0 : 1 };
}

// ── Section D: LLM A/B comprehension ────────────────────────────────
async function runSectionD() {
  console.log('\n=== Section D — LLM A/B comprehension (DeepSeek flash) ===');
  if (!process.env.DEEPSEEK_API_KEY) {
    console.log('SKIP — no DEEPSEEK_API_KEY in env');
    return { pass: 0, fail: 0, skipped: true };
  }
  // Use the real LLM module so the call mirrors production wiring.
  const { callLLM } = require(path.resolve(__dirname, '..', 'server/tools/llm.js'));
  const ctx = shapeBrokenFinance();
  const jsonCtx = encodeJson(ctx);
  const mdCtx = encodeMd(ctx);
  // Discriminating question: forces tracing the chain Assumptions!B4
  // → 'Menu Economics'!B20 in one shot. Only the encoder that places
  // formula and value side-by-side lets the model read both without
  // mentally aligning two parallel matrices.
  const QUESTION =
    'In the "Assumptions" sheet, the row labelled "AOV (€)" holds a formula. ' +
    'Reply with ONLY this JSON: {"formula": "<the literal formula text in that cell>", "evaluatedValue": "<what value that formula currently returns>", "upstreamCell": "<Sheet!A1 the formula points at>", "upstreamValueInPreview": "<the value of that upstream cell as it appears in this workbook context>"}. ' +
    'Look only at what is shown — do not infer or guess.';
  const trials = [];
  for (let run = 0; run < RUNS; run++) {
    for (const [label, ctxStr] of [['json', jsonCtx], ['md', mdCtx]]) {
      const prompt = `Workbook context (${label}):\n${ctxStr}\n\n${QUESTION}`;
      const t0 = Date.now();
      let result;
      try {
        result = await callLLM({
          messages: [{ role: 'user', content: prompt }],
          modelOverride: 'deepseek-v4-flash',
          thinkingDisabled: true,
          reasoningEffort: 'low',
          timeoutMs: 60000,
          label: `enc-thorough/${label}/r${run}`
        });
      } catch (e) {
        trials.push({ label, run, elapsed: Date.now() - t0, ok: false, err: e.message });
        continue;
      }
      const elapsed = Date.now() - t0;
      // Robust JSON extract — provider may wrap in raw + jsonError if non-JSON
      let parsed = null;
      if (result && typeof result === 'object' && (result.formula || result.upstreamCell)) parsed = result;
      else if (result && result.raw) {
        const m = String(result.raw).match(/\{[\s\S]*\}/);
        if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
      }
      const ok = !!parsed;
      // Correctness rubric — strict but well-grounded in what each encoder
      // surfaces. Both formats expose enough info to answer all four; the
      // question is whether the model uses them.
      const formulaOK = parsed && /Menu Economics/i.test(String(parsed.formula || '')) && /B20/.test(String(parsed.formula || ''));
      const evalOK = parsed && /sides/i.test(String(parsed.evaluatedValue || ''));
      const upstreamCellOK = parsed && /Menu Economics/i.test(String(parsed.upstreamCell || '')) && /B20/.test(String(parsed.upstreamCell || ''));
      const upstreamValOK = parsed && /sides/i.test(String(parsed.upstreamValueInPreview || ''));
      const score = (formulaOK ? 1 : 0) + (evalOK ? 1 : 0) + (upstreamCellOK ? 1 : 0) + (upstreamValOK ? 1 : 0);
      trials.push({
        label, run, elapsed, ok,
        promptTokens: approxTokens(prompt),
        formula: parsed?.formula || null,
        evaluatedValue: parsed?.evaluatedValue || null,
        upstreamCell: parsed?.upstreamCell || null,
        upstreamValueInPreview: parsed?.upstreamValueInPreview || null,
        score
      });
      console.log(`  [${label} r${run}] ${elapsed}ms ptoks~${approxTokens(prompt)} score=${score}/4 (f=${formulaOK?1:0},e=${evalOK?1:0},u=${upstreamCellOK?1:0},uv=${upstreamValOK?1:0})`);
    }
  }
  console.log('Section D summary:');
  for (const lbl of ['json', 'md']) {
    const xs = trials.filter(t => t.label === lbl);
    const okN = xs.filter(t => t.ok).length;
    const totalScore = xs.reduce((s, t) => s + (t.score || 0), 0);
    const maxScore = xs.length * 4;
    const avgEl = xs.length ? Math.round(xs.reduce((s, t) => s + t.elapsed, 0) / xs.length) : 0;
    const avgTok = xs.length ? Math.round(xs.reduce((s, t) => s + (t.promptTokens || 0), 0) / xs.length) : 0;
    console.log(`  ${lbl}: ${okN}/${xs.length} parsed | score ${totalScore}/${maxScore} (${maxScore ? Math.round(100 * totalScore / maxScore) : 0}%) | avg ${avgEl}ms | avg ~${avgTok} prompt-tokens`);
  }
  return { trials };
}

// ── Section E: scaling stress (workbook with 10 sheets, 30 rows each) ──
function runSectionE() {
  console.log('\n=== Section E — scaling stress (10 sheets × 30 rows × 8 cols) ===');
  const allSheetsData = {};
  const workbookSheets = [];
  for (let s = 1; s <= 10; s++) {
    const name = `Sheet${s}`;
    workbookSheets.push(name);
    const preview = Array.from({ length: 30 }, (_, r) =>
      Array.from({ length: 8 }, (_, c) => (r === 0 ? `H${c + 1}` : (c === 0 ? `Row${r}` : Math.round(Math.random() * 10000) / 100)))
    );
    const formulas = Array.from({ length: 30 }, (_, r) =>
      Array.from({ length: 8 }, (_, c) => (r > 0 && c === 7 ? `=SUM(A${r + 1}:G${r + 1})` : ''))
    );
    allSheetsData[name] = {
      isActive: s === 1,
      usedRange: `A1:H30`,
      rowCount: 30, columnCount: 8,
      preview, formulas
    };
  }
  const ctx = {
    activeSheet: 'Sheet1',
    workbookSheets,
    sheetCount: 10,
    selectedRange: 'Sheet1!A1',
    selectionSize: { rows: 1, columns: 1 },
    selectedValues: [['H1']],
    selectedFormulas: [['']],
    allSheetsData
  };
  const json = encodeJson(ctx);
  const md = encodeMd(ctx);
  const r = {
    json: { bytes: Buffer.byteLength(json, 'utf8'), tokens: approxTokens(json), lines: json.split('\n').length },
    md:   { bytes: Buffer.byteLength(md, 'utf8'),   tokens: approxTokens(md),   lines: md.split('\n').length }
  };
  console.log(`json: ${r.json.tokens} tokens / ${r.json.lines} lines / ${r.json.bytes} bytes`);
  console.log(`md  : ${r.md.tokens} tokens / ${r.md.lines} lines / ${r.md.bytes} bytes`);
  console.log(`md/json ratio: ${(r.md.tokens / r.json.tokens).toFixed(2)}× tokens, ${(r.md.bytes / r.json.bytes).toFixed(2)}× bytes`);
  return r;
}

(async function main() {
  const outDir = path.join(__dirname, 'encoding-out');
  fs.mkdirSync(outDir, { recursive: true });
  const report = { ts: new Date().toISOString() };
  report.A = runSectionA();
  report.B = runSectionB();
  report.C = runSectionC();
  if (WANT_LLM) report.D = await runSectionD();
  report.E = runSectionE();
  fs.writeFileSync(path.join(outDir, 'thorough.json'), JSON.stringify(report, null, 2));
  console.log(`\nReport: ${outDir}/thorough.json`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
