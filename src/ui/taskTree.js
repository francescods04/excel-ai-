'use strict';

import { escapeHtml, escapeAttr } from '../utils/html.js';

const taskTreeEl = document.getElementById('task-tree');
const approveBar = document.getElementById('approve-bar');
const progressFill = document.getElementById('progress-fill');
const progressStats = document.getElementById('progress-stats');
const progressEta = document.getElementById('progress-eta');
const progressLevel = document.getElementById('progress-level');
const taskTreeCache = new Map();
let turnStartTime = null;
let elapsedTimer = null;

function getTaskTreeCache() { return taskTreeCache; }

function resetTaskTree() {
  taskTreeEl.innerHTML = '';
  taskTreeCache.clear();
  updateProgress(0, 0, null, null);
  approveBar.classList.add('hidden');
  stopElapsedTimer();
}

function renderTaskTree(tasks) {
  const html = tasks.map(t => {
    const badgeClass = {
      data: 'badge-data',
      layout: 'badge-layout',
      formula: 'badge-formula',
      format: 'badge-format'
    }[t.agent] || 'badge-formula';
    return `
      <div class="task-item" id="task-${t.id}" data-task-id="${t.id}">
        <span class="task-status-icon" id="icon-${t.id}">⏳</span>
        <span class="task-badge ${badgeClass}">${escapeHtml(t.agent)}</span>
        <span class="task-desc">${escapeHtml(t.description || t.tool)}</span>
        <span class="task-tool">${escapeHtml(t.tool)}</span>
      </div>
    `;
  }).join('');
  taskTreeEl.innerHTML = html;

  taskTreeCache.clear();
  tasks.forEach(t => {
    taskTreeCache.set(t.id, {
      el: document.getElementById('task-' + t.id),
      icon: document.getElementById('icon-' + t.id)
    });
  });

  updateProgress(0, tasks.length, null, 0);
}

function updateTaskStatus(taskId, status) {
  const cached = taskTreeCache.get(taskId);
  if (!cached) return;
  const { el, icon } = cached;
  if (!el || !icon) return;
  el.classList.remove('running', 'completed', 'error');
  el.classList.add(status);
  if (status === 'running') icon.textContent = '🔄';
  else if (status === 'completed') icon.textContent = '✅';
  else if (status === 'error') icon.textContent = '❌';
  else icon.textContent = '⏳';

  recalcProgress();
}

function recalcProgress() {
  let total = taskTreeCache.size;
  let completed = 0;
  let running = 0;
  let errors = 0;

  taskTreeCache.forEach(({ el }) => {
    if (!el) return;
    if (el.classList.contains('completed')) completed++;
    else if (el.classList.contains('error')) errors++;
    else if (el.classList.contains('running')) running++;
  });

  updateProgress(completed + errors, total, running > 0, null);
  if (errors > 0) progressFill.classList.add('error');
  else progressFill.classList.remove('error');
}

function updateProgress(done, total, isRunning, level) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressFill.style.width = pct + '%';
  progressStats.textContent = `${done} / ${total}`;
  if (done === total && total > 0) {
    progressFill.classList.add('complete');
    progressEta.textContent = 'Completato';
  } else if (isRunning) {
    progressFill.classList.remove('complete');
  }
  if (level !== null && level !== undefined) {
    progressLevel.textContent = `Livello: ${level}`;
  }
}

function showApproveBar() {
  approveBar.classList.remove('hidden');
}

function hideApproveBar() {
  approveBar.classList.add('hidden');
}

function startElapsedTimer() {
  turnStartTime = Date.now();
  updateElapsed();
  elapsedTimer = setInterval(updateElapsed, 1000);
}

function stopElapsedTimer() {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  turnStartTime = null;
  const el = document.getElementById('elapsed-time');
  if (el) el.textContent = '';
}

function updateElapsed() {
  if (!turnStartTime) return;
  const el = document.getElementById('elapsed-time');
  if (!el) return;
  const secs = Math.floor((Date.now() - turnStartTime) / 1000);
  const mins = Math.floor(secs / 60);
  const remain = secs % 60;
  el.textContent = `${mins}:${String(remain).padStart(2, '0')}`;
}

export {
  renderTaskTree, updateTaskStatus, resetTaskTree, showApproveBar, hideApproveBar,
  startElapsedTimer, stopElapsedTimer, getTaskTreeCache, updateProgress
};
