#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { enhancedPipeline } = require('./enhanced');
const { sanitizeActions, isWholeColumnOrRow, validateActionsStrict } = require('./actionSanitizer');
const { validateCellDeps } = require('./cellDepValidator');

const SCENARIOS = {
  sumcol: {
    domain: 'simple',
    objective: 'Crea un foglio "Dati". Header A1:D1: Nome, Età, Città, Età+10 (grassetto, sfondo blu #1F4E79, testo bianco). 5 righe: Mario 30 Roma, Lucia 28 Milano, Paolo 45 Napoli, Anna 22 Torino, Marco 35 Bologna. In D2:D6 formula =B2+10. Bordi su tutto.',
    expect: { sheets: ['Dati'], minCells: 24, minFormulas: 5, mustHaveFormulas: [/=B\d\+10/i] },
  },
  dcf: {
    domain: 'finance',
    objective: 'Crea DCF professionale. Fogli: (1) Assumptions: Tasso Crescita 10%, Margine EBITDA 20%, WACC 8%, Aliquota 25%, Anni 5, Terminal Growth 2.5%, Capex iniziale 2000. (2) Projections Anno 1-5: Revenue parte da 1000, EBITDA = Revenue*Margine, EBIT=EBITDA, Tasse=EBIT*Aliquota, NOPAT, FCF=NOPAT (no D&A). (3) Valuation: Terminal Value=FCF5*(1+g)/(WACC-g), NPV FCF+TV, IRR. SOLO FORMULE. Formattazione IB: header #1F4E79, input #FFF2CC.',
    expect: {
      sheets: ['Assumptions', 'Projections', 'Valuation'],
      minCells: 60,
      minFormulas: 25,
      mustHaveFormulas: [/NPV|Enterprise|IRR/i, /Terminal/i, /Assumptions!/],
      perPeriodFormulas: { Projections: 5 },
    },
  },
  fastfood_bp: {
    domain: 'finance',
    objective: 'Crea business plan MEAT CREW fast-food Milano. Fogli: (1) Assumptions: affitto 8000, food cost 28%, labor 22%, utenze 3%, marketing 2%, scontrino 18, coperti 120, capex 350k, multiplo 8x, WACC 9%. (2) Menu completo: Starters MOCHOS BITES 6.90, CHICKEN TENDERS 6.90. Burger: L.A. 14.50/21.90, CRISPY 14.50/21.90, MAC CHEESE 15.50/22.90, OKLAHOMA 15.00/22.40, JUNIOR 8.50. Sandwiches: PASTRAMI 19.00/26.40, THE O.G. 14.50/21.90. Hot Dogs: BACON DOG 8.00/15.40, CHILI DOG 9.00/16.40. Sides: CRISPY FRIES 5.50, BACON FRIES 6.50, CHILI FRIES 6.50, MAC CHEESE 6.50. Sweets: BANANA PUDDING 4.90, GLAZED DONUT 2.50. Milkshakes 6.00. Drinks: Acqua 2.00, FREE REFILL 4.50, Birra Raw 5.50. (3) Personnel: Manager 3500, 2 Leader 2400, 6 Crew 1500, +30% loaded. (4) Revenue: 60 mesi, stagionalità ±15%, growth Y2+15% Y3+10% Y4-5+5%, revenue = coperti*giorni*scontrino. (5) PnL: 60 mesi + 5 annuali, EBITDA, ammortamenti(350k/60mesi), EBIT, IRES+IRAP, Net Income. (6) CashFlow: Operating CF, Investing, FCF. (7) BreakEven mensile costi fissi/variabili. (8) ScaleUp 4 città. (9) Valuation DCF IRR. (10) Sensitivity 5×5 scontrino×coperti su EBITDA con FORMULE verso Assumptions. SOLO FORMULE.',
    expect: {
      // Accept common synonyms via canonKey fuzzy-match: "Menu" ↔ "Menu Mix", "Personnel" ↔ "Staffing".
      sheets: ['Assumptions', 'Menu', 'Staffing', 'Revenue', 'PnL', 'CashFlow', 'Valuation', 'Sensitivity'],
      minCells: 200,
      minFormulas: 80,
      mustHaveFormulas: [/Assumptions!/, /SUM/i],
    },
  },
  vairano: {
    domain: 'real_estate',
    objective: 'Crea valutazione progetto immobiliare Vairano Scalo (CE): 10 piani, 1000mq/piano. Fogli: (1) Assumptions: Prezzo 2200€/mq, Costo 850€/mq, Oneri 120€/mq, Progettazione 5%, DL 3%, Collaudo 1.5%, Commercializzazione 3% ricavo, Oneri fin 4.5%/18mesi, Imprevisti 5%, Terreno 800k, IVA costi 10%/vendite 4%. (2) Costi: dettaglio con formule verso Assumptions. (3) Ricavi: lordo 2200*10000, netto. (4) PianoFinanziario: Equity 30%, Debito 70%, Interessi 4.5%/2.5anni, bullet. (5) CashFlow: 36 mesi, S-curve costruzione 5/10/20/30/20/10/5%, vendite progressive 10/20/30/25/15% mesi 20-28. (6) ContoEconomico. (7) Indici: ROI, ROE, IRR. (8) Sensitivity 5×5 Prezzo×Costo su Utile con FORMULE verso Assumptions. SOLO FORMULE.',
    expect: {
      sheets: ['Assumptions', 'Costi', 'Ricavi', 'PianoFinanziario', 'CashFlow', 'ContoEconomico', 'Indici', 'Sensitivity'],
      minCells: 120,
      minFormulas: 50,
      mustHaveFormulas: [/Assumptions!/, /IRR/i],
    },
  },

  // GENERALIZATION CHECKS — distinct finance models not in original bench.
  // These verify the pipeline works on common finance tasks the user will
  // actually run, not just the 4 scenarios above.
  lbo: {
    domain: 'finance',
    objective: 'Crea un LBO model semplice. Fogli: (1) Assumptions: Entry EV 500m, Entry EBITDA 50m (10x multiple), Exit Multiple 9x dopo 5 anni, Debt/EBITDA 5x all\'entrata, Interest rate 6%, Tax 25%, Revenue growth 8%/anno, EBITDA margin steady 18%, D&A 4% of revenue, CapEx 5% of revenue, NWC change 1% of revenue change. (2) Sources_Uses: Sources (Debt + Sponsor Equity), Uses (Entry EV + Fees 2%). (3) Projections Year 0-5: Revenue, EBITDA, D&A, EBIT, Interest, EBT, Tax, Net Income, FCF, Debt Schedule (beginning balance, mandatory repayment 5%, sweep, ending balance). (4) Returns: Exit EV, Exit Equity Value (= Exit EV - Final Debt), IRR, MOIC. SOLO FORMULE — niente valori hardcoded per item calcolati.',
    expect: {
      sheets: ['Assumptions', 'Sources_Uses', 'Projections', 'Returns'],
      minCells: 60,
      minFormulas: 25,
      mustHaveFormulas: [/IRR|MOIC/i, /Assumptions!/],
    },
  },
  three_statement: {
    domain: 'finance',
    objective: 'Crea un mini 3-statement model (Income Statement + Balance Sheet + Cash Flow) per una azienda manifatturiera. Fogli: (1) Assumptions: Revenue 100m anno 0, Growth 7%/anno per 4 anni, COGS 60% revenue, OpEx 22% revenue, Tax 25%, D&A 4% revenue, CapEx 6% revenue, DSO 45 giorni, DPO 30 giorni, DIO 60 giorni. (2) IncomeStatement Y0-Y4: Revenue, COGS, Gross Profit, OpEx, EBITDA, D&A, EBIT, Tax, Net Income. (3) BalanceSheet Y0-Y4: Cash (plug), AR (=Revenue×DSO/365), Inventory (=COGS×DIO/365), Total CA, PP&E (=prev+CapEx-D&A), Total Assets, AP (=COGS×DPO/365), Debt steady 20m, Equity (=prev+NI), Total L+E. Verifica TA = TL+E. (4) CashFlow Y1-Y4: NI, +D&A, -ΔAR, -ΔInventory, +ΔAP, Operating CF, -CapEx, Investing CF, Financing CF (0), Net Change Cash, Beginning Cash, Ending Cash. SOLO FORMULE.',
    expect: {
      sheets: ['Assumptions', 'IncomeStatement', 'BalanceSheet', 'CashFlow'],
      minCells: 100,
      minFormulas: 50,
      mustHaveFormulas: [/Assumptions!/, /IncomeStatement!|BalanceSheet!/],
    },
  },

  // STRESS TEST — Complex M&A merger model. 12+ sheets, accretion/dilution,
  // synergies, debt schedule, sensitivity. Pushes pipeline to its limits.
  ma_merger: {
    domain: 'finance',
    objective: 'Crea un M&A merger model completo. Acquirer "AlphaCo" compra "BetaCo". Fogli: (1) Assumptions: Acquirer share price 50, shares outstanding 100m, P/E 15x, EBITDA 200m. Target market cap 1500m, EBITDA 100m, premium offered 30%, deal structure 60% stock / 40% cash. Synergies revenue +50m/anno, cost -30m/anno realizzate linearmente in 3 anni. Tax 25%, financing rate 5%, transaction fees 1.5% del deal value. (2) DealStructure: Offer Price/share, Equity Purchase Price (= target_mcap × 1+premium), Enterprise Value, Cash Consideration, Stock Consideration, New Shares Issued (=stock_consid/acquirer_share). (3) Sources_Uses: Sources (New Debt, New Equity, Cash on hand), Uses (Purchase Equity, Refinance Debt, Fees). (4) AcquirerStandalone Y1-Y5: Revenue, EBITDA, D&A, EBIT, Interest, EBT, Tax, NI. (5) TargetStandalone Y1-Y5 stessa struttura. (6) Synergies Y1-Y5: Revenue synergies (ramp 33/66/100/100/100% of 50m), Cost synergies (ramp), Integration costs (-15m Y1, -10m Y2), Net Synergy. (7) ProForma Y1-Y5: Combined Revenue (=Acquirer+Target+Syn), Combined EBITDA, D&A, EBIT, Interest (on new debt+existing), EBT, Tax, NI. (8) Accretion_Dilution Y1-Y5: Acquirer Standalone EPS, ProForma EPS (=ProForma NI / (acquirer_shares + new_shares)), Accretion/Dilution %, GAAP/Cash EPS distinction. (9) DebtSchedule Y0-Y5: Beginning Debt, Mandatory Amort 5%, Cash Sweep, Ending Debt, Interest Expense. (10) Returns: IRR sponsor, MOIC, NPV synergies. (11) Sensitivity_AccrDil: matrice 5×5 Premium vs Synergies Realization su Y1 Accretion. (12) Sensitivity_IRR: matrice 5×5 Exit Multiple vs Hold Period su IRR. Cross-sheet refs sempre con $.',
    expect: {
      sheets: ['Assumptions', 'DealStructure', 'Sources_Uses', 'AcquirerStandalone', 'TargetStandalone', 'Synergies', 'ProForma', 'Accretion_Dilution', 'DebtSchedule', 'Returns', 'Sensitivity_AccrDil', 'Sensitivity_IRR'],
      minCells: 250,
      minFormulas: 150,
      mustHaveFormulas: [/Assumptions!/, /Synergies|Synerg/i, /Accretion|Dilution|EPS/i],
    },
  },
};

