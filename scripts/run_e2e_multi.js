#!/usr/bin/env node
// Multi-scenario parallel E2E runner. Launches N scenarios concurrently against
// the same server, waits for all to finish, prints a comparison table.
//
//   node scripts/run_e2e_multi.js --scenarios=dcf,vairano,fastfood_bp,data_cleaning \
//     --server=https://excel-six-plum.vercel.app
//
// Each child invokes scripts/run_e2e_trace.js with its own --scenario flag.
// Stdout from each child is tee'd to /tmp/e2e_multi_<scenario>_<ts>.log.
// On completion, prints a row per scenario: status, steps, llmCalls, errors,
// sheets, elapsed. Exits 0 if all completed without an `error` finalTurn status.

const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');

function arg(name, def) {
  const m = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return m ? m.split('=').slice(1).join('=') : def;
}

const SERVER     = arg('server', 'https://excel-six-plum.vercel.app');
const SCENARIOS  = arg('scenarios', 'dcf,vairano,fastfood_bp,data_cleaning')
  .split(',').map(s => s.trim()).filter(Boolean);
const TIMEOUT    = arg('timeout', '');
const OUT_DIR    = arg('outdir', '/tmp');

if (!SCENARIOS.length) {
  console.error('No scenarios provided (--scenarios=a,b,c)');
  process.exit(1);
}

const tracerPath = path.join(__dirname, 'run_e2e_trace.js');
if (!fs.existsSync(tracerPath)) {
  console.error('Tracer missing at ' + tracerPath);
  process.exit(1);
}

const ts = Date.now();

function runOne(scenario) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const logPath = path.join(OUT_DIR, `e2e_multi_${scenario}_${ts}.log`);
    const tracePath = path.join(OUT_DIR, `e2e_multi_${scenario}_${ts}.trace.json`);
    const args = [tracerPath, `--scenario=${scenario}`, `--server=${SERVER}`, `--out=${tracePath}`];
    if (TIMEOUT) args.push(`--timeout=${TIMEOUT}`);
    const logFh = fs.openSync(logPath, 'w');
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', logFh, logFh],
      env: { ...process.env }
    });
    console.log(`▶ [${scenario}] pid=${child.pid} log=${logPath} trace=${tracePath}`);
    child.on('close', code => {
      fs.closeSync(logFh);
      const elapsedS = Math.round((Date.now() - startedAt) / 1000);
      let trace = null;
      try { trace = JSON.parse(fs.readFileSync(tracePath, 'utf-8')); } catch (_) {}
      resolve({ scenario, code, elapsedS, logPath, tracePath, trace });
    });
    child.on('error', err => {
      try { fs.closeSync(logFh); } catch (_) {}
      resolve({ scenario, code: -1, elapsedS: 0, logPath, tracePath, trace: null, spawnError: err.message });
    });
  });
}

function fmtSheets(trace) {
  if (!trace?.sheetSummary?.length) return '-';
  return trace.sheetSummary
    .filter(s => s.maxRow > 0 || s.formulaCells > 0 || s.valueCells > 0)
    .map(s => `${s.name}(${s.maxRow}×${s.maxCol},f=${s.formulaCells},v=${s.valueCells})`)
    .join(' | ');
}

function fmtRow(r) {
  const t = r.trace || {};
  const ft = t.finalTurn || {};
  const status = ft.status || (r.spawnError ? 'spawn-error' : (r.code === 0 ? 'unknown' : `exit${r.code}`));
  const narrative = Array.isArray(t.narrative) ? t.narrative : [];
  const llmCalls = narrative.length;
  const steps = Array.isArray(t.steps) ? t.steps.length : 0;
  const errors = Array.isArray(t.errors) ? t.errors.length : 0;
  const parseErrs = narrative.filter(n => n.parseError).length;
  const parseRec = narrative.filter(n => n.parseErrorRecovered).length;
  const sheetCount = (t.sheetSummary || []).length;
  const formulaTotal = (t.sheetSummary || []).reduce((s, x) => s + (x.formulaCells || 0), 0);
  const cellTotal = (t.sheetSummary || []).reduce((s, x) => s + (x.formulaCells || 0) + (x.valueCells || 0), 0);
  return {
    scenario: r.scenario,
    status,
    elapsed_s: r.elapsedS,
    llm_calls: llmCalls,
    steps,
    errors,
    parse_errs: `${parseErrs - parseRec}/${parseErrs}`,
    sheets: sheetCount,
    formulas: formulaTotal,
    total_cells: cellTotal,
    log: r.logPath,
    trace: r.tracePath
  };
}

(async () => {
  console.log(`\n═══ MULTI-SCENARIO E2E (${SCENARIOS.length} parallel) ═══`);
  console.log(`Server:    ${SERVER}`);
  console.log(`Scenarios: ${SCENARIOS.join(', ')}`);
  console.log(`Out dir:   ${OUT_DIR}\n`);

  const results = await Promise.all(SCENARIOS.map(runOne));

  console.log('\n═══ RESULTS ═══\n');
  const rows = results.map(fmtRow);
  const cols = ['scenario','status','elapsed_s','llm_calls','steps','errors','parse_errs','sheets','formulas','total_cells'];
  const widths = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  const sep = '  ';
  console.log(cols.map((c, i) => c.padEnd(widths[i])).join(sep));
  console.log(widths.map(w => '-'.repeat(w)).join(sep));
  for (const r of rows) {
    console.log(cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join(sep));
  }
  console.log('\nArtifacts:');
  for (const r of rows) console.log(`  ${r.scenario}: trace=${r.trace}  log=${r.log}`);

  const anyError = rows.some(r => r.status === 'error' || r.status.startsWith('exit') || r.status === 'spawn-error');
  process.exit(anyError ? 2 : 0);
})().catch(e => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
