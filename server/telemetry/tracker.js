const { getSupabase } = require('../supabase/client');

const pending = [];
const FLUSH_INTERVAL_MS = 5000;

function track(event) {
  pending.push(event);
}

async function flush() {
  if (pending.length === 0) return;
  const batch = pending.splice(0);
  try {
    const supabase = getSupabase();
    const rows = batch.map(e => ({
      user_id: e.userId || null,
      session_id: e.sessionId || null,
      event_type: e.eventType,
      properties: e.properties || null,
      latency_ms: e.latencyMs || null,
      tokens_in: e.tokensIn || null,
      tokens_out: e.tokensOut || null,
      model: e.model || null,
      success: e.success != null ? e.success : null,
    }));
    await supabase.from('events').insert(rows);
  } catch (_) {}
}

setInterval(flush, FLUSH_INTERVAL_MS);

process.on('exit', () => flush());
process.on('SIGINT', () => { flush(); process.exit(); });
process.on('SIGTERM', () => { flush(); process.exit(); });

module.exports = { track };
