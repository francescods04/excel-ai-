const DEFAULTS = {
  maxPlanTasks: 80,
  maxActionsPerTask: 800,
  maxActionPayloadBytes: 2_500_000,
  maxTaskDescriptionChars: 800,
  maxParallelTasks: 4,
  maxSseClientsPerJob: 4,
  maxSseHistoryEvents: 350,
  maxLogEntries: 500,
  maxRequestBodyMb: 10
};

function numberFromEnv(name, fallback, min = 1) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < min) return fallback;
  return Math.floor(value);
}

const LIMITS = {
  maxPlanTasks: numberFromEnv('MAX_PLAN_TASKS', DEFAULTS.maxPlanTasks),
  maxActionsPerTask: numberFromEnv('MAX_ACTIONS_PER_TASK', DEFAULTS.maxActionsPerTask),
  maxActionPayloadBytes: numberFromEnv('MAX_ACTION_PAYLOAD_BYTES', DEFAULTS.maxActionPayloadBytes),
  maxTaskDescriptionChars: numberFromEnv('MAX_TASK_DESCRIPTION_CHARS', DEFAULTS.maxTaskDescriptionChars),
  maxParallelTasks: numberFromEnv('TURN_MAX_PARALLEL_TASKS', DEFAULTS.maxParallelTasks),
  maxSseClientsPerJob: numberFromEnv('MAX_SSE_CLIENTS_PER_JOB', DEFAULTS.maxSseClientsPerJob),
  maxSseHistoryEvents: numberFromEnv('MAX_SSE_HISTORY_EVENTS', DEFAULTS.maxSseHistoryEvents),
  maxLogEntries: numberFromEnv('MAX_TURN_LOG_ENTRIES', DEFAULTS.maxLogEntries),
  maxRequestBodyMb: numberFromEnv('MAX_REQUEST_BODY_MB', DEFAULTS.maxRequestBodyMb)
};

function byteSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value || null), 'utf8');
  } catch (err) {
    return Infinity;
  }
}

function assertPlanWithinLimits(plan = {}) {
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  if (tasks.length > LIMITS.maxPlanTasks) {
    throw new Error(`Piano troppo grande: ${tasks.length} task (limite ${LIMITS.maxPlanTasks})`);
  }

  for (const task of tasks) {
    const desc = String(task?.description || '');
    if (desc.length > LIMITS.maxTaskDescriptionChars) {
      task.description = `${desc.slice(0, LIMITS.maxTaskDescriptionChars - 1)}...`;
    }
  }
  return plan;
}

function assertActionBatchWithinLimits(actions = [], task = {}) {
  if (!Array.isArray(actions)) return;
  if (actions.length > LIMITS.maxActionsPerTask) {
    throw new Error(`[${task.id || task.tool || 'task'}] troppe azioni Excel: ${actions.length} (limite ${LIMITS.maxActionsPerTask})`);
  }
  const payloadBytes = byteSize(actions);
  if (payloadBytes > LIMITS.maxActionPayloadBytes) {
    throw new Error(`[${task.id || task.tool || 'task'}] payload azioni Excel troppo grande: ${payloadBytes} bytes (limite ${LIMITS.maxActionPayloadBytes})`);
  }
}

async function allSettledLimit(items = [], limit = LIMITS.maxParallelTasks, worker) {
  const safeLimit = Math.max(1, Number(limit) || 1);
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { status: 'rejected', reason: error };
      }
    }
  }

  const workers = Array.from({ length: Math.min(safeLimit, items.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

module.exports = {
  LIMITS,
  assertPlanWithinLimits,
  assertActionBatchWithinLimits,
  allSettledLimit,
  byteSize
};
