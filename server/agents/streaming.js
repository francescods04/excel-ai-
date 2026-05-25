// Gestione stream SSE per job con supporto a replay, heartbeat e più client per job
const { LIMITS } = require('../runtime/safetyLimits');

const clients = new Map(); // jobId -> Set<res>
const history = new Map(); // jobId -> [{ eventType, data }]
const heartbeats = new Map(); // jobId -> IntervalID
const llmProgressState = new Map(); // jobId -> { lastAt, length }
const MAX_HISTORY_EVENTS = LIMITS.maxSseHistoryEvents;
const MAX_CLIENTS_PER_JOB = LIMITS.maxSseClientsPerJob;
const HEARTBEAT_INTERVAL_MS = 15000; // 15 secondi
const LLM_PROGRESS_MIN_INTERVAL_MS = 1200;
const LLM_PROGRESS_MIN_CHARS = 900;

// Eventi non utili in replay: log lines + chunk LLM streaming.
// Volume alto e ricostruibili da turn JSON in altri eventi → escludi da history.
const NON_REPLAYABLE_EVENTS = new Set(['log', 'llmProgress']);

// Eventi sostituibili: se arriva uno nuovo per lo stesso item/turn, scarta il vecchio
const REPLACEABLE_EVENTS = new Set(['itemStarted', 'itemCompleted', 'taskActions', 'toolRequestResolved']);

function startHeartbeat(jobId) {
  if (heartbeats.has(jobId)) return;
  const intervalId = setInterval(() => {
    const jobClients = clients.get(jobId);
    if (!jobClients || jobClients.size === 0) {
      stopHeartbeat(jobId);
      return;
    }
    const deadClients = [];
    for (const res of jobClients) {
      try {
        res.write(':heartbeat\n\n');
      } catch (e) {
        deadClients.push(res);
      }
    }
    for (const dead of deadClients) {
      removeClient(jobId, dead);
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeats.set(jobId, intervalId);
}

function stopHeartbeat(jobId) {
  const intervalId = heartbeats.get(jobId);
  if (intervalId) {
    clearInterval(intervalId);
    heartbeats.delete(jobId);
  }
}

function writeEvent(res, eventType, data) {
  try {
    const payload = JSON.stringify(data);
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${payload}\n\n`);
  } catch (e) {
    // Ignora errori di scrittura su client disconnesso
  }
}

function getEventKey(eventType, data) {
  // Ritorna una chiave per raggruppare eventi sostituibili
  if (eventType === 'itemStarted' || eventType === 'itemCompleted') {
    return `${eventType}:${data?.item?.id || data?.item?.taskId || ''}`;
  }
  if (eventType === 'taskActions') {
    return `${eventType}:${data?.taskId || ''}`;
  }
  if (eventType === 'toolRequestResolved') {
    return `${eventType}:${data?.requestId || ''}`;
  }
  return null; // non sostituibile
}

function appendHistory(jobId, eventType, data) {
  if (NON_REPLAYABLE_EVENTS.has(eventType)) return;
  const events = history.get(jobId) || [];

  // Se l'evento è sostituibile, rimuovi il precedente per la stessa chiave
  const key = getEventKey(eventType, data);
  if (key) {
    const idx = events.findIndex(e => getEventKey(e.eventType, e.data) === key);
    if (idx >= 0) {
      events.splice(idx, 1);
    }
  }

  events.push({ eventType, data });
  if (events.length > MAX_HISTORY_EVENTS) {
    events.splice(0, events.length - MAX_HISTORY_EVENTS);
  }
  history.set(jobId, events);
}

function registerClient(jobId, res) {
  const jobClients = clients.get(jobId) || new Set();
  if (jobClients.size >= MAX_CLIENTS_PER_JOB) {
    const oldest = jobClients.values().next().value;
    if (oldest) {
      try { oldest.end(); } catch (err) {}
      jobClients.delete(oldest);
    }
  }
  jobClients.add(res);
  clients.set(jobId, jobClients);

  res.on('error', () => {
    removeClient(jobId, res);
  });

  const events = history.get(jobId) || [];
  for (const event of events) {
    writeEvent(res, event.eventType, event.data);
  }

  startHeartbeat(jobId);
}

function removeClient(jobId, res) {
  const jobClients = clients.get(jobId);
  if (!jobClients) return;
  jobClients.delete(res);
  if (jobClients.size === 0) {
    clients.delete(jobId);
    stopHeartbeat(jobId);
  }
}

function hasHistory(jobId) {
  const events = history.get(jobId);
  return !!(events && events.length > 0);
}

function hasClients(jobId) {
  const jobClients = clients.get(jobId);
  return !!(jobClients && jobClients.size > 0);
}

function sendEvent(jobId, eventType, data) {
  appendHistory(jobId, eventType, data);

  const jobClients = clients.get(jobId);
  if (!jobClients || jobClients.size === 0) return false;

  const deadClients = [];
  for (const res of jobClients) {
    try {
      writeEvent(res, eventType, data);
    } catch (e) {
      deadClients.push(res);
    }
  }
  for (const dead of deadClients) {
    removeClient(jobId, dead);
  }
  return true;
}

function sendTaskStart(jobId, task) {
  return sendEvent(jobId, 'taskStart', {
    taskId: task.id,
    agent: task.agent,
    description: task.description || task.tool,
    tool: task.tool
  });
}

function sendTaskActions(jobId, taskId, actions) {
  return sendEvent(jobId, 'actions', { taskId, actions });
}

function sendTaskComplete(jobId, taskId, result) {
  return sendEvent(jobId, 'taskComplete', { taskId, result: result || null });
}

function sendTaskError(jobId, taskId, error) {
  return sendEvent(jobId, 'taskError', { taskId, error: String(error) });
}

function sendPlan(jobId, tasks) {
  return sendEvent(jobId, 'plan', { tasks });
}

function sendDone(jobId, result) {
  return sendEvent(jobId, 'done', { result });
}

function sendLog(jobId, message, level = 'info') {
  return sendEvent(jobId, 'log', { message, level, time: new Date().toISOString() });
}

function sendLLMProgress(jobId, text, isDone) {
  const now = Date.now();
  const length = typeof text === 'string' ? text.length : 0;
  const previous = llmProgressState.get(jobId);
  const shouldSend = isDone
    || !previous
    || now - previous.lastAt >= LLM_PROGRESS_MIN_INTERVAL_MS
    || length - previous.length >= LLM_PROGRESS_MIN_CHARS;

  if (!shouldSend) return false;
  llmProgressState.set(jobId, { lastAt: now, length });
  return sendEvent(jobId, 'llmProgress', { text, isDone, time: new Date().toISOString() });
}

function cleanupTurn(turnId) {
  history.delete(turnId);
  clients.delete(turnId);
  llmProgressState.delete(turnId);
  stopHeartbeat(turnId);
}

module.exports = {
  registerClient,
  removeClient,
  hasHistory,
  hasClients,
  sendEvent,
  sendTaskStart,
  sendTaskActions,
  sendTaskComplete,
  sendTaskError,
  sendPlan,
  sendDone,
  sendLog,
  sendLLMProgress,
  cleanupTurn
};
