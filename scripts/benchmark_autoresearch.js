#!/usr/bin/env node
'use strict';

/**
 * Autoresearch Benchmark Suite
 *
 * Runs autoresearchPipeline with different configurations to find the
 * optimal trade-off between score, speed, and cell density.
 */

const fs = require('fs');
const path = require('path');
const { autoresearchPipeline } = require('../codefirst/autoresearch');

const BASE_DATA = {
  company_name: "ZUCCHETTI SPA",
  latest_year: 2024,
  revenue: 475729000,
  ebitda: 80591000,
  ebit: 61929000,
  net_income: 43895000,
  total_assets: 414766000,
  equity: 215570000,
  financial_debt: 31800000,
  cash: 64470000,
  employees: 2194,
  revenue_cagr_3y: 0.054,
  ebitda_margin: 0.169,
  net_margin: 0.092,
  roe: 0.204,
  roi: 0.149,
  debt_equity: 0.147,
  yearly: {
    "2020": {"revenue":378045000,"ebitda":52000000,"ebit":35000000,"net_income":22000000},
    "2021": {"revenue":402112000,"ebitda":58000000,"ebit":41000000,"net_income":28000000},
    "2022": {"revenue":430500000,"ebitda":65000000,"ebit":48000000,"net_income":33000000},
    "2023": {"revenue":451200000,"ebitda":72000000,"ebit":55000000,"net_income":38000000},
    "2024": {"revenue":475729000,"ebitda":80591000,"ebit":61929000,"net_income":43895000}
  }
};

const OBJECTIVE_BASE = "Build a full DCF valuation model for ZUCCHETTI SPA using the provided AIDA financials. Include: historical data, revenue build, EBITDA build, WACC, UFCF, DCF valuation, sensitivity table, and sanity checks.";

const OBJECTIVE_DENSE = "Build a comprehensive, institutional-grade DCF valuation model for ZUCCHETTI SPA. Must include: detailed historical financials (2020-2024), revenue build with 5-year projections, EBITDA build with margin analysis, full WACC calculation with CAPM components, unlevered free cash flow build, DCF valuation with discount factors and terminal value, 2-way sensitivity table (WACC vs Terminal Growth), and comprehensive sanity checks. Use maximum detail — at least 800 cells total with proper formatting.";

const CONTEXT = {
  client: "web",
  workbook: { sheets: [{ name: "Sheet1", id: "default" }] },
  allSheets: ["Sheet1"]
};

const CONFIGS = [
  { name: "baseline",       objective: OBJECTIVE_BASE,  threshold: 90, maxIterations: 3 },
  { name: "fast",           objective: OBJECTIVE_BASE,  threshold: 85, maxIterations: 2 },
  { name: "strict",         objective: OBJECTIVE_BASE,  threshold: 95, maxIterations: 3 },
  { name: "single_iter",    objective: OBJECTIVE_BASE,  threshold: 90, maxIterations: 1 },
  { name: "two_iter",       objective: OBJECTIVE_BASE,  threshold: 90, maxIterations: 2 },
  { name: "aggressive",     objective: OBJECTIVE_BASE,  threshold: 90, maxIterations: 4 },
  { name: "loose",          objective: OBJECTIVE_BASE,  threshold: 80, maxIterations: 2 },
  { name: "very_loose",     objective: OBJECTIVE_BASE,  threshold: 75, maxIterations: 2 },
  { name: "dense_model",    objective: OBJECTIVE_DENSE, threshold: 90, maxIterations: 3 },
  { name: "dense_fast",     objective: OBJECTIVE_DENSE, threshold: 85, maxIterations: 2 },
];

async function runConfig(cfg, idx) {
  console.log(`\n[${idx + 1}/${CONFIGS.length}] Running "${cfg.name}"...`);
  const start = Date.now();

  try {
    const result = await autoresearchPipeline(cfg.objective, CONTEXT, {
      data: BASE_DATA,
      maxIterations: cfg.maxIterations,
      scoreThreshold: cfg.threshold,
      _benchmarkConfig: cfg.name,
    });

    const elapsed = Date.now() - start;

    const metrics = {
      config: cfg.name,
      status: result.status,
      score: result.lastScore,
      converged: result.converged,
      iterations: result.iterations,
      cellCount: result.cellCount,
      totalMs: result.totalMs,
      elapsedMs: elapsed,
    };

    console.log(`  Score: ${metrics.score}, Converged: ${metrics.converged}, Iter: ${metrics.iterations}, Cells: ${metrics.cellCount}, Time: ${metrics.totalMs}ms`);
    return metrics;
  } catch (error) {
    console.error(`  FAILED: ${error.message}`);
    return { config: cfg.name, status: 'error', error: error.message, elapsedMs: Date.now() - start };
  }
}

async function main() {
  const results = [];
  for (let i = 0; i < CONFIGS.length; i++) {
    const res = await runConfig(CONFIGS[i], i);
    results.push(res);
    if (i < CONFIGS.length - 1) {
      console.log('  Cooling down 5s...');
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  const outDir = path.join(__dirname, '..', 'bench');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `autoresearch_benchmark_${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ configs: CONFIGS, results, timestamp: new Date().toISOString() }, null, 2));

  console.log(`\n\n========== BENCHMARK SUMMARY ==========`);
  console.log(`Saved to: ${outFile}\n`);

  const sorted = [...results]
    .filter(r => r.status === 'ok')
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.totalMs - b.totalMs;
    });

  console.log(`${'Config'.padEnd(18)} | Score | Conv  | Iter | Cells | Time(ms) | Effic`);
  console.log('-'.repeat(75));
  for (const r of sorted) {
    const efficiency = Math.round((r.score / r.totalMs) * 10000) / 10;
    console.log(`${r.config.padEnd(18)} | ${String(r.score).padStart(3)} | ${String(r.converged).padStart(5)} | ${r.iterations}    | ${String(r.cellCount).padStart(5)} | ${String(r.totalMs).padStart(6)} | ${efficiency}`);
  }

  const best = sorted[0];
  if (best) {
    console.log(`\nBest config: "${best.config}" score=${best.score} time=${best.totalMs}ms cells=${best.cellCount}`);
  }
}

main().catch(e => {
  console.error('Benchmark failed:', e);
  process.exit(1);
});
