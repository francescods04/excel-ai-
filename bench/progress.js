#!/usr/bin/env node
/**
 * Mini live progress dashboard for the model cost/quality sweep.
 *
 * Reads the per-config jsonl files + bench/sweep.log (read-only, safe to run
 * while the sweep is going) and shows: overall progress bar, per-config
 * done/total + running quality/tokens, what's running right now, and an ETA.
 *
 * Usage:
 *   node bench/progress.js            # one snapshot
 *   node bench/progress.js --watch    # refresh every 8s (Ctrl-C to stop)
 */

const fs = require('fs');
const path = require('path');

const BENCH_DIR = __dirname;
const SWEEP_LOG = path.join(BENCH_DIR, 'sweep.log');
const EXPECTED_CONFIGS = ['flash-no-thinking', 'flash-full', 'pro-no-thinking', 'pro-full'];

let SCEN_PER_CONFIG = 9;
try { SCEN_PER_CONFIG = Object.keys(require('./scenarios_complex').SCENARIOS).length; } catch (_) {}

function fmtMin(ms) {
  if (!ms || ms < 0) return '?';
  const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

function bar(done, total, width = 28) {
  const frac = total > 0 ? Math.min(1, done / total) : 0;
  const filled = Math.round(frac * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${done}/${total} (${Math.round(frac * 100)}%)`;
}

function loadConfigRuns() {
  const byConfig = {};
  let files = [];
  try {
    files = fs.readdirSync(BENCH_DIR).filter(f => f.startsWith('model-cost-quality-') && f.endsWith('.jsonl'));
  } catch (_) {}
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(BENCH_DIR, f), 'utf8'); } catch (_) { continue; }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let r; try { r = JSON.parse(t); } catch (_) { continue; }
      const c = r.config || f;
      (byConfig[c] || (byConfig[c] = [])).push(r);
    }
  }
  return byConfig;
}

function currentActivity() {
  let tail = [];
  try {
    tail = fs.readFileSync(SWEEP_LOG, 'utf8').split('\n').slice(-1500);
  } catch (_) { return {}; }
  let config = null, iter = null, model = null, lastScenario = null;
  for (const line of tail) {
    const mCfg = line.match(/CONFIG:\s*([\w-]+)/);
    if (mCfg) config = mCfg[1];
    const mIter = line.match(/Iteration\s+(\d+)\/(\d+)/);
    if (mIter) iter = mIter[1];
    const mModel = line.match(/DeepSeek\s*[←→]\s*(deepseek-[\w-]+)/);
    if (mModel) model = mModel[1];
    const mScen = line.match(/^\s{2}([a-z_]+)\s+\.\.\./);
    if (mScen) lastScenario = mScen[1];
  }
  return { config, iter, model, lastScenario };
}

function render() {
  const byConfig = loadConfigRuns();
  const act = currentActivity();
  const totalTarget = EXPECTED_CONFIGS.length * SCEN_PER_CONFIG;

  // Sequential sweep → the running config is the first one not yet complete.
  let currentConfig = null;
  for (const cfg of EXPECTED_CONFIGS) {
    if ((byConfig[cfg] || []).length < SCEN_PER_CONFIG) { currentConfig = cfg; break; }
  }

  let totalDone = 0;
  const allRuns = [];
  const rows = [];
  for (const cfg of EXPECTED_CONFIGS) {
    const runs = byConfig[cfg] || [];
    totalDone += runs.length;
    allRuns.push(...runs);
    const scored = runs.filter(r => r.quality && r.quality.score != null);
    const meanQ = scored.length ? Math.round(scored.reduce((a, r) => a + r.quality.score, 0) / scored.length) : null;
    const tok = runs.reduce((a, r) => a + (r.usage ? (r.usage.promptTokens + r.usage.completionTokens) : 0), 0);
    const state = runs.length >= SCEN_PER_CONFIG ? 'done' : (cfg === currentConfig ? 'RUNNING' : 'pending');
    rows.push({ cfg, done: runs.length, meanQ, tok, state });
  }
  // any config label seen in files but not expected (e.g. a manual run)
  for (const cfg of Object.keys(byConfig)) {
    if (!EXPECTED_CONFIGS.includes(cfg)) {
      const runs = byConfig[cfg];
      rows.push({ cfg: cfg + ' (extra)', done: runs.length, meanQ: null, tok: 0, state: 'extra' });
    }
  }

  const times = allRuns.map(r => r.totalMs).filter(Number.isFinite);
  const meanMs = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
  const remaining = Math.max(0, totalTarget - totalDone);
  const eta = meanMs ? meanMs * remaining : 0;

  const lines = [];
  lines.push('');
  lines.push(`  MODEL COST/QUALITY SWEEP — progress @ ${new Date().toLocaleTimeString()}`);
  lines.push(`  ${bar(totalDone, totalTarget)}   ETA ~${fmtMin(eta)}  (mean ${fmtMin(meanMs)}/scenario)`);
  lines.push('');
  lines.push('  config               state     done    meanQ   tokens');
  for (const r of rows) {
    lines.push(`  ${r.cfg.padEnd(20)} ${r.state.padEnd(8)} ${String(r.done + '/' + SCEN_PER_CONFIG).padEnd(7)} ${String(r.meanQ ?? '-').padStart(5)}   ${String(r.tok).padStart(9)}`);
  }
  lines.push('');
  if (totalDone >= totalTarget) {
    lines.push('  ✓ sweep complete — run: node bench/model_cost_quality_report.js');
  } else if (currentConfig) {
    lines.push(`  NOW: ${currentConfig} › ${act.lastScenario || 'scenario in corso'}  (iter ${act.iter || '?'}, ${act.model || '?'})`);
  } else {
    lines.push('  (in attesa del primo scenario…)');
  }
  lines.push('');
  return lines.join('\n');
}

const watch = process.argv.includes('--watch');
if (watch) {
  const tick = () => { process.stdout.write('\x1Bc'); process.stdout.write(render()); };
  tick();
  setInterval(tick, 8000);
} else {
  process.stdout.write(render());
}
