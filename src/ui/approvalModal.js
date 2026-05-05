'use strict';

import { escapeHtml } from '../utils/html.js';

const approvalOverlay = document.getElementById('approval-overlay');
const approvalTitle = document.getElementById('approval-title');
const approvalSummary = document.getElementById('approval-summary');
const approvalPreview = document.getElementById('approval-preview');
const btnApprove = document.getElementById('btn-approval-approve');
const btnCancel = document.getElementById('btn-approval-cancel');

let onApprove = null;
let onCancel = null;

function initApprovalModal() {
  btnApprove.addEventListener('click', () => {
    hideApprovalModal();
    if (onApprove) onApprove();
  });
  btnCancel.addEventListener('click', () => {
    hideApprovalModal();
    if (onCancel) onCancel();
  });
  approvalOverlay.addEventListener('click', (e) => {
    if (e.target === approvalOverlay) {
      hideApprovalModal();
      if (onCancel) onCancel();
    }
  });
}

function showApprovalModal({ title, summary, preview, approveLabel, cancelLabel, onConfirm, onReject }) {
  approvalTitle.textContent = title || 'Conferma modifiche';
  approvalSummary.textContent = summary || '';
  approvalPreview.innerHTML = '';

  if (preview && preview.length > 0) {
    preview.forEach(item => {
      const el = document.createElement('div');
      el.className = 'request-preview-item';
      el.style.marginBottom = '8px';
      el.innerHTML = `
        <strong>${escapeHtml(item.label || item.kind || 'Modifica')}</strong>
        ${item.sheet || item.target ? `<div class="request-preview-meta">${escapeHtml([item.sheet, item.target].filter(Boolean).join(' • '))}</div>` : ''}
        ${item.diff ? `<div class="request-preview-diff">${escapeHtml(item.diff)}</div>` : ''}
      `;
      approvalPreview.appendChild(el);
    });
  }

  btnApprove.textContent = approveLabel || 'Approva';
  btnCancel.textContent = cancelLabel || 'Blocca';
  onApprove = onConfirm;
  onCancel = onReject;
  approvalOverlay.classList.add('visible');
}

function hideApprovalModal() {
  approvalOverlay.classList.remove('visible');
  onApprove = null;
  onCancel = null;
}

export { initApprovalModal, showApprovalModal, hideApprovalModal };
