'use strict';

import { API_BASE } from '../ui/tabs.js';

async function startAgent(message, context, modelOverride, promptVariant) {
  const res = await fetch(`${API_BASE}/api/agent/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, context, modelOverride, promptVariant })
  });
  if (!res.ok) {
    throw new Error(await getErrorText(res, 'Errore avvio agent'));
  }
  return res.json();
}

async function resumeAgentWithResponse(agentId, userResponse) {
  const res = await fetch(`${API_BASE}/api/agent/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, userResponse })
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Errore risposta agent');
  }
  return res.json();
}

async function getErrorText(response, fallback) {
  try {
    const payload = await response.clone().json();
    return payload?.error || payload?.message || fallback;
  } catch (e) {
    return fallback;
  }
}

async function postAgentClientResponse(agentId, requestId, response) {
  const res = await fetch(`${API_BASE}/api/agent/${agentId}/client-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, response })
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `Errore invio risposta client (${res.status})`);
  }
  return res.json();
}

export { startAgent, resumeAgentWithResponse, postAgentClientResponse, API_BASE };
