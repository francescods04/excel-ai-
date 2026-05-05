#!/usr/bin/env node
// Bench script: misura latenza planner per N run.
// Usage: node bench/dcf_e2e.js [runs=5] [scenario=dcf|simple|repair]
// Output: bench/results-YYYYMMDD-HHMM.jsonl + summary p50/p95 su stdout.

const http = require('http');
const fs = require('fs');
const path = require('path');

const SERVER = process.env.BENCH_SERVER || 'http://localhost:3000';
const RUNS = Number(process.argv[2]) || 5;
const SCENARIO = process.argv[3] || 'dcf';

const SCENARIOS = {
  dcf: {
    message: 'Crea un modello DCF completo per AAPL con assumptions, WACC, proiezioni revenue, FCF, terminal value, enterprise value',
    context: { activeSheet: 'Sheet1', sheets: [{ name: 'Sheet1', usedRange: { rowCount: 0, columnCount: 0 } }] }
  },
  simple: {
    message: 'Colora di rosso le celle negative in A1:D20',
    context: { activeSheet: 'Sheet1', sheets: [{ name: 'Sheet1', usedRange: { rowCount: 20, columnCount: 4 } }] }
  },
  repair: {
    message: 'Risolvi gli errori #REF e #NAME nel foglio attivo',
    context: { activeSheet: 'Sheet1', sheets: [{ name: 'Sheet1', usedRange: { rowCount: 50, columnCount: 10 } }] }
  }
};

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function streamUntil(turnId, predicate, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${SERVER}/api/turn/stream/${turnId}`);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET',
      headers: { Accept: 'text/event-stream' }
    }, (res) => {
      let buf = '';
      let currentEvent = null;
      const timer = setTimeout(() => { req.destroy(); reject(new Error(`SSE timeout ${timeoutMs}ms`)); }, timeoutMs);

      res.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
          else if (line.startsWith('data:')) {
            const dataStr = line.slice(5).trim();
            try {
              const data = JSON.parse(dataStr);
              if (predicate(currentEvent, data)) {
                clearTimeout(timer);
                req.destroy();
                resolve({ event: currentEvent, data });
              }
            } catch (e) { /* ignore parse */ }
          } else if (line === '') currentEvent = null;
        }
      });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', reject);
    req.end();
  });
}

async function runOne(scenarioName) {
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) throw new Error(`Scenario sconosciuto: ${scenarioName}`);

  const startedAt = Date.now();
  const startResp = await postJson(`${SERVER}/api/turn/start`, {
    message: scenario.message,
    context: scenario.context
  });
  if (startResp.status !== 200) throw new Error(`turn/start ${startResp.status}: ${JSON.stringify(startResp.body)}`);
  const turnId = startResp.body.turnId;

  const planEvent = await streamUntil(turnId, (ev) => ev === 'turnAwaitingApproval' || ev === 'turnCompleted');
  const planMs = Date.now() - startedAt;

  const turnResp = await new Promise((resolve, reject) => {
    const u = new URL(`${SERVER}/api/turn/${turnId}`);
    http.get(u, (res) => {
      let buf = ''; res.on('data', c => buf += c); res.on('end', () => resolve(JSON.parse(buf)));
    }).on('error', reject);
  });

  return {
    turnId,
    scenario: scenarioName,
    planMs,
    status: planEvent.event,
    taskCount: turnResp.plan?.tasks?.length || 0,
    plannerSource: turnResp.plan?.source || null,
    error: turnResp.error || null
  };
}

function pct(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

(async () => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const outFile = path.join(__dirname, `results-${ts}.jsonl`);
  const fout = fs.createWriteStream(outFile);
  console.log(`Bench ${SCENARIO} × ${RUNS} su ${SERVER}`);
  console.log(`Output: ${outFile}`);

  const results = [];
  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(`[${i+1}/${RUNS}] `);
    try {
      const r = await runOne(SCENARIO);
      results.push(r);
      fout.write(JSON.stringify({ ...r, ts: new Date().toISOString() }) + '\n');
      console.log(`${r.planMs}ms  tasks=${r.taskCount}  src=${r.plannerSource}  status=${r.status}`);
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      fout.write(JSON.stringify({ run: i, error: e.message, ts: new Date().toISOString() }) + '\n');
    }
  }
  fout.end();

  const ok = results.filter(r => r.status === 'turnAwaitingApproval');
  if (ok.length === 0) { console.log('\nNessun run riuscito.'); process.exit(1); }
  const lat = ok.map(r => r.planMs);
  console.log(`\n=== Summary (${ok.length}/${RUNS} ok) ===`);
  console.log(`p50:  ${pct(lat, 0.5)}ms`);
  console.log(`p95:  ${pct(lat, 0.95)}ms`);
  console.log(`min:  ${Math.min(...lat)}ms`);
  console.log(`max:  ${Math.max(...lat)}ms`);
  console.log(`mean: ${Math.round(lat.reduce((a,b)=>a+b,0)/lat.length)}ms`);
})().catch(e => { console.error(e); process.exit(1); });
