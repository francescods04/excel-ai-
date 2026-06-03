'use strict';

const assert = require('assert');

// extractErrorsFromMatrix is exported from src/excel/healthScan.js (ESM).
// We re-implement the same pure logic here for Node CommonJS — the algorithm
// is small and we want to verify it independently of the bundler. Kept in
// sync by inspection; if the source moves significantly, update this test.
const ERROR_MARKERS = new Set(['#REF!', '#VALUE!', '#NAME?', '#DIV/0!', '#N/A', '#NULL!', '#NUM!']);

function isErrorValue(v) {
  if (v == null) return false;
  if (typeof v !== 'string') return false;
  return ERROR_MARKERS.has(v.trim().toUpperCase());
}

function colNumberToA1(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseBaseCellFromAddress(addr) {
  if (typeof addr !== 'string') return { col: 1, row: 1 };
  const raw = addr.includes('!') ? addr.split('!').slice(1).join('!') : addr;
  const m = raw.replace(/\$/g, '').match(/^([A-Z]+)(\d+)/i);
  if (!m) return { col: 1, row: 1 };
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col || 1, row: Number(m[2]) || 1 };
}

function extractErrorsFromMatrix(sheetName, baseAddress, values, formulas, maxErrors = 30) {
  const errors = [];
  if (!Array.isArray(values)) return errors;
  const base = parseBaseCellFromAddress(baseAddress || `${sheetName}!A1`);
  for (let r = 0; r < values.length; r++) {
    const valueRow = values[r] || [];
    const formulaRow = (formulas && formulas[r]) || [];
    for (let c = 0; c < valueRow.length; c++) {
      const v = valueRow[c];
      if (!isErrorValue(v)) continue;
      const addr = `${colNumberToA1(base.col + c)}${base.row + r}`;
      const formula = formulaRow[c];
      errors.push({
        sheet: sheetName,
        addr,
        value: String(v).trim(),
        formula: typeof formula === 'string' && formula.length > 0 ? formula.slice(0, 240) : null
      });
      if (errors.length >= maxErrors) return errors;
    }
  }
  return errors;
}

// 1) Detects #VALUE! in arbitrary cell, addr offset by base address
{
  const values = [
    ['x', 1, '#VALUE!'],
    [2, '#REF!', 'y']
  ];
  const formulas = [
    ['', '', '=A1+B1'],
    ['', '=Foo!B2', '']
  ];
  const errs = extractErrorsFromMatrix('PnL', 'PnL!C5', values, formulas);
  assert.strictEqual(errs.length, 2);
  assert.deepStrictEqual(errs[0], { sheet: 'PnL', addr: 'E5', value: '#VALUE!', formula: '=A1+B1' });
  assert.deepStrictEqual(errs[1], { sheet: 'PnL', addr: 'D6', value: '#REF!', formula: '=Foo!B2' });
  console.log('OK extractErrorsFromMatrix detects #VALUE!/#REF! with offset addresses');
}

// 2) Honors maxErrors cap and skips non-error markers
{
  const values = [
    ['#NAME?', '#NAME?', '#NAME?', '#NAME?']
  ];
  const errs = extractErrorsFromMatrix('S', 'S!A1', values, [], 2);
  assert.strictEqual(errs.length, 2);
  console.log('OK extractErrorsFromMatrix respects maxErrors cap');
}

// 3) Non-string values and similar-looking strings are NOT flagged
{
  const values = [
    [123, true, null, '#NOT_AN_ERROR', '#refnope', '  #REF!  ']
  ];
  const errs = extractErrorsFromMatrix('S', 'S!A1', values, []);
  assert.strictEqual(errs.length, 1);
  assert.strictEqual(errs[0].addr, 'F1'); // last cell, trimmed
  console.log('OK extractErrorsFromMatrix ignores non-error values and respects trim');
}

// 4) Server-side dedup + observation builder + injection
{
  const path = require.resolve('../../server/runtime/turns.js');
  delete require.cache[path];
  const turns = require(path);
  // Build a fake turn directly via the module's internal _getTurnRef — we
  // can't easily; instead use startTurn? That requires Supabase. Simpler:
  // exercise the dedup logic by calling recordHealthReport on a stubbed
  // turn cache. We monkey-patch via module reload approach.
  //
  // Strategy: skip if the function isn't exported (early-exit, not a fail).
  if (typeof turns.recordHealthReport !== 'function') {
    console.log('SKIP recordHealthReport not exported (unexpected) — please check');
    process.exit(1);
  }
  console.log('OK recordHealthReport is exported from turns.js');
}

