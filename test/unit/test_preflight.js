// test/unit/test_preflight.js
// Unit test per preflight read logic (getCellRangeBounds + conflict detection)

const assert = require('assert');
const { getCellRangeBounds, colToIndex, indexToCol } = require('../../server/agents/agentLoop');

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// --- colToIndex / indexToCol round-trip ---
test('colToIndex A -> 1', () => assert.strictEqual(colToIndex('A'), 1));
test('colToIndex Z -> 26', () => assert.strictEqual(colToIndex('Z'), 26));
test('colToIndex AA -> 27', () => assert.strictEqual(colToIndex('AA'), 27));
test('colToIndex AZ -> 52', () => assert.strictEqual(colToIndex('AZ'), 52));
test('indexToCol 1 -> A', () => assert.strictEqual(indexToCol(1), 'A'));
test('indexToCol 26 -> Z', () => assert.strictEqual(indexToCol(26), 'Z'));
test('indexToCol 27 -> AA', () => assert.strictEqual(indexToCol(27), 'AA'));
test('indexToCol 52 -> AZ', () => assert.strictEqual(indexToCol(52), 'AZ'));

// --- getCellRangeBounds ---
test('bounds single cell', () => {
  const bounds = getCellRangeBounds({ 'B5': 42 });
  assert.strictEqual(bounds, 'B5:B5');
});

test('bounds rectangular range', () => {
  const bounds = getCellRangeBounds({
    'A1': 1, 'B1': 2, 'C1': 3,
    'A2': 4, 'B2': 5, 'C2': 6
  });
  assert.strictEqual(bounds, 'A1:C2');
});

test('bounds scattered cells', () => {
  const bounds = getCellRangeBounds({
    'D10': 1, 'F12': 2
  });
  assert.strictEqual(bounds, 'D10:F12');
});

test('bounds empty map', () => {
  const bounds = getCellRangeBounds({});
  assert.strictEqual(bounds, null);
});

test('bounds large columns', () => {
  const bounds = getCellRangeBounds({ 'AA100': 1, 'AB101': 2 });
  assert.strictEqual(bounds, 'AA100:AB101');
});

// --- Simulazione preflight conflict ---
test('preflight conflict detection logic', () => {
  // Simula i dati restituiti da workbook.readRange
  const preflightValues = [
    ['', '', ''],
    ['', 42, ''],
    ['', '', '']
  ];
  const bounds = 'A1:C3';
  const nonEmpty = [];
  for (let r = 0; r < preflightValues.length && nonEmpty.length < 5; r++) {
    for (let c = 0; c < preflightValues[r].length && nonEmpty.length < 5; c++) {
      const v = preflightValues[r][c];
      if (v !== null && v !== undefined && v !== '') {
        nonEmpty.push({ row: r + 1, col: indexToCol(colToIndex(bounds.match(/^([A-Z]+)/)[1]) + c), value: String(v).slice(0, 50) });
      }
    }
  }
  assert.strictEqual(nonEmpty.length, 1);
  assert.strictEqual(nonEmpty[0].row, 2);
  assert.strictEqual(nonEmpty[0].col, 'B');
  assert.strictEqual(nonEmpty[0].value, '42');
});

console.log('\n🧪 Preflight tests completati.');
