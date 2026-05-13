const fs = require('fs');
const path = require('path');

const logger = require('../utils/logger');
const planner = require('../agents/planner');
const streaming = require('../agents/streaming');
const conversationMemory = require('./conversationMemory');
const { executeTool, registry } = require('../tools/registry');
const { validateTaskOutput } = require('../agents/critic');
const { runNarratorAgent } = require('../agents/narrator');
const {
  makeRequestId,
  waitForClientResponse,
  resolveClientResponse,
  rejectClientResponse
} = require('./clientRequests');
const { buildActionPreview, hasMutationActions } = require('./actionPreview');
const { computeLevels } = require('../utils/graph');
const { buildUndoActions, summarizeUndo } = require('./undo');
const { isPrefetchSafeTask } = require('./prefetchPolicy');

const TURNS_DIR = path.join(__dirname, '..', 'turns');

if (!fs.existsSync(TURNS_DIR)) {
  fs.mkdirSync(TURNS_DIR, { recursive: true });
}

const activeTurns = new Map();
const pendingDiskWrites = new Map(); // turnId -> timeoutId
const runningTaskPromises = new Map(); // `${turnId}:${taskId}` -> Promise

const MAX_ACTIVE_TURNS = 20;
const TURN_CLEANUP_DELAY_MS = 5 * 60 * 1000;

function enforceActiveTurnsLimit() {
  if (activeTurns.size <= MAX_ACTIVE_TURNS) return;
  const terminalEntries = [];
  for (const [id, turn] of activeTurns.entries()) {
    if (turn.status === 'completed' || turn.status === 'error') {
      terminalEntries.push([id, turn]);
    }
  }
  terminalEntries.sort((a, b) => new Date(a[1].updatedAt).getTime() - new Date(b[1].updatedAt).getTime());
  const keepTerminal = Math.max(0, MAX_ACTIVE_TURNS - (activeTurns.size - terminalEntries.length));
  const toRemove = terminalEntries.slice(0, terminalEntries.length - keepTerminal);
  for (const [id] of toRemove) {
    flushDiskWrite(id);
    activeTurns.delete(id);
    streaming.cleanupTurn(id);
  }
  if (activeTurns.size > MAX_ACTIVE_TURNS) {
    logger.warn(`[Turns] activeTurns limit exceeded (${activeTurns.size}) but only non-terminal turns remain.`);
  }
}

