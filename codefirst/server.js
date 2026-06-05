'use strict';

const express = require('express');
const { enhancedPipeline } = require('./enhanced');
const { autoresearchPipeline } = require('./autoresearch');
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
  const { turnId, modelOverride, timeoutMs = 240000, enableCritic = false, onProgress = null } = options;

  const result = await enhancedPipeline(objective, context, {
    modelOverride,
    skipCritic: !enableCritic,
    onProgress,
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
    mode: result.mode || (result.pipeline?.codegenMode) || 'create',
    explanation: result.explanation || null,
    validation: result.pipeline?.validation || null,
    sanitizer: result.pipeline?.sanitizer || result.sanitizerStats || null,
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

async function generateAndExecuteAutoresearch(objective, context = {}, options = {}) {
  const { turnId, modelOverride, data = null } = options;

  const result = await autoresearchPipeline(objective, context, {
    modelOverride,
    data,
    onProgress: options.onProgress || null,
    maxIterations: options.maxIterations || 3,
    skipResearch: options.skipResearch || false,
  });

  if (result.status !== 'ok') {
    throw new Error(result.error || 'Autoresearch pipeline failed');
  }

  const chunkedBatches = chunkActions(result.actions, 200);

  return {
    code: null,
    codeLength: 0,
    warnings: [],
    actions: result.actions,
    batches: chunkedBatches,
    cellCount: result.cellCount,
    plan: result.plan,
    review: {
      approved: result.converged,
      score: result.lastScore,
      issues: result.timeline?.filter(t => t.phase === 'reviewing') || [],
    },
    mode: 'autoresearch',
    explanation: `Autoresearch completed in ${result.iterations} iterations. Last score: ${result.lastScore}. Converged: ${result.converged}.`,
    validation: null,
    sanitizer: null,
    tokenUsage: { promptTokens: 0, completionTokens: 0, calls: 0 },
    timings: {
      planMs: 0,
      codegenMs: 0,
      criticMs: 0,
      executionMs: 0,
      totalMs: result.totalMs,
    },
    skillNames: result.researchContext ? [result.researchContext.domain] : [],
    autoresearchMeta: {
      iterations: result.iterations,
      converged: result.converged,
      lastScore: result.lastScore,
      timeline: result.timeline,
      researchContext: result.researchContext,
    },
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

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (eventType, data) => {
    try {
      res.write(`event: ${eventType}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_) {}
  };

  sendEvent('turnStarted', { turnId, status: 'processing' });

  const heartbeatInterval = setInterval(() => {
    sendEvent('heartbeat', { turnId, status: 'processing' });
  }, 3000);

  // Progressive streaming state: slice actions are sent as each slice completes,
  // so the user sees Excel populated section-by-section rather than waiting for all.
  const { sanitizeActions } = require('./actionSanitizer');
  let sliceBatchIdx = 0;
  const sheetsSent = new Set();
  let progressiveMode = false;

  function streamSliceActions(sliceActions) {
    if (!Array.isArray(sliceActions) || sliceActions.length === 0) return;
    // Prepend createSheet for new sheets encountered in this slice
    const newSheets = [];
    for (const a of sliceActions) {
      if (a.sheet && !sheetsSent.has(a.sheet) && a.type !== 'createSheet') {
        sheetsSent.add(a.sheet);
        newSheets.push({ type: 'createSheet', sheet: a.sheet });
      }
    }
    const sanitized = sanitizeActions([
      ...newSheets,
      ...sliceActions.filter(a => a.type !== 'createSheet'),
    ]);
    if (sanitized.actions.length === 0) return;
    sendEvent('taskActions', {
      turnId,
      taskId: 'codefirst',
      itemId: `slice_${sliceBatchIdx++}`,
      actions: sanitized.actions,
    });
    progressiveMode = true;
  }

  try {
    logger.info(`[CodeFirst] Starting turn ${turnId}: "${message.slice(0, 100)}..."`);
    const pipelinePromise = generateAndExecute(message, context, {
      turnId,
      modelOverride,
      timeoutMs: 180000,
      onProgress: (phase, info) => {
        try {
          if (phase === 'slice_complete') {
            streamSliceActions(info.sliceActions);
            sendEvent('progress', { turnId, phase: 'generating', message: info.message });
          } else {
            sendEvent('progress', { turnId, phase, ...info });
          }
        } catch (_) {}
      },
    });
    const hardTimeoutMs = 270000;
    const timeoutErr = Object.assign(new Error(`Pipeline timeout after ${hardTimeoutMs / 1000}s — some sections may be missing`), { isTimeout: true });
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(timeoutErr), hardTimeoutMs));
    const result = await Promise.race([pipelinePromise, timeoutPromise]);

    clearInterval(heartbeatInterval);

    if (result.error) {
      sendEvent('codefirstError', { turnId, error: result.error });
      res.end();
      return;
    }

    if (progressiveMode) {
      // Slices already streamed section-by-section. Send a final codefirstComplete.
      sendEvent('codefirstComplete', { turnId, totalBatches: sliceBatchIdx, cellCount: result.cellCount });
      res.end();
      return;
    }

    // Non-stepwise pipeline (edit mode / small single-shot): send everything at once
    sendEvent('codefirstReady', {
      turnId,
      batchCount: result.batches.length,
      cellCount: result.cellCount,
      warnings: result.warnings,
      tokenUsage: result.tokenUsage,
    });

    const BATCH_INTERVAL_MS = 80;
    const MAX_BATCHES_PER_TICK = 3;
    for (let batchIdx = 0; batchIdx < result.batches.length; ) {
      const batchesThisTick = Math.min(MAX_BATCHES_PER_TICK, result.batches.length - batchIdx);
      for (let i = 0; i < batchesThisTick; i++) {
        const batch = result.batches[batchIdx];
        sendEvent('taskActions', {
          turnId,
          taskId: 'codefirst',
          itemId: `batch_${batchIdx}`,
          actions: batch,
        });
        batchIdx++;
      }
      if (batchIdx < result.batches.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_INTERVAL_MS));
      }
    }

    sendEvent('codefirstComplete', { turnId, totalBatches: result.batches.length });
    res.end();
  } catch (error) {
    clearInterval(heartbeatInterval);
    if (error.isTimeout && progressiveMode) {
      // Partial result already streamed — signal completion rather than error
      logger.warn(`[CodeFirst] Timeout for ${turnId} — partial result streamed (${sliceBatchIdx} batches)`);
      sendEvent('codefirstComplete', { turnId, totalBatches: sliceBatchIdx, partial: true });
    } else {
      logger.error(`[CodeFirst] Error for ${turnId}: ${error.message}`);
      sendEvent('codefirstError', { turnId, error: error.message });
    }
    res.end();
  }
});

router.post('/autoresearch/start', async (req, res) => {
  const { message, context = {}, modelOverride, data = null } = req.body;
  const turnId = `cf_ar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  logger.info(`[CodeFirst/AR] Starting autoresearch turn ${turnId}: "${message.slice(0, 100)}..."`);

  try {
    const result = await generateAndExecuteAutoresearch(message, context, {
      turnId,
      modelOverride,
      data,
      timeoutMs: 300000,
    });

    const IS_VERCEL = !!process.env.VERCEL;

    if (IS_VERCEL) {
      res.json({
        turnId,
        status: 'ready',
        actions: result.actions,
        batches: result.batches,
        cellCount: result.cellCount,
        plan: result.plan ? { sections: result.plan.sections?.length, model_type: result.plan.model_type, estimated_cells: result.plan.estimated_cells } : null,
        review: result.review ? { approved: result.review.approved, score: result.review.score, issues: result.review.issues?.length } : null,
        mode: result.mode,
        explanation: result.explanation,
        timings: result.timings,
        skillNames: result.skillNames,
        autoresearchMeta: result.autoresearchMeta,
      });
    } else {
      activeRuns.set(turnId, {
        batches: result.batches,
        cellCount: result.cellCount,
        plan: result.plan,
        review: result.review,
        mode: result.mode,
        explanation: result.explanation,
        timings: result.timings,
        skillNames: result.skillNames,
        autoresearchMeta: result.autoresearchMeta,
        status: 'ready',
        batchCount: result.batches.length,
      });

      res.json({
        turnId,
        status: 'ready',
        batchCount: result.batches.length,
        cellCount: result.cellCount,
        actions: result.actions,
        plan: result.plan ? { sections: result.plan.sections?.length, model_type: result.plan.model_type, estimated_cells: result.plan.estimated_cells } : null,
        review: result.review ? { approved: result.review.approved, score: result.review.score, issues: result.review.issues?.length } : null,
        mode: result.mode,
        explanation: result.explanation,
        timings: result.timings,
        skillNames: result.skillNames,
        autoresearchMeta: result.autoresearchMeta,
      });
    }
  } catch (error) {
    logger.error(`[CodeFirst/AR] Error for ${turnId}: ${error.message}`);
    res.status(500).json({ error: error.message, turnId });
  }
});

router.get('/stream/:turnId', (req, res) => {
  const { turnId } = req.params;
  let state = activeRuns.get(turnId);

  if (!state) {
    return res.status(404).json({ error: 'Turn not found' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const sendEvent = (eventType, data) => {
    try {
      res.write(`data: ${JSON.stringify({ ...data, eventType })}

`);
    } catch (_) {}
  };

  sendEvent('turnStarted', { turnId, status: state.status });

  if (state.status === 'ready') {
    sendEvent('codefirstReady', { turnId, batchCount: state.batchCount, cellCount: state.cellCount, warnings: state.warnings, tokenUsage: state.tokenUsage });

    const streaming = require('../server/agents/streaming');
    streamActionsWithThrottle(turnId, state.batches, {
      sendEvent: (id, eventType, data) => {
        try {
          sendEvent(eventType, { ...data, turnId });
        } catch (_) {}
      }
    });
  } else if (state.status === 'error') {
    sendEvent('codefirstError', { turnId, error: state.error });
    res.end();
  } else if (state.status === 'processing') {
    // Heartbeat while processing — keeps connection alive on Vercel
    const heartbeatInterval = setInterval(() => {
      state = activeRuns.get(turnId);
      if (!state) {
        clearInterval(heartbeatInterval);
        sendEvent('codefirstError', { turnId, error: 'Turn state lost' });
        res.end();
        return;
      }

      if (state.status === 'processing') {
        sendEvent('heartbeat', { turnId, status: 'processing' });
      } else if (state.status === 'ready') {
        clearInterval(heartbeatInterval);
        sendEvent('codefirstReady', { turnId, batchCount: state.batchCount, cellCount: state.cellCount, warnings: state.warnings, tokenUsage: state.tokenUsage });
        const streaming = require('../server/agents/streaming');
        streamActionsWithThrottle(turnId, state.batches, {
          sendEvent: (id, eventType, data) => {
            try {
              sendEvent(eventType, { ...data, turnId });
            } catch (_) {}
          }
        });
      } else if (state.status === 'error') {
        clearInterval(heartbeatInterval);
        sendEvent('codefirstError', { turnId, error: state.error });
        res.end();
      }
    }, 3000);

    req.on('close', () => {
      clearInterval(heartbeatInterval);
      const finalState = activeRuns.get(turnId);
      if (finalState && finalState.status === 'ready') {
        setTimeout(() => activeRuns.delete(turnId), 300000);
      }
    });
  }

  req.on('close', () => {
    const finalState = activeRuns.get(turnId);
    if (finalState && finalState.status === 'ready') {
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

module.exports = { router, generateAndExecute, generateAndExecuteAutoresearch };
