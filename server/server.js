const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const https = require('https');
require('dotenv').config();

const logger = require('./utils/logger');
const { inferPublicBaseUrl } = require('./utils/publicUrl');
const streaming = require('./agents/streaming');
const turns = require('./runtime/turns');
const { LIMITS } = require('./runtime/safetyLimits');

const app = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (process.env.ALLOW_ALL_CORS === 'true') return true;
  if (process.env.ALLOWED_ORIGINS) {
    const allowed = process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
    if (allowed.includes(origin)) return true;
  }
  // Automatically allow the add-in's own public origin (required for Vercel / production)
  if (process.env.PUBLIC_URL) {
    try {
      const publicOrigin = new URL(process.env.PUBLIC_URL).origin;
      if (origin === publicOrigin) return true;
    } catch (_) {}
  }
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
}

const rateBuckets = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = Number(process.env.API_RATE_LIMIT_PER_MIN) || 600;

function rateLimit(req, res, next) {
  if (!req.path.startsWith('/api/') || req.path.includes('/stream/') || req.path === '/api/health') return next();
  const now = Date.now();
  const key = req.ip || req.socket?.remoteAddress || 'local';
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt > RATE_WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return next();
  }
  bucket.count += 1;
  if (bucket.count > RATE_MAX) {
    return res.status(429).json({ error: 'Troppe richieste API ravvicinate. Riprova tra poco.' });
  }
  return next();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets.entries()) {
    if (now - bucket.startedAt > RATE_WINDOW_MS * 2) rateBuckets.delete(key);
  }
}, RATE_WINDOW_MS).unref?.();