function scheduleTurnCleanup(turnId) {
  setTimeout(() => {
    const turn = activeTurns.get(turnId);
    if (turn && (turn.status === 'completed' || turn.status === 'error')) {
      flushDiskWrite(turnId);
      activeTurns.delete(turnId);
      streaming.cleanupTurn(turnId);
      logger.info(`[Turns] Cleaned up completed turn ${turnId} from memory`);
    }
  }, TURN_CLEANUP_DELAY_MS);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function turnPath(turnId) {
  return path.join(TURNS_DIR, `${turnId}.json`);
}

function makeTurnId() {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function taskItemId(taskId) {
  return `task-${taskId}`;
}

// Internal: returns live mutable reference (no clone). Use for all internal mutations.
function _getTurnRef(turnId) {
  if (activeTurns.has(turnId)) {
    return activeTurns.get(turnId);
  }

  const filePath = turnPath(turnId);
  if (!fs.existsSync(filePath)) return null;

  const turn = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  activeTurns.set(turnId, turn);
  return turn;
}

// Public: returns immutable clone for external consumers (API responses, etc.)
function loadTurn(turnId) {
  const turn = _getTurnRef(turnId);
  if (!turn) return null;
  return clone(turn);
}

// Debounced async disk write — batches rapid state changes into one write
const DISK_WRITE_DEBOUNCE_MS = 200;

function scheduleDiskWrite(turnId) {
  if (pendingDiskWrites.has(turnId)) {
    clearTimeout(pendingDiskWrites.get(turnId));
  }
  const timeoutId = setTimeout(() => {
    pendingDiskWrites.delete(turnId);
    const turn = activeTurns.get(turnId);
    if (!turn) return;
    const data = JSON.stringify(turn, null, 2);
    fs.writeFile(turnPath(turnId), data, (err) => {
      if (err) logger.error(`Disk write error for ${turnId}: ${err.message}`);
    });
  }, DISK_WRITE_DEBOUNCE_MS);
  pendingDiskWrites.set(turnId, timeoutId);
}

// Flush a specific turn to disk immediately (for terminal states)
function flushDiskWrite(turnId) {
  if (pendingDiskWrites.has(turnId)) {
    clearTimeout(pendingDiskWrites.get(turnId));
    pendingDiskWrites.delete(turnId);
  }
  const turn = activeTurns.get(turnId);
  if (!turn) return;
  fs.writeFileSync(turnPath(turnId), JSON.stringify(turn, null, 2));
}

function saveTurn(turn) {
  turn.updatedAt = nowIso();
  activeTurns.set(turn.id, turn);
  enforceActiveTurnsLimit();
  // Terminal states flush immediately; intermediate states debounce
  if (turn.status === 'completed' || turn.status === 'error') {
    flushDiskWrite(turn.id);
  } else {
    scheduleDiskWrite(turn.id);
  }
  return turn;
}

function upsertItem(turnId, itemPatch) {
  const turn = _getTurnRef(turnId);
  if (!turn) throw new Error(`Turn non trovato: ${turnId}`);

  const timestamp = nowIso();
  const existingIndex = turn.items.findIndex(item => item.id === itemPatch.id);
  const existingItem = existingIndex >= 0 ? turn.items[existingIndex] : null;
  const nextItem = {
    ...(existingItem || {}),
    ...itemPatch,
    updatedAt: timestamp
  };

  if (!nextItem.createdAt) nextItem.createdAt = timestamp;
  if (nextItem.status === 'completed' || nextItem.status === 'error') {
    nextItem.completedAt = timestamp;
  }

  if (existingIndex >= 0) {
    turn.items[existingIndex] = nextItem;
  } else {
    turn.items.push(nextItem);
  }

  saveTurn(turn);
  return { ...nextItem };
}

function appendLog(turnId, message, level = 'info', extra = {}) {
  const turn = _getTurnRef(turnId);
  if (!turn) throw new Error(`Turn non trovato: ${turnId}`);

  const entry = {
    time: nowIso(),
    level,
    message,
    ...extra
  };

  turn.log.push(entry);
  saveTurn(turn);
  streaming.sendEvent(turnId, 'log', entry);
  return entry;
}

function setTurnStatus(turnId, status, error) {
  const turn = _getTurnRef(turnId);
  if (!turn) throw new Error(`Turn non trovato: ${turnId}`);

  turn.status = status;
  if (error !== undefined) {
    turn.error = error;
  }
  saveTurn(turn);
  return turn;
}

function storeTaskResult(turnId, taskId, result) {
  const turn = _getTurnRef(turnId);
  if (!turn) throw new Error(`Turn non trovato: ${turnId}`);

  turn.results[taskId] = result;
  saveTurn(turn);
  return turn;
}

function emitTurnStarted(turn) {
  streaming.sendEvent(turn.id, 'turnStarted', {
    turnId: turn.id,
    status: turn.status,
    objective: turn.objective,
    createdAt: turn.createdAt
  });
}

function emitPlanUpdated(turn) {
  streaming.sendEvent(turn.id, 'planUpdated', {
    turnId: turn.id,
    objective: turn.plan?.objective || turn.objective,
    tasks: turn.plan?.tasks || []
  });
}

function emitItemStarted(turnId, item) {
  streaming.sendEvent(turnId, 'itemStarted', { item });
}

function emitItemCompleted(turnId, item) {
  streaming.sendEvent(turnId, 'itemCompleted', { item });
}

function emitTurnAwaitingApproval(turn) {
  streaming.sendEvent(turn.id, 'turnAwaitingApproval', {
    turnId: turn.id,
    status: turn.status,
    taskCount: turn.plan?.tasks?.length || 0
  });
}

function emitTaskActions(turnId, task, actions) {
  streaming.sendEvent(turnId, 'taskActions', {
    turnId,
    taskId: task.id,
    itemId: taskItemId(task.id),
    actions
  });
}

function emitTurnCompleted(turn) {
  streaming.sendEvent(turn.id, 'turnCompleted', {
    turnId: turn.id,
    status: turn.status,
    error: turn.error || null
  });
  scheduleTurnCleanup(turn.id);
}

const pendingBatches = new Map(); // turnId -> { timer, requests }
const BATCH_WINDOW_MS = 50;

function flushBatch(turnId) {
  const batch = pendingBatches.get(turnId);
  pendingBatches.delete(turnId);
  if (!batch || batch.requests.length === 0) return;
  streaming.sendEvent(turnId, 'toolRequestBatch', {
    turnId,
    requests: batch.requests
  });
}

function scheduleBatchEmit(turnId, request) {
  const existing = pendingBatches.get(turnId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.requests.push(request);
    existing.timer = setTimeout(() => flushBatch(turnId), BATCH_WINDOW_MS);
  } else {
    const timer = setTimeout(() => flushBatch(turnId), BATCH_WINDOW_MS);
    pendingBatches.set(turnId, { timer, requests: [request] });
  }
}

function emitToolRequest(turnId, request) {
  // Batched clientTool requests go through batch window; everything else is immediate
  if (request.type === 'clientTool') {
    scheduleBatchEmit(turnId, request);
  } else {
    streaming.sendEvent(turnId, 'toolRequest', {
      turnId,
      request
    });
  }
}

function emitToolRequestResolved(turnId, request, response, status = 'resolved') {
  streaming.sendEvent(turnId, 'toolRequestResolved', {
    turnId,
    requestId: request.id,
    requestType: request.type,
    status,
    response: response || null
  });
}

function buildTurn(message, context, parentTurnId = null, options = {}) {
  const turnId = makeTurnId();
  const createdAt = nowIso();

  return {
    id: turnId,
    objective: message,
    context: context || {},
    llm: {
      modelOverride: options.modelOverride || null
    },
    status: 'planning',
    error: null,
    plan: null,
    items: [],
    results: {},
    pendingRequests: [],
    log: [],
    parentTurnId,
    createdAt,
    updatedAt: createdAt
  };
}

function getParentContinuity(turn, parentOverride = null) {
  if (!turn?.parentTurnId && !parentOverride) {
    return { parentTurn: null, parentPlan: null, parentResults: null };
  }
  const parentTurn = parentOverride || _getTurnRef(turn.parentTurnId);
  if (!parentTurn) {
    return { parentTurn: null, parentPlan: null, parentResults: null };
  }
  return {
    parentTurn,
    parentPlan: parentTurn.plan || null,
    parentResults: parentTurn.results || null
  };
}

function collectRequestedResultIds(params = {}) {
  const requested = new Set();
  const add = value => {
    if (!value || typeof value !== 'string') return;
    requested.add(value);
    if (value.startsWith('$results.')) {
      const firstPathSegment = value.replace('$results.', '').split('.')[0];
      if (firstPathSegment) requested.add(firstPathSegment);
    }
  };

  if (Array.isArray(params.usesResults)) {
    params.usesResults.forEach(add);
  }
  add(params.fromResult);
  add(params.resultId);
  add(params.planRef);

  for (const value of Object.values(params)) {
    if (typeof value === 'string') add(value);
  }
  return requested;
}

function mergeExecutionResults(currentResults = {}, parentResults = {}, task = {}) {
  const current = currentResults && typeof currentResults === 'object' ? currentResults : {};
  const parent = parentResults && typeof parentResults === 'object' ? parentResults : {};
  const requested = collectRequestedResultIds(task.params || {});
  const merged = {};

  for (const [taskId, result] of Object.entries(parent)) {
    merged[`parent:${taskId}`] = result;
    if (!Object.prototype.hasOwnProperty.call(current, taskId) && requested.has(taskId)) {
      merged[taskId] = result;
    }
  }

  for (const [taskId, result] of Object.entries(current)) {
    merged[taskId] = result;
  }

  return merged;
}

function buildExecutionMemory(turn, task, runtime = {}, parentOverride = null) {
  const { parentPlan, parentResults } = getParentContinuity(turn, parentOverride);
  const executionResults = mergeExecutionResults(turn?.results || {}, parentResults || {}, task || {});
  const context = {
    ...(turn?.context || {})
  };
  if (parentPlan) context.parentPlan = parentPlan;
  if (parentResults) context.parentResults = parentResults;

  return {
    ...turn,
    context,
    results: executionResults,
    parentPlan,
    parentResults,
    runtime,
    currentTask: task
  };
}

function addPendingRequest(turnId, request) {
  const turn = _getTurnRef(turnId);
  if (!turn) throw new Error(`Turn non trovato: ${turnId}`);

  const nextRequest = {
    ...request,
    status: 'pending',
    createdAt: request.createdAt || nowIso()
  };

  const pendingRequests = Array.isArray(turn.pendingRequests) ? turn.pendingRequests : [];
  turn.pendingRequests = pendingRequests.filter(entry => entry.id !== nextRequest.id);
  turn.pendingRequests.push(nextRequest);
  saveTurn(turn);
  return nextRequest;
}

function removePendingRequest(turnId, requestId, updates = {}) {
  const turn = _getTurnRef(turnId);
  if (!turn) throw new Error(`Turn non trovato: ${turnId}`);

  const pendingRequests = Array.isArray(turn.pendingRequests) ? turn.pendingRequests : [];
  const existingRequest = pendingRequests.find(entry => entry.id === requestId) || null;
  turn.pendingRequests = pendingRequests.filter(entry => entry.id !== requestId);

  if (existingRequest) {
    turn.lastResolvedRequest = {
      ...existingRequest,
      ...updates,
      resolvedAt: nowIso()
    };
  }

  saveTurn(turn);
  return existingRequest;
}

function getPendingRequest(turnId, requestId) {
  const turn = _getTurnRef(turnId);
  if (!turn) return null;
  return (turn.pendingRequests || []).find(entry => entry.id === requestId) || null;
}

function normalizeRequestFields(fields) {
  if (!Array.isArray(fields)) return [];

  return fields.map((field, index) => {
    if (typeof field === 'string') {
      const key = field
        .toLowerCase()
        .replace(/[^a-z0-9]+/gi, '_')
        .replace(/^_+|_+$/g, '') || `field_${index + 1}`;

      return {
        key,
        label: field,
        type: 'text',
        required: true
      };
    }

    if (!field || typeof field !== 'object') {
      return {
        key: `field_${index + 1}`,
        label: `Campo ${index + 1}`,
        type: 'text',
        required: false
      };
    }

    const key = field.key || field.name || `field_${index + 1}`;
    return {
      type: 'text',
      required: false,
      ...field,
      key,
      label: field.label || key
    };
  });
}

async function requestClientResponse(turnId, request) {
  const normalizedRequest = addPendingRequest(turnId, {
    ...request,
    id: request.id || makeRequestId('req')
  });

  emitToolRequest(turnId, normalizedRequest);
  let timeoutId;

  try {
    const timeoutMs = normalizedRequest.timeoutMs || 120000;
    const response = await Promise.race([
      waitForClientResponse(turnId, normalizedRequest),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Timeout richiesta client: ${normalizedRequest.type}`)), timeoutMs);
      })
    ]);
    clearTimeout(timeoutId);
    removePendingRequest(turnId, normalizedRequest.id, {
      status: 'resolved',
      response
    });
    emitToolRequestResolved(turnId, normalizedRequest, response, 'resolved');
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    rejectClientResponse(turnId, normalizedRequest.id, error);
    removePendingRequest(turnId, normalizedRequest.id, {
      status: 'rejected',
      error: error.message
    });
    emitToolRequestResolved(turnId, normalizedRequest, { error: error.message }, 'rejected');
    throw error;
  }
}

function buildRuntimeHelpers(turnId, task) {
  const taskId = task?.id;

  return {
    async requestClientTool(toolName, params = {}) {
      const response = await requestClientResponse(turnId, {
        id: makeRequestId('tool'),
        type: 'clientTool',
        taskId,
        toolName,
        params,
        title: `Lettura workbook: ${toolName}`,
        prompt: `Recupero contesto dal workbook per il task ${taskId || toolName}.`
      });
      return response && response.data !== undefined ? response.data : response;
    },

    async requestUserInput(params = {}) {
      return requestClientResponse(turnId, {
        id: makeRequestId('input'),
        type: 'userInput',
        taskId,
        title: params.title || 'Mi serve un input per continuare',
        prompt: params.prompt || params.question || 'Compila i campi richiesti per continuare.',
        fields: normalizeRequestFields(params.fields),
        submitLabel: params.submitLabel || 'Continua',
        cancelLabel: params.cancelLabel || 'Annulla'
      });
    },

    async requestPermissions(params = {}) {
      return requestClientResponse(turnId, {
        id: makeRequestId('perm'),
        type: 'permission',
        taskId,
        title: params.title || 'Conferma richiesta',
        prompt: params.prompt || 'Confermi di voler procedere con questa operazione?',
        preview: Array.isArray(params.preview) ? params.preview : [],
        actions: Array.isArray(params.actions) ? params.actions : [],
        confirmLabel: params.confirmLabel || 'Approva',
        cancelLabel: params.cancelLabel || 'Blocca'
      });
    },

    async requestActionPermission(actions, preview, params = {}) {
      const response = await requestClientResponse(turnId, {
        id: makeRequestId('preview'),
        type: 'permission',
        taskId,
        title: params.title || `Conferma modifiche: ${task?.description || task?.tool || taskId}`,
        prompt: params.prompt || 'Verifica l\'anteprima delle modifiche al workbook prima di applicarle.',
        preview: preview?.items || [],
        summary: preview || null,
        actions: Array.isArray(actions) ? actions : [],
        confirmLabel: params.confirmLabel || 'Applica modifiche',
        cancelLabel: params.cancelLabel || 'Annulla task'
      });

      if (!response || response.approved !== true) {
        throw new Error(response?.reason || 'Modifiche al workbook rifiutate dall\'utente');
      }

      return response;
    }
  };
}

async function failTurn(turnId, errorMessage, itemPatch) {
  if (itemPatch) {
    const errorItem = upsertItem(turnId, {
      ...itemPatch,
      status: 'error',
      error: errorMessage
    });
    emitItemCompleted(turnId, errorItem);
  }

  appendLog(turnId, errorMessage, 'error');
  const turn = setTurnStatus(turnId, 'error', errorMessage);
  emitTurnCompleted(turn);
  return turn;
}

function isSafeTask(task) {
  return isPrefetchSafeTask(task, registry);
}

function buildLayoutFromResults(results) {
  if (!results || typeof results !== 'object') return { sheets: [], references: new Set() };
  const sheets = new Set();
  const references = new Set();
  for (const result of Object.values(results)) {
    if (!result) continue;
    // Estrai sheet da actions createSheet
    if (Array.isArray(result.actions)) {
      for (const action of result.actions) {
        if (action.type === 'createSheet' && action.name) sheets.add(action.name);
        if (action.sheet) sheets.add(action.sheet);
        // Aggiungi target come riferimento noto
        if (action.target) references.add(action.target);
      }
    }
    // Estrai sheet da data (layout JSON potrebbe avere sheets[])
    if (result.data && typeof result.data === 'object') {
      if (Array.isArray(result.data.sheets)) {
        result.data.sheets.forEach(s => sheets.add(s));
      }
      if (Array.isArray(result.data.references)) {
        result.data.references.forEach(r => references.add(r));
      }
      if (Array.isArray(result.data.sections)) {
        for (const section of result.data.sections) {
          if (Array.isArray(section.cells)) {
            section.cells.forEach(c => references.add(c));
          }
        }
      }
    }
  }
  return { sheets: [...sheets], references };
}

const STANDARD_DCF_SHEETS = ['Summary', 'Sources', 'Assumptions', 'WACC', 'DCF', 'Sensitivity', 'Scenarios', 'Audit'];

function addSheetName(set, value) {
  if (!value) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) set.add(trimmed);
    return;
  }
  if (typeof value === 'object') {
    addSheetName(set, value.name || value.sheetName || value.sheet || value.targetSheet);
  }
}

function addSheetsFromActions(set, actions) {
  if (!Array.isArray(actions)) return;
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    if (action.type === 'createSheet') addSheetName(set, action.name || action.sheet);
    addSheetName(set, action.sheet || action.sheetName || action.targetSheet);
    if (action.type === 'setCellRange' && action.cells && typeof action.cells === 'object') {
      for (const address of Object.keys(action.cells)) {
        const match = String(address).match(/^(?:'((?:[^']|'')+)'|([^!]+))!/);
        if (match) addSheetName(set, (match[1] || match[2] || '').replace(/''/g, "'"));
      }
    }
  }
}

function extractTurnMemorySummary(turn, failedTaskIds = new Set()) {
  const sheets = new Set();
  const dcfSections = new Set();
  let modelType = null;

  for (const task of (turn.plan?.tasks || [])) {
    if (failedTaskIds.has(task.id)) continue;
    if (task.tool === 'excel.createSheet') addSheetName(sheets, task.params?.name || task.params?.sheet);
    if (task.tool === 'llm.planLayout' && task.params?.model) modelType = task.params.model;
    if (task.tool === 'finance.dcf.buildSection') {
      modelType = 'DCF';
      if (task.params?.section) dcfSections.add(String(task.params.section).toLowerCase());
      if (Array.isArray(task.params?.sheets)) task.params.sheets.forEach(sheet => addSheetName(sheets, sheet));
    }
  }

  for (const result of Object.values(turn.results || {})) {
    if (!result) continue;
    addSheetsFromActions(sheets, result.actions);
    const data = result.data && typeof result.data === 'object' ? result.data : null;
    if (!data) continue;
    addSheetName(sheets, data.sheetName || data.name || data.sheet);
    if (Array.isArray(data.sheets)) data.sheets.forEach(sheet => addSheetName(sheets, sheet));
    if (data.allSheetsData && typeof data.allSheetsData === 'object') {
      Object.keys(data.allSheetsData).forEach(name => addSheetName(sheets, name));
    }
    addSheetsFromActions(sheets, data.actions);
  }

  const sheetList = Array.from(sheets);
  const hasDcfSignal = modelType === 'DCF' ||
    dcfSections.size > 0 ||
    STANDARD_DCF_SHEETS.filter(sheet => sheetList.some(name => name.toLowerCase() === sheet.toLowerCase())).length >= 3;
  const modelSheets = hasDcfSignal
    ? STANDARD_DCF_SHEETS.filter(sheet => sheetList.some(name => name.toLowerCase() === sheet.toLowerCase()))
    : sheetList;

  const keyCells = hasDcfSignal ? {
    assumptions: 'Assumptions!B10:B37',
    wacc: 'WACC!B4:B30',
    valuation: 'DCF!H30:H40',
    sensitivity: 'Sensitivity!B4:G18'
  } : null;

  return {
    sheetsCreated: modelSheets,
    modelType: hasDcfSignal ? 'DCF' : (modelType || (sheetList.length > 0 ? 'custom' : null)),
    keyCells
  };
}

async function planTurn(turnId) {
  const turn = _getTurnRef(turnId);
  if (!turn) throw new Error(`Turn non trovato: ${turnId}`);

  try {
    appendLog(turnId, 'Creo il piano di esecuzione agentico...');

    // If this turn has a parent, include parent results in context so planner can do incremental work
    const { parentPlan, parentResults } = getParentContinuity(turn);
    if (turn.parentTurnId) {
      if (parentPlan || parentResults) {
        appendLog(turnId, `Turn collegato a parent ${turn.parentTurnId}. Risultati precedenti disponibili per pianificazione incrementale.`);
      } else {
        appendLog(turnId, `Turn parent ${turn.parentTurnId} non trovato. Procedo con il solo contesto corrente.`, 'warn');
      }
    }

    const enrichedContext = {
      ...turn.context,
      conversationHistory: conversationMemory.getConversationContext(),
      recentSheets: conversationMemory.getRecentSheets(),
      lastModelState: conversationMemory.getLastModelState(),
      parentResults,
      parentPlan
    };
    const plan = await planner.plan(turn.objective, enrichedContext, turnId, {
      modelOverride: turn.llm?.modelOverride || undefined
    });

    const updatedTurn = _getTurnRef(turnId);
    updatedTurn.plan = plan;
    updatedTurn.status = 'awaiting_approval';
    saveTurn(updatedTurn);

    const completedPlanItem = upsertItem(turnId, {
      id: 'plan',
      type: 'plan',
      title: 'Piano proposto',
      status: 'completed',
      objective: plan.objective || turn.objective,
      tasks: plan.tasks
    });

    emitPlanUpdated(updatedTurn);
    emitItemCompleted(turnId, completedPlanItem);
    appendLog(turnId, `Piano pronto: ${plan.tasks.length} task. Attendo conferma per eseguire.`);

    // Auto-execute safe tasks per-level while user reviews plan (prefetch).
    // Cascades: level 0 safe → wait → level 1 safe (deps now satisfied) → ...
    const levels = computeLevels(plan.tasks);
    const sortedLevels = Array.from(levels.keys()).sort((a, b) => a - b);
    const PREFETCH_MAX_LEVEL = Number(process.env.PREFETCH_MAX_LEVEL ?? 2);

    const prefetchByLevel = sortedLevels
      .filter(l => l <= PREFETCH_MAX_LEVEL)
      .map(l => ({
        level: l,
        tasks: (levels.get(l) || [])
          .map(id => plan.tasks.find(t => t.id === id))
          .filter(t => t && isSafeTask(t))
      }))
      .filter(b => b.tasks.length > 0);

    if (prefetchByLevel.length > 0) {
      const totalPrefetch = prefetchByLevel.reduce((s, b) => s + b.tasks.length, 0);
      appendLog(turnId, `Prefetch ${totalPrefetch} task safe in background (livelli ${prefetchByLevel.map(b => b.level).join(',')})...`);
      (async () => {
        for (const batch of prefetchByLevel) {
          const results = await Promise.allSettled(batch.tasks.map(task => executeSingleTask(turnId, task)));
          const failed = results.filter(r => r.status === 'rejected' || r.value?.ok === false);
          if (failed.length > 0) {
            appendLog(turnId, `Errore prefetch livello ${batch.level}: ${failed.length} task falliti`, 'error');
          }
        }
        appendLog(turnId, `Prefetch completato. In attesa di approvazione per le mutazioni.`);
      })();
    }

    emitTurnAwaitingApproval(updatedTurn);
  } catch (error) {
    await failTurn(turnId, `Errore pianificazione: ${error.message}`, {
      id: 'plan',
      type: 'plan',
      title: 'Piano proposto'
    });
  }
}

async function executeSingleTask(turnId, task) {
  const key = `${turnId}:${task.id}`;
  if (runningTaskPromises.has(key)) {
    appendLog(turnId, `[${task.id}] già in corso (prefetch), attendo completamento`, 'info', { taskId: task.id });
    return runningTaskPromises.get(key);
  }
  const promise = executeSingleTaskInner(turnId, task)
    .finally(() => runningTaskPromises.delete(key));
  runningTaskPromises.set(key, promise);
  return promise;
}

async function executeSingleTaskInner(turnId, task) {
  const itemId = taskItemId(task.id);
  logger.info(`[Turn ${turnId}][${task.id}] Start task: ${task.agent}/${task.tool}`);
  const runningItem = upsertItem(turnId, {
    id: itemId,
    type: 'taskExecution',
    taskId: task.id,
    agent: task.agent,
    tool: task.tool,
    description: task.description || task.tool,
    deps: task.deps || [],
    status: 'inProgress'
  });

  emitItemStarted(turnId, runningItem);
  appendLog(turnId, `[${task.id}] ${task.agent}/${task.tool} avviato`, 'info', { taskId: task.id, itemId });

  try {
    const turn = _getTurnRef(turnId);
    const runtime = buildRuntimeHelpers(turnId, task);
    const start = Date.now();

    // Critic retry loop: re-prompt FormulaAgent on validation errors (max CRITIC_MAX_RETRY).
    const MAX_CRITIC_RETRY = Number(process.env.CRITIC_MAX_RETRY ?? 2);
    const isFormulaTask = task.tool === 'llm.writeFormulas'
      || (task.tool === 'finance.dcf.buildSection' && task.agent === 'formula');
    let result;
    let criticResult;
    let attempt = 0;
    let activeParams = { ...(task.params || {}) };

    while (true) {
      const executionMemory = buildExecutionMemory(turn, { ...task, params: activeParams }, runtime);
      result = await executeTool(
        task.tool,
        activeParams,
        executionMemory
      );
      const layout = buildLayoutFromResults(executionMemory.results);
      criticResult = validateTaskOutput(result, layout);

      const shouldRetry = isFormulaTask
        && !criticResult.ok
        && criticResult.errors.length > 0
        && attempt < MAX_CRITIC_RETRY;
      if (!shouldRetry) break;

      attempt++;
      const errorMessages = criticResult.errors.map(e => {
        const ref = e.action ? ` [${e.action.type}${e.action.target ? ' ' + e.action.target : ''}]` : '';
        return `${e.error}${ref}`;
      });
      appendLog(turnId, `[${task.id}] Critic retry ${attempt}/${MAX_CRITIC_RETRY}: ${errorMessages.length} errori → re-prompt FormulaAgent`, 'warn', { taskId: task.id, itemId });
      activeParams = { ...activeParams, criticErrors: errorMessages };
    }

    const elapsed = Date.now() - start;
    logger.info(`[Turn ${turnId}][${task.id}] Task completed in ${elapsed}ms (retry=${attempt})`);

    if (!criticResult.ok || criticResult.errors.length > 0) {
      const errorSummary = criticResult.errors.map(e => e.error).join('; ');
      appendLog(turnId, `[${task.id}] Validazione output: ${criticResult.errors.length} errori: ${errorSummary}`, 'warn', {
        taskId: task.id,
        itemId
      });
    }
    if (criticResult.warnings.length > 0) {
      const warnSummary = criticResult.warnings.join('; ');
      appendLog(turnId, `[${task.id}] Warning: ${warnSummary}`, 'warn', { taskId: task.id, itemId });
    }
    if (result.data?.builder) {
      appendLog(turnId, `[${task.id}] Builder: ${result.data.builder}`, result.data.aiError ? 'warn' : 'info', {
        taskId: task.id,
        itemId
      });
    }

    // Log metriche critic (formula count, mutation count)
    if (criticResult.stats) {
      appendLog(turnId, `[${task.id}] Stats: ${criticResult.stats.formulaCount} formule, ${criticResult.stats.mutationCount} mutazioni`, 'info');
    }

    if (result.actions && result.actions.length > 0) {
      // Smart approval: check requiresApproval from tool registry
      const AUTO_APPROVE = process.env.AUTO_APPROVE_ALL === 'true';
      const toolMeta = registry.meta(task.tool);
      const actionHasMutations = hasMutationActions(result.actions);
      const needsApproval = !AUTO_APPROVE && (
        task.requiresApproval === true ||
        toolMeta?.requiresApproval === 'always' ||
        (toolMeta?.category === 'mutation' && actionHasMutations) ||
        actionHasMutations
      );

      if (needsApproval && (actionHasMutations || task.requiresApproval)) {
        const preview = buildActionPreview(result.actions, task);
        appendLog(turnId, `[${task.id}] In attesa di conferma per ${preview.mutationCount} modifiche`, 'info', {
          taskId: task.id,
          itemId
        });
        await runtime.requestActionPermission(result.actions, preview);
      }

      appendLog(turnId, `[${task.id}] Inviate ${result.actions.length} azioni Excel`, 'info', { taskId: task.id, itemId });
      emitTaskActions(turnId, task, result.actions);
    }

    storeTaskResult(turnId, task.id, result);

    const completedItem = upsertItem(turnId, {
      id: itemId,
      type: 'taskExecution',
      taskId: task.id,
      agent: task.agent,
      tool: task.tool,
      description: task.description || task.tool,
      deps: task.deps || [],
      status: 'completed',
      result: result.data || result,
      actionCount: result.actions ? result.actions.length : 0
    });

    emitItemCompleted(turnId, completedItem);
    appendLog(turnId, `[${task.id}] completato`, 'info', { taskId: task.id, itemId });
    return { ok: true, taskId: task.id, result };
  } catch (error) {
    logger.error(`[Turn ${turnId}][${task.id}] Task error: ${error.message}`);
    storeTaskResult(turnId, task.id, {
      ok: false,
      error: error.message,
      agent: task.agent,
      tool: task.tool
    });
    const failedItem = upsertItem(turnId, {
      id: itemId,
      type: 'taskExecution',
      taskId: task.id,
      agent: task.agent,
      tool: task.tool,
      description: task.description || task.tool,
      deps: task.deps || [],
      status: 'error',
      error: error.message
    });

    emitItemCompleted(turnId, failedItem);
    appendLog(turnId, `[${task.id}] errore: ${error.message}`, 'error', { taskId: task.id, itemId });
    // Non rilanciare: gli altri task dello stesso livello possono continuare,
    // ma il caller riceve un esito strutturato per marcare il turn come fallito.
    return { ok: false, taskId: task.id, error: error.message };
  }
}

function skipTaskDueToFailedDeps(turnId, task, failedDeps) {
  const itemId = taskItemId(task.id);
  const message = `Saltato perché dipendenze fallite: ${failedDeps.join(', ')}`;
  storeTaskResult(turnId, task.id, {
    ok: false,
    skipped: true,
    error: message,
    agent: task.agent,
    tool: task.tool,
    failedDeps
  });
  const item = upsertItem(turnId, {
    id: itemId,
    type: 'taskExecution',
    taskId: task.id,
    agent: task.agent,
    tool: task.tool,
    description: task.description || task.tool,
    deps: task.deps || [],
    status: 'error',
    error: message
  });
  emitItemStarted(turnId, item);
  emitItemCompleted(turnId, item);
  appendLog(turnId, `[${task.id}] ${message}`, 'warn', { taskId: task.id, itemId });
  return { ok: false, skipped: true, taskId: task.id, error: message };
}

async function executeTurn(turnId) {
  const turn = _getTurnRef(turnId);
  if (!turn) throw new Error(`Turn non trovato: ${turnId}`);
  if (!turn.plan || !Array.isArray(turn.plan.tasks) || turn.plan.tasks.length === 0) {
    throw new Error("Nessun task disponibile per l'esecuzione");
  }

  logger.info(`[Turn ${turnId}] Execute turn with ${turn.plan.tasks.length} tasks`);
  try {
    const levels = computeLevels(turn.plan.tasks);
    const sortedLevels = Array.from(levels.keys()).sort((left, right) => left - right);

    const failedTaskIds = new Set();
    for (const level of sortedLevels) {
      const taskIds = levels.get(level) || [];
      appendLog(turnId, `Livello ${level}: eseguo ${taskIds.length} task`, 'info', { level });

      const results = await Promise.allSettled(taskIds.map(taskId => {
        const task = turn.plan.tasks.find(entry => entry.id === taskId);
        if (!task) throw new Error(`Task non trovato: ${taskId}`);
        const failedDeps = (task.deps || []).filter(dep => failedTaskIds.has(dep));
        if (failedDeps.length > 0) {
          return skipTaskDueToFailedDeps(turnId, task, failedDeps);
        }
        // Skip task già eseguiti dal prefetch (read-only safe in background)
        const liveTurn = _getTurnRef(turnId);
        if (liveTurn?.results && Object.prototype.hasOwnProperty.call(liveTurn.results, taskId)) {
          appendLog(turnId, `[${taskId}] già eseguito (prefetch), skip`, 'info');
          return Promise.resolve();
        }
        return executeSingleTask(turnId, task);
      }));

      results.forEach((result, idx) => {
        if (result.status === 'rejected' || result.value?.ok === false) {
          failedTaskIds.add(taskIds[idx]);
        }
      });
    }

    const finalError = failedTaskIds.size > 0
      ? `${failedTaskIds.size} task falliti su ${turn.plan.tasks.length}: ${Array.from(failedTaskIds).join(', ')}`
      : undefined;
    const completedTurn = setTurnStatus(
      turnId,
      failedTaskIds.size > 0 ? 'error' : 'completed',
      finalError
    );
    if (failedTaskIds.size > 0) {
      appendLog(turnId, `Turn completato con ${failedTaskIds.size} task falliti su ${turn.plan.tasks.length}.`, 'warn');
      logger.warn(`[Turn ${turnId}] Turn completed with ${failedTaskIds.size} failed tasks: ${Array.from(failedTaskIds).join(', ')}`);
    } else {
      appendLog(turnId, 'Turn completato con successo.');
    }

    // NarratorAgent: genera sintesi in linguaggio naturale
    try {
      const narration = await runNarratorAgent(completedTurn.objective, completedTurn.results);
      appendLog(turnId, narration.message, 'info');
      if (narration.suggestions.length > 0) {
        appendLog(turnId, `Suggerimenti: ${narration.suggestions.join(' | ')}`, 'info');
      }
      completedTurn.narration = narration;
    } catch (narrErr) {
      logger.warn(`[Turn ${turnId}] Narrator fallito: ${narrErr.message}`);
    }

    emitTurnCompleted(completedTurn);
    if (failedTaskIds.size > 0) {
      logger.info(`[Turn ${turnId}] Turn completed with partial success (${failedTaskIds.size} failures)`);
    } else {
      logger.info(`[Turn ${turnId}] Turn completed successfully`);
    }

    const memorySummary = extractTurnMemorySummary(completedTurn, failedTaskIds);
    const successCount = turn.plan.tasks.length - failedTaskIds.size;
    conversationMemory.addTurnMemory({
      turnId,
      objective: completedTurn.objective,
      planSummary: `Piano con ${successCount}/${turn.plan.tasks.length} task completati${failedTaskIds.size > 0 ? ` (${failedTaskIds.size} falliti)` : ''}`,
      sheetsCreated: memorySummary.sheetsCreated,
      modelType: memorySummary.modelType,
      keyCells: memorySummary.keyCells
    });
  } catch (error) {
    logger.error(`[Turn ${turnId}] Turn execution error: ${error.message}`);
    await failTurn(turnId, `Errore esecuzione: ${error.message}`);
  }
}

function startTurn(message, context, parentTurnId = null, options = {}) {
  const turn = buildTurn(message, context, parentTurnId, options);
  saveTurn(turn);

  emitTurnStarted(turn);

  const userItem = upsertItem(turn.id, {
    id: 'user-message',
    type: 'userMessage',
    role: 'user',
    content: message,
    status: 'completed'
  });
  emitItemStarted(turn.id, userItem);
  emitItemCompleted(turn.id, userItem);

  const planItem = upsertItem(turn.id, {
    id: 'plan',
    type: 'plan',
    title: 'Piano proposto',
    status: 'inProgress',
    objective: message
  });
  emitItemStarted(turn.id, planItem);

  void planTurn(turn.id);
  return loadTurn(turn.id);
}

function approveTurn(turnId) {
  const turn = _getTurnRef(turnId);
  if (!turn) throw new Error(`Turn non trovato: ${turnId}`);
  if (!turn.plan || !Array.isArray(turn.plan.tasks) || turn.plan.tasks.length === 0) {
    throw new Error('Il turn non ha ancora un piano eseguibile');
  }
  if (turn.status === 'running') return turn;
  if (turn.status === 'completed') return turn;
  if (turn.status === 'error') throw new Error(turn.error || 'Turn in errore');

  const runningTurn = setTurnStatus(turnId, 'running');
  appendLog(turnId, 'Avvio esecuzione del piano approvato.');
  void executeTurn(turnId);
  return runningTurn;
}

function respondToTurnRequest(turnId, requestId, response) {
  const request = getPendingRequest(turnId, requestId);
  if (!request) {
    throw new Error(`Richiesta non trovata o già risolta: ${requestId}`);
  }

  if (response && response.error) {
    const handled = rejectClientResponse(turnId, requestId, new Error(response.error));
    if (!handled) {
      throw new Error(`Nessun listener attivo per la richiesta ${requestId}`);
    }
    return { ok: true };
  }

  const handled = resolveClientResponse(turnId, requestId, response);
  if (!handled) {
    throw new Error(`Nessun listener attivo per la richiesta ${requestId}`);
  }
  return { ok: true };
}

function undoTurn(turnId) {
  const turn = _getTurnRef(turnId);
  if (!turn) throw new Error(`Turn non trovato: ${turnId}`);
  if (turn.status !== 'completed' && turn.status !== 'error') {
    throw new Error(`Undo disponibile solo su turn completed/error (stato attuale: ${turn.status})`);
  }
  if (turn.undone) {
    throw new Error('Turn già annullato');
  }

  const undoData = buildUndoActions(turn);
  const summary = summarizeUndo(undoData);

  if (undoData.actions.length === 0) {
    appendLog(turnId, `Undo: nessuna azione invertibile (skipped: ${summary.skippedCount})`, 'warn');
    turn.undone = true;
    turn.undoResult = { ...summary, performedAt: nowIso() };
    saveTurn(turn);
    return { ok: true, summary };
  }

  // Emit reverse actions in un singolo batch
  streaming.sendEvent(turnId, 'taskActions', {
    turnId,
    taskId: 'undo',
    itemId: 'undo',
    actions: undoData.actions,
    isUndo: true
  });

  appendLog(turnId, `Undo: emesse ${undoData.actions.length} azioni inverse (skipped: ${summary.skippedCount})`, 'info');
  turn.undone = true;
  turn.undoResult = { ...summary, performedAt: nowIso() };
  saveTurn(turn);
  return { ok: true, summary, actions: undoData.actions, skipped: undoData.skipped };
}

module.exports = {
  startTurn,
  approveTurn,
  loadTurn,
  buildExecutionMemory,
  respondToTurnRequest,
  undoTurn
};
