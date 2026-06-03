'use strict';

// detectSameToolRejectLoop: catches the LLM repeat-broken-bulk pattern
// observed 2026-06-03 in fastfood_bp turn ia3yjxxm. Loops 13-22 emitted
// bulk_set_cell_ranges with empty cells, each rejected server-side, the
// LLM kept re-emitting the same broken shape.

const assert = require('assert');
const { detectSameToolRejectLoop } = require('../../server/agents/agentLoop');

const REJ = { error: 'bulk_set_cell_ranges: no valid writes (...cells must be an object)', errors: [{ index: 0, reason: 'cells must be an object' }] };
const OK = { ok: true, applied: 1, actions: [{}] };

function toolResult(tool, result) { return { type: 'tool', tool, result }; }

// 1) Empty results → null
assert.strictEqual(detectSameToolRejectLoop([]), null);
console.log('OK detectSameToolRejectLoop returns null on empty input');

// 2) 4 rejected bulks but threshold default 5 → null
{
  const xs = Array.from({ length: 4 }, () => toolResult('bulk_set_cell_ranges', REJ));
  assert.strictEqual(detectSameToolRejectLoop(xs), null);
  console.log('OK detectSameToolRejectLoop respects default threshold');
}

// 3) Exactly 5 same-tool rejections → fires
{
  const xs = Array.from({ length: 5 }, () => toolResult('bulk_set_cell_ranges', REJ));
  const r = detectSameToolRejectLoop(xs);
  assert.ok(r);
  assert.strictEqual(r.pattern, 'same_tool_reject_loop');
  assert.strictEqual(r.tool, 'bulk_set_cell_ranges');
  assert.strictEqual(r.count, 5);
  assert.ok(/cells/.test(r.sampleReason));
  console.log('OK detectSameToolRejectLoop fires at threshold');
}

// 4) Non-write tool repeated → not flagged
{
  const xs = Array.from({ length: 6 }, () => toolResult('get_cell_ranges', { error: 'whatever' }));
  assert.strictEqual(detectSameToolRejectLoop(xs), null);
  console.log('OK detectSameToolRejectLoop ignores read tools');
}

// 5) Mixed tools → not flagged
{
  const xs = [
    toolResult('bulk_set_cell_ranges', REJ),
    toolResult('set_cell_range', REJ),
    toolResult('bulk_set_cell_ranges', REJ),
    toolResult('bulk_set_cell_ranges', REJ),
    toolResult('bulk_set_cell_ranges', REJ)
  ];
  assert.strictEqual(detectSameToolRejectLoop(xs), null);
  console.log('OK detectSameToolRejectLoop requires same tool in window');
}

// 6) One success in the tail breaks the streak → not flagged
{
  const xs = [
    toolResult('bulk_set_cell_ranges', REJ),
    toolResult('bulk_set_cell_ranges', REJ),
    toolResult('bulk_set_cell_ranges', OK), // success
    toolResult('bulk_set_cell_ranges', REJ),
    toolResult('bulk_set_cell_ranges', REJ)
  ];
  assert.strictEqual(detectSameToolRejectLoop(xs), null);
  console.log('OK detectSameToolRejectLoop bails if any tail entry succeeded');
}

// 7) MEAT CREW pattern (10 loops same broken bulk) → fires
{
  const xs = Array.from({ length: 10 }, () => toolResult('bulk_set_cell_ranges', REJ));
  const r = detectSameToolRejectLoop(xs);
  assert.ok(r);
  assert.strictEqual(r.count, 5); // only the last 5 counted (window)
  console.log('OK detectSameToolRejectLoop catches the MEAT CREW pattern');
}

// 8) Custom limit
{
  const xs = Array.from({ length: 3 }, () => toolResult('set_cell_range', REJ));
  const r = detectSameToolRejectLoop(xs, { limit: 3 });
  assert.ok(r);
  assert.strictEqual(r.tool, 'set_cell_range');
  assert.strictEqual(r.count, 3);
  console.log('OK detectSameToolRejectLoop honors custom limit');
}

console.log('\nsame-tool-reject loop tests completed.');
