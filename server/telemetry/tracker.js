const { getDb } = require('../db/init');

const pending = [];
const FLUSH_INTERVAL_MS = 5000;

function track(event) {
  pending.push(event);
}

function flush() {
  if (pending.length === 0) return;
  const batch = pending.splice(0);
  try {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO events (user_id, session_id, event_type, properties, latency_ms, tokens_in, tokens_out, model, success)
      VALUES (@user_id, @session_id, @event_type, @properties, @latency_ms, @tokens_in, @tokens_out, @model, @success)
    `);
    const tx = db.transaction(() => {
      for (const e of batch) {
        insert.run({
          user_id: e.userId || null,
          session_id: e.sessionId || null,
          event_type: e.eventType,
          properties: e.properties ? JSON.stringify(e.properties) : null,
          latency_ms: e.latencyMs || null,
          tokens_in: e.tokensIn || null,
          tokens_out: e.tokensOut || null,
          model: e.model || null,
          success: e.success != null ? (e.success ? 1 : 0) : null,
        });
      }
    });
    tx();
  } catch (err) {
    // silenzioso: non blocca mai la richiesta utente
  }
}

setInterval(flush, FLUSH_INTERVAL_MS);

process.on('exit', flush);
process.on('SIGINT', () => { flush(); process.exit(); });
process.on('SIGTERM', () => { flush(); process.exit(); });

module.exports = { track };
