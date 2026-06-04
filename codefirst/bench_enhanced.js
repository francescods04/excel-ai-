#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { enhancedPipeline } = require('./enhanced');
const { executeCode } = require('./bridge');
const fs = require('fs');
const logger = require('../server/utils/logger');

const SCENARIOS = {
  sumcol: {
    domain: 'simple',
    objective: 'Crea un foglio "Dati". Header A1:D1: Nome, Età, Città, Età+10 (grassetto, sfondo blu #1F4E79, testo bianco). 5 righe: Mario 30 Roma, Lucia 28 Milano, Paolo 45 Napoli, Anna 22 Torino, Marco 35 Bologna. In D2:D6 formula =B2+10. Bordi su tutto.',
  },
  dcf: {
    domain: 'finance',
    objective: 'Crea DCF professionale. Fogli: (1) Assumptions: Tasso Crescita 10%, Margine EBITDA 20%, WACC 8%, Aliquota 25%, Anni 5, Terminal Growth 2.5%, Capex iniziale 2000. (2) Projections Anno 1-5: Revenue parte da 1000, EBITDA = Revenue*Margine, EBIT=EBITDA, Tasse=EBIT*Aliquota, NOPAT, FCF=NOPAT (no D&A). (3) Valuation: Terminal Value=FCF5*(1+g)/(WACC-g), NPV FCF+TV, IRR. SOLO FORMULE. Formattazione IB: header #1F4E79, input #FFF2CC.',
  },
  fastfood_bp: {
    domain: 'finance',
    objective: 'Crea business plan MEAT CREW fast-food Milano. Fogli: (1) Assumptions: affitto 8000, food cost 28%, labor 22%, utenze 3%, marketing 2%, scontrino 18, coperti 120, capex 350k, multiplo 8x, WACC 9%. (2) Menu completo: Starters MOCHOS BITES 6.90, CHICKEN TENDERS 6.90. Burger: L.A. 14.50/21.90, CRISPY 14.50/21.90, MAC CHEESE 15.50/22.90, OKLAHOMA 15.00/22.40, JUNIOR 8.50. Sandwiches: PASTRAMI 19.00/26.40, THE O.G. 14.50/21.90. Hot Dogs: BACON DOG 8.00/15.40, CHILI DOG 9.00/16.40. Sides: CRISPY FRIES 5.50, BACON FRIES 6.50, CHILI FRIES 6.50, MAC CHEESE 6.50. Sweets: BANANA PUDDING 4.90, GLAZED DONUT 2.50. Milkshakes 6.00. Drinks: Acqua 2.00, FREE REFILL 4.50, Birra Raw 5.50. (3) Personnel: Manager 3500, 2 Leader 2400, 6 Crew 1500, +30% loaded. (4) Revenue: 60 mesi, stagionalità ±15%, growth Y2+15% Y3+10% Y4-5+5%, revenue = coperti*giorni*scontrino. (5) PnL: 60 mesi + 5 annuali, EBITDA, ammortamenti(350k/60mesi), EBIT, IRES+IRAP, Net Income. (6) CashFlow: Operating CF, Investing, FCF. (7) BreakEven mensile costi fissi/variabili. (8) ScaleUp 4 città. (9) Valuation DCF IRR. (10) Sensitivity 5×5 scontrino×coperti su EBITDA con FORMULE verso Assumptions. SOLO FORMULE.',
  },
  vairano: {
    domain: 'real_estate',
    objective: 'Crea valutazione progetto immobiliare Vairano Scalo (CE): 10 piani, 1000mq/piano. Fogli: (1) Assumptions: Prezzo 2200€/mq, Costo 850€/mq, Oneri 120€/mq, Progettazione 5%, DL 3%, Collaudo 1.5%, Commercializzazione 3% ricavo, Oneri fin 4.5%/18mesi, Imprevisti 5%, Terreno 800k, IVA costi 10%/vendite 4%. (2) Costi: dettaglio con formule verso Assumptions. (3) Ricavi: lordo 2200*10000, netto. (4) PianoFinanziario: Equity 30%, Debito 70%, Interessi 4.5%/2.5anni, bullet. (5) CashFlow: 36 mesi, S-curve costruzione 5/10/20/30/20/10/5%, vendite progressive 10/20/30/25/15% mesi 20-28. (6) ContoEconomico. (7) Indici: ROI, ROE, IRR. (8) Sensitivity 5×5 Prezzo×Costo su Utile con FORMULE verso Assumptions. SOLO FORMULE.',
  },
};

const AGENT_LOOP_ESTIMATES = {
  sumcol: { tokens: 120000, seconds: 45 },
  dcf: { tokens: 3200000, seconds: 210 },
  fastfood_bp: { tokens: 18500000, seconds: 900 },
  vairano: { tokens: 22000000, seconds: 1200 },
};

const FLASH_INPUT = 0.14 / 1e6;
const FLASH_OUTPUT = 0.28 / 1e6;

