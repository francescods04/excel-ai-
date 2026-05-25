'use strict';

import { escapeHtml } from '../utils/html.js';

const executionLogEl = document.getElementById('execution-log');
const logHeader = document.getElementById('log-header');
const logToggle = document.getElementById('log-toggle');
let isLogOpen = false;
const MAX_LOG_DOM_ENTRIES = 350;
const MAX_LOG_MESSAGE_CHARS = 2000;
const MAX_FLUSH_PER_FRAME = 80;
const pendingLogs = [];
let flushScheduled = false;

function initExecutionLog() {
  logHeader.addEventListener('click', toggleLog);
}

function toggleLog() {
  isLogOpen = !isLogOpen;
  if (isLogOpen) {
    executionLogEl.classList.add('visible');
    logToggle.classList.add('open');
  } else {
    executionLogEl.classList.remove('visible');
    logToggle.classList.remove('open');
  }
}

function addLog(msg, level) {
  const text = String(msg || '');
  pendingLogs.push({
    msg: text.length > MAX_LOG_MESSAGE_CHARS ? `${text.slice(0, MAX_LOG_MESSAGE_CHARS - 1)}...` : text,
    level,
    time: new Date().toLocaleTimeString()
  });
  scheduleLogFlush();
}

function scheduleLogFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  const schedule = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
  schedule(flushLogs);
}

function flushLogs() {
  flushScheduled = false;
  if (!executionLogEl || pendingLogs.length === 0) return;

  const fragment = document.createDocumentFragment();
  const batch = pendingLogs.splice(0, MAX_FLUSH_PER_FRAME);
  for (const entry of batch) {
    const line = document.createElement('div');
    line.className = 'log-entry';
    if (entry.level === 'error' || entry.level === 'warn') line.classList.add('log-error');
    line.innerHTML = `<span class="log-time">${entry.time}</span>${escapeHtml(entry.msg)}`;
    fragment.appendChild(line);
  }

  executionLogEl.appendChild(fragment);
  while (executionLogEl.children.length > MAX_LOG_DOM_ENTRIES) {
    executionLogEl.removeChild(executionLogEl.firstElementChild);
  }
  executionLogEl.scrollTop = executionLogEl.scrollHeight;

  if (pendingLogs.length > 0) scheduleLogFlush();
}

function clearLog() {
  pendingLogs.splice(0, pendingLogs.length);
  executionLogEl.innerHTML = '';
}

export { initExecutionLog, addLog, clearLog };
