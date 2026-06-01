const assert = require('assert');
const {
  formatToolResultForMessages,
  compactToolParamsForHistory,
  trimDeepArrays,
  compactMessagesToSummary,
  shouldAutoCompactMessages
} = require('../../server/agents/agentLoop.js');

(function main() {
  // 1) Small result -> indented JSON, no truncation marker
  {
    const out = formatToolResultForMessages({ ok: true, value: 42 }, 'noop');
    assert.match(out, /Tool result for noop:/);
    assert.ok(out.includes('"value": 42'), 'indented JSON used for small results');
    assert.ok(!/truncated/i.test(out), 'no truncation marker for small results');
    console.log('OK small tool results pass through with indented JSON');
  }

  // 2) Large array result -> arrays trimmed, marker present
  {
    const bigList = Array.from({ length: 500 }, (_, i) => ({ year: 2000 + i, rev: i * 1000 }));
    const result = { symbol: 'XYZ', income: bigList };
    const out = formatToolResultForMessages(result, 'openbb_equity_income', { maxChars: 4000 });
    assert.ok(out.length <= 4500, `expected <=4500 chars, got ${out.length}`);
    assert.match(out, /truncated/i, 'truncation marker present');
    assert.ok(out.includes('"symbol": "XYZ"'), 'top-level keys preserved');
    console.log(`OK long arrays trimmed within size cap (${out.length} chars)`);
  }

  // 3) trimDeepArrays preserves head + tail with marker for >maxItems arrays
  {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const trimmed = trimDeepArrays(arr, { maxItems: 10 });
    assert.ok(Array.isArray(trimmed));
    assert.ok(trimmed.length <= 12, 'trimmed array shrinks to <=maxItems(+marker)');
    const marker = trimmed.find(x => x && x._truncated);
    assert.ok(marker, 'marker object inserted');
    assert.strictEqual(marker._originalLength, 100);
    assert.ok(trimmed[0] === 0, 'first item preserved');
    assert.ok(trimmed[trimmed.length - 1] === 99, 'last item preserved');
    console.log('OK trimDeepArrays keeps head + tail with explicit marker');
  }

  // 4) _message override honored, with cap applied
  {
    const longMsg = 'A'.repeat(50000);
    const out = formatToolResultForMessages({ _message: longMsg }, 'execute_office_js', { maxChars: 1000 });
    assert.ok(out.length <= 1100, `_message capped, got ${out.length}`);
    assert.match(out, /truncated/i);
    console.log('OK _message override respects the size cap');
  }

  // 5) Hard truncation when even aggressive array trim doesn't help (huge strings)
  {
    const huge = { note: 'X'.repeat(100000) };
    const out = formatToolResultForMessages(huge, 'whatever', { maxChars: 2000 });
    assert.ok(out.length <= 2200, `hard-truncated within bound, got ${out.length}`);
    assert.match(out, /HARD-TRUNCATED/);
    console.log('OK hard truncation fallback when array trimming cannot shrink enough');
  }

  // 6) Circular references should not crash
  {
    const obj = { name: 'self' };
    obj.me = obj;
    const out = formatToolResultForMessages(obj, 'circular', { maxChars: 500 });
    assert.ok(typeof out === 'string' && out.length > 0, 'returns a string instead of throwing');
    console.log('OK circular references degrade gracefully');
  }

  // 7) Auto-compaction keeps a durable semantic summary, not a process-local snip placeholder
  {
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '[id:aaaaaa] Goal: build long model' },
      { role: 'assistant', content: JSON.stringify({ thought: 'created assumptions', tool: 'bulk_set_cell_ranges', params: {} }) },
      { role: 'user', content: '[id:bbbbbb] Tool result for bulk_set_cell_ranges:\n{"ok":true}' },
      { role: 'assistant', content: JSON.stringify({ thought: 'built revenue schedule', tool: 'bulk_set_cell_ranges', params: {} }) },
      { role: 'user', content: '[id:cccccc] POST-WRITE CRITIC clean' },
      { role: 'assistant', content: JSON.stringify({ thought: 'formatted model', tool: 'bulk_set_format', params: {} }) },
      { role: 'user', content: '[id:dddddd] recent keep 1' },
      { role: 'user', content: '[id:eeeeee] recent keep 2' }
    ];
    const result = compactMessagesToSummary(messages, { keepCount: 2 });
    assert.strictEqual(result.applied, true, 'compaction applied');
    assert.ok(messages[1].content.includes('AUTO-COMPACTED HISTORY'), 'summary message inserted');
    assert.ok(!messages[1].content.includes('[snipped:'), 'no process-local snip placeholder');
    assert.ok(messages[1].content.includes('created assumptions'), 'assistant progress preserved');
    assert.ok(messages[1].content.includes('built revenue schedule'), 'later progress preserved');
    assert.ok(!messages[1].content.includes('Tool result for bulk_set_cell_ranges'), 'tool-result noise omitted');
    assert.strictEqual(messages[messages.length - 1].content, '[id:eeeeee] recent keep 2');

    messages.push(
      { role: 'assistant', content: JSON.stringify({ thought: 'added audit checks', tool: 'bulk_set_cell_ranges', params: {} }) },
      { role: 'user', content: '[id:ffffff] recent keep 3' },
      { role: 'assistant', content: JSON.stringify({ thought: 'finalized dashboard', tool: 'bulk_set_format', params: {} }) },
      { role: 'user', content: '[id:gggggg] recent keep 4' }
    );
    const second = compactMessagesToSummary(messages, { keepCount: 2 });
    assert.strictEqual(second.applied, true, 'second compaction applied');
    assert.ok(messages[1].content.includes('created assumptions'), 'previous summary survives second compaction');
    assert.ok(messages[1].content.includes('added audit checks'), 'newer progress included in second compaction');
    console.log('OK auto-compaction writes durable summary and omits tool-result noise');
  }

  // 8) Auto-compaction defaults to history size, while message-count compaction is opt-in
  {
    const manySmallMessages = [
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: 90 }, (_, i) => ({ role: 'user', content: `short ${i}` }))
    ];
    const defaultDecision = shouldAutoCompactMessages(manySmallMessages, { maxChars: 1000000 });
    assert.strictEqual(defaultDecision.shouldCompact, false, 'message count alone does not compact by default');

    const messageLimitDecision = shouldAutoCompactMessages(manySmallMessages, { messageLimit: 80, maxChars: 1000000 });
    assert.strictEqual(messageLimitDecision.shouldCompact, true, 'explicit message limit still compacts');
    assert.strictEqual(messageLimitDecision.reason, 'message_count');

    const largeHistoryDecision = shouldAutoCompactMessages(manySmallMessages, { maxChars: 100, messageLimit: 0 });
    assert.strictEqual(largeHistoryDecision.shouldCompact, true, 'large history compacts by char threshold');
    assert.strictEqual(largeHistoryDecision.reason, 'char_count');
    console.log('OK auto-compaction is size-aware and keeps message-count limit opt-in');
  }

  // 9) Large write params are summarized before entering assistant history
  {
    const cells = {};
    for (let i = 1; i <= 500; i++) {
      cells[`A${i}`] = { formula: `=SUM(B${i}:Z${i})`, value: i };
    }
    const compact = compactToolParamsForHistory('set_cell_range', {
      sheet: 'Dense',
      cells,
      copyToRange: 'A1:Z1000'
    });
    const serialized = JSON.stringify(compact);
    assert.strictEqual(compact.sheet, 'Dense');
    assert.strictEqual(compact.cells, undefined, 'dense history must not expose fake cells params');
    assert.strictEqual(compact.cellsOmitted, true);
    assert.strictEqual(compact.cellsSummary.cellCount, 500);
    assert.strictEqual(compact.cellsSummary.sample.length, 8);
    assert.ok(serialized.length < 2500, `history params should stay compact, got ${serialized.length}`);
    assert.ok(!serialized.includes('A499'), 'tail cell payload omitted from prompt history');
    console.log('OK dense write params are summarized for agent history');
  }

  // 10) Small writes keep real cell params so the model does not learn fake summary shapes
  {
    const compact = compactToolParamsForHistory('set_cell_range', {
      sheet: 'RevenueSchedule',
      cells: {
        A1: { value: 'Mese' },
        A2: { formula: '=ROW()-1' },
        B1: { value: 'Ricavo' },
        B2: { formula: '=Assumptions!$B$5' }
      },
      copyToRange: 'A3:B601'
    });
    assert.ok(compact.cells.A2.formula, 'small write should preserve actual formula cells');
    assert.strictEqual(compact.cellsSummary, undefined);
    console.log('OK small write params remain reusable in agent history');
  }

  // 11) Bulk writes preserve per-sheet/range intent without carrying full payloads
  {
    const writes = Array.from({ length: 40 }, (_, i) => ({
      sheet: `S${i}`,
      cells: Object.fromEntries(Array.from({ length: 120 }, (_, row) => [
        `A${row + 1}`,
        row === 0 ? { value: 'Header' } : { formula: `=B${row + 1}*${i + 1}` }
      ])),
      copyToRange: `B2:B${100 + i}`
    }));
    const compact = compactToolParamsForHistory('bulk_set_cell_ranges', { writes });
    assert.strictEqual(compact.writeCount, 40);
    assert.strictEqual(compact.writes.length, 16);
    assert.strictEqual(compact.truncatedWrites, 24);
    assert.strictEqual(compact.writes[0].cells, undefined, 'dense bulk entries must not expose fake cells params');
    assert.strictEqual(compact.writes[0].cellsSummary.cellCount, 120);
    console.log('OK bulk write params keep intent and cap history size');
  }

  console.log('\ntool result size cap tests completed.');
})();
