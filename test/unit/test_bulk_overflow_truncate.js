// bulk_set_cell_ranges with >32 writes should auto-truncate + tell the LLM
// to send a follow-up call, rather than hard-rejecting (which spawned a
// retry loop that crashed the Vercel function on long write batches).

const assert = require('assert');
const { executeAgentTool } = require('../../server/agents/agentLoop');

async function main() {
  const writes = [];
  for (let i = 0; i < 50; i++) {
    writes.push({ sheet: 'Costs', cells: { [`A${i + 2}`]: { value: `row${i}` } } });
  }
  const ctx = { activeSheet: 'Sheet1', workbookSheets: ['Sheet1', 'Costs'] };
  const r = await executeAgentTool('bulk_set_cell_ranges', { writes }, ctx);
  assert.strictEqual(r.ok, true, 'should succeed (truncated, not rejected)');
  assert.strictEqual(r.applied, 32, `expected 32 applied, got ${r.applied}`);
  assert.strictEqual(r.truncatedCount, 18, `expected truncatedCount=18, got ${r.truncatedCount}`);
  assert.ok(/Bulk overflow auto-handled/.test(r._message));
  assert.ok(/follow-up bulk_set_cell_ranges/.test(r._message));
  assert.ok(/18 entries/.test(r._message));
  console.log('OK 50-write bulk: applied 32, remaining 18 reported in _message');

  // 32 writes exactly: no truncation
  const exact = [];
  for (let i = 0; i < 32; i++) {
    exact.push({ sheet: 'Costs', cells: { [`A${i + 2}`]: { value: i } } });
  }
  const r2 = await executeAgentTool('bulk_set_cell_ranges', { writes: exact }, ctx);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.applied, 32);
  assert.strictEqual(r2.truncatedCount, undefined);
  assert.strictEqual(r2._message, undefined);
  console.log('OK 32-write bulk: no truncation, no message');

  // Empty writes: still rejected
  const empty = await executeAgentTool('bulk_set_cell_ranges', { writes: [] }, ctx);
  assert.ok(empty.error && /non-empty array/.test(empty.error));
  console.log('OK empty writes still rejected');

  console.log('\nBulk overflow truncate tests completed.');
}

main().catch(e => { console.error(e); process.exit(1); });
