/**
 * Admin routes — extracted from server.js for clarity and bug fixing.
 *
 * All routes require authenticate + requireAdmin middleware (applied at mount).
 * Common helpers: asyncHandler, getSupabase, parseSince/Limit/Boolean.
 *
 * Bug fixes vs. inline version:
 *  - requireAdmin moved to middleware (no copy-paste in every route)
 *  - asyncHandler wraps every route (consistent 500 + logging)
 *  - getSupabase() resolved once at module load
 *  - User email lookup uses pagination for >500 users
 *  - Pagination params validated via parseLimit/parseOffset
 *  - Consistent error response: { error: string, requestId? }
 */

const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const requireAdmin = require('../middleware/admin');
const { parseSince, parseLimit, parseOffset, parseBoolean } = require('../utils/admin');
const supabase = require('../supabase/client').getSupabase();
const logger = require('../utils/logger');

let _llmTraceMod, _runtimeOutcomeMod, _pricingMod;
function llmTrace() { return _llmTraceMod || (_llmTraceMod = require('../utils/llmTrace')); }
function runtimeOutcome() { return _runtimeOutcomeMod || (_runtimeOutcomeMod = require('../utils/runtimeOutcomeSummary')); }
function pricing() { return _pricingMod || (_pricingMod = require('../utils/pricing')); }

// Apply to all routes in this router
router.use(requireAdmin);

// ────────────────────────────────────────────────────────────
// Stats
// ────────────────────────────────────────────────────────────
router.get('/stats', asyncHandler(async (req, res) => {
  let totalUsersAuth = 0;
  try {
    const { data: listData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
    totalUsersAuth = listData?.total || 0;
  } catch (_) { /* fallback below */ }

  const since24h = new Date(Date.now() - 86400000).toISOString();
  const since30d = new Date(Date.now() - 30 * 86400000).toISOString();

  const [{ count: turnsToday }, { count: errors24h }, { data: llmCalls }, { data: activeUsers }] = await Promise.all([
    supabase.from('turns').select('*', { count: 'exact', head: true }).gte('created_at', new Date().toISOString().slice(0, 10)),
    supabase.from('events').select('*', { count: 'exact', head: true }).eq('event_type', 'turn.failed').gte('ts', since24h),
    supabase.from('events').select('tokens_in, tokens_out').eq('event_type', 'llm.response').gte('ts', since24h),
    supabase.from('events').select('user_id').gte('ts', since30d).neq('user_id', null),
  ]);

  const distinctUserIds = new Set((activeUsers || []).map(e => e.user_id));
  const totalUsers = totalUsersAuth || distinctUserIds.size;
  const tokensIn24h = (llmCalls || []).reduce((s, r) => s + (r.tokens_in || 0), 0);
  const tokensOut24h = (llmCalls || []).reduce((s, r) => s + (r.tokens_out || 0), 0);

  res.json({
    totalUsers,
    turnsToday: turnsToday || 0,
    errors24h: errors24h || 0,
    llmCalls24h: (llmCalls || []).length,
    tokensIn24h,
    tokensOut24h,
  });
}));

// ────────────────────────────────────────────────────────────
// Events
// ────────────────────────────────────────────────────────────
router.get('/events-daily', asyncHandler(async (req, res) => {
  const { data: turns } = await supabase
    .from('turns')
    .select('status, created_at')
    .gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString())
    .order('created_at', { ascending: true });

  const byDay = {};
  for (const t of (turns || [])) {
    const day = t.created_at.slice(0, 10);
    if (!byDay[day]) byDay[day] = { completed: 0, failed: 0 };
    if (t.status === 'completed') byDay[day].completed++;
    if (t.status === 'error' || t.status === 'failed') byDay[day].failed++;
  }

  // Fill every day in the 30-day window so charts have consistent bar widths
  const days = [];
  const completed = [];
  const failed = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dayStr = d.toISOString().slice(0, 10);
    days.push(dayStr);
    completed.push(byDay[dayStr]?.completed || 0);
    failed.push(byDay[dayStr]?.failed || 0);
  }
  res.json({ days, completed, failed });
}));