function summarizeActions(actions) {
  const sheets = new Set();
  const refs = new Set();
  let totalCells = 0;
  let formulas = 0;
  let hardcoded = 0;
  let formattedNumeric = 0;
  let unformattedNumeric = 0;
  let fillRangeCount = 0;
  let wholeColumn = 0;
  const formulasByCell = new Map();
  const allFormulaStrings = [];
  const allLabelStrings = [];
  const cellsBySheet = {};
  const addressTouchCount = new Map();
  const refsWithoutDollar = [];

  for (const a of actions || []) {
    if (a.sheet) sheets.add(a.sheet);
    if (a.type === 'createSheet') sheets.add(a.sheet);
    if (a.type === 'fillRange') fillRangeCount++;
    if (a.type === 'setCellFormat' && a.target && isWholeColumnOrRow(a.target)) wholeColumn++;
    if (a.type === 'setCellRange' && a.cells) {
      const sh = a.sheet || a.sheetName || 'Sheet1';
      cellsBySheet[sh] = cellsBySheet[sh] || 0;
      for (const [addr, spec] of Object.entries(a.cells)) {
        totalCells++;
        cellsBySheet[sh]++;
        const fullKey = `${sh}!${addr}`;
        addressTouchCount.set(fullKey, (addressTouchCount.get(fullKey) || 0) + 1);
        if (isWholeColumnOrRow(addr)) wholeColumn++;
        if (!spec || typeof spec !== 'object') {
          if (typeof spec === 'number') { hardcoded++; unformattedNumeric++; }
          continue;
        }
        const hasFormula = typeof spec.formula === 'string' && spec.formula.length > 0;
        const isNumeric = typeof spec.value === 'number';
        const hasNumFmt = !!(spec.cellStyles && spec.cellStyles.numberFormat);
        if (typeof spec.value === 'string') allLabelStrings.push(spec.value);
        if (hasFormula) {
          formulas++;
          formulasByCell.set(`${sh}!${addr}`, spec.formula);
          allFormulaStrings.push(spec.formula);
          const refMatches = spec.formula.match(/([A-Za-z_][A-Za-z0-9_]*)!/g);
          if (refMatches) refMatches.forEach(s => refs.add(s.replace('!', '')));
          // Detect cross-sheet refs without absolute $ — they break when copied across periods.
          const crossSheetNoDollar = spec.formula.match(/[A-Za-z_]\w*![A-Z]+\d+(?![:])/g);
          if (crossSheetNoDollar) {
            for (const r of crossSheetNoDollar) {
              if (!r.includes('$')) refsWithoutDollar.push(`${fullKey}: ${r}`);
            }
          }
        } else if (isNumeric) {
          hardcoded++;
          if (hasNumFmt) formattedNumeric++; else unformattedNumeric++;
        }
      }
    }
  }

  const missingSheetRefs = [...refs].filter(r => !sheets.has(r));
  const duplicateAddresses = [...addressTouchCount.entries()].filter(([, n]) => n > 1).map(([k]) => k);

  return {
    sheets: [...sheets],
    totalCells, formulas, hardcoded,
    formattedNumeric, unformattedNumeric,
    fillRangeCount, wholeColumn,
    missingSheetRefs,
    duplicateAddresses,
    refsWithoutDollar: refsWithoutDollar.slice(0, 10),
    cellsBySheet,
    allFormulaStrings,
    allLabelStrings,
  };
}

