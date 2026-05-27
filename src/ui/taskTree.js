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

function computeWaves(tasks) {
  // Topological levels from deps. Returns Map<taskId, waveIndex>.
  const ids = new Set(tasks.map(t => t.id));
  const depMap = new Map();
  for (const t of tasks) {
    depMap.set(t.id, (t.deps || []).filter(d => ids.has(d)));
  }
  const level = new Map();
  const queue = tasks.filter(t => (depMap.get(t.id) || []).length === 0).map(t => t.id);
  for (const id of queue) level.set(id, 0);
  let safety = tasks.length * tasks.length;
  while (safety-- > 0) {
    let changed = false;
    for (const t of tasks) {
      if (level.has(t.id)) continue;
      const deps = depMap.get(t.id) || [];
      if (deps.every(d => level.has(d))) {
        const d = deps.length === 0 ? 0 : Math.max(...deps.map(x => level.get(x))) + 1;
        level.set(t.id, d);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return level;
}

function renderTaskTree(tasks) {
  taskTreeCache.clear();

  const isOrchestratorPlan = tasks.length > 0 && tasks.every(t => t.tool === 'orchestrator.slice');
  if (isOrchestratorPlan) {
    const levels = computeWaves(tasks);
    const waveGroups = new Map();
    for (const t of tasks) {
      const w = levels.get(t.id) ?? 0;
      if (!waveGroups.has(w)) waveGroups.set(w, []);
      waveGroups.get(w).push(t);
    }
    const sortedWaves = [...waveGroups.keys()].sort((a, b) => a - b);
    const html = sortedWaves.map(w => {
      const items = waveGroups.get(w);
      const parallelBadge = items.length > 1
        ? `<span class="wave-parallel">∥ ${items.length} in parallelo</span>`
        : '';
      const tasksHtml = items.map(t => `
        <div class="task-item slice-item" id="task-${t.id}" data-task-id="${t.id}">
          <span class="task-status-icon" id="icon-${t.id}">⏳</span>
          <span class="task-badge badge-slice">slice</span>
          <span class="task-desc">${escapeHtml(t.description || t.id)}</span>
          ${(t.deps && t.deps.length) ? `<span class="task-deps">← ${escapeHtml(t.deps.join(', '))}</span>` : ''}
        </div>
      `).join('');
      return `
        <div class="wave-group" data-wave="${w}">
          <div class="wave-header">Wave ${w + 1} ${parallelBadge}</div>
          ${tasksHtml}
        </div>
      `;
    }).join('');
    taskTreeEl.innerHTML = html;
  } else {
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
  }

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
