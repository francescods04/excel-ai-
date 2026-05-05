#!/usr/bin/env node
// Test rapido per verificare che lo streaming con timeout + fallback non-streaming funzioni
const http = require('http');

const SERVER = process.env.TEST_SERVER || 'http://localhost:3000';

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, SERVER);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
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

function getJson(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, SERVER);
    http.get(u, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, body: buf }); }
      });
    }).on('error', reject);
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

(async () => {
  console.log('🧪 Test planner con LLM (simple) — max attesa ~30s\n');
  const startedAt = Date.now();
  const start = await postJson('/api/turn/start', {
    message: 'Colora di rosso le celle negative in A1:D20',
    context: { activeSheet: 'Sheet1', workbookSheets: ['Sheet1'] }
  });
  if (start.status !== 200) {
    console.error('❌ turn/start fallito:', start.body);
    process.exit(1);
  }
  const turnId = start.body.turnId;
  console.log('Turn creato:', turnId);

  try {
    const event = await streamUntil(turnId, (ev) => ev === 'turnAwaitingApproval' || ev === 'turnCompleted' || ev === 'planUpdated', 120000);
    const elapsed = Date.now() - startedAt;
    console.log(`Evento ricevuto: ${event.event} in ${elapsed}ms`);

    const turn = await getJson(`/api/turn/${turnId}`);
    console.log('Stato turn:', turn.body.status);
    console.log('Task count:', turn.body.plan?.tasks?.length || 0);
    console.log('Planner source:', turn.body.plan?.source || 'LLM');
    if (turn.body.error) console.log('Errore:', turn.body.error);
  } catch (e) {
    console.error('❌ Timeout o errore SSE:', e.message);
    const turn = await getJson(`/api/turn/${turnId}`);
    console.log('Stato turn al timeout:', turn.body.status);
    process.exit(1);
  }
})();