function scoreScenario(key, scenario, actions, summary) {
  const exp = scenario.expect || {};
  const issues = [];

  // Cell-level dependency validation — catches #REF!/#NAME?/#VALUE! before deploy.
  const depIssues = validateCellDeps(actions);
  for (const d of depIssues) {
    issues.push({ severity: d.severity, kind: d.kind, msg: `${d.location}: ${d.detail}` });
  }

  function canonKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  const presentKeys = summary.sheets.map(canonKey);
  function matchSheet(req) {
    const r = canonKey(req);
    return presentKeys.some(p => p === r || p.includes(r) || r.includes(p));
  }
  for (const required of exp.sheets || []) {
    if (!matchSheet(required)) {
      issues.push({ severity: 'critical', kind: 'missing_sheet', msg: `sheet "${required}" not created` });
    }
  }
  if (exp.minCells && summary.totalCells < exp.minCells) {
    issues.push({ severity: 'high', kind: 'low_density', msg: `cells ${summary.totalCells} < expected ${exp.minCells}` });
  }
  if (exp.minFormulas && summary.formulas < exp.minFormulas) {
    issues.push({ severity: 'high', kind: 'low_formulas', msg: `formulas ${summary.formulas} < expected ${exp.minFormulas}` });
  }
  for (const re of exp.mustHaveFormulas || []) {
    const hit = summary.allFormulaStrings.some(f => re.test(f))
      || summary.allLabelStrings.some(l => re.test(l));
    if (!hit) issues.push({ severity: 'high', kind: 'missing_concept', msg: `no formula or label matches ${re}` });
  }
  if (summary.fillRangeCount > 0) {
    issues.push({ severity: 'medium', kind: 'fillRange_leaked', msg: `${summary.fillRangeCount} fillRange leaked past sanitizer` });
  }
  if (summary.wholeColumn > 0) {
    issues.push({ severity: 'critical', kind: 'whole_column', msg: `${summary.wholeColumn} whole-column refs` });
  }
  if (summary.missingSheetRefs.length > 0) {
    issues.push({ severity: 'critical', kind: 'broken_refs', msg: `formulas reference non-existent sheets: ${summary.missingSheetRefs.join(', ')}` });
  }
  if (summary.duplicateAddresses.length > 0) {
    issues.push({ severity: 'high', kind: 'duplicate_addresses', msg: `${summary.duplicateAddresses.length} cells written twice (slice collision): ${summary.duplicateAddresses.slice(0, 3).join(', ')}` });
  }
  if (summary.refsWithoutDollar.length > 5) {
    issues.push({ severity: 'medium', kind: 'cross_sheet_no_dollar', msg: `${summary.refsWithoutDollar.length}+ cross-sheet refs without $ (will break on copy)` });
  }
  if (summary.hardcoded > summary.formulas && summary.formulas > 0) {
    issues.push({ severity: 'medium', kind: 'too_many_hardcoded', msg: `${summary.hardcoded} hardcoded numerics vs ${summary.formulas} formulas` });
  }
  for (const required of exp.sheets || []) {
    const r = canonKey(required);
    const matchedReal = summary.sheets.find(s => {
      const p = canonKey(s);
      return p === r || p.includes(r) || r.includes(p);
    });
    if (matchedReal && (!summary.cellsBySheet[matchedReal] || summary.cellsBySheet[matchedReal] < 4)) {
      issues.push({ severity: 'high', kind: 'empty_sheet', msg: `sheet "${required}" (→${matchedReal}) has only ${summary.cellsBySheet[matchedReal] || 0} cells` });
    }
  }
  if (summary.unformattedNumeric > 5) {
    issues.push({ severity: 'low', kind: 'unformatted_numbers', msg: `${summary.unformattedNumeric} numeric cells without numberFormat` });
  }

  // Semantic checks: detect Mix % NOT summing to 100% via SUMPRODUCT
  for (const f of summary.allFormulaStrings) {
    if (/SUMPRODUCT/i.test(f) && /\bF\b|\bMix\b/i.test(f)) {
      // We can't easily evaluate without running Excel — but flag suspicious patterns
    }
  }

  const criticalCount = issues.filter(i => i.severity === 'critical').length;
  const highCount = issues.filter(i => i.severity === 'high').length;
  const mediumCount = issues.filter(i => i.severity === 'medium').length;
  const lowCount = issues.filter(i => i.severity === 'low').length;
  const score = Math.max(0, 100 - criticalCount * 25 - highCount * 10 - mediumCount * 4 - lowCount * 1);
  const passed = criticalCount === 0 && highCount === 0;

  return { score, passed, issues, criticalCount, highCount, mediumCount, lowCount };
}

