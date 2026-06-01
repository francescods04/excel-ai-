const DEFAULTS = {
  maxPlanTasks: 80,
  maxActionsPerTask: 800,
  maxActionPayloadBytes: 2_500_000,
  maxActionCellsPerBatch: 20000,
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
  maxActionCellsPerBatch: numberFromEnv('MAX_ACTION_CELLS_PER_BATCH', DEFAULTS.maxActionCellsPerBatch),
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

function colToNumber(col) {
  let n = 0;
  for (const ch of String(col || '').toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return null;
    n = n * 26 + (code - 64);
  }
  return n || null;
}

function estimateTargetCells(target) {
  const raw = String(target || '').replace(/\$/g, '');
  const withoutSheet = raw.includes('!') ? raw.split('!').pop() : raw;
  if (!withoutSheet) return 1;
  if (/^[A-Z]+:[A-Z]+$/i.test(withoutSheet) || /^\d+:\d+$/.test(withoutSheet)) return Infinity;
  const match = withoutSheet.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
  if (!match) return 1;
  const c1 = colToNumber(match[1]);
  const r1 = Number(match[2]);
  const c2 = match[3] ? colToNumber(match[3]) : c1;
  const r2 = match[4] ? Number(match[4]) : r1;
  if (!c1 || !c2 || !Number.isFinite(r1) || !Number.isFinite(r2)) return 1;
  return (Math.abs(r2 - r1) + 1) * (Math.abs(c2 - c1) + 1);
}

function matrixCellCount(matrix) {
  if (!Array.isArray(matrix)) return 0;
  const rows = matrix.length;
  const cols = Array.isArray(matrix[0]) ? matrix[0].length : 1;
  return Math.max(1, rows * cols);
}

function estimateActionCells(action = {}) {
  if (!action || typeof action !== 'object') return 0;
  if (action.type === 'setCellRange' && action.cells && typeof action.cells === 'object') {
    let total = 0;
    for (const key of Object.keys(action.cells)) {
      const n = estimateTargetCells(key);
      if (!Number.isFinite(n)) return Infinity;
      total += n;
    }
    if (action.copyToRange) {
      const copied = estimateTargetCells(action.copyToRange);
      if (!Number.isFinite(copied)) return Infinity;
      total += copied;
    }
    return total;
  }
  if (action.type === 'writeRange') {
    const n = matrixCellCount(action.formulas || action.values);
    return n || estimateTargetCells(action.target);
  }
  if (action.type === 'setCellFormat' || action.type === 'addConditionalFormat' || action.type === 'setConditionalFormat') {
    return estimateTargetCells(action.target);
  }
  if (action.type === 'fillRange') {
    const n = matrixCellCount(action.value);
    return n || estimateTargetCells(action.target);
  }
  if (action.type === 'runFormula' || action.type === 'setCellValue') {
    return estimateTargetCells(action.target);
  }
  return 0;
}

function estimateActionBatchCells(actions = []) {
  return actions.reduce((sum, action) => {
    const n = estimateActionCells(action);
    if (!Number.isFinite(n)) return Infinity;
    return sum + n;
  }, 0);
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
  const cellCount = estimateActionBatchCells(actions);
  if (!Number.isFinite(cellCount)) {
    throw new Error(`[${task.id || task.tool || 'task'}] batch Excel con range non limitato; usa range A1 finiti prima di eseguire`);
  }
  if (cellCount > LIMITS.maxActionCellsPerBatch) {
    throw new Error(`[${task.id || task.tool || 'task'}] troppe celle Excel nel batch: ${cellCount} (limite ${LIMITS.maxActionCellsPerBatch})`);
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
  byteSize,
  estimateActionCells,
  estimateActionBatchCells
};
