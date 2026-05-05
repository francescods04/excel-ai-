const pendingRequests = new Map();

const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS) || 5000;
const MAX_PENDING_AGE_MS = Number(process.env.MAX_PENDING_AGE_MS) || 120000;

function buildKey(turnId, requestId) {
  return `${turnId}:${requestId}`;
}

function makeRequestId(prefix = 'req') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function sweepPendingRequests() {
  const now = Date.now();
  for (const [key, entry] of pendingRequests.entries()) {
    const createdAt = entry.request?.createdAt ? new Date(entry.request.createdAt).getTime() : now;
    if (now - createdAt > MAX_PENDING_AGE_MS) {
      pendingRequests.delete(key);
      try { entry.reject(new Error('Richiesta scaduta per inattività')); } catch (e) {}
    }
  }
}

setInterval(sweepPendingRequests, SWEEP_INTERVAL_MS);

function waitForClientResponse(turnId, request) {
  return new Promise((resolve, reject) => {
    pendingRequests.set(buildKey(turnId, request.id), {
      request,
      resolve,
      reject
    });
  });
}

function resolveClientResponse(turnId, requestId, response) {
  const key = buildKey(turnId, requestId);
  const pending = pendingRequests.get(key);
  if (!pending) return false;

  pendingRequests.delete(key);
  pending.resolve(response);
  return true;
}

function rejectClientResponse(turnId, requestId, error) {
  const key = buildKey(turnId, requestId);
  const pending = pendingRequests.get(key);
  if (!pending) return false;

  pendingRequests.delete(key);
  pending.reject(error);
  return true;
}

module.exports = {
  makeRequestId,
  waitForClientResponse,
  resolveClientResponse,
  rejectClientResponse
};
