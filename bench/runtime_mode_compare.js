#!/usr/bin/env node
/**
 * Runtime mode benchmark.
 *
 * Confronta lo stesso task eseguito come:
 * - planned_dag
 * - agent_loop (senza escalation automatica)
 *
 * Usage:
 *   node bench/runtime_mode_compare.js [runs=1] [scenarios=dcf_institutional,complex_model_repair] [modes=planned_dag,agent_loop]
 *
 * Output: bench/runtime-mode-compare-<timestamp>.jsonl + summary su stdout.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const turns = require('../server/runtime/turns');

const RUNS = Number(process.argv[2]) || 1;
const SCENARIO_KEYS = (process.argv[3] || 'dcf_institutional,complex_model_repair')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const MODE_KEYS = (process.argv[4] || 'planned_dag,agent_loop')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const TURN_TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS) || 12 * 60 * 1000;
const POLL_MS = Number(process.env.BENCH_POLL_MS) || 250;

process.env.AUTO_APPROVE_ALL = process.env.AUTO_APPROVE_ALL || 'true';
process.env.DISABLE_QUOTA = process.env.DISABLE_QUOTA || 'true';

const SCENARIOS = {
  dcf_institutional: {
    objective: 'Crea da zero un DCF istituzionale per Apple con assumptions complete, peer-based WACC, forecast a 5 anni, bridge EV to Equity, sensitivity table e note sulle fonti.',
    context: {
      activeSheet: 'Sheet1',
      workbookSheets: ['Sheet1'],
      sheets: [{ name: 'Sheet1', usedRange: { rowCount: 0, columnCount: 0 } }]
    },
    loopPromptVariant: 'default',
    maxIterations: 45
  },
  complex_model_repair: {
    objective: 'Continua e correggi il modello esistente su piu fogli: riallinea Assumptions, WACC, DCF e Sensitivity, ripara formule incoerenti e completa il bridge finale senza ricostruire tutto da zero.',
    context: {
      activeSheet: 'Sensitivity',
      workbookSheets: ['Summary', 'Assumptions', 'WACC', 'DCF', 'Sensitivity'],
      sheets: [
        { name: 'Summary', usedRange: { rowCount: 22, columnCount: 8 } },
        { name: 'Assumptions', usedRange: { rowCount: 34, columnCount: 6 } },
        { name: 'WACC', usedRange: { rowCount: 28, columnCount: 6 } },
        { name: 'DCF', usedRange: { rowCount: 41, columnCount: 12 } },
        { name: 'Sensitivity', usedRange: { rowCount: 18, columnCount: 7 } }
      ],
      allSheetsData: {
        Summary: {
          isActive: false,
          usedRange: 'Summary!A1:H22',
          rowCount: 22,
          columnCount: 8,
          preview: [
            ['Metric', '2024A', '2025E', '2026E', '2027E'],
            ['Revenue', 1200, 1320, 1452, 1568],
            ['EBITDA', 240, 278, 305, 329]
          ]
        },
        Assumptions: {
          isActive: false,
          usedRange: 'Assumptions!A1:F34',
          rowCount: 34,
          columnCount: 6,
          preview: [
            ['Driver', 'Value'],
            ['Revenue Growth 2025E', '10.0%'],
            ['Tax Rate', '27.0%']
          ]
        },
        WACC: {
          isActive: false,
          usedRange: 'WACC!A1:F28',
          rowCount: 28,
          columnCount: 6,
          preview: [
            ['Input', 'Value'],
            ['Risk Free Rate', '4.25%'],
            ['ERP', '5.00%']
          ]
        },
        DCF: {
          isActive: false,
          usedRange: 'DCF!A1:L41',
          rowCount: 41,
          columnCount: 12,
          preview: [
            ['Year', '2024A', '2025E', '2026E', '2027E'],
            ['Revenue', 1200, 1320, 1452, 1568],
            ['FCF', 120, 138, 152, 168]
          ]
        },
        Sensitivity: {
          isActive: true,
          usedRange: 'Sensitivity!A1:G18',
          rowCount: 18,
          columnCount: 7,
          preview: [
            ['WACC / g', '1.5%', '2.0%', '2.5%'],
            ['7.5%', 1820, 1910, 2015],
            ['8.0%', 1710, 1795, 1890]
          ]
        }
      }
    },
    loopPromptVariant: 'default',
    maxIterations: 45
  },
  lbo_tech_template: {
    objective: 'Crea da zero un template completo di LBO per una società tech (target: CrowdStrike Holdings, CRWD) di circa 1000 righe complessive sul workbook. Includi: Cover & Summary, Sources & Uses, Transaction Assumptions, Debt Schedule (Term Loan A/B + Revolver + Senior Notes), Operating Model 3-statement (IS, BS, CFS) per 5 anni di forecast, Free Cash Flow + Debt Paydown waterfall, Returns (MoM, IRR sponsor, IRR exit multiples), Sensitivity (entry multiple x exit multiple), Credit Stats (Total Leverage, Senior Leverage, Coverage), Sources notes. Usa named range per Assumptions chiave. Forecast 5 anni con scenari base/upside/downside.',
    context: {
      activeSheet: 'Sheet1',
      workbookSheets: ['Sheet1'],
      sheets: [{ name: 'Sheet1', usedRange: { rowCount: 0, columnCount: 0 } }]
    },
    loopPromptVariant: 'default',
    maxIterations: 80
  }
};

const MODES = {
  planned_dag: {
    label: 'Forced planned DAG'
  },
  agent_loop: {
    label: 'Forced agent loop'
  }
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildStrategy(mode, scenarioKey) {
  const scenario = SCENARIOS[scenarioKey];
  if (mode === 'planned_dag') {
    return {
      mode: 'planned_dag',
      label: 'Forced planned DAG',
      reason: `benchmark_forced_planned:${scenarioKey}`,
      promptVariant: 'default',
      allowEscalation: false
    };
  }

  return {
    mode: 'agent_loop',
    label: 'Forced agent loop',
    reason: `benchmark_forced_agent_loop:${scenarioKey}`,
    promptVariant: scenario.loopPromptVariant || 'default',
    allowEscalation: false,
    fallbackMode: null,
    maxIterations: scenario.maxIterations || 45
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildQuestionResponse(request) {
  const questions = Array.isArray(request.questions) ? request.questions : [];
  const answers = questions.map(question => {
    const options = Array.isArray(question?.options) ? question.options : [];
    return options[0]?.label || question?.defaultValue || '';
  });
  return { values: { answers } };
}

function buildUserInputResponse(request) {
  const values = {};
  for (const field of Array.isArray(request.fields) ? request.fields : []) {
    const key = field?.key || field?.name;
    if (!key) continue;
    values[key] = field.defaultValue || field.value || '';
  }
  return { values };
}

function buildReadResponse(request, scenario) {
  const params = request.params || {};
  const allSheetsData = scenario.context.allSheetsData || {};
  const workbookSheets = scenario.context.workbookSheets || Object.keys(allSheetsData);
  const activeSheet = scenario.context.activeSheet || workbookSheets[0] || 'Sheet1';
  const sheetName = params.sheet || params.sheetName || activeSheet;
  const sheetData = allSheetsData[sheetName] || {
    isActive: sheetName === activeSheet,
    usedRange: `${sheetName}!A1:D10`,
    rowCount: 10,
    columnCount: 4,
    preview: []
  };

  if (request.toolName === 'workbook.readWorkbook') {
    return {
      data: {
        activeSheet,
        workbookSheets,
        allSheetsData: clone(allSheetsData)
      }
    };
  }

  if (request.toolName === 'workbook.readSheet') {
    return {
      data: {
        sheetName,
        ...clone(sheetData)
      }
    };
  }

  if (request.toolName === 'workbook.readRange') {
    return {
      data: {
        sheetName,
        target: params.target || params.range || sheetData.usedRange || `${sheetName}!A1:D10`,
        values: clone(sheetData.preview || []),
        formulas: [],
        cellCount: Array.isArray(sheetData.preview) ? sheetData.preview.length * (Array.isArray(sheetData.preview[0]) ? sheetData.preview[0].length : 1) : 0,
        format: params.format || 'snapshot'
      }
    };
  }

  if (request.toolName === 'workbook.listNamedRanges') {
    return {
      data: scenario.namedRanges || []
    };
  }

  return {
    data: {
      ok: true,
      _bench_stub: true,
      values: [],
      formulas: [],
      cellCount: 0
    }
  };
}

function summarizeTurn(turn, extra = {}) {
  const taskItems = (turn.items || []).filter(item => item.type === 'taskExecution');
  const resultEntries = Object.entries(turn.results || {}).filter(([taskId]) => !taskId.startsWith('__'));
  const totalActions = resultEntries.reduce((sum, [, result]) => {
    return sum + (Array.isArray(result?.actions) ? result.actions.length : 0);
  }, 0);

  let loopIteration = null;
  for (const [, result] of resultEntries) {
    if (result?.data?.builder === 'agent-loop' && Number.isFinite(result?.data?.iteration)) {
      loopIteration = result.data.iteration;
      break;
    }
  }

  return {
    status: turn.status,
    error: turn.error || null,
    planTaskCount: Array.isArray(turn.plan?.tasks) ? turn.plan.tasks.length : 0,
    completedTaskCount: taskItems.filter(item => item.status === 'completed').length,
    erroredTaskCount: taskItems.filter(item => item.status === 'error').length,
    totalActions,
    resultCount: resultEntries.length,
    loopIteration,
    strategy: turn.strategy || null,
    narration: turn.narration?.message || null,
    ...extra
  };
}

async function runOne(scenarioKey, mode) {
  const scenario = SCENARIOS[scenarioKey];
  const startedAt = Date.now();
  const requestCounters = {
    clientTool: 0,
    permission: 0,
    question: 0,
    userInput: 0
  };
  const handledRequestIds = new Set();
  let planningDoneAt = null;
  let approvedAt = null;

  const turn = turns.startTurn(
    scenario.objective,
    clone(scenario.context),
    null,
    { strategy: buildStrategy(mode, scenarioKey) }
  );

  while (true) {
    const liveTurn = turns.loadTurn(turn.id);
    if (!liveTurn) {
      throw new Error(`Turn non trovato durante il benchmark: ${turn.id}`);
    }

    if (!planningDoneAt && liveTurn.status !== 'planning') {
      planningDoneAt = Date.now();
    }

    if (liveTurn.status === 'awaiting_approval') {
      turns.approveTurn(turn.id);
      approvedAt = approvedAt || Date.now();
    }

    for (const request of liveTurn.pendingRequests || []) {
      if (!request?.id || handledRequestIds.has(request.id)) continue;
      handledRequestIds.add(request.id);

      let response;
      if (request.type === 'clientTool') {
        requestCounters.clientTool += 1;
        response = buildReadResponse(request, scenario);
      } else if (request.type === 'permission') {
        requestCounters.permission += 1;
        response = { approved: true };
      } else if (request.type === 'question') {
        requestCounters.question += 1;
        response = buildQuestionResponse(request);
      } else if (request.type === 'userInput') {
        requestCounters.userInput += 1;
        response = buildUserInputResponse(request);
      } else {
        response = { error: `Unsupported bench request type: ${request.type}` };
      }

      turns.respondToTurnRequest(turn.id, request.id, response);
    }

    if (liveTurn.status === 'completed' || liveTurn.status === 'error') {
      const finishedAt = Date.now();
      return {
        scenario: scenarioKey,
        mode,
        totalMs: finishedAt - startedAt,
        planningMs: planningDoneAt ? planningDoneAt - startedAt : null,
        executionMs: planningDoneAt ? finishedAt - planningDoneAt : null,
        approvalWaitMs: approvedAt && planningDoneAt ? approvedAt - planningDoneAt : 0,
        requestCounters,
        ...summarizeTurn(liveTurn)
      };
    }

    if (Date.now() - startedAt > TURN_TIMEOUT_MS) {
      const snapshot = turns.loadTurn(turn.id);
      return {
        scenario: scenarioKey,
        mode,
        totalMs: Date.now() - startedAt,
        planningMs: planningDoneAt ? planningDoneAt - startedAt : null,
        executionMs: planningDoneAt ? Date.now() - planningDoneAt : null,
        requestCounters,
        ...summarizeTurn(snapshot || { status: 'error', items: [], results: {} }, {
          status: 'error',
          error: `benchmark timeout after ${TURN_TIMEOUT_MS}ms`
        })
      };
    }

    await sleep(POLL_MS);
  }
}

function pct(values, percentile) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.floor((sorted.length - 1) * percentile);
  return sorted[index];
}

async function main() {
  const scenarios = SCENARIO_KEYS.filter(key => SCENARIOS[key]);
  const modes = MODE_KEYS.filter(key => MODES[key]);
  if (scenarios.length === 0) throw new Error('Nessuno scenario valido specificato.');
  if (modes.length === 0) throw new Error('Nessun mode valido specificato.');

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const outFile = path.join(__dirname, `runtime-mode-compare-${ts}.jsonl`);
  const out = fs.createWriteStream(outFile, { flags: 'a' });
  const results = [];

  console.log(`Runtime bench: scenarios=[${scenarios.join(',')}] modes=[${modes.join(',')}] runs=${RUNS}`);
  console.log(`Timeout per turn: ${TURN_TIMEOUT_MS}ms`);
  console.log(`Output: ${outFile}\n`);

  for (const scenarioKey of scenarios) {
    for (const mode of modes) {
      for (let run = 1; run <= RUNS; run += 1) {
        process.stdout.write(`  ${scenarioKey.padEnd(22)} ${mode.padEnd(12)} run ${run}/${RUNS} ... `);
        const result = await runOne(scenarioKey, mode);
        results.push(result);
        out.write(JSON.stringify(result) + '\n');
        const verdict = result.error
          ? `ERROR ${result.totalMs}ms  tasks=${result.completedTaskCount}/${result.planTaskCount}  err=${result.error.slice(0, 90)}`
          : `${result.totalMs}ms  plan=${result.planningMs || '-'}ms  exec=${result.executionMs || '-'}ms  tasks=${result.completedTaskCount}/${result.planTaskCount}  actions=${result.totalActions}  loopIter=${result.loopIteration || '-'}`;
        console.log(verdict);
      }
    }
    console.log('');
  }

  out.end();

  console.log('--- SUMMARY ---');
  console.log('scenario                mode          ok/total   meanMs   p50Ms   p95Ms   meanPlan   meanExec   meanTasks   meanActions   meanLoopIter');
  for (const scenarioKey of scenarios) {
    for (const mode of modes) {
      const bucket = results.filter(result => result.scenario === scenarioKey && result.mode === mode);
      if (bucket.length === 0) continue;
      const ok = bucket.filter(result => !result.error && result.status === 'completed');
      const latencies = bucket.map(result => result.totalMs);
      const planMs = ok.map(result => result.planningMs).filter(Number.isFinite);
      const execMs = ok.map(result => result.executionMs).filter(Number.isFinite);
      const tasks = ok.map(result => result.completedTaskCount);
      const actions = ok.map(result => result.totalActions);
      const loopIterations = ok.map(result => result.loopIteration).filter(Number.isFinite);
      const mean = list => list.length > 0
        ? Math.round(list.reduce((sum, value) => sum + value, 0) / list.length)
        : 0;

      console.log(
        `  ${scenarioKey.padEnd(22)} ${mode.padEnd(12)} ${`${ok.length}/${bucket.length}`.padEnd(8)} ${String(mean(latencies)).padStart(8)} ${String(pct(latencies, 0.5)).padStart(7)} ${String(pct(latencies, 0.95)).padStart(7)} ${String(mean(planMs)).padStart(10)} ${String(mean(execMs)).padStart(10)} ${String(mean(tasks)).padStart(10)} ${String(mean(actions)).padStart(12)} ${String(mean(loopIterations)).padStart(13)}`
      );
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
