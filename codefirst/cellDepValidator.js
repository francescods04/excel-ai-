'use strict';

// Cell-level dependency validator — simulates what Excel will do with the
// generated actions BEFORE deploy. Catches the bugs that cause #REF!/#NAME?/
// #VALUE! at runtime.
//
// Checks:
//  1. broken_cell_ref:    formula refs cell that's never written
//  2. string_in_arith:    formula multiplies/sums a string cell
//  3. array_in_cell:      cell value is "1,2,3,4,..." text → #VALUE! when used
//  4. self_ref:           cell formula references itself
//  5. circular_ref:       short circular chain (a→b→a)
//  6. div_by_literal_zero

function isAddrLike(s) {
  return typeof s === 'string' && /^\$?[A-Z]+\$?\d+$/.test(s);
}

// Normalize "A$3" or "$A3" to "A3"
function stripDollar(addr) { return addr.replace(/\$/g, ''); }

// Functions that take a cell/range as positional arg (don't evaluate its value arithmetically).
// Refs inside these don't need to be numeric.
const POSITIONAL_REF_FNS = new Set(['COLUMN', 'ROW', 'COLUMNS', 'ROWS', 'INDEX', 'MATCH', 'OFFSET', 'INDIRECT', 'ADDRESS', 'CELL', 'ISERROR', 'ISBLANK', 'ISNUMBER', 'ISTEXT', 'COUNTA', 'COUNTBLANK', 'COUNTIF', 'COUNTIFS', 'IFERROR', 'IFNA', 'IF']);

// Check if a position in the formula is inside any of the named functions
function isInsidePositionalFn(formula, pos) {
  // Walk backwards from pos, count parentheses, find an enclosing function name
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const ch = formula[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      if (depth === 0) {
        // Found enclosing open paren — read function name immediately before
        let j = i - 1;
        let name = '';
        while (j >= 0 && /[A-Za-z]/.test(formula[j])) { name = formula[j] + name; j--; }
        if (name && POSITIONAL_REF_FNS.has(name.toUpperCase())) return true;
        // Not a positional fn — keep walking outward
      } else {
        depth--;
      }
    }
  }
  return false;
}

// Extract cell refs from a formula string. Returns list of {sheet, addr, posIdx}.
// Skips ref tokens inside "..." strings.
function extractCellRefs(formula) {
  if (typeof formula !== 'string') return [];
  const stripped = formula.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const refs = [];
  // Cross-sheet: 'SheetName'!$A$1 or SheetName!A1
  const reCross = /(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_ .]*))!(\$?[A-Z]+\$?\d+)(?::(\$?[A-Z]+\$?\d+))?/g;
  let m;
  while ((m = reCross.exec(stripped))) {
    const sheet = (m[1] || m[2] || '').trim();
    const a1 = stripDollar(m[3]);
    const a2 = m[4] ? stripDollar(m[4]) : null;
    const positional = isInsidePositionalFn(stripped, m.index);
    if (a2) {
      for (const c of expandRange(a1, a2)) refs.push({ sheet, addr: c, positional });
    } else {
      refs.push({ sheet, addr: a1, positional });
    }
  }
  // Same-sheet: A1, B5:B10 (after the cross-sheet pass)
  // Mask out cross-sheet hits so we don't double-count
  const masked = stripped.replace(reCross, '');
  const reLocal = /(?<![A-Za-z_!])(\$?[A-Z]+\$?\d+)(?::(\$?[A-Z]+\$?\d+))?/g;
  while ((m = reLocal.exec(masked))) {
    const a1 = stripDollar(m[1]);
    const a2 = m[2] ? stripDollar(m[2]) : null;
    const positional = isInsidePositionalFn(masked, m.index);
    if (a2) {
      for (const c of expandRange(a1, a2)) refs.push({ sheet: null, addr: c, positional });
    } else {
      refs.push({ sheet: null, addr: a1, positional });
    }
  }
  return refs;
}

function colToNum(c) {
  let n = 0;
  for (const ch of c.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function numToCol(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function splitAddr(a) {
  const m = a.match(/^([A-Z]+)(\d+)$/);
  return m ? { col: m[1], row: Number(m[2]) } : null;
}
function expandRange(a1, a2) {
  const p1 = splitAddr(a1); const p2 = splitAddr(a2);
  if (!p1 || !p2) return [a1, a2];
  const c1 = colToNum(p1.col), c2 = colToNum(p2.col);
  const r1 = p1.row, r2 = p2.row;
  const out = [];
  const MAX = 60; // cap to avoid blowing up on whole-column refs
  let count = 0;
  for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
    for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
      out.push(`${numToCol(c)}${r}`);
      if (++count >= MAX) return out;
    }
  }
  return out;
}

// Index every written cell. Map: "Sheet!ADDR" -> {value, formula, sheet, addr}
function indexCells(actions) {
  const index = new Map();
  for (const a of actions || []) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    const sheet = a.sheet || a.sheetName || 'Sheet1';
    for (const [addr, spec] of Object.entries(a.cells)) {
      const key = `${sheet}!${stripDollar(addr)}`;
      if (spec == null) continue;
      // Accept bare-value spec: cells: { B5: 42 } as well as { B5: { value: 42 } }
      if (typeof spec !== 'object') {
        index.set(key, { sheet, addr: stripDollar(addr), value: spec, formula: null });
        continue;
      }
      index.set(key, {
        sheet, addr: stripDollar(addr),
        value: spec.value,
        formula: spec.formula || null,
      });
    }
  }
  return index;
}

