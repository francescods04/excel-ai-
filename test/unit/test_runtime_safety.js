const assert = require('assert');
const {
  LIMITS,
  assertPlanWithinLimits,
  assertActionBatchWithinLimits,
  allSettledLimit
} = require('../../server/runtime/safetyLimits');

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
