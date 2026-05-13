// test/unit/test_action_preview.js
// Regression guard for mutation detection and approval preview coverage.

const assert = require('assert');
const {
  buildActionPreview,
  hasMutationActions,
  isMutationAction,
  MUTATION_ACTION_TYPES
} = require('../../server/runtime/actionPreview');

function test(name, fn) {
  try {
    fn();
    console.log(`OK ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

const REQUIRED_MUTATIONS = [
  'setCellValue',
  'runFormula',
  'setCellFormat',
  'fillRange',
  'writeRange',
  'setCellRange',
  'createChart',
  'addConditionalFormat',
  'setConditionalFormat',
  'createSheet',
  'renameSheet',
  'deleteSheet',
  'duplicateSheet',
  'copyRange',
  'createNamedRange',
  'runJavaScript',
  'suspendCalculation',
  'resumeCalculation',
  'updateSetting'
];

test('all supported Excel mutations are in the preview mutation set', () => {
  for (const type of REQUIRED_MUTATIONS) {
    assert.ok(MUTATION_ACTION_TYPES.has(type), `${type} missing from mutation set`);
    assert.ok(isMutationAction({ type }), `${type} should be classified as mutation`);
  }
});

test('hasMutationActions ignores non-mutating UI actions', () => {
  assert.strictEqual(hasMutationActions([{ type: 'todoWrite', todos: [] }]), false);
});

test('buildActionPreview counts high-risk workbook actions', () => {
  const actions = [
    { type: 'setCellRange', sheet: 'Assumptions', cells: { B2: { value: 100 } } },
    { type: 'renameSheet', oldName: 'Old', newName: 'New' },
    { type: 'deleteSheet', name: 'Scratch' },
    { type: 'runJavaScript', code: 'context.workbook.worksheets.getActiveWorksheet().activate();' },
    { type: 'suspendCalculation' },
    { type: 'resumeCalculation' }
  ];

  const preview = buildActionPreview(actions, { description: 'Hardening test' });
  assert.strictEqual(preview.totalActions, actions.length);
  assert.strictEqual(preview.mutationCount, actions.length);
  assert.ok(preview.items.some(item => item.kind === 'code'));
  assert.ok(preview.items.some(item => item.kind === 'settings'));
});

console.log('\nAction preview tests completed.');
