#!/usr/bin/env node
/**
 * Cross-config report for the model cost/quality benchmark.
 *
 * Reads every bench/model-cost-quality-*.jsonl (or files passed as args), groups
 * runs by config label, and prints:
 *   - per-config: scenarios ok, mean quality (0-100), total $ cost, mean latency,
 *     $/scenario and quality-per-dollar
 *   - per-domain quality (finance / data_science / real_estate) per config
 *   - the FLASH-vs-PRO verdict: each config's quality % and cost % vs the best-quality
 *     baseline, and whether a cheaper config clears the quality floor (default 90%)
 *     => "viable as the sole model" or "keep the strong model / use mixed routing".
 *
 * PRICING ($/1M tokens) is approximate — EDIT to your real DeepSeek prices, or pass
 * BENCH_PRICES_JSON='{"pro":{"in":..,"cacheHit":..,"out":..},"flash":{...}}'.
 * Token counts in the jsonl are exact regardless; only the $ conversion uses these.
 *
 * Usage:
 *   node bench/model_cost_quality_report.js
 *   node bench/model_cost_quality_report.js bench/model-cost-quality-flash-no-thinking-*.jsonl ...
 *   BENCH_QUALITY_FLOOR=90 node bench/model_cost_quality_report.js
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PRICES = {
  // DeepSeek list prices ($/1M tokens). pro = promo 75%-off effective rate.
  // in = cache-miss input, cacheHit = cache-hit input, out = output.
  pro:   { in: 0.435, cacheHit: 0.003625, out: 0.87 },
  flash: { in: 0.14,  cacheHit: 0.0028,   out: 0.28 }
};
const PRICES = process.env.BENCH_PRICES_JSON ? JSON.parse(process.env.BENCH_PRICES_JSON) : DEFAULT_PRICES;
const QUALITY_FLOOR = Number(process.env.BENCH_QUALITY_FLOOR) || 90; // % of best quality to call a cheaper config "good enough"

function priceFor(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('pro')) return PRICES.pro;
  return PRICES.flash; // default to flash pricing for anything else
}

function runCostUSD(run) {
  if (!run.usage) return 0;
  const p = priceFor(run.agentModel);
  const { cacheHitTokens = 0, cacheMissTokens = 0, completionTokens = 0, promptTokens = 0 } = run.usage;
  // If cache split is missing, treat all prompt tokens as cache-miss (input).
  const miss = cacheMissTokens || Math.max(0, promptTokens - cacheHitTokens);
  return (cacheHitTokens / 1e6) * p.cacheHit + (miss / 1e6) * p.in + (completionTokens / 1e6) * p.out;
}

function loadRuns(files) {
  const runs = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { runs.push(JSON.parse(t)); } catch (_) {}
    }
  }
  return runs;
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function r1(n) { return Math.round(n * 10) / 10; }

function main() {
  const benchDir = __dirname;
  let files = process.argv.slice(2);
  if (files.length === 0) {
    files = fs.readdirSync(benchDir)
      .filter(f => f.startsWith('model-cost-quality-') && f.endsWith('.jsonl'))
      .map(f => path.join(benchDir, f));
  }
  if (files.length === 0) {
    console.error('Nessun file model-cost-quality-*.jsonl trovato. Esegui prima il sweep.');
    process.exit(1);
  }

  const runs = loadRuns(files);
  if (runs.length === 0) { console.error('Nessun run parsato.'); process.exit(1); }

  // Group by config label
  const byConfig = new Map();
  for (const run of runs) {
    const key = run.config || 'unknown';
    if (!byConfig.has(key)) byConfig.set(key, []);
    byConfig.get(key).push(run);
  }

  const domains = ['finance', 'data_science', 'real_estate'];
  const rows = [];
  for (const [config, list] of byConfig) {
    const scored = list.filter(r => r.quality && r.quality.score != null);
    const completed = list.filter(r => r.status === 'completed');
    const meanQ = mean(scored.map(r => r.quality.score));
    const totalCost = list.reduce((s, r) => s + runCostUSD(r), 0);
    const meanLatency = mean(list.map(r => (r.totalMs || 0) / 1000));
    const totalTok = list.reduce((s, r) => s + (r.usage ? (r.usage.promptTokens + r.usage.completionTokens) : 0), 0);
    const perDomainQ = {};
    for (const d of domains) {
      const dr = scored.filter(r => r.domain === d);
      perDomainQ[d] = dr.length ? Math.round(mean(dr.map(r => r.quality.score))) : null;
    }
    rows.push({
      config,
      agentModel: list[0]?.agentModel,
      thinking: list[0]?.thinking,
      runs: list.length,
      okCompleted: completed.length,
      meanQ,
      totalCost,
      costPerScenario: list.length ? totalCost / list.length : 0,
      meanLatency,
      totalTok,
      qPerDollar: totalCost > 0 ? meanQ / totalCost : null,
      perDomainQ
    });
  }

  // ---- Per-config table ----
  console.log('\n=== MODEL COST / QUALITY ===');
  console.log(`(prices $/1M tok: pro in/hit/out=${PRICES.pro.in}/${PRICES.pro.cacheHit}/${PRICES.pro.out}  flash=${PRICES.flash.in}/${PRICES.flash.cacheHit}/${PRICES.flash.out}  — EDIT to real prices)\n`);
  console.log('config                  model            think   ok    meanQ   $cost    $/scen   meanLat  tok       fin  ds  re');
  for (const r of rows.sort((a, b) => b.meanQ - a.meanQ)) {
    const d = r.perDomainQ;
    console.log(
      `  ${String(r.config).padEnd(22)} ${String(r.agentModel || '-').padEnd(16)} ${String(r.thinking || '-').padEnd(6)} ` +
      `${String(r.okCompleted + '/' + r.runs).padEnd(5)} ${String(r1(r.meanQ)).padStart(5)} ` +
      `${('$' + r.totalCost.toFixed(3)).padStart(8)} ${('$' + r.costPerScenario.toFixed(3)).padStart(8)} ` +
      `${(r1(r.meanLatency) + 's').padStart(7)} ${String(r.totalTok).padStart(8)}  ` +
      `${String(d.finance ?? '-').padStart(3)} ${String(d.data_science ?? '-').padStart(3)} ${String(d.real_estate ?? '-').padStart(3)}`
    );
  }

  // ---- Verdict vs best-quality baseline ----
  const baseline = rows.reduce((best, r) => (r.meanQ > best.meanQ ? r : best), rows[0]);
  console.log(`\n=== VERDICT (baseline = highest quality: "${baseline.config}", Q=${r1(baseline.meanQ)}, $${baseline.totalCost.toFixed(3)}) ===`);
  console.log('config                  quality%ofBest   cost%ofBest   savings   clears ' + QUALITY_FLOOR + '% floor?');
  const candidates = [];
  for (const r of rows.sort((a, b) => a.totalCost - b.totalCost)) {
    const qPct = baseline.meanQ > 0 ? (r.meanQ / baseline.meanQ) * 100 : 0;
    const costPct = baseline.totalCost > 0 ? (r.totalCost / baseline.totalCost) * 100 : 0;
    const savings = 100 - costPct;
    const clears = qPct >= QUALITY_FLOOR;
    if (r.config !== baseline.config && clears) candidates.push({ ...r, qPct, costPct, savings });
    console.log(
      `  ${String(r.config).padEnd(22)} ${(r1(qPct) + '%').padStart(13)} ${(r1(costPct) + '%').padStart(12)} ` +
      `${(r1(savings) + '%').padStart(8)}   ${clears ? 'YES' : 'no'}`
    );
  }

  console.log('\n--- RECOMMENDATION ---');
  if (candidates.length === 0) {
    console.log(`  Nessun config piu economico raggiunge il ${QUALITY_FLOOR}% della qualita migliore.`);
    console.log(`  => Tieni il modello forte ("${baseline.config}"), oppure usa routing misto (forte solo sui task dove i cheap crollano).`);
  } else {
    const best = candidates.sort((a, b) => a.totalCost - b.totalCost)[0];
    console.log(`  "${best.config}" raggiunge ${r1(best.qPct)}% della qualita migliore a ${r1(best.costPct)}% del costo (risparmio ${r1(best.savings)}%).`);
    console.log(`  => Se ${QUALITY_FLOOR}% e' la tua soglia accettabile, "${best.config}" e' viable come modello UNICO.`);
    // Per-domain caveat: flag domains where the cheaper config drops below the floor.
    const caveats = [];
    for (const d of ['finance', 'data_science', 'real_estate']) {
      const bq = best.perDomainQ[d], baseQ = baseline.perDomainQ[d];
      if (bq != null && baseQ != null && baseQ > 0 && (bq / baseQ) * 100 < QUALITY_FLOOR) {
        caveats.push(`${d} (${bq} vs ${baseQ})`);
      }
    }
    if (caveats.length) {
      console.log(`  ATTENZIONE per dominio: "${best.config}" scende sotto soglia su: ${caveats.join(', ')} → valuta routing forte SOLO su questi.`);
    }
  }
  console.log('');
}

main();
