// Layer B: sheet-name canonicalization guard. Verifies the helpers used by
// set_cell_range / bulk_set_cell_ranges / create_sheet / bulk_create_sheets.

const assert = require('assert');
const {
  normalizeSheetName,
  buildKnownSheetMap,
  findNearDuplicateSheet,
  nearDupSheetError
} = require('../../server/agents/agentLoop');

function main() {
  // 1) normalize is whitespace + punctuation + case insensitive
  assert.strictEqual(normalizeSheetName('Cost Breakdown'), 'costbreakdown');
  assert.strictEqual(normalizeSheetName('CostBreakdown'), 'costbreakdown');
  assert.strictEqual(normalizeSheetName('cost-breakdown'), 'costbreakdown');
  assert.strictEqual(normalizeSheetName('Cost_Breakdown'), 'costbreakdown');
  assert.strictEqual(normalizeSheetName('Cost&Breakdown'), 'costbreakdown');
  assert.strictEqual(normalizeSheetName('Cost (Breakdown)'), 'costbreakdown');
  assert.strictEqual(normalizeSheetName("Cost's Breakdown"), 'costsbreakdown');
  assert.notStrictEqual(normalizeSheetName('CostBreakdown'), normalizeSheetName('CostsBreakdown'));
  console.log('OK normalize collapses whitespace + punctuation + case');

  // 2) buildKnownSheetMap pulls from workbookSheets + slice scope
  const ctx = {
    workbookSheets: ['Sheet1', 'Assumptions', 'Cost Breakdown'],
    _sliceScope: { sheets_owned: ['Per-Floor Detail'], may_read_from: ['Revenue Schedule!A1:Z10'] },
    _knownSheetsRuntime: ['Custom Sheet']
  };
  const map = buildKnownSheetMap(ctx);
  assert.strictEqual(map.get('costbreakdown'), 'Cost Breakdown');
  assert.strictEqual(map.get('perfloordetail'), 'Per-Floor Detail');
  assert.strictEqual(map.get('revenueschedule'), 'Revenue Schedule');
  assert.strictEqual(map.get('customsheet'), 'Custom Sheet');
  console.log('OK known map aggregates workbookSheets + slice scope + runtime');

  // 3) findNearDuplicateSheet returns canonical when target differs only in punct
  assert.strictEqual(findNearDuplicateSheet('CostBreakdown', map), 'Cost Breakdown');
  assert.strictEqual(findNearDuplicateSheet('cost_breakdown', map), 'Cost Breakdown');
  assert.strictEqual(findNearDuplicateSheet('Cost-Breakdown', map), 'Cost Breakdown');
  console.log('OK near-dup detected across case/space/punct variants');

  // 4) exact match → not flagged
  assert.strictEqual(findNearDuplicateSheet('Cost Breakdown', map), null);
  assert.strictEqual(findNearDuplicateSheet('Assumptions', map), null);
  console.log('OK exact match returns null (no false positive)');

  // 5) unknown sheet → null (caller will create)
  assert.strictEqual(findNearDuplicateSheet('NewSheet', map), null);
  console.log('OK truly new sheet returns null');

  // 6) error message is informative + actionable
  const msg = nearDupSheetError('CostBreakdown', 'Cost Breakdown');
  assert.ok(msg.includes('CostBreakdown'));
  assert.ok(msg.includes('Cost Breakdown'));
  assert.ok(/exact name/i.test(msg));
  assert.ok(/Do NOT create/i.test(msg));
  console.log('OK error message names both target and canonical, with actionable guidance');

  // 7) empty / non-string inputs handled
  assert.strictEqual(findNearDuplicateSheet('', map), null);
  assert.strictEqual(findNearDuplicateSheet(null, map), null);
  assert.strictEqual(findNearDuplicateSheet(undefined, map), null);
  console.log('OK empty/null target safely returns null');

  console.log('\nLayer B sheet-name guard tests completed.');
}

main();