// Middleware
app.use(cors({
  origin(origin, callback) {
    callback(null, isAllowedOrigin(origin));
  }
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(bodyParser.json({ limit: `${LIMITS.maxRequestBodyMb}mb` }));
app.use(rateLimit);
app.get('/manifest.xml', sendOfficeManifest);
app.use(express.static(path.join(__dirname, '..')));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url}`);
  next();
});

/* ---------- Auth API (Supabase) ---------- */
const { authenticate, optionalAuth, quotaCheck } = require('./auth/middleware');

app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    const { getSupabase } = require('./supabase/client');
    const supabase = getSupabase();

    const { data: profile } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', req.userId)
      .single();

    const { count: turnsToday } = await supabase
      .from('turns')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.userId)
      .gte('created_at', new Date().toISOString().slice(0, 10));

    const { count: totalTurns } = await supabase
      .from('turns')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.userId);

    res.json({
      id: req.userId,
      email: req.userEmail,
      plan: req.userPlan,
      settings: profile?.settings_json || {},
      turns_today: turnsToday || 0,
      total_turns: totalTurns || 0,
      daily_quota: 10,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------- Supabase Config (per il frontend) ---------- */
const { getSupabaseUrl } = require('./supabase/client');
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: getSupabaseUrl(),
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  });
});

const START_TIME = Date.now();

app.get('/api/health', (req, res) => {
  const llmCfg = getLLMConfig();
  const activeModel = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
  const fallbackModel = process.env.DEEPSEEK_FALLBACK_MODEL || 'deepseek-v4-flash';

  res.json({
    ok: true,
    app: 'excel-ai-agent',
    version: '2.0.0',
    uptimeSec: Math.floor((Date.now() - START_TIME) / 1000),
    model: {
      provider: 'deepseek',
      primary: activeModel,
      fallback: fallbackModel,
    },
  });
});

app.get('/health', (req, res) => res.redirect('/api/health'));

/* ---------- Office Add-in Manifest (dinamico) ---------- */
function sendOfficeManifest(req, res) {
  const baseUrl = inferPublicBaseUrl(req);
  const origin = new URL(baseUrl).origin;

  try {
    // Use the static manifest as a template so VersionOverrides, icons and ribbon buttons are preserved
    const xml = fs.readFileSync(path.join(__dirname, '..', 'manifest.xml'), 'utf8');
    let productionXml = xml.replace(/http:\/\/localhost:3000/g, baseUrl);
    // Ensure AppDomain is a proper origin (protocol + host), not a subpath
    productionXml = productionXml.replace(
      /<AppDomain>[^<]+<\/AppDomain>/g,
      `<AppDomain>${origin}</AppDomain>`
    );
    res.type('application/xml').send(productionXml);
  } catch (err) {
    logger.error('Errore generazione manifest:', err.message);
    // Fallback minimal manifest
    const minimalXml = `<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
           xsi:type="TaskPaneApp">
  <Id>1c7b92c5-a8f4-4e1b-9d3f-2a6e8c0b5d1f</Id>
  <Version>1.0.0</Version>
  <ProviderName>Excel AI</ProviderName>
  <DefaultLocale>it-IT</DefaultLocale>
  <DisplayName DefaultValue="Excel AI"/>
  <Description DefaultValue="AI assistant for Excel"/>
  <IconUrl DefaultValue="${baseUrl}/assets/icon-32.png"/>
  <HighResolutionIconUrl DefaultValue="${baseUrl}/assets/icon-80.png"/>
  <SupportUrl DefaultValue="${baseUrl}/support"/>
  <AppDomains><AppDomain>${origin}</AppDomain></AppDomains>
  <Hosts><Host Name="Workbook"/></Hosts>
  <DefaultSettings>
    <SourceLocation DefaultValue="${baseUrl}/src/taskpane.html"/>
  </DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>
</OfficeApp>`;
    res.type('application/xml').send(minimalXml);
  }
}

/* ---------- Admin Dashboard API ---------- */
function parseAdminSince(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function parseAdminLimit(value, fallback = 50, max = 500) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.floor(numeric), max);
}

function parseAdminBoolean(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return undefined;
}

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

app.get('/api/admin/stats', authenticate, async (req, res) => {
  if (req.userPlan !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const supabase = require('./supabase/client').getSupabase();

    const [{ count: totalUsers }, { count: turnsToday }, { count: errors24h }, { data: llmCalls }] = await Promise.all([
      supabase.from('auth.users').select('*', { count: 'exact', head: true }),
      supabase.from('turns').select('*', { count: 'exact', head: true }).gte('created_at', new Date().toISOString().slice(0, 10)),
      supabase.from('events').select('*', { count: 'exact', head: true }).eq('event_type', 'turn.failed').gte('ts', new Date(Date.now() - 86400000).toISOString()),
      supabase.from('events').select('tokens_in, tokens_out').eq('event_type', 'llm.response').gte('ts', new Date(Date.now() - 86400000).toISOString()),
    ]);

    const tokensIn24h = (llmCalls || []).reduce((s, r) => s + (r.tokens_in || 0), 0);
    const tokensOut24h = (llmCalls || []).reduce((s, r) => s + (r.tokens_out || 0), 0);

    res.json({ totalUsers, turnsToday, errors24h, llmCalls24h: (llmCalls || []).length, tokensIn24h, tokensOut24h });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/events-daily', authenticate, async (req, res) => {
  if (req.userPlan !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const supabase = require('./supabase/client').getSupabase();
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
    // Fill every day in the 30-day window so Chart.js keeps bar widths consistent
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/events-by-type', authenticate, async (req, res) => {
  if (req.userPlan !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const supabase = require('./supabase/client').getSupabase();
    const { data: rows } = await supabase.rpc('admin_event_counts_24h');
    res.json(rows || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/recent-turns', authenticate, async (req, res) => {
  if (req.userPlan !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const supabase = require('./supabase/client').getSupabase();
    const { data: turns } = await supabase
      .from('turns')
      .select('id, user_id, status, task_count, action_count, total_latency_ms, created_at, user:user_id(email)')
      .order('created_at', { ascending: false })
      .limit(50);

    res.json((turns || []).map(t => ({
      id: t.id,
      userId: t.user_id,
      userEmail: t.user?.email,
      status: t.status,
      taskCount: t.task_count,
      actionCount: t.action_count,
      totalLatencyMs: t.total_latency_ms,
      createdAt: t.created_at,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/llm-traces/summary', authenticate, async (req, res) => {
  if (req.userPlan !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { summarizeLlmTraces } = require('./utils/llmTrace');
    const summary = summarizeLlmTraces({
      sinceMs: parseAdminSince(req.query.since),
      turnId: req.query.turnId || undefined,
      eventType: req.query.eventType || undefined,
      label: req.query.label || undefined,
      role: req.query.role || undefined,
      attempt: req.query.attempt || undefined,
      provider: req.query.provider || undefined,
      model: req.query.model || undefined,
      summaryLimit: parseAdminLimit(req.query.summaryLimit, 5000, 50000),
    });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/llm-traces', authenticate, async (req, res) => {
  if (req.userPlan !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { readLlmTraces } = require('./utils/llmTrace');
    const records = readLlmTraces({
      sinceMs: parseAdminSince(req.query.since),
      turnId: req.query.turnId || undefined,
      traceId: req.query.traceId || undefined,
      eventType: req.query.eventType || undefined,
      label: req.query.label || undefined,
      role: req.query.role || undefined,
      attempt: req.query.attempt || undefined,
      provider: req.query.provider || undefined,
      model: req.query.model || undefined,
      limit: parseAdminLimit(req.query.limit, 40, 200),
      descending: req.query.order !== 'asc',
    }).map(mapTracePreview);
    res.json(records);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/llm-traces/:traceId', authenticate, async (req, res) => {
  if (req.userPlan !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { readLlmTraces } = require('./utils/llmTrace');
    const records = readLlmTraces({
      traceId: req.params.traceId,
      limit: parseAdminLimit(req.query.limit, 20, 100),
      descending: false,
    });
    if (!records.length) return res.status(404).json({ error: 'Trace not found' });
    res.json({
      traceId: req.params.traceId,
      count: records.length,
      records,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/runtime-outcomes/summary', authenticate, async (req, res) => {
  if (req.userPlan !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { summarizeRuntimeOutcomes } = require('./utils/runtimeOutcomeSummary');
    const summary = summarizeRuntimeOutcomes({
      sinceMs: parseAdminSince(req.query.since),
      turnId: req.query.turnId || undefined,
      status: req.query.status || undefined,
      reasonCategory: req.query.reasonCategory || undefined,
      escalated: parseAdminBoolean(req.query.escalated),
      summaryLimit: parseAdminLimit(req.query.summaryLimit, 500, 5000),
    });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/runtime-outcomes', authenticate, async (req, res) => {
  if (req.userPlan !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { readRuntimeOutcomes } = require('./utils/runtimeOutcomeSummary');
    const records = readRuntimeOutcomes({
      sinceMs: parseAdminSince(req.query.since),
      turnId: req.query.turnId || undefined,
      status: req.query.status || undefined,
      reasonCategory: req.query.reasonCategory || undefined,
      escalated: parseAdminBoolean(req.query.escalated),
      limit: parseAdminLimit(req.query.limit, 30, 200),
      descending: req.query.order !== 'asc',
    });
    res.json(records);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/users', authenticate, async (req, res) => {
  if (req.userPlan !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const supabase = require('./supabase/client').getSupabase();
    const { data: listData, error: listError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 500 });
    if (listError) throw listError;
    const users = listData?.users || [];

    const { data: turnStats } = await supabase
      .from('turns')
      .select('user_id, status, tokens_in, tokens_out, total_latency_ms, created_at, model')
      .order('created_at', { ascending: false })
      .limit(50000);

    const todayIso = new Date().toISOString().slice(0, 10);
    const statsByUser = {};
    for (const t of (turnStats || [])) {
      const uid = t.user_id;
      if (!statsByUser[uid]) {
        statsByUser[uid] = { totalTurns: 0, turnsToday: 0, tokensIn: 0, tokensOut: 0, latencyMsSum: 0, latencyMsCount: 0, errorTurns: 0, costSum: 0 };
      }
      const s = statsByUser[uid];
      s.totalTurns += 1;
      if (t.created_at && t.created_at.slice(0, 10) === todayIso) s.turnsToday += 1;
      s.tokensIn += t.tokens_in || 0;
      s.tokensOut += t.tokens_out || 0;
      if (t.total_latency_ms) {
        s.latencyMsSum += t.total_latency_ms;
        s.latencyMsCount += 1;
      }
      if (t.status === 'error' || t.status === 'failed') s.errorTurns += 1;
    }

    const { estimateCost } = require('./utils/pricing');
    // Second pass to compute cost per-turn using its own model
    for (const t of (turnStats || [])) {
      const uid = t.user_id;
      if (!statsByUser[uid]) continue;
      statsByUser[uid].costSum += estimateCost(t.model || 'unknown', t.tokens_in || 0, t.tokens_out || 0);
    }

    const enriched = users.map(u => {
      const s = statsByUser[u.id] || { totalTurns: 0, turnsToday: 0, tokensIn: 0, tokensOut: 0, latencyMsSum: 0, latencyMsCount: 0, errorTurns: 0, costSum: 0 };
      const avgLatencyMs = s.latencyMsCount > 0 ? Math.round(s.latencyMsSum / s.latencyMsCount) : 0;
      return {
        id: u.id,
        email: u.email,
        plan: u.app_metadata?.plan || 'free',
        createdAt: u.created_at,
        totalTurns: s.totalTurns,
        turnsToday: s.turnsToday,
        tokensIn: s.tokensIn,
        tokensOut: s.tokensOut,
        avgLatencyMs,
        errorTurns: s.errorTurns,
        estimatedCost: Number((s.costSum || 0).toFixed(4)),
      };
    });

    enriched.sort((a, b) => b.totalTurns - a.totalTurns);
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/costs', authenticate, async (req, res) => {
  if (req.userPlan !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { estimateCostBatch } = require('./utils/pricing');
    const supabase = require('./supabase/client').getSupabase();

    const windows = [
      { key: '24h', since: new Date(Date.now() - 86400000).toISOString() },
      { key: '7d', since: new Date(Date.now() - 7 * 86400000).toISOString() },
      { key: '30d', since: new Date(Date.now() - 30 * 86400000).toISOString() },
    ];

    const result = {};
    for (const w of windows) {
      const { data: rows } = await supabase
        .from('turns')
        .select('model, tokens_in, tokens_out')
        .gte('created_at', w.since);
      const usage = (rows || []).map(r => ({ model: r.model || 'unknown', tokens_in: r.tokens_in || 0, tokens_out: r.tokens_out || 0 }));
      const cost = estimateCostBatch(usage);
      result[w.key] = {
        totalCost: Number(cost.totalCost.toFixed(4)),
        byModel: Object.fromEntries(Object.entries(cost.byModel).map(([k, v]) => [k, Number(v.toFixed(4))])),
        turns: usage.length,
      };
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin', optionalAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'src', 'admin.html'));
});

/* ---------- Turn / Item Runtime (Codex-inspired) ---------- */

app.post('/api/turn/start', authenticate, quotaCheck, async (req, res) => {
  try {
    const { message, context, parentTurnId, modelOverride, speedMode, executionEngine } = req.body;
    if (!message) return res.status(400).json({ error: 'Messaggio richiesto' });

    // Map user-facing speed mode to a concrete strategy preset.
    // Validated against bench/runtime_mode_compare.js (2026-05-28):
    //   fast     : flash, thinking off  -> ~280s, 9 sheets (lighter quality)
    //   balanced : flash, smart thinking, post-write critic -> 254s, 10 sheets
    //   pro      : pro,   smart thinking, post-write critic -> 523s, 10 sheets (verbose reasoning)
    function speedModeStrategyOverlay(mode) {
      const m = String(mode || '').toLowerCase().trim();
      if (m === 'fast') return { speedMode: 'fast', modelOverride: process.env.AGENT_LOOP_FAST_MODEL || 'deepseek-v4-flash', thinkingDisabled: true, postWriteCritic: false };
      if (m === 'pro') return { speedMode: 'pro', modelOverride: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro', thinkingDisabled: false, postWriteCritic: true };
      // default + 'balanced'
      return { speedMode: 'balanced', modelOverride: null, thinkingDisabled: null, postWriteCritic: true };
    }
    const overlay = speedModeStrategyOverlay(speedMode);
    const effectiveModelOverride = modelOverride || overlay.modelOverride || undefined;

    const turn = turns.startTurn(message, context, parentTurnId || null, {
      modelOverride: effectiveModelOverride,
      userId: req.userId,
      speedMode: overlay.speedMode,
      thinkingDisabled: overlay.thinkingDisabled,
      postWriteCritic: overlay.postWriteCritic,
      executionEngineOverride: executionEngine
    });
    res.json({
      turnId: turn.id,
      status: turn.status,
      speedMode: overlay.speedMode
    });
  } catch (error) {
    logger.error('Errore turn/start:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/turn/approve', authenticate, async (req, res) => {
  try {
    const { turnId } = req.body;
    if (!turnId) return res.status(400).json({ error: 'turnId richiesto' });

    const turn = turns.approveTurn(turnId);
    res.json({
      turnId: turn.id,
      status: turn.status
    });
  } catch (error) {
    logger.error('Errore turn/approve:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/turn/step', authenticate, async (req, res) => {
  try {
    const { turnId, clientResult, stepSeq } = req.body || {};
    if (!turnId) return res.status(400).json({ error: 'turnId richiesto' });
    await turns.getTurnRefAsync(turnId);
    const result = await turns.stepTurn(turnId, clientResult, stepSeq);
    res.json(result);
  } catch (error) {
    logger.error('Errore turn/step:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/turn/steer', authenticate, async (req, res) => {
  try {
    const { turnId, text } = req.body;
    if (!turnId || !text) return res.status(400).json({ error: 'turnId e text sono richiesti' });
    await turns.getTurnRefAsync(turnId);
    const item = turns.enqueueSteer(turnId, text);
    res.json({ ok: true, id: item.id, kind: item.kind });
  } catch (error) {
    logger.error('Errore turn/steer:', error.message);
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/turn/respond', authenticate, async (req, res) => {
  try {
    const { turnId, requestId, response } = req.body;
    if (!turnId || !requestId) {
      return res.status(400).json({ error: 'turnId e requestId sono richiesti' });
    }

    await turns.getTurnRefAsync(turnId);
    turns.respondToTurnRequest(turnId, requestId, response || {});
    res.json({ ok: true });
  } catch (error) {
    logger.error('Errore turn/respond:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/turn/respond-batch', authenticate, async (req, res) => {
  try {
    const { turnId, responses } = req.body;
    if (!turnId || !Array.isArray(responses)) {
      return res.status(400).json({ error: 'turnId e responses[] sono richiesti' });
    }

    await turns.getTurnRefAsync(turnId);
    const results = [];
    for (const entry of responses) {
      try {
        turns.respondToTurnRequest(turnId, entry.requestId, entry.response || {});
        results.push({ requestId: entry.requestId, ok: true });
      } catch (err) {
        results.push({ requestId: entry.requestId, ok: false, error: err.message });
      }
    }
    res.json({ ok: true, results });
  } catch (error) {
    logger.error('Errore turn/respond-batch:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/turn/action-result', authenticate, async (req, res) => {
  try {
    const { turnId, taskId } = req.body || {};
    if (!turnId || !taskId) {
      return res.status(400).json({ error: 'turnId e taskId sono richiesti' });
    }

    await turns.getTurnRefAsync(turnId);
    const result = turns.recordActionExecution(turnId, req.body || {});
    res.json({ ok: true, result });
  } catch (error) {
    logger.error('Errore turn/action-result:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/turn/stream/:turnId', authenticate, async (req, res) => {
  const { turnId } = req.params;
  let turn = turns.loadTurn(turnId);
  if (!turn) {
    await turns.getTurnRefAsync(turnId);
    turn = turns.loadTurn(turnId);
  }
  if (!turn) return res.status(404).json({ error: 'Turn non trovato' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  streaming.registerClient(turnId, res);

  if (!streaming.hasHistory(turnId)) {
    streaming.sendEvent(turnId, 'turnStarted', {
      turnId: turn.id,
      status: turn.status,
      objective: turn.objective,
      createdAt: turn.createdAt
    });

    for (const item of turn.items || []) {
      streaming.sendEvent(turnId, 'itemStarted', { item });
      if (item.status !== 'inProgress') {
        streaming.sendEvent(turnId, 'itemCompleted', { item });
      }
    }

    if (turn.plan && Array.isArray(turn.plan.tasks)) {
      streaming.sendEvent(turnId, 'planUpdated', {
        turnId: turn.id,
        objective: turn.plan.objective || turn.objective,
        tasks: turn.plan.tasks
      });
    }

    if (turn.status === 'awaiting_approval') {
      streaming.sendEvent(turnId, 'turnAwaitingApproval', {
        turnId: turn.id,
        status: turn.status,
        taskCount: turn.plan?.tasks?.length || 0
      });
    }

    for (const request of turn.pendingRequests || []) {
      streaming.sendEvent(turnId, 'toolRequest', {
        turnId: turn.id,
        request
      });
    }

    if (turn.status === 'completed' || turn.status === 'error') {
      streaming.sendEvent(turnId, 'turnCompleted', {
        turnId: turn.id,
        status: turn.status,
        error: turn.error || null
      });
    }
  }

  req.on('close', () => {
    streaming.removeClient(turnId, res);
  });
});

app.get('/api/turn/:turnId', (req, res) => {
  const turn = turns.loadTurn(req.params.turnId);
  if (!turn) return res.status(404).json({ error: 'Turn non trovato' });
  res.json(turn);
});

app.post('/api/turn/:turnId/undo', (req, res) => {
  try {
    const result = turns.undoTurn(req.params.turnId);
    res.json(result);
  } catch (error) {
    logger.error('Errore turn/undo:', error.message);
    res.status(400).json({ error: error.message });
  }
});

/* ---------- LLM Config API ---------- */
const { setLLMConfig, getLLMConfig, callLLM } = require('./tools/llm');
const { AGENT_SYSTEM_PROMPT, PROMPT_VARIANTS, getSystemPrompt } = require('./agents/agentLoop');

/* ---------- Cache warmup (preload system prompt to provider cache) ---------- */
const warmupState = { lastRun: 0, inFlight: false };
const WARMUP_COOLDOWN_MS = 5 * 60 * 1000; // 5 min

app.get('/api/config/llm', (req, res) => {
  res.json(getLLMConfig());
});

app.post('/api/config/llm', (req, res) => {
  try {
    const { provider, model, fallbackModel, apiKey, apiUrl } = req.body;
    const update = {};
    if (provider) update.provider = provider;
    if (model !== undefined) update.model = model || null;
    if (fallbackModel !== undefined) update.fallbackModel = fallbackModel || null;
    if (apiKey) update.apiKey = apiKey;
    if (apiUrl) update.apiUrl = apiUrl;
    setLLMConfig(update);
    res.json({ ok: true, config: getLLMConfig() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/agent/prompt-variants', (req, res) => {
  const variants = Object.keys(PROMPT_VARIANTS).map(name => {
    const text = getSystemPrompt(name);
    return { name, file: PROMPT_VARIANTS[name], chars: text.length };
  });
  res.json({ variants, default: process.env.AGENT_PROMPT_VARIANT || 'default' });
});

app.post('/api/llm/warmup', async (req, res) => {
  const now = Date.now();
  if (warmupState.inFlight) return res.json({ ok: true, status: 'in_flight' });
  if (now - warmupState.lastRun < WARMUP_COOLDOWN_MS) {
    return res.json({ ok: true, status: 'cached', lastRunAgo: now - warmupState.lastRun });
  }
  warmupState.inFlight = true;
  warmupState.lastRun = now;
  // Fire-and-forget: respond immediately, run cache priming in background
  res.json({ ok: true, status: 'queued' });
  callLLM({
    system: AGENT_SYSTEM_PROMPT,
    userText: 'Reply ONLY with the JSON: {"thought":"warmup","tool":"done","params":{"summary":"warmup"}}',
    timeoutMs: 30000,
    fallbackTimeoutMs: 15000,
    label: 'Warmup',
    cachePrompt: true,
    thinkingDisabled: true
  }).then(() => {
    logger.info('[Warmup] System prompt cache primed');
  }).catch(err => {
    logger.warn(`[Warmup] failed: ${err.message}`);
  }).finally(() => {
    warmupState.inFlight = false;
  });
});

app.get('/api/config/models', (req, res) => {
  res.json({
    providers: [
      { id: 'deepseek', name: 'DeepSeek (diretta)', models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat'] },
      { id: 'openrouter', name: 'OpenRouter', models: ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro', 'moonshotai/kimi-k2.6', 'openai/gpt-4o-mini'] },
      { id: 'xiaomi', name: 'Xiaomi MiMo', models: ['mimo-v2.5-pro'] },
      { id: 'openai', name: 'OpenAI', models: ['gpt-4o', 'gpt-4o-mini'] },
      { id: 'opencode', name: 'OpenCode Local', models: ['kimi-k2.6'] }
    ],
    current: getLLMConfig()
  });
});

/* ---------- Metrics API ---------- */
const { summarizeMetrics } = require('./utils/metrics');

app.get('/api/metrics/summary', (req, res) => {
  try {
    const since = req.query.since;
    const sinceMs = since ? Date.parse(since) : null;
    const summary = summarizeMetrics(sinceMs);
    res.json(summary);
  } catch (error) {
    logger.error('Errore metrics/summary:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/* ---------- Skills API ---------- */
const { listSkills, readSkill } = require('./skills/loader');

app.get('/api/skills', (req, res) => {
  try {
    const skills = listSkills();
    res.json({ skills, count: skills.length });
  } catch (error) {
    logger.error('Errore skills:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/skills/:name', (req, res) => {
  try {
    const skill = readSkill(req.params.name);
    if (skill.error) {
      return res.status(404).json({ error: skill.error });
    }
    res.json(skill);
  } catch (error) {
    logger.error('Errore skill/read:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/* ---------- Settings API ---------- */
const SETTINGS_PATH = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'user-settings.json')
  : path.join(__dirname, '..', 'docs', 'user-settings.json');

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return {};
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch (e) {
    logger.warn('[Settings] Failed to load:', e.message);
    return {};
  }
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (e) {
    logger.warn('[Settings] Failed to save:', e.message);
  }
}

app.get('/api/settings', (req, res) => {
  try {
    res.json(loadSettings());
  } catch (error) {
    logger.error('Errore settings/get:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    const settings = loadSettings();
    Object.assign(settings, req.body);
    saveSettings(settings);
    res.json({ ok: true, settings });
  } catch (error) {
    logger.error('Errore settings/post:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/* ---------- Wiki API ---------- */
const { loadWikiDomain, searchWiki, listWikiDomains, getWikiContextForPrompt } = require('./wiki/loader');
const { ingestPdf, ingestAllRawPdfs } = require('./wiki/ingest');

app.get('/api/wiki/domains', (req, res) => {
  try {
    const domains = listWikiDomains();
    res.json({ domains });
  } catch (error) {
    logger.error('Errore wiki/domains:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/wiki/:domain/pages', (req, res) => {
  try {
    const pages = loadWikiDomain(req.params.domain);
    res.json({ domain: req.params.domain, pages: pages.map(p => ({ title: p.title, fileName: p.fileName })) });
  } catch (error) {
    logger.error('Errore wiki/pages:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/wiki/:domain/page/:fileName', (req, res) => {
  try {
    const pages = loadWikiDomain(req.params.domain);
    const page = pages.find(p => p.fileName === req.params.fileName);
    if (!page) return res.status(404).json({ error: 'Pagina non trovata' });
    res.json({ domain: req.params.domain, page });
  } catch (error) {
    logger.error('Errore wiki/page:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/wiki/search', (req, res) => {
  try {
    const { q, domains } = req.query;
    if (!q) return res.status(400).json({ error: 'Query param q richiesto' });
    const domainList = domains ? domains.split(',') : null;
    const results = searchWiki(q, domainList);
    res.json({ query: q, results: results.slice(0, 10).map(r => ({ title: r.title, domain: r.domain, score: r.score })) });
  } catch (error) {
    logger.error('Errore wiki/search:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/wiki/ingest', async (req, res) => {
  try {
    const { fileName, domain = 'finance' } = req.body;
    if (!fileName) return res.status(400).json({ error: 'fileName richiesto' });

    const filePath = path.join(__dirname, '..', 'docs', 'wiki', 'raw', fileName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `File non trovato: ${fileName}` });
    }

    const result = await ingestPdf(filePath, { domain });
    res.json({ ok: true, result });
  } catch (error) {
    logger.error('Errore wiki/ingest:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/wiki/ingest-all', async (req, res) => {
  try {
    const { domain = 'finance' } = req.body;
    const result = await ingestAllRawPdfs({ domain });
    res.json({ ok: true, result });
  } catch (error) {
    logger.error('Errore wiki/ingest-all:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/* ---------- Agent Loop API (Claude-style continuous agent with SSE) ---------- */
const { runAgentLoop } = require('./agents/agentLoop');

const activeAgents = new Map(); // agentId -> { promise, state, controller }
const pendingClientRequests = new Map(); // agentId -> Map<requestId, { resolve, reject, timeout }>

function getOrCreateAgentRequests(agentId) {
  let m = pendingClientRequests.get(agentId);
  if (!m) {
    m = new Map();
    pendingClientRequests.set(agentId, m);
  }
  return m;
}

// Per-tool timeouts (ms). Tunable via env CLIENT_TOOL_TIMEOUT_<TOOL_NAME>
// (uppercased, dots/dashes replaced with underscores). Defaults below.
const CLIENT_TOOL_DEFAULT_TIMEOUT_MS = Number(process.env.CLIENT_TOOL_DEFAULT_TIMEOUT_MS) || 30000;
const CLIENT_TOOL_TIMEOUTS_MS = {
  'workbook.readRange': 8000,
  'workbook.readSheet': 12000,
  'workbook.readWorkbook': 20000,
  'workbook.listNamedRanges': 5000,
  'runJavaScript': 60000
};

function getClientToolTimeout(toolName) {
  const envKey = `CLIENT_TOOL_TIMEOUT_${String(toolName).toUpperCase().replace(/[.\-]/g, '_')}`;
  if (process.env[envKey]) {
    const v = Number(process.env[envKey]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return CLIENT_TOOL_TIMEOUTS_MS[toolName] || CLIENT_TOOL_DEFAULT_TIMEOUT_MS;
}

const clientReadCache = require('./utils/clientReadCache');

function makeRequestClientTool(agentId) {
  return async (toolName, params) => {
    // DataLoader-style cache: serve idempotent workbook reads from cache
    // if a recent identical request hit the wire. Invalidated by agentLoop
    // whenever a mutation runs.
    const cached = clientReadCache.get(agentId, toolName, params);
    if (cached !== null) return cached;

    return new Promise((resolve, reject) => {
      const requestId = 'cr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const agentRequests = getOrCreateAgentRequests(agentId);
      const timeoutMs = getClientToolTimeout(toolName);
      const timeout = setTimeout(() => {
        agentRequests.delete(requestId);
        reject(new Error(`Client read timeout (${timeoutMs}ms) for ${toolName}`));
      }, timeoutMs);
      agentRequests.set(requestId, {
        resolve: (value) => {
          clientReadCache.set(agentId, toolName, params, value);
          resolve(value);
        },
        reject,
        timeout
      });

      streaming.sendEvent(agentId, 'toolRequestBatch', {
        requests: [{ id: requestId, toolName, params }]
      });
    });
  };
}

app.post('/api/agent/start', async (req, res) => {
  try {
    const { message, context, modelOverride, promptVariant } = req.body;
    if (!message) return res.status(400).json({ error: 'Messaggio richiesto' });

    /* ---------- Pre-flight sanity check: API key must be configured for the selected provider ---------- */
    const llmConfig = getLLMConfig();
    const provider = llmConfig.provider || process.env.AI_PROVIDER || 'opencode';

    function getProviderApiKey(prov) {
      // If user set a runtime apiKey explicitly, use it
      if (llmConfig.apiKey) return llmConfig.apiKey;
      switch (prov) {
        case 'deepseek': return process.env.DEEPSEEK_API_KEY;
        case 'xiaomi': return process.env.XIAOMI_API_KEY;
        case 'openrouter': return process.env.OPENROUTER_API_KEY;
        case 'openai': return process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
        default: return null;
      }
    }

    const needsKey = provider === 'openai' || provider === 'xiaomi' || provider === 'deepseek' || provider === 'openrouter';
    const providerApiKey = getProviderApiKey(provider);
    if (needsKey && !providerApiKey) {
      const envVar = {
        deepseek: 'DEEPSEEK_API_KEY',
        xiaomi: 'XIAOMI_API_KEY',
        openrouter: 'OPENROUTER_API_KEY',
        openai: 'AI_API_KEY / OPENAI_API_KEY'
      }[provider] || 'API_KEY';
      return res.status(400).json({
        error: `API key mancante per il provider "${provider}". Aggiungi la variabile d'ambiente ${envVar} nel file .env o cambia modello dal menu in alto.`,
        code: 'MISSING_API_KEY',
        provider,
        envVar
      });
    }

    const agentId = 'agent-' + Date.now();
    logger.info(`[AgentLoop] Starting agent ${agentId}: ${message}`);

    // Start agent loop asynchronously with streaming events
    const agentState = { status: 'running', result: null };
    const agentPromise = runAgentLoop(message, context || {}, {
      modelOverride,
      agentId,
      promptVariant,
      onEvent: (eventType, data) => {
        streaming.sendEvent(agentId, eventType, data);
      },
      requestClientTool: makeRequestClientTool(agentId)
    });

    activeAgents.set(agentId, { promise: agentPromise, state: agentState });

    // Run in background; when done, update state
    agentPromise.then(result => {
      agentState.status = result.status;
      agentState.result = result;
      // DON'T send agentCompleted for paused — agentPaused already sent; user must resume
      if (result.status !== 'paused') {
        streaming.sendEvent(agentId, 'agentCompleted', { status: result.status, summary: result.summary, iteration: result.iteration });
      }
    }).catch(err => {
      agentState.status = 'error';
      agentState.error = err.message;
      streaming.sendEvent(agentId, 'agentError', { error: err.message });
    });

    // Return immediately with agentId
    res.json({ agentId, status: 'running' });
  } catch (error) {
    logger.error('Errore agent/start:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/agent/stream/:agentId', authenticate, async (req, res) => {
  const { agentId } = req.params;
  const agent = activeAgents.get(agentId);
  if (!agent) {
    // Still allow SSE connection even if agent not found (might have completed)
    // Client will get no replay and wait for events
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  streaming.registerClient(agentId, res);

  req.on('close', () => {
    streaming.removeClient(agentId, res);
  });
});

app.post('/api/agent/respond', async (req, res) => {
  try {
    const { agentId, userResponse } = req.body;
    if (!agentId || !userResponse) return res.status(400).json({ error: 'agentId e userResponse richiesti' });

    const agent = activeAgents.get(agentId);
    if (!agent || !agent.state || !agent.state.result) {
      return res.status(404).json({ error: 'Agent non trovato o non in pausa' });
    }

    const prev = agent.state.result;
    if (prev.status !== 'paused') {
      return res.status(400).json({ error: 'Agent non è in pausa' });
    }

    // Resume agent loop with user response appended to messages
    const resumeMessages = [...prev.messages];
    resumeMessages.push({ role: 'user', content: `User response: ${JSON.stringify(userResponse)}` });

    // Preserve original context on resume so read fallbacks still work
    const resumeContext = prev.context || {};

    const newAgentId = 'agent-' + Date.now();
    const agentState = { status: 'running', result: null };
    const agentPromise = runAgentLoop(prev.objective || 'Resume', resumeContext, {
      modelOverride: agent.state.modelOverride,
      resumeMessages,
      resumeResults: prev.results,
      resumeIteration: prev.iteration,
      resumeCodeLog: prev.codeLog,
      resumeConsecutiveErrors: prev.consecutiveErrors,
      resumeLastErrorMessage: prev.lastErrorMessage,
      resumeWebSearchCount: prev.webSearchCount,
      resumeParseFailureStreak: prev.parseFailureStreak,
      resumeForceThinkingNext: prev.forceThinkingNext,
      resumeLoadedSkillNames: prev.loadedSkillNames,
      resumeRecentToolTrail: prev.recentToolTrail,
      onEvent: (eventType, data) => {
        streaming.sendEvent(newAgentId, eventType, data);
      },
      requestClientTool: makeRequestClientTool(newAgentId)
    });

    activeAgents.set(newAgentId, { promise: agentPromise, state: agentState });

    agentPromise.then(result => {
      agentState.status = result.status;
      agentState.result = result;
      if (result.status !== 'paused') {
        streaming.sendEvent(newAgentId, 'agentCompleted', { status: result.status, summary: result.summary, iteration: result.iteration });
      }
    }).catch(err => {
      agentState.status = 'error';
      agentState.error = err.message;
      streaming.sendEvent(newAgentId, 'agentError', { error: err.message });
    });

    res.json({ agentId: newAgentId, status: 'running' });
  } catch (error) {
    logger.error('Errore agent/respond:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/agent/:agentId/client-response', (req, res) => {
  const { agentId } = req.params;
  const { requestId, response } = req.body || {};

  if (!requestId) {
    return res.status(400).json({ error: 'requestId required' });
  }

  const agentRequests = pendingClientRequests.get(agentId);
  if (!agentRequests) {
    return res.status(404).json({ error: `Agent ${agentId} not found or already completed` });
  }

  const entry = agentRequests.get(requestId);
  if (!entry) {
    return res.status(404).json({ error: `Request ${requestId} not found (may have timed out)` });
  }

  clearTimeout(entry.timeout);
  agentRequests.delete(requestId);
  if (agentRequests.size === 0) {
    pendingClientRequests.delete(agentId);
  }

  if (response && response.error) {
    entry.reject(new Error(response.error));
  } else {
    entry.resolve(response && response.data !== undefined ? response.data : response);
  }

  res.json({ ok: true });
});

app.get('/api/agent/:agentId', (req, res) => {
  const agent = activeAgents.get(req.params.agentId);
  if (!agent) return res.status(404).json({ error: 'Agent non trovato' });
  res.json({ status: agent.state.status });
});

/* ---------- Avvio server ---------- */

function cleanOldTurns() {
  const turnsDir = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, 'turns')
    : path.join(__dirname, 'turns');
  const maxFiles = Number(process.env.MAX_TURN_FILES) || 100;
  try {
    if (!fs.existsSync(turnsDir)) return;
    const files = fs.readdirSync(turnsDir)
      .filter(f => f.startsWith('turn-') && f.endsWith('.json'))
      .map(f => ({ name: f, path: path.join(turnsDir, f), mtime: fs.statSync(path.join(turnsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    const toDelete = files.slice(maxFiles);
    for (const f of toDelete) {
      fs.unlinkSync(f.path);
      logger.info(`[Startup] Cleaned old turn file: ${f.name}`);
    }
    if (toDelete.length > 0) {
      logger.info(`[Startup] Cleaned ${toDelete.length} old turn files, kept ${Math.min(files.length, maxFiles)} most recent`);
    }
  } catch (e) {
    logger.warn(`[Startup] Could not clean old turns: ${e.message}`);
  }
}

function startServers() {
  cleanOldTurns();
  app.listen(PORT, () => {
    console.log(`Excel AI Agent Server HTTP  -> http://localhost:${PORT}`);
    console.log(`Health check:                 http://localhost:${PORT}/api/health`);
    console.log(`Endpoints turn/item:`);
    console.log(`  POST /api/turn/start`);
    console.log(`  POST /api/turn/approve`);
    console.log(`  POST /api/turn/respond`);
    console.log(`  GET  /api/turn/stream/:turnId`);
  });

  // HTTPS per Excel Desktop
  const keyPath = path.join(__dirname, '..', 'certs', 'key.pem');
  const certPath = path.join(__dirname, '..', 'certs', 'cert.pem');
  const caPath = path.join(__dirname, '..', 'ca.crt');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const options = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), ...(fs.existsSync(caPath) && { ca: fs.readFileSync(caPath) }) };
    https.createServer(options, app).listen(HTTPS_PORT, () => {
      console.log(`Excel AI Agent Server HTTPS -> https://localhost:${HTTPS_PORT}`);
    });
  } else {
    console.log('Certificati HTTPS non trovati in certs/; solo HTTP disponibile.');
  }
}

if (require.main === module) {
  startServers();
}

module.exports = app;
