'use strict';

import { API_BASE } from '../ui/tabs.js';

async function startTurn(message, context, modelOverride, parentTurnId = null) {
  const res = await fetch(`${API_BASE}/api/turn/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, context, modelOverride, parentTurnId })
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, 'Errore avvio turn'));
  }
  return res.json();
}

async function approveTurnExecution(turnId) {
  const res = await fetch(`${API_BASE}/api/turn/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnId })
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, 'Errore approvazione'));
  }
}

async function postTurnResponse(turnId, requestId, response) {
  const res = await fetch(`${API_BASE}/api/turn/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnId, requestId, response })
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Errore nella risposta al runtime');
  }
}

async function postTurnResponseBatch(turnId, responses) {
  const res = await fetch(`${API_BASE}/api/turn/respond-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnId, responses })
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Errore nella risposta batch');
  }
}

async function getTurn(turnId) {
  const res = await fetch(`${API_BASE}/api/turn/${encodeURIComponent(turnId)}`);
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, 'Errore lettura turn'));
  }
  return res.json();
}

async function getErrorMessageFromResponse(response, fallbackMessage) {
  const fallback = fallbackMessage || `Errore HTTP ${response.status}`;
  if (!response) return fallback;
  let payload = null;
  try { payload = await response.clone().json(); } catch (jsonError) {
    try {
      const text = await response.text();
      if (text) {
        if (text.includes('Cannot POST /api/turn/start')) {
          return 'Il taskpane sta parlando con un server statico o non aggiornato. Riavvia il backend corretto con ./start-dev.sh.';
        }
        return `${fallback}: ${text}`;
      }
    } catch (textError) {}
    return fallback;
  }
  const errorMessage = payload?.error || payload?.message || payload?.details;
  if (errorMessage) return errorMessage;
  if (response.status === 404) return 'Endpoint non trovato. Probabilmente il server non e\' aggiornato.';
  if (response.status === 413) return 'Il contesto Excel inviato e\' troppo grande.';
  return fallback;
}

export { startTurn, approveTurnExecution, postTurnResponse, postTurnResponseBatch, getTurn, getErrorMessageFromResponse, API_BASE };
