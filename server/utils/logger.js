const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', '..', 'server.log');
const FLUSH_INTERVAL_MS = 500;

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] !== undefined
  ? LOG_LEVELS[process.env.LOG_LEVEL]
  : LOG_LEVELS.info;

let buffer = [];
let flushTimer = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_INTERVAL_MS);
}

function flush() {
  if (buffer.length === 0) return;
  const lines = buffer.join('');
  buffer = [];
  fs.appendFile(LOG_FILE, lines, { encoding: 'utf8' }, (err) => {
    if (err) {
      // Silently ignore write errors
    }
  });
}

function timestamp() {
  return new Date().toISOString();
}

function appendToFile(level, message) {
  const line = `[${timestamp()}] [${level.toUpperCase()}] ${message}\n`;
  buffer.push(line);
  scheduleFlush();
}

function log(level, ...args) {
  if (LOG_LEVELS[level] === undefined || LOG_LEVELS[level] > CURRENT_LOG_LEVEL) {
    // Suppress levels below current threshold
    return;
  }
  const message = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  appendToFile(level, message);

  if (level === 'error') {
    console.error(`[${timestamp()}] [ERROR]`, ...args);
  } else if (level === 'warn') {
    console.warn(`[${timestamp()}] [WARN]`, ...args);
  } else if (level === 'debug') {
    console.debug(`[${timestamp()}] [DEBUG]`, ...args);
  } else {
    console.log(`[${timestamp()}] [INFO]`, ...args);
  }
}

// Flush on process exit
process.on('exit', flush);
process.on('SIGINT', () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });

module.exports = {
  info: (...args) => log('info', ...args),
  warn: (...args) => log('warn', ...args),
  error: (...args) => log('error', ...args),
  debug: (...args) => log('debug', ...args)
};
