#!/usr/bin/env node
/**
 * Planner LLM A/B benchmark.
 *
 * Cross-tests model x thinking configurations on the SAME planner prompt and
 * scenarios. Measures latency, output size, plan validity, plan task count.
 *
 * Configurations:
 *   - flash_nothink : deepseek-v4-flash, thinking disabled
 *   - flash_think   : deepseek-v4-flash, thinking enabled
 *   - pro_nothink   : deepseek-v4-pro, thinking disabled
 *   - pro_think     : deepseek-v4-pro, thinking enabled, reasoning_effort=high
 *
 * Usage:
 *   node bench/llm_plan_compare.js [scenarios=dcf,lbo,data_analysis] [runs=1]
 *
 * Output: bench/plan-compare-<timestamp>.jsonl + summary table on stdout.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { callLLM } = require('../server/tools/llm');

// Load planner pieces. We do this lazily to avoid heavy init when only the LLM call matters.
const planner = require('../server/agents/planner');

const SCENARIOS = {
  dcf: {
    objective: 'Crea un DCF granulare e professionale per Apple, con tutti i fogli istituzionali e analisi WACC peer-based',
    context: { activeSheet: 'Sheet1', workbookSheets: ['Sheet1'] }
  },
  lbo: {
    objective: 'Costruisci un LBO completo per Tesla con leva tradizionale, debt schedule, IRR/MOIC e sensitivity',
    context: { activeSheet: 'Sheet1', workbookSheets: ['Sheet1'] }
  },
  data_analysis: {
    objective: 'Analizza i dati del foglio attivo: profilatura, distribuzioni, correlazioni e insight actionable',
    context: {
      activeSheet: 'Sales',
      workbookSheets: ['Sales'],
      allSheetsData: {
        Sales: {
          isActive: true,
          usedRange: 'Sales!A1:F20',
          rowCount: 20, columnCount: 6,
          preview: [
            ['Date', 'Region', 'Product', 'Units', 'Revenue', 'Margin'],
            ['2024-01', 'EMEA', 'Pro', 120, 24000, 0.42],
            ['2024-01', 'NA', 'Pro', 85, 17000, 0.40],
            ['2024-02', 'APAC', 'Plus', 60, 9000, 0.32]
          ]
        }
      }
    }
  },
  forecasting: {
    objective: 'Forecast vendite per i prossimi 12 mesi con decomposizione trend/stagionalità e scenari',
    context: { activeSheet: 'Sheet1', workbookSheets: ['Sheet1'] }
  }
};

const CONFIGS = [
  { name: 'flash_nothink', model: 'deepseek-v4-flash', thinkingDisabled: true,  reasoningEffort: null    },
  { name: 'flash_think',   model: 'deepseek-v4-flash', thinkingDisabled: false, reasoningEffort: 'medium'},
  { name: 'pro_nothink',   model: 'deepseek-v4-pro',   thinkingDisabled: true,  reasoningEffort: null    },
  { name: 'pro_think',     model: 'deepseek-v4-pro',   thinkingDisabled: false, reasoningEffort: 'high'  }
];

function tryParseJson(text) {
  if (typeof text !== 'string') return text;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function scoreOutput(parsed) {
  if (!parsed) return { valid: false, reason: 'no_json', taskCount: 0 };
  if (!Array.isArray(parsed.tasks)) return { valid: false, reason: 'no_tasks_array', taskCount: 0 };
  const tasks = parsed.tasks;
  const taskCount = tasks.length;
  const tools = new Set(tasks.map(t => t?.tool).filter(Boolean));
  const hasRead = [...tools].some(t => t && t.startsWith('workbook.read'));
  const hasGraph = tools.has('workbook.buildGraph');
  const hasUnderstand = tools.has('workbook.understand');
  const hasBuildSection = tools.has('finance.dcf.buildSection') || tools.has('finance.model.buildSection');
  const buildSectionCount = tasks.filter(t => ['finance.dcf.buildSection', 'finance.model.buildSection'].includes(t?.tool)).length;
  const focusAreaCount = tasks.filter(t => t?.params?.focusArea).length;
  const sectionsUsed = new Set(tasks.map(t => t?.params?.section).filter(Boolean));
  return {
    valid: taskCount > 0,
    taskCount,
    toolCount: tools.size,
    hasRead,
    hasGraph,
    hasUnderstand,
    hasBuildSection,
    buildSectionCount,
    focusAreaCount,
    sectionCoverage: sectionsUsed.size
  };
}

async function runOne(scenarioKey, cfg) {
  const scenario = SCENARIOS[scenarioKey];
  // Build the same prompt the planner would send. We reach into the module to access internals.
  // Use the public plan() entry point but override modelOverride/thinkingDisabled via options.
  const start = Date.now();
  let lastError = null;
  let firstTokenAt = null;

  // Inject custom config by directly calling LLM with the planner system + user prompt.
  // We avoid calling planner.plan() to bypass domain-fallback short-circuit (we want pure LLM behavior).
  const planningContext = planner.compactPlanningContext(scenario.context);
  const userText = `Crea un piano di esecuzione per: "${scenario.objective}".\n\nContesto Excel attuale (compattato):\n${JSON.stringify(planningContext, null, 2)}`;

  let raw;
  try {
    raw = await callLLM({
      system: planner.PLANNER_SYSTEM_PROMPT,
      userText,
      timeoutMs: 600000,
      fallbackTimeoutMs: 300000,
      modelOverride: cfg.model,
      label: `bench ${scenarioKey}/${cfg.name}`,
      cachePrompt: true,
      thinkingDisabled: cfg.thinkingDisabled,
      reasoningEffort: cfg.reasoningEffort
    });
  } catch (err) {
    lastError = err.message;
  }
  const totalMs = Date.now() - start;
  const text = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? JSON.stringify(raw) : '');
  const parsed = typeof raw === 'object' && raw && !raw.jsonError ? raw : tryParseJson(text);
  const score = scoreOutput(parsed);
  return {
    scenario: scenarioKey,
    config: cfg.name,
    model: cfg.model,
    thinkingDisabled: cfg.thinkingDisabled,
    reasoningEffort: cfg.reasoningEffort,
    totalMs,
    outputLen: text.length,
    error: lastError,
    score
  };
}

async function main() {
  const scenariosArg = (process.argv[2] || 'dcf,lbo,data_analysis,forecasting').split(',').filter(s => SCENARIOS[s]);
  const runs = Number(process.argv[3]) || 1;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const outFile = path.join(__dirname, `plan-compare-${ts}.jsonl`);
  const fd = fs.createWriteStream(outFile, { flags: 'a' });

  console.log(`Bench: scenarios=[${scenariosArg.join(',')}] runs=${runs} configs=[${CONFIGS.map(c => c.name).join(', ')}]`);
  console.log(`Output: ${outFile}\n`);

  const results = [];
  for (const scen of scenariosArg) {
    for (const cfg of CONFIGS) {
      for (let r = 1; r <= runs; r++) {
        process.stdout.write(`  ${scen.padEnd(15)} ${cfg.name.padEnd(14)} run ${r}/${runs} ... `);
        const result = await runOne(scen, cfg);
        results.push(result);
        fd.write(JSON.stringify(result) + '\n');
        const score = result.score;
        const verdict = result.error ? `ERROR: ${result.error.slice(0, 80)}` :
          `${(result.totalMs / 1000).toFixed(1)}s, ${score.taskCount}tasks, ${result.outputLen}chars` +
          (score.buildSectionCount ? ` (${score.buildSectionCount} buildSection, ${score.focusAreaCount} focusArea)` : '');
        console.log(verdict);
      }
    }
    console.log('');
  }
  fd.end();

  // Summary
  console.log('--- SUMMARY ---');
  const byConfig = {};
  for (const r of results) {
    const k = r.config;
    if (!byConfig[k]) byConfig[k] = { count: 0, totalMs: 0, taskCount: 0, outputLen: 0, errors: 0, buildSection: 0, focusArea: 0 };
    byConfig[k].count++;
    byConfig[k].totalMs += r.totalMs;
    byConfig[k].taskCount += r.score.taskCount;
    byConfig[k].outputLen += r.outputLen;
    if (r.error) byConfig[k].errors++;
    byConfig[k].buildSection += r.score.buildSectionCount || 0;
    byConfig[k].focusArea += r.score.focusAreaCount || 0;
  }
  console.log('config           avgMs   avgTasks  avgChars  buildSec  focusArea  errors');
  for (const [name, s] of Object.entries(byConfig)) {
    const avgMs = Math.round(s.totalMs / s.count);
    const avgTasks = (s.taskCount / s.count).toFixed(1);
    const avgChars = Math.round(s.outputLen / s.count);
    const avgBuild = (s.buildSection / s.count).toFixed(1);
    const avgFocus = (s.focusArea / s.count).toFixed(1);
    console.log(`  ${name.padEnd(15)} ${String(avgMs).padStart(6)} ${avgTasks.padStart(9)} ${String(avgChars).padStart(9)} ${avgBuild.padStart(9)} ${avgFocus.padStart(10)} ${String(s.errors).padStart(7)}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
