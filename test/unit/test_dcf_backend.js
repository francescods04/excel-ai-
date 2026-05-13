const assert = require('assert');
const planner = require('../../server/agents/planner');
const { buildDcfSection, inferDcfInputs } = require('../../server/models/dcfTemplate');
const { buildDcfSectionAi, normalizeActions, validateDcfSectionContract } = require('../../server/models/dcfAiBuilder');
const { buildProfessionalFormatPlan } = require('../../server/models/formatTemplate');
const { validateFormula, validateTaskOutput } = require('../../server/agents/critic');
const { inferEquityIntent } = require('../../server/utils/equityIntent');
const { parseSheetMatrix } = require('../../server/utils/sheetParser');
const { executeTool } = require('../../server/tools/registry');
const { getAnalystDepth } = require('../../server/models/analystDepth');
const { normalizeAiSchema } = require('../../server/models/workbookAiSchema');
const { normalizeUnderstanding } = require('../../server/models/workbookUnderstanding');
const { selectLastModelState } = require('../../server/runtime/conversationMemory');

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

function wideFinancialRow(label, value2024, value2023 = null, value2022 = null) {
  const row = new Array(38).fill('');
  row[0] = label;
  row[18] = value2024;
  if (value2023 !== null) row[26] = value2023;
  if (value2022 !== null) row[37] = value2022;
  return row;
}

const localItalianFinancialSheet = [
  ['ZUCCHETTI SPA'],
  ['Società privata', 'EUR'],
  ['Bilancio non consolidato'],
  wideFinancialRow('Ricavi delle vendite', 422084200, 384293950, 335110795),
  wideFinancialRow('EBITDA', 144455481, 137397815, 109040566),
  wideFinancialRow('Utile Netto', 98659837, 92640625, 73452441),
  wideFinancialRow('Totale Attività', 1877404039, 1392953646, 1124782656),
  wideFinancialRow('Patrimonio Netto', 796074921, 698199348, 608235999),
  wideFinancialRow('Posizione finanziaria netta', '##########', 278255159, 281083500),
  wideFinancialRow('C.IV. TOT. DISPON. LIQUIDE', 123159144, 18924672, 65637177),
  wideFinancialRow('C.IV.3. Denaro in cassa', 73677, 25641, 65121),
  wideFinancialRow('RISULTATO PRIMA DELLE IMPOSTE', 124885000, 118500000, 94000000),
  wideFinancialRow('20. Totale Imposte sul reddito correnti, differite e anticipate', 26225163, 25859375, 20547559),
  wideFinancialRow('B.10. TOT Ammortamenti e svalut.', 13728388, 12810277, 13428874),
  wideFinancialRow('Capitale circolante netto', -137278459, -312257541, -168743724),
  wideFinancialRow('EBITDA/Vendite (%)', 33.67, 34.66, 31.82),
  wideFinancialRow('Redditività delle vendite (ROS) (%)', 27.9, 28.1, 26.4),
  wideFinancialRow('Debt/Equity ratio', 0.8, 0.9, 1.0)
];

const localItalianContext = {
  activeSheet: 'Sheet1',
  workbookSheets: ['Sheet1'],
  allSheetsData: {
    Sheet1: {
      isActive: true,
      usedRange: 'Sheet1!A1:AL12',
      rowCount: 12,
      columnCount: 38,
      preview: localItalianFinancialSheet
    }
  }
};

const localFrenchFinancialSheet = [
  ['SOCIETE EXEMPLE SA'],
  ['Société privée', 'EUR', 'en milliers d’euros'],
  ['', '2021A', '2022A', '2023A', '2024A'],
  ['Chiffre d’affaires', 280000, 310000, 360000, 420000],
  ['Excédent brut d’exploitation (EBE)', 70000, 80000, 95000, 120000],
  ['Résultat avant impôt', 42000, 51000, 64000, 83000],
  ['Impôts sur les bénéfices', -11000, -13000, -17000, -22000],
  ['Dotations aux amortissements', 10000, 11000, 12000, 13000],
  ['Besoin en fonds de roulement', -42000, -46000, -50000, -52000],
  ['Trésorerie et équivalents de trésorerie', 55000, 70000, 86000, 95000],
  ['Dette financière nette', 155000, 145000, 132000, 118000]
];

const localFrenchContext = {
  activeSheet: 'Comptes',
  workbookSheets: ['Comptes'],
  allSheetsData: {
    Comptes: {
      isActive: true,
      usedRange: 'Comptes!A1:E11',
      rowCount: 11,
      columnCount: 5,
      preview: localFrenchFinancialSheet
    }
  }
};

