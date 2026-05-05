const { spawn } = require('child_process');
const path = require('path');
const logger = require('../utils/logger');

/* ---------- Python Execution Environment ---------- */

const PYTHON_TIMEOUT_MS = Number(process.env.PYTHON_TIMEOUT_MS) || 30000;

async function executePython(code, options = {}) {
  const timeoutMs = options.timeoutMs || PYTHON_TIMEOUT_MS;
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Python execution timeout after ${timeoutMs}ms`)), timeoutMs)
  );

  logger.info(`[Python] Executing code (${code.length} chars)`);
  const start = Date.now();

  try {
    const result = await Promise.race([runPythonProcess(code), timeout]);
    const elapsed = Date.now() - start;
    logger.info(`[Python] Completed in ${elapsed}ms`);
    return result;
  } catch (error) {
    logger.error(`[Python] Error: ${error.message}`);
    throw error;
  }
}

function runPythonProcess(code) {
  return new Promise((resolve, reject) => {
    const python = spawn('python3', ['-c', code], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    python.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python exited with code ${code}: ${stderr || stdout}`));
      } else {
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim() || null,
          exitCode: code
        });
      }
    });

    python.on('error', (err) => {
      reject(new Error(`Failed to start Python: ${err.message}`));
    });
  });
}

module.exports = { executePython };
