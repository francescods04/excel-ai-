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

/* ---------- User dashboard endpoints ---------- */
app.get('/api/me/turns', authenticate, async (req, res) => {
  try {
    const { getSupabase } = require('./supabase/client');
    const supabase = getSupabase();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const { data, error } = await supabase
      .from('turns')
      .select('id, status, input_message_length, task_count, action_count, error_type, error_message, model, created_at, completed_at, total_latency_ms, tokens_in, tokens_out')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ turns: data || [], limit, offset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/me/stats', authenticate, async (req, res) => {
  try {
    const { getSupabase } = require('./supabase/client');
    const supabase = getSupabase();
    const userId = req.userId;

    const since7d = new Date(Date.now() - 7 * 86400000).toISOString();
    const since30d = new Date(Date.now() - 30 * 86400000).toISOString();

    const [
      { count: totalTurns },
      { count: total30d },
      { count: total7d },
      { count: totalToday },
      { count: failed30d },
      { data: tokensAgg },
    ] = await Promise.all([
      supabase.from('turns').select('*', { count: 'exact', head: true }).eq('user_id', userId),
      supabase.from('turns').select('*', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', since30d),
      supabase.from('turns').select('*', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', since7d),
      supabase.from('turns').select('*', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', new Date().toISOString().slice(0, 10)),
      supabase.from('turns').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'failed').gte('created_at', since30d),
      supabase.from('turns').select('tokens_in, tokens_out, total_latency_ms').eq('user_id', userId).gte('created_at', since30d),
    ]);

    const tokensIn = (tokensAgg || []).reduce((s, r) => s + (r.tokens_in || 0), 0);
    const tokensOut = (tokensAgg || []).reduce((s, r) => s + (r.tokens_out || 0), 0);
    const latencies = (tokensAgg || []).map(r => r.total_latency_ms || 0).filter(x => x > 0).sort((a, b) => a - b);
    const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : 0;
    const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : 0;

    res.json({
      total_turns: totalTurns || 0,
      turns_30d: total30d || 0,
      turns_7d: total7d || 0,
      turns_today: totalToday || 0,
      failed_30d: failed30d || 0,
      success_rate_30d: total30d ? Math.round(((total30d - (failed30d || 0)) / total30d) * 100) : 100,
      tokens_in_30d: tokensIn,
      tokens_out_30d: tokensOut,
      latency_p50_ms: p50,
      latency_p95_ms: p95,
      daily_quota: 10,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/me/settings', authenticate, async (req, res) => {
  try {
    const { settings } = req.body || {};
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      return res.status(400).json({ error: 'settings deve essere un oggetto' });
    }
    const { getSupabase } = require('./supabase/client');
    const supabase = getSupabase();
    const { error } = await supabase
      .from('user_settings')
      .upsert({ user_id: req.userId, settings_json: settings, updated_at: new Date().toISOString() });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/me/feedback', authenticate, async (req, res) => {
  try {
    const { type, message, turn_id } = req.body || {};
    if (!message || typeof message !== 'string' || message.length > 2000) {
      return res.status(400).json({ error: 'message richiesto (max 2000 caratteri)' });
    }
    if (type && !['bug', 'feature', 'praise', 'other'].includes(type)) {
      return res.status(400).json({ error: 'type non valido' });
    }
    const { getSupabase } = require('./supabase/client');
    const supabase = getSupabase();
    const { error } = await supabase.from('events').insert({
      user_id: req.userId,
      event_type: 'user_feedback',
      properties: { type: type || 'other', message, turn_id: turn_id || null },
      success: true,
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------- Public event tracking (client-side) ---------- */
const ALLOWED_TRACK_EVENTS = new Set([
  'page_view', 'page_leave', 'scroll_depth', 'time_on_page',
  'cta_click', 'outbound_click', 'form_start', 'form_submit', 'form_error',
  'demo_preset_selected', 'demo_run_started', 'demo_run_completed',
  'signup_initiated', 'signup_completed', 'signup_error',
  'login_initiated', 'login_completed', 'login_error',
  'magic_link_requested', 'password_reset_requested',
  'install_tab_clicked', 'install_cmd_copied',
  'faq_opened', 'video_played', 'pricing_viewed',
  'js_error', 'api_error', 'web_vitals'
]);

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || '';
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

app.post('/api/events', async (req, res) => {
  const startedAt = Date.now();
  try {
    const body = req.body || {};
    const events = Array.isArray(body.events) ? body.events : (body.event ? [body] : []);

    if (!events.length) return res.status(400).json({ error: 'events array richiesto' });
    if (events.length > 50) return res.status(400).json({ error: 'max 50 eventi per batch' });

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
            || req.socket?.remoteAddress
            || null;
    const ua = (req.headers['user-agent'] || '').slice(0, 500);

    const rows = [];
    const sanitized = [];
    for (const e of events) {
      if (typeof e !== 'object' || e === null) continue;
      const eventType = String(e.event || e.event_type || '').slice(0, 100);
      if (!ALLOWED_TRACK_EVENTS.has(eventType)) {
        sanitized.push({ skipped: eventType, reason: 'not_allowlisted' });
        continue;
      }
      const props = (typeof e.properties === 'object' && e.properties !== null && !Array.isArray(e.properties))
        ? e.properties : {};
      // Cap properties size
      const propsJson = JSON.stringify(props).slice(0, 8000);

      rows.push({
        user_id: e.user_id || null,
        session_id: e.session_id ? String(e.session_id).slice(0, 100) : null,
        event_type: eventType,
        properties: props,
        success: e.success != null ? !!e.success : null,
      });
    }

    if (rows.length === 0) {
      return res.json({ ok: true, accepted: 0, skipped: sanitized });
    }

    // Persist to Supabase (best-effort)
    try {
      const { getSupabase } = require('./supabase/client');
      const supabase = getSupabase();
      await supabase.from('events').insert(rows);
    } catch (e) {
      // Soft-fail: don't break client
      logger.warn('events insert failed', { message: e.message });
    }

    // Optional: forward to PostHog
    if (POSTHOG_API_KEY) {
      const phPayload = rows.map(r => ({
        api_key: POSTHOG_API_KEY,
        event: r.event_type,
        distinct_id: r.user_id || r.session_id || 'anon',
        properties: {
          ...r.properties,
          $ip: ip,
          $useragent: ua,
          session_id: r.session_id,
        },
        timestamp: new Date().toISOString(),
      }));
      // Fire and forget
      fetch(POSTHOG_HOST + '/capture/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch: phPayload, sent_at: new Date().toISOString() }),
      }).catch(() => {});
    }

    res.json({ ok: true, accepted: rows.length, skipped: sanitized, latency_ms: Date.now() - startedAt });
  } catch (err) {
    logger.error('events endpoint error', { message: err.message });
    res.status(500).json({ error: 'internal' });
  }
});

/* ---------- Supabase Config (per il frontend) ---------- */
const { getSupabaseUrl } = require('./supabase/client');
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: getSupabaseUrl(),
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    posthogEnabled: !!POSTHOG_API_KEY,
    posthogKey: POSTHOG_API_KEY || null,
    posthogHost: POSTHOG_HOST,
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

/* ---------- Admin Dashboard (modular routes) ---------- */
const adminRouter = require('./routes/admin');
app.use('/api/admin', authenticate, adminRouter);

app.get('/admin', optionalAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'src', 'admin.html'));
});

/* ---------- Global error handler ---------- */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const requestId = req.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  logger.error('Unhandled error in route', {
    requestId,
    method: req.method,
    path: req.path,
    message: err.message,
    stack: err.stack?.split('\n').slice(0, 5).join('\n'),
  });
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: status >= 500 ? 'Errore interno del server' : err.message,
    requestId,
  });
});

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


/* ---------- Turn / Item Runtime (Codex-inspired) ---------- */

app.post('/api/turn/start', authenticate, quotaCheck, async (req, res) => {
  try {
    const { message, context, parentTurnId, modelOverride, speedMode, executionEngine, forceWorkerTier } = req.body;
    if (!message) return res.status(400).json({ error: 'Messaggio richiesto' });

    // Map user-facing speed mode to a concrete strategy preset.
    // fast     : flash, thinking off        -> ~183s (bench-validated best quality/speed)
    // balanced : flash, smart thinking gate, post-write critic async
    // pro      : flash, smart thinking gate, post-write critic async (same model, longer iteration budget)
    function speedModeStrategyOverlay(mode) {
      const m = String(mode || '').toLowerCase().trim();
      if (m === 'fast') return { speedMode: 'fast', modelOverride: 'deepseek-v4-flash', thinkingDisabled: true, postWriteCritic: false };
      if (m === 'pro') return { speedMode: 'pro', modelOverride: 'deepseek-v4-flash', thinkingDisabled: false, postWriteCritic: true };
      // default + 'balanced'
      return { speedMode: 'balanced', modelOverride: null, thinkingDisabled: null, postWriteCritic: true };
    }
    const overlay = speedModeStrategyOverlay(speedMode);
    const effectiveModelOverride = modelOverride || overlay.modelOverride || undefined;

    // Detect serverless deployment: Vercel sends fire-and-forget background
    // tasks to die when the response ends. Block on planning so the client
    // doesn't poll a half-built turn that never advances. Local servers can
    // still use the async path (env VERCEL is set on Vercel only).
    const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
    const startFn = isServerless ? turns.startTurnAwaitPlan : turns.startTurn;
    const turn = await Promise.resolve(startFn(message, context, parentTurnId || null, {
      modelOverride: effectiveModelOverride,
      userId: req.userId,
      speedMode: overlay.speedMode,
      thinkingDisabled: overlay.thinkingDisabled,
      postWriteCritic: overlay.postWriteCritic,
      executionEngineOverride: executionEngine,
      forceWorkerTier: forceWorkerTier === 'flash' || forceWorkerTier === 'pro' ? forceWorkerTier : null
    }));
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
    const turn = turns.loadTurn(turnId);
    // Wrap in execution context so worker LLM calls propagate turnId/userId
    // into llm trace records (otherwise turn_id is null in Supabase).
    const { runWithExecutionContext } = require('./utils/executionContext');
    const result = await runWithExecutionContext({
      turnId, userId: turn?.userId || req.userId || null,
      parentTurnId: turn?.parentTurnId || null,
      phase: 'execution', workflow: 'turn', source: 'turn.step',
    }, () => turns.stepTurn(turnId, clientResult, stepSeq));
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

// Periodic workbook health report from the client-side scanner. Dedupes
// against errors already known to the turn and, for genuinely new ones,
// injects an observation into active agent / slice messages so the next LLM
// iteration sees them. NEVER calls an LLM here — fast write only.
app.post('/api/turn/health-report', authenticate, async (req, res) => {
  try {
    const { turnId, errors } = req.body || {};
    if (!turnId) return res.status(400).json({ error: 'turnId richiesto' });
    if (!Array.isArray(errors)) return res.status(400).json({ error: 'errors deve essere un array' });
    await turns.getTurnRefAsync(turnId);
    const result = turns.recordHealthReport(turnId, errors);
    res.json({ ok: true, ...result });
  } catch (error) {
    logger.error('Errore turn/health-report:', error.message);
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

// Per-turn endpoint: authenticated user can fetch their own turn.
// Admins can fetch any turn.
// Cold-instance hydration: Vercel serverless lands requests on arbitrary lambda
// instances; the turn created by POST /api/turn/start may live in a different
// instance's in-memory map when GET arrives, returning 404. Mirror the SSE
// stream endpoint pattern: try in-memory first, then hydrate from DB.
// (Observed on 2026-06-02 Vairano runs — turn 404 immediately after creation.)
app.get('/api/turn/:turnId', authenticate, async (req, res) => {
  const { turnId } = req.params;
  let turn = turns.loadTurn(turnId);
  if (!turn) {
    try { await turns.getTurnRefAsync(turnId); } catch (_) {}
    turn = turns.loadTurn(turnId);
  }
  if (!turn) return res.status(404).json({ error: 'Turn non trovato' });
  if (turn.userId && turn.userId !== req.userId && req.userPlan !== 'admin') {
    return res.status(403).json({ error: 'Non autorizzato' });
  }
  res.json(turn);
});

// Per-turn LLM traces: owner or admin can read
app.get('/api/turn/:turnId/llm-traces', authenticate, async (req, res) => {
  try {
    const turnId = req.params.turnId;
    const turn = turns.loadTurn(turnId);
    const ownsTurn = turn && turn.userId && turn.userId === req.userId;
    if (!ownsTurn && req.userPlan !== 'admin') {
      return res.status(403).json({ error: 'Non autorizzato' });
    }
    const { readLlmTracesAsync } = require('./utils/llmTrace');
    const records = await readLlmTracesAsync({
      turnId,
      eventType: req.query.eventType || undefined,
      label: req.query.label || undefined,
      limit: Math.min(Math.max(parseInt(req.query.limit) || 500, 1), 5000),
      descending: req.query.order !== 'asc',
    });
    res.json({ turnId, count: records.length, records });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/turn/:turnId/undo', authenticate, (req, res) => {
  try {
    const turn = turns.loadTurn(req.params.turnId);
    if (turn && turn.userId && turn.userId !== req.userId && req.userPlan !== 'admin') {
      return res.status(403).json({ error: 'Non autorizzato' });
    }
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

/* ---------- Demo request (landing form) ---------- */
const ALLOWED_RUOLI = new Set([
  'Analista finanziario', 'Commercialista', 'CFO / Controller',
  'Investment Banker', 'Consulente', 'Startup founder', 'Altro'
]);

app.post('/api/demo-request', async (req, res) => {
  const startedAt = Date.now();
  try {
    const { nome, cognome, email, azienda, ruolo, hp } = req.body || {};

    if (hp) {
      logger.info('Demo request: honeypot triggered, dropping silently');
      return res.json({ ok: true, id: null, honeypot: true });
    }

    const errors = [];
    const clean = (v, max = 200) => typeof v === 'string' ? v.trim().slice(0, max) : '';
    const n = clean(nome, 80);
    const c = clean(cognome, 80);
    const e = clean(email, 254).toLowerCase();
    const a = clean(azienda, 120);
    const r = clean(ruolo, 60);

    if (n.length < 2) errors.push('nome richiesto');
    if (c.length < 2) errors.push('cognome richiesto');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) errors.push('email non valida');
    if (a.length < 2) errors.push('azienda richiesta');
    if (!ALLOWED_RUOLI.has(r)) errors.push('ruolo non valido');

    if (errors.length) {
      return res.status(400).json({ error: 'Validazione fallita', details: errors });
    }

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
            || req.socket?.remoteAddress
            || null;

    const properties = {
      nome: n, cognome: c, email: e, azienda: a, ruolo: r,
      source: 'landing',
      user_agent: (req.headers['user-agent'] || '').slice(0, 500),
      referer: (req.headers['referer'] || '').slice(0, 500),
      ip
    };

    const { getSupabase } = require('./supabase/client');
    const supabase = getSupabase();

    // Primary store: demo_leads (apply supabase/migrations/005_demo_leads.sql)
    // Fallback: events table with event_type='demo_request'
    let savedId = null;
    let usedFallback = false;

    try {
      const { data, error } = await supabase
        .from('demo_leads')
        .insert({ nome: n, cognome: c, email: e, azienda: a, ruolo: r,
                  source: 'landing', user_agent: properties.user_agent,
                  referer: properties.referer, ip })
        .select('id, created_at')
        .single();

      if (!error && data) {
        savedId = data.id;
      } else {
        usedFallback = true;
        logger.warn('Demo request: demo_leads unavailable, using events fallback', { code: error?.code, msg: error?.message });
      }
    } catch (e) {
      usedFallback = true;
    }

    if (usedFallback) {
      const { data, error } = await supabase
        .from('events')
        .insert({ event_type: 'demo_request', properties, success: true })
        .select('id')
        .single();

      if (error) {
        logger.error('Demo request: both stores failed', { error: error.message });
        return res.status(500).json({ error: 'Errore nel salvataggio. Riprova più tardi.' });
      }
      savedId = data?.id;
    }

    logger.info('Demo request: saved', {
      id: savedId, email: e, ruolo: r, ip, fallback: usedFallback, latency_ms: Date.now() - startedAt
    });

    res.json({ ok: true, id: savedId });
  } catch (error) {
    logger.error('Demo request: unhandled', { message: error.message, stack: error.stack });
    res.status(500).json({ error: 'Errore interno. Riprova più tardi.' });
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
