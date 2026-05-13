'use strict';

import state from './store/state.js';
import { restoreTurnMemory, persistTurnStarted, persistTurnCompleted, forgetActiveTurn } from './store/turnMemory.js';
import { escapeHtml, formatActionTarget, isRangeWriteAction, summarizeMatrix } from './utils/html.js';
import { initTabs, switchTab, updateProgressBadge, API_BASE } from './ui/tabs.js';
import { addMessage, removeMessage, showTypingIndicator, hideTypingIndicator, showQuestionOptionsInChat, getChatContainer } from './ui/chat.js';
import { showToast } from './ui/toast.js';
import { initExecutionLog, addLog, clearLog } from './ui/executionLog.js';
import { renderTaskTree, updateTaskStatus, resetTaskTree, showApproveBar, hideApproveBar, startElapsedTimer, stopElapsedTimer, getTaskTreeCache, updateProgress } from './ui/taskTree.js';
import { updateStepsPanel, hideStepsPanel } from './ui/stepsPanel.js';
import { showCodePanel, hideCodePanel, clearCodePanel } from './ui/codePanel.js';
import { initApprovalModal, showApprovalModal, hideApprovalModal } from './ui/approvalModal.js';
import { initUndoBadge, showUndoBadge } from './ui/undoBar.js';
import { hideRequestPanel, showPermissionRequest, showUserInputRequest, showQuestionRequest, collectRequestFormValues, normalizeRequestFields } from './ui/requestPanel.js';
import { getExcelContext } from './excel/context.js';
import { worksheetExists, readWorkbookSnapshot, readSheetSnapshot, readRangeSnapshot, readRangeAsCsv, readNamedRanges, readMultiRangeBatch } from './excel/readers.js';
import { enqueueActions, executeActions as execActions, undoLastSnapshot } from './excel/writers.js';
import { startTurn, approveTurnExecution, postTurnResponse, postTurnResponseBatch, getTurn, getErrorMessageFromResponse } from './api/turn.js';
import { startAgent, resumeAgentWithResponse, postAgentClientResponse } from './api/agent.js';
import { loadModelConfig, changeModel, warmupLLM } from './api/config.js';

const AGENT_KEYWORDS = ['dcf','wacc','lbo','model','modello','build','costruisci','valuation','finanziario','financial','forecast','proiezioni','sensitivity','scenario'];

const messagesContainer = document.getElementById('messages');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const statusEl = document.getElementById('status');
const actionsPreview = document.getElementById('actions-preview');
const actionsList = document.getElementById('actions-list');
const agentModeCheck = document.getElementById('agent-mode-check');
const agentModeToggle = document.getElementById('agent-mode-toggle');
const promptVariantCheck = document.getElementById('prompt-variant-check');
const promptVariantToggle = document.getElementById('prompt-variant-toggle');
const agentPanel = document.getElementById('progress-panel');
const taskTreeEl = document.getElementById('task-tree');
const approveBar = document.getElementById('approve-bar');
const btnExecute = document.getElementById('btn-execute');
const btnCancelPlan = document.getElementById('btn-cancel-plan');
const btnRequestPrimary = document.getElementById('btn-request-primary');
const btnRequestSecondary = document.getElementById('btn-request-secondary');
const modelSelect = document.getElementById('model-select');
const scrollBottomBtn = document.getElementById('scroll-bottom-btn');
const themeToggle = document.getElementById('theme-toggle');
const pendingQuestionBanner = document.getElementById('pending-question-banner');

function showActionsPreview(actions) {
  actionsList.innerHTML = actions.map(a =>
    `<li><span class="code-block">${a.type}</span> → ${escapeHtml(formatActionTarget(a))}</li>`
  ).join('');
  actionsPreview.classList.add('visible');
}

function hideActionsPreview() {
  actionsPreview.classList.remove('visible');
}

function showPendingQuestionBanner(text) {
  if (!pendingQuestionBanner) return;
  const content = pendingQuestionBanner.querySelector('.pending-question-text');
  if (content) content.textContent = text || 'In attesa della tua risposta...';
  pendingQuestionBanner.classList.remove('hidden');
  addLog('[UI] Banner domanda in sospeso MOSTRATO');
}

function hidePendingQuestionBanner() {
  if (!pendingQuestionBanner) return;
  pendingQuestionBanner.classList.add('hidden');
  addLog('[UI] Banner domanda in sospeso NASCOSTO');
}

function shouldUseAgentMode(text) {
  if (agentModeCheck.checked) return true;
  const lower = text.toLowerCase();
  return AGENT_KEYWORDS.some(k => lower.includes(k));
}

Office.onReady((info) => {
  if (info.host === Office.HostType.Excel) {
    statusEl.textContent = 'Connesso a Excel';
    statusEl.className = 'status-connected';
    init();
  }
});

