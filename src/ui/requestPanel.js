'use strict';

import { escapeHtml, escapeAttr, summarizeMatrix, isRangeWriteAction } from '../utils/html.js';

const requestPanel = document.getElementById('request-panel');
const requestTitleEl = document.getElementById('request-title');
const requestPromptEl = document.getElementById('request-prompt');
const requestSummaryEl = document.getElementById('request-summary');
const requestPreviewListEl = document.getElementById('request-preview-list');
const requestFormEl = document.getElementById('request-form');
const requestActionsEl = document.getElementById('request-actions');

function hideRequestPanel() {
  requestPanel.classList.add('hidden');
  requestTitleEl.textContent = 'Conferma richiesta';
  requestPromptEl.textContent = '';
  requestSummaryEl.textContent = '';
  requestSummaryEl.classList.add('hidden');
  requestPreviewListEl.innerHTML = '';
  requestPreviewListEl.classList.add('hidden');
  requestFormEl.innerHTML = '';
  requestFormEl.classList.add('hidden');
  requestActionsEl.classList.add('hidden');
}

function showPermissionRequest(request) {
  requestTitleEl.textContent = request.title || 'Conferma modifiche';
  requestPromptEl.textContent = request.prompt || 'Verifica e approva le modifiche.';

  const previewItems = (request.preview || []).map(item => `
    <li class="request-preview-item">
      <strong>${escapeHtml(item.label || item.kind || 'Modifica')}</strong>
      ${item.sheet || item.target ? `<div class="request-preview-meta">${escapeHtml([item.sheet, item.target].filter(Boolean).join(' • '))}</div>` : ''}
      ${item.diff ? `<div class="request-preview-diff">${escapeHtml(item.diff)}</div>` : ''}
      ${item.preview && !item.diff ? `<div class="request-preview-value">${escapeHtml(item.preview)}</div>` : ''}
    </li>
  `).join('');

  if (previewItems) {
    requestPreviewListEl.innerHTML = previewItems;
    requestPreviewListEl.classList.remove('hidden');
  } else {
    requestPreviewListEl.classList.add('hidden');
  }

  const actionCount = (request.actions || []).length || previewItems.length;
  if (actionCount) {
    requestSummaryEl.textContent = `${actionCount} azioni in anteprima`;
    requestSummaryEl.classList.remove('hidden');
  } else {
    requestSummaryEl.classList.add('hidden');
  }

  requestFormEl.classList.add('hidden');
  requestActionsEl.classList.remove('hidden');
  requestPanel.classList.remove('hidden');
}

function showUserInputRequest(request) {
  requestTitleEl.textContent = request.title || 'Input richiesto';
  requestPromptEl.textContent = request.prompt || 'Compila i campi richiesti.';
  requestSummaryEl.classList.add('hidden');
  requestPreviewListEl.classList.add('hidden');
  renderRequestForm(request.fields || []);
  requestActionsEl.classList.remove('hidden');
  requestPanel.classList.remove('hidden');
}

function showQuestionRequest(request, activeQuestionSelections) {
  requestTitleEl.textContent = request.title || 'Domanda';
  requestPromptEl.textContent = request.prompt || '';
  requestSummaryEl.classList.add('hidden');
  requestPreviewListEl.classList.add('hidden');
  requestFormEl.innerHTML = '';
  requestFormEl.classList.remove('hidden');

  const questions = request.questions || [];
  questions.forEach((q, qIdx) => {
    activeQuestionSelections.set(qIdx, new Set());

    const qContainer = document.createElement('div');
    qContainer.style.marginBottom = '12px';

    const qHeader = document.createElement('div');
    qHeader.style.cssText = 'font-size:11px;font-weight:600;margin-bottom:6px;';
    qHeader.textContent = q.header || q.question || '';
    qContainer.appendChild(qHeader);

    const optsContainer = document.createElement('div');
    optsContainer.className = 'question-options';
    optsContainer.dataset.qidx = String(qIdx);

    (q.options || []).forEach((opt) => {
      const optEl = document.createElement('div');
      optEl.className = 'question-option';
      optEl.dataset.value = opt.label;
      optEl.innerHTML = `
        <span class="question-option-label">${escapeHtml(opt.label)}</span>
        ${opt.description ? `<span class="question-option-description">${escapeHtml(opt.description)}</span>` : ''}
      `;
      optEl.addEventListener('click', () => {
        const selSet = activeQuestionSelections.get(qIdx);
        if (q.multiSelect) {
          optEl.classList.toggle('selected');
          if (optEl.classList.contains('selected')) {
            selSet.add(opt.label);
          } else {
            selSet.delete(opt.label);
          }
        } else {
          optsContainer.querySelectorAll('.question-option').forEach(el => el.classList.remove('selected'));
          optEl.classList.add('selected');
          selSet.clear();
          selSet.add(opt.label);
        }
      });
      optsContainer.appendChild(optEl);
    });

    qContainer.appendChild(optsContainer);
    requestFormEl.appendChild(qContainer);
  });

  requestActionsEl.classList.remove('hidden');
  requestPanel.classList.remove('hidden');
}

