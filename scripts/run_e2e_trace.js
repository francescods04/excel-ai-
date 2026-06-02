#!/usr/bin/env node
/**
 * Simple E2E driver: small scenario → prod Vercel → capture every iteration.
 * Output: detailed iter-by-iter analysis (thought / tool / params summary /
 * result summary) plus final workbook state and timing.
 *
 * Run: node scripts/run_e2e_trace.js [--scenario=dcf|simple|sumcol]
 */

require('dotenv').config();
const https = require('https');
const http = require('http');
const fs = require('fs');

const arg = (n, d) => { const f = process.argv.slice(2).find(a => a.startsWith(`--${n}=`)); return f ? f.slice(n.length + 3) : d; };
const SERVER = (arg('server', 'https://excel-six-plum.vercel.app')).replace(/\/$/, '');
const EMAIL = arg('email', 'francescojordan04@gmail.com');
const SCENARIO = arg('scenario', 'sumcol');
const TIMEOUT_MS = (Number(arg('timeout', '300')) || 300) * 1000;
const OUT = arg('out', `/tmp/e2e_trace_${SCENARIO}_${Date.now()}.json`);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) { console.error('Missing SUPABASE env'); process.exit(1); }

const SCENARIOS = {
  sumcol: 'Crea un foglio con header A1:C1 = Nome, Età, Città. Aggiungi 5 righe di esempio (Mario 30 Roma, Lucia 28 Milano, Paolo 45 Napoli, Anna 22 Torino, Marco 35 Bologna). In D1 metti header "Età+10", in D2:D6 una formula che somma B2 + 10.',
  dcf: 'Crea un mini DCF: foglio Assumptions con Revenue iniziale 1000, growth 10%, margine 20%, sconto 8%, anni 5. Foglio Projections con Revenue Y1-Y5 in B2:F2 (=B2*(1+growth)), EBITDA = Revenue*margine, FCF=EBITDA. Foglio Valuation con NPV dei FCF.',
  simple: 'Scrivi "Hello World" in A1, "Buongiorno" in A2, e in A3 una formula =CONCATENATE(A1," ",A2).'
};
const OBJECTIVE = SCENARIOS[SCENARIO] || SCENARIOS.sumcol;

// ── HTTP ─────────────────────────────────────────────────────────────────
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

async function mintAccessToken(email) {
  const linkResp = await request('POST', `${SUPABASE_URL}/auth/v1/admin/generate_link`,
    { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }, { type: 'magiclink', email });
  if (linkResp.status >= 400) throw new Error(`generate_link [${linkResp.status}]: ${linkResp.body.slice(0, 300)}`);
  const root = linkResp.json || {};
  const email_otp = root.email_otp || root.properties?.email_otp;
  if (email_otp) {
    const r = await request('POST', `${SUPABASE_URL}/auth/v1/verify`, { apikey: SERVICE_KEY }, { type: 'magiclink', email, token: email_otp });
    if (r.json?.access_token) return r.json.access_token;
  }
  throw new Error('no email_otp in generate_link response');
}

