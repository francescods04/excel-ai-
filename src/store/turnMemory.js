'use strict';

const TURN_MEMORY_KEY = 'excelAi.turnMemory.v1';
const TURN_MEMORY_TTL_MS = 12 * 60 * 60 * 1000;

function getStorage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch (err) {
    return null;
  }
}

function normalizeMemory(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const updatedAt = Number(raw.updatedAt) || 0;
  if (!updatedAt || now - updatedAt > TURN_MEMORY_TTL_MS) return null;
  return {
    lastTurnId: typeof raw.lastTurnId === 'string' ? raw.lastTurnId : null,
    lastCompletedTurnId: typeof raw.lastCompletedTurnId === 'string' ? raw.lastCompletedTurnId : null,
    updatedAt
  };
}

function readTurnMemory(now = Date.now()) {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(TURN_MEMORY_KEY) || 'null');
    const memory = normalizeMemory(parsed, now);
    if (!memory) storage.removeItem(TURN_MEMORY_KEY);
    return memory;
  } catch (err) {
    try { storage.removeItem(TURN_MEMORY_KEY); } catch (removeErr) {}
    return null;
  }
}

function writeTurnMemory(patch = {}) {
  const storage = getStorage();
  if (!storage) return null;
  const next = {
    ...(readTurnMemory() || {}),
    ...patch,
    updatedAt: Date.now()
  };
  if (!next.lastTurnId && !next.lastCompletedTurnId) {
    try { storage.removeItem(TURN_MEMORY_KEY); } catch (removeErr) {}
    return null;
  }
  try {
    storage.setItem(TURN_MEMORY_KEY, JSON.stringify(next));
    return next;
  } catch (err) {
    return null;
  }
}

function restoreTurnMemory(state) {
  const memory = readTurnMemory();
  if (!memory || !state) return null;
  state.lastTurnId = memory.lastTurnId || state.lastTurnId || null;
  state.lastCompletedTurnId = memory.lastCompletedTurnId || state.lastCompletedTurnId || null;
  return memory;
}

function persistTurnStarted(turnId) {
  if (!turnId) return null;
  return writeTurnMemory({ lastTurnId: turnId });
}

function persistTurnCompleted(turnId, ok = true) {
  if (!turnId) return null;
  return writeTurnMemory({
    lastTurnId: turnId,
    ...(ok ? { lastCompletedTurnId: turnId } : {})
  });
}

function forgetActiveTurn() {
  return writeTurnMemory({ lastTurnId: null });
}

export {
  TURN_MEMORY_KEY,
  TURN_MEMORY_TTL_MS,
  readTurnMemory,
  restoreTurnMemory,
  persistTurnStarted,
  persistTurnCompleted,
  forgetActiveTurn
};
