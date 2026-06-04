'use strict';

const { spawn } = require('child_process');
const path = require('path');
const logger = require('../server/utils/logger');

const PYTHON_TIMEOUT_MS = Number(process.env.CODEFIRST_PYTHON_TIMEOUT_MS) || 60000;
const RUNTIME_DIR = path.join(__dirname, 'runtime');
const IS_VERCEL = !!process.env.VERCEL;

async function executeCodeVercel(code) {
  const baseUrl = process.env.PUBLIC_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://localhost:3000';
  const url = `${baseUrl}/api/codefirst/execute`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(PYTHON_TIMEOUT_MS),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Vercel Python error: ${data.error || res.status}`);
  }
  return {
    actions: data.actions || [],
    cellCount: (data.actions || []).reduce((s, a) =>
      s + (a.type === 'setCellRange' && a.cells ? Object.keys(a.cells).length : 0), 0),
    stderr: null,
    elapsedMs: 0,
  };
}

async function executeCode(code, options = {}) {
  if (IS_VERCEL) return executeCodeVercel(code);
  return executeCodeLocal(code, options);
}

async function executeCodeLocal(code, options = {}) {
  const timeoutMs = options.timeoutMs || PYTHON_TIMEOUT_MS;
  const start = Date.now();

  const addPath = RUNTIME_DIR;
  const pythonCode = `
import sys
sys.path.insert(0, ${JSON.stringify(addPath)})
${code}
`;

  logger.info(`[CodeFirst] Executing Python (${pythonCode.length} chars)`);

  const proc = spawn('python3', ['-c', pythonCode], {
    cwd: process.cwd(),
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const actions = [];
  let stderr = '';
  let stdoutBuffer = '';

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Python timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      let idx;
      while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (!line) continue;
        try {
          const action = JSON.parse(line);
          actions.push(action);
        } catch (e) {
          stderr += `[JSON parse error on stdout] ${line}\n`;
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const elapsed = Date.now() - start;

      if (stdoutBuffer.trim()) {
        try {
          const action = JSON.parse(stdoutBuffer.trim());
          actions.push(action);
        } catch (e) {
          stderr += `[JSON parse error] ${stdoutBuffer.trim()}`;
        }
      }

      if (code === 0) {
        const cellCount = actions.reduce((sum, a) => {
          if (a.type === 'setCellRange' && a.cells) return sum + Object.keys(a.cells).length;
          return sum;
        }, 0);
        logger.info(`[CodeFirst] Done (${elapsed}ms, ${actions.length} batches, ~${cellCount} cells)`);
        resolve({ actions, stderr: stderr.trim() || null, elapsedMs: elapsed, cellCount });
      } else {
        reject(new Error(`Python exit ${code}: ${stderr || 'unknown error'}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start Python: ${err.message}`));
    });
  });
}

async function executeCodeAndStream(code, emitFn, options = {}) {
  const timeoutMs = options.timeoutMs || PYTHON_TIMEOUT_MS;
  const start = Date.now();

  const addPath = RUNTIME_DIR;
  const pythonCode = `
import sys
sys.path.insert(0, ${JSON.stringify(addPath)})
${code}
`;

  logger.info(`[CodeFirst] Executing Python with streaming (${pythonCode.length} chars)`);

  const proc = spawn('python3', ['-c', pythonCode], {
    cwd: process.cwd(),
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const allActions = [];
  let stderr = '';
  let stdoutBuffer = '';
  let totalCells = 0;
  let batchSeq = 0;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Python timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      let idx;
      while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (!line) continue;
        try {
          const action = JSON.parse(line);
          allActions.push(action);
          if (action.type === 'setCellRange' && action.cells) {
            totalCells += Object.keys(action.cells).length;
          }
          if (emitFn) {
            emitFn({
              turnId: options.turnId || 'codefirst',
              taskId: `codegen_${batchSeq}`,
              itemId: `batch_${batchSeq}`,
              actions: [action],
            });
            batchSeq++;
          }
        } catch (e) {
          stderr += `[JSON parse] ${line}\n`;
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const elapsed = Date.now() - start;

      if (stdoutBuffer.trim()) {
        try {
          const action = JSON.parse(stdoutBuffer.trim());
          allActions.push(action);
        } catch (e) {
          stderr += `[JSON parse] ${stdoutBuffer.trim()}`;
        }
      }

      if (code === 0) {
        logger.info(`[CodeFirst] Stream done (${elapsed}ms, ${allActions.length} batches, ${totalCells} cells)`);
        resolve({ actions: allActions, stderr: stderr.trim() || null, elapsedMs: elapsed, cellCount: totalCells });
      } else {
        reject(new Error(`Python exit ${code}: ${stderr || 'unknown error'}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start Python: ${err.message}`));
    });
  });
}

module.exports = { executeCode, executeCodeAndStream };