async function init() {
  initTabs();
  initExecutionLog();
  initApprovalModal();
  initUndoBadge(handleUndo);
  const restoredTurnMemory = restoreTurnMemory(state);
  if (restoredTurnMemory?.lastCompletedTurnId || restoredTurnMemory?.lastTurnId) {
    addLog(`Continuità chat ripristinata: ${restoredTurnMemory.lastCompletedTurnId || restoredTurnMemory.lastTurnId}`, 'info');
  }

  loadModelConfig().then(config => {
    if (config && config.current) {
      const currentModel = config.current.model || config.current.provider;
      if (currentModel) {
        for (const opt of modelSelect.options) {
          if (opt.value === currentModel) {
            modelSelect.value = currentModel;
            break;
          }
        }
      }
    }
  });

  // Prime LLM provider cache with system prompt — first real request will be much faster.
  // Fire-and-forget: server returns immediately, runs in background.
  warmupLLM().then(ok => {
    if (ok) addLog('LLM cache warmup avviato', 'info');
  });

  modelSelect.addEventListener('change', async () => {
    const model = modelSelect.value;
    const ok = await changeModel(model);
    if (ok) {
      addLog(`Modello cambiato: ${model}`);
      showToast(`Modello: ${modelSelect.options[modelSelect.selectedIndex].text}`, 'info');
    } else {
      addLog('Errore cambio modello', 'error');
    }
  });

  themeToggle.addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.documentElement.setAttribute('data-theme', isDark ? '' : 'dark');
    themeToggle.setAttribute('aria-pressed', String(!isDark));
    themeToggle.textContent = isDark ? '◐' : '◑';
  });

  sendBtn.addEventListener('click', handleSend);
  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  scrollBottomBtn.addEventListener('click', () => {
    const chatContainer = getChatContainer();
    chatContainer.scrollTop = chatContainer.scrollHeight;
    scrollBottomBtn.classList.remove('visible');
  });

  btnExecute.addEventListener('click', () => {
    if (state.currentTurnId) {
      approveTurn(state.currentTurnId);
    }
  });
  btnCancelPlan.addEventListener('click', resetAgent);
  btnRequestPrimary.addEventListener('click', handlePrimaryRequestAction);
  btnRequestSecondary.addEventListener('click', handleSecondaryRequestAction);

  agentModeToggle.classList.toggle('active', agentModeCheck.checked);
  agentModeCheck.addEventListener('change', () => {
    agentModeToggle.classList.toggle('active', agentModeCheck.checked);
  });

  if (promptVariantCheck && promptVariantToggle) {
    promptVariantToggle.classList.toggle('active', promptVariantCheck.checked);
    promptVariantCheck.addEventListener('change', () => {
      promptVariantToggle.classList.toggle('active', promptVariantCheck.checked);
    });
  }

  resumeStoredTurnIfActive(restoredTurnMemory);
}

async function handleSend() {
  const text = userInput.value.trim();
  if (!text || state.isProcessing) return;

  // If agent is paused waiting for a response, route this message as the answer
  if (state.isAgentPaused && state.pausedAgentId) {
    addMessage(text, 'user');
    userInput.value = '';
    state.isProcessing = true;
    sendBtn.disabled = true;
    showTypingIndicator();
    try {
      addLog(`Invio risposta a agent in pausa: ${text}`);
      await resumeAgent(state.pausedAgentId, text);
    } catch (err) {
      addMessage(`Errore ripresa agent: ${err.message}`, 'error');
    } finally {
      state.isProcessing = false;
      sendBtn.disabled = false;
      hideTypingIndicator();
    }
    return;
  }

  addMessage(text, 'user');
  userInput.value = '';
  state.isProcessing = true;
  sendBtn.disabled = true;
  showTypingIndicator();

  try {
    if (shouldUseAgentMode(text)) {
      if (!agentModeCheck.checked) {
        addMessage('Ho rilevato una richiesta complessa. Preparo un piano agentico con preview e approvazione prima delle modifiche.', 'bot');
        agentModeCheck.checked = true;
        agentModeToggle.classList.add('active');
      }
    }
    await runTurnMode(text);
  } catch (err) {
    console.error(err);
    addMessage('Errore: ' + err.message, 'error');
  } finally {
    state.isProcessing = false;
    sendBtn.disabled = false;
    hideTypingIndicator();
  }
}

function resetAgent() {
  resetTaskTree();
  hideStepsPanel();
  clearLog();
  hideCodePanel();
  hideApproveBar();
  hideRequestPanel();
  state.currentTurnId = null;
  forgetActiveTurn();
  state.currentPlanTasks = null;
  state.handledActionBatchIds.clear();
  state.handledRequestIds.clear();
  resetRequestQueue();
  if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
  closeAgentEventStream();
  state.currentAgentId = null;
  state.isAgentPaused = false;
  state.pausedAgentId = null;
  updateProgressBadge(0);
  stopElapsedTimer();
}

