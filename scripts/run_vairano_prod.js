#!/usr/bin/env node
/**
 * Vairano prompt → deploy Vercel reale (stepwise driver).
 * - Mint token via Supabase admin (SERVICE_ROLE_KEY)
 * - Start turn → auto-approve → drive stepwise via /api/turn/step loop
 * - Respond to client tool requests via in-memory mock workbook
 * - Also subscribe to SSE for log capture (best-effort; dies at 300s on Vercel)
 * - On completion, pull LLM traces via admin endpoint and save report
 *
 * Run:  node scripts/run_vairano_prod.js
 */

require('dotenv').config();
const https = require('https');
const http = require('http');
const fs = require('fs');
const readline = require('readline');

const arg = (n, d) => { const f = process.argv.slice(2).find(a => a.startsWith(`--${n}=`)); return f ? f.slice(n.length + 3) : d; };
const EMAIL = arg('email', 'francescojordan04@gmail.com');
const SERVER = (arg('server', 'https://excel-six-plum.vercel.app')).replace(/\/$/, '');
const TIMEOUT_MS = (Number(arg('timeout', '1200')) || 1200) * 1000;
const TIER = arg('tier', null); // 'flash' | 'pro' | null (default)
const TAG = arg('tag', TIER || 'default');
const OUT = arg('out', `/tmp/vairano_prod_${TAG}_${Date.now()}.json`);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) { console.error('Missing SUPABASE env'); process.exit(1); }

const OBJECTIVE = 'fai un excel super completo per fare la valutazione della realizzazione di un progetto immobiliare da 0, l immobile sarà un 10 piani a vairano scalo in provincia di caserta di circa 1000mq2 per piano  fai un analisi super cpmplessa di costi e ricavi, finanziamenti, dividi i costi in vari sottocosto. l excel deve essere completo con ogni foglio circa 1000 righe';

