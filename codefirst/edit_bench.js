#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const { editPipeline, looksLikeEdit } = require('./enhanced');

// Synthetic workbook contexts simulating what getExcelContext() returns
// after a prior /cf created a model. We test that the edit pipeline finds
// the right cell with just labels + values.

const DCF_CTX = {
  activeSheet: 'Assumptions',
  workbookSheets: ['Assumptions', 'Projections', 'Valuation'],
  sheets: [
    {
      name: 'Assumptions',
      rowCount: 9,
      columnCount: 2,
      preview: [
        ['Parametro', 'Valore'],
        ['Tasso Crescita', 0.10],
        ['Margine EBITDA', 0.20],
        ['WACC', 0.08],
        ['Aliquota Fiscale', 0.25],
        ['Anni Proiezione', 5],
        ['Terminal Growth', 0.025],
        ['Capex Iniziale', 2000],
      ],
      formulas: [['', ''], ['', ''], ['', ''], ['', ''], ['', ''], ['', ''], ['', ''], ['', '']],
    },
    {
      name: 'Projections',
      rowCount: 7,
      columnCount: 6,
      preview: [
        ['Metric', 'Y1', 'Y2', 'Y3', 'Y4', 'Y5'],
        ['Revenue', 1100, 1210, 1331, 1464.1, 1610.51],
        ['EBITDA', 220, 242, 266.2, 292.82, 322.10],
        ['EBIT', 220, 242, 266.2, 292.82, 322.10],
        ['Tasse', 55, 60.5, 66.55, 73.21, 80.53],
        ['NOPAT', 165, 181.5, 199.65, 219.62, 241.58],
        ['FCF', 165, 181.5, 199.65, 219.62, 241.58],
      ],
      formulas: [
        ['', '', '', '', '', ''],
        ['', '=1000*(1+Assumptions!$B$2)', '=B2*(1+Assumptions!$B$2)', '=C2*(1+Assumptions!$B$2)', '=D2*(1+Assumptions!$B$2)', '=E2*(1+Assumptions!$B$2)'],
        ['', '=B2*Assumptions!$B$3', '=C2*Assumptions!$B$3', '=D2*Assumptions!$B$3', '=E2*Assumptions!$B$3', '=F2*Assumptions!$B$3'],
      ],
    },
  ],
};

const BP_CTX = {
  activeSheet: 'Assumptions',
  workbookSheets: ['Assumptions', 'Revenue', 'PnL'],
  sheets: [
    {
      name: 'Assumptions',
      rowCount: 11,
      columnCount: 2,
      preview: [
        ['Driver', 'Valore'],
        ['Affitto Mensile', 8000],
        ['Food Cost %', 0.28],
        ['Labor Cost %', 0.22],
        ['Utenze %', 0.03],
        ['Marketing %', 0.02],
        ['Scontrino Medio', 18],
        ['Coperti/Giorno', 120],
        ['Capex', 350000],
        ['Multiplo Exit', 8],
        ['WACC', 0.09],
      ],
      formulas: Array.from({ length: 11 }, () => ['', '']),
    },
  ],
};

const TESTS = [
  {
    name: 'dcf_change_growth',
    objective: 'cambia il growth rate a 12%',
    context: DCF_CTX,
    expect: { sheet: 'Assumptions', addr: 'B2', value: 0.12 },
  },
  {
    name: 'dcf_wacc_to_9',
    objective: 'ora porta il WACC a 9%',
    context: DCF_CTX,
    expect: { sheet: 'Assumptions', addr: 'B4', value: 0.09 },
  },
  {
    name: 'dcf_multi_change',
    objective: 'cambia growth a 8% e EBITDA margin a 25%',
    context: DCF_CTX,
    expect: [
      { sheet: 'Assumptions', addr: 'B2', value: 0.08 },
      { sheet: 'Assumptions', addr: 'B3', value: 0.25 },
    ],
  },
  {
    name: 'bp_scontrino',
    objective: 'imposta scontrino medio a 22 euro',
    context: BP_CTX,
    expect: { sheet: 'Assumptions', addr: 'B7', value: 22 },
  },
  {
    name: 'bp_coperti',
    objective: 'aumenta coperti al giorno a 150',
    context: BP_CTX,
    expect: { sheet: 'Assumptions', addr: 'B8', value: 150 },
  },
  {
    name: 'bp_food_cost',
    objective: 'riduci food cost al 25%',
    context: BP_CTX,
    expect: { sheet: 'Assumptions', addr: 'B3', value: 0.25 },
  },
];