// ── Mock workbook (minimal) ──────────────────────────────────────────────
const workbook = { sheets: new Map([['Sheet1', new Map()]]) };
function colToIndex(c){let n=0;for(const ch of String(c||'').toUpperCase())n=n*26+(ch.charCodeAt(0)-64);return n;}
function indexToCol(n){let s='';while(n>0){const r=(n-1)%26;s=String.fromCharCode(65+r)+s;n=Math.floor((n-1)/26);}return s;}
function parseAddr(a){const m=String(a).replace(/\$/g,'').match(/^([A-Z]+)(\d+)$/i);return m?{col:colToIndex(m[1]),row:Number(m[2])}:null;}
function parseRange(t){const raw=String(t||'').replace(/\$/g,'');if(raw.includes('!'))return parseRange(raw.split('!').slice(1).join('!'));const[a,b]=raw.split(':');const L=parseAddr(a);if(!L)return null;const R=b?parseAddr(b):L;if(!R)return null;return{c1:Math.min(L.col,R.col),c2:Math.max(L.col,R.col),r1:Math.min(L.row,R.row),r2:Math.max(L.row,R.row)};}
function ensureSheet(n){if(!workbook.sheets.has(n))workbook.sheets.set(n,new Map());return workbook.sheets.get(n);}
function translateFormula(f,dR,dC){if(typeof f!=='string')return f;return f.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g,(m,ab,col,ar,row)=>{const nc=ab==='$'?col:indexToCol(colToIndex(col)+dC);const nr=ar==='$'?row:String(Number(row)+dR);return `${ab}${nc}${ar}${nr}`;});}
function applySetCellRange(a){const s=ensureSheet(a.sheet||a.sheetName||'Sheet1');const cells=a.cells||{};for(const[ad,sp]of Object.entries(cells)){if(!parseAddr(ad))continue;s.set(ad,{value:sp.value,formula:sp.formula});}if(a.copyToRange){const d=parseRange(a.copyToRange);if(d)for(const[sa,sp]of Object.entries(cells)){if(!sp.formula)continue;const sd=parseAddr(sa);if(!sd)continue;for(let r=d.r1;r<=d.r2;r++)for(let c=d.c1;c<=d.c2;c++){if(r===sd.row&&c===sd.col)continue;s.set(`${indexToCol(c)}${r}`,{formula:translateFormula(sp.formula,r-sd.row,c-sd.col)});}}}}
function applyAction(a){if(!a||typeof a!=='object')return;const t=a.type;if(t==='createSheet'){const n=a.name||a.sheet;if(n)ensureSheet(n);}else if(t==='deleteSheet'){if(a.name)workbook.sheets.delete(a.name);}else if(t==='setCellRange')applySetCellRange(a);}
function sheetBounds(s){let mr=0,mc=0;for(const a of s.keys()){const p=parseAddr(a);if(!p)continue;if(p.row>mr)mr=p.row;if(p.col>mc)mc=p.col;}return{maxRow:mr,maxCol:mc};}
function sheetTo2D(s,r1,r2,c1,c2){const v=[],f=[];for(let r=r1;r<=r2;r++){const vr=[],fr=[];for(let c=c1;c<=c2;c++){const cell=s.get(`${indexToCol(c)}${r}`);vr.push(cell?(cell.value!==undefined?cell.value:(cell.formula??null)):null);fr.push(cell?.formula||null);}v.push(vr);f.push(fr);}return{values:v,formulas:f};}
function mockClient(toolName, params) {
  if (toolName === 'workbook.readWorkbook') { const sheets=[...workbook.sheets.entries()].map(([n,s])=>{const b=sheetBounds(s);return{name:n,usedRange:{rowCount:b.maxRow,columnCount:b.maxCol}};}); return { data:{ sheets } }; }
  if (toolName === 'workbook.readSheet') { const n=params.sheet||params.sheetName||'Sheet1';const s=workbook.sheets.get(n);if(!s)return{data:{name:n,values:[],formulas:[]}};const b=sheetBounds(s);const{values,formulas}=sheetTo2D(s,1,Math.max(1,b.maxRow||1),1,Math.max(1,b.maxCol||1));return{data:{name:n,values,formulas}};}
  if (toolName === 'workbook.readRange') { const n=params.sheet||params.sheetName||'Sheet1';const r=parseRange(params.target);const s=workbook.sheets.get(n);if(!s||!r)return{data:{sheet:n,target:params.target,values:[[]],formulas:[[]]}};const{values,formulas}=sheetTo2D(s,r.r1,r.r2,r.c1,r.c2);return{data:{sheet:n,target:params.target,values,formulas}};}
  if (toolName === 'workbook.listNamedRanges') return { data: { namedRanges: [] } };
  if (toolName === 'workbook.readFormatSummary') return { data: { summary: 'mock' } };
  return { data: {} };
}

// ── Step driver ──────────────────────────────────────────────────────────
const stats = { startedAt: Date.now(), iterations: [], errors: [], steps: [], events: 0 };

