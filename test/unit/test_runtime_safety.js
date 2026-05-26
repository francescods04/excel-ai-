const assert = require('assert');
const {
  LIMITS,
  assertPlanWithinLimits,
  assertActionBatchWithinLimits,
  allSettledLimit
} = require('../../server/runtime/safetyLimits');
const { chooseTurnStrategy } = require('../../server/runtime/turns');

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