function resetRequestQueue() {
  state.requestQueue = [];
  state.activeRequest = null;
  state.isProcessingRequestQueue = false;
  hideRequestPanel();
}

async function resumeStoredTurnIfActive(restoredTurnMemory) {
  const turnId = restoredTurnMemory?.lastTurnId;
  if (!turnId || state.currentTurnId) return;

  try {
    const turn = await getTurn(turnId);
    const resumable = ['planning', 'awaiting_approval', 'running'].includes(turn.status);
    if (!resumable) return;

    state.currentTurnId = turn.id;
    state.lastTurnId = turn.id;
    switchTab('progress');
    startElapsedTimer();
    const planMsgId = addMessage(`Riprendo il turn in corso: <strong>${escapeHtml(turn.id)}</strong>`, 'bot');
    addLog(`Ripresa turn ${turn.id} (${turn.status})`, 'info');
    if (turn.status === 'awaiting_approval') showApproveBar();
    openTurnEventStream(turn.id, planMsgId);
  } catch (err) {
    addLog(`Ripresa turn salvato non disponibile: ${err.message}`, 'warn');
  }
}

function closeAgentEventStream() {
  if (state.agentEventSource) {
    state.agentEventSource.close();
    state.agentEventSource = null;
  }
}

async function runAgentMode(text) {
  resetAgent();
  switchTab('progress');
  closeAgentEventStream();
  startElapsedTimer();

  const planMsgId = addMessage('Avvio Agent Loop continuo...', 'bot');

  try {
    const context = await getExcelContext();
    addLog('Lettura contesto Excel completata');

    const promptVariant = promptVariantCheck && promptVariantCheck.checked ? 'fast' : 'default';
    const startData = await startAgent(text, context, modelSelect.value, promptVariant);
    state.currentAgentId = startData.agentId;
    removeMessage(planMsgId);
    addLog(`Agent avviato: ${state.currentAgentId}`);
    showToast('Agent avviato', 'info');

    openAgentEventStream(state.currentAgentId);

  } catch (err) {
    removeMessage(planMsgId);
    addMessage('Errore agent loop: ' + err.message, 'error');
    resetAgent();
    stopElapsedTimer();
  }
}

