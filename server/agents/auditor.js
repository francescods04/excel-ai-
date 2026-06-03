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

// Build a concrete repair suggestion for a templated-clone group. Heuristic:
// look at which row most refs sit on; if it matches the FIRST cell's row, the
// LLM probably forgot to anchor. Otherwise it's an absolute-row template that
// needs ROW() or COLUMN().
function suggestRefFix(sampleFormula, cells) {
  if (!cells || !cells.length) return 'Use ROW()/COLUMN() or relative refs so each cell pulls its own data.';
  const firstAddr = cells[0].addr;
  const firstPos = parseAddr(firstAddr);
  if (!firstPos) return 'Anchor refs with $ on the row that should stay fixed and let the other axis vary; use ROW()/COLUMN() when no clean anchor exists.';
  const rowRefs = [...sampleFormula.matchAll(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g)];
  if (rowRefs.length === 0) return 'Formula has no cell refs — likely a constant-only template; reference workbook data instead.';
  // Most refs at firstPos.row?
  const sameRow = rowRefs.filter(m => Number(m[4]) === firstPos.row).length;
  if (sameRow > 0 && sameRow >= rowRefs.length / 2) {
    return `Refs sit on row ${firstPos.row}; if this is meant to apply per-row, drop the row literals (e.g. ${rowRefs[0][2]}${firstPos.row} → ${rowRefs[0][2]}<ROW> with the row varying per cell). If row ${firstPos.row} is a fixed driver row, anchor it with $ (${rowRefs[0][2]}$${firstPos.row}) and let other refs vary.`;
  }
  return `Vary the column ref per column (use ${rowRefs[0][2]}<col-driven> or COLUMN()-based indexing) and anchor only what should stay fixed with $.`;
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
      // Severity ramps with count. ≥50 cells = fail (will block done and
      // trigger repair). Below that = warn-only signal. The old threshold of
      // 500 was too tolerant — fastfood_bp P&L "=IF(B4,B6/B4,0)" ×298 (a real
      // semantic bug: same column-4 percentage cloned across every month)
      // came through as a mere warning.
      const severity = g.cells.length >= 50 ? 'fail' : 'warn';
      const sampleAddrs = g.cells.slice(0, 5).map(c => c.addr);
      const fix = suggestRefFix(g.sampleFormula, g.cells);
      issues.push({
        type: 'templated_clones',
        sheet,
        severity,
        count: g.cells.length,
        sampleAddrs,
        sampleFormula: g.sampleFormula,
        suggestedFix: fix,
        msg: `${g.cells.length} cells on "${sheet}" share identical formula+literals "${g.sampleFormula.slice(0, 60)}"; LLM hardcoded an index where a relative ref was needed. ${fix}`
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
    const severity = occ.length >= 20 ? 'fail' : 'warn';
    issues.push({
      type: 'constant_guard',
      sheet: sample.sheet,
      severity,
      count: occ.length,
      sampleAddr: sample.addr,
      sampleFormula: sample.formula,
      suggestedFix: `Replace literal-vs-literal IF check with a cell-based condition (e.g. IF(${sample.addr}<>"",…) or IF(ROW()>1,…))`,
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
      const severity = occ.length >= 50 ? 'fail' : 'warn';
      issues.push({
        type: 'frozen_index',
        sheet,
        severity,
        count: occ.length,
        sampleAddr: occ[0].addr,
        sampleFormula: occ[0].formula,
        suggestedFix: `Replace literal index ${key.split('|')[1]} with ROW()-N (relative row) or MATCH(lookup_value, range, 0) so each cell looks up its own data`,
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
      const severity = info.cells >= 100 ? 'fail' : 'warn';
      issues.push({
        type: 'row_template',
        sheet,
        severity,
        count: info.cells,
        rowsAffected: info.rows,
        sampleFormula: info.sampleFormula,
        suggestedFix: `Vary at least one ref per column. If cols represent series (months, floors, scenarios) anchor by COLUMN() or reference a per-column header. Sample bad: "${info.sampleFormula.slice(0, 60)}" — needs to differ across A:E`,
        msg: `${info.cells} cells across ${info.rows} rows on "${sheet}" replicate the same formula shape across ≥${minCols} columns; columns A:E should differ per-column (likely missing COLUMN()/header-driven ref)`
      });
    }
  }
  return issues;
}

// Audit summary: groups issues by severity, returns top-N actionable ones.
// Detect labels that recur in MULTIPLE sheets with conflicting numeric
// neighbours. Catches the canonical MEAT CREW symptom: "Revenue Y1" =
// 94,011 in P&L vs 1,128,139 in Dashboard (12× delta — neither cell is
// in error state, both look fine in isolation, but cross-sheet they
// contradict). Strategy:
//   1) For each sheet, scan cells: when a TEXT label sits in cell (col,
//      row) and the cell at (col+1, row) is numeric, record (label,
//      sheet, addr, value).
//   2) Group by normalized label (lowercased, whitespace-collapsed,
//      trailing colons/punctuation stripped).
//   3) For every label appearing in ≥2 sheets, compare its numeric
//      values. Flag when the relative gap > tolerance AND the absolute
//      gap > floor (so trivial rounding doesn't trigger).
//
// Heuristics:
//   - Skip labels < MIN_LABEL_LEN chars (avoids "A", "B", ":", etc.)
//   - Skip generic non-financial labels (Year, Month, Total, etc.) by
//     allow-list of financial keywords (revenue, ebitda, fcf, …) so
//     "Total" appearing 30 times across sheets does not flood reports.
//     Conservative: only fire on FINANCIAL labels — false negatives
//     beat 50 noise issues.
const FIN_LABEL_RE = /(revenue|sales|fatturat|ricavi|ebitda|ebit|net income|gross profit|cogs|opex|capex|fcf|free cash|enterprise value|equity value|debt|wacc|terminal value|labor cost|marketing|tax|d&a|depreci|margin|aov|customers?\b|annual customers?|monthly|cumulative)/i;
const MIN_LABEL_LEN = 4;
function normLabel(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .replace(/[:;,.\-()\[\]€$£%]+/g, '')
    .trim();
}
function isFinancialLabel(s) {
  return typeof s === 'string' && s.length >= MIN_LABEL_LEN && FIN_LABEL_RE.test(s);
}
function isNumericValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return true;
  if (typeof v === 'string') {
    const t = v.replace(/[€$£%,\s]/g, '');
    return /^-?\d+(\.\d+)?$/.test(t);
  }
  return false;
}
function numericValue(v) {
  if (typeof v === 'number') return v;
  return Number(String(v).replace(/[€$£%,\s]/g, ''));
}
function detectCrossSheetCoherence(sheetCells, opts = {}) {
  const tolPct = opts.tolerancePct != null ? opts.tolerancePct : 0.01; // 1 % relative
  const absFloor = opts.absoluteFloor != null ? opts.absoluteFloor : 1; // floor 1 unit
  // (label → [{sheet, addr, value}])
  const byLabel = new Map();
  for (const [sheet, cells] of Object.entries(sheetCells || {})) {
    // Build (col,row) → cell map
    const byPos = new Map();
    for (const [addr, c] of Object.entries(cells || {})) {
      const p = parseAddr(addr);
      if (!p) continue;
      byPos.set(`${p.col}:${p.row}`, { addr, p, ...c });
    }
    for (const cell of byPos.values()) {
      const labelVal = cell.v;
      if (typeof labelVal !== 'string') continue;
      if (!isFinancialLabel(labelVal)) continue;
      const neighbour = byPos.get(`${cell.p.col + 1}:${cell.p.row}`);
      if (!neighbour) continue;
      if (!isNumericValue(neighbour.v)) continue;
      const key = normLabel(labelVal);
      if (!key) continue;
      if (!byLabel.has(key)) byLabel.set(key, []);
      byLabel.get(key).push({ sheet, addr: neighbour.addr, value: numericValue(neighbour.v), labelOriginal: labelVal });
    }
  }
  const issues = [];
  for (const [key, hits] of byLabel.entries()) {
    // Need ≥2 distinct sheets
    const sheets = new Set(hits.map(h => h.sheet));
    if (sheets.size < 2) continue;
    // Compute spread: pick min/max numeric. If reldelta exceeds tolerance AND
    // absolute delta exceeds floor → mismatch.
    const values = hits.map(h => h.value).filter(v => Number.isFinite(v));
    if (values.length < 2) continue;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const absDelta = Math.abs(max - min);
    const denom = Math.max(Math.abs(max), Math.abs(min), 1e-9);
    const relDelta = absDelta / denom;
    if (relDelta < tolPct) continue;
    if (absDelta < absFloor) continue;
    const samples = hits.slice(0, 4).map(h => `${h.sheet}!${h.addr}=${h.value}`).join(', ');
    const severity = relDelta >= 0.1 ? 'fail' : 'warn'; // 10 % delta = fail
    issues.push({
      type: 'cross_sheet_coherence',
      severity,
      label: hits[0].labelOriginal,
      sheets: [...sheets],
      values,
      relDelta: Number(relDelta.toFixed(4)),
      msg: `Label "${hits[0].labelOriginal}" appears in ${sheets.size} sheets with mismatched values (${(relDelta * 100).toFixed(1)}% spread): ${samples}. Verify one sheet is the source of truth and link the others by formula.`
    });
  }
  return issues;
}

// Detect a label repeated within the SAME sheet in the SAME column, with
// different numeric neighbours. Catches the MEAT CREW "Net Income" row
// written twice in the P&L (one row = +21,132, second row = -14,459, the
// second one shadowing the first). Within-sheet duplicates are almost
// always a write bug (model wrote, then re-wrote, then forgot to remove
// the original).
function detectDuplicateRowLabels(sheetCells, opts = {}) {
  const issues = [];
  for (const [sheet, cells] of Object.entries(sheetCells || {})) {
    // (col → [{row, labelRaw, normLabel, neighbour}])
    const byCol = new Map();
    const byPos = new Map();
    for (const [addr, c] of Object.entries(cells || {})) {
      const p = parseAddr(addr);
      if (!p) continue;
      byPos.set(`${p.col}:${p.row}`, { addr, p, ...c });
    }
    for (const cell of byPos.values()) {
      if (typeof cell.v !== 'string') continue;
      if (!isFinancialLabel(cell.v)) continue;
      const neighbour = byPos.get(`${cell.p.col + 1}:${cell.p.row}`);
      const neighbourV = neighbour && isNumericValue(neighbour.v) ? numericValue(neighbour.v) : null;
      const colKey = cell.p.col;
      if (!byCol.has(colKey)) byCol.set(colKey, []);
      byCol.get(colKey).push({ row: cell.p.row, labelRaw: cell.v, normLabel: normLabel(cell.v), neighbour: neighbourV, addr: cell.addr });
    }
    for (const entries of byCol.values()) {
      const groups = new Map();
      for (const e of entries) {
        if (!e.normLabel) continue;
        if (!groups.has(e.normLabel)) groups.set(e.normLabel, []);
        groups.get(e.normLabel).push(e);
      }
      for (const [norm, group] of groups.entries()) {
        if (group.length < 2) continue;
        // Filter to rows where neighbour is numeric (the label is acting
        // as a row driver). If neighbours match, it's a coincidence
        // (e.g. "Revenue" used as section header and as row label both
        // pointing at the same number) → skip. Mismatch is the signal.
        const vs = group.map(g => g.neighbour).filter(v => v != null && Number.isFinite(v));
        if (vs.length < 2) continue;
        const min = Math.min(...vs);
        const max = Math.max(...vs);
        if (Math.abs(max - min) < 1) continue;
        const samples = group.slice(0, 4).map(g => `${g.addr}=${g.neighbour}`).join(', ');
        issues.push({
          type: 'duplicate_row_label',
          severity: 'fail',
          sheet,
          label: group[0].labelRaw,
          rows: group.map(g => g.row),
          msg: `Sheet "${sheet}" has label "${group[0].labelRaw}" on ${group.length} different rows with conflicting neighbour values (${samples}). The agent likely wrote the same line twice without removing the older row — delete the wrong copy.`
        });
      }
    }
  }
  return issues;
}

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

// Builds a focused repair instruction the agent can act on. One block per
// issue with: type, sheet, sample addrs, bad formula, and a concrete fix
// suggestion. Tight enough to fit in a single user message without padding the
// context window.
function buildRepairInstruction(issues, opts = {}) {
  const maxLines = opts.maxLines || 8;
  const lines = [
    'Auditor blocked done — formula bugs detected in the writes you just made.',
    'For each block below, READ the cells listed, REWRITE the formulas with the suggested fix, then call done.',
    'Do NOT add new sheets or columns. Do NOT call done before fixing.'
  ];
  for (const issue of issues.slice(0, maxLines)) {
    const samples = (issue.sampleAddrs || [issue.sampleAddr]).filter(Boolean).slice(0, 4).join(', ');
    const fix = issue.suggestedFix ? `\n  fix: ${issue.suggestedFix}` : '';
    const formula = issue.sampleFormula ? `\n  bad formula: ${issue.sampleFormula.slice(0, 120)}` : '';
    lines.push(`• [${issue.type}] sheet="${issue.sheet}" sample cells: ${samples}${issue.count ? ` (×${issue.count} affected)` : ''}${formula}${fix}`);
  }
  if (issues.length > maxLines) lines.push(`(+ ${issues.length - maxLines} more issues of the same kind — applying the patterns above will fix them)`);
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
    ...detectSelfRefs(sheetCells),
    ...detectCrossSheetCoherence(sheetCells, opts),
    ...detectDuplicateRowLabels(sheetCells, opts)
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
  detectCrossSheetCoherence,
  detectDuplicateRowLabels,
  buildRepairInstruction,
  formulaShape,
  literalIntsOutsideRefs,
  summarizeIssues
};