router.get('/events-by-type', asyncHandler(async (req, res) => {
  const { data: rows, error } = await supabase.rpc('admin_event_counts_24h');
  if (error) {
    logger.warn('admin_event_counts_24h RPC failed', { message: error.message });
    return res.json([]);
  }
  res.json(rows || []);
}));

// ────────────────────────────────────────────────────────────
// Turns (admin view of all turns)
// ────────────────────────────────────────────────────────────
const emailCache = new Map();
let emailCacheTs = 0;
const EMAIL_CACHE_TTL_MS = 60_000;

async function buildEmailMap() {
  if (Date.now() - emailCacheTs < EMAIL_CACHE_TTL_MS && emailCache.size) return emailCache;
  emailCache.clear();
  try {
    const perPage = 1000;
    let page = 1;
    let total = Infinity;
    while (emailCache.size < total) {
      const { data } = await supabase.auth.admin.listUsers({ page, perPage });
      const users = data?.users || [];
      for (const u of users) emailCache.set(u.id, u.email);
      total = data?.total || emailCache.size;
      if (users.length < perPage) break;
      page++;
      if (page > 50) break; // safety: 50k users max
    }
    emailCacheTs = Date.now();
  } catch (e) {
    logger.warn('buildEmailMap failed', { message: e.message });
  }
  return emailCache;
}

router.get('/recent-turns', asyncHandler(async (req, res) => {
  const limit = parseLimit(req.query.limit, 50, 200);
  const { data: turns, error: turnsError } = await supabase
    .from('turns')
    .select('id, user_id, status, task_count, action_count, total_latency_ms, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (turnsError) throw turnsError;

  const emailMap = await buildEmailMap();
  res.json((turns || []).map(t => ({
    id: t.id,
    userId: t.user_id,
    userEmail: emailMap.get(t.user_id) || null,
    status: t.status,
    taskCount: t.task_count,
    actionCount: t.action_count,
    totalLatencyMs: t.total_latency_ms,
    createdAt: t.created_at,
  })));
}));

// ────────────────────────────────────────────────────────────
// LLM Traces
// ────────────────────────────────────────────────────────────
function mapTracePreview(record) {
  const responseText = typeof record.responseText === 'string' ? record.responseText : '';
  const previewSource = responseText || record.error?.message || '';
  return {
    ts: record.ts,
    traceId: record.traceId,
    turnId: record.turnId || null,
    phase: record.phase || null,
    workflow: record.workflow || null,
    label: record.label || null,
    role: record.role || null,
    eventType: record.eventType,
    provider: record.provider || null,
    model: record.model || null,
    attempt: record.attempt || null,
    latencyMs: record.latencyMs || null,
    promptTokens: record.usage?.prompt_tokens || 0,
    completionTokens: record.usage?.completion_tokens || 0,
    messageCount: record.messageSummary?.count || 0,
    messageChars: record.messageSummary?.chars || 0,
    responseChars: responseText.length || 0,
    preview: previewSource.length > 220 ? `${previewSource.slice(0, 220)}…` : previewSource,
    errorMessage: record.error?.message || null,
  };
}

router.get('/llm-traces/summary', asyncHandler(async (req, res) => {
  const summary = llmTrace().summarizeLlmTraces({
    sinceMs: parseSince(req.query.since),
    turnId: req.query.turnId || undefined,
    eventType: req.query.eventType || undefined,
    label: req.query.label || undefined,
    role: req.query.role || undefined,
    attempt: req.query.attempt || undefined,
    provider: req.query.provider || undefined,
    model: req.query.model || undefined,
    summaryLimit: parseLimit(req.query.summaryLimit, 5000, 50000),
  });
  res.json(summary);
}));

router.get('/llm-traces', asyncHandler(async (req, res) => {
  const records = await llmTrace().readLlmTracesAsync({
    sinceMs: parseSince(req.query.since),
    turnId: req.query.turnId || undefined,
    traceId: req.query.traceId || undefined,
    eventType: req.query.eventType || undefined,
    label: req.query.label || undefined,
    role: req.query.role || undefined,
    attempt: req.query.attempt || undefined,
    provider: req.query.provider || undefined,
    model: req.query.model || undefined,
    limit: parseLimit(req.query.limit, 40, 200),
    descending: req.query.order !== 'asc',
  });
  res.json(records.map(mapTracePreview));
}));

router.get('/llm-traces/:traceId', asyncHandler(async (req, res) => {
  const records = llmTrace().readLlmTraces({
    traceId: req.params.traceId,
    limit: parseLimit(req.query.limit, 20, 100),
    descending: false,
  });
  if (!records.length) return res.status(404).json({ error: 'Trace not found' });
  res.json({ traceId: req.params.traceId, count: records.length, records });
}));

// ────────────────────────────────────────────────────────────
// Runtime Outcomes
// ────────────────────────────────────────────────────────────
router.get('/runtime-outcomes/summary', asyncHandler(async (req, res) => {
  const summary = runtimeOutcome().summarizeRuntimeOutcomes({
    sinceMs: parseSince(req.query.since),
    turnId: req.query.turnId || undefined,
    status: req.query.status || undefined,
    reasonCategory: req.query.reasonCategory || undefined,
    escalated: parseBoolean(req.query.escalated),
    summaryLimit: parseLimit(req.query.summaryLimit, 500, 5000),
  });
  res.json(summary);
}));

router.get('/runtime-outcomes', asyncHandler(async (req, res) => {
  const records = runtimeOutcome().readRuntimeOutcomes({
    sinceMs: parseSince(req.query.since),
    turnId: req.query.turnId || undefined,
    status: req.query.status || undefined,
    reasonCategory: req.query.reasonCategory || undefined,
    escalated: parseBoolean(req.query.escalated),
    limit: parseLimit(req.query.limit, 30, 200),
    descending: req.query.order !== 'asc',
  });
  res.json(records);
}));

// ────────────────────────────────────────────────────────────
// Users
// ────────────────────────────────────────────────────────────
router.get('/users', asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = Math.min(500, Math.max(1, parseInt(req.query.perPage) || 100));
  const search = (req.query.search || '').toLowerCase().trim();

  const { data: listData, error: listError } = await supabase.auth.admin.listUsers({ page, perPage });
  if (listError) throw listError;
  const users = listData?.users || [];

  // Optional: enrich with last activity
  const userIds = users.map(u => u.id);
  let lastActivityMap = {};
  if (userIds.length) {
    const { data: lastEvents } = await supabase
      .from('events')
      .select('user_id, ts')
      .in('user_id', userIds)
      .order('ts', { ascending: false })
      .limit(userIds.length * 2);
    for (const e of (lastEvents || [])) {
      if (!lastActivityMap[e.user_id]) lastActivityMap[e.user_id] = e.ts;
    }
  }

  const enriched = users
    .filter(u => !search || (u.email || '').toLowerCase().includes(search))
    .map(u => ({
      id: u.id,
      email: u.email,
      createdAt: u.created_at,
      lastSignInAt: u.last_sign_in_at,
      providers: u.app_metadata?.providers || [],
      bannedUntil: u.banned_until,
      lastActivity: lastActivityMap[u.id] || null,
    }));

  res.json({ total: listData?.total || users.length, page, perPage, users: enriched });
}));

