'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

const BROWSERUSE_URL = process.env.BROWSERUSE_URL || 'http://127.0.0.1:5099';
const BROWSERUSE_DEFAULT_TIMEOUT_MS = Number(process.env.BROWSERUSE_TIMEOUT_MS) || 240000;

/**
 * Call the browser-use Python sidecar.
 * The sidecar runs an autonomous agent in a headless Chromium that can navigate
 * multi-step flows: search, login, click, fill forms, scroll, screenshot. Returns
 * the final result string + a compact navigation history.
 */
async function runBrowserAgent(params = {}) {
  const task = String(params.task || '').trim();
  if (!task) throw new Error('runBrowserAgent: task (natural-language goal) required');
  const maxSteps = Math.min(Number(params.maxSteps) || 25, 80);
  const headless = params.headless !== false;
  const model = params.model || null;
  const useVision = params.useVision !== false;
  const returnScreenshots = !!params.returnScreenshots;
  const timeoutMs = Math.min(Number(params.timeoutMs) || BROWSERUSE_DEFAULT_TIMEOUT_MS, 600000);

  // Quick liveness check so we can fail fast and explain.
  try {
    await axios.get(`${BROWSERUSE_URL}/health`, { timeout: 5000 });
  } catch (e) {
    throw new Error(
      `browser-use sidecar not reachable at ${BROWSERUSE_URL}. ` +
      `Start it with: ./python_bridge/start_browseruse.sh (background) ` +
      `or set BROWSERUSE_URL to your running instance. Underlying error: ${e.message}`
    );
  }

  logger.info(`[BrowserAgent] task="${task.slice(0, 120)}..." max_steps=${maxSteps}`);
  const start = Date.now();
  let resp;
  try {
    resp = await axios.post(`${BROWSERUSE_URL}/run`, {
      task,
      max_steps: maxSteps,
      headless,
      model,
      use_vision: useVision,
      return_screenshots: returnScreenshots
    }, { timeout: timeoutMs });
  } catch (e) {
    logger.warn(`[BrowserAgent] HTTP error: ${e.message}`);
    throw new Error(`browser-use call failed: ${e.message}`);
  }
  const elapsed = Date.now() - start;
  const data = resp.data || {};
  logger.info(`[BrowserAgent] completed in ${elapsed}ms ok=${data.ok} steps=${data.steps || 0}`);
  return {
    ok: !!data.ok,
    task,
    result: data.result || null,
    error: data.error || null,
    steps: data.steps || 0,
    historyLength: Array.isArray(data.history) ? data.history.length : 0,
    history: (data.history || []).slice(0, 25),
    screenshots: returnScreenshots ? (data.screenshots || []) : [],
    elapsedMs: elapsed,
    provider: 'browser-use',
    sidecarUrl: BROWSERUSE_URL
  };
}

async function isSidecarUp() {
  try {
    const resp = await axios.get(`${BROWSERUSE_URL}/health`, { timeout: 3000 });
    return resp.data && resp.data.ok === true;
  } catch (_) { return false; }
}

module.exports = { runBrowserAgent, isSidecarUp };
