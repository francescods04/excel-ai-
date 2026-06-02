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
const SCENARIO_DEFAULT_TIMEOUTS = { sumcol: 120, simple: 60, dcf: 600, vairano: 2700, data_cleaning: 600, fastfood_bp: 2700 };
const TIMEOUT_MS = (Number(arg('timeout', String(SCENARIO_DEFAULT_TIMEOUTS[arg('scenario','sumcol')] || 300))) || 300) * 1000;
const FINAL_STATUS_WAIT_MS = (Number(arg('final-wait', '90')) || 90) * 1000;
const RESUME_TURN_ID = arg('resume', null); // optional: reattach to existing turn
const OUT = arg('out', `/tmp/e2e_trace_${SCENARIO}_${Date.now()}.json`);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) { console.error('Missing SUPABASE env'); process.exit(1); }

const SCENARIOS = {
  sumcol: 'Crea un foglio con header A1:C1 = Nome, Età, Città. Aggiungi 5 righe di esempio (Mario 30 Roma, Lucia 28 Milano, Paolo 45 Napoli, Anna 22 Torino, Marco 35 Bologna). In D1 metti header "Età+10", in D2:D6 una formula che somma B2 + 10.',
  dcf: 'Crea un mini DCF: foglio Assumptions con Revenue iniziale 1000, growth 10%, margine 20%, sconto 8%, anni 5. Foglio Projections con Revenue Y1-Y5 in B2:F2 (=B2*(1+growth)), EBITDA = Revenue*margine, FCF=EBITDA. Foglio Valuation con NPV dei FCF.',
  simple: 'Scrivi "Hello World" in A1, "Buongiorno" in A2, e in A3 una formula =CONCATENATE(A1," ",A2).',
  vairano: 'fai un excel super completo per fare la valutazione della realizzazione di un progetto immobiliare da 0, l immobile sarà un 10 piani a vairano scalo in provincia di caserta di circa 1000mq2 per piano fai un analisi super cpmplessa di costi e ricavi, finanziamenti, dividi i costi in vari sottocosto. l excel deve essere completo con ogni foglio circa 1000 righe',
  data_cleaning: 'Crea un dataset clienti su Sheet "Raw" con 50 righe e colonne A:F = ClientID, Nome, Email, Telefono, Data_Iscrizione, Spesa_Totale. Includi volutamente almeno: 5 email senza @ o malformate, 3 telefoni con caratteri non numerici, 4 nomi con spazi extra/CAPS misti, 2 duplicati di ClientID. Poi crea un foglio "Clean" che applica formule per: trim e proper-case nomi, validare email con FIND("@"), normalizzare telefoni (solo cifre), e flaggare i duplicati. Crea un terzo foglio "QA Report" con conteggio errori per colonna e percentuale di righe pulite.',
  fastfood_bp: 'Crea un business plan completo per investitori istituzionali per il lancio della catena fast-food MEAT CREW — American Burger (location di proprietà, no franchising). Inizia da una single location a Milano e proietta lo scale-up. Menù (NON modificabile, da rispettare letteralmente in foglio Menù): Starters: MOCHO\'S BITES 6,90€, CHICKEN TENDERS 6,90€. Burger & Smash (Singola | Menu M): L.A. 14,50 | 21,90 (Doppio Patty Manzo, American Cheese, Insalata, Pomodoro, Cipolla Cruda, Mocho\'s Burger Sauce); CRISPY 14,50 | 21,90 (Doppio Patty Manzo, American Cheese, Bacon, Mocho\'s Burger Sauce); MAC \'N\' CHEESE 15,50 | 22,90 (Doppio Patty Manzo, American Cheese, Maccheroni al Formaggio, Pickles, Bacon, Mocho\'s Burger Sauce); OKLAHOMA 15,00 | 22,40 (Doppio Patty Manzo, American Cheese, Pickles, Cipolla Smashata, Bacon, Ketchup, Senape); JUNIOR 8,50 (Patty singolo Manzo, American Cheese — no menu). Sandwiches: PASTRAMI 19,00 | 26,40; THE O.G. 14,50 | 21,90. Hot Dogs: BACON DOG 8,00 | 15,40; CHILI DOG 9,00 | 16,40. Beyond Meat: TENDERS 7,50 (no menu); VEGGIE DELUXE 14,50 | 21,90. Sides: CRISPY FRIES 5,50, BACON FRIES 6,50, CHILI FRIES 6,50, MAC \'N\' CHEESE 6,50. Sweets: BANANA PUDDING 4,90, GLAZED DONUT 2,50. Milkshakes 6,00€ (Vaniglia, Peanut Butter, Banana, Fragola, Cioccolato, Oreo; extra Panna/Bacon +0,50). Drinks: Acqua 2,00, FREE REFILL 4,50, Birra Raw 5,50. Fogli richiesti: Assumptions (input drivers: rent Milano, costi food %, labor cost, copertura coperti/giorno, scontrino medio, capex apertura, multiplo exit), Menù (listino letterale sopra), Cost of Goods (food cost per piatto, %COGS), Personnel (organico per ruolo, costo annuo loaded), CapEx (apertura singola location), Revenue Forecast (60 mesi con stagionalità), P&L mensile e annuale (5 anni), Cash Flow, Break-even, Scale-up Plan (apertura nuove location anno 2-5 con mix città italiane), Valuation (DCF + multiplo EBITDA exit), Sensitivity (scontrino medio × coperti/giorno, EBITDA margin × WACC). Numeri devono essere coerenti tra fogli — niente input fabbricati, niente padding di righe.'
};
const OBJECTIVE = SCENARIOS[SCENARIO] || SCENARIOS.sumcol;