router.patch('/users/:userId', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { banned, ban_duration } = req.body || {};
  if (typeof userId !== 'string' || !userId) {
    return res.status(400).json({ error: 'userId richiesto' });
  }
  const action = banned ? 'ban' : 'unban';
  const duration = typeof ban_duration === 'string' ? ban_duration : (banned ? '24h' : undefined);
  const { data, error } = await supabase.auth.admin.updateUserById(userId, {
    ban_duration: banned ? duration : 'none',
  });
  if (error) throw error;
  logger.info('admin user update', { userId, action, by: req.userEmail });
  res.json({ ok: true, user: { id: data.user.id, bannedUntil: data.user.banned_until } });
}));

// ────────────────────────────────────────────────────────────
// Leads (demo requests) — query demo_leads with fallback to events
// ────────────────────────────────────────────────────────────
router.get('/leads', asyncHandler(async (req, res) => {
  const limit = parseLimit(req.query.limit, 200, 500);

  // Try demo_leads table first
  try {
    const { data, error } = await supabase
      .from('demo_leads')
      .select('id, created_at, nome, cognome, email, azienda, ruolo, source, user_agent, status, contacted_at, notes')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (!error) return res.json(data || []);
  } catch (_) { /* fall through to events */ }

  // Fallback: events with event_type='demo_request_submitted'
  const { data: evts, error: evErr } = await supabase
    .from('events')
    .select('id, ts, properties')
    .eq('event_type', 'demo_request_submitted')
    .order('ts', { ascending: false })
    .limit(limit);
  if (evErr) throw evErr;
  const leads = (evts || []).map(e => ({
    id: e.id,
    created_at: e.ts,
    nome: e.properties?.nome,
    cognome: e.properties?.cognome,
    email: e.properties?.email,
    azienda: e.properties?.azienda,
    ruolo: e.properties?.ruolo,
    source: 'events',
    user_agent: e.properties?.user_agent,
  }));
  res.json(leads);
}));