function scoreEditResult(result, expect) {
  if (result.status !== 'ok') return { passed: false, reason: `status=${result.status}: ${result.error || result.question}` };
  const expected = Array.isArray(expect) ? expect : [expect];
  const actions = result.actions || [];
  const cellMap = new Map();
  for (const a of actions) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    const sh = a.sheet || a.sheetName;
    for (const [addr, spec] of Object.entries(a.cells)) {
      cellMap.set(`${sh}!${addr}`, spec);
    }
  }

  const hits = [];
  const misses = [];
  for (const exp of expected) {
    const key = `${exp.sheet}!${exp.addr}`;
    const got = cellMap.get(key);
    if (!got) {
      misses.push(`missing ${key}`);
      continue;
    }
    const gotVal = got.value !== undefined ? got.value : (got.formula ? `(formula:${got.formula})` : null);
    // Allow small rounding tolerance
    const numEq = typeof exp.value === 'number' && typeof gotVal === 'number' && Math.abs(gotVal - exp.value) < 0.0001;
    if (numEq || gotVal === exp.value) {
      hits.push(key);
    } else {
      misses.push(`${key}: expected ${exp.value}, got ${gotVal}`);
    }
  }

  const extraCells = cellMap.size - expected.length;
  return {
    passed: misses.length === 0 && extraCells <= 1,
    hits, misses, extraCells,
  };
}

async function runTest(t) {
  const start = Date.now();
  const detected = looksLikeEdit(t.objective, t.context);
  if (!detected) {
    return { name: t.name, passed: false, reason: 'looksLikeEdit returned false', elapsedS: 0 };
  }
  const result = await editPipeline(t.objective, t.context, {});
  const elapsedS = (Date.now() - start) / 1000;
  const score = scoreEditResult(result, t.expect);
  return {
    name: t.name, passed: score.passed,
    elapsedS, status: result.status,
    explanation: result.explanation,
    hits: score.hits, misses: score.misses, extraCells: score.extraCells,
    reason: score.reason,
    cellCount: result.cellCount,
  };
}

async function main() {
  console.log('═══ EDIT MODE BENCH ═══');
  const wallStart = Date.now();
  const results = await Promise.all(TESTS.map(runTest));
  const wallS = (Date.now() - wallStart) / 1000;

  let passed = 0;
  for (const r of results) {
    const flag = r.passed ? '✓' : '✗';
    console.log(`${flag} ${r.name} (${r.elapsedS.toFixed(1)}s, ${r.cellCount || 0} cells)`);
    if (r.explanation) console.log(`    "${r.explanation.slice(0, 100)}"`);
    if (r.hits?.length) console.log(`    hit: ${r.hits.join(', ')}`);
    if (r.misses?.length) console.log(`    miss: ${r.misses.join('; ')}`);
    if (r.reason) console.log(`    reason: ${r.reason}`);
    if (r.passed) passed++;
  }
  console.log(`\nPass: ${passed}/${results.length} | wall: ${wallS.toFixed(0)}s`);
  fs.writeFileSync(`/tmp/cf_edit_${Date.now()}.json`, JSON.stringify(results, null, 2));
  process.exit(passed === results.length ? 0 : 1);
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e); process.exit(2); });
}

module.exports = { TESTS, runTest, scoreEditResult, DCF_CTX, BP_CTX };
