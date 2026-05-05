#!/usr/bin/env node
// Test E2E con mock client: simula Excel per eseguire un turn DCF completo
// con il modello kimi-k2.6 su OpenRouter.
// Timeout molto ampio perché kimi-k2.6 è lento.

const http = require('http');
const readline = require('readline');

const SERVER = process.env.TEST_SERVER || 'http://localhost:3000';
const GLOBAL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minuti

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

function sseStream(turnId, handlers) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${SERVER}/api/turn/stream/${turnId}`);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET',
      headers: { Accept: 'text/event-stream' }
    }, (res) => {
      let buf = '';
      let currentEvent = null;
      const rl = readline.createInterface({ input: res, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const dataStr = line.slice(5).trim();
          try {
            const data = JSON.parse(dataStr);
            if (handlers.onEvent) handlers.onEvent(currentEvent, data);
            if (currentEvent === 'turnCompleted') {
              rl.close();
              resolve(data);
            }
          } catch (e) {
            // ignore
          }
        } else if (line === '') {
          currentEvent = null;
        }
      });
      rl.on('close', () => resolve(null));
      rl.on('error', (e) => reject(e));
    });
    req.on('error', reject);
    req.end();
  });
}

function mockResponseForTool(toolName, params) {
  if (toolName === 'workbook.readWorkbook') {
    return { data: { sheets: [{ name: 'Sheet1', usedRange: { rowCount: 0, columnCount: 0 } }] } };
  }
  if (toolName === 'workbook.readSheet') {
    return { data: { name: params.sheet || 'Sheet1', values: [], formulas: [] } };
  }
  if (toolName === 'workbook.readRange') {
    return { data: { sheet: params.sheet || 'Sheet1', target: params.target, values: [[1, 2, 3]], formulas: [[null, null, null]] } };
  }
  return { data: {} };
}

async function runTest() {
  console.log('🚀 Avvio test E2E mock client con moonshotai/kimi-k2.6');
  console.log(`   Server: ${SERVER}`);
  console.log(`   Timeout globale: ${GLOBAL_TIMEOUT_MS / 1000}s\n`);

  const startTotal = Date.now();

  // 1. Start turn
  console.log('1) Creazione turn DCF...');
  const startResp = await postJson('/api/turn/start', {
    message: 'Crea un modello DCF per AAPL',
    context: { activeSheet: 'Sheet1', workbookSheets: ['Sheet1'] }
  });
  if (startResp.status !== 200) {
    console.error('❌ turn/start fallito:', startResp.body);
    process.exit(1);
  }
  const turnId = startResp.body.turnId;
  console.log(`   Turn creato: ${turnId}`);

  // 2. Attendi piano
  console.log('2) Attesa piano (fast-path DCF)...');
  let turn;
  for (let i = 0; i < 60; i++) {
    turn = (await getJson(`/api/turn/${turnId}`)).body;
    if (turn.status === 'awaiting_approval' || turn.status === 'completed' || turn.status === 'error') break;
    await new Promise(r => setTimeout(r, 1000));
  }
  if (turn.status !== 'awaiting_approval') {
    console.error('❌ Piano non generato. Stato:', turn.status, 'Errore:', turn.error);
    process.exit(1);
  }
  console.log(`   ✅ Piano pronto: ${turn.plan.tasks.length} task`);
  turn.plan.tasks.forEach(t => console.log(`      ${t.id}: ${t.agent}/${t.tool} — ${t.description}`));

  // 3. Approva
  console.log('\n3) Approvazione turn...');
  await postJson('/api/turn/approve', { turnId });
  console.log('   ✅ Turn approvato, avvio esecuzione...\n');

  // 4. SSE + mock client
  const pendingRequests = [];
  let completed = false;
  let error = null;

  const ssePromise = sseStream(turnId, {
    onEvent: (event, data) => {
      const ts = new Date().toISOString().slice(11, 19);
      if (event === 'log') {
        console.log(`   [${ts}] 📝 ${data.message}`);
      } else if (event === 'itemStarted') {
        console.log(`   [${ts}] ▶️  ${data.item?.taskId || data.item?.id} started`);
      } else if (event === 'itemCompleted') {
        console.log(`   [${ts}] ✅ ${data.item?.taskId || data.item?.id} completed`);
      } else if (event === 'taskActions') {
        console.log(`   [${ts}] 📊 taskActions: ${data.actions?.length || 0} azioni Excel emesse`);
      } else if (event === 'toolRequest' || event === 'toolRequestBatch') {
        const reqs = data.requests || [data.request];
        for (const req of reqs) {
          if (!req) continue;
          console.log(`   [${ts}] 📡 Richiesta client: ${req.type} / ${req.toolName || req.title || ''} (id: ${req.id})`);
          if (req.type === 'clientTool') {
            pendingRequests.push({
              requestId: req.id,
              response: mockResponseForTool(req.toolName, req.params)
            });
          } else if (req.type === 'permission') {
            pendingRequests.push({
              requestId: req.id,
              response: { approved: true }
            });
          } else if (req.type === 'userInput') {
            // Crea risposta mock con tutti i campi vuoti
            const fields = req.fields || [];
            const values = {};
            fields.forEach(f => values[f.key] = '0.1');
            pendingRequests.push({
              requestId: req.id,
              response: { data: values }
            });
          }
        }
      } else if (event === 'turnCompleted') {
        completed = true;
        if (data.error) error = data.error;
      }
    }
  });

  // 5. Polling per rispondere alle richieste client
  const respondLoop = setInterval(async () => {
    if (pendingRequests.length === 0) return;
    const batch = pendingRequests.splice(0);
    try {
      await postJson('/api/turn/respond-batch', { turnId, responses: batch });
      console.log(`   💬 Risposte inviate: ${batch.map(r => r.requestId).join(', ')}`);
    } catch (e) {
      console.error('   ❌ Errore respond-batch:', e.message);
    }
  }, 500);

  // 6. Timeout globale
  const timeoutTimer = setTimeout(() => {
    console.error('\n⏰ Timeout globale scaduto');
    clearInterval(respondLoop);
    process.exit(1);
  }, GLOBAL_TIMEOUT_MS);

  // 7. Attendi completamento SSE
  await ssePromise;
  clearInterval(respondLoop);
  clearTimeout(timeoutTimer);

  const elapsed = Date.now() - startTotal;
  console.log(`\n────────────────────────────────────────`);
  if (error) {
    console.log(`❌ Turn completato con ERRORE: ${error}`);
  } else {
    console.log(`✅ Turn completato con successo in ${Math.round(elapsed / 1000)}s`);
  }
  console.log(`────────────────────────────────────────\n`);

  // 8. Stato finale
  const final = (await getJson(`/api/turn/${turnId}`)).body;
  console.log('Stato finale:', final.status);
  console.log('Error:', final.error || 'nessuno');
  console.log('Narration:', final.narration?.message || 'nessuna');
  console.log('Log ultimi 10:');
  (final.log || []).slice(-10).forEach(l => console.log(`  ${l.time.slice(11,19)} [${l.level}] ${l.message}`));

  process.exit(error ? 1 : 0);
}

runTest().catch(e => {
  console.error('Errore test:', e);
  process.exit(1);
});