// ── HTTP ─────────────────────────────────────────────────────────────────
function request(method, urlStr, headers, body, timeoutMs) {
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
    req.on('error', reject);
    // Explicit socket timeout. Vercel function limit is 300s; cap requests at
    // 310s so a stalled function manifests as a clean reject + script retry.
    req.setTimeout(timeoutMs || 310000, () => { req.destroy(new Error('socket_timeout')); });
    if (data) req.write(data); req.end();
  });
}

async function mintAccessToken(email) {
  // Pre-minted token from caller (e.g. multi-runner) avoids hitting Supabase
  // magiclink rate limits when launching N parallel scenarios.
  if (process.env.E2E_PREMINTED_TOKEN) return process.env.E2E_PREMINTED_TOKEN;
  // Retry generate_link on rate limit / transient with exponential backoff.
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt));
    const linkResp = await request('POST', `${SUPABASE_URL}/auth/v1/admin/generate_link`,
      { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }, { type: 'magiclink', email });
    if (linkResp.status === 429 || linkResp.status >= 500) {
      lastErr = new Error(`generate_link [${linkResp.status}] attempt ${attempt + 1}: ${linkResp.body.slice(0, 200)}`);
      continue;
    }
    if (linkResp.status >= 400) throw new Error(`generate_link [${linkResp.status}]: ${linkResp.body.slice(0, 300)}`);
    const root = linkResp.json || {};
    const email_otp = root.email_otp || root.properties?.email_otp;
    if (email_otp) {
      const r = await request('POST', `${SUPABASE_URL}/auth/v1/verify`, { apikey: SERVICE_KEY }, { type: 'magiclink', email, token: email_otp });
      if (r.json?.access_token) return r.json.access_token;
    }
    lastErr = new Error('no email_otp in generate_link response');
  }
  throw lastErr || new Error('mintAccessToken exhausted retries');
}