function paramsSummary(p) {
  if (!p || typeof p !== 'object') return '';
  const keys = Object.keys(p);
  const parts = [];
  for (const k of keys.slice(0, 6)) {
    const v = p[k];
    if (k === 'cells' && v && typeof v === 'object') {
      const addrs = Object.keys(v).slice(0, 4);
      parts.push(`cells={${addrs.join(',')}${Object.keys(v).length > 4 ? ',…' : ''}}`);
    } else if (Array.isArray(v)) {
      parts.push(`${k}[${v.length}]`);
    } else if (typeof v === 'string') {
      parts.push(`${k}="${v.slice(0, 40)}${v.length > 40 ? '…' : ''}"`);
    } else if (typeof v === 'object' && v) {
      parts.push(`${k}={…}`);
    } else {
      parts.push(`${k}=${v}`);
    }
  }
  return parts.join(' ');
}

async function stepLoop(turnId, token) {
  let nextClientResult = null;
  let stepSeq = 0;
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) {
    if (Date.now() - t0 > TIMEOUT_MS) { stats.errors.push({ ts: now(), message: 'timeout' }); break; }
    const body = nextClientResult ? { turnId, clientResult: nextClientResult, stepSeq } : { turnId, stepSeq };
    const r = await request('POST', `${SERVER}/api/turn/step`, { Authorization: `Bearer ${token}` }, body);
    if (r.status !== 200) { stats.errors.push({ ts: now(), message: `step [${r.status}]: ${r.body.slice(0, 300)}` }); break; }
    nextClientResult = null;
    const { control, payload, stepSeq: newSeq } = r.json || {};
    if (typeof newSeq === 'number') stepSeq = newSeq;
    stats.steps.push({ ts: now(), control, payloadKind: payload ? Object.keys(payload).slice(0,5).join(',') : '' });
    if (payload && Array.isArray(payload.actions) && payload.actions.length) for (const a of payload.actions) applyAction(a);
    if (control === 'done') return;
    if (control === 'aborted') { stats.errors.push({ ts: now(), message: `aborted: ${payload?.reason || ''}` }); return; }
    if (control === 'paused') { nextClientResult = { results: [{ requestId: payload?.requestId || 'q', response: { data: { answer: 'continue' } } }] }; continue; }
    if (control === 'await_client') {
      const requests = Array.isArray(payload?.requests) ? payload.requests : [];
      const results = [];
      for (const req of requests) {
        let response = { data: {} };
        if (req.type === 'clientTool') response = mockClient(req.toolName, req.params || {});
        else if (req.type === 'permission') response = { approved: true };
        results.push({ requestId: req.id, response });
      }
      nextClientResult = { results };
      continue;
    }
  }
}

