'use strict';

import { escapeHtml } from '../utils/html.js';

function showCodePanel(code, result) {
  const panel = document.getElementById('code-panel');
  const content = document.getElementById('code-content');
  if (!panel || !content) return;
  panel.classList.add('visible');
  const block = document.createElement('div');
  block.innerHTML = `<pre>${escapeHtml(code)}</pre><div style="color:#6a9955;margin-top:4px;">${escapeHtml(JSON.stringify(result, null, 2))}</div>`;
  content.appendChild(block);
}

function hideCodePanel() {
  const panel = document.getElementById('code-panel');
  if (panel) panel.classList.remove('visible');
}

function clearCodePanel() {
  const content = document.getElementById('code-content');
  if (content) content.innerHTML = '';
}

export { showCodePanel, hideCodePanel, clearCodePanel };
