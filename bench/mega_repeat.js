'use strict';

// Repeated mega-scenario bench: run test_mega_lbo.js N times, collect per-run
// metrics from analysis.json, print aggregate. Single runs are noise — score
// has varied 38-81 across identical code. Judge configurations on N>=3.
//
// Usage: MEGA_RUNS=3 node bench/mega_repeat.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const N = Number(process.env.MEGA_RUNS) || 3;
const ROOT = path.join(__dirname, '..');
const ANALYSIS = path.join(ROOT, 'codefirst', 'test_mega_output', 'analysis.json');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
const OUT = path.join(__dirname, `mega-repeat-${ts}.jsonl`);

function runOnce(i) {
  const start = Date.now();
  console.log(`[mega_repeat] Run ${i + 1}/${N} starting...`);
  const res = spawnSync('node', ['codefirst/test_mega_lbo.js'], {
    cwd: ROOT,
    env: { ...process.env, CF_PLANNER_TIMEOUT_MS: process.env.CF_PLANNER_TIMEOUT_MS || '360000' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: Number(process.env.MEGA_RUN_TIMEOUT_MS) || 3000000,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  });
  const wallMs = Date.now() - start;
  let rec = { run: i + 1, wallMs, exit: res.status, error: res.error ? res.error.message : null };
  try {
    const a = JSON.parse(fs.readFileSync(ANALYSIS, 'utf8'));
    const lintBy = {};
    for (const iss of (a.financeLint?.issues || [])) {
      lintBy[iss.kind] = (lintBy[iss.kind] || 0) + 1;
    }
    rec = {
      ...rec,
      score: a.score,
      verdict: a.verdict,
      sheets: a.overview?.totalSheets,
      cells: a.overview?.totalCells,
      formulas: a.overview?.totalFormulas,
      formulaRatio: a.overview?.formulaRatio,
      promptTokens: a.overview?.totalTokens?.promptTokens,
      completionTokens: a.overview?.totalTokens?.completionTokens,
      llmCalls: a.overview?.totalTokens?.calls,
      depCritical: (a.cells?.depIssues || []).filter(x => x.severity === 'critical').length,
      formulaCritical: (a.formulas?.issues || []).filter(x => x.severity === 'critical').length,
      lintCritical: (a.financeLint?.issues || []).filter(x => x.severity === 'critical').length,
      lintHigh: (a.financeLint?.issues || []).filter(x => x.severity === 'high').length,
      invariantViolations: a.invariants?.count,
      lintByKind: lintBy,
    };
  } catch (e) {
    rec.parseError = e.message;
  }
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
  console.log(`[mega_repeat] Run ${i + 1}: score=${rec.score} verdict=${rec.verdict} wall=${Math.round(wallMs / 1000)}s depCrit=${rec.depCritical} lintCrit=${rec.lintCritical}`);
  return rec;
}

function agg(records, key) {
  const vals = records.map(r => r[key]).filter(v => typeof v === 'number');
  if (vals.length === 0) return null;
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  return { mean: Math.round(mean * 100) / 100, min: Math.min(...vals), max: Math.max(...vals) };
}

(function main() {
  console.log(`[mega_repeat] ${N} runs → ${OUT}`);
  const records = [];
  for (let i = 0; i < N; i++) records.push(runOnce(i));
  console.log('\n[mega_repeat] ===== AGGREGATE =====');
  for (const k of ['score', 'wallMs', 'cells', 'formulas', 'promptTokens', 'llmCalls', 'depCritical', 'formulaCritical', 'lintCritical', 'lintHigh', 'invariantViolations']) {
    const a = agg(records, k);
    if (a) console.log(`${k}: mean=${a.mean} min=${a.min} max=${a.max}`);
  }
  const allKinds = {};
  for (const r of records) {
    for (const [k, v] of Object.entries(r.lintByKind || {})) allKinds[k] = (allKinds[k] || 0) + v;
  }
  console.log('lint kinds (total across runs):', JSON.stringify(allKinds));
})();
