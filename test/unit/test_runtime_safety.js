const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  LIMITS,
  assertPlanWithinLimits,
  assertActionBatchWithinLimits,
  allSettledLimit,
  estimateActionBatchCells
} = require('../../server/runtime/safetyLimits');
const { chooseTurnStrategy, resolvePlannerModelOverride } = require('../../server/runtime/turns');
const {
  buildToolStagnationSignature,
  detectToolStagnation,
  formatToolStagnationReason,
  resolveAgentLoopModel
} = require('../../server/agents/agentLoop');

async function test(name, fn) {
  try {
    await fn();
    console.log(`OK ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function probeAgentThinkingWithEnv(env) {
  const agentLoopPath = path.join(__dirname, '../../server/agents/agentLoop');
  const script = `
    const { shouldUseAgentThinking } = require(${JSON.stringify(agentLoopPath)});
    const values = [
      shouldUseAgentThinking(1, {}),
      shouldUseAgentThinking(2, {}),
      shouldUseAgentThinking(6, {}),
      shouldUseAgentThinking(3, { forceThinkingNext: true }),
      shouldUseAgentThinking(3, { consecutiveErrors: 1 }),
      shouldUseAgentThinking(4, { parseFailureStreak: 1 }),
      shouldUseAgentThinking(4, { lastToolName: 'todo_write' })
    ];
    console.log('__AGENT_THINKING__' + JSON.stringify(values));
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '../..'),
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  assert.strictEqual(child.status, 0, child.stderr || child.stdout);
  const line = child.stdout.trim().split(/\n/).find(output => output.startsWith('__AGENT_THINKING__'));
  assert.ok(line, child.stdout);
  return JSON.parse(line.slice('__AGENT_THINKING__'.length));
}

async function main() {
  await test('allSettledLimit preserves order and caps concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    const results = await allSettledLimit([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return value * 2;
    });

    assert.deepStrictEqual(results.map(result => result.value), [2, 4, 6, 8, 10]);
    assert.ok(maxActive <= 2);
  });

  await test('plan safety rejects excessive task graphs', () => {
    const tasks = Array.from({ length: LIMITS.maxPlanTasks + 1 }, (_, index) => ({
      id: `t${index + 1}`,
      tool: 'workbook.readWorkbook',
      description: 'read',
      deps: []
    }));
    assert.throws(() => assertPlanWithinLimits({ tasks }), /Piano troppo grande/);
  });

  await test('action safety rejects excessive Excel action batches', () => {
    const actions = Array.from({ length: LIMITS.maxActionsPerTask + 1 }, (_, index) => ({
      type: 'setCellValue',
      sheet: 'Sheet1',
      target: `A${index + 1}`,
      value: index
    }));
    assert.throws(() => assertActionBatchWithinLimits(actions, { id: 't9' }), /troppe azioni Excel/);
  });

  await test('action safety rejects excessive write cell volume', () => {
    const cells = {};
    for (let i = 0; i < LIMITS.maxActionCellsPerBatch + 1; i++) {
      cells[`A${i + 1}`] = { value: i };
    }
    const actions = [{ type: 'setCellRange', sheet: 'Sheet1', cells }];
    assert.strictEqual(estimateActionBatchCells(actions), LIMITS.maxActionCellsPerBatch + 1);
    assert.throws(() => assertActionBatchWithinLimits(actions, { id: 't10' }), /troppe celle Excel/);
  });

  await test('action safety counts format target cell volume', () => {
    const actions = [{ type: 'setCellFormat', sheet: 'Sheet1', target: `A1:A${LIMITS.maxActionCellsPerBatch + 1}`, options: { bold: true } }];
    assert.strictEqual(estimateActionBatchCells(actions), LIMITS.maxActionCellsPerBatch + 1);
    assert.throws(() => assertActionBatchWithinLimits(actions, { id: 't11' }), /troppe celle Excel/);
  });

  await test('turn router prefers fast agent loop for local workbook continuation', () => {
    const strategy = chooseTurnStrategy('analizza questo excel e completalo', {
      activeSheet: 'DCF',
      selectedRange: 'DCF!T48',
      workbookSheets: ['DCF'],
      allSheetsData: {
        DCF: { usedRange: 'A1:L39', rowCount: 39, columnCount: 12 }
      }
    });

    assert.strictEqual(strategy.mode, 'agent_loop');
    assert.strictEqual(strategy.promptVariant, 'fast');
    assert.strictEqual(strategy.allowEscalation, true);
  });

  await test('turn router keeps full public-company builds on deep planner path', () => {
    const strategy = chooseTurnStrategy('voglio fare un DCF di Apple da zero con WACC, sensitivity e fonti', {
      activeSheet: 'Sheet1',
      workbookSheets: ['Sheet1']
    });

    assert.strictEqual(strategy.mode, 'planned_dag');
    assert.strictEqual(strategy.allowEscalation, false);
  });

  await test('turn router uses structured agent loop for continuity edits on multi-sheet models', () => {
    const strategy = chooseTurnStrategy('continua questo modello e correggi la sensitivity', {
      activeSheet: 'Sensitivity',
      workbookSheets: ['Summary', 'Assumptions', 'WACC', 'DCF', 'Sensitivity'],
      allSheetsData: {
        Summary: { usedRange: 'A1:H20' },
        Assumptions: { usedRange: 'A1:F30' },
        WACC: { usedRange: 'A1:F25' },
        DCF: { usedRange: 'A1:L40' },
        Sensitivity: { usedRange: 'A1:G18' }
      }
    }, 'parent-turn-1');

    assert.strictEqual(strategy.mode, 'agent_loop');
    assert.strictEqual(strategy.promptVariant, 'default');
    assert.strictEqual(strategy.reason, 'continuity_incremental_edit');
  });

  await test('planner override ignores generic execution model override unless explicitly set', () => {
    assert.strictEqual(resolvePlannerModelOverride({
      llm: { modelOverride: 'deepseek-v4-pro' }
    }), undefined);

    assert.strictEqual(resolvePlannerModelOverride({
      llm: {
        modelOverride: 'deepseek-v4-pro',
        plannerModelOverride: 'deepseek-v4-flash'
      }
    }), 'deepseek-v4-flash');
  });

  await test('agent loop stagnation guard catches identical repeated read tool calls', () => {
    const signature = buildToolStagnationSignature('get_cell_ranges', {
      ranges: [{ sheet: 'DCF', target: 'B5:E12' }]
    });
    const trail = Array.from({ length: 4 }, (_, index) => ({
      iteration: index + 1,
      toolName: 'get_cell_ranges',
      signature
    }));

    const stagnation = detectToolStagnation(trail, 4, 3);
    assert.ok(stagnation);
    assert.strictEqual(stagnation.pattern, 'repeat');
    assert.match(formatToolStagnationReason(stagnation), /stagnation_repeat:get_cell_ranges:x4/);
  });

  await test('agent loop stagnation guard catches alternating read-write loops', () => {
    const readEntry = {
      toolName: 'get_cell_ranges',
      signature: buildToolStagnationSignature('get_cell_ranges', {
        ranges: [{ sheet: 'DCF', target: 'F10:H18' }]
      })
    };
    const writeEntry = {
      toolName: 'execute_office_js',
      signature: buildToolStagnationSignature('execute_office_js', {
        code: 'await Excel.run(async (context) => { /* repeated fix */ });'
      })
    };
    const trail = [
      readEntry,
      writeEntry,
      readEntry,
      writeEntry,
      readEntry,
      writeEntry
    ].map((entry, index) => ({
      iteration: index + 1,
      toolName: entry.toolName,
      signature: entry.signature
    }));

    const stagnation = detectToolStagnation(trail, 4, 3);
    assert.ok(stagnation);
    assert.strictEqual(stagnation.pattern, 'alternating');
    assert.match(formatToolStagnationReason(stagnation), /stagnation_cycle:get_cell_ranges->execute_office_js:x3/);
  });

  await test('agent loop defaults to flash routing unless explicitly overridden', () => {
    assert.strictEqual(resolveAgentLoopModel(undefined, 'fast'), 'deepseek-v4-flash');
    assert.strictEqual(resolveAgentLoopModel(undefined, 'default'), 'deepseek-v4-flash');
    assert.strictEqual(resolveAgentLoopModel('deepseek-v4-pro', 'fast'), 'deepseek-v4-pro');
  });

  await test('agent loop thinking defaults off except explicit forced next step', () => {
    assert.deepStrictEqual(probeAgentThinkingWithEnv({
      AGENT_THINKING_FIRST_ITER: 'false',
      AGENT_THINKING_INTERVAL: '0',
      AGENT_FORCE_THINKING_AFTER_ERROR: 'false',
      AGENT_THINKING_EVERY_ITER: 'false'
    }), [false, false, false, true, false, false, false]);
  });

  await test('agent loop thinking env knobs enable first step, interval, and recovery triggers', () => {
    assert.deepStrictEqual(probeAgentThinkingWithEnv({
      AGENT_THINKING_FIRST_ITER: 'true',
      AGENT_THINKING_INTERVAL: '6',
      AGENT_FORCE_THINKING_AFTER_ERROR: 'true',
      AGENT_THINKING_EVERY_ITER: 'false'
    }), [true, false, true, true, true, true, false]);
  });
}

process.on('exit', () => {
  if (process.exitCode) {
    console.error('\nRuntime safety tests failed.');
  } else {
    console.log('\nRuntime safety tests completed.');
  }
});

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