// ── Mock workbook (minimal) ──────────────────────────────────────────────
const workbook = { sheets: new Map([['Sheet1', new Map()]]) };
function colToIndex(c){let n=0;for(const ch of String(c||'').toUpperCase())n=n*26+(ch.charCodeAt(0)-64);return n;}
function indexToCol(n){let s='';while(n>0){const r=(n-1)%26;s=String.fromCharCode(65+r)+s;n=Math.floor((n-1)/26);}return s;}
function parseAddr(a){const m=String(a).replace(/\$/g,'').match(/^([A-Z]+)(\d+)$/i);return m?{col:colToIndex(m[1]),row:Number(m[2])}:null;}
function parseRange(t){const raw=String(t||'').replace(/\$/g,'');if(raw.includes('!'))return parseRange(raw.split('!').slice(1).join('!'));const[a,b]=raw.split(':');const L=parseAddr(a);if(!L)return null;const R=b?parseAddr(b):L;if(!R)return null;return{c1:Math.min(L.col,R.col),c2:Math.max(L.col,R.col),r1:Math.min(L.row,R.row),r2:Math.max(L.row,R.row)};}
function splitQualifiedRange(t){const raw=String(t||'');const bang=raw.indexOf('!');if(bang<0)return{sheet:null,range:raw};let sheet=raw.slice(0,bang).trim();if(sheet.startsWith("'")&&sheet.endsWith("'"))sheet=sheet.slice(1,-1).replace(/''/g,"'");return{sheet,range:raw.slice(bang+1)};}
function targetSheet(params,fallback='Sheet1'){const q=splitQualifiedRange(params.target||params.range||params.address||params.addr||params.from||params.source||params.to||params.dest||params.copyToRange);return params.sheet||params.sheetName||q.sheet||fallback;}
function targetRange(t){return splitQualifiedRange(t).range;}
function ensureSheet(n){if(!workbook.sheets.has(n))workbook.sheets.set(n,new Map());return workbook.sheets.get(n);}
function translateFormula(f,dR,dC){if(typeof f!=='string')return f;return f.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g,(m,ab,col,ar,row)=>{const nc=ab==='$'?col:indexToCol(colToIndex(col)+dC);const nr=ar==='$'?row:String(Number(row)+dR);return `${ab}${nc}${ar}${nr}`;});}
function cellSpec(sp){return sp&&typeof sp==='object'&&!Array.isArray(sp)?sp:{value:sp};}
function matrixAt(value,r,c){return Array.isArray(value)?(Array.isArray(value[r])?value[r][c]:value[r]):value;}
function writeCell(s,addr,spec){const sp=cellSpec(spec);const formula=sp.formula!==undefined?sp.formula:(typeof sp.value==='string'&&sp.value.startsWith('=')?sp.value:undefined);const value=formula!==undefined?undefined:sp.value;s.set(addr,{value,formula});}
function writeRangeCells(s,target,spec){const r=parseRange(target);if(!r)return;const sp=cellSpec(spec);const values=sp.values!==undefined?sp.values:sp.value;const formulas=sp.formulas!==undefined?sp.formulas:sp.formula;for(let row=r.r1;row<=r.r2;row++)for(let col=r.c1;col<=r.c2;col++){const rr=row-r.r1,cc=col-r.c1,addr=`${indexToCol(col)}${row}`;const formula=matrixAt(formulas,rr,cc);if(formula!==undefined&&formula!==null&&formula!=='')s.set(addr,{formula});else{const value=matrixAt(values,rr,cc);if(value!==undefined)s.set(addr,{value});}}}
function applySetCellRange(a){const defaultSheet=a.sheet||a.sheetName||'Sheet1';const cells=a.cells||{};for(const[ad,raw]of Object.entries(cells)){const q=splitQualifiedRange(ad);const s=ensureSheet(q.sheet||defaultSheet);const sp=cellSpec(raw);if(parseAddr(q.range))writeCell(s,q.range,sp);else writeRangeCells(s,q.range,sp);}if(a.copyToRange){const cq=splitQualifiedRange(a.copyToRange);const d=parseRange(cq.range);if(d)for(const[sa,raw]of Object.entries(cells)){const sq=splitQualifiedRange(sa);const s=ensureSheet(cq.sheet||sq.sheet||defaultSheet);const sp=cellSpec(raw);const src=parseRange(sq.range);const seed=parseAddr(sq.range);const formula=sp.formula!==undefined?sp.formula:(typeof sp.value==='string'&&sp.value.startsWith('=')?sp.value:null);if(!formula)continue;const anchor=seed||src&&{row:src.r1,col:src.c1};if(!anchor)continue;for(let r=d.r1;r<=d.r2;r++)for(let c=d.c1;c<=d.c2;c++){if(r===anchor.row&&c===anchor.col)continue;s.set(`${indexToCol(c)}${r}`,{formula:translateFormula(formula,r-anchor.row,c-anchor.col)});}}}}
function applyWriteRange(a){const target=a.target||a.range;const s=ensureSheet(targetSheet(a));writeRangeCells(s,targetRange(target),{value:a.value,values:a.values,formulas:a.formulas});}
function applyFillRange(a){const target=a.target||a.range;const s=ensureSheet(targetSheet(a));writeRangeCells(s,targetRange(target),{value:a.value});}
function applyRunFormula(a){const target=a.target||a.range;const s=ensureSheet(targetSheet(a));writeRangeCells(s,targetRange(target),{formula:a.value||a.formula});}
function applySetCellValue(a){const target=a.target||a.range;const s=ensureSheet(targetSheet(a));writeRangeCells(s,targetRange(target),{value:a.value});}
function applyCopyRange(a){const source=a.from||a.source||a.target;const dest=a.to||a.dest||a.copyToRange;const sourceQ=splitQualifiedRange(source);const destQ=splitQualifiedRange(dest);const from=workbook.sheets.get(a.fromSheet||a.sheet||sourceQ.sheet||'Sheet1');const to=ensureSheet(a.toSheet||a.sheet||destQ.sheet||sourceQ.sheet||'Sheet1');const src=parseRange(sourceQ.range);const dst=parseRange(destQ.range);if(!from||!src||!dst)return;for(let r=0;r<=src.r2-src.r1;r++)for(let c=0;c<=src.c2-src.c1;c++){const cell=from.get(`${indexToCol(src.c1+c)}${src.r1+r}`);if(cell)to.set(`${indexToCol(dst.c1+c)}${dst.r1+r}`,{...cell});}}
function applyAction(a){if(!a||typeof a!=='object')return;const t=a.type;if(t==='createSheet'){const n=a.name||a.sheet;if(n)ensureSheet(n);}else if(t==='deleteSheet'){const n=a.name||a.sheet;if(n)workbook.sheets.delete(n);}else if(t==='renameSheet'){const oldName=a.oldName||a.name,newName=a.newName||a.to;if(oldName&&newName&&workbook.sheets.has(oldName)){workbook.sheets.set(newName,workbook.sheets.get(oldName));workbook.sheets.delete(oldName);}}else if(t==='setCellRange')applySetCellRange(a);else if(t==='writeRange')applyWriteRange(a);else if(t==='fillRange')applyFillRange(a);else if(t==='runFormula')applyRunFormula(a);else if(t==='setCellValue')applySetCellValue(a);else if(t==='copyRange')applyCopyRange(a);}
function sheetBounds(s){let mr=0,mc=0;for(const a of s.keys()){const p=parseAddr(a);if(!p)continue;if(p.row>mr)mr=p.row;if(p.col>mc)mc=p.col;}return{maxRow:mr,maxCol:mc};}
function usedRangeAddress(name,b){return b.maxRow&&b.maxCol?`${name}!A1:${indexToCol(b.maxCol)}${b.maxRow}`:null;}
function sheetTo2D(s,r1,r2,c1,c2){const v=[],f=[];for(let r=r1;r<=r2;r++){const vr=[],fr=[];for(let c=c1;c<=c2;c++){const cell=s.get(`${indexToCol(c)}${r}`);vr.push(cell?(cell.value!==undefined?cell.value:(cell.formula??null)):null);fr.push(cell?.formula||null);}v.push(vr);f.push(fr);}return{values:v,formulas:f};}
function mockClient(toolName, params) {
  if (toolName === 'workbook.readWorkbook') { const activeSheet=params.activeSheet||'Sheet1';const sheets=[...workbook.sheets.entries()].map(([n,s])=>{const b=sheetBounds(s);const maxRows=Number(params.maxRows)||20;const maxCols=Number(params.maxCols)||10;const rows=Math.min(Math.max(1,b.maxRow||1),maxRows);const cols=Math.min(Math.max(1,b.maxCol||1),maxCols);const{values,formulas}=sheetTo2D(s,1,rows,1,cols);return{name:n,usedRange:usedRangeAddress(n,b),rowCount:b.maxRow,columnCount:b.maxCol,preview:b.maxRow?values:[],formulas:b.maxRow&&params.includeFormulas!==false?formulas:[]};});return{data:{activeSheet,workbookSheets:[...workbook.sheets.keys()],selectedRange:`${activeSheet}!A1`,selectionSize:{rows:1,columns:1},selectedValues:[[]],selectedFormulas:[[]],selectedRangeTruncated:false,sheets}}; }
  if (toolName === 'workbook.readSheet') { const n=targetSheet(params);const s=workbook.sheets.get(n);if(!s)return{data:{sheet:n,usedRange:null,values:[],formulas:[],rowCount:0,columnCount:0}};const b=sheetBounds(s);const maxRows=Number(params.maxRows)||30;const maxCols=Number(params.maxCols)||12;const rows=Math.min(Math.max(1,b.maxRow||1),maxRows);const cols=Math.min(Math.max(1,b.maxCol||1),maxCols);const{values,formulas}=sheetTo2D(s,1,rows,1,cols);return{data:{sheet:n,usedRange:usedRangeAddress(n,b),values:b.maxRow?values:[],formulas:b.maxRow?formulas:[],rowCount:b.maxRow,columnCount:b.maxCol}};}
  if (toolName === 'workbook.readRange') { const target=params.target||params.range||params.address||params.addr;const n=targetSheet(params);const cleanTarget=targetRange(target);const r=parseRange(cleanTarget);const s=workbook.sheets.get(n);if(!s||!r)return{data:{sheet:n,target:cleanTarget,address:n?`${n}!${cleanTarget}`:cleanTarget,values:[],formulas:[],rowCount:0,columnCount:0,totalRowCount:0,totalColumnCount:0,truncated:false}};const maxRows=Number(params.maxRows)||100;const maxCols=Number(params.maxCols)||100;const r2=Math.min(r.r2,r.r1+maxRows-1);const c2=Math.min(r.c2,r.c1+maxCols-1);const{values,formulas}=sheetTo2D(s,r.r1,r2,r.c1,c2);return{data:{sheet:n,target:cleanTarget,address:`${n}!${cleanTarget}`,values,formulas,rowCount:r2-r.r1+1,columnCount:c2-r.c1+1,totalRowCount:r.r2-r.r1+1,totalColumnCount:r.c2-r.c1+1,truncated:r2<r.r2||c2<r.c2}};}
  if (toolName === 'workbook.listNamedRanges') return { data: { namedRanges: [] } };
  if (toolName === 'workbook.readFormatSummary') return { data: { summary: 'mock' } };
  return { data: {} };
}