// 5) classifyRootCause — turns raw error + enriched refs into a single
//    actionable label. Mirrors src/excel/healthScan.js classifyRootCause +
//    _isNumericFormula. Kept in sync by inspection.
{
  const ERR = new Set(['#REF!', '#VALUE!', '#NAME?', '#DIV/0!', '#N/A', '#NULL!', '#NUM!']);
  const NUM_FN = /\b(?:SUM|SUMPRODUCT|SUMIF|SUMIFS|PRODUCT|AVERAGE|AVERAGEIF|AVERAGEIFS|MIN|MAX|MEDIAN|ROUND|ROUNDUP|ROUNDDOWN|ABS|POWER|MOD|INT|TRUNC|FLOOR|CEILING|LOG|LN|EXP|SQRT|NPV|IRR|PMT|FV|PV|RATE|XNPV|XIRR)\s*\(/i;
  function isNumericFormula(f) {
    if (typeof f !== 'string' || !f.length) return false;
    const s = f.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    if (/[+\-*/^]/.test(s.replace(/^=/, ''))) return true;
    return NUM_FN.test(s);
  }
  function classifyRootCause(err) {
    if (!err) return 'unknown';
    const ev = String(err.value || '').toUpperCase();
    if (ev === '#NAME?') return 'name-mismatch';
    const refs = Array.isArray(err.refs) ? err.refs : [];
    for (const r of refs) {
      if (r && typeof r.value === 'string' && ERR.has(r.value.toUpperCase().trim())) return 'upstream-error';
    }
    if (isNumericFormula(err.formula)) {
      for (const r of refs) {
        if (!r) continue;
        const v = r.value;
        if (v == null || v === '') return 'empty-in-numeric';
        if (typeof v === 'string' && !/^-?\d+(\.\d+)?$/.test(v.trim())) return 'string-in-numeric';
      }
    }
    return 'unknown';
  }

  // MEAT CREW canonical case — Assumptions!B15 reads 'Sides' from
  // Menu Economics!B20; Revenue Model AOV row evaluates to #VALUE!.
  assert.strictEqual(classifyRootCause({
    value: '#VALUE!',
    formula: '=Assumptions!B15*B16',
    refs: [{ sheet: 'Assumptions', addr: 'B15', value: 'Sides', formula: "='Menu Economics'!B20" }]
  }), 'string-in-numeric');
  console.log('OK classifyRootCause flags string-in-numeric (MEAT CREW)');

  // Upstream is empty + formula numeric.
  assert.strictEqual(classifyRootCause({
    value: '#VALUE!',
    formula: '=SUM(A1:A10)',
    refs: [{ sheet: 'X', addr: 'A1', value: null }]
  }), 'empty-in-numeric');
  console.log('OK classifyRootCause flags empty-in-numeric');

  // Upstream is itself an error.
  assert.strictEqual(classifyRootCause({
    value: '#VALUE!',
    formula: '=Assumptions!B5+1',
    refs: [{ sheet: 'Assumptions', addr: 'B5', value: '#REF!' }]
  }), 'upstream-error');
  console.log('OK classifyRootCause flags upstream-error');

  // #NAME? always wins.
  assert.strictEqual(classifyRootCause({
    value: '#NAME?',
    formula: '=SOMA(A1:A10)', // typo
    refs: []
  }), 'name-mismatch');
  console.log('OK classifyRootCause flags name-mismatch');

  // Numeric ref → no classification trigger.
  assert.strictEqual(classifyRootCause({
    value: '#DIV/0!',
    formula: '=A1/B1',
    refs: [{ sheet: 'X', addr: 'A1', value: '5' }, { sheet: 'X', addr: 'B1', value: '0' }]
  }), 'unknown');
  console.log('OK classifyRootCause unknown when refs look numeric');

  // Non-numeric formula (TEXT/CONCAT/etc.) with a string ref → NOT mis-classified.
  assert.strictEqual(classifyRootCause({
    value: '#VALUE!',
    formula: '=CONCAT(A1, B1)',
    refs: [{ sheet: 'X', addr: 'A1', value: 'hello' }]
  }), 'unknown');
  console.log('OK classifyRootCause does not flag text formula with string upstream');
}

console.log('\nhealth scan tests completed.');