const genericSalesContext = {
  activeSheet: 'Sales',
  workbookSheets: ['Sales'],
  allSheetsData: {
    Sales: {
      isActive: true,
      usedRange: 'Sales!A1:D4',
      rowCount: 4,
      columnCount: 4,
      preview: [
        ['Date', 'Region', 'Revenue', 'Units'],
        ['2026-01-01', 'North', 1200, 12],
        ['2026-01-02', 'South', 900, 9],
        ['2026-01-03', 'North', 1400, 14]
      ],
      formulas: [
        ['', '', '', ''],
        ['', '', '', ''],
        ['', '', '', ''],
        ['', '', '', '']
      ]
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
      .forEach(task => {
        assert.strictEqual(task.params.mode, 'ai_assisted');
        assert.strictEqual(task.params.analysisDepth, 'institutional');
        assert.ok(task.params.analystDepth);
        assert.ok(task.params.analystDepth.requiredAnalyses.length >= 3);
        assert.ok(task.params.analystDepth.visibleOutputs.length >= 2);
      });

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

  await test('planner can force domain playbook for deterministic DCF runtime tests', async () => {
    const plan = await planner.plan('crea un dcf per nvdia', {
      activeSheet: 'Sheet1',
      workbookSheets: ['Sheet1']
    }, 'turn-test-dcf', { domainPlaybookFirst: true });

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

  await test('sheet parser extracts Italian financial rows and European numbers', () => {
    const parsed = parseSheetMatrix(localItalianFinancialSheet, 'Sheet1');
    const revenue = parsed.inferredInputs.find(input => input.canonical === 'Revenue');
    const ebitda = parsed.inferredInputs.find(input => input.canonical === 'EBITDA');
    const netIncome = parsed.inferredInputs.find(input => input.canonical === 'Net Income');
    const margin = parsed.inferredInputs.find(input => input.canonical === 'EBITDA Margin');
    const netDebt = parsed.inferredInputs.find(input => input.canonical === 'Net Debt');
    const totalCash = parsed.inferredInputs.find(input => input.label.includes('TOT. DISPON'));
    const cashLine = parsed.inferredInputs.find(input => input.label.includes('Denaro in cassa'));
    const da = parsed.inferredInputs.find(input => input.canonical === 'D&A');
    const taxes = parsed.inferredInputs.find(input => input.canonical === 'Income Taxes');
    const ros = parsed.inferredInputs.find(input => input.label.includes('ROS'));

    assert.strictEqual(revenue.value, 422084200);
    assert.strictEqual(revenue.cell, 'Sheet1!S4');
    assert.strictEqual(ebitda.value, 144455481);
    assert.strictEqual(netIncome.value, 98659837);
    assert.strictEqual(margin.value, 33.67);
    assert.strictEqual(netDebt.value, 278255159);
    assert.strictEqual(totalCash.value, 123159144);
    assert.strictEqual(cashLine.value, 73677);
    assert.ok(totalCash.priority > cashLine.priority);
    assert.strictEqual(da.value, 13728388);
    assert.strictEqual(taxes.value, 26225163);
    assert.strictEqual(ros.canonical, 'EBIT Margin');
  });

  await test('sheet parser handles French periods and latest historical year', () => {
    const parsed = parseSheetMatrix(localFrenchFinancialSheet, 'Comptes');
    const revenue2024 = parsed.inferredInputs.find(input => input.canonical === 'Revenue' && input.fiscalYear === 2024);
    const revenue2021 = parsed.inferredInputs.find(input => input.canonical === 'Revenue' && input.fiscalYear === 2021);
    const cash = parsed.inferredInputs.find(input => input.canonical === 'Cash & Equivalents' && input.fiscalYear === 2024);
    const nwc = parsed.inferredInputs.find(input => input.canonical === 'Net Working Capital' && input.fiscalYear === 2024);

    assert.strictEqual(revenue2024.value, 420000);
    assert.strictEqual(revenue2024.cell, 'Comptes!E4');
    assert.strictEqual(revenue2024.period, '2024A');
    assert.strictEqual(revenue2021.value, 280000);
    assert.strictEqual(cash.value, 95000);
    assert.strictEqual(nwc.value, -52000);
  });

  await test('DCF template uses historical French growth bridge instead of arbitrary growth', () => {
    const inputs = inferDcfInputs({}, { context: localFrenchContext, results: {} });
    assert.strictEqual(inputs.companyName, 'SOCIETE EXEMPLE SA');
    assert.strictEqual(inputs.currency, 'EUR');
    assert.strictEqual(inputs.sourceType, 'workbook');
    assert.strictEqual(inputs.reportingUnit, 'thousands');
    assert.strictEqual(inputs.baseYear, 2024);
    assert.ok(Math.abs(inputs.baseRevenueMillions - 420) < 0.0001);
    assert.ok(Math.abs(inputs.cashMillions - 95) < 0.0001);
    assert.ok(Math.abs(inputs.debtMillions - 118) < 0.0001);
    assert.ok(Math.abs(inputs.historicalGrowth.latestGrowth - (420000 / 360000 - 1)) < 0.0001);
    assert.ok(inputs.revenueGrowth[0] > 0.13 && inputs.revenueGrowth[0] < 0.18);

    const assumptions = buildDcfSection({ section: 'assumptions' }, { context: localFrenchContext, results: {} });
    const cells = assumptions.actions[0].cells;
    assert.strictEqual(cells.A40.value, 'Historical Revenue Growth Bridge');
    assert.strictEqual(cells.A42.value, 'Historical Revenue 2024A');
    assert.ok(Math.abs(cells.B42.value - 420) < 0.0001);
    assert.ok(Math.abs(cells.B47.value - (420000 / 360000 - 1)) < 0.0001);
    assert.ok(cells.C18.value.includes('Growth bridge uses latest YoY'));
  });

  await test('AI workbook schema mappings override deterministic parser without trusting invented values', () => {
    const cellLookup = new Map([
      ['Comptes!E4', { value: 420000, row: 3, col: 4, sheet: 'Comptes' }],
      ['Comptes!E10', { value: 95000, row: 9, col: 4, sheet: 'Comptes' }]
    ]);
    const schema = normalizeAiSchema({
      language: 'fr',
      companyName: 'SOCIETE EXEMPLE SA',
      currency: 'EUR',
      reportingUnit: 'thousands',
      isPrivateCompany: true,
      mappings: [
        {
          canonical: 'Revenue',
          label: 'Chiffre d’affaires',
          sheet: 'Comptes',
          cell: 'Comptes!E4',
          row: 3,
          col: 4,
          period: '2024A',
          fiscalYear: 2024,
          isForecast: false,
          confidence: 'high',
          rationale: 'AI identified revenue from French label',
          value: 999999999
        },
        {
          canonical: 'Cash & Equivalents',
          label: 'Trésorerie et équivalents de trésorerie',
          sheet: 'Comptes',
          cell: 'Comptes!E10',
          row: 9,
          col: 4,
          period: '2024A',
          fiscalYear: 2024,
          isForecast: false,
          confidence: 'high',
          rationale: 'AI identified total cash'
        }
      ]
    }, cellLookup);

    assert.strictEqual(schema.mappings.length, 2);
    assert.strictEqual(schema.mappings[0].value, 420000);
    assert.strictEqual(schema.mappings[1].value, 95000);
  });

  await test('generic workbook understanding validates AI semantic ranges against real cells', () => {
    const normalized = normalizeUnderstanding({
      workbookPurpose: 'Track sales by region and date',
      domain: 'sales',
      language: 'en',
      confidence: 'high',
      sheets: [
        {
          name: 'Sales',
          role: 'source_data',
          summary: 'Sales transaction table',
          usedRange: 'Sales!A1:D4',
          tables: [
            {
              name: 'Sales transactions',
              range: 'Sales!A1:D4',
              anchorCell: 'Sales!A1',
              headerRow: 1,
              headers: ['Date', 'Region', 'Revenue', 'Units'],
              grain: 'one row per daily regional sale',
              measures: ['Revenue', 'Units'],
              dimensions: ['Region'],
              timeFields: ['Date']
            },
            {
              name: 'Invented table',
              range: 'Sales!Z1:Z99',
              anchorCell: 'Sales!Z1',
              headers: ['Bad']
            }
          ],
          keyCells: [
            { cell: 'Sales!C2', label: 'Revenue sample', meaning: 'First transaction revenue' },
            { cell: 'Sales!Z99', label: 'Invalid', meaning: 'Should be rejected' }
          ],
          formulaZones: [
            { range: 'Sales!C2:D4', meaning: 'numeric transaction metrics' },
            { range: 'Sales!X1:X4', meaning: 'invalid zone' }
          ],
          risks: ['No totals yet']
        }
      ],
      crossSheetRelationships: [],
      recommendedNextActions: ['Create a regional summary'],
      questionsForUser: []
    }, genericSalesContext, 'analizza vendite');

    assert.strictEqual(normalized.domain, 'sales');
    assert.strictEqual(normalized.sheets.length, 1);
    assert.strictEqual(normalized.sheets[0].tables.length, 1);
    assert.strictEqual(normalized.sheets[0].tables[0].range, 'Sales!A1:D4');
    assert.strictEqual(normalized.sheets[0].keyCells.length, 1);
    assert.strictEqual(normalized.sheets[0].formulaZones.length, 1);
  });

  await test('planner injects workbook.understand before AI reasoning tasks', () => {
    const rawPlan = {
      objective: 'crea un summary vendite',
      tasks: [
        { id: 't1', agent: 'data', tool: 'workbook.readWorkbook', description: 'read', params: { maxRows: 20, maxCols: 10 }, deps: [], requiresApproval: false, status: 'pending' },
        { id: 't2', agent: 'formula', tool: 'llm.writeFormulas', description: 'summary', params: { sheet: 'Sales', section: 'summary' }, deps: ['t1'], requiresApproval: false, status: 'pending' }
      ]
    };
    const plan = planner.ensureWorkbookUnderstandingPlan(rawPlan, genericSalesContext, 'crea un summary vendite');
    const understand = plan.tasks.find(task => task.tool === 'workbook.understand');
    const formula = plan.tasks.find(task => task.id === 't2');

    assert.ok(understand);
    assert.deepStrictEqual(understand.deps, ['t1']);
    assert.ok(formula.deps.includes(understand.id));
    assert.ok(formula.params.usesResults.includes(understand.id));
    assert.strictEqual(formula.params.workbookUnderstanding, understand.id);
  });

  await test('workbook.understand deterministic fallback works for non-finance workbooks', async () => {
    const previous = process.env.WORKBOOK_UNDERSTANDING_ENABLED;
    process.env.WORKBOOK_UNDERSTANDING_ENABLED = 'false';
    try {
      const output = await executeTool('workbook.understand', { objective: 'analizza vendite' }, {
        context: genericSalesContext,
        results: {}
      });
      assert.strictEqual(output.actions.length, 0);
      assert.strictEqual(output.data.builder, 'deterministic-fallback');
      assert.strictEqual(output.data.sheets[0].name, 'Sales');
      assert.strictEqual(output.data.sheets[0].tables[0].headers[0], 'Date');
    } finally {
      if (previous === undefined) delete process.env.WORKBOOK_UNDERSTANDING_ENABLED;
      else process.env.WORKBOOK_UNDERSTANDING_ENABLED = previous;
    }
  });

  await test('workbook.understand accepts readWorkbook snapshots that also include selected range data', async () => {
    const previous = process.env.WORKBOOK_UNDERSTANDING_ENABLED;
    process.env.WORKBOOK_UNDERSTANDING_ENABLED = 'false';
    try {
      const output = await executeTool('workbook.understand', { objective: 'formatta tutto', fromResult: 't1' }, {
        results: {
          t1: {
            data: {
              activeSheet: 'Sales',
              workbookSheets: ['Sales', 'Summary'],
              selectedValues: [['Revenue']],
              sheets: [
                { name: 'Sales', usedRange: 'Sales!A1:D4', rowCount: 4, columnCount: 4, preview: genericSalesContext.allSheetsData.Sales.preview },
                { name: 'Summary', usedRange: 'Summary!A1:B3', rowCount: 3, columnCount: 2, preview: [['Summary'], ['Revenue', '=SUM(Sales!C:C)']], formulas: [[''], ['', '=SUM(Sales!C:C)']] }
              ]
            }
          }
        }
      });
      assert.strictEqual(output.data.builder, 'deterministic-fallback');
      assert.deepStrictEqual(output.data.sheets.map(sheet => sheet.name), ['Sales', 'Summary']);
    } finally {
      if (previous === undefined) delete process.env.WORKBOOK_UNDERSTANDING_ENABLED;
      else process.env.WORKBOOK_UNDERSTANDING_ENABLED = previous;
    }
  });

  await test('DCF template prefers local workbook financials over external/default data', () => {
    const inputs = inferDcfInputs({}, {
      context: localItalianContext,
      results: mockMemory.results
    });

    assert.strictEqual(inputs.companyName, 'ZUCCHETTI SPA');
    assert.strictEqual(inputs.ticker, 'PRIVATE');
    assert.strictEqual(inputs.currency, 'EUR');
    assert.strictEqual(inputs.sourceType, 'workbook');
    assert.ok(Math.abs(inputs.baseRevenueMillions - 422.0842) < 0.0001);
    assert.ok(Math.abs(inputs.ebitdaMargin - (144455481 / 422084200)) < 0.0001);
    assert.ok(Math.abs(inputs.cashMillions - 123.159144) < 0.0001);
    assert.ok(Math.abs(inputs.debtMillions - 278.255159) < 0.0001);
    assert.ok(Math.abs(inputs.daPercentRevenue - (12810277 / 384293950)) < 0.0001);
    assert.ok(Math.abs(inputs.taxRate - (25859375 / 118500000)) < 0.0001);
    assert.ok(inputs.revenueGrowth[0] > 0.08);
    assert.strictEqual(inputs.privateOwnershipMode, true);
    assert.strictEqual(inputs.hasShareCount, false);
    assert.strictEqual(inputs.sharesMillions, 1);

    const assumptions = buildDcfSection({ section: 'assumptions' }, {
      context: localItalianContext,
      results: mockMemory.results
    });
    assert.strictEqual(assumptions.actions[0].cells.B6.value, 'EUR');
    assert.strictEqual(assumptions.actions[0].cells.B8.value, 'Workbook local data');
    assert.ok(Math.abs(assumptions.actions[0].cells.B10.value - 422.0842) < 0.0001);
    assert.ok(assumptions.actions[0].cells.C10.value.includes('converted to millions'));
    assert.ok(assumptions.actions[0].cells.D10.value.includes('Local source: Sheet1!S4'));
    assert.ok(Math.abs(assumptions.actions[0].cells.B33.value - 123.159144) < 0.0001);
    assert.ok(assumptions.actions[0].cells.D33.value.includes('Local source'));
    assert.strictEqual(assumptions.actions[0].cells.A35.value, 'Ownership Units (100%=1.0)');
    assert.ok(assumptions.actions[0].cells.C28.value.includes('cross-checked'));

    const dcf = buildDcfSection({ section: 'dcf' }, {
      context: localItalianContext,
      results: mockMemory.results
    });
    assert.ok(dcf.actions[0].cells.A35.value.includes('100% Ownership'));
    assert.ok(dcf.actions[0].cells.A37.value.includes('Reference Share Price'));
    assert.strictEqual(dcf.actions[0].cells.H35.formula, '=H33/H34');
    assert.strictEqual(dcf.actions[0].cells.H38.formula, '=IF(H37>0,H35/H37-1,"")');

    const audit = buildDcfSection({ section: 'audit' }, {
      context: localItalianContext,
      results: mockMemory.results
    });
    assert.strictEqual(audit.actions[0].cells.A10.value, 'Cash / revenue sanity');
    assert.strictEqual(audit.actions[0].cells.A11.value, 'Market input support');
    assert.ok(audit.actions[0].cells.B17.formula.includes('$B$5:$B$14'));
  });

  await test('planner workbook-first guardrail removes invented external company data tasks', () => {
    const parsed = parseSheetMatrix(localItalianFinancialSheet, 'Sheet1');
    const planningContext = {
      activeSheet: 'Sheet1',
      workbookSheets: ['Sheet1'],
      allSheetsData: localItalianContext.allSheetsData,
      inferredData: {
        highConfidenceInputs: parsed.inferredInputs.map(input => ({
          canonical: input.canonical,
          value: input.value,
          cell: input.cell,
          sheet: 'Sheet1'
        })),
        summary: parsed.summary
      }
    };
    const rawPlan = {
      objective: 'analizza questa azienda',
      tasks: [
        { id: 't1', agent: 'data', tool: 'workbook.scanDeep', description: 'scan', params: {}, deps: [], requiresApproval: false },
        { id: 't2', agent: 'data', tool: 'openbb.equity.profile', description: 'invented profile', params: { symbol: 'ZUCN.MI' }, deps: [], requiresApproval: false },
        { id: 't3', agent: 'data', tool: 'yahoo.fundamentals', description: 'invented fundamentals', params: { ticker: 'ZUCN.MI' }, deps: [], requiresApproval: false },
        { id: 't4', agent: 'formula', tool: 'finance.dcf.buildSection', description: 'build assumptions', params: { section: 'assumptions', ticker: 'ZUCN.MI', usesResults: ['t1', 't2', 't3'] }, deps: ['t1', 't2', 't3'], requiresApproval: false }
      ]
    };

    const guarded = planner.enforceWorkbookFirstPlan(rawPlan, planningContext, 'analizza questa azienda');
    assert.ok(!guarded.tasks.some(task => task.tool === 'openbb.equity.profile'));
    assert.ok(!guarded.tasks.some(task => task.tool === 'yahoo.fundamentals'));
    const dcfTask = guarded.tasks.find(task => task.tool === 'finance.dcf.buildSection');
    assert.deepStrictEqual(dcfTask.deps, ['t1']);
    assert.deepStrictEqual(dcfTask.params.usesResults, ['t1']);
    assert.strictEqual(dcfTask.params.ticker, undefined);
    assert.strictEqual(dcfTask.params.sourcePriority, 'workbook_first');
  });

  await test('planner routes local full valuation to workbook-first DCF builder', async () => {
    const plan = await planner.plan(
      'analizza questa azienda e fammi una full valuation completa',
      localItalianContext
    );

    assert.ok(plan.tasks.some(task => task.tool === 'workbook.buildGraph'));
    assert.ok(!plan.tasks.some(task => task.tool === 'llm.planLayout'));
    assert.ok(!plan.tasks.some(task => task.tool === 'llm.writeFormulas' && task.params.mode === 'build_finance_model'));
    assert.ok(!plan.tasks.some(task => task.tool.startsWith('yahoo.')));

    const dcfTasks = plan.tasks.filter(task => task.tool === 'finance.dcf.buildSection');
    assert.deepStrictEqual(
      dcfTasks.map(task => task.params.section),
      ['shell', 'sources', 'assumptions', 'wacc', 'dcf', 'sensitivity', 'scenarios', 'summary', 'audit', 'format']
    );
    dcfTasks.forEach(task => {
      assert.strictEqual(task.params.sourcePriority, 'workbook_first');
      assert.strictEqual(task.params.ticker, undefined);
      assert.strictEqual(task.params.companyName, undefined);
      assert.strictEqual(task.params.localCompanyType, 'private');
    });
  });

  await test('planner annotates generic finance formula tasks with analyst depth', async () => {
    const plan = await planner.plan('calcola un WACC completo con tutti i controlli necessari', {
      activeSheet: 'Sheet1',
      workbookSheets: ['Sheet1']
    });
    const formulaTask = plan.tasks.find(task => task.tool === 'llm.writeFormulas');
    assert.ok(formulaTask);
    assert.strictEqual(formulaTask.params.analysisDepth, 'institutional');
    assert.strictEqual(formulaTask.params.analystDepth.section, 'wacc');
    assert.ok(formulaTask.params.analystDepth.requiredAnalyses.some(item => item.includes('peer/sector beta')));
  });

  await test('runtime planner lets AI decide complex valuation plans before playbook fallback', async () => {
    const domainPlan = await planner.plan(
      'analizza questa azienda e fammi una full valuation completa',
      localItalianContext
    );
    const previous = process.env.AI_MANAGED_PLANNING;
    try {
      delete process.env.AI_MANAGED_PLANNING;
      assert.strictEqual(
        planner.shouldUseDomainPlaybookFirst(
          'turn-test-ai-managed',
          {},
          'analizza questa azienda e fammi una full valuation completa',
          localItalianContext,
          domainPlan
        ),
        false
      );
      assert.strictEqual(
        planner.shouldUseDomainPlaybookFirst(
          null,
          {},
          'analizza questa azienda e fammi una full valuation completa',
          localItalianContext,
          domainPlan
        ),
        true
      );
      process.env.AI_MANAGED_PLANNING = 'false';
      assert.strictEqual(
        planner.shouldUseDomainPlaybookFirst(
          'turn-test-ai-managed',
          {},
          'analizza questa azienda e fammi una full valuation completa',
          localItalianContext,
          domainPlan
        ),
        true
      );
    } finally {
      if (previous === undefined) delete process.env.AI_MANAGED_PLANNING;
      else process.env.AI_MANAGED_PLANNING = previous;
    }
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

  await test('DCF WACC template exposes beta peer cross-check methodology', () => {
    const wacc = buildDcfSection({ section: 'wacc', ticker: 'AAPL', companyName: 'Apple Inc.' }, mockMemory);
    const cells = wacc.actions[0].cells;
    assert.strictEqual(wacc.actions[0].sheet, 'WACC');
    assert.strictEqual(cells.B5.formula, '=B28');
    assert.strictEqual(cells.A21.value, 'Beta Evidence & Peer Cross-Check');
    assert.strictEqual(cells.B26.formula, '=B23/(1+(1-B25)*B24)');
    assert.strictEqual(cells.B27.formula, '=B26*(1+(1-B25)*B24)');
    assert.strictEqual(cells.B28.formula, '=AVERAGE(B22,B27)');
    assert.ok(cells.B30.value.includes('unlever peers'));
    assert.strictEqual(validateDcfSectionContract('wacc', wacc.actions, wacc.actions).ok, true);
  });

  await test('DCF template creates source, scenario, summary and audit layers', () => {
    const shell = buildDcfSection({ section: 'shell', ticker: 'AAPL', companyName: 'Apple Inc.' }, mockMemory);
    const createdSheets = shell.actions.filter(action => action.type === 'createSheet').map(action => action.sheet || action.name);
    ['Summary', 'Sources', 'Assumptions', 'WACC', 'DCF', 'Sensitivity', 'Scenarios', 'Audit']
      .forEach(sheet => assert.ok(createdSheets.includes(sheet), `${sheet} should be created by shell`));

    const sources = buildDcfSection({ section: 'sources', ticker: 'AAPL', companyName: 'Apple Inc.' }, mockMemory);
    assert.strictEqual(sources.actions[0].sheet, 'Sources');
    assert.strictEqual(sources.actions[0].cells.B24.formula, '=Assumptions!$B$10');
    assert.strictEqual(sources.actions[0].cells.A43.value, 'Analyst Depth Workplan');
    assert.ok(sources.actions[0].cells.C46.value.includes('peer/sector beta'));
    assert.strictEqual(sources.data.analystDepth.section, 'sources');

    const assumptions = buildDcfSection({ section: 'assumptions', ticker: 'AAPL', companyName: 'Apple Inc.' }, mockMemory);
    assert.strictEqual(assumptions.actions[0].sheet, 'Assumptions');
    assert.strictEqual(assumptions.actions[0].cells.C3.value, 'How Derived');
    assert.strictEqual(assumptions.actions[0].cells.D3.value, 'Source / Review');
    assert.ok(assumptions.actions[0].cells.C14.value.includes('Capital intensity'));
    assert.ok(assumptions.actions[0].cells.D23.value.includes('terminal growth'));

    const scenarios = buildDcfSection({ section: 'scenarios', ticker: 'AAPL', companyName: 'Apple Inc.' }, mockMemory);
    assert.strictEqual(scenarios.actions[0].sheet, 'Scenarios');
    assert.ok(scenarios.actions[0].cells.F5.formula.includes('DCF!$G$20'));
    assert.strictEqual(scenarios.data.analystDepth.section, 'scenarios');

    const summary = buildDcfSection({ section: 'summary', ticker: 'AAPL', companyName: 'Apple Inc.' }, mockMemory);
    assert.strictEqual(summary.actions[0].sheet, 'Summary');
    assert.strictEqual(summary.actions[0].cells.B7.formula, '=DCF!$H$35');

    const audit = buildDcfSection({ section: 'audit', ticker: 'AAPL', companyName: 'Apple Inc.' }, mockMemory);
    assert.strictEqual(audit.actions[0].sheet, 'Audit');
    assert.ok(audit.actions[0].cells.B17.formula.includes('COUNTIF'));
    assert.strictEqual(audit.actions[0].cells.A26.value, 'Depth Coverage Checks');
    assert.ok(audit.actions[0].cells.C31.value.includes('Operating forecast'));
  });

  await test('analyst depth playbook covers all major valuation sections', () => {
    for (const section of ['sources', 'assumptions', 'wacc', 'dcf', 'sensitivity', 'scenarios', 'summary', 'audit', 'format']) {
      const depth = getAnalystDepth(section);
      assert.strictEqual(depth.depthLevel, 'institutional');
      assert.ok(depth.method.length > 20);
      assert.ok(depth.requiredAnalyses.length >= 3);
      assert.ok(depth.sanityChecks.length >= 1);
      assert.ok(depth.visibleOutputs.length >= 1);
    }
    assert.ok(getAnalystDepth('dcf').requiredAnalyses.some(item => item.includes('terminal value')));
    assert.ok(getAnalystDepth('sensitivity').method.includes('single point estimate'));
    assert.ok(getAnalystDepth('assumptions').requiredAnalyses.some(item => item.includes('fallback assumption')));
    assert.strictEqual(getAnalystDepth('wacc.cost_of_equity').section, 'wacc');
    assert.strictEqual(getAnalystDepth('full_model_review').section, 'audit');
    assert.strictEqual(getAnalystDepth('sensitivity.data_table').section, 'sensitivity');
  });

  await test('professional formatter builds adaptive red restyle without blanket reset', () => {
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

    assert.strictEqual(plan.data.builder, 'adaptive-format');
    assert.strictEqual(plan.data.theme, 'red');
    assert.strictEqual(plan.data.strategy, 'semantic_restyle');
    assert.ok(plan.actions.length > 45);
    assert.ok(plan.actions.some(action => action.options?.columnWidth));
    assert.ok(plan.actions.some(action => action.options?.borders || action.options?.borderBottomColor));
    assert.ok(plan.actions.some(action => action.sheet === 'Summary' && action.target === 'A1:C1' && action.options.backgroundColor === '#7F1D1D'));
    assert.ok(plan.actions.some(action => action.sheet === 'Sensitivity' && action.type === 'addConditionalFormat' && action.target === 'C5:G9'));
    assert.ok(!plan.actions.some(action => action.sheet === 'Summary' && action.target === 'A1:C29' && action.options.backgroundColor === '#FFFFFF'));
  });

  await test('formatter interprets non-red color themes from objective', () => {
    const memory = {
      results: {
        t1: {
          data: {
            activeSheet: 'Sheet1',
            sheets: [
              { name: 'Sheet1', usedRange: 'Sheet1!A1:D8', rowCount: 8, columnCount: 4, preview: [['Revenue model'], [], ['Operating inputs'], ['Metric', 'Value', 'Source'], ['Revenue', 100, 'Workbook']] }
            ]
          }
        }
      }
    };
    const plan = buildProfessionalFormatPlan({
      sheet: 'Sheet1',
      objective: 'cambia solo i colori in verde professionale',
      scope: 'sheet'
    }, memory);

    assert.strictEqual(plan.data.theme, 'green');
    assert.strictEqual(plan.data.strategy, 'semantic_restyle');
    assert.ok(plan.actions.some(action => action.sheet === 'Sheet1' && action.target === 'A1:D1' && action.options.backgroundColor === '#14532D'));
    assert.ok(plan.actions.some(action => action.sheet === 'Sheet1' && action.target === 'A3:D3' && action.options.backgroundColor === '#D9EAD3'));
  });

  await test('planner keeps short formatting requests attached to the last model', async () => {
    const plan = await planner.plan('cambia la formattazione in verde professionale', {
      activeSheet: 'Sheet1',
      workbookSheets: ['Sheet1', 'Summary', 'Sources', 'Assumptions', 'WACC', 'DCF', 'Sensitivity', 'Scenarios', 'Audit'],
      lastModelState: {
        modelType: 'DCF',
        sheets: ['Summary', 'Sources', 'Assumptions', 'WACC', 'DCF', 'Sensitivity', 'Scenarios', 'Audit'],
        turnId: 'turn-previous-dcf'
      }
    });
    const formatTask = plan.tasks.find(task => task.tool === 'llm.planFormat');
    assert.ok(formatTask);
    assert.strictEqual(formatTask.params.sheet, 'Summary');
    assert.strictEqual(formatTask.params.scope, 'workbook');
    assert.deepStrictEqual(formatTask.params.sheets, ['Summary', 'Sources', 'Assumptions', 'WACC', 'DCF', 'Sensitivity', 'Scenarios', 'Audit']);
    assert.ok(!formatTask.params.sheets.includes('Sheet1'));
    assert.strictEqual(formatTask.params.analysisDepth, 'institutional');
    assert.strictEqual(formatTask.params.analystDepth.section, 'format');
  });

  await test('planner formats the whole existing model when the user asks for all of it, even after a narrow prior turn', async () => {
    const plan = await planner.plan('formatta tutto il modello con colori da investment banker', {
      activeSheet: 'Scenarios',
      workbookSheets: ['Sheet1', 'Summary', 'Sources', 'Assumptions', 'WACC', 'DCF', 'Sensitivity', 'Scenarios', 'Audit'],
      lastModelState: {
        modelType: 'custom',
        sheets: ['Scenarios', 'WACC'],
        turnId: 'turn-narrow-followup'
      }
    });
    const formatTask = plan.tasks.find(task => task.tool === 'llm.planFormat');
    assert.ok(formatTask);
    assert.strictEqual(formatTask.params.scope, 'workbook');
    assert.deepStrictEqual(formatTask.params.sheets, ['Summary', 'Sources', 'Assumptions', 'WACC', 'DCF', 'Sensitivity', 'Scenarios', 'Audit']);
    assert.strictEqual(formatTask.params.sheet, 'Scenarios');
    assert.ok(!formatTask.params.sheets.includes('Sheet1'));
  });

  await test('conversation memory keeps durable DCF model state after partial edit turns', () => {
    const state = selectLastModelState([
      {
        turnId: 'turn-dcf',
        objective: 'analizza questa azienda e crea valuation',
        planSummary: 'Piano con 13/13 task completati',
        modelType: 'DCF',
        sheetsCreated: ['Summary', 'Sources', 'Assumptions', 'WACC', 'DCF', 'Sensitivity', 'Scenarios', 'Audit'],
        keyCells: { valuation: 'DCF!H30:H40' }
      },
      {
        turnId: 'turn-format-partial',
        objective: 'sistema la formattazione di scenarios',
        planSummary: 'Piano con 3/3 task completati',
        modelType: 'custom',
        sheetsCreated: ['Scenarios', 'WACC']
      }
    ]);

    assert.strictEqual(state.modelType, 'DCF');
    assert.strictEqual(state.turnId, 'turn-dcf');
    assert.deepStrictEqual(state.sheets, ['Summary', 'Sources', 'Assumptions', 'WACC', 'DCF', 'Sensitivity', 'Scenarios', 'Audit']);
  });

  await test('conversation memory still supports custom workbook continuity when no durable model exists', () => {
    const state = selectLastModelState([
      {
        turnId: 'turn-sales',
        objective: 'crea un summary vendite',
        planSummary: 'Piano con 2/2 task completati',
        modelType: 'custom',
        sheetsCreated: ['Sales Summary']
      }
    ]);

    assert.strictEqual(state.modelType, 'custom');
    assert.deepStrictEqual(state.sheets, ['Sales Summary']);
  });

  await test('formatter applies semantic colors for inputs, formulas and workbook links', () => {
    const memory = {
      results: {
        t1: {
          data: {
            activeSheet: 'Assumptions',
            sheets: [
              {
                name: 'Assumptions',
                usedRange: 'Assumptions!A1:C5',
                rowCount: 5,
                columnCount: 3,
                preview: [
                  ['Assumptions'],
                  ['Metric', 'Value', 'Source'],
                  ['Revenue Growth', 0.08, 'Analyst input'],
                  ['Revenue', 100, 'Workbook'],
                  ['Linked Revenue', 100, 'Sheet1']
                ],
                formulas: [
                  ['', '', ''],
                  ['', '', ''],
                  ['', '', ''],
                  ['', '=B3*1.1', ''],
                  ['', '=Sheet1!B2', '']
                ]
              }
            ]
          }
        }
      }
    };
    const plan = buildProfessionalFormatPlan({
      sheet: 'Assumptions',
      objective: 'formatta input formule e link',
      scope: 'sheet',
      usesResults: ['t1']
    }, memory);

    assert.ok(plan.actions.some(action => action.sheet === 'Assumptions' && action.target === 'B3:C3' && action.options.fontColor));
    assert.ok(plan.actions.some(action => action.sheet === 'Assumptions' && action.target === 'B4' && action.options.fontColor === '#000000'));
    assert.ok(plan.actions.some(action => action.sheet === 'Assumptions' && action.target === 'B5' && action.options.fontColor === '#008000'));
  });

  await test('formatter targets explicit model sheets without blanket-formatting source data', () => {
    const memory = {
      context: {
        allSheetsData: {
          Sheet1: {
            usedRange: 'Sheet1!A1:DF734',
            rowCount: 734,
            columnCount: 110,
            preview: [['Local financial source data']]
          }
        }
      },
      results: {
        t3: { data: { sheetName: 'Assumptions' }, actions: [{ type: 'createSheet', sheet: 'Assumptions' }] },
        t4: { actions: [{ type: 'createSheet', sheet: 'WACC' }] },
        t7: { actions: [{ type: 'setCellValue', sheet: 'DCF', target: 'A1', value: 'DCF' }] },
        t8: { actions: [{ type: 'setCellValue', sheet: 'Sensitivity', target: 'A1', value: 'Sensitivity' }] }
      }
    };
    const plan = buildProfessionalFormatPlan({
      sheet: 'DCF',
      sheets: ['Assumptions', 'WACC', 'DCF', 'Sensitivity'],
      objective: 'Apply institutional IB formatting',
      mode: 'institutional_finance',
      scope: 'workbook',
      usesResults: ['t3', 't4', 't7', 't8']
    }, memory);

    assert.strictEqual(plan.data.sheetCount, 4);
    assert.ok(plan.actions.some(action => action.sheet === 'Assumptions'));
    assert.ok(plan.actions.some(action => action.sheet === 'DCF'));
    assert.ok(!plan.actions.some(action => action.sheet === 'Sheet1'));
  });

  await test('DCF format section uses adaptive workbook formatter instead of sparse title-only styling', () => {
    const output = buildDcfSection({
      section: 'format',
      objective: 'formatta tutto il modello in verde professionale',
      sheets: ['Summary', 'Sources', 'Assumptions', 'WACC', 'DCF', 'Sensitivity', 'Scenarios', 'Audit'],
      mode: 'institutional_finance'
    }, {
      results: {
        t1: {
          data: {
            activeSheet: 'Assumptions',
            sheets: [
              { name: 'Assumptions', usedRange: 'Assumptions!A1:D56', rowCount: 56, columnCount: 4, preview: [['Model Assumptions'], [], ['Projection Assumptions'], ['Revenue Growth Y1 (%)', 0.05, 'Derived from historical trend', 'Local']] },
              { name: 'DCF', usedRange: 'DCF!A1:H40', rowCount: 40, columnCount: 8, preview: [['DCF Model'], ['Metric', '2024A', '2025E']] },
              { name: 'Sensitivity', usedRange: 'Sensitivity!A1:G18', rowCount: 18, columnCount: 7, preview: [['Sensitivity Analysis'], [], ['Implied Share Price Sensitivity']] }
            ]
          }
        }
      }
    });

    assert.ok(output.actions.length > 60, `expected rich format plan, got ${output.actions.length}`);
    assert.ok(output.actions.some(action => action.sheet === 'Summary' && action.target === 'A1:C1' && action.options.backgroundColor === '#14532D'));
    assert.ok(output.actions.some(action => action.sheet === 'Assumptions' && action.target === 'C1:C40' && action.options.wrapText === true));
    assert.ok(output.actions.some(action => action.type === 'addConditionalFormat' && action.sheet === 'Sensitivity' && action.target === 'C5:G9'));
  });

  await test('DCF runtime labels format section as adaptive-format in execution logs', async () => {
    const output = await buildDcfSectionAi({
      section: 'format',
      objective: 'formatta tutto il modello in verde professionale',
      sheets: ['Summary', 'Sources', 'Assumptions', 'WACC', 'DCF', 'Sensitivity', 'Scenarios', 'Audit'],
      mode: 'ai_assisted'
    }, { results: {} });

    assert.strictEqual(output.data.builder, 'adaptive-format');
    assert.ok(output.actions.length > 60);
  });

  await test('format plan task is non-mutating and applyFormat applies planned actions once', async () => {
    const previousFormatFlag = process.env.FORMAT_LLM_ENABLED;
    process.env.FORMAT_LLM_ENABLED = 'false';
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
    try {
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
    } finally {
      if (previousFormatFlag === undefined) delete process.env.FORMAT_LLM_ENABLED;
      else process.env.FORMAT_LLM_ENABLED = previousFormatFlag;
    }
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
