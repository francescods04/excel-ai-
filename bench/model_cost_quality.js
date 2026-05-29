#!/usr/bin/env node
/**
 * Model cost/quality benchmark.
 *
 * Runs the complex multi-domain scenarios (bench/scenarios_complex.js) for ONE
 * model+thinking config (set via env, because model/thinking are read at module
 * load — so a sweep = one process per config; see bench/sweep_models.sh).
 *
 * Per scenario it captures: latency, iterations, actions, and TOKEN USAGE
 * (via llm.resetUsageStats/getUsageStats), then scores QUALITY with an LLM-judge
 * (fixed strong model, no thinking) against the scenario rubric on the agent's
 * EMITTED construction (sheets/labels/formulas/notes). Reads are stubbed, so the
 * judge grades plan & build quality, not live numeric results — fair for relative
 * flash-vs-pro comparison.
 *
 * Config env (all optional):
 *   BENCH_CONFIG_LABEL   filename + report key, e.g. "flash-no-thinking"
 *   BENCH_AGENT_MODEL    model the agent loop uses (e.g. deepseek-v4-flash / deepseek-v4-pro)
 *   BENCH_THINKING       none | light | full
 *   BENCH_JUDGE_MODEL    judge model (default deepseek-v4-pro) — keep FIXED across configs
 *   BENCH_SCENARIOS      comma list or domain (finance|data_science|real_estate|all). default all
 *   BENCH_TIMEOUT_MS     per-turn timeout (default 12 min)
 *
 * Usage:
 *   BENCH_CONFIG_LABEL=flash-no-thinking BENCH_AGENT_MODEL=deepseek-v4-flash BENCH_THINKING=none \
 *     node bench/model_cost_quality.js
 *
 * Output: bench/model-cost-quality-<label>-<ts>.jsonl  (+ stdout summary)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ---- Apply config overrides BEFORE requiring server modules (env read at load) ----
const CONFIG_LABEL = process.env.BENCH_CONFIG_LABEL || 'current';
const AGENT_MODEL = process.env.BENCH_AGENT_MODEL || process.env.AGENT_LOOP_MODEL || process.env.DEEPSEEK_FALLBACK_MODEL || 'deepseek-v4-flash';
const THINKING = (process.env.BENCH_THINKING || 'full').toLowerCase();
const JUDGE_MODEL = process.env.BENCH_JUDGE_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';

// Accurate token capture requires the non-streaming path (DeepSeek stream omits usage).
process.env.AGENT_USE_STREAMING = 'false';
process.env.AUTO_APPROVE_ALL = process.env.AUTO_APPROVE_ALL || 'true';
process.env.DISABLE_QUOTA = process.env.DISABLE_QUOTA || 'true';

// Force the agent loop onto the model under test (both default + fast variants).
process.env.AGENT_LOOP_MODEL = AGENT_MODEL;
process.env.AGENT_LOOP_FAST_MODEL = AGENT_MODEL;

// Map the high-level thinking knob onto the agent-loop thinking env flags.
if (THINKING === 'none') {
  process.env.DEEPSEEK_THINKING_ENABLED = 'false';
  process.env.AGENT_THINKING_FIRST_ITER = 'false';
  process.env.AGENT_THINKING_EVERY_ITER = 'false';
  process.env.AGENT_FORCE_THINKING_AFTER_ERROR = 'false';
} else if (THINKING === 'light') {
  process.env.DEEPSEEK_THINKING_ENABLED = 'true';
  process.env.AGENT_THINKING_FIRST_ITER = 'true';
  process.env.AGENT_THINKING_EVERY_ITER = 'false';
  process.env.DEEPSEEK_REASONING_EFFORT_AGENT = 'low';
} else { // full
  process.env.DEEPSEEK_THINKING_ENABLED = 'true';
  process.env.AGENT_THINKING_FIRST_ITER = 'true';
  process.env.AGENT_THINKING_EVERY_ITER = 'true';
  process.env.DEEPSEEK_REASONING_EFFORT_AGENT = 'high';
}

const fs = require('fs');
const turns = require('../server/runtime/turns');
const llm = require('../server/tools/llm');
const { SCENARIOS, DOMAINS } = require('./scenarios_complex');

const TURN_TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS) || 12 * 60 * 1000;
const POLL_MS = Number(process.env.BENCH_POLL_MS) || 250;

function resolveScenarioKeys() {
  const raw = (process.env.BENCH_SCENARIOS || 'all').trim();
  if (raw === 'all') return Object.keys(SCENARIOS);
  if (DOMAINS.includes(raw)) return Object.keys(SCENARIOS).filter(k => SCENARIOS[k].domain === raw);
  return raw.split(',').map(s => s.trim()).filter(k => SCENARIOS[k]);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clone = v => JSON.parse(JSON.stringify(v));

function buildStrategy(scenarioKey) {
  return {
    mode: 'agent_loop',
    label: 'Bench agent loop',
    reason: `model_cost_quality:${scenarioKey}`,
    promptVariant: SCENARIOS[scenarioKey].loopPromptVariant || 'default',
    allowEscalation: false,
    fallbackMode: null
  };
}

// ---- Mock client responses (Excel reads stubbed, same approach as runtime_mode_compare) ----
function buildReadResponse(request, scenario) {
  const params = request.params || {};
  const allSheetsData = scenario.context.allSheetsData || {};
  const workbookSheets = scenario.context.workbookSheets || Object.keys(allSheetsData);
  const activeSheet = scenario.context.activeSheet || workbookSheets[0] || 'Sheet1';
  const sheetName = params.sheet || params.sheetName || activeSheet;
  const sheetData = allSheetsData[sheetName] || { usedRange: `${sheetName}!A1:D10`, rowCount: 10, columnCount: 4, preview: [] };

  if (request.toolName === 'workbook.readWorkbook') {
    return { data: { activeSheet, workbookSheets, allSheetsData: clone(allSheetsData) } };
  }
  if (request.toolName === 'workbook.readSheet') {
    return { data: { sheetName, ...clone(sheetData) } };
  }
  if (request.toolName === 'workbook.readRange') {
    return { data: { sheetName, target: params.target || params.range || sheetData.usedRange, values: clone(sheetData.preview || []), formulas: [] } };
  }
  if (request.toolName === 'workbook.readFormatSummary') {
    return { data: { sheet: sheetName, target: params.target, styledCells: [], styledCellCount: 0, noteCountInSheet: 0 } };
  }
  if (request.toolName === 'workbook.listNamedRanges') {
    return { data: scenario.namedRanges || [] };
  }
  return { data: { ok: true, _bench_stub: true, values: [], formulas: [], cellCount: 0 } };
}

function buildQuestionResponse(request) {
  const questions = Array.isArray(request.questions) ? request.questions : [];
  return { values: { answers: questions.map(q => (Array.isArray(q?.options) ? q.options[0]?.label : '') || q?.defaultValue || 'Procedi') } };
}

// ---- Extract a faithful but bounded "what the agent built" summary for the judge ----
function buildConstructionSummary(turn) {
  const entries = Object.entries(turn.results || {}).filter(([id]) => !id.startsWith('__'));
  const sheets = new Set();
  const labels = [];
  const formulas = [];
  const namedRanges = [];
  const officeJsSnippets = [];
  let cellCount = 0, formulaCount = 0, notesCount = 0, chartsCount = 0, formatCount = 0, errorCount = 0;

  const pushAction = (a) => {
    if (!a || typeof a !== 'object') return;
    if (a.sheet) sheets.add(a.sheet);
    switch (a.type) {
      case 'setCellRange': {
        const cells = a.cells || {};
        for (const [, spec] of Object.entries(cells)) {
          cellCount++;
          if (spec && typeof spec === 'object') {
            if (typeof spec.value === 'string' && spec.value.trim() && labels.length < 180) labels.push(spec.value.slice(0, 60));
            if (spec.formula) { formulaCount++; if (formulas.length < 90) formulas.push(String(spec.formula).slice(0, 120)); }
            if (spec.note) notesCount++;
          }
        }
        break;
      }
      case 'setNotes': notesCount += Array.isArray(a.notes) ? a.notes.length : 0; break;
      case 'setCellFormat': formatCount++; break;
      case 'createSheet': if (a.name) sheets.add(a.name); break;
      case 'createChart': chartsCount++; break;
      case 'createNamedRange': if (a.name) namedRanges.push(a.name); break;
      case 'runJavaScript':
        // Agent built via execute_office_js — capture the code so the judge can score it.
        if (a.code && officeJsSnippets.join('').length < 8000) officeJsSnippets.push(String(a.code).slice(0, 2000));
        break;
      default: break;
    }
  };

  for (const [, result] of entries) {
    const actions = Array.isArray(result?.actions) ? result.actions : [];
    for (const a of actions) pushAction(a);
    if (Array.isArray(result?.errors)) errorCount += result.errors.length;
  }

  return {
    sheetsTouched: [...sheets],
    cellCount, formulaCount, notesCount, chartsCount, formatCount, errorCount,
    namedRanges: namedRanges.slice(0, 40),
    sampleLabels: labels,
    sampleFormulas: formulas,
    officeJsSnippets
  };
}

const JUDGE_SYSTEM = `You are a meticulous senior reviewer grading an AI agent that builds Excel models.
You are given: the user OBJECTIVE, a RUBRIC (the checkpoints that define institutional/expert quality), and a CONSTRUCTION SUMMARY of what the agent actually emitted (sheets, sample labels/line-items, sample formulas, notes, named ranges, counts, AND raw Office.js snippets when the agent built via execute_office_js — treat those snippets as construction evidence too). Excel reads were stubbed in this harness, so judge PLAN and CONSTRUCTION quality (coverage, correct linkage, formula approach, completeness), NOT live numeric results.
For each rubric point decide met (true/false/partial) based ONLY on evidence in the construction summary. Be strict: missing sheets, hardcoded values where formulas are required, absent linkage, or no sensitivity/waterfall when required = not met.
Return STRICT JSON only:
{"score": <0-100 int>, "points": [{"point": "<short>", "met": "yes|partial|no"}], "strengths": "<1-2 lines>", "gaps": "<1-2 lines>"}
score = weighted coverage of the rubric (institutional bar). No prose outside JSON.`;

async function judgeRun(scenario, construction) {
  const userText = [
    `OBJECTIVE:\n${scenario.objective}`,
    ``,
    `RUBRIC (institutional-quality checkpoints):`,
    ...scenario.rubric.map((r, i) => `${i + 1}. ${r}`),
    ``,
    `CONSTRUCTION SUMMARY (what the agent emitted):`,
    JSON.stringify(construction, null, 1).slice(0, 14000)
  ].join('\n');

  try {
    const res = await llm.callLLM({
      system: JUDGE_SYSTEM,
      userText,
      modelOverride: JUDGE_MODEL,
      thinkingDisabled: true,
      jsonMode: true,
      timeoutMs: 90000,
      fallbackTimeoutMs: 90000,
      label: 'bench judge'
    });
    const obj = (res && typeof res === 'object' && res.score != null)
      ? res
      : tryExtractJson(res && (res.raw || res.content || res.text));
    if (!obj || obj.score == null) return { score: null, error: 'judge_unparseable' };
    return {
      score: Math.max(0, Math.min(100, Math.round(Number(obj.score)))),
      points: Array.isArray(obj.points) ? obj.points : [],
      strengths: obj.strengths || '',
      gaps: obj.gaps || ''
    };
  } catch (err) {
    return { score: null, error: err.message };
  }
}

function tryExtractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch (_) {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (__) { return null; } }
    return null;
  }
}

function summarizeTurn(turn) {
  const entries = Object.entries(turn.results || {}).filter(([id]) => !id.startsWith('__'));
  const totalActions = entries.reduce((s, [, r]) => s + (Array.isArray(r?.actions) ? r.actions.length : 0), 0);
  let loopIteration = null;
  for (const [, r] of entries) {
    if (Number.isFinite(r?.data?.iteration)) { loopIteration = r.data.iteration; break; }
  }
  return { status: turn.status, error: turn.error || null, totalActions, loopIteration };
}

async function runScenario(scenarioKey, opts = {}) {
  const scenario = SCENARIOS[scenarioKey];
  const startedAt = Date.now();
  // In parallel mode the outer driver resets/reads usage once per config — skip here.
  const trackUsage = opts.trackUsage !== false;
  if (trackUsage) llm.resetUsageStats();

  const turn = turns.startTurn(scenario.objective, clone(scenario.context), null, { strategy: buildStrategy(scenarioKey) });
  const handled = new Set();
  const requestCounters = { clientTool: 0, question: 0, permission: 0 };

  let finalTurn = null;
  while (true) {
    const live = turns.loadTurn(turn.id);
    if (!live) throw new Error(`Turn perso: ${turn.id}`);
    if (live.status === 'awaiting_approval') turns.approveTurn(turn.id);

    for (const req of live.pendingRequests || []) {
      if (!req?.id || handled.has(req.id)) continue;
      handled.add(req.id);
      let response;
      if (req.type === 'clientTool') { requestCounters.clientTool++; response = buildReadResponse(req, scenario); }
      else if (req.type === 'question') { requestCounters.question++; response = buildQuestionResponse(req); }
      else if (req.type === 'permission') { requestCounters.permission++; response = { approved: true }; }
      else response = { error: `unsupported ${req.type}` };
      turns.respondToTurnRequest(turn.id, req.id, response);
    }

    if (live.status === 'completed' || live.status === 'error') { finalTurn = live; break; }
    if (Date.now() - startedAt > TURN_TIMEOUT_MS) {
      finalTurn = { ...(turns.loadTurn(turn.id) || live), status: 'error', error: `timeout ${TURN_TIMEOUT_MS}ms` };
      break;
    }
    await sleep(POLL_MS);
  }

  // Agent token usage (judge runs AFTER this read so its tokens aren't counted).
  // In parallel mode the outer driver gets one accumulator per config; here = null.
  const usage = trackUsage ? llm.getUsageStats() : null;
  const totalMs = Date.now() - startedAt;
  const construction = buildConstructionSummary(finalTurn);
  const meta = summarizeTurn(finalTurn);
  const quality = await judgeRun(scenario, construction);

  return {
    config: CONFIG_LABEL,
    agentModel: AGENT_MODEL,
    thinking: THINKING,
    scenario: scenarioKey,
    domain: scenario.domain,
    status: meta.status,
    error: meta.error,
    totalMs,
    iterations: meta.loopIteration,
    actions: meta.totalActions,
    cells: construction.cellCount,
    formulas: construction.formulaCount,
    notes: construction.notesCount,
    namedRanges: construction.namedRanges.length,
    charts: construction.chartsCount,
    excelErrors: construction.errorCount,
    requestCounters,
    usage: usage ? {
      calls: usage.calls,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cacheHitTokens: usage.cacheHitTokens,
      cacheMissTokens: usage.cacheMissTokens
    } : null,
    quality
  };
}

async function main() {
  const keys = resolveScenarioKeys();
  if (keys.length === 0) { console.error('Nessuno scenario valido (BENCH_SCENARIOS).'); process.exit(1); }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const safeLabel = String(CONFIG_LABEL).replace(/[^a-zA-Z0-9_-]/g, '_');
  const outFile = path.join(__dirname, `model-cost-quality-${safeLabel}-${ts}.jsonl`);
  const out = fs.createWriteStream(outFile, { flags: 'a' });

  const PARALLEL = process.env.BENCH_PARALLEL === 'true';
  const CONCURRENCY = Math.max(1, Number(process.env.BENCH_CONCURRENCY) || 5);

  console.log(`Model cost/quality bench`);
  console.log(`  config=${CONFIG_LABEL}  agentModel=${AGENT_MODEL}  thinking=${THINKING}  judge=${JUDGE_MODEL}`);
  console.log(`  scenarios=[${keys.join(', ')}]`);
  console.log(`  mode=${PARALLEL ? `parallel x${CONCURRENCY}` : 'sequential'}`);
  console.log(`  output=${outFile}\n`);

  const results = [];

  if (PARALLEL) {
    // ONE accumulator for the whole config; per-scenario usage is the even split.
    llm.resetUsageStats();
    let cursor = 0;
    async function worker(id) {
      while (cursor < keys.length) {
        const idx = cursor++;
        const key = keys[idx];
        process.stdout.write(`  [w${id} start] ${key}\n`);
        try {
          const r = await runScenario(key, { trackUsage: false });
          results.push(r);
          process.stdout.write(`  [w${id} done ] ${key.padEnd(26)}  ${r.status}  ${Math.round(r.totalMs / 1000)}s  iter=${r.iterations ?? '-'}  actions=${r.actions}  Q=${r.quality?.score ?? 'n/a'}\n`);
        } catch (err) {
          process.stdout.write(`  [w${id} ERR  ] ${key}: ${err.message}\n`);
          results.push({ config: CONFIG_LABEL, scenario: key, status: 'error', error: err.message });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keys.length) }, (_, i) => worker(i + 1)));

    // Spread the config-wide aggregate across the runs so per-config sums in the
    // report stay correct (per-scenario attribution is approximate in parallel mode).
    const total = llm.getUsageStats() || { calls: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
    const n = results.length || 1;
    for (const r of results) {
      if (r.status === 'error' && !r.scenario) continue;
      r.usage = {
        calls: Math.round(total.calls / n),
        promptTokens: Math.round(total.promptTokens / n),
        completionTokens: Math.round(total.completionTokens / n),
        cacheHitTokens: Math.round(total.cacheHitTokens / n),
        cacheMissTokens: Math.round(total.cacheMissTokens / n),
        _note: 'evenly distributed across scenarios (BENCH_PARALLEL)'
      };
      out.write(JSON.stringify(r) + '\n');
    }
  } else {
    for (const key of keys) {
      process.stdout.write(`  ${key.padEnd(26)} ... `);
      try {
        const r = await runScenario(key);
        out.write(JSON.stringify(r) + '\n');
        results.push(r);
        const tok = r.usage ? r.usage.promptTokens + r.usage.completionTokens : 0;
        console.log(`${r.status}  ${Math.round(r.totalMs / 1000)}s  iter=${r.iterations ?? '-'}  actions=${r.actions}  tok=${tok}  Q=${r.quality?.score ?? 'n/a'}`);
      } catch (err) {
        console.log(`ERROR ${err.message}`);
        out.write(JSON.stringify({ config: CONFIG_LABEL, scenario: key, status: 'error', error: err.message }) + '\n');
      }
    }
  }
  out.end();

  // Per-config summary
  const ok = results.filter(r => r.quality?.score != null);
  const mean = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  const totalTok = results.reduce((s, r) => s + (r.usage ? r.usage.promptTokens + r.usage.completionTokens : 0), 0);
  console.log(`\n--- CONFIG SUMMARY: ${CONFIG_LABEL} ---`);
  console.log(`  scenarios ok: ${results.filter(r => r.status === 'completed').length}/${results.length}`);
  console.log(`  mean quality: ${mean(ok.map(r => r.quality.score))}  (judge=${JUDGE_MODEL})`);
  console.log(`  mean latency: ${mean(results.map(r => Math.round(r.totalMs / 1000)))}s`);
  console.log(`  total tokens: ${totalTok}  (prompt+completion across all scenarios)`);
  console.log(`\nRun the report to compare configs:  node bench/model_cost_quality_report.js`);
}

main().catch(err => { console.error(err); process.exit(1); });
