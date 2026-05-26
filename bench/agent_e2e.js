#!/usr/bin/env node
// Agent loop bench: misura latenza end-to-end del nuovo runtime (/api/agent/start)
// Usage: node bench/agent_e2e.js [runs=3] [scenario=dcf|simple|repair]
// Output: bench/agent-results-YYYYMMDD-HHMM.jsonl + summary su stdout.

const http = require('http');
const fs = require('fs');
const path = require('path');

const SERVER = process.env.BENCH_SERVER || 'http://localhost:3000';
const RUNS = Number(process.argv[2]) || 3;
const SCENARIO = process.argv[3] || 'simple';
const TURN_TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS) || 240000;

const SCENARIOS = {
  dcf: {
    message: 'Crea un modello DCF completo per AAPL con assumptions, WACC, proiezioni revenue, FCF, terminal value, enterprise value',
    context: { activeSheet: 'Sheet1', sheets: [{ name: 'Sheet1', usedRange: { rowCount: 0, columnCount: 0 } }] }
  },
  simple: {
    message: 'Crea un mini schema con header A1:C1 = Nome, Età, Città e 3 righe esempio',
    context: { activeSheet: 'Sheet1', sheets: [{ name: 'Sheet1', usedRange: { rowCount: 0, columnCount: 0 } }] }
  },
  repair: {
    message: 'Ho dei dati in A1:C10 con valori numerici. Crea una colonna D che somma A+B+C per ogni riga',
    context: { activeSheet: 'Sheet1', sheets: [{ name: 'Sheet1', usedRange: { rowCount: 10, columnCount: 3 } }] }
  }
};

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
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

function streamUntilDone(agentId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${SERVER}/api/agent/stream/${agentId}`);
    const stats = {
      iterations: 0, toolsCalled: [], firstTokenMs: null, started: Date.now(),
      pendingClientRequests: 0, autoAnsweredClientRequests: 0
    };
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET',
      headers: { Accept: 'text/event-stream' }
    }, (res) => {
      let buf = '';
      let currentEvent = null;
      const timer = setTimeout(() => { req.destroy(); reject(new Error(`SSE timeout ${timeoutMs}ms — last event=${currentEvent} iter=${stats.iterations}`)); }, timeoutMs);

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
              if (currentEvent === 'iterationStart') stats.iterations = data.iteration;
              if (currentEvent === 'thought') {
                if (data.tool) stats.toolsCalled.push(data.tool);
                if (!stats.firstTokenMs) stats.firstTokenMs = Date.now() - stats.started;
              }
              if (currentEvent === 'toolRequest' || currentEvent === 'toolRequestBatch') {
                stats.pendingClientRequests++;
                // auto-respond to client tool requests with empty stub so the bench can complete
                const items = data.batch || [data];
                for (const item of items) {
                  const requestId = item.requestId || item.id || item.toolId;
                  if (!requestId) continue;
                  const respUrl = `${SERVER}/api/agent/${agentId}/client-response`;
                  postJson(respUrl, {
                    requestId,
                    response: { data: { ok: true, _bench_stub: true, values: [], formulas: [], cellCount: 0 } }
                  }).catch(() => {});
                }
                stats.autoAnsweredClientRequests++;
              }
              if (currentEvent === 'agentCompleted' || currentEvent === 'agentError' || currentEvent === 'agentPaused') {
                clearTimeout(timer); req.destroy();
                resolve({ event: currentEvent, data, stats });
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
  const startResp = await postJson(`${SERVER}/api/agent/start`, {
    message: scenario.message, context: scenario.context
  });
  if (startResp.status !== 200) throw new Error(`agent/start ${startResp.status}: ${JSON.stringify(startResp.body)}`);
  const agentId = startResp.body.agentId;

  const final = await streamUntilDone(agentId, TURN_TIMEOUT_MS);
  const totalMs = Date.now() - startedAt;
  return {
    agentId, scenario: scenarioName, totalMs,
    status: final.event, finalData: final.data,
    iterations: final.stats.iterations,
    firstTokenMs: final.stats.firstTokenMs,
    toolsCalled: final.stats.toolsCalled,
    pendingClientRequests: final.stats.pendingClientRequests
  };
}

function pct(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

(async () => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const outFile = path.join(__dirname, `agent-results-${ts}.jsonl`);
  const fout = fs.createWriteStream(outFile);
  console.log(`Agent bench ${SCENARIO} × ${RUNS} su ${SERVER} (timeout ${TURN_TIMEOUT_MS}ms)`);
  console.log(`Output: ${outFile}\n`);

  const results = [];
  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(`[${i+1}/${RUNS}] `);
    try {
      const r = await runOne(SCENARIO);
      results.push(r);
      fout.write(JSON.stringify({ ...r, ts: new Date().toISOString() }) + '\n');
      console.log(`${r.totalMs}ms  iter=${r.iterations}  ttft=${r.firstTokenMs || '-'}ms  tools=[${r.toolsCalled.slice(0,8).join(',')}]  status=${r.status}`);
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      fout.write(JSON.stringify({ run: i, error: e.message, ts: new Date().toISOString() }) + '\n');
    }
  }
  fout.end();

  const ok = results.filter(r => r.status === 'agentCompleted');
  if (ok.length === 0) { console.log('\nNessun run completato.'); process.exit(1); }
  const lat = ok.map(r => r.totalMs);
  const iters = ok.map(r => r.iterations);
  console.log(`\n=== Summary (${ok.length}/${RUNS} ok) ===`);
  console.log(`latency p50:   ${pct(lat, 0.5)}ms`);
  console.log(`latency p95:   ${pct(lat, 0.95)}ms`);
  console.log(`latency mean:  ${Math.round(lat.reduce((a,b)=>a+b,0)/lat.length)}ms`);
  console.log(`iter mean:     ${(iters.reduce((a,b)=>a+b,0)/iters.length).toFixed(1)}`);
  console.log(`iter max:      ${Math.max(...iters)}`);
})().catch(e => { console.error(e); process.exit(1); });
