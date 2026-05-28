'use strict';

/*
 * DataLoader-style cache for client-side workbook reads.
 *
 * Goal: collapse the N+1 problem when the agent re-reads the same range
 * across consecutive iterations. Per-agentId, in-process, TTL-based.
 *
 * Cacheable: workbook.readRange, workbook.readSheet, workbook.readWorkbook,
 * workbook.listNamedRanges (idempotent reads).
 *
 * Invalidation: any mutation (set_cell_range, runJavaScript, sheet creation
 * etc.) in the agent loop calls invalidate(agentId) to wipe stale entries.
 * TTL also expires entries even without an explicit invalidation, so a stale
 * cache cannot live longer than CLIENT_READ_CACHE_TTL_MS (default 30s).
 */

const DEFAULT_TTL_MS = Number(process.env.CLIENT_READ_CACHE_TTL_MS) || 30000;
const MAX_ENTRIES_PER_AGENT = Number(process.env.CLIENT_READ_CACHE_MAX_ENTRIES) || 64;

const cache = new Map(); // agentId -> Map<key, { value, expiresAt }>
const stats = { hits: 0, misses: 0, invalidations: 0, evictions: 0 };

const CACHEABLE_TOOLS = new Set([
  'workbook.readRange',
  'workbook.readSheet',
  'workbook.readWorkbook',
  'workbook.listNamedRanges'
]);

function isCacheable(toolName) {
  return CACHEABLE_TOOLS.has(toolName);
}

function keyFor(toolName, params) {
  let p;
  try { p = JSON.stringify(params || {}); } catch (_) { p = String(params); }
  return `${toolName}::${p}`;
}

function getOrCreate(agentId) {
  let m = cache.get(agentId);
  if (!m) {
    m = new Map();
    cache.set(agentId, m);
  }
  return m;
}

function get(agentId, toolName, params) {
  if (!agentId || !isCacheable(toolName)) return null;
  const m = cache.get(agentId);
  if (!m) { stats.misses++; return null; }
  const k = keyFor(toolName, params);
  const entry = m.get(k);
  if (!entry) { stats.misses++; return null; }
  if (entry.expiresAt < Date.now()) {
    m.delete(k);
    stats.misses++;
    return null;
  }
  stats.hits++;
  return entry.value;
}

function set(agentId, toolName, params, value, opts = {}) {
  if (!agentId || !isCacheable(toolName)) return;
  const ttl = Number(opts.ttlMs) || DEFAULT_TTL_MS;
  const m = getOrCreate(agentId);
  if (m.size >= MAX_ENTRIES_PER_AGENT) {
    // Drop oldest entry (Map iteration order = insertion order)
    const firstKey = m.keys().next().value;
    if (firstKey !== undefined) {
      m.delete(firstKey);
      stats.evictions++;
    }
  }
  m.set(keyFor(toolName, params), { value, expiresAt: Date.now() + ttl });
}

function invalidate(agentId) {
  if (!agentId) return 0;
  const m = cache.get(agentId);
  if (!m) return 0;
  const n = m.size;
  cache.delete(agentId);
  stats.invalidations += n;
  return n;
}

function snapshot() {
  return {
    agents: cache.size,
    totalEntries: Array.from(cache.values()).reduce((sum, m) => sum + m.size, 0),
    ...stats
  };
}

function resetStatsForTests() {
  stats.hits = 0;
  stats.misses = 0;
  stats.invalidations = 0;
  stats.evictions = 0;
}

module.exports = {
  isCacheable,
  get,
  set,
  invalidate,
  keyFor,
  snapshot,
  resetStatsForTests,
  // Exposed for tests:
  _internalCache: cache,
  DEFAULT_TTL_MS,
  MAX_ENTRIES_PER_AGENT
};
