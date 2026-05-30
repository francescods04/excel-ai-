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
          { sheet: 'Sources & Uses',  cells: { A2: { formula: '=B2*(1+C2)' } }, copyToRange: 'A2:A5' },
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
    assert.strictEqual(r.actions[1].copyToRange, 'A2:A5');
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

  // 7) Over-cap (>96 by default) rejected
  {
    const formats = Array.from({ length: 97 }, () => ({ sheet: 'X', target: 'A1', options: { bold: true } }));
    const r = await executeAgentTool('bulk_set_format', { formats }, { messages: [], iteration: 0 }, null);
    assert.match(r.error, /max 96/);
    console.log('OK bulk_set_format enforces max 96 formats');
  }

  // 8) format options normalize common LLM spellings/colors before reaching Excel
  {
    const r = await executeAgentTool(
      'bulk_set_format',
      {
        formats: [
          {
            sheet: 'DCF',
            target: 'A1:C1',
            options: {
              backgroundColor: 'blue',
              fontColor: 'rgb(255, 0, 0)',
              horizontalAlignment: 'center',
              vertical_align: 'middle',
              columnWidth: '120',
              wrap: 'false'
            }
          }
        ]
      },
      { messages: [], iteration: 0 },
      null
    );
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.actions[0].options, {
      backgroundColor: '#0000FF',
      fontColor: '#FF0000',
      horizontalAlignment: 'Center',
      verticalAlignment: 'Center',
      columnWidth: 120,
      wrapText: false
    });
    console.log('OK bulk_set_format normalizes colors, aliases, alignment, and numeric/boolean strings');
  }

  // 9) inline write cellStyles normalize for back-compat without relying on presets
  {
    const r = await executeAgentTool(
      'set_cell_range',
      {
        sheet: 'Model',
        cells: {
          A1: {
            value: 'Header',
            cellStyles: {
              bg_color: 'red',
              color: '#fff',
              alignment: 'right'
            }
          }
        }
      },
      { messages: [], iteration: 0 },
      null
    );
    assert.strictEqual(r.actions[0].cells.A1.cellStyles.backgroundColor, '#FF0000');
    assert.strictEqual(r.actions[0].cells.A1.cellStyles.fontColor, '#FFFFFF');
    assert.strictEqual(r.actions[0].cells.A1.cellStyles.horizontalAlignment, 'Right');
    console.log('OK set_cell_range normalizes inline cellStyles for compatibility');
  }

  // 10) invalid format-only entries are rejected after normalization
  {
    const r = await executeAgentTool(
      'bulk_set_format',
      { formats: [{ sheet: 'DCF', target: 'A1', options: { backgroundColor: 'not-a-color' } }] },
      { messages: [], iteration: 0 },
      null
    );
    assert.match(r.error, /no valid formats/);
    assert.match(r.errors[0].reason, /no supported/);
    console.log('OK bulk_set_format rejects entries with no supported normalized options');
  }

  // 10b) bulk_set_format accepts the per-entry option aliases LLM keeps using
  {
    const r = await executeAgentTool(
      'bulk_set_format',
      {
        formats: [
          { sheet: 'A', target: 'A1', cellStyles: { backgroundColor: '#FF0000', bold: true } },
          { sheet: 'A', range:  'A2', styles:     { fontColor: 'blue' } },
          { sheet: 'A', addr:   'A3', formatting: { numberFormat: '0.00%' } }
        ]
      },
      { messages: [], iteration: 0 },
      null
    );
    assert.strictEqual(r.ok, true, 'bulk_set_format should accept cellStyles/styles/formatting + range/addr');
    assert.strictEqual(r.applied, 3);
    assert.deepStrictEqual(r.actions[0].options, { backgroundColor: '#FF0000', bold: true });
    assert.deepStrictEqual(r.actions[1].options, { fontColor: '#0000FF' });
    assert.strictEqual(r.actions[2].options.numberFormat, '0.00%');
    console.log('OK bulk_set_format accepts cellStyles/styles/formatting + range/addr aliases');
  }

  // 10c) set_format also accepts the alias names
  {
    const r = await executeAgentTool(
      'set_format',
      { sheet: 'A', range: 'A1:B1', cellStyles: { backgroundColor: '#0D1F2D', fontColor: '#FFFFFF' } },
      { messages: [], iteration: 0 },
      null
    );
    assert.strictEqual(r.actions.length, 1);
    assert.deepStrictEqual(r.actions[0].options, { backgroundColor: '#0D1F2D', fontColor: '#FFFFFF' });
    assert.strictEqual(r.actions[0].target, 'A1:B1');
    console.log('OK set_format accepts range + cellStyles aliases');
  }

  // 10d) bulk_set_format missing-options error message lists keys actually seen
  {
    const r = await executeAgentTool(
      'bulk_set_format',
      { formats: [{ sheet: 'A', target: 'A1', mystyle: { bold: true } }] },
      { messages: [], iteration: 0 },
      null
    );
    assert.match(r.error, /no valid formats/);
    assert.match(r.errors[0].reason, /Keys seen on this entry: \[mystyle\]/);
    console.log('OK bulk_set_format error reports the unknown keys the LLM passed');
  }

  // 11) bulk_set_notes fans many notes into ONE setNotes action; sheet defaults to active
  {
    const r = await executeAgentTool(
      'bulk_set_notes',
      {
        notes: [
          { sheet: 'Assumptions', cell: 'B3', note: 'WACC 9.2% = rf 4.3% + beta 1.1 x ERP 4.5%' },
          { cell: 'B4', note: 'Terminal growth 2.5%' } // sheet omitted -> defaults to active
        ]
      },
      { messages: [], iteration: 0, activeSheet: 'Assumptions' },
      null
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.applied, 2);
    assert.strictEqual(r.actions.length, 1);
    assert.strictEqual(r.actions[0].type, 'setNotes');
    assert.strictEqual(r.actions[0].notes.length, 2);
    assert.deepStrictEqual(r.actions[0].notes[0], { sheet: 'Assumptions', addr: 'B3', text: 'WACC 9.2% = rf 4.3% + beta 1.1 x ERP 4.5%' });
    assert.strictEqual(r.actions[0].notes[1].sheet, 'Assumptions'); // defaulted from active sheet
    assert.strictEqual(r.actions[0].notes[1].addr, 'B4');
    console.log('OK bulk_set_notes fans many notes into one setNotes action');
  }

  // 12) Invalid note entries reported, valid ones kept
  {
    const r = await executeAgentTool(
      'bulk_set_notes',
      {
        notes: [
          { sheet: 'A', cell: 'A1', note: 'ok' },
          { sheet: 'A', note: 'no cell' },   // missing cell
          { sheet: 'A', cell: 'A2' },         // missing note
          { sheet: 'A', cell: 'A3', note: 'ok2' }
        ]
      },
      { messages: [], iteration: 0 },
      null
    );
    assert.strictEqual(r.applied, 2);
    assert.strictEqual(r.actions[0].notes.length, 2);
    assert.ok(Array.isArray(r.errors) && r.errors.length === 2);
    console.log('OK bulk_set_notes surfaces per-entry errors and continues');
  }

  // 13) Over-cap (>64) rejected
  {
    const notes = Array.from({ length: 65 }, (_, i) => ({ sheet: 'X', cell: `A${i + 1}`, note: 'n' }));
    const r = await executeAgentTool('bulk_set_notes', { notes }, { messages: [], iteration: 0 }, null);
    assert.match(r.error, /max 64/);
    console.log('OK bulk_set_notes enforces max 64 notes');
  }

  // 14) Empty / missing -> soft error
  {
    const r1 = await executeAgentTool('bulk_set_notes', { notes: [] }, { messages: [], iteration: 0 }, null);
    assert.match(r1.error, /non-empty/);
    const r2 = await executeAgentTool('bulk_set_notes', {}, { messages: [], iteration: 0 }, null);
    assert.match(r2.error, /non-empty/);
    console.log('OK bulk_set_notes rejects empty / missing notes');
  }

  // 15) read_format_summary requires a live client and passes through visual-format data
  {
    const noClient = await executeAgentTool('read_format_summary', { sheet: 'DCF', target: 'A1:C5' }, { messages: [], iteration: 0 }, null);
    assert.match(noClient.error, /live Excel client/);

    let captured = null;
    const mockClient = async (toolName, p) => {
      captured = { toolName, p };
      return { sheet: 'DCF', styledCellCount: 1, styledCells: [{ addr: 'B2', fontColor: '#0000FF' }] };
    };
    const ok = await executeAgentTool('read_format_summary', { sheet: 'DCF', target: 'A1:C5', maxRows: 10 }, { messages: [], iteration: 0 }, mockClient);
    assert.strictEqual(captured.toolName, 'workbook.readFormatSummary');
    assert.strictEqual(captured.p.target, 'A1:C5');
    assert.strictEqual(ok.styledCellCount, 1);
    assert.strictEqual(ok.styledCells[0].fontColor, '#0000FF');
    console.log('OK read_format_summary requires a client and passes through visual format data');
  }

  // 16) copyToRange rejected when its source cell holds a text label, even with siblings
  {
    const r = await executeAgentTool(
      'set_cell_range',
      {
        sheet: 'Staffing',
        cells: {
          F3: { value: 'Total' },
          A1: { value: 'Headcount' },
          B3: { formula: '=B2+1' }
        },
        copyToRange: 'F3:J6'
      },
      { messages: [], iteration: 0 },
      null
    );
    assert.match(r.error, /set_cell_range rejected: copyToRange "F3:J6"/);
    assert.match(r.error, /text label \("Total"\)/);
    console.log('OK set_cell_range rejects copyToRange with a text-only source even with sibling cells');
  }

  // 17) copyToRange with a formula source is still accepted
  {
    const r = await executeAgentTool(
      'set_cell_range',
      {
        sheet: 'Staffing',
        cells: { F3: { formula: '=SUM(B3:E3)' }, A1: { value: 'Header' } },
        copyToRange: 'F3:J6'
      },
      { messages: [], iteration: 0 },
      null
    );
    assert.strictEqual(r.actions.length, 1);
    assert.strictEqual(r.actions[0].copyToRange, 'F3:J6');
    console.log('OK set_cell_range still accepts copyToRange when source has a formula');
  }

  console.log('\nbulk write + format tests completed.');
})().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
