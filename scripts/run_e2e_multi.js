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
const https     = require('https');
const http      = require('http');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch (_) {}

function arg(name, def) {
  const m = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return m ? m.split('=').slice(1).join('=') : def;
}

const SERVER     = arg('server', 'https://excel-six-plum.vercel.app');
const SCENARIOS  = arg('scenarios', 'dcf,vairano,fastfood_bp,data_cleaning')
  .split(',').map(s => s.trim()).filter(Boolean);
const TIMEOUT    = arg('timeout', '');
const OUT_DIR    = arg('outdir', '/tmp');
const RETRIES    = Math.max(0, Number(arg('retries', '0')) || 0);
const FINAL_WAIT = arg('final-wait', '');

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

function runOne(scenario, attempt = 0) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const suffix = attempt > 0 ? `_try${attempt + 1}` : '';
    const logPath = path.join(OUT_DIR, `e2e_multi_${scenario}_${ts}${suffix}.log`);
    const tracePath = path.join(OUT_DIR, `e2e_multi_${scenario}_${ts}${suffix}.trace.json`);
    const args = [tracerPath, `--scenario=${scenario}`, `--server=${SERVER}`, `--out=${tracePath}`];
    if (TIMEOUT) args.push(`--timeout=${TIMEOUT}`);
    if (FINAL_WAIT) args.push(`--final-wait=${FINAL_WAIT}`);
    const logFh = fs.openSync(logPath, 'w');
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', logFh, logFh],
      env: { ...process.env }
    });
    console.log(`▶ [${scenario}${suffix}] pid=${child.pid} log=${logPath} trace=${tracePath}`);
    child.on('close', code => {
      fs.closeSync(logFh);
      const elapsedS = Math.round((Date.now() - startedAt) / 1000);
      let trace = null;
      try { trace = JSON.parse(fs.readFileSync(tracePath, 'utf-8')); } catch (_) {}
      resolve({ scenario, attempt, code, elapsedS, logPath, tracePath, trace });
    });
    child.on('error', err => {
      try { fs.closeSync(logFh); } catch (_) {}
      resolve({ scenario, attempt, code: -1, elapsedS: 0, logPath, tracePath, trace: null, spawnError: err.message });
    });
  });
}

function isBadResult(r) {
  const t = r.trace || {};
  const status = t.finalTurn?.status;
  if (r.spawnError || r.code !== 0) return true;
  if (status !== 'completed') return true;
  if (Array.isArray(t.quality?.failures) && t.quality.failures.length > 0) return true;
  if (Array.isArray(t.errors) && t.errors.length > 0) return true;
  return false;
}

function resultScore(r) {
  const t = r.trace || {};
  const q = Number(t.quality?.score || 0);
  const statusBonus = t.finalTurn?.status === 'completed' ? 1000 : 0;
  const qualityPenalty = Array.isArray(t.quality?.failures) ? t.quality.failures.length * 100 : 0;
  return statusBonus + q - qualityPenalty - Math.min(300, r.elapsedS || 0) / 30;
}

async function runWithRetries(scenario) {
  const attempts = [];
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const result = await runOne(scenario, attempt);
    attempts.push(result);
    if (!isBadResult(result)) break;
    if (attempt < RETRIES) {
      const failures = result.trace?.quality?.failures || [];
      const reason = failures[0] || result.spawnError || result.trace?.finalTurn?.status || `exit ${result.code}`;
      console.log(`↻ [${scenario}] retry ${attempt + 2}/${RETRIES + 1}: ${reason}`);
    }
  }
  const best = attempts.slice().sort((a, b) => resultScore(b) - resultScore(a))[0] || attempts[0];
  best.attempts = attempts;
  return best;
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
  const quality = t.quality || {};
  const failures = Array.isArray(quality.failures) ? quality.failures.length : 0;
  const warnings = Array.isArray(quality.warnings) ? quality.warnings.length : 0;
  const parseErrs = narrative.filter(n => n.parseError).length;
  const parseRec = narrative.filter(n => n.parseErrorRecovered).length;
  const sheetCount = (t.sheetSummary || []).length;
  const formulaTotal = (t.sheetSummary || []).reduce((s, x) => s + (x.formulaCells || 0), 0);
  const cellTotal = (t.sheetSummary || []).reduce((s, x) => s + (x.formulaCells || 0) + (x.valueCells || 0), 0);
  return {
    scenario: r.scenario,
    status,
    elapsed_s: r.elapsedS,
    attempts: Array.isArray(r.attempts) ? r.attempts.length : 1,
    llm_calls: llmCalls,
    steps,
    errors,
    quality: quality.ok === false || failures > 0 ? `FAIL:${quality.score ?? '-'}` : `PASS:${quality.score ?? '-'}`,
    q_fail: failures,
    q_warn: warnings,
    parse_errs: `${parseErrs - parseRec}/${parseErrs}`,
    sheets: sheetCount,
    formulas: formulaTotal,
    total_cells: cellTotal,
    cells_per_s: r.elapsedS > 0 ? Math.round(cellTotal / r.elapsedS) : 0,
    log: r.logPath,
    trace: r.tracePath,
    quality_failures: quality.failures || [],
    quality_warnings: quality.warnings || []
  };
}