// ────────────────────────────────────────────────────────────
// Funnel aggregations
// ────────────────────────────────────────────────────────────
router.get('/funnel', asyncHandler(async (req, res) => {
  const since24h = new Date(Date.now() - 86400000).toISOString();
  const { data: byType, error } = await supabase.rpc('admin_event_counts_24h');
  // Fallback if RPC doesn't exist
  let events = byType;
  if (error || !byType) {
    const { data } = await supabase
      .from('events')
      .select('event_type')
      .gte('ts', since24h);
    const counts = {};
    for (const e of (data || [])) {
      counts[e.event_type] = (counts[e.event_type] || 0) + 1;
    }
    events = Object.entries(counts).map(([event_type, count]) => ({ event_type, count }));
  }

  const get = (name) => (events || []).filter(e => e.event_type === name).reduce((s, e) => s + (e.count || 0), 0);
  res.json({
    pageViews: get('page_view'),
    signups: get('signup_completed'),
    demoRequests: get('demo_request_submitted'),
    demoRuns: get('demo_run_completed'),
    logins: get('login_completed'),
    ctaClicks: get('cta_click'),
  });
}));

// ────────────────────────────────────────────────────────────
// Costs (per model from LLM events)
// ────────────────────────────────────────────────────────────
router.get('/costs', asyncHandler(async (req, res) => {
  const windows = [
    { key: '24h', since: new Date(Date.now() - 86400000).toISOString() },
    { key: '7d', since: new Date(Date.now() - 7 * 86400000).toISOString() },
    { key: '30d', since: new Date(Date.now() - 30 * 86400000).toISOString() },
  ];

  const result = {};
  for (const w of windows) {
    const { data: rows } = await supabase
      .from('events')
      .select('model, tokens_in, tokens_out, session_id')
      .eq('event_type', 'llm.response')
      .gte('ts', w.since);

    const usage = (rows || []).map(r => ({
      model: r.model || 'unknown',
      tokens_in: r.tokens_in || 0,
      tokens_out: r.tokens_out || 0,
    }));
    const cost = pricing().estimateCostBatch(usage);
    const distinctTurnIds = new Set((rows || []).map(r => r.session_id).filter(Boolean));

    result[w.key] = {
      totalCost: Number(cost.totalCost.toFixed(4)),
      byModel: Object.fromEntries(
        Object.entries(cost.byModel).map(([k, v]) => [k, Number(v.toFixed(4))])
      ),
      calls: usage.length,
      turns: distinctTurnIds.size,
    };
  }
  res.json(result);
}));

// ────────────────────────────────────────────────────────────
// Pricing
// ────────────────────────────────────────────────────────────
router.get('/pricing', asyncHandler(async (req, res) => {
  const { MODEL_PRICING } = pricing();
  const rows = Object.entries(MODEL_PRICING).map(([model, prices]) => ({
    model,
    input: prices.input,
    output: prices.output,
    unit: 'per 1M tokens',
    note: prices.input === 0 && prices.output === 0 ? 'local / free' : null,
  }));
  res.json(rows);
}));

