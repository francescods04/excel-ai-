const assert = require('assert');
const { formatToolResultForMessages, trimDeepArrays, compactMessagesToSummary } = require('../../server/agents/agentLoop.js');

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

  console.log('\ntool result size cap tests completed.');
})();
