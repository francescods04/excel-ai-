'use strict';

const logger = require('../server/utils/logger');

function colToNum(col) {
  let n = 0;
  const s = String(col).toUpperCase();
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 65 || c > 90) return NaN;
    n = n * 26 + (c - 64);
  }
  return n;
}

function numToCol(n) {
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s || 'A';
}

function parseAddr(a) {
  const m = /^([$]?)([A-Z]+)([$]?)(\d+)$/.exec(String(a).toUpperCase());
  if (!m) return null;
  return { colAbs: m[1] === '$', col: m[2], rowAbs: m[3] === '$', row: Number(m[4]) };
}

function shiftFormula(formula, colShift, rowShift) {
  if (!formula || typeof formula !== 'string') return formula;
  return formula.replace(/(\$?)([A-Z]+)(\$?)(\d+)\b/g, (_m, ca, col, ra, row) => {
    let newCol = col;
    let newRow = Number(row);
    if (ca !== '$' && colShift) {
      const n = colToNum(col) + colShift;
      if (n >= 1) newCol = numToCol(n);
    }
    if (ra !== '$' && rowShift) {
      newRow = newRow + rowShift;
      if (newRow < 1) newRow = 1;
    }
    return `${ca}${newCol}${ra}${newRow}`;
  });
}

function isWholeColumnOrRow(target) {
  if (!target || typeof target !== 'string') return false;
  const bare = target.includes('!') ? target.split('!').pop() : target;
  if (/^[A-Z]+:[A-Z]+$/i.test(bare)) return true;
  if (/^\d+:\d+$/.test(bare)) return true;
  return false;
}

function boundTarget(target, maxRows = 200, maxCols = 50) {
  if (!target || typeof target !== 'string') return target;
  const sheetPart = target.includes('!') ? target.split('!')[0] + '!' : '';
  const bare = target.includes('!') ? target.split('!').pop() : target;
  let bounded = bare;
  const colMatch = /^([A-Z]+):([A-Z]+)$/i.exec(bare);
  if (colMatch) {
    bounded = `${colMatch[1]}1:${colMatch[2]}${maxRows}`;
  }
  const rowMatch = /^(\d+):(\d+)$/.exec(bare);
  if (rowMatch) {
    bounded = `A${rowMatch[1]}:${numToCol(maxCols)}${rowMatch[2]}`;
  }
  return sheetPart + bounded;
}

function expandFillRangeToCells(action) {
  const { start, end, formula, value } = action;
  if (!start || !end) return null;
  const a = parseAddr(start);
  const b = parseAddr(end);
  if (!a || !b) return null;
  const c1 = colToNum(a.col);
  const c2 = colToNum(b.col);
  const r1 = a.row;
  const r2 = b.row;
  if (!c1 || !c2 || c1 > c2 || r1 > r2) return null;

  const cells = {};
  const totalCells = (c2 - c1 + 1) * (r2 - r1 + 1);
  if (totalCells > 400) return null;

  for (let c = c1; c <= c2; c++) {
    for (let r = r1; r <= r2; r++) {
      const colShift = c - c1;
      const rowShift = r - r1;
      const addr = `${numToCol(c)}${r}`;
      if (formula) {
        const shifted = shiftFormula(formula, colShift, rowShift);
        cells[addr] = { formula: shifted };
      } else if (value !== undefined) {
        cells[addr] = { value };
      }
    }
  }
  return {
    type: 'setCellRange',
    sheet: action.sheet || action.sheetName,
    cells,
  };
}

function absolutifyCrossSheetRefs(formula) {
  if (!formula || typeof formula !== 'string') return formula;
  // Match: SheetName!A1 or SheetName!$A1 or SheetName!A$1 — single-cell cross-sheet refs without full $.
  // Skip: ranges (A1:B2), already-$$ refs, and refs without the ! qualifier.
  return formula.replace(/([A-Za-z_][A-Za-z0-9_]*)!(\$?)([A-Z]+)(\$?)(\d+)(?![:\d])/g,
    (m, sheet, ca, col, ra, row) => `${sheet}!$${col}$${row}`);
}