function validateCellDeps(actions) {
  const issues = [];
  const idx = indexCells(actions);

  // Pass 1: scan every formula
  for (const [key, cell] of idx) {
    if (!cell.formula) continue;
    // Skip TABLE() — Excel data-table function self-references by design
    if (/^=\s*TABLE\s*\(/i.test(cell.formula)) continue;
    const refs = extractCellRefs(cell.formula);
    const arithmetic = /[+\-*/^]/.test(cell.formula.replace(/^=/, '')) || /\b(SUM|PRODUCT|AVERAGE|NPV|IRR|XIRR|XNPV|RATE|PMT|FV|PV|POWER)\s*\(/i.test(cell.formula);

    for (const ref of refs) {
      const refSheet = ref.sheet || cell.sheet;
      const refKey = `${refSheet}!${ref.addr}`;
      if (refKey === key) {
        // Self-ref is often intentional (Cash plug, Cumulative formulas). Demote to medium.
        issues.push({ severity: 'medium', kind: 'self_ref', location: key, detail: `formula refs itself: ${cell.formula}` });
        continue;
      }
      const target = idx.get(refKey);
      if (!target) {
        // Only flag if the ref is to a cell that's truly never written — empty
        // labels/headers are fine. Whole-column refs already caught elsewhere.
        issues.push({ severity: 'critical', kind: 'broken_cell_ref', location: key, detail: `refs unwritten ${refKey} in formula ${cell.formula.slice(0, 80)}` });
        continue;
      }
      // Arithmetic context + ref is a non-numeric string (skip if positional)
      if (arithmetic && !ref.positional && !target.formula
        && typeof target.value === 'string'
        && target.value.trim() !== ''
        && !/^-?\d+(\.\d+)?$/.test(target.value.trim())
        && !/^[€$£]?\s*-?\d/.test(target.value.trim())) {
        issues.push({
          severity: 'critical', kind: 'string_in_arith', location: key,
          detail: `arithmetic on string ${refKey}="${String(target.value).slice(0, 30)}" via ${cell.formula.slice(0, 60)}`
        });
      }
    }

    // div-by-zero literal
    if (/\/\s*\(?\s*0+(\s*\)|[^.\w]|$)/.test(cell.formula)) {
      issues.push({ severity: 'high', kind: 'div_by_zero', location: key, detail: cell.formula.slice(0, 80) });
    }
  }

  // Pass 2: detect array-in-cell (value is comma-list of numbers)
  for (const [key, cell] of idx) {
    if (cell.formula) continue;
    if (typeof cell.value !== 'string') continue;
    if (/^(?:-?\d+(?:\.\d+)?\s*,\s*){2,}-?\d+(?:\.\d+)?$/.test(cell.value.trim())) {
      issues.push({ severity: 'high', kind: 'array_in_cell', location: key, detail: `value is comma-list "${cell.value.slice(0, 40)}" — should be N separate cells` });
    }
  }

  // Pass 3: short circular chains a→b→a
  for (const [key, cell] of idx) {
    if (!cell.formula) continue;
    if (/^=\s*TABLE\s*\(/i.test(cell.formula)) continue;
    const refs = extractCellRefs(cell.formula);
    for (const ref of refs) {
      const refKey = `${ref.sheet || cell.sheet}!${ref.addr}`;
      const target = idx.get(refKey);
      if (!target || !target.formula) continue;
      const refs2 = extractCellRefs(target.formula);
      for (const r2 of refs2) {
        const r2Key = `${r2.sheet || target.sheet}!${r2.addr}`;
        if (r2Key === key) {
          // Two-step circular (a→b→a). In real financial models this is often
          // intentional (Cash plug, Sources/Uses balance, Debt begin/end). Excel
          // resolves via iterative calc. Demote to "medium" (informational, not test-failure).
          issues.push({ severity: 'medium', kind: 'circular_ref', location: key, detail: `${key} ↔ ${refKey}` });
        }
      }
    }
  }

  return issues;
}

module.exports = { validateCellDeps, extractCellRefs, indexCells };
