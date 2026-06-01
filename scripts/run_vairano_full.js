#!/usr/bin/env node
/**
 * Vairano full e2e — drives the runtime IN-PROCESS (no HTTP/auth) with an
 * in-memory Excel mock client. Captures all SSE events via monkey-patch on
 * streaming.sendEvent, plus the full LLM trace via llmTrace.readLlmTraces.
 *
 * Usage:
 *   node scripts/run_vairano_full.js
 *   node scripts/run_vairano_full.js --timeout=900 --out=/tmp/vairano_full.json
 */

require('dotenv').config();
const fs = require('fs');

const streaming = require('../server/agents/streaming');
const turns = require('../server/runtime/turns');
const { readLlmTraces } = require('../server/utils/llmTrace');

const argMap = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const GLOBAL_TIMEOUT_MS = (Number(argMap.timeout) || 900) * 1000;
const OUT_PATH = argMap.out || `/tmp/vairano_full_${Date.now()}.json`;

const OBJECTIVE = 'fai un excel super completo per fare la valutazione della realizzazione di un progetto immobiliare da 0, l immobile sarà un 10 piani a vairano scalo in provincia di caserta di circa 1000mq2 per piano  fai un analisi super cpmplessa di costi e ricavi, finanziamenti, dividi i costi in vari sottocosto. l excel deve essere completo con ogni foglio circa 1000 righe';

// ─── In-memory workbook simulator ───────────────────────────────────────────

const workbook = { sheets: new Map([['Sheet1', new Map()]]) };

