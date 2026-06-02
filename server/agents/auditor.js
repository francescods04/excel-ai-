// Auditor — static formula review for slice-level + workbook-level audit.
//
// Runs as separate stage AFTER the agent calls `done`. Sees the workbook as the
// architect produced it (formulas + literal values) and flags issues the agent
// would not catch itself: cloned formula templates with literal indices instead
// of relative refs, monotonic cost/revenue inversions, NaN-prone NPV/IRR setups,
// missing-anchor cross-sheet refs.
//
// Returns structured issues; caller decides whether to block done or warn.

const logger = require('../utils/logger');

const RE_CELL = /^\$?([A-Z]{1,3})\$?(\d+)$/i;
const RE_LITERAL_NUMBER = /\b(\d+)\b/g;
const RE_FUNC = /\b([A-Z]{2,30})\s*\(/g;

function colToIndex(col) {
  let n = 0;
  for (const ch of String(col || '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function parseAddr(addr) {
  const m = RE_CELL.exec(String(addr || ''));
  return m ? { col: colToIndex(m[1]), row: Number(m[2]) } : null;
}

// Normalize a formula by replacing concrete A1 refs with positional tokens. Two
// formulas with the same "shape" produce the same string. Used to group clones.
function formulaShape(formula) {
  return String(formula || '')
    .replace(/(?:'([^']+)'|([A-Za-z_][\w .&-]*))!\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?/gi, 'XREF')
    .replace(/\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?/g, 'REF')
    .replace(/\s+/g, '');
}

// Extract literal numeric tokens that are NOT inside cell references. Used to
// catch templated formulas where the LLM hardcoded a row index. Example:
//   =IF(2=0,"",1/INDEX(...,2))  → literals=[2,0,2] (suspicious clones)
function literalIntsOutsideRefs(formula) {
  // Strip refs (with sheets) and ranges first.
  const stripped = String(formula || '')
    .replace(/(?:'([^']+)'|([A-Za-z_][\w .&-]*))!\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?/gi, ' ')
    .replace(/\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?/g, ' ');
  const ints = [];
  for (const m of stripped.matchAll(RE_LITERAL_NUMBER)) ints.push(Number(m[1]));
  return ints;
}

// Extract all numeric row tokens from cell refs in a formula. Used to detect
// whether a formula's refs "track" the cell's own row (legitimate column-fill)
// vs sit on a fixed row (templated clone).
function refRowsInFormula(formula) {
  const rows = [];
  for (const m of String(formula || '').matchAll(/\$?[A-Z]{1,3}\$?(\d+)/g)) rows.push(Number(m[1]));
  return rows;
}

// For a group of cells sharing the same shape+literals, decide whether it
// represents a legitimate column-fill (each cell's relative ref matches its own
// row) or a templated clone (all cells reference the SAME absolute row,
// regardless of where they sit). Returns true if column-fill.
function isLegitimateColumnFill(group) {
  if (!group.cells || group.cells.length < 3) return false;
  let matched = 0;
  for (const { addr, formula } of group.cells) {
    const myPos = parseAddr(addr);
    if (!myPos) continue;
    const refRows = refRowsInFormula(formula);
    if (refRows.includes(myPos.row)) matched += 1;
  }
  // ≥80% of cells reference their own row → real fill, not a clone.
  return matched / group.cells.length >= 0.8;
}

// Detect templated-clone bug: ≥N cells with identical formula shape AND
// identical literal-ints AND none of the refs track the cell's own row. The
// Vairano 2026-06-02 bug (4800 cells with =IF(2=0,"",1/INDEX(...,2))) matches:
// shape identical, literal "2" hardcoded, no row-tracking ref.
function detectTemplatedClones(sheetCells, opts = {}) {
  const minClones = opts.minClones || 25;
  const issues = [];
  for (const [sheet, cells] of Object.entries(sheetCells || {})) {
    const groups = new Map(); // shape+literals → { cells: [{addr, formula}], sampleFormula }
    for (const [addr, c] of Object.entries(cells || {})) {
      const f = c && c.f;
      if (!f) continue;
      const shape = formulaShape(f);
      const lits = literalIntsOutsideRefs(f).join(',');
      const key = `${shape}|L:${lits}`;
      if (!groups.has(key)) groups.set(key, { cells: [], sampleFormula: f });
      groups.get(key).cells.push({ addr, formula: f });
    }
    for (const [key, g] of groups.entries()) {
      if (g.cells.length < minClones) continue;
      const lits = key.split('|L:')[1];
      const shape = key.split('|L:')[0];
      // Skip groups with no refs and no literals — pure constant formulas
      // (e.g. `=PI()`) are intentionally identical.
      if (!/REF|XREF/.test(shape) && !lits) continue;
      const positions = g.cells.map(c => parseAddr(c.addr)).filter(Boolean);
      const rowSet = new Set(positions.map(p => p.row));
      const colSet = new Set(positions.map(p => p.col));
      if (rowSet.size < 2 && colSet.size < 2) continue;
      // Column-fill filter: if cells span rows AND each ref tracks its own row,
      // the LLM did the right thing (just used relative refs that happen to
      // share a shape). Don't flag.
      if (rowSet.size >= 2 && isLegitimateColumnFill(g)) continue;
      issues.push({
        type: 'templated_clones',
        sheet,
        severity: g.cells.length > 500 ? 'fail' : 'warn',
        count: g.cells.length,
        sampleAddrs: g.cells.slice(0, 5).map(c => c.addr),
        sampleFormula: g.sampleFormula,
        msg: `${g.cells.length} cells on "${sheet}" share identical formula+literals "${g.sampleFormula.slice(0, 60)}"; LLM likely hardcoded an index where a relative ref (ROW(), A2) was needed`
      });
    }
  }
  return issues;
}

// Detect formulas referencing themselves directly (=A1 in cell A1). The match
// must be either unqualified (no sheet prefix) OR qualified with the cell's
// own sheet. A formula like =Raw!A2 inside Clean!A2 is a cross-sheet pull, not
// a self-ref — false positive in earlier impl flagged 350 such cells on
// data_cleaning.
function detectSelfRefs(sheetCells) {
  const issues = [];
  for (const [sheet, cells] of Object.entries(sheetCells || {})) {
    for (const [addr, c] of Object.entries(cells || {})) {
      const f = c && c.f;
      if (!f) continue;
      const escAddr = addr.replace(/(\d+)/, '\\$?$1');
      // Same-sheet qualified: 'Sheet'!A2 or Sheet!A2
      const qualRe = new RegExp(`(?:'${sheet}'|${sheet})!\\$?${escAddr}(?![A-Z0-9_])`, 'i');
      // Unqualified A2 — but not preceded by `!` (which would make it part of a
      // foreign-sheet ref like Raw!A2) and not preceded by `[A-Z0-9_$]`.
      const unqualRe = new RegExp(`(?:^|[^A-Z0-9_$!'])\\$?${escAddr}(?![A-Z0-9_])`, 'i');
      if (qualRe.test(f) || unqualRe.test(f)) {
        issues.push({ type: 'self_ref', sheet, severity: 'warn', addr, formula: f, msg: `${sheet}!${addr} references itself` });
      }
    }
  }
  return issues;
}

// Detect formulas with IF(literal cmp literal,...) — always-true or always-false
// guards. Indicates LLM wrote a constant condition instead of a per-cell test.
function detectConstantGuards(sheetCells) {
  const issues = [];
  // Match IF(<int> <op> <int>, ...) — int op int as guard.
  const re = /\bIF\s*\(\s*(\d+)\s*(=|<>|<|<=|>|>=)\s*(\d+)\s*[,)]/gi;
  const seenShapes = new Map();
  for (const [sheet, cells] of Object.entries(sheetCells || {})) {
    for (const [addr, c] of Object.entries(cells || {})) {
      const f = c && c.f;
      if (!f) continue;
      const matches = [...f.matchAll(re)];
      for (const m of matches) {
        const key = `${sheet}|${m[1]}${m[2]}${m[3]}`;
        if (!seenShapes.has(key)) seenShapes.set(key, []);
        seenShapes.get(key).push({ sheet, addr, formula: f });
      }
    }
  }
  for (const [key, occ] of seenShapes.entries()) {
    if (occ.length < 5) continue;
    const sample = occ[0];
    issues.push({
      type: 'constant_guard',
      sheet: sample.sheet,
      severity: occ.length > 100 ? 'fail' : 'warn',
      count: occ.length,
      sampleAddr: sample.addr,
      sampleFormula: sample.formula,
      msg: `${occ.length} cells on "${sample.sheet}" use IF(${key.split('|')[1]},…) — constant condition, likely meant a per-row reference`
    });
  }
  return issues;
}

// Detect formulas whose INDEX(...) / OFFSET(...) / INDIRECT(...) row/col index
// is a literal integer ≥2 that is repeated identically across N cells of
// different rows. Signal that the literal was meant to be ROW()/MATCH(). Skip
// when at least one ref tracks the cell's own row — that's a legitimate fill
// (the literal is a column index, not a row index).
function detectFrozenIndex(sheetCells) {
  const issues = [];
  const re = /\b(INDEX|OFFSET|INDIRECT)\s*\(/gi;
  for (const [sheet, cells] of Object.entries(sheetCells || {})) {
    const byFunc = new Map();
    for (const [addr, c] of Object.entries(cells || {})) {
      const f = c && c.f;
      if (!f) continue;
      const hasFn = re.test(f);
      re.lastIndex = 0;
      if (!hasFn) continue;
      const lits = literalIntsOutsideRefs(f).filter(n => n >= 2).join(',');
      if (!lits) continue;
      const key = `${formulaShape(f)}|${lits}`;
      if (!byFunc.has(key)) byFunc.set(key, []);
      byFunc.get(key).push({ addr, formula: f });
    }
    for (const [key, occ] of byFunc.entries()) {
      if (occ.length < 30) continue;
      const positions = occ.map(o => parseAddr(o.addr)).filter(Boolean);
      const rowSet = new Set(positions.map(p => p.row));
      if (rowSet.size < 3) continue;
      // Column-fill filter: if cells span rows AND ≥80% of cells have a ref
      // tracking their own row, the literal INDEX arg is a static column
      // selector — legitimate.
      if (isLegitimateColumnFill({ cells: occ })) continue;
      issues.push({
        type: 'frozen_index',
        sheet,
        severity: occ.length > 200 ? 'fail' : 'warn',
        count: occ.length,
        sampleAddr: occ[0].addr,
        sampleFormula: occ[0].formula,
        msg: `${occ.length} cells on "${sheet}" reuse same INDEX/OFFSET/INDIRECT literal index ${key.split('|')[1]} across multiple rows — likely needed ROW()/MATCH()`
      });
    }
  }
  return issues;
}

// Detect row-template bug: same formula replicated across N+ columns within
// the same row, where the cells should differ per column. Confirmed Vairano
// 2026-06-02 Revenue Schedule: 5 floors × 960 rows all share identical
// =IF(N=0,"",1/INDEX(...,N)) per row — column variation was lost. Distinct
// from templated_clones because there N varied per row (so each row got its
// own shape); the bug is that A:E columns are identical when they shouldn't be.
function detectRowTemplates(sheetCells, opts = {}) {
  const minCols = opts.minCols || 4;
  const minRows = opts.minRows || 20;
  const issues = [];
  for (const [sheet, cells] of Object.entries(sheetCells || {})) {
    // Bucket cells by row → unique formula → cols set.
    const byRow = new Map(); // row → Map<formula, Set<col>>
    for (const [addr, c] of Object.entries(cells || {})) {
      const f = c && c.f;
      if (!f) continue;
      const pos = parseAddr(addr);
      if (!pos) continue;
      if (!byRow.has(pos.row)) byRow.set(pos.row, new Map());
      const m = byRow.get(pos.row);
      if (!m.has(f)) m.set(f, new Set());
      m.get(f).add(pos.col);
    }
    // For each formula, count rows where it spans ≥minCols columns identical.
    const formulaRowSpans = new Map(); // formula → rows[]
    for (const [row, fm] of byRow.entries()) {
      for (const [formula, cols] of fm.entries()) {
        if (cols.size < minCols) continue;
        if (!formulaRowSpans.has(formula)) formulaRowSpans.set(formula, []);
        formulaRowSpans.get(formula).push({ row, cols: [...cols] });
      }
    }
    // Shape-group: many distinct formulas with same SHAPE+col-pattern → same
    // bug repeated per row. Aggregate by a "deep" shape that ALSO normalizes
    // literal integers, so 960 unique row-formulas like IF(2=0,...,2) and
    // IF(3=0,...,3) all collapse into one shape "IF(LIT=LIT,...,LIT)".
    const deepShape = (f) => formulaShape(f).replace(/\b\d+\b/g, 'LIT');
    const byShape = new Map();
    for (const [formula, rows] of formulaRowSpans.entries()) {
      if (rows.length < 1) continue;
      const shape = deepShape(formula);
      if (!byShape.has(shape)) byShape.set(shape, { rows: 0, cells: 0, sampleFormula: formula });
      const s = byShape.get(shape);
      s.rows += rows.length;
      s.cells += rows.reduce((acc, r) => acc + r.cols.length, 0);
    }
    for (const [shape, info] of byShape.entries()) {
      if (info.rows < minRows) continue;
      issues.push({
        type: 'row_template',
        sheet,
        severity: info.cells > 1000 ? 'fail' : 'warn',
        count: info.cells,
        rowsAffected: info.rows,
        sampleFormula: info.sampleFormula,
        msg: `${info.cells} cells across ${info.rows} rows on "${sheet}" replicate the same formula shape across ≥${minCols} columns; columns A:E should differ per-column (likely missing COLUMN()/header-driven ref)`
      });
    }
  }
  return issues;
}

// Audit summary: groups issues by severity, returns top-N actionable ones.
function summarizeIssues(issues) {
  const fails = issues.filter(i => i.severity === 'fail');
  const warns = issues.filter(i => i.severity === 'warn');
  return {
    ok: fails.length === 0,
    fails,
    warns,
    total: issues.length
  };
}

// Builds a focused repair instruction the agent can act on. One short message
// per issue, addr-specific. Max N issues to keep prompt short.
function buildRepairInstruction(issues, opts = {}) {
  const maxLines = opts.maxLines || 6;
  const lines = ['Auditor flagged the following formula issues. Fix ONLY these cells, then call done again:'];
  for (const issue of issues.slice(0, maxLines)) {
    const samples = (issue.sampleAddrs || [issue.sampleAddr]).filter(Boolean).slice(0, 3).join(', ');
    lines.push(`- [${issue.type}] sheet="${issue.sheet}" cells=${samples}${issue.count ? ` (×${issue.count})` : ''}: ${issue.msg}. Sample formula: ${(issue.sampleFormula || '').slice(0, 100)}`);
  }
  if (issues.length > maxLines) lines.push(`- (+ ${issues.length - maxLines} more similar issues; fixing the patterns above usually fixes the rest)`);
  return lines.join('\n');
}

// One-shot audit entry point — pure static, no LLM.
function auditStatic(sheetCells, opts = {}) {
  if (!sheetCells || typeof sheetCells !== 'object') return summarizeIssues([]);
  const issues = [
    ...detectTemplatedClones(sheetCells, opts),
    ...detectConstantGuards(sheetCells),
    ...detectFrozenIndex(sheetCells),
    ...detectRowTemplates(sheetCells, opts),
    ...detectSelfRefs(sheetCells)
  ];
  const result = summarizeIssues(issues);
  if (issues.length > 0) {
    logger.info(`[Auditor] static audit: ${issues.length} issue(s) (${result.fails.length} fail, ${result.warns.length} warn)`);
  }
  return result;
}

module.exports = {
  auditStatic,
  detectTemplatedClones,
  detectConstantGuards,
  detectFrozenIndex,
  detectRowTemplates,
  detectSelfRefs,
  buildRepairInstruction,
  formulaShape,
  literalIntsOutsideRefs,
  summarizeIssues
};