function openAgentEventStream(agentId) {
  closeAgentEventStream();
  const src = new EventSource(`${API_BASE}/api/agent/stream/${agentId}`);
  state.agentEventSource = src;

  src.addEventListener('agentStarted', () => {
    addLog('Agent loop avviato');
  });

  src.addEventListener('llmProgress', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.text) {
        // Update typing/thinking indicator with live token count
        const charCount = data.text.length;
        if (charCount % 200 === 0 || data.isDone) {
          // Throttled log to avoid flooding
          addLog(`Streaming: ${charCount} char${data.isDone ? ' (done)' : ''}`, 'debug');
        }
      }
    } catch (err) {}
  });

  src.addEventListener('thought', (e) => {
    try {
      const data = JSON.parse(e.data);
      addLog(`[Iter ${data.iteration}] ${data.tool}: ${(data.thought || '').slice(0, 100)}`);
    } catch (err) {}
  });

  src.addEventListener('todoWrite', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.todos) updateStepsPanel(data.todos);
    } catch (err) {}
  });

  src.addEventListener('actions', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.actions && data.actions.length > 0) {
        addLog(`Eseguo ${data.actions.length} azioni Excel`);
        showToast(`${data.actions.length} azioni in esecuzione su Excel`, 'info');
        enqueueActions(data.actions, state.excelActionQueue, showActionsPreview, hideActionsPreview,
          (acts) => execActions(acts, updateStepsPanel));
      }
    } catch (err) {}
  });

  src.addEventListener('codeLog', (e) => {
    try {
      const data = JSON.parse(e.data);
      showCodePanel(data.code, data.result);
    } catch (err) {}
  });

  src.addEventListener('agentAutoAnswer', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.answer) {
        addMessage(`<div class="auto-answer-banner">🤖 <strong>Domanda auto-risposta:</strong> ${escapeHtml(data.answer)}</div>`, 'bot');
      }
    } catch (err) {}
  });

  src.addEventListener('toolRequestBatch', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.requests && data.requests.length > 0) {
        handleAgentClientToolBatch(agentId, data.requests);
      }
    } catch (err) {
      addLog(`Errore agent toolRequestBatch: ${err.message}`, 'error');
    }
  });

  src.addEventListener('agentPaused', (e) => {
    try {
      addLog('[agentPaused] EVENTO SSE RICEVUTO');
      const data = JSON.parse(e.data);
      addLog(`[agentPaused] DATA: reason=${data.reason}, hasQuestion=${!!data.question}, isArray=${Array.isArray(data.question)}, type=${typeof data.question}`);
      
      if (data.reason === 'user_input_required' && data.question) {
        // Mark agent as paused so subsequent messages are routed as responses
        state.isAgentPaused = true;
        state.pausedAgentId = agentId;
        addLog('[agentPaused] STATO: agente messo in pausa');
        
        // ALWAYS switch to chat tab so user sees the question
        addLog('[agentPaused] AZIONE: switchTab a chat');
        switchTab('chat');
        
        // Show fixed banner at top of chat (impossible to miss)
        showPendingQuestionBanner('In attesa della tua risposta — scrolla in basso per vedere la domanda');
        
        if (Array.isArray(data.question)) {
          addLog(`[agentPaused] RENDER: domanda array con ${data.question.length} elementi`);
          showQuestionOptionsInChat(data.question, agentId, (label) => {
            addLog(`[agentPaused] RISPOSTA: utente ha selezionato "${label}"`);
            hidePendingQuestionBanner();
            addMessage(`Hai scelto: ${escapeHtml(label)}`, 'user');
            resumeAgent(agentId, label);
          });
        } else {
          const qText = String(data.question || '');
          addLog(`[agentPaused] RENDER: domanda testo "${qText.slice(0, 80)}"`);
          addMessage(`<div class="inline-question-alert"><span>Domanda</span>${escapeHtml(qText)}</div>`, 'bot');
        }
      } else {
        addLog(`[agentPaused] SALTATO: reason=${data.reason}, question=${JSON.stringify(data.question).slice(0, 100)}`);
      }
    } catch (err) {
      addLog(`[agentPaused] ERRORE CRITICO: ${err.message}`, 'error');
      addLog(`[agentPaused] Stack: ${err.stack}`, 'error');
    }
  });

  src.addEventListener('agentCompleted', (e) => {
    try {
      const data = JSON.parse(e.data);
      hideTypingIndicator();
      stopElapsedTimer();
      hidePendingQuestionBanner();
      // Clear paused state
      state.isAgentPaused = false;
      state.pausedAgentId = null;
      if (data.status === 'completed') {
        addMessage(`<strong>Completato!</strong> ${escapeHtml(data.summary || '')}`, 'bot');
        showToast('Completato!', 'success');
      } else if (data.status === 'paused') {
        // Paused state — don't close SSE, keep waiting for user response
        // Question was already shown by agentPaused handler above
        return;
      } else if (data.status === 'aborted' || data.status === 'error') {
        const summary = escapeHtml(data.summary || '');
        const lowerSummary = summary.toLowerCase();
        const isApiKey = lowerSummary.includes('api key');
        const isAuth = lowerSummary.includes('unauthorized') || lowerSummary.includes('authentication');
        const is402 = lowerSummary.includes('402') || lowerSummary.includes('payment required') || lowerSummary.includes('credit');
        if (is402) {
          addMessage(`<div style="background:#fdecea;border:1px solid #dc3545;border-radius:8px;padding:10px 12px;font-size:12px;"><strong>💳 Fondi insufficienti</strong><br>Il provider ha risposto con errore 402 (Payment Required). I crediti API sono esauriti o l'account non ha fondi. Ricarica il credito o cambia provider dal menu in alto.</div>`, 'error');
          showToast('Crediti API esauriti — ricarica o cambia provider', 'error');
        } else if (isApiKey || isAuth) {
          addMessage(`<div style="background:#fdecea;border:1px solid #dc3545;border-radius:8px;padding:10px 12px;font-size:12px;"><strong>⚠️ Errore configurazione API key</strong><br>Il modello selezionato non ha una chiave API configurata. Controlla la configurazione o cambia modello dal menu in alto.</div>`, 'error');
          showToast('API key mancante — controlla la configurazione', 'error');
        } else {
          addMessage(`<div style="background:#fdecea;border:1px solid #dc3545;border-radius:8px;padding:10px 12px;font-size:12px;"><strong>⚠️ Errore agent</strong><br>${summary || 'L\'agente si è interrotto inaspettatamente.'}</div>`, 'error');
          showToast('Errore agent', 'error');
        }
        addLog(`Agent ABORTED: ${summary}`, 'error');
      } else {
        addMessage(`<strong>Completato</strong> (${data.status || 'max iterations'})`, 'bot');
      }
      addLog(`Agent loop completato in ${data.iteration || '?'} iterazioni`);
      hideStepsPanel();
      closeAgentEventSource();
    } catch (err) {}
  });

  src.addEventListener('agentError', (e) => {
    try {
      const data = JSON.parse(e.data);
      hidePendingQuestionBanner();
      const errText = escapeHtml(data.error || 'Errore sconosciuto');
      const lowerErr = errText.toLowerCase();
      const isApiKey = lowerErr.includes('api key');
      const isAuth = lowerErr.includes('unauthorized') || lowerErr.includes('authentication');
      const is402 = lowerErr.includes('402') || lowerErr.includes('payment required') || lowerErr.includes('credit');
      if (is402) {
        addMessage(`<div style="background:#fdecea;border:1px solid #dc3545;border-radius:8px;padding:10px 12px;font-size:12px;"><strong>💳 Fondi insufficienti</strong><br>Il provider ha risposto con errore 402 (Payment Required). I crediti API sono esauriti o l'account non ha fondi. Ricarica il credito o cambia provider dal menu in alto.</div>`, 'error');
        showToast('Crediti API esauriti — ricarica o cambia provider', 'error');
      } else if (isApiKey || isAuth) {
        addMessage(`<div style="background:#fdecea;border:1px solid #dc3545;border-radius:8px;padding:10px 12px;font-size:12px;"><strong>⚠️ Errore configurazione API key</strong><br>Il modello selezionato non ha una chiave API configurata. Controlla la configurazione o cambia modello dal menu in alto.</div>`, 'error');
        showToast('API key mancante — controlla la configurazione', 'error');
      } else {
        addMessage(`<div style="background:#fdecea;border:1px solid #dc3545;border-radius:8px;padding:10px 12px;font-size:12px;"><strong>⚠️ Errore agent</strong><br>${errText}</div>`, 'error');
        showToast(`Errore: ${errText}`, 'error');
      }
      addLog(`Errore agent: ${data.error}`, 'error');
      stopElapsedTimer();
    } catch (err) {}
    closeAgentEventStream();
  });

  src.onerror = () => {
    addLog('Connessione agent SSE interrotta', 'error');
    closeAgentEventStream();
  };
}

