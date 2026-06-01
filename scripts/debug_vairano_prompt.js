#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { triageObjective } = require('../server/agents/triage');
const { generateBlueprint, validateBlueprint } = require('../server/agents/architect');
const { callLLM } = require('../server/tools/llm');
const { TRACE_DIR, readLlmTraces } = require('../server/utils/llmTrace');

const OBJECTIVE = 'fai un excel super completo per fare la valutazione della realizzazione di un progetto immobiliare da 0, l immobile sarà un 10 piani a vairano scalo in provincia di caserta di circa 1000mq2 per piano  fai un analisi super cpmplessa di costi e ricavi, finanziamenti, dividi i costi in vari sottocosto. l excel deve essere completo con ogni foglio circa 1000 righe';

const KEYWORDS = [
  'vairano',
  'caserta',
  'immobiliare',
  'progetto immobiliare',
  'real estate',
  'development proforma',
  're_development',
  'construction',
  'costruzione'
];

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const arg = process.argv.slice(2).find(item => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function compact(value, max = 900) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}... [${oneLine.length - max} chars trimmed]`;
}

function loadTraceRecords() {
  let files = [];
  try {
    files = fs.readdirSync(TRACE_DIR).filter(name => name.endsWith('.jsonl')).sort();
  } catch (_) {
    return [];
  }

  const records = [];
  for (const file of files) {
    const fullPath = path.join(TRACE_DIR, file);
    let lines = [];
    try {
      lines = fs.readFileSync(fullPath, 'utf8').split('\n').filter(Boolean);
    } catch (_) {
      continue;
    }
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch (_) {
        // ignore malformed historical trace rows
      }
    }
  }
  return records;
}

function messageText(record) {
  if (!Array.isArray(record.messages)) return '';
  return record.messages.map(message => `${message.role || 'unknown'}: ${message.content || ''}`).join('\n');
}

function userQuestion(record) {
  if (!Array.isArray(record.messages)) return '';
  const users = record.messages.filter(message => message.role === 'user');
  return users.length ? users[users.length - 1].content || '' : '';
}

function recordBlob(record) {
  return [
    record.label,
    record.traceId,
    record.turnId,
    messageText(record),
    record.responseText,
    record.error && JSON.stringify(record.error),
  ].filter(Boolean).join('\n').toLowerCase();
}

function tracePairKey(record) {
  return `${record.traceId || 'no-trace'}|${record.label || 'no-label'}|${record.attempt || 'primary'}`;
}

function actionStatsFromResponse(record) {
  const response = record.response && typeof record.response === 'object' ? record.response : null;
  if (!response || !Array.isArray(response.slices)) return null;
  return summarizeBlueprint(response);
}

function summarizeHistoricalPairs(limit) {
  const records = loadTraceRecords();
  const matched = records.filter(record => KEYWORDS.some(keyword => recordBlob(record).includes(keyword)));
  const matchedKeys = new Set(matched.map(tracePairKey));
  const related = records.filter(record => matchedKeys.has(tracePairKey(record)));
  const byKey = new Map();

  for (const record of related) {
    const key = tracePairKey(record);
    const pair = byKey.get(key) || { key, traceId: record.traceId, label: record.label, attempt: record.attempt, records: [] };
    pair.records.push(record);
    if (record.eventType === 'llm.request') pair.request = record;
    if (record.eventType === 'llm.response') pair.response = record;
    if (record.eventType === 'llm.error') pair.error = record;
    if (!pair.ts || String(record.ts || '') > pair.ts) pair.ts = record.ts;
    byKey.set(key, pair);
  }

  const pairs = [...byKey.values()].sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || ''))).slice(0, limit);
  console.log(`\n=== Historical matching LLM Q/A (${pairs.length}/${byKey.size}) ===`);
  if (!pairs.length) {
    console.log(`No matching records in ${TRACE_DIR}`);
    return;
  }

  for (const pair of pairs) {
    const response = pair.response;
    const error = pair.error;
    console.log(`\n[${pair.ts || 'no-ts'}] ${pair.label || 'no-label'} trace=${pair.traceId || 'no-trace'} attempt=${pair.attempt || 'primary'}`);
    if (pair.request) console.log(`Q: ${compact(userQuestion(pair.request), 1200)}`);
    if (response) {
      const stats = actionStatsFromResponse(response);
      const usage = response.usage ? ` tokens=${response.usage.prompt_tokens || 0}/${response.usage.completion_tokens || 0}` : '';
      console.log(`A:${usage} ${compact(response.responseText || response.response, 1400)}`);
      if (stats) console.log(`Blueprint stats: ${compact(stats, 1400)}`);
      if (response.extra?.jsonError) console.log(`JSON error: ${response.extra.jsonError}`);
    }
    if (error) console.log(`ERROR: ${compact(error.error, 600)}`);
  }
}

function columnToNumber(col) {
  let n = 0;
  for (const ch of String(col || '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function countRangeCells(target) {
  const raw = String(target || '').replace(/\$/g, '').trim();
  if (!raw) return 0;
  const parts = raw.split(':');
  const cellRe = /^([A-Z]+)(\d+)$/i;
  if (parts.length === 1) return cellRe.test(parts[0]) ? 1 : Infinity;
  const left = parts[0].match(cellRe);
  const right = parts[1].match(cellRe);
  if (!left || !right) return Infinity;
  const cols = Math.abs(columnToNumber(right[1]) - columnToNumber(left[1])) + 1;
  const rows = Math.abs(Number(right[2]) - Number(left[2])) + 1;
  return cols * rows;
}

function isWidthOnlyFormat(options) {
  const keys = Object.keys(options || {});
  return keys.length > 0 && keys.every(key => key === 'columnWidth' || key === 'rowHeight');
}

function inspectAction(action, issues, stats) {
  if (!action || typeof action !== 'object') return;
  const tool = action.tool || action.type || 'unknown';
  stats.toolCounts[tool] = (stats.toolCounts[tool] || 0) + 1;
  stats.totalActions += 1;

  const params = action.params || {};
  if (tool === 'set_cell_range') {
    const cellCount = Object.keys(params.cells || {}).length;
    stats.maxLiteralCells = Math.max(stats.maxLiteralCells, cellCount);
    if (cellCount > 250) issues.push(`set_cell_range has ${cellCount} literal cells`);
    if (params.copyToRange) {
      stats.copyToRangeCount += 1;
      const copiedCells = countRangeCells(params.copyToRange);
      if (!Number.isFinite(copiedCells) || copiedCells > 12000) issues.push(`copyToRange unsafe: ${params.sheet || '?'}!${params.copyToRange}`);
    }
  }

  if (tool === 'bulk_set_cell_ranges') {
    const writes = Array.isArray(params.writes) ? params.writes : [];
    for (const write of writes) {
      const cellCount = Object.keys(write.cells || {}).length;
      stats.maxLiteralCells = Math.max(stats.maxLiteralCells, cellCount);
      if (cellCount > 250) issues.push(`bulk write has ${cellCount} literal cells on ${write.sheet || '?'}`);
      if (write.copyToRange) {
        stats.copyToRangeCount += 1;
        const copiedCells = countRangeCells(write.copyToRange);
        if (!Number.isFinite(copiedCells) || copiedCells > 12000) issues.push(`bulk copyToRange unsafe: ${write.sheet || '?'}!${write.copyToRange}`);
      }
    }
  }

  const formats = tool === 'set_format'
    ? [{ sheet: params.sheet, target: params.target, options: params.options || {} }]
    : (tool === 'bulk_set_format' && Array.isArray(params.formats) ? params.formats : []);
  for (const fmt of formats) {
    const targetCells = countRangeCells(fmt.target);
    if ((!Number.isFinite(targetCells) || targetCells > 12000) && !isWidthOnlyFormat(fmt.options)) {
      issues.push(`format target unsafe: ${fmt.sheet || '?'}!${fmt.target || '?'} (${Number.isFinite(targetCells) ? targetCells : 'unbounded'} cells)`);
    }
  }
}

function summarizeBlueprint(blueprint) {
  const stats = {
    slices: Array.isArray(blueprint.slices) ? blueprint.slices.length : 0,
    waves: Array.isArray(blueprint.waves) ? blueprint.waves.length : 0,
    deterministicSlices: 0,
    totalActions: 0,
    copyToRangeCount: 0,
    maxLiteralCells: 0,
    toolCounts: {},
    issues: []
  };

  for (const slice of blueprint.slices || []) {
    if (Array.isArray(slice.actions) && slice.actions.length > 0) stats.deterministicSlices += 1;
    for (const action of slice.actions || []) inspectAction(action, stats.issues, stats);
  }

  if (stats.totalActions === 0) stats.issues.push('no deterministic actions in blueprint');
  if (stats.copyToRangeCount === 0) stats.issues.push('no copyToRange actions; dense 1000-row sheets will likely be slow or shallow');
  return stats;
}

function printBlueprintSlices(blueprint) {
  console.log('\n=== Blueprint slices ===');
  for (const slice of blueprint.slices || []) {
    const sheets = slice.scope?.sheets_owned || [];
    const ranges = slice.scope?.ranges_owned || [];
    console.log(`- ${slice.id}: actions=${(slice.actions || []).length}, deps=${(slice.deps || []).join(',') || '-'}, sheets=${sheets.join(',') || ranges.join(',') || '-'}`);
  }
}

function makeTracedCall(traceId) {
  return async (options) => callLLM({
    ...options,
    trace: {
      traceId,
      source: 'debug_vairano_prompt',
      phase: options.role || null,
    }
  });
}

function printTraceForId(traceId) {
  const records = readLlmTraces({ traceId, limit: 20, descending: false });
  console.log(`\n=== Live trace Q/A trace=${traceId} (${records.length} records) ===`);
  const byKey = new Map();
  for (const record of records) {
    const key = tracePairKey(record);
    const pair = byKey.get(key) || {};
    if (record.eventType === 'llm.request') pair.request = record;
    if (record.eventType === 'llm.response') pair.response = record;
    if (record.eventType === 'llm.error') pair.error = record;
    if (record.eventType === 'llm.fallback') pair.fallback = record;
    pair.label = record.label;
    pair.attempt = record.attempt;
    byKey.set(key, pair);
  }

  for (const pair of byKey.values()) {
    console.log(`\n${pair.label || 'no-label'} attempt=${pair.attempt || 'primary'}`);
    if (pair.request) console.log(`Q: ${compact(userQuestion(pair.request), 1200)}`);
    if (pair.response) {
      const usage = pair.response.usage ? ` tokens=${pair.response.usage.prompt_tokens || 0}/${pair.response.usage.completion_tokens || 0}` : '';
      console.log(`A:${usage} ${compact(pair.response.responseText || pair.response.response, 1600)}`);
      if (pair.response.extra?.jsonError) console.log(`JSON error: ${pair.response.extra.jsonError}`);
    }
    if (pair.error) console.log(`ERROR: ${compact(pair.error.error, 700)}`);
    if (pair.fallback) console.log(`FALLBACK: ${compact(pair.fallback.extra, 700)}`);
  }
}

async function runLive() {
  const traceId = `debug-vairano-${Date.now()}`;
  const context = { activeSheet: 'Sheet1', workbookSheets: ['Sheet1'] };
  const callLLMFn = makeTracedCall(traceId);

  console.log('\n=== Live Vairano triage + architect ===');
  console.log(`traceId=${traceId}`);
  console.log(`objective=${OBJECTIVE}`);

  const triage = await triageObjective({ objective: OBJECTIVE, context, callLLMFn });
  console.log('\nTriage:');
  console.log(JSON.stringify({
    complexity: triage.complexity,
    parallelizable: triage.parallelizable,
    mode: triage.mode,
    estimated_iterations: triage.estimated_iterations,
    reasoning: triage.reasoning,
    scale_hints: triage.scale_hints,
    fallback: triage._meta?.fallback || false,
    model: triage._meta?.model || null,
    latencyMs: triage._meta?.latencyMs || null,
  }, null, 2));

  const blueprint = await generateBlueprint({ objective: OBJECTIVE, context, triage, callLLMFn });
  const validation = validateBlueprint(blueprint, { workbookSheets: context.workbookSheets, objective: OBJECTIVE });
  const summary = summarizeBlueprint(blueprint);

  console.log('\nArchitect summary:');
  console.log(JSON.stringify({
    validationOk: validation.ok,
    validationErrors: validation.errors || [],
    objective_restated: blueprint.objective_restated,
    global_layout_notes: blueprint.global_layout_notes,
    summary,
    model: blueprint._meta?.model || null,
    latencyMs: blueprint._meta?.latencyMs || null,
  }, null, 2));
  printBlueprintSlices(blueprint);
  printTraceForId(traceId);
}

async function main() {
  const limit = Math.max(1, Number(argValue('--limit', '8')) || 8);
  if (!hasFlag('--skip-history')) summarizeHistoricalPairs(limit);
  if (hasFlag('--live')) await runLive();
}

main().catch(error => {
  console.error(`\nFAILED: ${error.stack || error.message}`);
  process.exit(1);
});
