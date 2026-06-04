#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { run } = require('./runner');
const { resetUsageStats, getUsageStats } = require('../server/tools/llm');
const logger = require('../server/utils/logger');

const SCENARIOS = {
  sumcol: {
    domain: 'simple',
    objective: 'Crea un foglio chiamato "Dati". In A1:C1 metti gli header: Nome, Età, Città (grassetto, sfondo blu, testo bianco). Aggiungi 5 righe di esempio: Mario 30 Roma, Lucia 28 Milano, Paolo 45 Napoli, Anna 22 Torino, Marco 35 Bologna. In D1 metti header "Età+10" (stesso formato). In D2:D6 metti una formula che somma B2+10, B3+10, etc.',
    context: {},
  },

  dcf: {
    domain: 'finance',
    objective: 'Crea da zero un mini DCF professionale. Fogli: (1) "Assumptions" con: Tasso di Crescita 10%, Margine EBITDA 20%, WACC 8%, Aliquota Fiscale 25%, Anni di Proiezione 5. (2) "Projections" con colonne Anno 1-5: Revenue che parte da 1000 e cresce del tasso di crescita, EBITDA = Revenue × Margine EBITDA, EBIT = EBITDA (no D&A per semplicità), Tasse = EBIT × Aliquota Fiscale, NOPAT = EBIT - Tasse, FCF = NOPAT. (3) "Valuation" con: calcolo del Terminal Value = FCF_Anno5 × (1+2.5%) / (WACC - 2.5%), NPV dei FCF + Terminal Value attualizzati al WACC. Usa formule cross-sheet, formattazione professionale IB (header blu, bordi, number format appropriati).',
    context: {},
  },

  fastfood_bp: {
    domain: 'finance',
    objective: `Crea un business plan completo per la catena fast-food "MEAT CREW" — American Burger a Milano. Fogli:

(1) "Assumptions": drivers principali — affitto mensile Milano 8,000€, food cost 28% del revenue, labor cost 22%, utenze 3%, marketing 2%, scontrino medio 18€, coperti/giorno 120, capex apertura 350,000€, multiplo EBITDA exit 8x.

(2) "Menu": listino letterale (NON modificare prezzi/descrizioni):
Starters: MOCHO'S BITES 6.90€, CHICKEN TENDERS 6.90€
Burger: L.A. 14.50€ (singolo) / 21.90€ (menu), CRISPY 14.50€ / 21.90€, MAC 'N' CHEESE 15.50€ / 22.90€, OKLAHOMA 15.00€ / 22.40€, JUNIOR 8.50€
Sandwiches: PASTRAMI 19.00€ / 26.40€, THE O.G. 14.50€ / 21.90€
Hot Dogs: BACON DOG 8.00€ / 15.40€, CHILI DOG 9.00€ / 16.40€
Sides: CRISPY FRIES 5.50€, BACON FRIES 6.50€, CHILI FRIES 6.50€, MAC 'N' CHEESE 6.50€
Sweets: BANANA PUDDING 4.90€, GLAZED DONUT 2.50€
Milkshakes 6.00€ (Vaniglia, PB, Banana, Fragola, Cioccolato, Oreo)
Drinks: Acqua 2.00€, FREE REFILL 4.50€, Birra Raw 5.50€

(3) "Personnel": organico mensile — Store Manager 3,500€, 2 Shift Leader 2,400€ cad, 6 Crew 1,500€ cad, costo annuo loaded (+30% oneri).

(4) "Revenue": forecast 60 mesi con stagionalità mensile (±15% vs media), growth anno 2 +15%, anno 3 +10%, anno 4-5 +5%. Calcola revenue = coperti × scontrino medio × giorni apertura (30/mese).

(5) "PnL": mensile e annuale 5 anni. Revenue, Food Cost, Labor, Utenze, Marketing, Affitto, EBITDA, Ammortamenti (lineari su 5 anni del capex), EBIT, Tasse (IRES 24% + IRAP 3.9%), Net Income.

(6) "CashFlow": Operating CF (EBITDA - Tasse - ΔNWC), Investing (capex iniziale + maintenance 2%/anno), Financing (zero), FCF, cumulative.

(7) "BreakEven": mensile — Revenue mensile, Costi Fissi (affitto + personale + ammortamenti), Costi Variabili (food+labor+utenze+marketing), Margine di Contribuzione, Break-Even mensile (costi fissi / margine %).

(8) "ScaleUp": apertura nuove location anno 2-5 (Roma, Bologna, Torino, Firenze) con capex ridotto 250,000€ cad, revenue scalato per popolazione. Revenue consolidato per location.

(9) "Valuation": DCF — FCF proiettati 5 anni, Terminal Value = FCF_anno5 × (1+2%) / (WACC 9% - 2%), NPV del TV + FCF, Equity Value (no debito), IRR implicito sul capex iniziale, Sensitivity WACC vs Exit Multiple.

(10) "Sensitivity": matrice scontrino medio (16-22€) × coperti/giorno (100-150) su EBITDA anno 5.

Formattazione professionale: header blu scuro #1F4E79, testo bianco, bordi sottili, numeri in €, percentuali in 0.0%.`,
    context: {},
  },

  vairano: {
    domain: 'real_estate',
    objective: `Crea un excel completo per la valutazione di un progetto immobiliare residenziale. L'immobile: 10 piani fuori terra a Vairano Scalo (CE), 1,000 mq commerciali per piano. Fogli:

(1) "Assumptions": Prezzo vendita 2,200 €/mq, Costo costruzione 850 €/mq, Oneri urbanizzazione 120 €/mq, Costi progettazione 5% del costo costruzione, Direzione lavori 3%, Collaudo 1.5%, Commercializzazione 3% del ricavo, Oneri finanziari 4.5% su esposizione media 18 mesi, Imprevisti 5% del costo totale, Durata costruzione 30 mesi, IVA 10% su costi / 4% su vendite (prima casa).

(2) "Costi": Costo terreno 800,000€, Costruzione = 850 × 10,000mq, Urbanizzazione, Progettazione = 5% × Costruzione, Direzione Lavori = 3% × Costruzione, Collaudo = 1.5% × Costruzione, Commercializzazione = 3% × Ricavo Lordo, Oneri Finanziari = (Costo Totale - Terreno) × 4.5% × (18/12), Imprevisti = 5% × (Subtotale Costi), Costo Totale.

(3) "Ricavi": Vendita lorda = 2,200 × 10,000mq, IVA 4% sulle vendite, Ricavo Netto.

(4) "PianoFinanziario": Equity 30% del costo totale, Debito bancario 70%, Interessi passivi = Debito × 4.5% × 2.5 anni, Rimborso bullet a fine progetto.

(5) "Tempistiche": Gantt 30 mesi: Mesi 1-3 progettazione, 4-6 permessi, 7-24 costruzione, 20-30 vendite progressive. Vendite: 10% mese 20, 20% mese 22, 30% mese 24, 25% mese 26, 15% mese 28.

(6) "CashFlow": mensile per 36 mesi. Uscite: costruzione (S-curve: 5/10/20/30/20/10/5% sui 18 mesi), costi fissi distribuiti. Entrate: vendite progressive. Saldo mensile e cumulato.

(7) "ContoEconomico": Ricavi, Costo del Venduto (costruzione + urbanizzazione + oneri progettazione + DL + collaudo), Margine Lordo, Costi Commerciali, Oneri Finanziari, Imprevisti, Utile Lordo, Imposte (IRES 24% + IRAP 3.9%), Utile Netto.

(8) "Indici": ROI = Utile Netto / Costo Totale, ROE = Utile Netto / Equity, Margin = Utile Netto / Ricavi, Payback (mesi), IRR mensile sui flussi equity.

(9) "Sensitivity": matrice Prezzo Vendita (1,800-2,600 €/mq, step 200) × Costo Costruzione (700-1,000 €/mq, step 50) su Utile Netto e ROE.

Formattazione: header blu #1F4E79 testo bianco, celle input sfondo grigio chiaro #F2F2F2, celle calcolate sfondo azzurro chiaro #DAEEF3, numero in € con formato #,##0, percentuali in 0.0%.`,
    context: {},
  },
};

