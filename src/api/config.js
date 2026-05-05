'use strict';

import { API_BASE } from '../ui/tabs.js';

async function loadModelConfig() {
  try {
    const res = await fetch(`${API_BASE}/api/config/models`);
    const data = await res.json();
    return data;
  } catch (err) {
    console.warn('Failed to load model config:', err);
    return null;
  }
}

function inferProviderFromModel(model) {
  if (!model) return 'openrouter';
  // Direct provider models have NO slash (e.g. "deepseek-v4-pro", "deepseek-chat", "mimo-v2.5-pro")
  // OpenRouter models include slash (e.g. "deepseek/deepseek-v4-flash", "openai/gpt-4o-mini")
  if (model.startsWith('deepseek-')) return 'deepseek';
  if (model.startsWith('mimo-') || model.startsWith('xiaomi-')) return 'xiaomi';
  if (model.startsWith('xiaomi/')) return 'xiaomi'; // legacy: xiaomi/mimo-... is xiaomi direct
  if (model.startsWith('gpt-') || model.startsWith('o1-')) return 'openai';
  return 'openrouter';
}

async function changeModel(model) {
  const provider = inferProviderFromModel(model);
  const res = await fetch(`${API_BASE}/api/config/llm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model })
  });
  return res.ok;
}

async function warmupLLM() {
  try {
    const res = await fetch(`${API_BASE}/api/llm/warmup`, { method: 'POST' });
    return res.ok;
  } catch (err) {
    console.warn('Warmup failed:', err);
    return false;
  }
}

export { loadModelConfig, changeModel, warmupLLM, API_BASE };
