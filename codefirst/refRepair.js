'use strict';

// Label-aware cross-sheet ref repair. The LLM often picks the wrong row in
// Assumptions because it doesn't know which row holds which value. This
// post-processor:
//   1. Builds a "label index" for input sheets (Assumptions, Inputs, etc.):
//      map of canonical concept → cell address by looking at column A labels.
//   2. For each formula in other sheets, looks at the LOCAL cell's row label
//      (column A) and uses fuzzy matching to detect when the ref points at
//      a row whose label is wildly different from the local concept.
//   3. Rewrites the ref to the best-matching row.

const logger = require('../server/utils/logger');

// Canonicalise a label for matching: lowercased, alphanumeric only.
function canon(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Synonym groups — words that mean the same concept in finance modeling.
const SYNONYMS = [
  ['capex', 'capitalexpenditure', 'initialcapex', 'launchcapex', 'investment'],
  ['wacc', 'discountrate', 'costofcapital', 'requiredreturn'],
  ['cogs', 'cogspercent', 'foodcost', 'foodcostpercent'],
  ['labor', 'laborcost', 'wages', 'payroll', 'staff'],
  ['marketing', 'marketingpercent', 'mktg'],
  ['utilities', 'utility'],
  ['rent', 'occupancycost', 'occupancy', 'lease'],
  ['taxrate', 'taxes', 'corporatetax', 'tax'],
  ['inflation', 'inflationrate'],
  ['aov', 'averageordervalue', 'scontrino', 'averagecheck', 'ticket'],
  ['traffic', 'dailytraffic', 'dailycustomers', 'covers', 'visitors'],
  ['conversion', 'conversionrate', 'convrate'],
  ['operatingdays', 'days', 'workingdays'],
  ['preopening', 'preopeningcosts', 'preopen'],
  ['workingcapital', 'wc', 'nwc'],
  ['terminalgrowth', 'gordongrowth', 'perpetualgrowth'],
  ['exitmultiple', 'exitebitda', 'terminalmultiple'],
];

// Group lookup: word → group index
const wordToGroup = new Map();
SYNONYMS.forEach((group, idx) => group.forEach(w => wordToGroup.set(w, idx)));

function groupOf(label) {
  const c = canon(label);
  if (wordToGroup.has(c)) return wordToGroup.get(c);
  // Try to find any synonym word AS A SUBSTRING of the canonical label
  for (let i = 0; i < SYNONYMS.length; i++) {
    for (const w of SYNONYMS[i]) if (c.includes(w) || w.includes(c)) return i;
  }
  return -1;
}

// Build per-sheet label-map: cell address → label (column A value of same row)
function buildLabelMap(actions) {
  const sheets = {};
  for (const a of actions) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    const sh = a.sheet || a.sheetName || 'Sheet1';
    if (!sheets[sh]) sheets[sh] = { rowLabels: new Map(), valueRow: new Map() };
    for (const [addr, spec] of Object.entries(a.cells)) {
      const m = addr.match(/^([A-Z]+)(\d+)$/); if (!m) continue;
      const [, col, row] = m;
      if (!spec) continue;
      const s = typeof spec === 'object' ? spec : { value: spec };
      if (col === 'A' && typeof s.value === 'string' && s.value.trim()) {
        sheets[sh].rowLabels.set(Number(row), s.value.trim());
      }
      if (col === 'B' && (typeof s.value === 'number' || s.formula)) {
        sheets[sh].valueRow.set(Number(row), { value: s.value, formula: s.formula });
      }
    }
  }
  return sheets;
}

// For each input sheet (Assumptions, Inputs), build group → row
function buildConceptIndex(labelMap) {
  const idx = {};
  for (const [sheet, info] of Object.entries(labelMap)) {
    if (!/assumptions|input|param/i.test(sheet)) continue;
    idx[sheet] = new Map(); // group → row number
    for (const [row, label] of info.rowLabels) {
      const grp = groupOf(label);
      if (grp >= 0 && info.valueRow.has(row) && !idx[sheet].has(grp)) {
        idx[sheet].set(grp, row);
      }
    }
  }
  return idx;
}

// Walk formulas. For each cross-sheet ref to an input sheet, check if the
// referenced row's label matches a synonym of the local cell's label.
function repairRefs(actions) {
  const labelMap = buildLabelMap(actions);
  const conceptIdx = buildConceptIndex(labelMap);
  if (Object.keys(conceptIdx).length === 0) return 0;
  let fixed = 0;
  const refRe = /(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))!\$?([A-Z]+)\$?(\d+)/g;

  for (const a of actions) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    const sh = a.sheet || a.sheetName || 'Sheet1';
    const sheetInfo = labelMap[sh];
    if (!sheetInfo) continue;
    for (const [addr, spec] of Object.entries(a.cells)) {
      if (!spec || typeof spec !== 'object' || !spec.formula) continue;
      const localM = addr.match(/^([A-Z]+)(\d+)$/);
      if (!localM) continue;
      const localRow = Number(localM[2]);
      const localLabel = sheetInfo.rowLabels.get(localRow);
      if (!localLabel) continue;
      const localGrp = groupOf(localLabel);
      if (localGrp < 0) continue;

      let formulaChanged = false;
      const newFormula = spec.formula.replace(refRe, (match, qsheet, usheet, col, row) => {
        const targetSheet = (qsheet || usheet || '').trim();
        if (!conceptIdx[targetSheet]) return match;
        if (col !== 'B') return match; // Only column B holds values
        const targetRow = Number(row);
        const targetLabel = labelMap[targetSheet]?.rowLabels.get(targetRow);
        const targetGrp = targetLabel ? groupOf(targetLabel) : -1;
        // If target label is same concept as local OR is in same synonym group, keep.
        // Only repair when target label is in a DIFFERENT concept group that's clearly wrong.
        if (targetGrp === localGrp) return match;
        if (targetGrp === -1) return match; // unknown — don't risk
        // Check if there's a row in this input sheet labeled with the local concept
        const candidateRow = conceptIdx[targetSheet].get(localGrp);
        if (!candidateRow || candidateRow === targetRow) return match;
        formulaChanged = true;
        const quoted = targetSheet.includes(' ') || /[^A-Za-z0-9_]/.test(targetSheet);
        const sheetRef = quoted ? `'${targetSheet}'` : targetSheet;
        return `${sheetRef}!$B$${candidateRow}`;
      });
      if (formulaChanged) {
        spec.formula = newFormula;
        fixed++;
      }
    }
  }
  if (fixed > 0) {
    logger.info(`[RefRepair] Repaired ${fixed} formulas with mis-pointed Assumptions refs`);
  }
  return fixed;
}

module.exports = { repairRefs, buildLabelMap, buildConceptIndex, groupOf };