function colToIndex(col) {
  let n = 0;
  for (const ch of String(col || '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function indexToCol(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function parseAddr(a) {
  const m = String(a).replace(/\$/g, '').match(/^([A-Z]+)(\d+)$/i);
  if (!m) return null;
  return { col: colToIndex(m[1]), row: Number(m[2]) };
}
function parseRange(target) {
  const raw = String(target || '').replace(/\$/g, '');
  if (raw.includes('!')) return parseRange(raw.split('!').slice(1).join('!'));
  const [a, b] = raw.split(':');
  const left = parseAddr(a);
  if (!left) return null;
  const right = b ? parseAddr(b) : left;
  if (!right) return null;
  return {
    c1: Math.min(left.col, right.col), c2: Math.max(left.col, right.col),
    r1: Math.min(left.row, right.row), r2: Math.max(left.row, right.row),
  };
}
function ensureSheet(name) {
  if (!workbook.sheets.has(name)) workbook.sheets.set(name, new Map());
  return workbook.sheets.get(name);
}
function translateFormula(formula, dRow, dCol) {
  if (typeof formula !== 'string') return formula;
  return formula.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (m, abc, col, abr, row) => {
    const newCol = abc === '$' ? col : indexToCol(colToIndex(col) + dCol);
    const newRow = abr === '$' ? row : String(Number(row) + dRow);
    return `${abc}${newCol}${abr}${newRow}`;
  });
}
function applySetCellRange(action) {
  const sheet = ensureSheet(action.sheet || action.sheetName || 'Sheet1');
  const cells = action.cells || {};
  const seeds = Object.entries(cells);
  for (const [addr, spec] of seeds) {
    const p = parseAddr(addr); if (!p) continue;
    sheet.set(addr, { value: spec.value, formula: spec.formula });
  }
  const copyToRange = action.copyToRange;
  if (copyToRange && seeds.length > 0) {
    const dest = parseRange(copyToRange);
    if (dest) {
      for (const [seedAddr, spec] of seeds) {
        if (!spec.formula) continue;
        const seed = parseAddr(seedAddr); if (!seed) continue;
        const maxCells = 50000;
        let written = 0;
        for (let r = dest.r1; r <= dest.r2; r++) {
          for (let c = dest.c1; c <= dest.c2; c++) {
            if (r === seed.row && c === seed.col) continue;
            if (++written > maxCells) return;
            const a = `${indexToCol(c)}${r}`;
            sheet.set(a, { formula: translateFormula(spec.formula, r - seed.row, c - seed.col) });
          }
        }
      }
    }
  }
}
function applyCopyRange(action) {
  const from = parseRange(action.from);
  const src = workbook.sheets.get(action.from_sheet);
  const dst = ensureSheet(action.to_sheet);
  const toAddr = parseAddr(action.to);
  if (!from || !src || !toAddr) return;
  for (let r = from.r1; r <= from.r2; r++) {
    for (let c = from.c1; c <= from.c2; c++) {
      const cell = src.get(`${indexToCol(c)}${r}`); if (!cell) continue;
      const dstA = `${indexToCol(toAddr.col + (c - from.c1))}${toAddr.row + (r - from.r1)}`;
      const newF = cell.formula ? translateFormula(cell.formula, toAddr.row - from.r1, toAddr.col - from.c1) : undefined;
      dst.set(dstA, { value: cell.value, formula: newF });
    }
  }
}
function applyAction(a) {
  if (!a || typeof a !== 'object') return;
  const t = a.type;
  if (t === 'createSheet') { const name = a.name || a.sheet; if (name) ensureSheet(name); }
  else if (t === 'deleteSheet') { if (a.name) workbook.sheets.delete(a.name); }
  else if (t === 'renameSheet') {
    if (a.from && a.to && workbook.sheets.has(a.from)) {
      workbook.sheets.set(a.to, workbook.sheets.get(a.from));
      workbook.sheets.delete(a.from);
    }
  } else if (t === 'setCellRange') applySetCellRange(a);
  else if (t === 'copyRange') applyCopyRange(a);
}
function sheetBounds(sheet) {
  let maxRow = 0, maxCol = 0;
  for (const addr of sheet.keys()) {
    const p = parseAddr(addr); if (!p) continue;
    if (p.row > maxRow) maxRow = p.row;
    if (p.col > maxCol) maxCol = p.col;
  }
  return { maxRow, maxCol };
}
function sheetTo2D(sheet, r1, r2, c1, c2) {
  const values = [], formulas = [];
  for (let r = r1; r <= r2; r++) {
    const vRow = [], fRow = [];
    for (let c = c1; c <= c2; c++) {
      const cell = sheet.get(`${indexToCol(c)}${r}`);
      vRow.push(cell ? (cell.value !== undefined ? cell.value : (cell.formula ?? null)) : null);
      fRow.push(cell?.formula || null);
    }
    values.push(vRow); formulas.push(fRow);
  }
  return { values, formulas };
}
function mockClientTool(toolName, params) {
  if (toolName === 'workbook.readWorkbook') {
    const sheets = [...workbook.sheets.entries()].map(([name, s]) => {
      const b = sheetBounds(s);
      return { name, usedRange: { rowCount: b.maxRow, columnCount: b.maxCol } };
    });
    return { data: { sheets } };
  }
  if (toolName === 'workbook.readSheet') {
    const name = params.sheet || params.sheetName || 'Sheet1';
    const s = workbook.sheets.get(name);
    if (!s) return { data: { name, values: [], formulas: [] } };
    const b = sheetBounds(s);
    const { values, formulas } = sheetTo2D(s, 1, Math.max(1, Math.min(b.maxRow || 1, 2000)), 1, Math.max(1, Math.min(b.maxCol || 1, 60)));
    return { data: { name, values, formulas } };
  }
  if (toolName === 'workbook.readRange') {
    const name = params.sheet || params.sheetName || 'Sheet1';
    const r = parseRange(params.target);
    const s = workbook.sheets.get(name);
    if (!s || !r) return { data: { sheet: name, target: params.target, values: [[]], formulas: [[]] } };
    const { values, formulas } = sheetTo2D(s, r.r1, Math.min(r.r2, r.r1 + 1500), r.c1, Math.min(r.c2, r.c1 + 60));
    return { data: { sheet: name, target: params.target, values, formulas } };
  }
  if (toolName === 'workbook.readFormatSummary') return { data: { summary: 'mock', sheet: params.sheet } };
  if (toolName === 'workbook.listNamedRanges') return { data: { namedRanges: [] } };
  return { data: {} };
}

// ─── Capture all SSE events via monkey-patch ────────────────────────────────

const stats = {
  events: [], logs: [], errors: [], taskActions: [], toolRequests: [],
  triageDecision: null, blueprint: null, completed: false, error: null,
  startedAt: Date.now(),
};

const origSendEvent = streaming.sendEvent;
streaming.sendEvent = function (jobId, eventType, data) {
  const ts = new Date().toISOString().slice(11, 19);
  stats.events.push({ ts, event: eventType });

  if (eventType === 'log' && data) {
    const lvl = data.level || 'info';
    const m = String(data.message || '');
    stats.logs.push({ ts, level: lvl, message: m });
    if (lvl === 'error' || lvl === 'warn') stats.errors.push({ ts, level: lvl, message: m });
    process.stdout.write(`[${ts}] ${lvl.padEnd(5)} ${m}\n`);
  } else if (eventType === 'triageDecision') {
    stats.triageDecision = data;
  } else if (eventType === 'planUpdated' && data?.tasks && data.tasks.length) {
    // Capture blueprint on first plan
  } else if (eventType === 'taskActions') {
    stats.taskActions.push({ ts, taskId: data.taskId, actionCount: (data.actions || []).length });
    process.stdout.write(`[${ts}] ▷ taskActions ${data.taskId}: ${(data.actions || []).length} actions\n`);
    for (const a of (data.actions || [])) applyAction(a);
    // Acknowledge async (do not block sendEvent)
    setImmediate(() => {
      try {
        turns.recordActionExecution(jobId, {
          taskId: data.taskId, itemId: data.itemId,
          actionCount: (data.actions || []).length, errorCount: 0, status: 'completed'
        });
      } catch (e) { console.error('action-result err:', e.message); }
    });
  } else if (eventType === 'toolRequest' || eventType === 'toolRequestBatch') {
    const reqs = data.requests || [data.request];
    for (const req of reqs) {
      if (!req) continue;
      stats.toolRequests.push({ ts, type: req.type, name: req.toolName || req.title });
      const responses = [];
      if (req.type === 'clientTool') {
        responses.push({ requestId: req.id, response: mockClientTool(req.toolName, req.params || {}) });
      } else if (req.type === 'permission') {
        responses.push({ requestId: req.id, response: { approved: true } });
      } else if (req.type === 'userInput') {
        const fields = req.fields || [];
        const values = {}; fields.forEach(f => values[f.key] = '0');
        responses.push({ requestId: req.id, response: { data: values } });
      }
      for (const r of responses) {
        setImmediate(() => {
          try { turns.respondToTurnRequest(jobId, r.requestId, r.response); }
          catch (e) { console.error('respond err:', e.message); }
        });
      }
    }
  } else if (eventType === 'turnCompleted') {
    stats.completed = true;
    if (data?.error) stats.error = data.error;
  }

  return origSendEvent.call(this, jobId, eventType, data);
};

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Out: ${OUT_PATH}`);
  console.log(`Timeout: ${GLOBAL_TIMEOUT_MS / 1000}s\n`);

  // Disable Supabase persistence noise if envs missing
  process.env.DISABLE_QUOTA = 'true';

  const turn = turns.startTurn(OBJECTIVE, { activeSheet: 'Sheet1', workbookSheets: ['Sheet1'] }, null, {});
  const turnId = turn.id;
  console.log(`Turn: ${turnId}\n`);

  // Wait for blueprint/plan, then approve if needed
  let approved = false;
  const deadline = Date.now() + GLOBAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    const t = turns.loadTurn(turnId);
    if (!t) continue;
    if (!approved && t.status === 'awaiting_approval') {
      console.log(`\n>>> Plan ready — approving (${t.plan?.tasks?.length || 0} tasks)\n`);
      if (t.plan?.meta?.blueprint) {
        stats.blueprint = {
          objective_restated: t.plan.meta.blueprint.objective_restated,
          global_layout_notes: t.plan.meta.blueprint.global_layout_notes,
          waves: t.plan.meta.blueprint.waves,
          slices: t.plan.meta.blueprint.slices.map(s => ({
            id: s.id, title: s.title, deps: s.deps, tier: s.tier,
            sheets_owned: s.scope?.sheets_owned, ranges_owned: s.scope?.ranges_owned,
            may_read_from: s.scope?.may_read_from,
            actionCount: (s.actions || []).length,
            actionToolMix: (s.actions || []).reduce((m, a) => { m[a.tool] = (m[a.tool] || 0) + 1; return m; }, {}),
          })),
        };
      }
      if (t.plan?.meta?.triage) stats.triageDecision = stats.triageDecision || t.plan.meta.triage;
      try { turns.approveTurn(turnId); approved = true; } catch (e) { console.error('approve err:', e.message); break; }
    }
    if (stats.completed || t.status === 'completed' || t.status === 'error') break;
  }

  if (!stats.completed) console.warn('\n[!] Timeout: turn non completed.');

  const elapsedSec = Math.round((Date.now() - stats.startedAt) / 1000);

  // Read LLM trace
  let traceRecords = [];
  try { traceRecords = readLlmTraces({ turnId, limit: 5000, descending: false }); }
  catch (e) { console.error('trace read err:', e.message); }

  const labelCounts = {};
  const labelTokens = {};
  const labelLatency = {};
  for (const r of traceRecords) {
    if (r.eventType === 'llm.response') {
      labelCounts[r.label] = (labelCounts[r.label] || 0) + 1;
      labelTokens[r.label] = (labelTokens[r.label] || { in: 0, out: 0 });
      labelTokens[r.label].in += r.usage?.prompt_tokens || 0;
      labelTokens[r.label].out += r.usage?.completion_tokens || 0;
      labelLatency[r.label] = (labelLatency[r.label] || 0) + (r.latencyMs || 0);
    }
  }

  const finalTurn = turns.loadTurn(turnId) || {};
  const sheetSummary = [...workbook.sheets.entries()].map(([name, s]) => {
    const b = sheetBounds(s);
    let valueCells = 0, formulaCells = 0;
    for (const v of s.values()) { if (v?.formula) formulaCells++; if (v?.value !== undefined) valueCells++; }
    return { name, maxRow: b.maxRow, maxCol: b.maxCol, valueCells, formulaCells };
  });

  // Sample LLM Q/A: triage, architect, first 3 slice workers' first/last iteration
  const sampleQA = [];
  const seenLabels = new Set();
  for (const r of traceRecords) {
    if (r.eventType !== 'llm.response') continue;
    if (seenLabels.size > 25) break;
    const lbl = r.label || '';
    if (lbl.includes('Triage') && !seenLabels.has('triage')) {
      seenLabels.add('triage');
      sampleQA.push({ label: lbl, q: lastUserMsg(findReqFor(traceRecords, r)), a: shortenA(r.responseText) });
    } else if (lbl.includes('Architect') && !seenLabels.has('architect:' + (r.attempt || 'primary'))) {
      seenLabels.add('architect:' + (r.attempt || 'primary'));
      sampleQA.push({ label: lbl, q: lastUserMsg(findReqFor(traceRecords, r)), a: shortenA(r.responseText) });
    } else if (lbl.includes('AgentLoop iter')) {
      const slice = r.phase || lbl;
      const key = `${slice}|${lbl}`;
      if (!seenLabels.has(key)) {
        seenLabels.add(key);
        if (sampleQA.length < 30) sampleQA.push({ label: lbl, phase: r.phase, q: lastUserMsg(findReqFor(traceRecords, r)), a: shortenA(r.responseText) });
      }
    }
  }

  const out = {
    turnId,
    elapsedSec,
    completed: stats.completed,
    error: stats.error || finalTurn.error || null,
    finalStatus: finalTurn.status || null,
    triageDecision: stats.triageDecision,
    blueprint: stats.blueprint,
    sheetSummary,
    taskActions: stats.taskActions,
    toolRequestCounts: stats.toolRequests.reduce((m, r) => { const k = `${r.type}:${r.name}`; m[k] = (m[k] || 0) + 1; return m; }, {}),
    eventTypeCounts: stats.events.reduce((m, e) => { m[e.event] = (m[e.event] || 0) + 1; return m; }, {}),
    llmTrace: { totalRecords: traceRecords.length, labelCounts, labelTokens, labelLatency },
    sampleQA,
    errorLogs: stats.errors.slice(0, 80),
    logsTail: stats.logs.slice(-150),
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`\nSaved: ${OUT_PATH}`);
  console.log(`elapsedSec=${elapsedSec} status=${finalTurn.status} error=${stats.error || 'none'}`);
  console.log(`Sheets: ${sheetSummary.map(s => `${s.name}(r=${s.maxRow},c=${s.maxCol},f=${s.formulaCells},v=${s.valueCells})`).join(' | ')}`);
  console.log(`Errors logged: ${stats.errors.length}`);
  console.log(`LLM labels (top):`);
  for (const [k, v] of Object.entries(labelCounts).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    const tk = labelTokens[k] || { in: 0, out: 0 };
    console.log(`  ${String(v).padStart(4)} ${k.padEnd(40)} tok ${tk.in}→${tk.out}  ms=${Math.round(labelLatency[k] || 0)}`);
  }

  process.exit(stats.error ? 2 : 0);
}

function findReqFor(records, response) {
  for (const r of records) {
    if (r.eventType === 'llm.request' && r.traceId === response.traceId && r.label === response.label && (r.attempt || 'primary') === (response.attempt || 'primary')) return r;
  }
  return null;
}
function lastUserMsg(req) {
  if (!req || !Array.isArray(req.messages)) return '';
  const u = req.messages.filter(m => m.role === 'user');
  return u.length ? (u[u.length - 1].content || '').replace(/\s+/g, ' ').slice(0, 1200) : '';
}
function shortenA(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').slice(0, 2400);
}

setTimeout(() => {
  console.error('\nGlobal timeout. Forcing exit.');
  process.exit(124);
}, GLOBAL_TIMEOUT_MS + 30000).unref();

main().catch(e => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
