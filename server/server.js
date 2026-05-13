const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const https = require('https');
require('dotenv').config();

const logger = require('./utils/logger');
const streaming = require('./agents/streaming');
const turns = require('./runtime/turns');

const app = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..')));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url}`);
  next();
});

const START_TIME = Date.now();

app.get('/api/health', (req, res) => {
  const { TOOL_DEFINITIONS, PROMPT_VARIANTS } = require('./agents/agentLoop');
  const llmCfg = getLLMConfig();
  const promptVariant = process.env.AGENT_PROMPT_VARIANT || 'default';
  const activeModel = llmCfg.model
    || (llmCfg.provider === 'openrouter' ? process.env.OPENROUTER_MODEL : null)
    || (llmCfg.provider === 'deepseek' ? process.env.DEEPSEEK_MODEL : null)
    || process.env.AI_MODEL
    || 'kimi-k2.6';

  res.json({
    ok: true,
    app: 'excel-ai-agent',
    version: '2.0.0',
    runtime: 'turn-item-v2',
    uptimeSec: Math.floor((Date.now() - START_TIME) / 1000),
    model: {
      provider: llmCfg.provider,
      primary: activeModel,
      fallback: llmCfg.fallbackModel || process.env.AI_FALLBACK_MODEL || '',
      maxTokens: Number(process.env.MAX_TOKENS) || 16384
    },
    tools: {
      count: TOOL_DEFINITIONS.length,
      list: TOOL_DEFINITIONS.map(t => t.function?.name || t.name)
    },
    promptVariant,
    promptVariantsAvailable: Object.keys(PROMPT_VARIANTS),
    features: [
      'turn-runtime',
      'workbook-tools',
      'interactive-requests',
      'preflight-read',
      'context-snip',
      'cache-breakpoint',
      'skills-lazyload',
      'bm25-tool-search',
      'calculation-suspension',
      'persistent-instructions',
      'update-setting',
      'auto-skill-suggest'
    ],
    env: {
      nodeEnv: process.env.NODE_ENV || 'development',
      cacheBreakpointEnabled: process.env.CACHE_BREAKPOINT_ENABLED !== 'false',
      autoCompactLimit: Number(process.env.AGENT_AUTO_COMPACT_LIMIT) || 18
    }
  });
});

/* ---------- Turn / Item Runtime (Codex-inspired) ---------- */

app.post('/api/turn/start', async (req, res) => {
  try {
    const { message, context, parentTurnId, modelOverride } = req.body;
    if (!message) return res.status(400).json({ error: 'Messaggio richiesto' });

    const turn = turns.startTurn(message, context, parentTurnId || null, { modelOverride });
    res.json({
      turnId: turn.id,
      status: turn.status
    });
  } catch (error) {
    logger.error('Errore turn/start:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/turn/approve', async (req, res) => {
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

app.post('/api/turn/respond', async (req, res) => {
  try {
    const { turnId, requestId, response } = req.body;
    if (!turnId || !requestId) {
      return res.status(400).json({ error: 'turnId e requestId sono richiesti' });
    }

    turns.respondToTurnRequest(turnId, requestId, response || {});
    res.json({ ok: true });
  } catch (error) {
    logger.error('Errore turn/respond:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/turn/respond-batch', async (req, res) => {
  try {
    const { turnId, responses } = req.body;
    if (!turnId || !Array.isArray(responses)) {
      return res.status(400).json({ error: 'turnId e responses[] sono richiesti' });
    }

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

app.get('/api/turn/stream/:turnId', async (req, res) => {
  const { turnId } = req.params;
  const turn = turns.loadTurn(turnId);
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
const SETTINGS_PATH = path.join(__dirname, '..', 'docs', 'user-settings.json');

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

function makeRequestClientTool(agentId) {
  return async (toolName, params) => {
    return new Promise((resolve, reject) => {
      const requestId = 'cr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const agentRequests = getOrCreateAgentRequests(agentId);
      const timeout = setTimeout(() => {
        agentRequests.delete(requestId);
        reject(new Error(`Client read timeout (30s) for ${toolName}`));
      }, 30000);
      agentRequests.set(requestId, { resolve, reject, timeout });

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

app.get('/api/agent/stream/:agentId', async (req, res) => {
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
  const turnsDir = path.join(__dirname, 'turns');
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
