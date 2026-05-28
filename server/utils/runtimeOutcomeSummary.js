const fs = require('fs');
const path = require('path');

const AGENT_LOOP_TASK_ID = 'agent-loop';
const TURNS_DIR = process.env.ADMIN_TURNS_DIR || path.join(__dirname, '..', 'turns');
const MAX_TURN_FILES_TO_SCAN = Math.max(10, Number(process.env.ADMIN_TURN_SCAN_MAX_FILES) || 300);

function listTurnFiles() {
  try {
    return fs.readdirSync(TURNS_DIR)
      .filter(name => name.endsWith('.json'))
      .sort()
      .slice(-MAX_TURN_FILES_TO_SCAN);
  } catch (_) {
    return [];
  }
}

function parseTimestamp(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function normalizeIterations(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function classifyAgentLoopReason(status, summary) {
  const cleanStatus = String(status || 'unknown').trim().toLowerCase();
  const cleanSummary = String(summary || '').trim();
  const summaryLower = cleanSummary.toLowerCase();

  if (cleanStatus === 'completed') {
    return { category: 'completed', detail: 'completed' };
  }
  if (summaryLower.startsWith('stagnation_')) {
    return { category: 'stagnation', detail: cleanSummary };
  }
  if (cleanStatus === 'max_iterations' || summaryLower.includes('reached max iterations')) {
    return { category: 'max_iterations', detail: 'max_iterations' };
  }
  if (summaryLower.startsWith('repeated_error_x')) {
    return { category: 'repeated_error', detail: cleanSummary.split(':')[0] || 'repeated_error' };
  }
  if (summaryLower.startsWith('fatal_error:')) {
    return { category: 'fatal_error', detail: 'fatal_error' };
  }
  if (cleanStatus === 'paused' || summaryLower.includes('user_input_required')) {
    return { category: 'user_input_required', detail: 'user_input_required' };
  }
  if (cleanStatus === 'aborted') {
    return { category: 'aborted', detail: cleanSummary || 'aborted' };
  }
  return { category: cleanStatus || 'unknown', detail: cleanSummary || cleanStatus || 'unknown' };
}

function extractAgentLoopOutcome(turn) {
  if (!turn || typeof turn !== 'object') return null;
  const primary = turn.results?.[AGENT_LOOP_TASK_ID]?.data || null;
  const attempt = turn.results?.[`${AGENT_LOOP_TASK_ID}:attempt`]?.data || null;
  const taskItem = Array.isArray(turn.items)
    ? turn.items.find(item => item?.taskId === AGENT_LOOP_TASK_ID)
    : null;
  const itemResult = taskItem?.result || null;
  const data = primary || attempt || itemResult;
  if (!data || typeof data !== 'object') return null;

  const status = data.status || itemResult?.status || null;
  const summary = data.summary || itemResult?.summary || '';
  const reason = classifyAgentLoopReason(status, summary);
  const eventTs = taskItem?.completedAt || turn.updatedAt || turn.createdAt || null;
  const strategyReason = data.strategy || turn.strategy?.reason || null;
  const promptVariant = data.promptVariant || turn.strategy?.promptVariant || null;
  const escalated = Boolean(
    attempt?.escalated ||
    data.escalated ||
    itemResult?.escalated
  );

  return {
    turnId: turn.id || null,
    userId: turn.userId || null,
    turnStatus: turn.status || null,
    createdAt: turn.createdAt || null,
    updatedAt: turn.updatedAt || null,
    ts: eventTs,
    status: status || 'unknown',
    summary,
    iteration: normalizeIterations(data.iteration || itemResult?.iteration),
    strategyReason,
    promptVariant,
    escalated,
    reasonCategory: reason.category,
    reasonDetail: reason.detail,
  };
}

function matchesOutcomeFilters(outcome, filters = {}) {
  if (!outcome) return false;
  if (filters.turnId && outcome.turnId !== filters.turnId) return false;
  if (filters.status && outcome.status !== filters.status) return false;
  if (filters.reasonCategory && outcome.reasonCategory !== filters.reasonCategory) return false;
  if (filters.escalated !== undefined && outcome.escalated !== filters.escalated) return false;
  if (filters.sinceMs) {
    const ts = parseTimestamp(outcome.ts || outcome.updatedAt || outcome.createdAt);
    if (!ts || ts < filters.sinceMs) return false;
  }
  return true;
}

function readRuntimeOutcomes(filters = {}) {
  const limit = Math.max(1, Number(filters.limit) || 50);
  const descending = filters.descending !== false;
  const files = listTurnFiles();
  const records = [];

  for (const fileName of files) {
    const filePath = path.join(TURNS_DIR, fileName);
    try {
      const turn = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const outcome = extractAgentLoopOutcome(turn);
      if (!matchesOutcomeFilters(outcome, filters)) continue;
      records.push(outcome);
    } catch (_) {
      // Skip malformed turn files
    }
  }

  records.sort((left, right) => {
    const leftTs = parseTimestamp(left.ts || left.updatedAt || left.createdAt) || 0;
    const rightTs = parseTimestamp(right.ts || right.updatedAt || right.createdAt) || 0;
    return descending ? rightTs - leftTs : leftTs - rightTs;
  });

  return records.slice(0, limit);
}

function summarizeRuntimeOutcomes(filters = {}) {
  const records = readRuntimeOutcomes({
    ...filters,
    limit: filters.summaryLimit || 1000,
    descending: true
  });
  const summary = {
    count: records.length,
    completed: 0,
    aborted: 0,
    maxIterations: 0,
    paused: 0,
    escalated: 0,
    avgIterations: 0,
    avgEscalatedIterations: 0,
    newestTs: records[0]?.ts || null,
    oldestTs: records[records.length - 1]?.ts || null,
    byReasonCategory: {},
    byReasonDetail: {},
    byPromptVariant: {},
    byStrategyReason: {},
    byStatus: {},
  };

  let totalIterations = 0;
  let totalIterationCount = 0;
  let totalEscalatedIterations = 0;
  let totalEscalatedCount = 0;

  for (const record of records) {
    const statusKey = record.status || 'unknown';
    summary.byStatus[statusKey] = (summary.byStatus[statusKey] || 0) + 1;
    if (statusKey === 'completed') summary.completed += 1;
    if (statusKey === 'aborted') summary.aborted += 1;
    if (statusKey === 'max_iterations') summary.maxIterations += 1;
    if (statusKey === 'paused') summary.paused += 1;
    if (record.escalated) summary.escalated += 1;

    if (record.iteration != null) {
      totalIterations += record.iteration;
      totalIterationCount += 1;
      if (record.escalated) {
        totalEscalatedIterations += record.iteration;
        totalEscalatedCount += 1;
      }
    }

    const categoryKey = record.reasonCategory || 'unknown';
    if (!summary.byReasonCategory[categoryKey]) {
      summary.byReasonCategory[categoryKey] = { count: 0, escalated: 0, iterations: 0, samples: 0 };
    }
    summary.byReasonCategory[categoryKey].count += 1;
    if (record.escalated) summary.byReasonCategory[categoryKey].escalated += 1;
    if (record.iteration != null) {
      summary.byReasonCategory[categoryKey].iterations += record.iteration;
      summary.byReasonCategory[categoryKey].samples += 1;
    }

    const detailKey = record.reasonDetail || categoryKey;
    if (!summary.byReasonDetail[detailKey]) {
      summary.byReasonDetail[detailKey] = { count: 0, escalated: 0 };
    }
    summary.byReasonDetail[detailKey].count += 1;
    if (record.escalated) summary.byReasonDetail[detailKey].escalated += 1;

    const variantKey = record.promptVariant || 'unknown';
    summary.byPromptVariant[variantKey] = (summary.byPromptVariant[variantKey] || 0) + 1;

    const strategyKey = record.strategyReason || 'unknown';
    summary.byStrategyReason[strategyKey] = (summary.byStrategyReason[strategyKey] || 0) + 1;
  }

  for (const bucket of Object.values(summary.byReasonCategory)) {
    bucket.avgIterations = bucket.samples ? Math.round(bucket.iterations / bucket.samples) : 0;
    delete bucket.iterations;
    delete bucket.samples;
  }

  summary.avgIterations = totalIterationCount ? Math.round(totalIterations / totalIterationCount) : 0;
  summary.avgEscalatedIterations = totalEscalatedCount ? Math.round(totalEscalatedIterations / totalEscalatedCount) : 0;
  return summary;
}

module.exports = {
  TURNS_DIR,
  classifyAgentLoopReason,
  extractAgentLoopOutcome,
  readRuntimeOutcomes,
  summarizeRuntimeOutcomes,
};