function collectRequestFormValues() {
  const values = {};
  const fields = requestFormEl.querySelectorAll('[data-field-key]');
  fields.forEach((field) => {
    const key = field.getAttribute('data-field-key');
    if (!key) return;
    if (field.type === 'checkbox') {
      values[key] = !!field.checked;
    } else if (field.type === 'number') {
      values[key] = field.value === '' ? null : Number(field.value);
    } else {
      values[key] = field.value;
    }
  });
  return values;
}

function renderRequestForm(fields) {
  const normalized = normalizeRequestFields(fields);
  const safeFields = normalized.length > 0 ? normalized : [{ key: 'notes', label: 'Dettagli', type: 'textarea', required: true }];

  requestFormEl.innerHTML = safeFields.map((field, index) => {
    const key = field.key || field.name || `field_${index + 1}`;
    const label = field.label || key;
    const required = field.required ? 'required' : '';
    const placeholder = escapeHtml(field.placeholder || '');
    const defaultValue = field.defaultValue != null ? String(field.defaultValue) : '';
    const type = field.type || 'text';

    let control = '';
    if (type === 'textarea') {
      control = `<textarea data-field-key="${escapeAttr(key)}" placeholder="${placeholder}" ${required}>${escapeHtml(defaultValue)}</textarea>`;
    } else if (type === 'select') {
      const options = Array.isArray(field.options) ? field.options : [];
      control = `<select data-field-key="${escapeAttr(key)}" ${required}>
        ${options.map(option => {
          const value = typeof option === 'string' ? option : option.value;
          const title = typeof option === 'string' ? option : (option.label || option.value);
          const selected = String(value) === defaultValue ? 'selected' : '';
          return `<option value="${escapeAttr(value)}" ${selected}>${escapeHtml(title)}</option>`;
        }).join('')}
      </select>`;
    } else {
      const inputType = type === 'number' ? 'number' : (type === 'boolean' ? 'checkbox' : 'text');
      if (inputType === 'checkbox') {
        const checked = defaultValue === 'true' ? 'checked' : '';
        control = `<input type="checkbox" data-field-key="${escapeAttr(key)}" ${checked}>`;
      } else {
        control = `<input type="${inputType}" data-field-key="${escapeAttr(key)}" value="${escapeAttr(defaultValue)}" placeholder="${placeholder}" ${required}>`;
      }
    }

    return `<div class="request-field"><label>${escapeHtml(label)}</label>${control}</div>`;
  }).join('');

  requestFormEl.classList.remove('hidden');
}

function normalizeRequestFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields.map((field, index) => {
    if (typeof field === 'string') {
      const key = field.toLowerCase().replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || `field_${index + 1}`;
      return { key, label: field, type: 'text', required: true };
    }
    if (!field || typeof field !== 'object') {
      return { key: `field_${index + 1}`, label: `Campo ${index + 1}`, type: 'text', required: false };
    }
    const key = field.key || field.name || `field_${index + 1}`;
    return { type: 'text', required: false, ...field, key, label: field.label || key };
  });
}

function isRequestPanelVisible() {
  return !requestPanel.classList.contains('hidden');
}

export {
  hideRequestPanel, showPermissionRequest, showUserInputRequest, showQuestionRequest,
  collectRequestFormValues, normalizeRequestFields, isRequestPanelVisible
};