async function resumeAgent(agentId, userResponse) {
  try {
    addLog('Invio risposta e ripresa agent...');
    showTypingIndicator();
    hidePendingQuestionBanner();
    // Clear paused state before resume
    state.isAgentPaused = false;
    state.pausedAgentId = null;
    // Switch back to progress tab
    switchTab('progress');
    const data = await resumeAgentWithResponse(agentId, userResponse);
    state.currentAgentId = data.agentId;
    openAgentEventStream(state.currentAgentId);
  } catch (err) {
    addMessage(`Errore ripresa agent: ${err.message}`, 'error');
    hideTypingIndicator();
    state.isProcessing = false;
    sendBtn.disabled = false;
  }
}

async function runTurnMode(text) {
  const parentTurnId = state.currentTurnId || state.lastCompletedTurnId || state.lastTurnId || null;
  resetAgent();
  switchTab('progress');
  closeAgentEventStream();
  startElapsedTimer();

  const planMsgId = addMessage('Analizzo il workbook e genero un piano...', 'bot');

  try {
    const context = await getExcelContext();
    addLog('Lettura contesto Excel completata');

    const startData = await startTurn(text, context, modelSelect.value, parentTurnId);
    state.currentTurnId = startData.turnId;
    state.lastTurnId = startData.turnId;
    persistTurnStarted(startData.turnId);
    addLog('Turn creato: ' + startData.turnId);
    if (parentTurnId) addLog('Continuità chat: uso il contesto del turn precedente ' + parentTurnId);
    openTurnEventStream(startData.turnId, planMsgId);
  } catch (err) {
    removeMessage(planMsgId);
    addMessage('Errore avvio turn: ' + err.message, 'error');
    resetAgent();
    stopElapsedTimer();
  }
}