// ─── HTTP ────────────────────────────────────────────────────────────────
function request(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + (u.search || ''), method, headers: { ...headers } };
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    if (data && !opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
    const req = lib.request(opts, res => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => { const out = { status: res.statusCode, headers: res.headers, body: buf }; try { out.json = JSON.parse(buf); } catch {} resolve(out); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

// ─── Token mint ──────────────────────────────────────────────────────────
async function mintAccessToken(email) {
  const linkResp = await request('POST', `${SUPABASE_URL}/auth/v1/admin/generate_link`,
    { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }, { type: 'magiclink', email });
  if (linkResp.status >= 400) throw new Error(`generate_link [${linkResp.status}]: ${linkResp.body.slice(0, 300)}`);
  const root = linkResp.json || {};
  const email_otp = root.email_otp || root.properties?.email_otp;
  const hashed_token = root.hashed_token || root.properties?.hashed_token;
  const action_link = root.action_link || root.properties?.action_link;
  if (email_otp) {
    const r = await request('POST', `${SUPABASE_URL}/auth/v1/verify`, { apikey: SERVICE_KEY }, { type: 'magiclink', email, token: email_otp });
    if (r.json?.access_token) return r.json.access_token;
  }
  if (action_link || hashed_token) {
    const url = action_link || `${SUPABASE_URL}/auth/v1/verify?token=${hashed_token}&type=magiclink&redirect_to=http://localhost`;
    const r = await new Promise((res, rej) => {
      const u = new URL(url); const lib = u.protocol === 'https:' ? https : http;
      lib.get({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: { apikey: SERVICE_KEY } }, resp => res({ status: resp.statusCode, location: resp.headers.location })).on('error', rej);
    });
    if (r.location) { const m = r.location.match(/access_token=([^&]+)/); if (m) return decodeURIComponent(m[1]); }
    throw new Error(`verify GET ${r.status} loc=${(r.location || '').slice(0, 200)}`);
  }
  throw new Error('no token fields');
}

// ─── Workbook mock ────────────────────────────────────────────────────────
const workbook = { sheets: new Map([['Sheet1', new Map()]]) };
function colToIndex(c){let n=0;for(const ch of String(c||'').toUpperCase())n=n*26+(ch.charCodeAt(0)-64);return n;}
function indexToCol(n){let s='';while(n>0){const r=(n-1)%26;s=String.fromCharCode(65+r)+s;n=Math.floor((n-1)/26);}return s;}
function parseAddr(a){const m=String(a).replace(/\$/g,'').match(/^([A-Z]+)(\d+)$/i);return m?{col:colToIndex(m[1]),row:Number(m[2])}:null;}
function parseRange(t){const raw=String(t||'').replace(/\$/g,'');if(raw.includes('!'))return parseRange(raw.split('!').slice(1).join('!'));const[a,b]=raw.split(':');const L=parseAddr(a);if(!L)return null;const R=b?parseAddr(b):L;if(!R)return null;return{c1:Math.min(L.col,R.col),c2:Math.max(L.col,R.col),r1:Math.min(L.row,R.row),r2:Math.max(L.row,R.row)};}
function ensureSheet(n){if(!workbook.sheets.has(n))workbook.sheets.set(n,new Map());return workbook.sheets.get(n);}
function translateFormula(f,dR,dC){if(typeof f!=='string')return f;return f.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g,(m,ab,col,ar,row)=>{const nc=ab==='$'?col:indexToCol(colToIndex(col)+dC);const nr=ar==='$'?row:String(Number(row)+dR);return `${ab}${nc}${ar}${nr}`;});}
function applySetCellRange(a){const s=ensureSheet(a.sheet||a.sheetName||'Sheet1');const cells=a.cells||{};const seeds=Object.entries(cells);for(const[ad,sp]of seeds){if(!parseAddr(ad))continue;s.set(ad,{value:sp.value,formula:sp.formula});}if(a.copyToRange&&seeds.length){const d=parseRange(a.copyToRange);if(d)for(const[sa,sp]of seeds){if(!sp.formula)continue;const sd=parseAddr(sa);if(!sd)continue;let w=0;for(let r=d.r1;r<=d.r2;r++)for(let c=d.c1;c<=d.c2;c++){if(r===sd.row&&c===sd.col)continue;if(++w>50000)return;s.set(`${indexToCol(c)}${r}`,{formula:translateFormula(sp.formula,r-sd.row,c-sd.col)});}}}}
function applyCopyRange(a){const fr=parseRange(a.from);const src=workbook.sheets.get(a.from_sheet);const dst=ensureSheet(a.to_sheet);const to=parseAddr(a.to);if(!fr||!src||!to)return;for(let r=fr.r1;r<=fr.r2;r++)for(let c=fr.c1;c<=fr.c2;c++){const cell=src.get(`${indexToCol(c)}${r}`);if(!cell)continue;const da=`${indexToCol(to.col+(c-fr.c1))}${to.row+(r-fr.r1)}`;dst.set(da,{value:cell.value,formula:cell.formula?translateFormula(cell.formula,to.row-fr.r1,to.col-fr.c1):undefined});}}
function applyAction(a){if(!a||typeof a!=='object')return;const t=a.type;if(t==='createSheet'){const n=a.name||a.sheet;if(n)ensureSheet(n);}else if(t==='deleteSheet'){if(a.name)workbook.sheets.delete(a.name);}else if(t==='renameSheet'){if(a.from&&a.to&&workbook.sheets.has(a.from)){workbook.sheets.set(a.to,workbook.sheets.get(a.from));workbook.sheets.delete(a.from);}}else if(t==='setCellRange')applySetCellRange(a);else if(t==='copyRange')applyCopyRange(a);}
function sheetBounds(s){let mr=0,mc=0;for(const a of s.keys()){const p=parseAddr(a);if(!p)continue;if(p.row>mr)mr=p.row;if(p.col>mc)mc=p.col;}return{maxRow:mr,maxCol:mc};}
function sheetTo2D(s,r1,r2,c1,c2){const v=[],f=[];for(let r=r1;r<=r2;r++){const vr=[],fr=[];for(let c=c1;c<=c2;c++){const cell=s.get(`${indexToCol(c)}${r}`);vr.push(cell?(cell.value!==undefined?cell.value:(cell.formula??null)):null);fr.push(cell?.formula||null);}v.push(vr);f.push(fr);}return{values:v,formulas:f};}
function mockClient(toolName, params) {
  if (toolName === 'workbook.readWorkbook') { const sheets = [...workbook.sheets.entries()].map(([n, s]) => { const b = sheetBounds(s); return { name: n, usedRange: { rowCount: b.maxRow, columnCount: b.maxCol } }; }); return { data: { sheets } }; }
  if (toolName === 'workbook.readSheet') { const n = params.sheet || params.sheetName || 'Sheet1'; const s = workbook.sheets.get(n); if (!s) return { data: { name: n, values: [], formulas: [] } }; const b = sheetBounds(s); const { values, formulas } = sheetTo2D(s, 1, Math.max(1, Math.min(b.maxRow || 1, 2000)), 1, Math.max(1, Math.min(b.maxCol || 1, 60))); return { data: { name: n, values, formulas } }; }
  if (toolName === 'workbook.readRange') { const n = params.sheet || params.sheetName || 'Sheet1'; const r = parseRange(params.target); const s = workbook.sheets.get(n); if (!s || !r) return { data: { sheet: n, target: params.target, values: [[]], formulas: [[]] } }; const { values, formulas } = sheetTo2D(s, r.r1, Math.min(r.r2, r.r1 + 1500), r.c1, Math.min(r.c2, r.c1 + 60)); return { data: { sheet: n, target: params.target, values, formulas } }; }
  if (toolName === 'workbook.readFormatSummary') return { data: { summary: 'mock', sheet: params.sheet } };
  if (toolName === 'workbook.listNamedRanges') return { data: { namedRanges: [] } };
  if (toolName === 'runJavaScript') {
    // Best-effort: parse common Office.js patterns and apply to the in-memory workbook.
    // Worker often writes `worksheet.getRange("X").values = [[...]]` blocks.
    return runJsToMock(params.code || '');
  }
  return { data: {} };
}

function runJsToMock(code) {
  const logs = [];
  try {
    // Sheet creation: worksheets.add("Name")
    for (const m of code.matchAll(/worksheets\.add\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
      ensureSheet(m[1]); logs.push(`addSheet ${m[1]}`);
    }
    // worksheet retrieval: const NAME = ... worksheets.getItem("X")
    const sheetRefs = new Map(); // var → sheetName
    for (const m of code.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*[^;]*?worksheets\.getItem(?:OrNullObject)?\(\s*["'`]([^"'`]+)["'`]/g)) {
      sheetRefs.set(m[1], m[2]);
    }
    // .getRange("X").values = [[...]] / .formulas = [[...]] / .numberFormat = ...
    const setterRe = /(\w+)\.getRange\(\s*["'`]([^"'`]+)["'`]\s*\)\.(values|formulas|numberFormat)\s*=\s*(\[[\s\S]*?\]);?\s*(?=\n|$|context\.sync)/g;
    let mt; let applied = 0;
    while ((mt = setterRe.exec(code)) !== null) {
      const sheetName = sheetRefs.get(mt[1]) || 'Sheet1';
      const addr = mt[2];
      const kind = mt[3];
      let arr;
      try { arr = eval(mt[4]); } catch { logs.push(`parse fail ${addr}`); continue; }
      if (!Array.isArray(arr)) continue;
      const r = parseRange(addr);
      if (!r) continue;
      const sheet = ensureSheet(sheetName);
      for (let i = 0; i < arr.length; i++) {
        const row = Array.isArray(arr[i]) ? arr[i] : [arr[i]];
        for (let j = 0; j < row.length; j++) {
          const a = `${indexToCol(r.c1 + j)}${r.r1 + i}`;
          const v = row[j];
          if (kind === 'values') sheet.set(a, { value: v });
          else if (kind === 'formulas') {
            if (typeof v === 'string' && v.startsWith('=')) sheet.set(a, { formula: v });
            else if (v !== '' && v != null) sheet.set(a, { value: v });
          }
          applied++;
        }
      }
      logs.push(`${sheetName}!${addr} ${kind} ${arr.length}rows`);
    }
    return { data: { ok: true, value: null, logs: logs.slice(0, 20).concat([`cellsApplied=${applied}`]) } };
  } catch (e) {
    return { data: { ok: false, error: e.message, logs } };
  }
}

// ─── Capture ──────────────────────────────────────────────────────────────
const stats = {
  events: [], logs: [], errors: [], taskActions: [], toolRequests: [],
  triageDecision: null, blueprint: null, completed: false, error: null,
  steps: [], startedAt: Date.now(),
};

function logLine(ts, lvl, m) {
  stats.logs.push({ ts, level: lvl, message: m });
  if (lvl === 'error' || lvl === 'warn') stats.errors.push({ ts, level: lvl, message: m });
  process.stdout.write(`[${ts}] ${lvl.padEnd(5)} ${m}\n`);
}

function handleSseEvent(eventType, data, token, turnId) {
  const ts = new Date().toISOString().slice(11, 19);
  stats.events.push({ ts, event: eventType });
  if (eventType === 'log') {
    logLine(ts, data.level || 'info', String(data.message || ''));
  } else if (eventType === 'triageDecision') {
    stats.triageDecision = data;
  } else if (eventType === 'taskActions') {
    stats.taskActions.push({ ts, taskId: data.taskId, actionCount: (data.actions || []).length });
    for (const a of (data.actions || [])) applyAction(a);
    // ack
    request('POST', `${SERVER}/api/turn/action-result`, { Authorization: `Bearer ${token}` },
      { turnId, taskId: data.taskId, itemId: data.itemId, actionCount: (data.actions || []).length, errorCount: 0, status: 'completed' })
      .catch(e => console.error('action-result err:', e.message));
  } else if (eventType === 'turnCompleted') {
    stats.completed = true;
    if (data?.error) stats.error = data.error;
  }
}

function sseStreamBest(turnId, token, onClose) {
  const u = new URL(`${SERVER}/api/turn/stream/${turnId}`);
  const lib = u.protocol === 'https:' ? https : http;
  const req = lib.request({ hostname: u.hostname, port: 443, path: u.pathname, method: 'GET',
    headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` } }, res => {
    if (res.statusCode !== 200) { res.resume(); onClose(`SSE ${res.statusCode}`); return; }
    let currentEvent = null;
    const rl = readline.createInterface({ input: res, crlfDelay: Infinity });
    rl.on('line', line => {
      if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
      else if (line.startsWith('data:')) { try { handleSseEvent(currentEvent, JSON.parse(line.slice(5).trim()), token, turnId); } catch {} }
      else if (line === '') currentEvent = null;
    });
    rl.on('close', () => onClose('rl close'));
    rl.on('error', e => onClose(`rl err: ${e.message}`));
  });
  req.on('error', e => onClose(`req err: ${e.message}`));
  req.end();
  return req;
}

// ─── Stepwise loop ───────────────────────────────────────────────────────

async function stepLoop(turnId, token) {
  let stepSeq = 0;
  let nextClientResult = null;
  let consecutiveErrors = 0;
  const deadline = Date.now() + TIMEOUT_MS - 30000;

  while (Date.now() < deadline) {
    let resp;
    try {
      resp = await request('POST', `${SERVER}/api/turn/step`, { Authorization: `Bearer ${token}` },
        { turnId, clientResult: nextClientResult, stepSeq });
    } catch (e) {
      if (++consecutiveErrors > 5) { logLine(now(), 'error', `step network err x5: ${e.message}`); return; }
      await sleep(2000); continue;
    }

    if (resp.status !== 200) {
      logLine(now(), 'warn', `step status ${resp.status}: ${resp.body.slice(0, 200)}`);
      if (++consecutiveErrors > 5) return;
      await sleep(1500); continue;
    }
    consecutiveErrors = 0;
    nextClientResult = null;

    const { control, payload, stepSeq: newSeq } = resp.json || {};
    stats.steps.push({ ts: now(), control, stepSeq: newSeq, payloadKeys: Object.keys(payload || {}), actionCount: (payload?.actions || []).length });
    if (Number.isFinite(newSeq)) stepSeq = newSeq;

    // Apply any actions returned in this step's payload (stepwise sends them here, not SSE).
    if (Array.isArray(payload?.actions) && payload.actions.length > 0) {
      stats.taskActions.push({ ts: now(), taskId: 'step', actionCount: payload.actions.length });
      for (const a of payload.actions) applyAction(a);
      logLine(now(), 'info', `step → ${payload.actions.length} actions applied (cumulative sheets: ${[...workbook.sheets.keys()].join(', ')})`);
      // ack so error gates see completion
      try {
        await request('POST', `${SERVER}/api/turn/action-result`, { Authorization: `Bearer ${token}` },
          { turnId, taskId: payload.taskId || 'orchestrator', itemId: payload.itemId || 'step',
            actionCount: payload.actions.length, errorCount: 0, status: 'completed' });
      } catch {}
    }

    if (control === 'done') { logLine(now(), 'info', `step → done`); return; }
    if (control === 'aborted') { logLine(now(), 'error', `step → aborted: ${payload?.reason || ''}`); stats.error = payload?.reason || 'aborted'; return; }
    if (control === 'paused') { logLine(now(), 'warn', `step → paused: ${JSON.stringify(payload?.question).slice(0, 200)}`); nextClientResult = { results: [{ requestId: payload?.requestId || 'q', response: { data: { answer: 'skip' } } }] }; continue; }
    if (control === 'await_client') {
      const requests = Array.isArray(payload?.requests) ? payload.requests : [];
      const results = [];
      for (const req of requests) {
        stats.toolRequests.push({ ts: now(), type: req.type, name: req.toolName || req.title });
        let response = { data: {} };
        if (req.type === 'clientTool') response = mockClient(req.toolName, req.params || {});
        else if (req.type === 'permission') response = { approved: true };
        else if (req.type === 'userInput') { const fields = req.fields || []; const v = {}; fields.forEach(f => v[f.key] = '0'); response = { data: v }; }
        results.push({ requestId: req.id, response });
      }
      nextClientResult = { results };
      continue;
    }
    // control === 'continue' → loop
  }
  logLine(now(), 'warn', 'stepLoop timeout');
}

function now() { return new Date().toISOString().slice(11, 19); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Server: ${SERVER}\nEmail:  ${EMAIL}\nOut:    ${OUT}\n`);

  console.log('1) Minting access token (admin) ...');
  const token = await mintAccessToken(EMAIL);
  console.log(`   ok (${token.length} chars, hidden)\n`);

  console.log('2) POST /api/turn/start ...');
  const startBody = { message: OBJECTIVE, context: { activeSheet: 'Sheet1', workbookSheets: ['Sheet1'] } };
  if (TIER) startBody.forceWorkerTier = TIER;
  const startResp = await request('POST', `${SERVER}/api/turn/start`,
    { Authorization: `Bearer ${token}` }, startBody);
  if (startResp.status !== 200) { console.error(`start [${startResp.status}]: ${startResp.body.slice(0, 400)}`); process.exit(1); }
  const turnId = startResp.json.turnId;
  console.log(`   turnId: ${turnId}\n`);

  // Best-effort SSE (will die at 300s on Vercel)
  let sseClosed = false;
  sseStreamBest(turnId, token, reason => { if (!sseClosed) { sseClosed = true; logLine(now(), 'info', `SSE closed: ${reason}`); } });

  // Wait for planUpdated/awaiting_approval, capture blueprint, approve
  let approved = false;
  for (let i = 0; i < 90; i++) {
    await sleep(1500);
    const r = await request('GET', `${SERVER}/api/turn/${turnId}`, { Authorization: `Bearer ${token}` });
    const t = r.json;
    if (!t) continue;
    if (!stats.blueprint && t.plan?.meta?.blueprint) {
      const bp = t.plan.meta.blueprint;
      stats.blueprint = {
        objective_restated: bp.objective_restated, global_layout_notes: bp.global_layout_notes, waves: bp.waves,
        slices: bp.slices.map(s => ({ id: s.id, title: s.title, deps: s.deps, tier: s.tier,
          sheets_owned: s.scope?.sheets_owned, ranges_owned: s.scope?.ranges_owned, may_read_from: s.scope?.may_read_from,
          actionCount: (s.actions || []).length,
          actionToolMix: (s.actions || []).reduce((m, a) => { m[a.tool] = (m[a.tool] || 0) + 1; return m; }, {}) })),
      };
    }
    if (!approved && t.status === 'awaiting_approval') {
      console.log(`\n>>> Approving (${t.plan?.tasks?.length || 0} tasks)\n`);
      await request('POST', `${SERVER}/api/turn/approve`, { Authorization: `Bearer ${token}` }, { turnId });
      approved = true; break;
    }
    if (t.status === 'running' || t.status === 'completed' || t.status === 'error') break;
  }

  // 3) Drive stepwise
  console.log('3) Step loop start ...');
  await stepLoop(turnId, token);

  // 4) Final turn fetch
  let finalTurn = {};
  try { finalTurn = (await request('GET', `${SERVER}/api/turn/${turnId}`, { Authorization: `Bearer ${token}` })).json || {}; } catch {}

  // 5) Pull LLM trace via per-turn endpoint (owner access, no admin needed)
  let traceRecords = [];
  try {
    const tr = await request('GET', `${SERVER}/api/turn/${encodeURIComponent(turnId)}/llm-traces?limit=5000&order=asc`, { Authorization: `Bearer ${token}` });
    if (tr.json) traceRecords = Array.isArray(tr.json) ? tr.json : (tr.json.records || tr.json.traces || []);
    console.log(`\nLLM traces: ${traceRecords.length} (status ${tr.status})`);
    if (tr.status !== 200) console.log(`  → ${tr.body.slice(0, 200)}`);
  } catch (e) { console.error('trace fetch err:', e.message); }

  // 6) Stats
  const labelCounts = {}, labelTokens = {}, labelLatency = {};
  for (const r of traceRecords) {
    const et = r.eventType || r.event_type;
    if (et !== 'llm.response') continue;
    const lbl = r.label || 'unknown';
    labelCounts[lbl] = (labelCounts[lbl] || 0) + 1;
    labelTokens[lbl] = labelTokens[lbl] || { in: 0, out: 0 };
    labelTokens[lbl].in += (r.usage?.prompt_tokens || r.prompt_tokens || 0);
    labelTokens[lbl].out += (r.usage?.completion_tokens || r.completion_tokens || 0);
    labelLatency[lbl] = (labelLatency[lbl] || 0) + (r.latencyMs || r.latency_ms || 0);
  }
  const sheetSummary = [...workbook.sheets.entries()].map(([n, s]) => { const b = sheetBounds(s); let vc = 0, fc = 0; for (const v of s.values()) { if (v?.formula) fc++; if (v?.value !== undefined) vc++; } return { name: n, maxRow: b.maxRow, maxCol: b.maxCol, valueCells: vc, formulaCells: fc }; });
  const sampleQA = [];
  const seen = new Set();
  for (const r of traceRecords) {
    if ((r.eventType || r.event_type) !== 'llm.response') continue;
    const key = `${r.label}|${r.attempt || 'primary'}|${r.phase || ''}`;
    if (seen.has(key)) continue; seen.add(key);
    const req = traceRecords.find(x => (x.eventType || x.event_type) === 'llm.request' && x.traceId === r.traceId && x.label === r.label && (x.attempt || 'primary') === (r.attempt || 'primary'));
    sampleQA.push({
      label: r.label, attempt: r.attempt || 'primary', phase: r.phase || null,
      q: lastUserMsg(req), a: shortenA(r.responseText || r.response_text || r.response),
      tokens: { in: r.usage?.prompt_tokens || r.prompt_tokens || 0, out: r.usage?.completion_tokens || r.completion_tokens || 0 },
      latencyMs: r.latencyMs || r.latency_ms || 0,
    });
    if (sampleQA.length >= 50) break;
  }

  const out = {
    server: SERVER, turnId, elapsedSec: Math.round((Date.now() - stats.startedAt) / 1000),
    completed: stats.completed, error: stats.error || finalTurn.error || null, finalStatus: finalTurn.status || null,
    triageDecision: stats.triageDecision, blueprint: stats.blueprint, sheetSummary,
    taskActions: stats.taskActions,
    toolRequestCounts: stats.toolRequests.reduce((m, r) => { const k = `${r.type}:${r.name}`; m[k] = (m[k] || 0) + 1; return m; }, {}),
    eventTypeCounts: stats.events.reduce((m, e) => { m[e.event] = (m[e.event] || 0) + 1; return m; }, {}),
    stepHistory: stats.steps.slice(-200),
    llmTrace: { totalRecords: traceRecords.length, labelCounts, labelTokens, labelLatency },
    sampleQA,
    errorLogs: stats.errors.slice(0, 100),
    logsTail: stats.logs.slice(-300),
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nSaved: ${OUT}`);
  console.log(`elapsedSec=${out.elapsedSec} status=${out.finalStatus} error=${out.error || 'none'}`);
  console.log(`Sheets: ${sheetSummary.map(s => `${s.name}(r=${s.maxRow},c=${s.maxCol},f=${s.formulaCells},v=${s.valueCells})`).join(' | ')}`);
  console.log(`Errors: ${stats.errors.length}`);
  console.log(`LLM labels:`);
  for (const [k, v] of Object.entries(labelCounts).sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    const tk = labelTokens[k] || { in: 0, out: 0 };
    console.log(`  ${String(v).padStart(4)} ${k.padEnd(45)} tok ${tk.in}→${tk.out}  ms=${Math.round(labelLatency[k] || 0)}`);
  }
  process.exit(stats.error ? 2 : 0);
}

function lastUserMsg(req) { if (!req || !Array.isArray(req.messages)) return ''; const u = req.messages.filter(m => m.role === 'user'); return u.length ? (u[u.length - 1].content || '').replace(/\s+/g, ' ').slice(0, 1400) : ''; }
function shortenA(t) { if (typeof t !== 'string') return ''; return t.replace(/\s+/g, ' ').slice(0, 2400); }

setTimeout(() => { console.error('\nGlobal timeout. Forcing exit.'); process.exit(124); }, TIMEOUT_MS + 60000).unref();
main().catch(e => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
