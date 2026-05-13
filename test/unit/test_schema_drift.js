// test/unit/test_schema_drift.js
// Verifies that LLM-side TOOL_DEFINITIONS (agentLoop) and server-side registry
// schemas stay aligned for shared tools.

const assert = require('assert');
const { TOOL_DEFINITIONS } = require('../../server/agents/agentLoop');
const { registry } = require('../../server/tools/registry');
const SHARED = require('../../server/tools/schemas');

function test(name, fn) {
  try { fn(); console.log(`✅ ${name}`); }
  catch (e) { console.error(`❌ ${name}: ${e.message}`); process.exitCode = 1; }
}

function findLLMTool(name) {
  return TOOL_DEFINITIONS.find(t => (t.function?.name || t.name) === name);
}

function getRegEntry(name) {
  return registry.get ? registry.get(name) : null;
}

// 1. Shared schemas exist
test('SHARED.SET_CELL_RANGE exported', () => {
  assert.ok(SHARED.SET_CELL_RANGE);
  assert.strictEqual(SHARED.SET_CELL_RANGE.type, 'object');
});

// 2. agentLoop set_cell_range uses shared schema
test('agentLoop set_cell_range references SHARED.SET_CELL_RANGE', () => {
  const tool = findLLMTool('set_cell_range');
  assert.ok(tool, 'set_cell_range not found in TOOL_DEFINITIONS');
  assert.strictEqual(tool.function.parameters, SHARED.SET_CELL_RANGE,
    'agentLoop schema is NOT the shared object reference — drift risk');
});

// 3. Required fields invariant: sheet + cells must be required
test('set_cell_range requires sheet + cells', () => {
  const sch = SHARED.SET_CELL_RANGE;
  assert.deepStrictEqual([...sch.required].sort(), ['cells', 'sheet']);
});

// 4. Registry excel.setCellRange schema requires same fields (compatibility check)
test('registry.excel.setCellRange schema-compatible with shared', () => {
  if (!registry.meta) {
    console.log('   (skipped — registry.meta not exposed)');
    return;
  }
  const meta = registry.meta('excel.setCellRange');
  if (!meta) {
    console.log('   (skipped — excel.setCellRange not registered)');
    return;
  }
  const regSchema = meta.schema;
  assert.ok(regSchema, 'registry entry missing schema');
  assert.strictEqual(regSchema, SHARED.SET_CELL_RANGE,
    'registry schema is NOT the shared object reference — drift risk');
  assert.ok(regSchema.required.includes('sheet'), 'registry must require sheet');
  assert.ok(regSchema.required.includes('cells'), 'registry must require cells');
  // Both must accept the same top-level optional props
  ['copyToRange', 'allow_overwrite'].forEach(p => {
    assert.ok(p in regSchema.properties, `registry schema missing optional prop: ${p}`);
    assert.ok(p in SHARED.SET_CELL_RANGE.properties, `shared schema missing optional prop: ${p}`);
  });
});

// 5. Cell spec (value | formula) compatibility
test('CELL_SPEC supports value, formula, note, cellStyles, borderStyles', () => {
  const props = SHARED.CELL_SPEC.properties;
  ['value', 'formula', 'note', 'cellStyles', 'borderStyles'].forEach(k => {
    assert.ok(k in props, `CELL_SPEC missing property: ${k}`);
  });
});

console.log('\n🧪 Schema drift tests completati.');
