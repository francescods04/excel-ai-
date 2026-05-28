const assert = require('assert');
const { executeAgentTool } = require('../../server/agents/agentLoop.js');

(async function main() {
  // 1) bulk_set_cell_ranges emits N setCellRange actions, all in one call
  {
    const r = await executeAgentTool(
      'bulk_set_cell_ranges',
      {
        writes: [
          { sheet: 'Assumptions',     cells: { A1: { value: 'Driver' }, B1: { value: 'Value' } } },
          { sheet: 'Sources & Uses',  cells: { A1: { value: 'Sources' } }, copyToRange: 'A1:A5' },
          { sheet: 'Debt Schedule',   cells: { A1: { value: 'Year' } }, allow_overwrite: false }
        ]
      },
      { messages: [], iteration: 0, activeSheet: 'Sheet1' },
      null
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.applied, 3);
    assert.strictEqual(r.actions.length, 3);
    assert.deepStrictEqual(r.sheets.sort(), ['Assumptions', 'Debt Schedule', 'Sources & Uses'].sort());
    assert.strictEqual(r.cellsTotal, 4);
    assert.strictEqual(r.actions[0].type, 'setCellRange');
    assert.strictEqual(r.actions[0].sheet, 'Assumptions');
    assert.strictEqual(r.actions[1].copyToRange, 'A1:A5');
    assert.strictEqual(r.actions[2].allow_overwrite, false);
    console.log('OK bulk_set_cell_ranges fans out N writes across sheets in 1 iteration');
  }

  // 2) Invalid entries surface in "errors" without aborting valid ones
  {
    const r = await executeAgentTool(
      'bulk_set_cell_ranges',
      {
        writes: [
          { sheet: 'A', cells: { A1: { value: 1 } } },
          { sheet: 'B', cells: {} },                              // empty cells
          { cells: { A1: { value: 2 } } },                          // missing sheet (no active context)
          { sheet: 'C', cells: { A2: { value: 3 } } }
        ]
      },
      { messages: [], iteration: 0 }, // no activeSheet
      null
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.applied, 2);
    assert.ok(Array.isArray(r.errors) && r.errors.length === 2);
    console.log('OK bulk_set_cell_ranges surfaces per-entry errors and continues');
  }

  // 3) Over-cap (>16) rejected
  {
    const writes = Array.from({ length: 17 }, () => ({ sheet: 'X', cells: { A1: { value: 1 } } }));
    const r = await executeAgentTool('bulk_set_cell_ranges', { writes }, { messages: [], iteration: 0 }, null);
    assert.match(r.error, /max 16/);
    console.log('OK bulk_set_cell_ranges enforces max 16 writes');
  }

  // 4) Empty / missing -> soft error
  {
    const r1 = await executeAgentTool('bulk_set_cell_ranges', { writes: [] }, { messages: [], iteration: 0 }, null);
    assert.match(r1.error, /non-empty/);
    const r2 = await executeAgentTool('bulk_set_cell_ranges', {}, { messages: [], iteration: 0 }, null);
    assert.match(r2.error, /non-empty/);
    console.log('OK bulk_set_cell_ranges rejects empty / missing writes');
  }

  // 5) bulk_set_format emits N setCellFormat actions
  {
    const r = await executeAgentTool(
      'bulk_set_format',
      {
        formats: [
          { sheet: 'DCF',          target: 'A1:H1', options: { bold: true, backgroundColor: '#0D1F2D' } },
          { sheet: 'DCF',          target: 'B2:F2', options: { numberFormat: '#,##0' } },
          { sheet: 'Assumptions',  target: 'A:A',   options: { columnWidth: 230 } }
        ]
      },
      { messages: [], iteration: 0 },
      null
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.applied, 3);
    assert.strictEqual(r.actions.length, 3);
    assert.strictEqual(r.actions[0].type, 'setCellFormat');
    assert.strictEqual(r.actions[0].sheet, 'DCF');
    assert.deepStrictEqual(r.actions[0].options, { bold: true, backgroundColor: '#0D1F2D' });
    console.log('OK bulk_set_format fans out N format actions in 1 iteration');
  }

  // 6) Invalid format entries reported, others applied
  {
    const r = await executeAgentTool(
      'bulk_set_format',
      {
        formats: [
          { sheet: 'A', target: 'A1', options: { bold: true } },
          { sheet: 'A', target: 'A2' },                                  // missing options
          { sheet: 'A', options: { bold: true } },                       // missing target
          { target: 'A3', options: { bold: true } },                     // missing sheet (no active)
          { sheet: 'A', target: 'A4', options: { italic: true } }
        ]
      },
      { messages: [], iteration: 0 },
      null
    );
    assert.strictEqual(r.applied, 2);
    assert.strictEqual(r.errors.length, 3);
    console.log('OK bulk_set_format surfaces per-entry errors and continues');
  }

  // 7) Over-cap (>32) rejected
  {
    const formats = Array.from({ length: 33 }, () => ({ sheet: 'X', target: 'A1', options: { bold: true } }));
    const r = await executeAgentTool('bulk_set_format', { formats }, { messages: [], iteration: 0 }, null);
    assert.match(r.error, /max 32/);
    console.log('OK bulk_set_format enforces max 32 formats');
  }

  console.log('\nbulk write + format tests completed.');
})().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