function openTurnEventStream(turnId, planMsgId) {
  if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }

  let attempt = 0;
  const maxBackoff = 15000;
  let currentSource = null;
  let lastPlanningProgressAt = 0;
  let lastPlanningProgressChars = 0;

  function setupListeners(src) {
    let planReceived = false;

    src.addEventListener('turnStarted', () => {
      addLog(`Turn ${turnId} avviato`);
    });

    src.addEventListener('planUpdated', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.tasks && !planReceived) {
          planReceived = true;
          removeMessage(planMsgId);
          state.currentPlanTasks = data.tasks;
          addMessage(`Piano generato: <strong>${escapeHtml(turnId)}</strong> (${data.tasks.length} task)`, 'bot');
          renderTaskTree(data.tasks);
          updateProgressBadge(data.tasks.length);
          showToast(`Piano: ${data.tasks.length} task`, 'info');
        }
      } catch (err) {}
    });

    src.addEventListener('turnAwaitingApproval', () => {
      addLog('Piano pronto. In attesa della tua conferma per eseguire.');
      showApproveBar();
    });

    src.addEventListener('itemStarted', (e) => {
      try {
        const data = JSON.parse(e.data);
        const item = data.item || {};
        if (item.type === 'taskExecution') {
          updateTaskStatus(item.taskId, 'running');
          addLog(`[${item.taskId}] ${item.description || item.tool} — avviato`);
        }
      } catch (err) {}
    });

    src.addEventListener('taskActions', (e) => {
      try {
        const data = JSON.parse(e.data);
        const batchId = data.itemId || data.taskId || JSON.stringify(data.actions || []);
        if (state.handledActionBatchIds.has(batchId)) return;
        state.handledActionBatchIds.add(batchId);
        if (data.actions && data.actions.length > 0) {
          addLog(`[${data.taskId}] Eseguo ${data.actions.length} azioni su Excel`);
          showToast(`${data.actions.length} azioni Excel (${data.taskId})`, 'info');
          enqueueActions(data.actions, state.excelActionQueue, showActionsPreview, hideActionsPreview,
            (acts) => execActions(acts, updateStepsPanel));
        }
      } catch (err) {}
    });

    src.addEventListener('toolRequest', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.request) queueToolRequest(data.request);
      } catch (err) {}
    });

    src.addEventListener('toolRequestBatch', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.requests && data.requests.length > 0) handleClientToolBatch(data.requests);
      } catch (err) {}
    });

    src.addEventListener('toolRequestResolved', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (state.activeRequest && data.requestId === state.activeRequest.id) {
          handleRequestResolved();
        }
      } catch (err) {}
    });

    src.addEventListener('itemCompleted', (e) => {
      try {
        const data = JSON.parse(e.data);
        const item = data.item || {};
        if (item.type === 'taskExecution') {
          const status = item.status === 'error' ? 'error' : 'completed';
          updateTaskStatus(item.taskId, status);
          if (item.status === 'error') {
            addLog(`[${item.taskId}] ERRORE: ${item.error || 'errore sconosciuto'}`, 'error');
          } else {
            addLog(`[${item.taskId}] completato`);
          }
        }
      } catch (err) {}
    });

    src.addEventListener('log', (e) => {
      try {
        const data = JSON.parse(e.data);
        addLog(data.message, data.level);
      } catch (err) {}
    });

    src.addEventListener('llmProgress', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.text && !planReceived) {
          const now = Date.now();
          const chars = String(data.text).length;
          const shouldLog = data.isDone
            || lastPlanningProgressAt === 0
            || now - lastPlanningProgressAt >= 5000
            || chars - lastPlanningProgressChars >= 3000;

          if (shouldLog) {
            lastPlanningProgressAt = now;
            lastPlanningProgressChars = chars;
            addLog(data.isDone
              ? 'Generazione piano LLM completata.'
              : `Generazione piano LLM in corso (${chars} caratteri)...`);
          }
        }
      } catch (err) {}
    });

    src.addEventListener('todoWrite', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.todos) updateStepsPanel(data.todos);
      } catch (err) {}
    });

    src.addEventListener('turnCompleted', (e) => {
      try {
        const data = JSON.parse(e.data);
        state.lastTurnId = data.turnId || turnId;
        if (!(data.status === 'error' || data.error)) {
          state.lastCompletedTurnId = data.turnId || turnId;
        }
        persistTurnCompleted(data.turnId || turnId, !(data.status === 'error' || data.error));
        removeMessage(planMsgId);
        hideApproveBar();
        hideTypingIndicator();
        stopElapsedTimer();
        if (data.status === 'error' || data.error) {
          addLog(`Esecuzione terminata con errore: ${data.error || 'errore sconosciuto'}`, 'error');
          addMessage(`Esecuzione interrotta: ${escapeHtml(data.error || 'errore sconosciuto')}`, 'error');
          showToast('Completato con errori', 'error');
        } else {
          addLog('Esecuzione completata.');
          addMessage('Modello completato! Tutti i task sono stati eseguiti su Excel.', 'bot');
          showToast('Esecuzione completata', 'success');
        }
        resetRequestQueue();
        hideStepsPanel();
        updateProgressBadge(0);
        src.close();
        if (currentSource === src) {
          currentSource = null;
          state.eventSource = null;
        }
      } catch (err) {}
    });

    src.onerror = () => {
      if (currentSource !== src) return;
      addLog('Connessione SSE instabile, tento riconnessione...', 'error');
      src.close();
      currentSource = null;
      state.eventSource = null;
      attempt += 1;
      const delay = Math.min(1000 * Math.pow(2, attempt), maxBackoff);
      setTimeout(connect, delay);
    };

    src.onopen = () => { attempt = 0; };
  }

  function connect() {
    if (state.currentTurnId !== turnId) return;
    currentSource = new EventSource(`${API_BASE}/api/turn/stream/${turnId}`);
    state.eventSource = currentSource;
    setupListeners(currentSource);
  }

  connect();
}

async function approveTurn(turnId) {
  hideApproveBar();
  addLog('Avvio esecuzione turn ' + turnId);
  showToast('Esecuzione avviata...', 'info');
  try {
    await approveTurnExecution(turnId);
  } catch (err) {
    addLog('Errore avvio esecuzione: ' + err.message, 'error');
  }
}

function queueToolRequest(request) {
  if (!request || !request.id || state.handledRequestIds.has(request.id)) return;
  state.handledRequestIds.add(request.id);
  state.requestQueue.push(request);
  processToolRequests();
}

