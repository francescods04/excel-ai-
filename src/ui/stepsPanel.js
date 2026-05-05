'use strict';

import { escapeHtml } from '../utils/html.js';

function updateStepsPanel(todos) {
  if (!todos || todos.length === 0) return;
  const panel = document.getElementById('steps-panel');
  const list = document.getElementById('steps-list');
  if (!panel || !list) return;
  panel.classList.remove('hidden');
  panel.classList.add('visible');

  list.innerHTML = todos.map(todo => {
    const statusIcon = {
      pending: '○',
      in_progress: '◐',
      completed: '✓',
      cancelled: '✕'
    }[todo.status] || '○';

    return `
      <div class="step-item ${todo.status}">
        <span class="step-icon">${statusIcon}</span>
        <span class="step-content">${escapeHtml(todo.content)}</span>
        <span class="step-priority priority-${todo.priority || 'medium'}">${todo.priority || 'medium'}</span>
      </div>
    `;
  }).join('');
}

function hideStepsPanel() {
  const panel = document.getElementById('steps-panel');
  if (panel) {
    panel.classList.remove('visible');
    panel.classList.add('hidden');
  }
}

export { updateStepsPanel, hideStepsPanel };
