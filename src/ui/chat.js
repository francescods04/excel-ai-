'use strict';

import { escapeHtml, escapeAttr } from '../utils/html.js';

const messagesContainer = document.getElementById('messages');
const chatContainer = document.getElementById('chat-container');
const scrollBottomBtn = document.getElementById('scroll-bottom-btn');
let typingIndicatorEl = null;

function getChatContainer() { return chatContainer; }

function showTypingIndicator() {
  if (typingIndicatorEl) return;
  typingIndicatorEl = document.createElement('div');
  typingIndicatorEl.className = 'message bot-message';
  typingIndicatorEl.innerHTML = `
    <div class="bubble">
      <div class="typing-indicator">
        <span></span><span></span><span></span>
      </div>
    </div>
  `;
  messagesContainer.appendChild(typingIndicatorEl);
  scrollToBottom();
}

function hideTypingIndicator() {
  if (typingIndicatorEl) {
    typingIndicatorEl.remove();
    typingIndicatorEl = null;
  }
}

function addMessage(html, type) {
  const id = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
  const timestamp = new Date().toLocaleTimeString();

  const div = document.createElement('div');
  div.id = id;
  div.className = `message ${type}-message`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const content = document.createElement('div');
  content.innerHTML = html;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = timestamp;

  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-copy-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const text = content.innerText;
    navigator.clipboard.writeText(text).catch(() => {});
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  });

  bubble.appendChild(copyBtn);
  bubble.appendChild(content);
  bubble.appendChild(meta);
  div.appendChild(bubble);
  messagesContainer.appendChild(div);
  scrollToBottom();
  return id;
}

function removeMessage(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    chatContainer.scrollTop = chatContainer.scrollHeight;
    updateScrollButton();
  });
}

function updateScrollButton() {
  const atBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 60;
  if (atBottom) {
    scrollBottomBtn.classList.remove('visible');
  } else {
    scrollBottomBtn.classList.add('visible');
  }
}

function showQuestionOptionsInChat(questions, agentId, onSelect) {
  // Robust rendering: handles strings, objects with missing fields, and malformed options
  let html = '<div class="chat-question-box">';
  html += '<div class="chat-question-header">❓ Ho bisogno di una risposta</div>';

  questions.forEach((q, qIdx) => {
    const isString = typeof q === 'string';
    const questionText = isString ? q : (q.header || q.question || q.text || q.prompt || q.title || '');
    const options = isString ? [] : (Array.isArray(q.options) ? q.options : []);

    html += `<div class="chat-question-item">`;
    if (questionText) {
      html += `<div class="chat-question-text">${escapeHtml(questionText)}</div>`;
    }

    if (options.length > 0) {
      html += `<div class="chat-question-options">`;
      options.forEach((opt, oIdx) => {
        const isOptString = typeof opt === 'string';
        const label = isOptString ? opt : (opt.label || opt.value || opt.text || String(opt));
        const description = isOptString ? '' : (opt.description || opt.desc || '');
        const safeLabel = escapeAttr(label);
        const safeLabelHtml = escapeHtml(label);
        const safeDescHtml = description ? escapeHtml(description) : '';
        html += `
          <button class="chat-question-btn" data-qidx="${qIdx}" data-oidx="${oIdx}" data-label="${safeLabel}" type="button">
            <span class="chat-question-btn-label">${safeLabelHtml}</span>
            ${safeDescHtml ? `<span class="chat-question-btn-desc">${safeDescHtml}</span>` : ''}
          </button>
        `;
      });
      html += `</div>`;
    } else {
      // No options: render a text input fallback
      html += `
        <div class="chat-question-fallback">
          <input type="text" class="chat-question-input" data-qidx="${qIdx}" placeholder="Scrivi la tua risposta..." />
          <button class="chat-question-submit" data-qidx="${qIdx}" type="button">Invia</button>
        </div>
      `;
    }
    html += `</div>`;
  });
  html += '</div>';

  const msgId = addMessage(html, 'bot');
  const msgEl = document.getElementById(msgId);
  if (!msgEl || !onSelect) return;

  const bubble = msgEl.querySelector('.bubble');
  if (!bubble) return;

  // Helper to disable all controls in this question box
  function disableControls() {
    bubble.querySelectorAll('button, input').forEach(el => {
      el.disabled = true;
      el.style.opacity = '0.5';
      el.style.cursor = 'not-allowed';
    });
  }

  // Helper to show selected answer inline
  function showSelected(label) {
    disableControls();
    const selectedBanner = document.createElement('div');
    selectedBanner.className = 'chat-question-selected';
    selectedBanner.innerHTML = `✅ <strong>Hai risposto:</strong> ${escapeHtml(label)}`;
    bubble.appendChild(selectedBanner);
    onSelect(label);
  }

  // Handle button clicks (options)
  bubble.querySelectorAll('.chat-question-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const label = btn.dataset.label;
      showSelected(label);
    });
  });

  // Handle text input fallback
  bubble.querySelectorAll('.chat-question-submit').forEach(btn => {
    btn.addEventListener('click', () => {
      const qIdx = btn.dataset.qidx;
      const input = bubble.querySelector(`.chat-question-input[data-qidx="${qIdx}"]`);
      const value = input ? input.value.trim() : '';
      if (!value) return;
      showSelected(value);
    });
  });
  bubble.querySelectorAll('.chat-question-input').forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const btn = bubble.querySelector(`.chat-question-submit[data-qidx="${input.dataset.qidx}"]`);
        if (btn) btn.click();
      }
    });
  });
}

function highlightCodeBlocks(root) {
  root.querySelectorAll('pre code, code').forEach(el => {
    el.classList.add('msg-code');
  });
}

export {
  addMessage, removeMessage, showTypingIndicator, hideTypingIndicator,
  scrollToBottom, showQuestionOptionsInChat, highlightCodeBlocks, getChatContainer
};
