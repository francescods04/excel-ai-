'use strict';

const undoBadge = document.getElementById('undo-badge');
const undoBadgeText = document.getElementById('undo-badge-text');
const undoBadgeBtn = document.getElementById('undo-badge-undo');
const undoBadgeDismiss = document.getElementById('undo-badge-dismiss');
let hideTimer = null;

function initUndoBadge(onUndo) {
  undoBadgeBtn.addEventListener('click', () => {
    hideUndoBadge();
    if (onUndo) onUndo();
  });
  undoBadgeDismiss.addEventListener('click', hideUndoBadge);
}

function showUndoBadge(text) {
  if (hideTimer) clearTimeout(hideTimer);
  undoBadgeText.textContent = text || 'Modifiche applicate';
  undoBadge.classList.add('visible');
  hideTimer = setTimeout(hideUndoBadge, 10000);
}

function hideUndoBadge() {
  undoBadge.classList.remove('visible');
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

export { initUndoBadge, showUndoBadge, hideUndoBadge };
