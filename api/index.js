const path = require('path');

// Vercel serverless: filesystem is read-only except /tmp
if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
  process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/excel-data';
  process.env.LLM_TRACE_DIR = process.env.LLM_TRACE_DIR || path.join(process.env.DATA_DIR, 'llm-traces');
}

const app = require('../server/server');

module.exports = app;