function sanitizeActions(actions, opts = {}) {
  const { maxRows = 200, maxCols = 50 } = opts;
  const out = [];
  const stats = { dropped: 0, expanded: 0, bounded: 0, kept: 0, absolutified: 0, deduped: 0 };

  for (const a of actions || []) {
    if (!a || typeof a !== 'object' || !a.type) {
      stats.dropped++;
      continue;
    }

    if (a.type === 'fillRange') {
      const hasNewSchema = a.start && a.end && (a.formula !== undefined || a.value !== undefined);
      const hasLegacy = a.target && (a.formula !== undefined || a.value !== undefined);

      if (hasNewSchema) {
        if (isWholeColumnOrRow(`${a.start}:${a.end}`)) {
          logger.warn(`[Sanitizer] fillRange whole-column dropped: ${a.start}:${a.end}`);
          stats.dropped++;
          continue;
        }
        const expanded = expandFillRangeToCells(a);
        if (expanded) {
          out.push(expanded);
          stats.expanded++;
          continue;
        }
        stats.dropped++;
        continue;
      }

      if (hasLegacy) {
        if (isWholeColumnOrRow(a.target)) {
          a.target = boundTarget(a.target, maxRows, maxCols);
          stats.bounded++;
        }
        out.push(a);
        stats.kept++;
        continue;
      }

      logger.warn(`[Sanitizer] fillRange malformed dropped: ${JSON.stringify(a).slice(0, 120)}`);
      stats.dropped++;
      continue;
    }

    if (a.type === 'setCellFormat') {
      if (a.target && isWholeColumnOrRow(a.target)) {
        a.target = boundTarget(a.target, maxRows, maxCols);
        stats.bounded++;
      }
      out.push(a);
      stats.kept++;
      continue;
    }

    if (a.type === 'setCellRange' && a.cells && typeof a.cells === 'object') {
      const cleanCells = {};
      for (const [addr, spec] of Object.entries(a.cells)) {
        if (!addr) continue;
        const bare = addr.includes('!') ? addr.split('!').pop() : addr;
        if (isWholeColumnOrRow(bare)) {
          logger.warn(`[Sanitizer] setCellRange whole-column cell skipped: ${addr}`);
          continue;
        }
        let cellSpec = spec;
        if (cellSpec && typeof cellSpec === 'object' && typeof cellSpec.value === 'string' && cellSpec.value.startsWith('=') && !cellSpec.formula) {
          cellSpec = { ...cellSpec, formula: cellSpec.value };
          delete cellSpec.value;
        }
        if (cellSpec && typeof cellSpec === 'object' && typeof cellSpec.formula === 'string') {
          const fixed = absolutifyCrossSheetRefs(cellSpec.formula);
          if (fixed !== cellSpec.formula) {
            cellSpec = { ...cellSpec, formula: fixed };
            stats.absolutified++;
          }
        }
        cleanCells[addr] = cellSpec;
      }
      if (Object.keys(cleanCells).length === 0) {
        stats.dropped++;
        continue;
      }
      a.cells = cleanCells;
      out.push(a);
      stats.kept++;
      continue;
    }

    out.push(a);
    stats.kept++;
  }

  // Deduplicate cell writes across all setCellRange actions in the SAME sheet.
  // When stepwise slicing emits overlapping row ranges, two sections write to the
  // same address — keep the LAST one (later sections typically refine earlier ones)
  // and merge cellStyles non-destructively.
  const sheetCellSeen = new Map(); // key="sheet!addr" → {actionIdx, addr, lastSpec}
  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    if (a.type !== 'setCellRange' || !a.cells) continue;
    const sh = a.sheet || a.sheetName || 'Sheet1';
    for (const addr of Object.keys(a.cells)) {
      const k = `${sh}!${addr}`;
      const prev = sheetCellSeen.get(k);
      if (prev) {
        const prevSpec = out[prev.actionIdx].cells[prev.addr];
        const curSpec = a.cells[addr];
        if (prevSpec && curSpec && typeof prevSpec === 'object' && typeof curSpec === 'object') {
          curSpec.cellStyles = { ...(prevSpec.cellStyles || {}), ...(curSpec.cellStyles || {}) };
        }
        delete out[prev.actionIdx].cells[prev.addr];
        stats.deduped++;
      }
      sheetCellSeen.set(k, { actionIdx: i, addr });
    }
  }

  // Drop now-empty setCellRange actions
  const final = out.filter(a => {
    if (a.type !== 'setCellRange' || !a.cells) return true;
    return Object.keys(a.cells).length > 0;
  });

  return { actions: final, stats };
}

function validateActionsStrict(actions) {
  const errors = [];
  const sheets = new Set();
  const refs = new Set();

  for (const a of actions) {
    if (a.type === 'createSheet' && a.sheet) sheets.add(a.sheet);
    if (a.sheet) sheets.add(a.sheet);
    if (a.type === 'setCellRange' && a.cells) {
      for (const [addr, spec] of Object.entries(a.cells)) {
        if (spec?.formula) {
          const m = String(spec.formula).match(/([A-Za-z_][A-Za-z0-9_]*)!/g);
          if (m) m.forEach(s => refs.add(s.replace('!', '')));
        }
      }
    }
    if (a.type === 'fillRange' && a.formula) {
      const m = String(a.formula).match(/([A-Za-z_][A-Za-z0-9_]*)!/g);
      if (m) m.forEach(s => refs.add(s.replace('!', '')));
    }
  }

  for (const ref of refs) {
    if (!sheets.has(ref)) {
      errors.push({ severity: 'high', kind: 'missing_sheet', sheet: ref });
    }
  }

  return errors;
}

module.exports = {
  absolutifyCrossSheetRefs,
  sanitizeActions,
  validateActionsStrict,
  shiftFormula,
  colToNum,
  numToCol,
  parseAddr,
  isWholeColumnOrRow,
  boundTarget,
  expandFillRangeToCells,
};
