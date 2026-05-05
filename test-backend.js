#!/usr/bin/env node
// Test backend locale: verifica health + planner fast-path (no LLM / no costo)
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

async function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(cond, msg) {
    if (cond) { console.log('  ✅ ' + msg); passed++; }
    else { console.log('  ❌ ' + msg); failed++; }
  }

  console.log('\n🧪 Test Backend Excel AI Agent (no LLM)\n');

  // 1. Health
  console.log('1) Health check');
  const health = await getJson('/api/health');
  assert(health.status === 200, 'Status 200');
  assert(health.body.ok === true, 'body.ok === true');
  assert(health.body.app === 'excel-ai-agent', 'app name corretto');

  // 2. Turn start fast-path DCF
  console.log('\n2) Planner fast-path DCF');
  const start = await postJson('/api/turn/start', {
    message: 'Crea un modello DCF per TEST',
    context: { activeSheet: 'Sheet1', workbookSheets: ['Sheet1'] }
  });
  assert(start.status === 200, 'Turn start status 200');
  assert(start.body.turnId && start.body.status === 'planning', 'Turn creato in stato planning');
  const turnId = start.body.turnId;

  // 3. Turn state after planning
  console.log('\n3) Stato turn dopo planning');
  const turn = await getJson(`/api/turn/${turnId}`);
  assert(turn.status === 200, 'GET turn status 200');
  assert(turn.body.status === 'awaiting_approval', 'Stato awaiting_approval');
  assert(turn.body.plan && Array.isArray(turn.body.plan.tasks), 'Piano con tasks presente');
  assert(turn.body.plan.tasks.length >= 10, `Almeno 10 task (trovati ${turn.body.plan.tasks.length})`);
  assert(turn.body.plan.tasks.some(t => t.tool === 'llm.writeFormulas'), 'Contiene task formula');

  // 4. Turn start fast-path WACC
  console.log('\n4) Planner fast-path WACC');
  const wacc = await postJson('/api/turn/start', {
    message: 'Calcola il WACC',
    context: { activeSheet: 'Sheet1', workbookSheets: ['Sheet1'] }
  });
  assert(wacc.status === 200, 'Turn start WACC status 200');
  const waccTurn = await getJson(`/api/turn/${wacc.body.turnId}`);
  assert(waccTurn.body.status === 'awaiting_approval', 'WACC awaiting_approval');
  assert(waccTurn.body.plan.tasks.some(t => t.params && t.params.model === 'WACC'), 'Piano WACC riconosciuto');

  // 5. Turn start non-finance -> deve andare su LLM (verifichiamo solo che non crashi)
  console.log('\n5) Turn start non-finance (richiede LLM — verifica solo avvio)');
  const simple = await postJson('/api/turn/start', {
    message: 'Colora di rosso le celle negative in A1:D20',
    context: { activeSheet: 'Sheet1', workbookSheets: ['Sheet1'] }
  });
  assert(simple.status === 200, 'Turn start simple status 200');
  assert(simple.body.turnId, 'TurnId generato');

  console.log('\n────────────────────────────────────────');
  console.log(`Risultati: ${passed} passati, ${failed} falliti`);
  console.log('────────────────────────────────────────\n');
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => { console.error('Errore test:', e); process.exit(1); });