function now() { return new Date().toISOString().slice(11, 19); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log(`Server:   ${SERVER}`);
  console.log(`Scenario: ${SCENARIO}`);
  console.log(`Prompt:   ${OBJECTIVE.slice(0, 120)}${OBJECTIVE.length > 120 ? '…' : ''}`);
  console.log(`Out:      ${OUT}\n`);

  console.log('1) mint token...');
  const token = await mintAccessToken(EMAIL);

  console.log('2) start turn...');
  const startResp = await request('POST', `${SERVER}/api/turn/start`,
    { Authorization: `Bearer ${token}` },
    { message: OBJECTIVE, context: { activeSheet: 'Sheet1', workbookSheets: ['Sheet1'] } });
  if (startResp.status !== 200) { console.error(`start [${startResp.status}]: ${startResp.body.slice(0, 400)}`); process.exit(1); }
  const turnId = startResp.json.turnId;
  console.log(`   turnId: ${turnId}`);

  // Wait for approval gate
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const r = await request('GET', `${SERVER}/api/turn/${turnId}`, { Authorization: `Bearer ${token}` });
    const t = r.json || {};
    if (t.status === 'awaiting_approval') {
      console.log(`3) approve (${t.plan?.tasks?.length || 0} tasks)`);
      await request('POST', `${SERVER}/api/turn/approve`, { Authorization: `Bearer ${token}` }, { turnId });
      break;
    }
    if (t.status === 'running' || t.status === 'completed' || t.status === 'error') break;
  }

  console.log('4) step loop...');
  await stepLoop(turnId, token);

  const finalTurn = (await request('GET', `${SERVER}/api/turn/${turnId}`, { Authorization: `Bearer ${token}` })).json || {};

  // 5) Pull traces
  let traceRecords = [];
  try {
    const tr = await request('GET', `${SERVER}/api/turn/${encodeURIComponent(turnId)}/llm-traces?limit=5000&order=asc`, { Authorization: `Bearer ${token}` });
    if (tr.json) traceRecords = Array.isArray(tr.json) ? tr.json : (tr.json.records || tr.json.traces || []);
  } catch (e) { console.error('trace fetch err:', e.message); }

  // 6) Build iter-by-iter narrative from traces
  const responses = traceRecords.filter(r => (r.eventType || r.event_type) === 'llm.response');
  const requests = traceRecords.filter(r => (r.eventType || r.event_type) === 'llm.request');
  const narrative = [];
  for (let i = 0; i < responses.length; i++) {
    const r = responses[i];
    const matchedReq = requests.find(x => x.traceId === r.traceId && x.label === r.label);
    let parsed = null;
    try { parsed = JSON.parse(r.responseText || r.response_text || r.response || '{}'); } catch (e) { parsed = { _parseError: e.message, raw: (r.responseText || '').slice(0, 200) }; }
    const lastUser = matchedReq && Array.isArray(matchedReq.messages)
      ? (matchedReq.messages.filter(m => m.role === 'user').pop()?.content || '').replace(/\s+/g, ' ').slice(0, 200)
      : '';
    narrative.push({
      n: i + 1,
      label: r.label,
      latencyMs: r.latencyMs || r.latency_ms || 0,
      tokens: { in: r.usage?.prompt_tokens || r.prompt_tokens || 0, out: r.usage?.completion_tokens || r.completion_tokens || 0 },
      lastUserBrief: lastUser,
      thought: (parsed.thought || parsed.reasoning || '').slice(0, 240),
      tool: parsed.tool || parsed.action || null,
      paramsSummary: paramsSummary(parsed.params || parsed.parameters || {}),
      parseError: parsed._parseError || null
    });
  }

  const sheetSummary = [...workbook.sheets.entries()].map(([n, s]) => {
    const b = sheetBounds(s); let vc = 0, fc = 0;
    for (const v of s.values()) { if (v?.formula) fc++; if (v?.value !== undefined) vc++; }
    return { name: n, maxRow: b.maxRow, maxCol: b.maxCol, valueCells: vc, formulaCells: fc };
  });

  // Print response-by-response analysis
  console.log('\n═══ ITERATION-BY-ITERATION ═══\n');
  for (const it of narrative) {
    console.log(`[${String(it.n).padStart(3)}] ${it.label}  tok ${it.tokens.in}→${it.tokens.out}  ${it.latencyMs}ms`);
    if (it.parseError) console.log(`     ✗ PARSE ERROR: ${it.parseError}`);
    if (it.thought) console.log(`     thought: ${it.thought}`);
    if (it.tool) console.log(`     tool:    ${it.tool}(${it.paramsSummary})`);
  }

  console.log('\n═══ FINAL STATE ═══');
  console.log(`Status:   ${finalTurn.status} ${finalTurn.error ? `error=${finalTurn.error}` : ''}`);
  console.log(`Elapsed:  ${Math.round((Date.now() - stats.startedAt) / 1000)}s`);
  console.log(`LLM calls: ${responses.length}  steps: ${stats.steps.length}  errors: ${stats.errors.length}`);
  console.log(`Sheets:   ${sheetSummary.map(s => `${s.name}(r=${s.maxRow},c=${s.maxCol},v=${s.valueCells},f=${s.formulaCells})`).join(' | ')}`);
  if (stats.errors.length) console.log(`Errors:\n  ${stats.errors.slice(0, 5).map(e => e.message).join('\n  ')}`);

  // Dump cells of first sheet for inspection
  if (sheetSummary[0]) {
    const s0 = workbook.sheets.get(sheetSummary[0].name);
    const cells = [...s0.entries()].map(([a, c]) => `${a}=${c.formula ? `[F]${c.formula}` : c.value}`).slice(0, 30);
    console.log(`\nSample cells (${sheetSummary[0].name}):\n  ${cells.join('\n  ')}`);
  }

  fs.writeFileSync(OUT, JSON.stringify({ turnId, scenario: SCENARIO, finalTurn, narrative, sheetSummary, steps: stats.steps, errors: stats.errors }, null, 2));
  console.log(`\nSaved: ${OUT}`);
  process.exit(finalTurn.error ? 2 : 0);
}

main().catch(e => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
