import { API_BASE } from '../ui/tabs.js';
import { getAccessToken } from '../auth/auth.js';

function authHeaders(headers = {}) {
  const token = getAccessToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function startTurn(message, context, modelOverride, parentTurnId = null, speedMode = null, executionEngine = null) {
  const res = await fetch(`${API_BASE}/api/turn/start`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, context, modelOverride, parentTurnId, speedMode, executionEngine })
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, 'Errore avvio turn'));
  }
  return res.json();
}

async function approveTurnExecution(turnId) {
  const res = await fetch(`${API_BASE}/api/turn/approve`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ turnId })
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, 'Errore approvazione'));
  }
}

async function postTurnStep(turnId, clientResult, stepSeq) {
  const res = await fetch(`${API_BASE}/api/turn/step`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ turnId, clientResult, stepSeq })
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, 'Errore step turn'));
  }
  return res.json();
}

async function steerTurn(turnId, text) {
  const res = await fetch(`${API_BASE}/api/turn/steer`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ turnId, text })
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Errore steering turn');
  }
  return res.json();
}

async function postTurnResponse(turnId, requestId, response) {
  const res = await fetch(`${API_BASE}/api/turn/respond`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
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
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ turnId, responses })
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Errore nella risposta batch');
  }
}

async function postTurnActionResult(turnId, result, retries = 3) {
  let lastError;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(`${API_BASE}/api/turn/action-result`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ turnId, ...(result || {}) })
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      return res.json();
    } catch (err) {
      lastError = err;
      if (i < retries) {
        const delay = 1000 * Math.pow(2, i);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw new Error(`Errore nel salvataggio esito azioni Excel dopo ${retries + 1} tentativi: ${lastError.message}`);
}

async function postHealthReport(turnId, errors) {
  const res = await fetch(`${API_BASE}/api/turn/health-report`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ turnId, errors })
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, 'Errore health report'));
  }
  return res.json();
}

async function getTurn(turnId) {
  const res = await fetch(`${API_BASE}/api/turn/${encodeURIComponent(turnId)}`, {
    headers: authHeaders()
  });
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
          return 'Il taskpane sta parlando con un server statico o non aggiornato. Riavvia il backend corretto.';
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

async function startCodeFirst(message, context, modelOverride) {
  const res = await fetch(`${API_BASE}/api/codefirst/start`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, context, modelOverride })
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, 'Errore avvio CodeFirst'));
  }
  return res;
}

export { startTurn, startCodeFirst, approveTurnExecution, postTurnStep, postTurnResponse, postTurnResponseBatch, postTurnActionResult, postHealthReport, getTurn, steerTurn, getErrorMessageFromResponse, API_BASE };
