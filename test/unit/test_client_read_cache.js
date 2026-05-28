const assert = require('assert');
const cache = require('../../server/utils/clientReadCache');

(function main() {
  cache.resetStatsForTests();

  // 1) Idempotent reads cache hits across identical calls
  {
    cache.invalidate('agent-1');
    cache.set('agent-1', 'workbook.readRange', { sheet: 'A', target: 'A1:B2' }, [[1, 2], [3, 4]]);
    const hit = cache.get('agent-1', 'workbook.readRange', { sheet: 'A', target: 'A1:B2' });
    assert.deepStrictEqual(hit, [[1, 2], [3, 4]], 'identical params hit cache');
    const miss = cache.get('agent-1', 'workbook.readRange', { sheet: 'A', target: 'A1:B3' });
    assert.strictEqual(miss, null, 'different params miss cache');
    console.log('OK clientReadCache distinguishes by tool+params');
  }

  // 2) Non-cacheable tools never store anything
  {
    cache.invalidate('agent-2');
    assert.strictEqual(cache.isCacheable('workbook.readRange'), true);
    assert.strictEqual(cache.isCacheable('runJavaScript'), false);
    assert.strictEqual(cache.isCacheable('excel.setCellRange'), false);
    cache.set('agent-2', 'runJavaScript', { code: 'return 1' }, 1);
    const v = cache.get('agent-2', 'runJavaScript', { code: 'return 1' });
    assert.strictEqual(v, null, 'mutations never cached');
    console.log('OK only read tools are cacheable');
  }

  // 3) Invalidation wipes a single agent without touching others
  {
    cache.invalidate('agent-3');
    cache.invalidate('agent-4');
    cache.set('agent-3', 'workbook.readSheet', { sheet: 'A' }, { v: 'a3' });
    cache.set('agent-4', 'workbook.readSheet', { sheet: 'A' }, { v: 'a4' });
    const n = cache.invalidate('agent-3');
    assert.strictEqual(n, 1);
    assert.strictEqual(cache.get('agent-3', 'workbook.readSheet', { sheet: 'A' }), null);
    assert.deepStrictEqual(cache.get('agent-4', 'workbook.readSheet', { sheet: 'A' }), { v: 'a4' });
    console.log('OK invalidate scoped to one agentId');
  }

  // 4) TTL expiry
  {
    cache.invalidate('agent-5');
    cache.set('agent-5', 'workbook.readRange', { sheet: 'A', target: 'A1' }, 42, { ttlMs: 25 });
    assert.strictEqual(cache.get('agent-5', 'workbook.readRange', { sheet: 'A', target: 'A1' }), 42);
    return new Promise(resolve => setTimeout(() => {
      const after = cache.get('agent-5', 'workbook.readRange', { sheet: 'A', target: 'A1' });
      assert.strictEqual(after, null, 'entry expired by TTL');
      console.log('OK TTL expiry removes stale entries');
      resolve();
    }, 50));
  }
})().then(() => {
  // 5) LRU-style eviction past MAX_ENTRIES_PER_AGENT
  cache.invalidate('agent-6');
  const cap = cache.MAX_ENTRIES_PER_AGENT;
  for (let i = 0; i < cap + 5; i++) {
    cache.set('agent-6', 'workbook.readRange', { sheet: 'A', target: `A${i}:A${i}` }, i);
  }
  const internal = cache._internalCache.get('agent-6');
  assert.ok(internal.size <= cap, `agent cache stays under cap (${internal.size} <= ${cap})`);
  console.log('OK eviction keeps agent cache bounded');

  // 6) Stats track hits / misses / invalidations
  cache.resetStatsForTests();
  cache.invalidate('agent-7');
  cache.set('agent-7', 'workbook.readRange', { sheet: 'A', target: 'A1' }, 1);
  cache.get('agent-7', 'workbook.readRange', { sheet: 'A', target: 'A1' }); // hit
  cache.get('agent-7', 'workbook.readRange', { sheet: 'A', target: 'B1' }); // miss
  cache.invalidate('agent-7');
  const snap = cache.snapshot();
  assert.strictEqual(snap.hits, 1);
  assert.strictEqual(snap.misses, 1);
  assert.strictEqual(snap.invalidations, 1);
  console.log('OK stats track hits/misses/invalidations');

  console.log('\nclient read cache tests completed.');
}).catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
