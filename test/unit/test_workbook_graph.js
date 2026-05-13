const assert = require('assert');
const { buildWorkbookGraph, extractFormulaRefs, classifySheet } = require('../../server/models/workbookGraph');
const { executeTool } = require('../../server/tools/registry');

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`OK ${name}`))
    .catch((err) => {
      console.error(`FAIL ${name}`);
      console.error(err);
      process.exitCode = 1;
    });
}

const snapshot = {
  activeSheet: 'DCF',
  workbookSheets: ['Summary', 'Assumptions', 'WACC', 'DCF', 'Sensitivity'],
  sheets: [
    {
      name: 'Summary',
      usedRange: 'Summary!A1:C8',
      rowCount: 8,
      columnCount: 3,
      preview: [
        ['Apple Inc. - Summary', '', ''],
        [],
        ['Metric', 'Value', 'Source'],
        ['Enterprise Value', '', 'DCF'],
        ['Implied Share Price', '', 'DCF']
      ],
      formulas: [
        ['', '', ''],
        [],
        ['', '', ''],
        ['', '=DCF!$H$30', ''],
        ['', '=DCF!$H$35', '']
      ]
    },
    {
      name: 'Assumptions',
      usedRange: 'Assumptions!A1:B12',
      rowCount: 12,
      columnCount: 2,
      preview: [
        ['Company', 'Apple Inc.'],
        ['Ticker', 'AAPL'],
        ['Revenue Growth %', 0.05],
        ['Tax Rate %', 0.21],
        ['Terminal Growth Rate %', 0.025],
        ['Market Risk Premium', 0.055]
      ],
      formulas: []
    },
    {
      name: 'WACC',
      usedRange: 'WACC!A1:B12',
      rowCount: 12,
      columnCount: 2,
      preview: [
        ['Cost of Equity', ''],
        ['Risk-Free Rate', 0.042],
        ['Beta', 1.2],
        ['Market Risk Premium', 0.055],
        ['WACC', '']
      ],
      formulas: [
        ['', '=Assumptions!$B$6'],
        ['', ''],
        ['', ''],
        ['', '=Assumptions!$B$6'],
        ['', '=B2+B3*B4']
      ]
    },
    {
      name: 'DCF',
      usedRange: 'DCF!A1:H16',
      rowCount: 16,
      columnCount: 8,
      preview: [
        ['Apple Inc. - DCF', '', '', '', '', '', '', ''],
        ['Metric', '2026E', '2027E', '2028E', '2029E', '2030E', '', 'Terminal'],
        ['Revenue', 400000, '', '', '', '', '', ''],
        ['Unlevered FCF', 100000, '', '', '', '', '', ''],
        ['Terminal Value', '', '', '', '', '', '', '#REF!'],
        ['Enterprise Value', '', '', '', '', '', '', '']
      ],
      formulas: [
        ['', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', ''],
        ['', '=Assumptions!$B$3', '=B3*(1+Assumptions!$B$3)', '', '', '', '', ''],
        ['', '=B3*0.25', '=C3*0.25', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '=G4*(1+Assumptions!$B$5)/(WACC!$B$5-Assumptions!$B$5)'],
        ['', '', '', '', '', '', '', '=SUM(B4:F4)+#REF!']
      ]
    },
    {
      name: 'Sensitivity',
      usedRange: 'Sensitivity!A1:G9',
      rowCount: 9,
      columnCount: 7,
      preview: [
        ['Sensitivity Analysis', '', '', '', '', '', ''],
        [],
        ['WACC \\ Terminal Growth', 0.015, 0.02, 0.025, 0.03],
        [0.075, '', '', '', ''],
        [0.08, '', '', '', '']
      ],
      formulas: [
        ['', '', '', '', '', '', ''],
        [],
        ['', '', '', '', ''],
        ['', '=DCF!$H$35', '=DCF!$H$35', '=DCF!$H$35', '=DCF!$H$35'],
        ['', '=DCF!$H$35', '=DCF!$H$35', '=DCF!$H$35', '=DCF!$H$35']
      ]
    }
  ]
};

(async () => {
await test('WorkbookGraph classifies finance sheets and detects model objects', () => {
  const graph = buildWorkbookGraph(snapshot, { workbookName: 'Apple DCF' });

  assert.strictEqual(graph.version, 1);
  assert.strictEqual(graph.workbook.name, 'Apple DCF');
  assert.strictEqual(graph.summary.sheetCount, 5);
  assert.strictEqual(graph.summary.roles.assumptions, 1);
  assert.strictEqual(graph.sheets.find(sheet => sheet.name === 'WACC').role, 'wacc');
  assert.strictEqual(graph.sheets.find(sheet => sheet.name === 'DCF').role, 'model');
  assert.ok(graph.summary.detectedModels.includes('dcf'));
  assert.ok(graph.summary.detectedModels.includes('wacc'));
  assert.ok(graph.summary.detectedModels.includes('sensitivity'));
  assert.ok(graph.sheets.find(sheet => sheet.name === 'DCF').tables.length >= 1);
});

await test('WorkbookGraph extracts cross-sheet formula dependencies and issues', () => {
  const graph = buildWorkbookGraph(snapshot);

  assert.ok(graph.formulas.count >= 10);
  assert.ok(graph.formulas.crossSheetCount >= 8);
  assert.ok(graph.formulas.refsBySheet.Assumptions >= 4);
  assert.ok(graph.formulas.refsBySheet.WACC >= 1);
  assert.ok(graph.formulas.dependencyEdges.some(edge => edge.from === 'DCF!H5' && edge.to === 'WACC!B5'));
  assert.ok(graph.issues.some(issue => issue.type === 'broken_reference' && issue.sheet === 'DCF'));
});

await test('formula reference parser handles quoted and unquoted sheet names', () => {
  const refs = extractFormulaRefs("='Assumptions Case'!$B$5+WACC!$C$10+DCF!B4:G4");
  assert.deepStrictEqual(refs, [
    { sheet: 'Assumptions Case', target: 'B5' },
    { sheet: 'WACC', target: 'C10' },
    { sheet: 'DCF', target: 'B4:G4' }
  ]);
});

await test('sheet classifier recognizes assumptions without relying on sheet name only', () => {
  const role = classifySheet('Inputs', [
    ['Driver', 'Value'],
    ['Revenue Growth %', 0.05],
    ['Terminal Growth Rate %', 0.025]
  ]);
  assert.strictEqual(role, 'assumptions');
});

await test('workbook.buildGraph reads from prior task results without mutating Excel', async () => {
  const memory = {
    results: {
      t1: { data: snapshot }
    }
  };
  const result = await executeTool('workbook.buildGraph', { fromResult: 't1', workbookName: 'Apple DCF' }, memory);
  assert.strictEqual(result.actions.length, 0);
  assert.strictEqual(result.data.workbook.name, 'Apple DCF');
  assert.strictEqual(result.data.summary.roles.model, 1);
});

await test('workbook.scanDeep requests formulas from the Excel runtime', async () => {
  const memory = {
    runtime: {
      requestClientTool: async (toolName, params) => {
        assert.strictEqual(toolName, 'workbook.readWorkbook');
        assert.strictEqual(params.includeFormulas, true);
        assert.strictEqual(params.maxRows, 90);
        return snapshot;
      }
    }
  };
  const result = await executeTool('workbook.scanDeep', { maxRows: 90, workbookName: 'Runtime DCF' }, memory);
  assert.strictEqual(result.actions.length, 0);
  assert.strictEqual(result.data.workbook.name, 'Runtime DCF');
  assert.ok(result.data.formulas.crossSheetCount > 0);
});
})();