async function processToolRequests() {
  if (state.isProcessingRequestQueue || state.activeRequest || state.requestQueue.length === 0) return;
  state.isProcessingRequestQueue = true;

  try {
    while (!state.activeRequest && state.requestQueue.length > 0) {
      const request = state.requestQueue.shift();
      if (!request) continue;

      if (request.type === 'clientTool') {
        await handleClientToolRequest(request);
        continue;
      }

      if (request.type === 'permission') {
        state.activeRequest = request;
        switchTab('details');
        showPermissionRequest(request);
        break;
      }

      if (request.type === 'userInput') {
        state.activeRequest = request;
        switchTab('details');
        showUserInputRequest(request);
        break;
      }

      if (request.type === 'question') {
        state.activeRequest = request;
        switchTab('details');
        showQuestionRequest(request, state.activeQuestionSelections);
        break;
      }

      await postTurnResponse(state.currentTurnId, request.id, {
        error: `Tipo richiesta non supportato: ${request.type}`
      });
    }
  } catch (err) {
    addLog(`Errore gestione richiesta runtime: ${err.message}`, 'error');
    if (state.activeRequest) {
      try { await postTurnResponse(state.currentTurnId, state.activeRequest.id, { error: err.message }); } catch (postErr) {}
      handleRequestResolved();
    }
  } finally {
    state.isProcessingRequestQueue = false;
    if (!state.activeRequest && state.requestQueue.length > 0) {
      setTimeout(processToolRequests, 0);
    }
  }
}

function handleRequestResolved() {
  state.activeRequest = null;
  hideRequestPanel();
  processToolRequests();
}

async function handleClientToolRequest(request) {
  addLog(`[${request.taskId || 'runtime'}] Lettura client ${request.toolName}`);
  try {
    let data;
    switch (request.toolName) {
      case 'workbook.readWorkbook':
        data = await readWorkbookSnapshot(request.params || {});
        break;
      case 'workbook.readSheet':
        data = await readSheetSnapshot(request.params || {});
        break;
      case 'workbook.readRange':
        data = await readRangeSnapshot(request.params || {});
        break;
      case 'workbook.listNamedRanges':
        data = await readNamedRanges(request.params || {});
        break;
      default:
        throw new Error(`Client tool non supportato: ${request.toolName}`);
    }
    await postTurnResponse(state.currentTurnId, request.id, { data });
    addLog(`[${request.taskId || 'runtime'}] ${request.toolName} completato`);
  } catch (err) {
    await postTurnResponse(state.currentTurnId, request.id, { error: err.message });
    addLog(`[${request.taskId || 'runtime'}] ${request.toolName} fallito: ${err.message}`, 'error');
  }
}

async function handleClientToolBatch(requests) {
  if (!requests || requests.length === 0) return;
  addLog(`Batch clientTool: ${requests.length} richieste`);

  try {
    // NOTE: each reader already wraps itself in Excel.run(); do NOT nest here
    const outputs = [];
    for (const request of requests) {
      try {
        let data;
        switch (request.toolName) {
          case 'workbook.readWorkbook':
            data = await readWorkbookSnapshot(request.params || {});
            break;
          case 'workbook.readSheet':
            data = await readSheetSnapshot(request.params || {});
            break;
          case 'workbook.readRange': {
            const p = request.params || {};
            data = p.format === 'csv' ? await readRangeAsCsv(p) : await readRangeSnapshot(p);
            break;
          }
          case 'workbook.listNamedRanges':
            data = await readNamedRanges(request.params || {});
            break;
          default:
            throw new Error(`Client tool non supportato: ${request.toolName}`);
        }
        outputs.push({ requestId: request.id, response: { data } });
        addLog(`[${request.taskId || 'runtime'}] ${request.toolName} completato (batch)`);
      } catch (err) {
        outputs.push({ requestId: request.id, response: { error: err.message } });
        addLog(`[${request.taskId || 'runtime'}] ${request.toolName} fallito: ${err.message}`, 'error');
      }
    }

    await postTurnResponseBatch(state.currentTurnId, outputs);
  } catch (err) {
    addLog(`Errore batch clientTool: ${err.message}`, 'error');
    const errorResponses = requests.map(r => ({ requestId: r.id, response: { error: err.message } }));
    try { await postTurnResponseBatch(state.currentTurnId, errorResponses); } catch (e) {}
  }
}