// ── Step driver ──────────────────────────────────────────────────────────
const stats = { startedAt: Date.now(), iterations: [], errors: [], steps: [], events: 0, lastControl: null, lastPayload: null };

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
  let netErrStreak = 0;
  // Save partial state every 10 steps so a script abort doesn't lose all data.
  const partialPath = OUT.replace(/\.json$/, '.partial.json');
  const savePartial = () => {
    try { fs.writeFileSync(partialPath, JSON.stringify({ turnId, scenario: SCENARIO, partial: true, steps: stats.steps, errors: stats.errors, sheetSnapshot: [...workbook.sheets.keys()] }, null, 2)); } catch (_) {}
  };
  for (let i = 0; i < 1000; i++) {
    if (i % 5 === 0 && i > 0) savePartial();
    if (Date.now() - t0 > TIMEOUT_MS) { stats.errors.push({ ts: now(), message: 'timeout' }); break; }
    const body = nextClientResult ? { turnId, clientResult: nextClientResult, stepSeq } : { turnId, stepSeq };
    let r;
    try {
      r = await request('POST', `${SERVER}/api/turn/step`, { Authorization: `Bearer ${token}` }, body);
      netErrStreak = 0;
    } catch (netErr) {
      netErrStreak++;
      if (netErrStreak >= 5) { stats.errors.push({ ts: now(), message: `network: ${netErr.message} (5 streak)` }); break; }
      stats.steps.push({ ts: now(), control: 'net_retry', payloadKind: netErr.message });
      await sleep(2000);
      continue; // retry without advancing stepSeq
    }
    if (r.status !== 200) { stats.errors.push({ ts: now(), message: `step [${r.status}]: ${r.body.slice(0, 300)}` }); break; }
    nextClientResult = null;
    const { control, payload, stepSeq: newSeq } = r.json || {};
    if (typeof newSeq === 'number') stepSeq = newSeq;
    stats.lastControl = control || null;
    stats.lastPayload = payload || null;
    stats.steps.push({ ts: now(), control, payloadKind: payload ? Object.keys(payload).slice(0,5).join(',') : '' });
    if (payload && Array.isArray(payload.actions) && payload.actions.length) for (const a of payload.actions) applyAction(a);
    // Periodic progress log so a long-running test doesn't look hung.
    if (i % 10 === 0 && i > 0) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.log(`   [step ${i}] ${elapsed}s elapsed, control=${control}, sheets=${workbook.sheets.size}`);
    }
    if (control === 'done') return;
    if (control === 'aborted') { stats.errors.push({ ts: now(), message: `aborted: ${payload?.reason || ''}` }); return; }
    if (control === 'paused') { nextClientResult = { results: [{ requestId: payload?.requestId || 'q', response: { data: { answer: 'continue' } } }] }; continue; }
    if (control === 'await_client') {
      const requests = Array.isArray(payload?.requests) ? payload.requests : [];
      const results = [];
      for (const req of requests) {
        let response = { data: {} };
        if (req.type === 'clientTool' || req.toolName) response = mockClient(req.toolName, req.params || {});
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

async function fetchTurnJson(turnId, token) {
  const r = await request('GET', `${SERVER}/api/turn/${turnId}`, { Authorization: `Bearer ${token}` }, null, 30000);
  return r.json || {};
}

async function fetchFinalTurn(turnId, token) {
  const deadline = Date.now() + FINAL_STATUS_WAIT_MS;
  let last = {};
  while (true) {
    last = await fetchTurnJson(turnId, token);
    if (last.status === 'completed' || last.status === 'error') return last;
    if (stats.lastControl !== 'done' && stats.lastControl !== 'aborted') return last;
    if (Date.now() >= deadline) return last;
    console.log(`   final status still ${last.status || 'unknown'} after ${stats.lastControl}; retrying...`);
    await sleep(3000);
  }
}

function normText(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function activeSheets(sheetSummary) {
  return (sheetSummary || []).filter(s => (s.maxRow || 0) > 0 || (s.maxCol || 0) > 0 || (s.valueCells || 0) > 0 || (s.formulaCells || 0) > 0);
}

function totals(sheetSummary) {
  return (sheetSummary || []).reduce((acc, s) => {
    acc.formulas += s.formulaCells || 0;
    acc.values += s.valueCells || 0;
    acc.cells += (s.formulaCells || 0) + (s.valueCells || 0);
    return acc;
  }, { formulas: 0, values: 0, cells: 0 });
}

function allWorkbookText(sheetCells) {
  return Object.entries(sheetCells || {}).map(([name, cells]) =>
    `${name}\n${Object.entries(cells || {}).map(([addr, c]) => `${addr}:${c.f || c.v || ''}`).join('\n')}`
  ).join('\n');
}

function rangeEndpointKind(token) {
  const raw = String(token || '').replace(/\$/g, '').toUpperCase();
  if (/^[A-Z]{1,3}\d+$/.test(raw)) return 'cell';
  if (/^[A-Z]{1,3}$/.test(raw)) return 'column';
  if (/^\d+$/.test(raw)) return 'row';
  return 'unknown';
}

function malformedRangeRefs(formula) {
  const bad = [];
  const re = /(?:(?:'[^']+'|[A-Za-z_][\w .&-]*)!)?(\$?[A-Z]{1,3}\$?\d+|\$?\d+|\$?[A-Z]{1,3})\s*:\s*(\$?[A-Z]{1,3}\$?\d+|\$?\d+|\$?[A-Z]{1,3})/gi;
  for (const match of String(formula || '').matchAll(re)) {
    const left = match[1];
    const right = match[2];
    const leftKind = rangeEndpointKind(left);
    const rightKind = rangeEndpointKind(right);
    if (leftKind !== rightKind || leftKind === 'unknown') bad.push(`${left}:${right}`);
  }
  return bad;
}

function formulaQualityIssues(sheetCells) {
  const malformed = [];
  for (const [sheet, cells] of Object.entries(sheetCells || {})) {
    for (const [addr, c] of Object.entries(cells || {})) {
      const formula = c && c.f;
      if (!formula) continue;
      const badRanges = malformedRangeRefs(formula);
      for (const ref of badRanges) malformed.push({ sheet, addr, ref, formula });
    }
  }
  return { malformed };
}

function hasSheetLike(sheetSummary, pattern) {
  return (sheetSummary || []).some(s => pattern.test(normText(s.name)));
}

function evaluateScenarioQuality({ scenario, finalTurn, sheetSummary, sheetCells, narrative }) {
  const failures = [];
  const warnings = [];
  const sheets = activeSheets(sheetSummary);
  const total = totals(sheetSummary);
  const text = normText(allWorkbookText(sheetCells));
  const formulaIssues = formulaQualityIssues(sheetCells);
  const unrecoveredParse = (narrative || []).filter(n => n.parseError && !n.parseErrorRecovered).length;
  const recoveredParse = (narrative || []).filter(n => n.parseError && n.parseErrorRecovered).length;

  if (finalTurn.status !== 'completed') failures.push(`final status is ${finalTurn.status || 'unknown'}, expected completed`);
  if (finalTurn.error) failures.push(`turn error: ${finalTurn.error}`);
  if (stats.errors.length > 0) failures.push(`${stats.errors.length} runner error(s): ${stats.errors.slice(0, 2).map(e => e.message).join(' | ')}`);
  if (stats.lastControl === 'done' && finalTurn.status !== 'completed') failures.push('step loop returned done but persisted turn is not completed');
  if (formulaIssues.malformed.length > 0) {
    const sample = formulaIssues.malformed.slice(0, 3).map(x => `${x.sheet}!${x.addr} ${x.formula}`).join(' | ');
    failures.push(`malformed formula ranges detected (${formulaIssues.malformed.length}): ${sample}`);
  }
  if (unrecoveredParse > 0) warnings.push(`${unrecoveredParse} unrecovered parse error(s) in trace`);
  if (recoveredParse > 0) warnings.push(`${recoveredParse} recovered parse error(s)`);

  if (scenario === 'dcf') {
    for (const [label, re] of [['Assumptions', /assum/], ['Projections', /projection/], ['Valuation', /valuation/]]) {
      if (!hasSheetLike(sheetSummary, re)) failures.push(`missing ${label} sheet`);
    }
    if (total.formulas < 15) failures.push(`DCF formula count too low (${total.formulas} < 15)`);
    if (!/npv|van|discount|sconto/.test(text)) failures.push('DCF valuation does not show NPV/discount logic');
  } else if (scenario === 'data_cleaning') {
    const raw = (sheetSummary || []).find(s => normText(s.name) === 'raw');
    const clean = (sheetSummary || []).find(s => normText(s.name) === 'clean');
    const qa = (sheetSummary || []).find(s => /qa|report/.test(normText(s.name)));
    if (!raw || raw.maxRow < 51) failures.push(`Raw sheet too small (${raw?.maxRow || 0} rows, expected 51)`);
    if (!clean || clean.maxRow < 51) failures.push(`Clean sheet too small (${clean?.maxRow || 0} rows, expected 51)`);
    if (!qa || qa.maxRow < 5) failures.push('QA Report missing or too small');
    if ((clean?.formulaCells || 0) < 250) failures.push(`Clean formula coverage too low (${clean?.formulaCells || 0} < 250)`);
    if (!/duplicat|duplicate/.test(text)) failures.push('duplicate flag/check not found');
  } else if (scenario === 'fastfood_bp') {
    const required = [/assum/, /menu|menu/, /cost of goods|cogs/, /personnel/, /capex/, /revenue/, /p&l|pnl/, /cash/, /break/, /scale/, /valuation/, /sensitivity/];
    const matched = required.filter(re => hasSheetLike(sheetSummary, re) || re.test(text)).length;
    if (sheets.length < 10) failures.push(`fastfood workbook has too few populated sheets (${sheets.length} < 10)`);
    if (matched < 10) failures.push(`fastfood required sections matched ${matched}/12`);
    if (total.cells < 500) failures.push(`fastfood workbook too thin (${total.cells} cells < 500)`);
    if (total.formulas < 100) failures.push(`fastfood formula count too low (${total.formulas} < 100)`);
    if (!/mocho|crispy|oklahoma|banana pudding|free refill/.test(text)) failures.push('literal menu coverage missing');
    if (!hasSheetLike(sheetSummary, /revenue/) || !((sheetSummary || []).some(s => /revenue/.test(normText(s.name)) && (s.maxCol >= 50 || s.maxRow >= 60)))) failures.push('60-month revenue forecast not detected');
  } else if (scenario === 'vairano') {
    if (sheets.length < 8) failures.push(`Vairano workbook has too few populated sheets (${sheets.length} < 8)`);
    if (total.cells < 5000) failures.push(`Vairano workbook too thin (${total.cells} cells < 5000)`);
    if (total.formulas < 1000) failures.push(`Vairano formula count too low (${total.formulas} < 1000)`);
    if (!(sheetSummary || []).some(s => s.maxRow >= 900)) failures.push('no ~1000-row sheet detected');
    for (const [label, re] of [['costi', /costi|cost breakdown|sottocosti/], ['ricavi', /ricavi|revenue|vendite/], ['finanziamenti', /finanziament|mutuo|loan|debt/], ['sensitivity', /sensitivity|sensitiv|scenario/]]) {
      if (!re.test(text)) failures.push(`Vairano missing ${label} coverage`);
    }
  }

  const score = Math.max(0, 100 - failures.length * 20 - warnings.length * 5);
  return { ok: failures.length === 0, score, failures, warnings, totals: total, populatedSheets: sheets.length };
}

async function main() {
  console.log(`Server:   ${SERVER}`);
  console.log(`Scenario: ${SCENARIO}`);
  console.log(`Prompt:   ${OBJECTIVE.slice(0, 120)}${OBJECTIVE.length > 120 ? '…' : ''}`);
  console.log(`Out:      ${OUT}\n`);

  console.log('1) mint token...');
  const token = await mintAccessToken(EMAIL);

  let turnId;
  if (RESUME_TURN_ID) {
    turnId = RESUME_TURN_ID;
    console.log(`2) RESUME existing turn: ${turnId}`);
    // Sanity: ensure turn is fetchable (with retries for 404 propagation).
    let foundStatus = null;
    for (let k = 0; k < 5; k++) {
      const r = await request('GET', `${SERVER}/api/turn/${turnId}`, { Authorization: `Bearer ${token}` }, null, 30000);
      if (r.status === 200 && r.json) { foundStatus = r.json.status; break; }
      console.log(`   resume fetch [${r.status}], retry ${k+1}/5...`);
      await sleep(2000);
    }
    if (!foundStatus) { console.error(`Resume failed: turn ${turnId} not fetchable`); process.exit(1); }
    console.log(`   resumed at status=${foundStatus}`);
  } else {
    console.log('2) start turn...');
    const startResp = await request('POST', `${SERVER}/api/turn/start`,
      { Authorization: `Bearer ${token}` },
      { message: OBJECTIVE, context: { activeSheet: 'Sheet1', workbookSheets: ['Sheet1'] } });
    if (startResp.status !== 200) { console.error(`start [${startResp.status}]: ${startResp.body.slice(0, 400)}`); process.exit(1); }
    turnId = startResp.json.turnId;
    console.log(`   turnId: ${turnId}`);

    // 404 retry — Supabase eventual consistency means the GET right after
    // start can return "not found" for 500-2000ms. Retry up to 5 times.
    let initialOk = false;
    for (let k = 0; k < 5; k++) {
      await sleep(1500);
      const r = await request('GET', `${SERVER}/api/turn/${turnId}`, { Authorization: `Bearer ${token}` }, null, 30000);
      if (r.status === 200 && r.json && r.json.status) { initialOk = true; break; }
      console.log(`   initial fetch [${r.status}], retry ${k+1}/5...`);
    }
    if (!initialOk) console.warn(`   ⚠ turn not yet visible after 5 retries; continuing anyway`);
  }

  // Wait for approval gate (Vairano architect blueprint ~30s, allow up to 5 min)
  for (let i = 0; i < 200; i++) {
    await sleep(1500);
    const r = await request('GET', `${SERVER}/api/turn/${turnId}`, { Authorization: `Bearer ${token}` }, null, 30000);
    const t = r.json || {};
    if (i > 0 && i % 20 === 0) console.log(`   wait status=${t.status || r.status || 'unknown'} (${i}/200)`);
    if (t.status === 'awaiting_approval') {
      console.log(`3) approve (${t.plan?.tasks?.length || 0} tasks)`);
      await request('POST', `${SERVER}/api/turn/approve`, { Authorization: `Bearer ${token}` }, { turnId });
      break;
    }
    if (t.status === 'running' || t.status === 'completed' || t.status === 'error') break;
  }

  console.log(`4) step loop (timeout ${Math.round(TIMEOUT_MS/60000)}min)...`);
  await stepLoop(turnId, token);

  const finalTurn = await fetchFinalTurn(turnId, token);

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
    let parseErrorRecovered = false;
    const rawTxt = r.responseText || r.response_text || r.response || '{}';
    try { parsed = JSON.parse(rawTxt); } catch (e) {
      // Trace stores RAW response. Production layer may have recovered via
      // tryRecoverTruncatedAgentJson / tryParseJSON. If a subsequent iter
      // shows forward progress (thought/tool), this iter's parse error was
      // recovered transparently — flag but don't blame.
      parsed = { _parseError: e.message, _rawTxt: rawTxt.slice(0, 200) };
      // Forward-progress detection done after loop.
    }
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
  const sheetCells = {};
  for (const [name, s] of workbook.sheets.entries()) {
    const out = {};
    for (const [addr, c] of s.entries()) {
      out[addr] = c.formula ? { f: c.formula } : { v: c.value };
    }
    sheetCells[name] = out;
  }

  // Mark parse errors as recovered if a subsequent iter shows forward progress
  for (let i = 0; i < narrative.length; i++) {
    if (!narrative[i].parseError) continue;
    const next = narrative.slice(i + 1, i + 3).find(x => x.tool || x.thought);
    if (next) narrative[i].parseErrorRecovered = true;
  }
  const quality = evaluateScenarioQuality({ scenario: SCENARIO, finalTurn, sheetSummary, sheetCells, narrative });

  // Print response-by-response analysis
  console.log('\n═══ ITERATION-BY-ITERATION ═══\n');
  for (const it of narrative) {
    console.log(`[${String(it.n).padStart(3)}] ${it.label}  tok ${it.tokens.in}→${it.tokens.out}  ${it.latencyMs}ms`);
    if (it.parseError) {
      const tag = it.parseErrorRecovered ? '⚠ PARSE (recovered in server)' : '✗ PARSE ERROR';
      console.log(`     ${tag}: ${it.parseError}`);
    }
    if (it.thought) console.log(`     thought: ${it.thought}`);
    if (it.tool) console.log(`     tool:    ${it.tool}(${it.paramsSummary})`);
  }

  console.log('\n═══ FINAL STATE ═══');
  console.log(`Status:   ${finalTurn.status} ${finalTurn.error ? `error=${finalTurn.error}` : ''}`);
  console.log(`Elapsed:  ${Math.round((Date.now() - stats.startedAt) / 1000)}s`);
  console.log(`LLM calls: ${responses.length}  steps: ${stats.steps.length}  errors: ${stats.errors.length}`);
  console.log(`Sheets:   ${sheetSummary.map(s => `${s.name}(r=${s.maxRow},c=${s.maxCol},v=${s.valueCells},f=${s.formulaCells})`).join(' | ')}`);
  console.log(`Quality:  ${quality.ok ? 'PASS' : 'FAIL'} score=${quality.score} populatedSheets=${quality.populatedSheets} cells=${quality.totals.cells} formulas=${quality.totals.formulas}`);
  if (stats.errors.length) console.log(`Errors:\n  ${stats.errors.slice(0, 5).map(e => e.message).join('\n  ')}`);
  if (quality.failures.length) console.log(`Quality failures:\n  ${quality.failures.slice(0, 8).join('\n  ')}`);
  if (quality.warnings.length) console.log(`Quality warnings:\n  ${quality.warnings.slice(0, 8).join('\n  ')}`);

  // Dump cells of first sheet for inspection
  if (sheetSummary[0]) {
    const s0 = workbook.sheets.get(sheetSummary[0].name);
    const cells = [...s0.entries()].map(([a, c]) => `${a}=${c.formula ? `[F]${c.formula}` : c.value}`).slice(0, 30);
    console.log(`\nSample cells (${sheetSummary[0].name}):\n  ${cells.join('\n  ')}`);
  }

  fs.writeFileSync(OUT, JSON.stringify({ turnId, scenario: SCENARIO, finalTurn, narrative, sheetSummary, sheetCells, steps: stats.steps, errors: stats.errors, quality }, null, 2));
  console.log(`\nSaved: ${OUT}`);
  process.exit(quality.ok ? 0 : 2);
}

main().catch(e => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