async function runScenario(key, scenario) {
  const start = Date.now();
  let result;
  try {
    result = await enhancedPipeline(scenario.objective, {}, { skipCritic: true });
  } catch (e) {
    return { key, status: 'error', error: e.message, elapsedS: (Date.now() - start) / 1000 };
  }

  if (result.status !== 'ok') {
    return { key, status: 'failed', error: result.error, elapsedS: (Date.now() - start) / 1000 };
  }

  const summary = summarizeActions(result.actions);
  const score = scoreScenario(key, scenario, result.actions, summary);
  const elapsedS = (Date.now() - start) / 1000;
  const tokens = (result.totalTokens?.promptTokens || 0) + (result.totalTokens?.completionTokens || 0);

  return {
    key,
    status: 'ok',
    elapsedS,
    tokens,
    cellCount: summary.totalCells,
    formulaCount: summary.formulas,
    sheets: summary.sheets,
    fillRangeCount: summary.fillRangeCount,
    wholeColumn: summary.wholeColumn,
    missingSheetRefs: summary.missingSheetRefs,
    sanitizer: result.pipeline?.sanitizer || result.sanitizerStats || null,
    ...score,
    actions: result.actions,
  };
}

async function main() {
  const filter = process.argv.find(a => a.startsWith('--scenario='));
  const keys = filter ? filter.split('=')[1].split(',') : Object.keys(SCENARIOS);
  const saveActions = process.argv.includes('--save-actions');
  const serial = process.argv.includes('--serial');

  const wallStart = Date.now();
  console.log('═══ CODEFIRST QUALITY BENCH ═══');
  console.log(`Model: ${process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'}`);
  console.log(`Scenarios: ${keys.join(', ')} (${serial ? 'serial' : 'parallel'})\n`);

  const scenarios = keys.map(k => ({ key: k, sc: SCENARIOS[k] })).filter(x => x.sc);

  const reportResult = (r) => {
    if (r.status !== 'ok') {
      console.log(`─── ${r.key} ───`);
      console.log(`  ✗ ${r.status}: ${r.error}`);
      return;
    }
    const flag = r.passed ? '✓' : '✗';
    console.log(`─── ${r.key} ───`);
    console.log(`  ${flag} score=${r.score}/100 cells=${r.cellCount} formulas=${r.formulaCount} sheets=${r.sheets.length} ${r.elapsedS.toFixed(0)}s ${r.tokens.toLocaleString()}tok`);
    if (r.sanitizer) console.log(`  sanitizer: ${JSON.stringify(r.sanitizer)}`);
    for (const i of r.issues) console.log(`    [${i.severity}] ${i.kind}: ${i.msg}`);
    if (saveActions) {
      const out = path.join('/tmp', `cf_actions_${r.key}_${Date.now()}.json`);
      fs.writeFileSync(out, JSON.stringify({ scenario: r.key, summary: r, actions: r.actions }, null, 2));
      console.log(`  actions → ${out}`);
    }
  };

  let results;
  if (serial) {
    results = [];
    for (const { key, sc } of scenarios) {
      const r = await runScenario(key, sc);
      results.push(r);
      reportResult(r);
    }
  } else {
    results = await Promise.all(scenarios.map(({ key, sc }) => runScenario(key, sc)));
    for (const r of results) reportResult(r);
  }
  const wallS = (Date.now() - wallStart) / 1000;

  console.log('\n═══ SUMMARY ═══');
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const avgScore = results.reduce((s, r) => s + (r.score || 0), 0) / Math.max(1, total);
  const sumTime = results.reduce((s, r) => s + (r.elapsedS || 0), 0);
  const avgTime = sumTime / Math.max(1, total);
  console.log(`Pass: ${passed}/${total} | avg score: ${avgScore.toFixed(1)}/100 | avg per scenario: ${avgTime.toFixed(0)}s | sum: ${sumTime.toFixed(0)}s | wall: ${wallS.toFixed(0)}s`);

  const outPath = path.join('/tmp', `cf_quality_${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results.map(r => ({ ...r, actions: undefined })), null, 2));
  console.log(`Saved → ${outPath}`);

  process.exit(passed === total ? 0 : 1);
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e); process.exit(2); });
}

module.exports = { SCENARIOS, runScenario, summarizeActions, scoreScenario };
