const assert = require('assert');
const planner = require('../../server/agents/planner');
const { buildDcfSection, inferDcfInputs } = require('../../server/models/dcfTemplate');
const { inferEquityIntent } = require('../../server/utils/equityIntent');

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

const mockMemory = {
  results: {
    t2: {
      data: {
        symbol: 'AAPL',
        longName: 'Apple Inc.',
        regularMarketPrice: 210,
        marketCap: 3150000000000
      },
      actions: []
    },
    t3: {
      data: {
        financialData: {
          totalRevenue: 391035000000,
          ebitda: 134661000000,
          totalCash: 65171000000,
          totalDebt: 106629000000
        },
        defaultKeyStatistics: {
          sharesOutstanding: 15022100000,
          beta: 1.18
        }
      },
      actions: []
    }
  }
};

async function main() {
  await test('equity intent resolves natural-language Apple DCF', () => {
    const intent = inferEquityIntent('voglio fare un dcf di apple');
    assert.strictEqual(intent.model, 'dcf');
    assert.strictEqual(intent.ticker, 'AAPL');
    assert.strictEqual(intent.hasBuildIntent, true);
  });

  await test('planner turns Apple DCF into full deterministic backend pipeline', async () => {
    const plan = await planner.plan('voglio fare un dcf di apple', {
      activeSheet: 'Sheet1',
      workbookSheets: ['Sheet1']
    });

    const tools = plan.tasks.map(task => task.tool);
    assert.ok(tools.includes('workbook.readWorkbook'));
    assert.ok(tools.includes('yahoo.quote'));
    assert.ok(tools.includes('yahoo.fundamentals'));

    const dcfSections = plan.tasks
      .filter(task => task.tool === 'finance.dcf.buildSection')
      .map(task => task.params.section);
    assert.deepStrictEqual(dcfSections, ['shell', 'assumptions', 'wacc', 'dcf', 'sensitivity', 'format']);

    const shellTask = plan.tasks.find(task => task.params.section === 'shell');
    assert.strictEqual(shellTask.params.ticker, 'AAPL');
    assert.ok(shellTask.deps.includes('t1'));
    assert.ok(shellTask.deps.some(dep => plan.tasks.find(task => task.id === dep)?.tool === 'yahoo.quote'));
  });

  await test('DCF template derives assumptions from market data', () => {
    const inputs = inferDcfInputs({ ticker: 'AAPL', companyName: 'Apple Inc.' }, mockMemory);
    assert.strictEqual(inputs.ticker, 'AAPL');
    assert.strictEqual(inputs.companyName, 'Apple Inc.');
    assert.ok(inputs.baseRevenueMillions > 390000);
    assert.ok(inputs.ebitdaMargin > 0.30 && inputs.ebitdaMargin < 0.40);
    assert.ok(inputs.sharesMillions > 15000);
  });

  await test('DCF template creates formulas for valuation and sensitivity', () => {
    const dcf = buildDcfSection({ section: 'dcf', ticker: 'AAPL', companyName: 'Apple Inc.' }, mockMemory);
    assert.strictEqual(dcf.actions.length, 1);
    const dcfCells = dcf.actions[0].cells;
    assert.strictEqual(dcf.actions[0].sheet, 'DCF');
    assert.strictEqual(dcfCells.A5.value, 'Revenue ($M)');
    assert.strictEqual(dcfCells.H30.formula, '=SUM(C24:G24)+H28');
    assert.strictEqual(dcfCells.H35.formula, '=H33/H34');

    const sensitivity = buildDcfSection({ section: 'sensitivity', ticker: 'AAPL', companyName: 'Apple Inc.' }, mockMemory);
    const sensCells = sensitivity.actions[0].cells;
    assert.ok(sensCells.C5.formula.includes('DCF!$G$20'));
    assert.ok(sensCells.G18.formula.includes('SUM(DCF!$C$24:$G$24)'));
  });
}

process.on('exit', () => {
  if (process.exitCode) {
    console.error('\nDCF backend tests failed.');
  } else {
    console.log('\nDCF backend tests completed.');
  }
});

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
