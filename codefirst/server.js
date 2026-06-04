'use strict';

const express = require('express');
const { enhancedPipeline } = require('./enhanced');
const { executeCodeAndStream } = require('./bridge');
const logger = require('../server/utils/logger');

const router = express.Router();

const activeRuns = new Map();

function chunkActions(actions, maxCellsPerBatch = 200) {
  const batches = [];
  let current = [];
  let currentCells = 0;

  for (const action of actions) {
    let actionCells = 0;
    if (action.type === 'setCellRange' && action.cells) {
      actionCells = Object.keys(action.cells).length;
    }

    if (currentCells + actionCells > maxCellsPerBatch && current.length > 0) {
      batches.push(current);
      current = [];
      currentCells = 0;
    }

    current.push(action);
    currentCells += actionCells;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

async function generateAndExecute(objective, context = {}, options = {}) {
  const { turnId, modelOverride, timeoutMs = 240000, enableCritic = false } = options;

  const result = await enhancedPipeline(objective, context, {
    modelOverride,
    skipCritic: !enableCritic,
    onProgress: options.onProgress || null,
  });

  if (result.status !== 'ok') {
    throw new Error(result.error || 'Pipeline failed');
  }

  const chunkedBatches = chunkActions(result.actions, 200);

  return {
    code: result.code,
    codeLength: result.codeLength,
    warnings: [],
    actions: result.actions,
    batches: chunkedBatches,
    cellCount: result.cellCount,
    plan: result.plan,
    review: result.review,
    tokenUsage: result.totalTokens,
    timings: {
      planMs: result.pipeline?.phases?.plan?.planTimeMs || 0,
      codegenMs: result.pipeline?.phases?.codegen?.codeTimeMs || 0,
      criticMs: result.pipeline?.phases?.critic?.reviewTimeMs || 0,
      executionMs: result.pipeline?.phases?.execution?.executionMs || 0,
      totalMs: result.totalMs,
    },
    skillNames: result.skillNames,
  };
}

function streamActionsWithThrottle(turnId, chunkedBatches, streaming) {
  const sendEvent = streaming.sendEvent.bind(streaming);
  let batchIdx = 0;
  const BATCH_INTERVAL_MS = 80;
  const MAX_BATCHES_PER_TICK = 3;

  function sendBatch() {
    if (batchIdx >= chunkedBatches.length) {
      sendEvent(turnId, 'codefirstComplete', { turnId, totalBatches: chunkedBatches.length });
      return;
    }

    const batchesThisTick = Math.min(MAX_BATCHES_PER_TICK, chunkedBatches.length - batchIdx);
    for (let i = 0; i < batchesThisTick; i++) {
      const batch = chunkedBatches[batchIdx];
      sendEvent(turnId, 'taskActions', {
        turnId,
        taskId: 'codefirst',
        itemId: `batch_${batchIdx}`,
        actions: batch,
      });
      batchIdx++;
    }

    if (batchIdx < chunkedBatches.length) {
      setTimeout(sendBatch, BATCH_INTERVAL_MS);
    } else {
      sendEvent(turnId, 'codefirstComplete', { turnId, totalBatches: chunkedBatches.length });
    }
  }

  sendBatch();
}

router.post('/start', async (req, res) => {
  const { message, context = {}, modelOverride } = req.body;
  const turnId = `cf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  logger.info(`[CodeFirst] Starting turn ${turnId}: "${message.slice(0, 100)}..."`);

  try {
    const result = await generateAndExecute(message, context, {
      turnId,
      modelOverride,
      timeoutMs: 180000,
    });

    const IS_VERCEL = !!process.env.VERCEL;

    if (IS_VERCEL) {
      res.json({
        turnId,
        status: 'ready',
        actions: result.actions,
        batches: result.batches,
        cellCount: result.cellCount,
        codeLength: result.codeLength,
        plan: result.plan ? { sections: result.plan.sections?.length, model_type: result.plan.model_type, estimated_cells: result.plan.estimated_cells } : null,
        review: result.review ? { approved: result.review.approved, score: result.review.score, issues: result.review.issues?.length } : null,
        warnings: result.warnings,
        tokenUsage: result.tokenUsage,
        timings: result.timings,
        skillNames: result.skillNames,
      });
    } else {
      activeRuns.set(turnId, {
        batches: result.batches,
        cellCount: result.cellCount,
        codeLength: result.codeLength,
        plan: result.plan,
        review: result.review,
        warnings: result.warnings,
        tokenUsage: result.tokenUsage,
        timings: result.timings,
        skillNames: result.skillNames,
        code: result.code,
        status: 'ready',
        batchCount: result.batches.length,
      });

      res.json({
        turnId,
        status: 'ready',
        batchCount: result.batches.length,
        cellCount: result.cellCount,
        codeLength: result.codeLength,
        plan: result.plan ? { sections: result.plan.sections?.length, model_type: result.plan.model_type, estimated_cells: result.plan.estimated_cells } : null,
        review: result.review ? { approved: result.review.approved, score: result.review.score, issues: result.review.issues?.length } : null,
        warnings: result.warnings,
        tokenUsage: result.tokenUsage,
        timings: result.timings,
        skillNames: result.skillNames,
      });
    }
  } catch (error) {
    logger.error(`[CodeFirst] Error for ${turnId}: ${error.message}`);
    res.status(500).json({ error: error.message, turnId });
  }
});

router.get('/stream/:turnId', (req, res) => {
  const { turnId } = req.params;
  const state = activeRuns.get(turnId);

  if (!state) {
    return res.status(404).json({ error: 'Turn not found' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  res.write(`data: ${JSON.stringify({ eventType: 'turnStarted', turnId, status: state.status })}\n\n`);

  if (state.status === 'ready') {
    res.write(`data: ${JSON.stringify({ eventType: 'codefirstReady', turnId, batchCount: state.batchCount, cellCount: state.cellCount, warnings: state.warnings, tokenUsage: state.tokenUsage })}\n\n`);

    const streaming = require('../server/agents/streaming');
    streamActionsWithThrottle(turnId, state.batches, {
      sendEvent: (id, eventType, data) => {
        try {
          res.write(`data: ${JSON.stringify({ ...data, eventType })}\n\n`);
        } catch (_) {}
      }
    });
  } else if (state.status === 'error') {
    res.write(`data: ${JSON.stringify({ eventType: 'codefirstError', turnId, error: state.error })}\n\n`);
    res.end();
  }

  req.on('close', () => {
    if (state.status === 'ready') {
      setTimeout(() => activeRuns.delete(turnId), 300000);
    }
  });
});

router.post('/approve', async (req, res) => {
  const { turnId } = req.body || {};
  const state = activeRuns.get(turnId);

  if (!state) {
    return res.status(404).json({ error: 'Turn not found' });
  }

  if (state.status !== 'ready') {
    return res.status(400).json({ error: `Turn not ready (status: ${state.status})` });
  }

  res.json({ turnId, status: 'approved' });
});

router.get('/status/:turnId', (req, res) => {
  const state = activeRuns.get(req.params.turnId);
  if (!state) return res.status(404).json({ error: 'not found' });
  res.json(state);
});

router.get('/result/:turnId', (req, res) => {
  const state = activeRuns.get(req.params.turnId);
  if (!state) return res.status(404).json({ error: 'not found' });
  res.json({
    turnId: req.params.turnId,
    status: state.status,
    batchCount: state.batchCount,
    cellCount: state.cellCount,
    codeLength: state.codeLength,
    warnings: state.warnings,
    tokenUsage: state.tokenUsage,
    timings: state.timings,
    error: state.error,
  });
});

module.exports = { router, generateAndExecute };