function httpReq(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + (u.search || ''), method, headers: { ...headers } };
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    if (data && !opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
    const req = lib.request(opts, res => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => { const out = { status: res.statusCode, body: buf }; try { out.json = JSON.parse(buf); } catch {} resolve(out); });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('socket_timeout')));
    if (data) req.write(data);
    req.end();
  });
}

async function mintSharedToken() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const email = process.env.E2E_USER_EMAIL || 'francescojordan04@gmail.com';
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Missing SUPABASE env vars');
  const linkResp = await httpReq('POST', `${SUPABASE_URL}/auth/v1/admin/generate_link`,
    { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }, { type: 'magiclink', email });
  if (linkResp.status >= 400) throw new Error(`generate_link [${linkResp.status}]: ${linkResp.body.slice(0, 300)}`);
  const root = linkResp.json || {};
  const email_otp = root.email_otp || root.properties?.email_otp;
  if (!email_otp) throw new Error('no email_otp in generate_link response');
  const r = await httpReq('POST', `${SUPABASE_URL}/auth/v1/verify`, { apikey: SERVICE_KEY }, { type: 'magiclink', email, token: email_otp });
  if (!r.json?.access_token) throw new Error('verify did not return access_token');
  return r.json.access_token;
}

(async () => {
  console.log(`\n═══ MULTI-SCENARIO E2E (${SCENARIOS.length} parallel) ═══`);
  console.log(`Server:    ${SERVER}`);
  console.log(`Scenarios: ${SCENARIOS.join(', ')}`);
  console.log(`Retries:   ${RETRIES}`);
  console.log(`Out dir:   ${OUT_DIR}\n`);

  let sharedToken = null;
  try {
    sharedToken = await mintSharedToken();
    console.log('✓ Minted shared E2E token (passed to children via E2E_PREMINTED_TOKEN)\n');
  } catch (e) {
    console.warn(`! Token mint failed (${e.message}); children will attempt their own with retry.\n`);
  }
  if (sharedToken) process.env.E2E_PREMINTED_TOKEN = sharedToken;

  const results = await Promise.all(SCENARIOS.map(runWithRetries));

  console.log('\n═══ RESULTS ═══\n');
  const rows = results.map(fmtRow);
  const cols = ['scenario','status','quality','attempts','elapsed_s','llm_calls','steps','errors','q_fail','q_warn','parse_errs','sheets','formulas','total_cells','cells_per_s'];
  const widths = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  const sep = '  ';
  console.log(cols.map((c, i) => c.padEnd(widths[i])).join(sep));
  console.log(widths.map(w => '-'.repeat(w)).join(sep));
  for (const r of rows) {
    console.log(cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join(sep));
  }
  console.log('\nArtifacts:');
  for (const r of rows) console.log(`  ${r.scenario}: trace=${r.trace}  log=${r.log}`);

  console.log('\nQuality notes:');
  for (const r of rows) {
    const notes = [...(r.quality_failures || []), ...(r.quality_warnings || [])].slice(0, 6);
    console.log(`  ${r.scenario}: ${notes.length ? notes.join(' | ') : 'no quality issues'}`);
  }

  const anyError = rows.some(r => r.status !== 'completed' || r.q_fail > 0 || r.errors > 0 || r.quality.startsWith('FAIL'));
  process.exit(anyError ? 2 : 0);
})().catch(e => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