// ────────────────────────────────────────────────────────────
// LLM stats (count, cost, latency)
// ────────────────────────────────────────────────────────────
router.get('/llm-stats', asyncHandler(async (req, res) => {
  const sinceMs = parseSince(req.query.since);
  const turnId = req.query.turnId || undefined;
  const eventType = req.query.eventType || 'llm.response';

  let query = supabase.from('events').select('event_type, tokens_in, tokens_out, model, latency_ms, success').eq('event_type', eventType);
  if (sinceMs) query = query.gte('ts', new Date(sinceMs).toISOString());
  if (turnId) query = query.eq('session_id', turnId);
  const { data: rows, error } = await query.limit(50000);
  if (error) throw error;

  const records = (rows || []).map(r => ({ model: r.model || 'unknown', tokens_in: r.tokens_in || 0, tokens_out: r.tokens_out || 0 }));
  const cost = pricing().estimateCostBatch(records);

  const totalLatencyMs = (rows || []).reduce((s, r) => s + (r.latency_ms || 0), 0);
  const avgLatencyMs = rows?.length ? Math.round(totalLatencyMs / rows.length) : 0;
  const errors = (rows || []).filter(r => r.success === false || r.event_type === 'llm.error').length;

  res.json({
    count: rows?.length || 0,
    requests: rows?.length || 0,
    errors,
    fallbacks: (rows || []).filter(r => r.event_type === 'llm.fallback').length,
    totalLatencyMs,
    avgLatencyMs,
    promptTokens: records.reduce((s, r) => s + r.tokens_in, 0),
    completionTokens: records.reduce((s, r) => s + r.tokens_out, 0),
    cost: Number(cost.totalCost.toFixed(4)),
    byModel: Object.fromEntries(Object.entries(cost.byModel).map(([k, v]) => [k, Number(v.toFixed(4))])),
  });
}));

router.get('/llm-events', asyncHandler(async (req, res) => {
  const sinceMs = parseSince(req.query.since);
  const turnId = req.query.turnId || undefined;
  const limit = parseLimit(req.query.limit, 40, 200);

  let query = supabase.from('events').select('*').in('event_type', ['llm.request', 'llm.response', 'llm.error', 'llm.fallback']);
  if (sinceMs) query = query.gte('ts', new Date(sinceMs).toISOString());
  if (turnId) query = query.eq('session_id', turnId);
  const { data: rows, error } = await query.order('ts', { ascending: false }).limit(limit);
  if (error) throw error;

  res.json((rows || []).map(r => ({
    traceId: r.id,
    ts: r.ts,
    eventType: r.event_type,
    turnId: r.session_id,
    model: r.model,
    latencyMs: r.latency_ms,
    promptTokens: r.tokens_in,
    completionTokens: r.tokens_out,
    preview: r.properties?.label || r.properties?.role || '',
  })));
}));

// ────────────────────────────────────────────────────────────
// Live monitor (SSE)
// ────────────────────────────────────────────────────────────
router.get('/live', asyncHandler(async (req, res) => {
  // Lightweight polling-based SSE: pushes a snapshot every 3s.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let alive = true;
  req.on('close', () => { alive = false; clearInterval(timer); });

  async function snapshot() {
    if (!alive) return;
    try {
      const since24h = new Date(Date.now() - 86400000).toISOString();
      const [{ count: turnsToday }, { count: failed }, { data: recent }, { data: llmRows }] = await Promise.all([
        supabase.from('turns').select('*', { count: 'exact', head: true }).gte('created_at', new Date().toISOString().slice(0, 10)),
        supabase.from('turns').select('*', { count: 'exact', head: true }).eq('status', 'failed').gte('created_at', since24h),
        supabase.from('turns').select('id, status, task_count, action_count, created_at, model, total_latency_ms').order('created_at', { ascending: false }).limit(5),
        supabase.from('events').select('tokens_in, tokens_out, model').eq('event_type', 'llm.response').gte('ts', since24h),
      ]);
      const totalTokensIn = (llmRows || []).reduce((s, r) => s + (r.tokens_in || 0), 0);
      const totalTokensOut = (llmRows || []).reduce((s, r) => s + (r.tokens_out || 0), 0);
      const payload = {
        ts: Date.now(),
        turnsToday: turnsToday || 0,
        failed24h: failed || 0,
        tokensIn24h: totalTokensIn,
        tokensOut24h: totalTokensOut,
        recent: (recent || []).map(t => ({
          id: t.id, status: t.status, tasks: t.task_count, actions: t.action_count,
          model: t.model, latency: t.total_latency_ms, createdAt: t.created_at,
        })),
      };
      res.write(`event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch (e) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    }
  }

  await snapshot();
  const timer = setInterval(snapshot, 3000);
}));

module.exports = router;
