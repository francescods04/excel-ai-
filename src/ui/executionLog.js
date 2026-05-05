'use strict';

import { escapeHtml } from '../utils/html.js';

const executionLogEl = document.getElementById('execution-log');
const logHeader = document.getElementById('log-header');
const logToggle = document.getElementById('log-toggle');
let isLogOpen = false;

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
  const line = document.createElement('div');
  line.className = 'log-entry';
  if (level === 'error' || level === 'warn') line.classList.add('log-error');
  const time = new Date().toLocaleTimeString();
  line.innerHTML = `<span class="log-time">${time}</span>${escapeHtml(msg)}`;
  executionLogEl.appendChild(line);
  executionLogEl.scrollTop = executionLogEl.scrollHeight;
}

function clearLog() {
  executionLogEl.innerHTML = '';
}

export { initExecutionLog, addLog, clearLog };
