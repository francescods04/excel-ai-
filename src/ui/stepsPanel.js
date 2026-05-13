'use strict';

import { escapeHtml } from '../utils/html.js';

function updateStepsPanel(todos) {
  const panel = document.getElementById('steps-panel');
  const list = document.getElementById('steps-list');
  if (!panel || !list) return;

  if (!todos || todos.length === 0) {
    panel.classList.add('hidden');
    panel.classList.remove('visible');
    list.innerHTML = '';
    return;
  }

  const allDone = todos.every(t => t.status === 'completed' || t.status === 'cancelled');
  if (allDone) {
    panel.classList.remove('hidden');
    panel.classList.add('visible');
    renderSteps(list, todos);
    setTimeout(() => {
      panel.classList.add('hidden');
      panel.classList.remove('visible');
      list.innerHTML = '';
    }, 1500);
    return;
  }

  panel.classList.remove('hidden');
  panel.classList.add('visible');
  renderSteps(list, todos);
}

function renderSteps(list, todos) {
  list.innerHTML = todos.map(todo => {
    const statusIcon = {
      pending: '○',
      in_progress: '<span class="step-spinner"></span>',
      completed: '✓',
      cancelled: '✕'
    }[todo.status] || '○';
    const label = (todo.status === 'in_progress' && todo.activeForm) ? todo.activeForm : todo.content;

    return `
      <div class="step-item ${todo.status}">
        <span class="step-icon">${statusIcon}</span>
        <span class="step-content">${escapeHtml(label)}</span>
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