async function handleAgentClientToolBatch(agentId, requests) {
  if (!requests || requests.length === 0) return;
  addLog(`Agent clientTool: ${requests.length} richieste`);

  try {
    // Group range reads for batch execution in single Excel.run()
    const rangeReads = [];
    const otherRequests = [];

    for (const request of requests) {
      if (request.toolName === 'workbook.readRange' || request.toolName === 'workbook.readSheet') {
        rangeReads.push(request);
      } else {
        otherRequests.push(request);
      }
    }

    // Execute all range reads in one Excel.run()
    let batchResults = [];
    if (rangeReads.length > 0) {
      const batchReqs = rangeReads.map(r => ({
        id: r.id,
        sheet: r.params?.sheet || r.params?.sheetName,
        target: r.params?.target || r.params?.range,
        maxRows: r.params?.maxRows,
        format: r.params?.format || 'snapshot'
      }));
      batchResults = await readMultiRangeBatch(batchReqs);
    }

    // Map batch results back to outputs
    const outputs = batchResults.map(r => ({
      requestId: r.requestId,
      response: r.error ? { error: r.error } : { data: r.data }
    }));

    // Handle non-range reads individually
    for (const request of otherRequests) {
      try {
        let data;
        switch (request.toolName) {
          case 'workbook.readWorkbook':
            data = await readWorkbookSnapshot(request.params || {});
            break;
          case 'workbook.listNamedRanges':
            data = await readNamedRanges(request.params || {});
            break;
          default:
            throw new Error(`Client tool non supportato: ${request.toolName}`);
        }
        outputs.push({ requestId: request.id, response: { data } });
        addLog(`[agent] ${request.toolName} completato`);
      } catch (err) {
        outputs.push({ requestId: request.id, response: { error: err.message } });
        addLog(`[agent] ${request.toolName} fallito: ${err.message}`, 'error');
      }
    }

    for (const result of outputs) {
      try {
        await postAgentClientResponse(agentId, result.requestId, result.response);
      } catch (err) {
        addLog(`[agent] Errore invio risposta client: ${err.message}`, 'error');
      }
    }
  } catch (err) {
    addLog(`Errore batch agent clientTool: ${err.message}`, 'error');
    const errorResponses = requests.map(r => ({ requestId: r.id, response: { error: err.message } }));
    for (const result of errorResponses) {
      try { await postAgentClientResponse(agentId, result.requestId, result.response); } catch (e) {}
    }
  }
}

async function handlePrimaryRequestAction() {
  if (!state.activeRequest) return;
  const request = state.activeRequest;
  try {
    if (request.type === 'permission') {
      await postTurnResponse(state.currentTurnId, request.id, { approved: true });
      addLog(`[${request.taskId || 'runtime'}] Modifiche approvate`);
      showToast('Modifiche approvate', 'success');
    } else if (request.type === 'userInput') {
      const values = collectRequestFormValues();
      const missingRequired = normalizeRequestFields(request.fields || [])
        .filter(field => field.required)
        .filter(field => {
          const key = field.key || field.name;
          return values[key] === '' || values[key] == null;
        });
      if (missingRequired.length > 0) {
        showToast(`Campi richiesti: ${missingRequired.map(f => f.label || f.name).join(', ')}`, 'error');
        return;
      }
      await postTurnResponse(state.currentTurnId, request.id, { values });
      addLog(`[${request.taskId || 'runtime'}] Input inviato`);
    } else if (request.type === 'question') {
      const questions = request.questions || [];
      const answers = questions.map((q, qIdx) => {
        const selSet = state.activeQuestionSelections.get(qIdx) || new Set();
        return q.multiSelect ? Array.from(selSet) : Array.from(selSet)[0] || '';
      });
      await postTurnResponse(state.currentTurnId, request.id, { values: { answers } });
      addLog(`[${request.taskId || 'runtime'}] Risposta inviata`);
    }
    handleRequestResolved();
  } catch (err) {
    addLog(`Errore invio risposta: ${err.message}`, 'error');
  }
}

async function handleSecondaryRequestAction() {
  if (!state.activeRequest) return;
  const request = state.activeRequest;
  try {
    if (request.type === 'permission') {
      await postTurnResponse(state.currentTurnId, request.id, { approved: false, reason: 'Modifiche bloccate dall\'utente' });
      addLog(`[${request.taskId || 'runtime'}] Modifiche bloccate`, 'error');
    } else if (request.type === 'userInput') {
      await postTurnResponse(state.currentTurnId, request.id, { error: 'Input annullato dall\'utente' });
      addLog(`[${request.taskId || 'runtime'}] Input annullato`, 'error');
    } else if (request.type === 'question') {
      await postTurnResponse(state.currentTurnId, request.id, { error: 'Domanda annullata dall\'utente' });
      addLog(`[${request.taskId || 'runtime'}] Domanda annullata`, 'error');
    }
    handleRequestResolved();
  } catch (err) {
    addLog(`Errore invio risposta: ${err.message}`, 'error');
  }
}

async function handleUndo() {
  try {
    // Try client-side snapshot undo first (restores exact previous values/formulas)
    const snapshotUndone = await undoLastSnapshot();
    if (snapshotUndone) {
      showToast('Undo eseguito (snapshot)', 'info');
      return;
    }
    // Fallback: native Excel undo
    await Excel.run(async (context) => {
      context.workbook.undo();
      await context.sync();
    });
    addLog('Undo eseguito (native)');
    showToast('Undo eseguito', 'info');
  } catch (err) {
    addLog('Undo fallito: ' + err.message, 'error');
  }
}
