const assert = require('assert');
const { executeAgentTool } = require('../../server/agents/agentLoop.js');

(async function main() {
  // 1) bulk_create_sheets emits N actions in one iteration
  {
    const r = await executeAgentTool(
      'bulk_create_sheets',
      { names: ['Assumptions', 'WACC', 'DCF', 'Sensitivity'] },
      { messages: [], iteration: 0 },
      null
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 4);
    assert.deepStrictEqual(r.sheetsCreated, ['Assumptions', 'WACC', 'DCF', 'Sensitivity']);
    assert.strictEqual(r.actions.length, 4);
    assert.strictEqual(r.actions[0].type, 'createSheet');
    assert.strictEqual(r.actions[0].name, 'Assumptions');
    console.log('OK bulk_create_sheets emits N createSheet actions in one tool result');
  }

  // 2) Dedupe by name + trim whitespace
  {
    const r = await executeAgentTool(
      'bulk_create_sheets',
      { names: ['  Cover  ', 'Cover', 'Debt Schedule', '   '] },
      { messages: [], iteration: 0 },
      null
    );
    assert.deepStrictEqual(r.sheetsCreated, ['Cover', 'Debt Schedule']);
    assert.strictEqual(r.actions.length, 2);
    console.log('OK bulk_create_sheets dedupes by name and skips empty entries');
  }

  // 3) Empty / missing names array -> soft error
  {
    const r = await executeAgentTool(
      'bulk_create_sheets',
      { names: [] },
      { messages: [], iteration: 0 },
      null
    );
    assert.match(r.error, /non-empty/);
  }
  {
    const r = await executeAgentTool(
      'bulk_create_sheets',
      {},
      { messages: [], iteration: 0 },
      null
    );
    assert.match(r.error, /non-empty/);
    console.log('OK bulk_create_sheets rejects empty / missing names');
  }

  // 4) Over-cap (>32) rejected as a whole
  {
    const names = Array.from({ length: 33 }, (_, i) => `S${i}`);
    const r = await executeAgentTool(
      'bulk_create_sheets',
      { names },
      { messages: [], iteration: 0 },
      null
    );
    assert.match(r.error, /max 32/);
    console.log('OK bulk_create_sheets enforces max 32 sheets per call');
  }

  // 5) bulk_create_named_ranges emits N createNamedRange actions
  {
    const r = await executeAgentTool(
      'bulk_create_named_ranges',
      {
        ranges: [
          { name: 'Revenue',  refers_to: '=Assumptions!B3' },
          { name: 'TaxRate',  refers_to: '=Assumptions!B5' },
          { name: 'WACC',     refers_to: '=WACC!B10' }
        ]
      },
      { messages: [], iteration: 0 },
      null
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 3);
    assert.deepStrictEqual(r.rangesCreated, ['Revenue', 'TaxRate', 'WACC']);
    assert.strictEqual(r.actions.length, 3);
    assert.strictEqual(r.actions[0].type, 'createNamedRange');
    assert.strictEqual(r.actions[0].refersTo, '=Assumptions!B3');
    assert.strictEqual(r.skipped, undefined);
    console.log('OK bulk_create_named_ranges emits N createNamedRange actions');
  }

  // 6) Invalid entries are reported in "skipped" but valid ones still apply
  {
    const r = await executeAgentTool(
      'bulk_create_named_ranges',
      {
        ranges: [
          { name: 'Good',     refers_to: '=Assumptions!B3' },
          { name: '',         refers_to: '=Assumptions!B5' },          // missing name
          { name: 'NoRef',    refers_to: '' },                          // missing refers_to
          { name: 'Good',     refers_to: '=Assumptions!B7' },          // duplicate
          { name: 'Second',   refers_to: '=Assumptions!B9' }
        ]
      },
      { messages: [], iteration: 0 },
      null
    );
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.rangesCreated, ['Good', 'Second']);
    assert.strictEqual(r.actions.length, 2);
    assert.ok(Array.isArray(r.skipped) && r.skipped.length === 3, 'three skipped entries reported');
    console.log('OK bulk_create_named_ranges reports invalid entries and applies valid ones');
  }

  // 7) All-invalid batch -> error
  {
    const r = await executeAgentTool(
      'bulk_create_named_ranges',
      { ranges: [{ name: '', refers_to: '' }] },
      { messages: [], iteration: 0 },
      null
    );
    assert.match(r.error, /no valid/);
    console.log('OK bulk_create_named_ranges errors when nothing valid');
  }

  console.log('\nbulk setup tests completed.');
})().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
