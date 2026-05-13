const assert = require('assert');
const planner = require('../../server/agents/planner');
const { buildDcfSection, inferDcfInputs } = require('../../server/models/dcfTemplate');
const { buildDcfSectionAi, normalizeActions, validateDcfSectionContract } = require('../../server/models/dcfAiBuilder');
const { buildProfessionalFormatPlan } = require('../../server/models/formatTemplate');
const { validateFormula, validateTaskOutput } = require('../../server/agents/critic');
const { inferEquityIntent } = require('../../server/utils/equityIntent');
const { executeTool } = require('../../server/tools/registry');

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

  await test('equity intent treats complete DCF typo nvdia as NVIDIA build', () => {
    const intent = inferEquityIntent('completa un dcf su nvdia');
    assert.strictEqual(intent.model, 'dcf');
    assert.strictEqual(intent.ticker, 'NVDA');
    assert.strictEqual(intent.companyName, 'NVIDIA Corporation');
    assert.strictEqual(intent.hasBuildIntent, true);
  });

  await test('planner turns Apple DCF into full AI-assisted backend pipeline', async () => {
    const plan = await planner.plan('voglio fare un dcf di apple', {
      activeSheet: 'Sheet1',
      workbookSheets: ['Sheet1']
    });

    const tools = plan.tasks.map(task => task.tool);
    assert.ok(tools.includes('workbook.readWorkbook'));
    assert.ok(tools.includes('workbook.buildGraph'));
    assert.ok(tools.includes('yahoo.quote'));
    assert.ok(tools.includes('yahoo.fundamentals'));
    assert.ok(tools.includes('yahoo.historical'));
    assert.ok(plan.tasks.length >= 13);

    const dcfSections = plan.tasks
      .filter(task => task.tool === 'finance.dcf.buildSection')
      .map(task => task.params.section);
    assert.deepStrictEqual(dcfSections, ['shell', 'sources', 'assumptions', 'wacc', 'dcf', 'sensitivity', 'scenarios', 'summary', 'audit', 'format']);
    plan.tasks
      .filter(task => task.tool === 'finance.dcf.buildSection')
      .forEach(task => assert.strictEqual(task.params.mode, 'ai_assisted'));

    const shellTask = plan.tasks.find(task => task.params.section === 'shell');
    assert.strictEqual(shellTask.params.ticker, 'AAPL');
    assert.ok(shellTask.deps.includes('t1'));
    assert.ok(shellTask.deps.some(dep => plan.tasks.find(task => task.id === dep)?.tool === 'workbook.buildGraph'));
    assert.ok(shellTask.deps.some(dep => plan.tasks.find(task => task.id === dep)?.tool === 'yahoo.quote'));
  });

  await test('planner repairs existing incomplete DCF without generic full_model_review LLM', async () => {
    const plan = await planner.plan('completa il dcf ci sono ancora un sacco di problemi', {
      activeSheet: 'Sensitivity',
      workbookSheets: ['Sheet1', 'Assumptions', 'WACC', 'DCF', 'Sensitivity'],
      allSheetsData: {
        Assumptions: {
          isActive: false,
          usedRange: 'Assumptions!A1:B10',
          preview: [
            ['Company', 'Apple Inc.'],
            ['Ticker', 'AAPL'],
            ['Base Revenue ($M)', 100000]
          ]
        }
      }
    });

    assert.ok(plan.tasks.some(task => task.tool === 'yahoo.quote' && task.params.ticker === 'AAPL'));
    assert.ok(plan.tasks.some(task => task.tool === 'workbook.buildGraph'));
    assert.ok(!plan.tasks.some(task => task.tool === 'llm.writeFormulas' && task.params.section === 'full_model_review'));
    const dcfTasks = plan.tasks.filter(task => task.tool === 'finance.dcf.buildSection');
    assert.deepStrictEqual(dcfTasks.map(task => task.params.section), ['shell', 'sources', 'assumptions', 'wacc', 'dcf', 'sensitivity', 'scenarios', 'summary', 'audit', 'format']);
    dcfTasks.forEach(task => assert.strictEqual(task.params.mode, 'template'));
  });

  await test('planner builds full DCF for complete request on empty workbook', async () => {
    const plan = await planner.plan('completa un dcf su nvdia', {
      activeSheet: 'Sheet1',
      workbookSheets: ['Sheet1'],
      allSheetsData: {
        Sheet1: { isActive: true, empty: true, preview: [] }
      }
    });

    assert.ok(plan.tasks.some(task => task.tool === 'yahoo.quote' && task.params.ticker === 'NVDA'));
    assert.ok(plan.tasks.some(task => task.tool === 'yahoo.fundamentals' && task.params.ticker === 'NVDA'));
    assert.ok(plan.tasks.some(task => task.tool === 'yahoo.historical' && task.params.ticker === 'NVDA'));
    assert.ok(!plan.tasks.some(task => task.tool === 'llm.writeFormulas' && task.params.section === 'full_model_review'));
    const dcfSections = plan.tasks
      .filter(task => task.tool === 'finance.dcf.buildSection')
      .map(task => task.params.section);
    assert.deepStrictEqual(dcfSections, ['shell', 'sources', 'assumptions', 'wacc', 'dcf', 'sensitivity', 'scenarios', 'summary', 'audit', 'format']);
  });

  await test('planner uses domain playbook immediately for DCF turn runtime', async () => {
    const plan = await planner.plan('crea un dcf per nvdia', {
      activeSheet: 'Sheet1',
      workbookSheets: ['Sheet1']
    }, 'turn-test-dcf');

    assert.ok(plan.tasks.some(task => task.tool === 'yahoo.quote' && task.params.ticker === 'NVDA'));
    assert.ok(plan.tasks.some(task => task.tool === 'finance.dcf.buildSection' && task.params.section === 'audit'));
    assert.ok(!plan.tasks.some(task => task.tool === 'llm.writeFormulas' && task.params.section === 'full_model_review'));
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

  await test('DCF template creates source, scenario, summary and audit layers', () => {
    const shell = buildDcfSection({ section: 'shell', ticker: 'AAPL', companyName: 'Apple Inc.' }, mockMemory);
    const createdSheets = shell.actions.filter(action => action.type === 'createSheet').map(action => action.sheet || action.name);
    ['Summary', 'Sources', 'Assumptions', 'WACC', 'DCF', 'Sensitivity', 'Scenarios', 'Audit']
      .forEach(sheet => assert.ok(createdSheets.includes(sheet), `${sheet} should be created by shell`));

    const sources = buildDcfSection({ section: 'sources', ticker: 'AAPL', companyName: 'Apple Inc.' }, mockMemory);
    assert.strictEqual(sources.actions[0].sheet, 'Sources');
    assert.strictEqual(sources.actions[0].cells.B24.formula, '=Assumptions!$B$10');

    const scenarios = buildDcfSection({ section: 'scenarios', ticker: 'AAPL', companyName: 'Apple Inc.' }, mockMemory);
    assert.strictEqual(scenarios.actions[0].sheet, 'Scenarios');
    assert.ok(scenarios.actions[0].cells.F5.formula.includes('DCF!$G$20'));

    const summary = buildDcfSection({ section: 'summary', ticker: 'AAPL', companyName: 'Apple Inc.' }, mockMemory);
    assert.strictEqual(summary.actions[0].sheet, 'Summary');
    assert.strictEqual(summary.actions[0].cells.B7.formula, '=DCF!$H$35');

    const audit = buildDcfSection({ section: 'audit', ticker: 'AAPL', companyName: 'Apple Inc.' }, mockMemory);
    assert.strictEqual(audit.actions[0].sheet, 'Audit');
    assert.ok(audit.actions[0].cells.B17.formula.includes('COUNTIF'));
  });

  await test('professional formatter builds workbook-wide red finance styling without LLM', () => {
    const memory = {
      results: {
        t1: {
          data: {
            activeSheet: 'Sensitivity',
            workbookSheets: ['Summary', 'Sources', 'Assumptions', 'WACC', 'DCF', 'Sensitivity', 'Scenarios', 'Audit'],
            sheets: [
              { name: 'Summary', usedRange: 'Summary!A1:C29', rowCount: 29, columnCount: 3, preview: [['Apple Inc. - Summary'], [], ['Executive Valuation Output'], ['Metric', 'Value', 'Source']] },
              { name: 'Assumptions', usedRange: 'Assumptions!A1:B37', rowCount: 37, columnCount: 2, preview: [['Apple Inc. - Assumptions'], [], ['Company & Source'], ['Company', 'Apple Inc.']] },
              { name: 'DCF', usedRange: 'DCF!A1:H40', rowCount: 40, columnCount: 8, preview: [['Apple Inc. - DCF'], ['Metric', '2025A', '2026E']] },
              { name: 'Sensitivity', usedRange: 'Sensitivity!A1:G18', rowCount: 18, columnCount: 7, preview: [['Sensitivity Analysis'], [], ['Implied Share Price Sensitivity'], ['WACC \\ g', 0.015, 0.02]] },
              { name: 'Scenarios', usedRange: 'Scenarios!A1:G17', rowCount: 17, columnCount: 7, preview: [['Scenario Analysis'], [], ['Operating Case Matrix'], ['Scenario', 'Revenue Haircut / Uplift']] },
              { name: 'Audit', usedRange: 'Audit!A1:C23', rowCount: 23, columnCount: 3, preview: [['Model Audit & QA'], [], ['Readiness Checks'], ['Check', 'Result', 'Why It Matters']] }
            ]
          }
        }
      }
    };
    const plan = buildProfessionalFormatPlan({
      sheet: 'Sensitivity',
      objective: 'cambia la formattazione fallo sui colori del rosso ma in modalità professionale',
      scope: 'workbook'
    }, memory);

    assert.strictEqual(plan.data.builder, 'deterministic-format');
    assert.strictEqual(plan.data.theme, 'red');
    assert.ok(plan.actions.length > 45);
    assert.ok(plan.actions.some(action => action.sheet === 'Summary' && action.target === 'A1:C1' && action.options.backgroundColor === '#7F1D1D'));
    assert.ok(plan.actions.some(action => action.sheet === 'Sensitivity' && action.type === 'addConditionalFormat' && action.target === 'C5:G9'));
  });

  await test('format plan task is non-mutating and applyFormat applies planned actions once', async () => {
    const memory = {
      results: {
        t1: {
          data: {
            activeSheet: 'Sensitivity',
            sheets: [
              { name: 'Sensitivity', usedRange: 'Sensitivity!A1:G18', rowCount: 18, columnCount: 7, preview: [['Sensitivity Analysis'], [], ['Implied Share Price Sensitivity'], ['WACC \\ g', 0.015, 0.02]] }
            ]
          }
        }
      }
    };
    const planned = await executeTool('llm.planFormat', {
      sheet: 'Sensitivity',
      objective: 'formatta in rosso professionale',
      scope: 'workbook',
      usesResults: ['t1']
    }, memory);
    assert.strictEqual(planned.actions.length, 0);
    assert.ok(planned.data.actions.length > 10);

    memory.results.t2 = planned;
    const applied = await executeTool('excel.applyFormat', { fromResult: 't2', sheet: 'Sensitivity' }, memory);
    assert.strictEqual(applied.actions.length, planned.data.actions.length);
  });

  await test('critic validates DCF cross-sheet formulas without regex crash', () => {
    const formula = '=SUM(DCF!$C$24:$G$24)+Assumptions!$B$33-WACC!$B$19';
    const result = validateFormula(formula, {
      sheets: ['Assumptions', 'WACC', 'DCF', 'Sensitivity'],
      references: new Set()
    });
    assert.strictEqual(result.ok, true);
    assert.ok(result.refs.includes('DCF!$C$24:$G$24'));
    assert.ok(result.refs.includes('Assumptions!$B$33'));
    assert.ok(result.refs.includes('WACC!$B$19'));
  });

  await test('critic accepts every deterministic DCF section before Excel execution', () => {
    const layout = {
      sheets: ['Assumptions', 'WACC', 'DCF', 'Sensitivity'],
      references: new Set()
    };
    for (const section of ['assumptions', 'wacc', 'dcf', 'sensitivity']) {
      const output = buildDcfSection({ section, ticker: 'AAPL', companyName: 'Apple Inc.' }, mockMemory);
      const critic = validateTaskOutput(output, layout);
      assert.strictEqual(critic.ok, true, `${section}: ${JSON.stringify(critic.errors)}`);
      assert.ok(critic.stats.formulaCount > 0, `${section} should expose formulas in stats`);
      assert.ok(critic.stats.mutationCount > 0, `${section} should expose mutations in stats`);
    }
  });

  await test('AI DCF action normalizer preserves formula semantics and strips fragile notes', () => {
    const actions = normalizeActions([
      {
        type: 'setCellRange',
        cells: {
          A1: { value: 'Metric' },
          B1: { value: '=Assumptions!$B$10', note: 'Source note that must not abort Excel writes' }
        }
      }
    ], 'DCF');

    assert.strictEqual(actions.length, 1);
    assert.strictEqual(actions[0].sheet, 'DCF');
    assert.strictEqual(actions[0].cells.A1.value, 'Metric');
    assert.strictEqual(actions[0].cells.B1.formula, '=Assumptions!$B$10');
    assert.strictEqual(actions[0].cells.B1.value, undefined);
    assert.strictEqual(actions[0].cells.B1.note, undefined);
  });

  await test('AI DCF section contract rejects incomplete sections before Excel execution', () => {
    const fallback = buildDcfSection({ section: 'assumptions', ticker: 'AAPL', companyName: 'Apple Inc.' }, mockMemory);
    const incomplete = {
      data: {},
      actions: [
        {
          type: 'setCellRange',
          sheet: 'Assumptions',
          cells: {
            A1: { value: 'Apple Inc. (AAPL) - DCF Assumptions' },
            A10: { value: 'Base Revenue ($M)' },
            B10: { value: 100000 }
          }
        }
      ]
    };
    const contract = validateDcfSectionContract('assumptions', incomplete.actions, fallback.actions);
    assert.strictEqual(contract.ok, false);
    assert.ok(contract.errors.some(error => error.includes('minimum complete section')));
  });

  await test('AI DCF builder can be disabled for deterministic fallback', async () => {
    const previous = process.env.DCF_AI_BUILDER_ENABLED;
    process.env.DCF_AI_BUILDER_ENABLED = 'false';
    try {
      const output = await buildDcfSectionAi({ section: 'wacc', ticker: 'AAPL' }, mockMemory);
      assert.strictEqual(output.data.builder, 'template');
      assert.strictEqual(output.actions[0].sheet, 'WACC');
    } finally {
      if (previous === undefined) delete process.env.DCF_AI_BUILDER_ENABLED;
      else process.env.DCF_AI_BUILDER_ENABLED = previous;
    }
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