const FLASH_INPUT_PRICE = 0.14 / 1_000_000;
const FLASH_OUTPUT_PRICE = 0.28 / 1_000_000;

const AGENT_LOOP_ESTIMATES = {
  sumcol: { tokens: 120_000, seconds: 45 },
  dcf: { tokens: 3_200_000, seconds: 210 },
  fastfood_bp: { tokens: 18_500_000, seconds: 900 },
  vairano: { tokens: 22_000_000, seconds: 1200 },
};

async function runBenchmark() {
  const scenarioKeys = Object.keys(SCENARIOS);
  const scenarioArg = process.argv.find(a => a.startsWith('--scenario='));
  const filter = scenarioArg ? scenarioArg.split('=')[1].split(',') : null;
  const keys = filter || scenarioKeys;

  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║        CODEFIRST BENCHMARK                         ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log(`Model: ${process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro'}`);
  console.log(`Scenarios: ${keys.join(', ')}`);
  console.log('');

  const results = [];

  for (const key of keys) {
    const sc = SCENARIOS[key];
    if (!sc) { console.log(`  Scenario "${key}" not found, skipping`); continue; }

    console.log(`─── ${key} (${sc.domain}) ───`);
    process.stdout.write(`  Generating code... `);

    const start = Date.now();
    resetUsageStats();

    const result = await run(sc.objective, sc.context, {
      label: `bench_${key}`,
      timeoutMs: 180000,
    });

    const usage = getUsageStats();
    const totalMs = Date.now() - start;

    if (result.status !== 'ok') {
      console.log(`FAILED: ${result.error || 'unknown'}`);
      results.push({ key, domain: sc.domain, status: 'failed', error: result.error, totalMs, usage });
      continue;
    }

    console.log(`${result.codeLength} chars, ${result.timings.codegenMs}ms`);
    console.log(`  Executing code... ${result.timings.executionMs}ms, ${result.cellCount} cells, ${result.summary.totalFormulas} formulas`);
    console.log(`  Sheets: ${result.summary.sheets.join(', ')}`);
    console.log(`  Actions: ${result.summary.totalActions} (${result.summary.createSheet} createSheet, ${result.summary.setCellRange} setCellRange, ${result.summary.fillRange} fillRange, ${result.summary.bulkSetFormat} format)`);

    const promptTokens = usage?.promptTokens || 0;
    const completionTokens = usage?.completionTokens || 0;
    const cacheHit = usage?.cacheHitTokens || 0;
    const cacheMiss = usage?.cacheMissTokens || 0;
    const totalTokens = promptTokens + completionTokens;
    const costInput = (promptTokens - cacheHit) * FLASH_INPUT_PRICE + cacheHit * 0.0028 / 1_000_000;
    const costOutput = completionTokens * FLASH_OUTPUT_PRICE;
    const cost = costInput + costOutput;

    console.log(`  Tokens: ${promptTokens.toLocaleString()} prompt + ${completionTokens.toLocaleString()} completion = ${totalTokens.toLocaleString()} total`);
    console.log(`  Cache: ${cacheHit.toLocaleString()} hit, ${cacheMiss.toLocaleString()} miss`);
    console.log(`  Cost: ~$${cost.toFixed(4)}`);
    console.log(`  Time: ${(totalMs / 1000).toFixed(1)}s total`);
    console.log('');

    results.push({
      key, domain: sc.domain, status: 'ok',
      codeLength: result.codeLength,
      cellCount: result.cellCount,
      formulas: result.summary.totalFormulas,
      sheets: result.summary.sheets.length,
      actions: result.summary.totalActions,
      promptTokens, completionTokens, totalTokens, cacheHit, cacheMiss,
      cost,
      timings: result.timings,
    });
  }

  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║        COMPARISON vs AGENT LOOP                    ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`${'Scenario'.padEnd(18)} ${'CodeFirst Tokens'.padEnd(20)} ${'AgentLoop Est.'.padEnd(20)} ${'Reduction'.padEnd(12)} ${'Speedup'.padEnd(12)}`);
  console.log('─'.repeat(82));

  let totalCodeFirst = 0;
  let totalAgentLoop = 0;
  let totalCodeFirstTime = 0;
  let totalAgentLoopTime = 0;

  for (const r of results) {
    if (r.status !== 'ok') {
      console.log(`${r.key.padEnd(18)} FAILED`.padEnd(50) + `(${r.error || 'unknown'})`);
      continue;
    }
    const est = AGENT_LOOP_ESTIMATES[r.key] || { tokens: 5_000_000, seconds: 300 };
    const reduction = est.tokens > 0 ? ((1 - r.totalTokens / est.tokens) * 100).toFixed(1) : 'N/A';
    const speedup = r.timings?.totalMs > 0 ? (est.seconds / (r.timings.totalMs / 1000)).toFixed(0) : 'N/A';
    console.log(`${r.key.padEnd(18)} ${r.totalTokens.toLocaleString().padEnd(20)} ${est.tokens.toLocaleString().padEnd(20)} ${(reduction + '%').padEnd(12)} ${(speedup + 'x').padEnd(12)}`);
    totalCodeFirst += r.totalTokens || 0;
    totalAgentLoop += est.tokens;
    totalCodeFirstTime += r.timings?.totalMs || 0;
    totalAgentLoopTime += est.seconds * 1000;
  }

  console.log('─'.repeat(82));
  const totalReduction = totalAgentLoop > 0 ? ((1 - totalCodeFirst / totalAgentLoop) * 100).toFixed(1) : 'N/A';
  const totalSpeedup = totalCodeFirstTime > 0 ? (totalAgentLoopTime / totalCodeFirstTime).toFixed(0) : 'N/A';
  console.log(`${'TOTAL'.padEnd(18)} ${totalCodeFirst.toLocaleString().padEnd(20)} ${totalAgentLoop.toLocaleString().padEnd(20)} ${(totalReduction + '%').padEnd(12)} ${(totalSpeedup + 'x').padEnd(12)}`);
  console.log('');

  const totalCost = results.reduce((s, r) => s + (r.cost || 0), 0);
  const agentLoopCost = totalAgentLoop * FLASH_INPUT_PRICE * 0.7 + totalAgentLoop * 0.3 * FLASH_OUTPUT_PRICE;
  console.log(`CodeFirst cost: ~$${totalCost.toFixed(3)}`);
  console.log(`AgentLoop cost (est): ~$${agentLoopCost.toFixed(2)}`);
  console.log(`Cost reduction: ${agentLoopCost > 0 ? ((1 - totalCost / agentLoopCost) * 100).toFixed(1) : 'N/A'}%`);
  console.log('');

  const allOk = results.every(r => r.status === 'ok');
  console.log(`Status: ${allOk ? 'ALL PASSED' : 'SOME FAILED'}`);
  console.log(`Saved to: /tmp/codefirst_bench_${Date.now()}.json`);

  const fs = require('fs');
  fs.writeFileSync(`/tmp/codefirst_bench_${Date.now()}.json`, JSON.stringify(results, null, 2));

  process.exit(allOk ? 0 : 1);
}

runBenchmark().catch(e => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