async function runBenchmark() {
  const filter = process.argv.find(a => a.startsWith('--scenario='));
  const keys = filter ? filter.split('=')[1].split(',') : Object.keys(SCENARIOS);

  console.log('═══ ENHANCED PIPELINE BENCHMARK ═══');
  console.log('Model:', process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro');
  console.log('Pipeline: plan → codegen → critic → refiner → execute');
  console.log('');

  const results = [];
  const allActions = {};

  for (const key of keys) {
    const sc = SCENARIOS[key];
    if (!sc) continue;

    console.log(`─── ${key} (${sc.domain}) ───`);
    const start = Date.now();

    let result;
    try {
      result = await enhancedPipeline(sc.objective, {}, { skipCritic: false });
    } catch (e) {
      console.log(`  FAILED: ${e.message}`);
      results.push({ key, status: 'failed', error: e.message });
      continue;
    }

    if (result.status !== 'ok') {
      console.log(`  FAILED: ${result.error}`);
      results.push({ key, status: 'failed', error: result.error });
      continue;
    }

    const tt = result.totalTokens || {};
    const totalTokens = (tt.promptTokens || 0) + (tt.completionTokens || 0);
    const cost = ((tt.promptTokens || 0) * FLASH_INPUT) + ((tt.completionTokens || 0) * FLASH_OUTPUT);
    const totalS = (Date.now() - start) / 1000;

    const phases = result.pipeline?.phases || {};
    const phaseStr = ['plan','codegen','critic','refiner']
      .filter(p => phases[p])
      .map(p => {
        const pk = Object.keys(phases[p]);
        const ms = phases[p][pk.find(k => k.endsWith('Ms'))];
        return p[0].toUpperCase() + (ms ? `${(ms/1000).toFixed(0)}s` : '?');
      })
      .join(' → ');

    console.log(`  Phases: ${phaseStr} → exec`);
    console.log(`  Cells: ${result.cellCount} | Tokens: ${totalTokens.toLocaleString()} | Time: ${totalS.toFixed(0)}s | Cost: $${cost.toFixed(3)}`);
    console.log(`  Skills: ${result.skillNames?.join(', ') || 'none'}`);
    console.log(`  Review: score=${result.review?.score || '?'}/100, issues=${result.review?.issues?.length || 0}`);
    if (result.review?.issues?.filter(i => i.severity === 'critical').length) {
      console.log(`  Critical: ${result.review.issues.filter(i => i.severity === 'critical').map(i => i.description.slice(0, 80)).join('; ')}`);
    }
    console.log('');

    results.push({
      key, domain: sc.domain, status: 'ok',
      cellCount: result.cellCount,
      totalTokens, totalS, cost,
      reviewScore: result.review?.score,
      reviewIssues: result.review?.issues?.length || 0,
      skills: result.skillNames,
    });

    allActions[key] = result.actions;
    if (result.code) fs.writeFileSync(`/tmp/${key}_enhanced_code.py`, result.code);
  }

  console.log('═'.repeat(95));
  console.log(`${'Scenario'.padEnd(16)} ${'Cells'.padEnd(8)} ${'Tokens'.padEnd(14)} ${'Time'.padEnd(8)} ${'Cost'.padEnd(10)} ${'vs Agent'.padEnd(16)} ${'Speedup'.padEnd(8)}`);
  console.log('─'.repeat(95));

  let totalCF = 0, totalAL = 0;
  for (const r of results) {
    const est = AGENT_LOOP_ESTIMATES[r.key] || { tokens: 5e6, seconds: 300 };
    const tokRed = r.totalTokens > 0 ? ((1 - r.totalTokens / est.tokens) * 100).toFixed(1) + '%' : 'N/A';
    const spd = r.totalS > 0 ? Math.round(est.seconds / r.totalS) + 'x' : 'N/A';
    console.log(`${r.key.padEnd(16)} ${String(r.cellCount || '?').padEnd(8)} ${r.totalTokens.toLocaleString().padEnd(14)} ${(r.totalS?.toFixed(0) + 's').padEnd(8)} $${(r.cost || 0).toFixed(3).padEnd(9)} ${tokRed.padEnd(16)} ${spd.padEnd(8)}`);
    totalCF += r.totalTokens || 0;
    totalAL += est.tokens;
  }

  console.log('─'.repeat(95));
  const totalRed = totalAL > 0 ? ((1 - totalCF / totalAL) * 100).toFixed(1) + '%' : 'N/A';
  console.log(`${'TOTAL'.padEnd(16)} ${results.reduce((s,r) => s + (r.cellCount||0), 0).toString().padEnd(8)} ${totalCF.toLocaleString().padEnd(14)} ${''.padEnd(8)} ${''.padEnd(10)} ${totalRed.padEnd(16)}`);

  const alCost = totalAL * 0.7 * FLASH_INPUT + totalAL * 0.3 * FLASH_OUTPUT;
  const cfCost = results.reduce((s, r) => s + (r.cost || 0), 0);
  console.log(`\nAgent loop cost (est): $${alCost.toFixed(2)}`);
  console.log(`Enhanced cost:         $${cfCost.toFixed(3)}`);
  console.log(`Cost reduction:        ${alCost > 0 ? ((1 - cfCost / alCost) * 100).toFixed(1) : 'N/A'}%`);

  fs.writeFileSync(`/tmp/enhanced_bench_${Date.now()}.json`, JSON.stringify(results, null, 2));
  console.log(`\nSaved to /tmp/enhanced_bench_*.json`);
  console.log(`Code files: /tmp/*_enhanced_code.py`);

  const allOk = results.every(r => r.status === 'ok');
  process.exit(allOk ? 0 : 1);
}

runBenchmark().catch(e => { console.error('FATAL:', e); process.exit(1); });
