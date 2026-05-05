// Taskpane AI Agent for Excel — Modalità normale + Agent Mode
(function() {
  'use strict';

  const API_BASE = window.location.origin;
  let isProcessing = false;
  let currentTurnId = null;
  let currentPlanTasks = null;
  let eventSource = null;
  let requestQueue = [];
  let activeRequest = null;
  let isProcessingRequestQueue = false;
  const handledActionBatchIds = new Set();
  const handledRequestIds = new Set();
  const taskTreeCache = new Map();
  let activeQuestionSelections = new Map(); // question index -> Set(selected labels)

  // Coda azioni Excel per esecuzione sequenziale e thread-safe
  let excelActionQueue = [];
  let isExecutingQueue = false;
  let reconnectTimer = null;

  // Log DOM batching
  let logBuffer = [];
  let logFlushTimer = null;
  let logFlushRaf = null;

  // Keywords che attivano automaticamente l'agent mode
  const AGENT_KEYWORDS = ['dcf','wacc','lbo','model','modello','build','costruisci','valuation','finanziario','financial','forecast','proiezioni','sensitivity','scenario'];

  // Elementi DOM
  const messagesContainer = document.getElementById('messages');
  const userInput = document.getElementById('user-input');
  const sendBtn = document.getElementById('send-btn');
  const statusEl = document.getElementById('status');
  const actionsPreview = document.getElementById('actions-preview');
  const actionsList = document.getElementById('actions-list');
  const agentModeCheck = document.getElementById('agent-mode-check');
  const agentPanel = document.getElementById('agent-panel');
  const taskTreeEl = document.getElementById('task-tree');
  const executionLogEl = document.getElementById('execution-log');
  const approveBar = document.getElementById('approve-bar');
  const btnExecute = document.getElementById('btn-execute');
  const btnCancelPlan = document.getElementById('btn-cancel-plan');
  const requestPanel = document.getElementById('request-panel');
  const requestTitleEl = document.getElementById('request-title');
  const requestPromptEl = document.getElementById('request-prompt');
  const requestSummaryEl = document.getElementById('request-summary');
  const requestPreviewListEl = document.getElementById('request-preview-list');
  const requestFormEl = document.getElementById('request-form');
  const requestActionsEl = document.getElementById('request-actions');
  const btnRequestPrimary = document.getElementById('btn-request-primary');
  const btnRequestSecondary = document.getElementById('btn-request-secondary');

  // Selettore modello
  const modelSelect = document.getElementById('model-select');

  // Inizializzazione Office
  Office.onReady((info) => {
    if (info.host === Office.HostType.Excel) {
      statusEl.textContent = 'Connesso a Excel';
      statusEl.className = 'status-connected';
      console.log('Excel AI Agent pronto');
      loadModelConfig();
    }
  });

  async function loadModelConfig() {
    try {
      const res = await fetch(`${API_BASE}/api/config/models`);
      const data = await res.json();
      if (data.current) {
        const currentModel = data.current.model || data.current.provider;
        if (currentModel) {
          for (const opt of modelSelect.options) {
            if (opt.value === currentModel) {
              modelSelect.value = currentModel;
              break;
            }
          }
        }
      }
    } catch (err) {
      console.warn('Failed to load model config:', err);
    }
  }

  modelSelect.addEventListener('change', async () => {
    const model = modelSelect.value;
    let provider = 'openrouter';
    if (model.startsWith('xiaomi')) provider = 'xiaomi';
    else if (model.startsWith('openai')) provider = 'openai';
    else if (model.startsWith('deepseek') && !model.includes('/')) provider = 'deepseek';
    try {
      const res = await fetch(`${API_BASE}/api/config/llm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model })
      });
      if (res.ok) {
        addLog(`Modello cambiato: ${model} (${provider})`);
      } else {
        addLog('Errore cambio modello', 'error');
      }
    } catch (err) {
      addLog('Errore rete cambio modello', 'error');
    }
  });

  // Event listeners
  sendBtn.addEventListener('click', handleSend);
  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  btnExecute.addEventListener('click', () => {
    if (currentTurnId) {
      approveTurnExecution(currentTurnId);
    }
  });
  btnCancelPlan.addEventListener('click', resetAgentPanel);
  btnRequestPrimary.addEventListener('click', handlePrimaryRequestAction);
  btnRequestSecondary.addEventListener('click', handleSecondaryRequestAction);

  // Undo / Redo
  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');
  if (btnUndo) btnUndo.addEventListener('click', handleUndo);
  if (btnRedo) btnRedo.addEventListener('click', handleRedo);

  // -------- Modalità --------

  function shouldUseAgentMode(text) {
    if (agentModeCheck.checked) return true;
    const lower = text.toLowerCase();
    return AGENT_KEYWORDS.some(k => lower.includes(k));
  }

  // -------- Send handler --------

  async function handleSend() {
    const text = userInput.value.trim();
    if (!text || isProcessing) return;

    addMessage(text, 'user');
    userInput.value = '';
    isProcessing = true;
    sendBtn.disabled = true;

    try {
      if (shouldUseAgentMode(text)) {
        if (!agentModeCheck.checked) {
          addMessage('Ho rilevato una richiesta complessa. Attivo la modalità <strong>Agent</strong> per costruire il modello con multi-agente parallelo.', 'bot');
          agentModeCheck.checked = true;
        }
        await runAgentMode(text);
      } else {
        await runLegacyMode(text);
      }
    } catch (err) {
      console.error(err);
      addMessage('Errore: ' + err.message, 'error');
    } finally {
      isProcessing = false;
      sendBtn.disabled = false;
    }
  }

  // -------- Legacy mode (comandi semplici) --------

  async function runLegacyMode(text) {
    // Unified runtime: even simple commands go through the turn-based agent
    await runAgentMode(text);
  }

  // -------- Agent mode (modelli complessi) --------

  let currentAgentId = null;
  let agentEventSource = null;

  function closeAgentEventSource() {
    if (agentEventSource) {
      agentEventSource.close();
      agentEventSource = null;
    }
  }

  async function runAgentMode(text) {
    resetAgentPanel();
    agentPanel.classList.add('visible');
    closeAgentEventSource();

    const planMsgId = addMessage('Avvio Agent Loop continuo... (il modello ragiona e agisce autonomamente)', 'bot');

    try {
      const context = await getExcelContext();
      addLog('Lettura contesto Excel completata');

      // Start agent loop (returns immediately with agentId)
      const startRes = await fetch(`${API_BASE}/api/agent/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, context, modelOverride: modelSelect.value })
      });

      if (!startRes.ok) {
        const errMsg = await getErrorMessageFromResponse(startRes, 'Errore avvio agent');
        addLog('Fallback a planner legacy: ' + errMsg, 'warn');
        removeMessage(planMsgId);
        return runLegacyPlanner(text, context, planMsgId);
      }

      const startData = await startRes.json();
      currentAgentId = startData.agentId;
      removeMessage(planMsgId);
      addLog(`Agent avviato: ${currentAgentId}`);

      // Open SSE stream for live progress
      openAgentEventStream(currentAgentId);

    } catch (err) {
      removeMessage(planMsgId);
      addMessage('Errore agent loop: ' + err.message, 'error');
      resetAgentPanel();
    }
  }

  function openAgentEventStream(agentId) {
    closeAgentEventSource();
    const src = new EventSource(`${API_BASE}/api/agent/stream/${agentId}`);
    agentEventSource = src;

    src.addEventListener('agentStarted', () => {
      addLog('Agent loop avviato');
    });

    src.addEventListener('thought', (e) => {
      try {
        const data = JSON.parse(e.data);
        addLog(`[Iter ${data.iteration}] ${data.tool}: ${data.thought?.slice(0, 100)}...`);
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
          enqueueActions(data.actions);
        }
      } catch (err) {}
    });

    src.addEventListener('codeLog', (e) => {
      try {
        const data = JSON.parse(e.data);
        const codePanel = document.getElementById('code-panel') || createCodePanel();
        codePanel.classList.remove('hidden');
        const block = document.createElement('div');
        block.className = 'code-block';
        block.innerHTML = `<pre>${escapeHtml(data.code)}</pre><div class="code-result">${escapeHtml(JSON.stringify(data.result, null, 2))}</div>`;
        codePanel.appendChild(block);
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

    src.addEventListener('agentPaused', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.reason === 'user_input_required' && data.question) {
          if (Array.isArray(data.question)) {
            showChatQuestionOptions(data.question, agentId);
          } else {
            addMessage(`Domanda: ${escapeHtml(data.question)}`, 'bot');
          }
        }
      } catch (err) {}
    });

    src.addEventListener('agentCompleted', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.status === 'completed') {
          addMessage(`<strong>Completato!</strong> ${escapeHtml(data.summary || '')}`, 'bot');
        } else {
          addMessage(`<strong>Completato</strong> (${data.status})`, 'bot');
        }
        addLog(`Agent loop completato in ${data.iteration || '?'} iterazioni`);
      } catch (err) {}
      closeAgentEventSource();
    });

    src.addEventListener('agentError', (e) => {
      try {
        const data = JSON.parse(e.data);
        addMessage(`Errore agent: ${escapeHtml(data.error)}`, 'error');
        addLog(`Errore agent: ${data.error}`, 'error');
      } catch (err) {}
      closeAgentEventSource();
    });

    src.onerror = () => {
      addLog('Connessione agent SSE interrotta', 'error');
      closeAgentEventSource();
    };
  }

  async function resumeAgentWithResponse(agentId, userResponse) {
    try {
      addLog('Invio risposta e ripresa agent...');
      const res = await fetch(`${API_BASE}/api/agent/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, userResponse })
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || 'Errore risposta agent');
      }
      const data = await res.json();
      currentAgentId = data.agentId;
      openAgentEventStream(currentAgentId);
    } catch (err) {
      addMessage(`Errore ripresa agent: ${err.message}`, 'error');
    }
  }

  async function runLegacyPlanner(text, context, planMsgId) {
    try {
      const startRes = await fetch(`${API_BASE}/api/turn/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, context })
      });
      if (!startRes.ok) {
        throw new Error(await getErrorMessageFromResponse(startRes, 'Errore avvio turn'));
      }
      const startData = await startRes.json();
      currentTurnId = startData.turnId;
      addLog('Turn creato: ' + startData.turnId);
      openEventStream(startData.turnId, planMsgId);
    } catch (err) {
      removeMessage(planMsgId);
      addMessage('Errore avvio turn: ' + err.message, 'error');
      resetAgentPanel();
    }
  }

  async function getErrorMessageFromResponse(response, fallbackMessage) {
    const fallback = fallbackMessage || `Errore HTTP ${response.status}`;

    if (!response) return fallback;

    let payload = null;
    try {
      payload = await response.clone().json();
    } catch (jsonError) {
      try {
        const text = await response.text();
        if (text) {
          if (text.includes('Cannot POST /api/turn/start')) {
            return 'Il taskpane sta parlando con un server statico o non aggiornato. Riavvia il backend corretto con ./start-dev.sh.';
          }
          return `${fallback}: ${text}`;
        }
      } catch (textError) {}
      return fallback;
    }

    const errorMessage = payload?.error || payload?.message || payload?.details;
    if (errorMessage) {
      if (response.status === 404 && String(errorMessage).includes('/api/turn/start')) {
        return 'Endpoint turn/start non trovato. Riavvia il server dell\'add-in per caricare il nuovo runtime agentico.';
      }
      return errorMessage;
    }

    if (response.status === 404) {
      return 'Endpoint richiesto non trovato. Probabilmente il server dell\'add-in non e\' aggiornato.';
    }

    if (response.status === 413) {
      return 'Il contesto Excel inviato e\' troppo grande. Riduci la selezione attiva o riapri il task pane.';
    }

    return fallback;
  }

  function openEventStream(turnId, planMsgId) {
    if (eventSource) { eventSource.close(); }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    let attempt = 0;
    const maxBackoff = 15000;
    let currentSource = null;

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
            currentPlanTasks = data.tasks;
            addMessage(`Piano generato: <strong>${escapeHtml(turnId)}</strong> (${data.tasks.length} task)`, 'bot');
            renderTaskTree(data.tasks);
          }
        } catch (err) {}
      });

      src.addEventListener('turnAwaitingApproval', () => {
        addLog('Piano pronto. In attesa della tua conferma per eseguire.');
        approveBar.classList.remove('hidden');
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
          if (handledActionBatchIds.has(batchId)) {
            return;
          }
          handledActionBatchIds.add(batchId);
          if (data.actions && data.actions.length > 0) {
            addLog(`[${data.taskId}] Eseguo ${data.actions.length} azioni su Excel`);
            enqueueActions(data.actions);
          }
        } catch (err) {}
      });

      src.addEventListener('toolRequest', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.request) {
            queueToolRequest(data.request);
          }
        } catch (err) {}
      });

      src.addEventListener('toolRequestBatch', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.requests && data.requests.length > 0) {
            handleClientToolBatch(data.requests);
          }
        } catch (err) {}
      });

      src.addEventListener('toolRequestResolved', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (activeRequest && data.requestId === activeRequest.id) {
            hideRequestPanel();
            processToolRequests();
          }
        } catch (err) {}
      });

      src.addEventListener('itemCompleted', (e) => {
        try {
          const data = JSON.parse(e.data);
          const item = data.item || {};
          if (item.type === 'taskExecution') {
            if (item.status === 'error') {
              updateTaskStatus(item.taskId, 'error');
              addLog(`[${item.taskId}] ERRORE: ${item.error || 'errore sconosciuto'}`, 'error');
            } else {
              updateTaskStatus(item.taskId, 'completed');
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
          if (data.text) {
            // Show first ~120 chars as a status indicator while LLM generates
            const preview = data.text.length > 120 ? data.text.slice(0, 120) + '...' : data.text;
            if (!planReceived) {
              addLog(`Generazione piano in corso... ${preview}`);
            }
          }
        } catch (err) {}
      });

      src.addEventListener('turnCompleted', (e) => {
        try {
          const data = JSON.parse(e.data);
          removeMessage(planMsgId);
          approveBar.classList.add('hidden');
          if (data.status === 'error' || data.error) {
            addLog(`Esecuzione terminata con errore: ${data.error || 'errore sconosciuto'}`, 'error');
            addMessage(`Esecuzione interrotta: ${escapeHtml(data.error || 'errore sconosciuto')}`, 'error');
          } else {
            addLog('Esecuzione completata.');
            addMessage('Modello completato! Tutti i task sono stati eseguiti su Excel.', 'bot');
          }
          resetRequestState();
          src.close();
          if (currentSource === src) {
            currentSource = null;
            eventSource = null;
          }
        } catch (err) {}
      });

      src.onerror = () => {
        if (currentSource !== src) return;
        addLog('Connessione SSE instabile, tento la riconnessione automatica...', 'error');
        src.close();
        currentSource = null;
        eventSource = null;
        attempt += 1;
        const delay = Math.min(1000 * Math.pow(2, attempt), maxBackoff);
        reconnectTimer = setTimeout(connect, delay);
      };

      src.onopen = () => {
        attempt = 0;
      };
    }

    function connect() {
      if (currentTurnId !== turnId) return;
      currentSource = new EventSource(`${API_BASE}/api/turn/stream/${turnId}`);
      eventSource = currentSource;
      setupListeners(currentSource);
    }

    connect();
  }

  function resetAgentPanel() {
    agentPanel.classList.remove('visible');
    taskTreeEl.innerHTML = '';
    executionLogEl.innerHTML = '';
    approveBar.classList.add('hidden');
    currentTurnId = null;
    currentPlanTasks = null;
    handledActionBatchIds.clear();
    handledRequestIds.clear();
    resetRequestState();
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    closeAgentEventSource();
    currentAgentId = null;
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

    // Cache DOM references for fast updates
    taskTreeCache.clear();
    tasks.forEach(t => {
      taskTreeCache.set(t.id, {
        el: document.getElementById('task-' + t.id),
        icon: document.getElementById('icon-' + t.id)
      });
    });
  }

  function updateTaskStatus(taskId, status, error) {
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
  }

  function flushLogs() {
    logFlushTimer = null;
    logFlushRaf = null;
    if (logBuffer.length === 0) return;
    const fragment = document.createDocumentFragment();
    logBuffer.forEach(({ msg, level }) => {
      const line = document.createElement('div');
      line.className = 'log-entry';
      if (level === 'error') line.classList.add('log-error');
      const time = new Date().toLocaleTimeString();
      line.innerHTML = `<span class="log-time">${time}</span>${escapeHtml(msg)}`;
      fragment.appendChild(line);
    });
    executionLogEl.appendChild(fragment);
    executionLogEl.scrollTop = executionLogEl.scrollHeight;
    logBuffer = [];
  }

  function addLog(msg, level) {
    logBuffer.push({ msg, level });
    if (!logFlushTimer) {
      logFlushTimer = setTimeout(() => {
        if (!logFlushRaf) {
          logFlushRaf = requestAnimationFrame(flushLogs);
        }
      }, 100);
    }
  }

  // -------- Execution & SSE --------

  async function approveTurnExecution(turnId) {
    approveBar.classList.add('hidden');
    addLog('Avvio esecuzione turn ' + turnId);

    const execRes = await fetch(`${API_BASE}/api/turn/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId })
    });
    if (!execRes.ok) {
      addLog('Errore avvio esecuzione', 'error');
      return;
    }
  }

  async function postTurnResponse(turnId, requestId, response) {
    const res = await fetch(`${API_BASE}/api/turn/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId, requestId, response })
    });

    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || 'Errore nella risposta al runtime');
    }
  }

  async function postTurnResponseBatch(turnId, responses) {
    const res = await fetch(`${API_BASE}/api/turn/respond-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId, responses })
    });

    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || 'Errore nella risposta batch al runtime');
    }
  }

  function queueToolRequest(request) {
    if (!request || !request.id || handledRequestIds.has(request.id)) return;
    handledRequestIds.add(request.id);
    requestQueue.push(request);
    processToolRequests();
  }

  async function processToolRequests() {
    if (isProcessingRequestQueue || activeRequest || requestQueue.length === 0) return;
    isProcessingRequestQueue = true;

    try {
      while (!activeRequest && requestQueue.length > 0) {
        const request = requestQueue.shift();
        if (!request) continue;

        if (request.type === 'clientTool') {
          await handleClientToolRequest(request);
          continue;
        }

        if (request.type === 'permission') {
          await showPermissionRequest(request);
          break;
        }

        if (request.type === 'userInput') {
          showUserInputRequest(request);
          break;
        }

        if (request.type === 'question') {
          showQuestionRequest(request);
          break;
        }

        await postTurnResponse(currentTurnId, request.id, {
          error: `Tipo richiesta non supportato: ${request.type}`
        });
      }
    } catch (err) {
      addLog(`Errore gestione richiesta runtime: ${err.message}`, 'error');
      if (activeRequest) {
        try {
          await postTurnResponse(currentTurnId, activeRequest.id, { error: err.message });
        } catch (postErr) {}
        hideRequestPanel();
      }
    } finally {
      isProcessingRequestQueue = false;
      if (!activeRequest && requestQueue.length > 0) {
        setTimeout(processToolRequests, 0);
      }
    }
  }

  function resetRequestState() {
    requestQueue = [];
    activeRequest = null;
    isProcessingRequestQueue = false;
    hideRequestPanel();
  }

  function hideRequestPanel() {
    activeRequest = null;
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
          data = await listNamedRanges();
          break;
        default:
          throw new Error(`Client tool non supportato: ${request.toolName}`);
      }

      await postTurnResponse(currentTurnId, request.id, { data });
      addLog(`[${request.taskId || 'runtime'}] ${request.toolName} completato`);
    } catch (err) {
      await postTurnResponse(currentTurnId, request.id, { error: err.message });
      addLog(`[${request.taskId || 'runtime'}] ${request.toolName} fallito: ${err.message}`, 'error');
    }
  }

  async function handleClientToolBatch(requests) {
    if (!requests || requests.length === 0) return;
    addLog(`Batch clientTool: ${requests.length} richieste`);

    try {
      const results = await Excel.run(async (context) => {
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
                if (p.format === 'csv') {
                  data = await readRangeAsCsv(p);
                } else {
                  data = await readRangeSnapshot(p);
                }
                break;
              }
              case 'workbook.listNamedRanges':
                data = await listNamedRanges();
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
        return outputs;
      });

      await postTurnResponseBatch(currentTurnId, results);
    } catch (err) {
      addLog(`Errore batch clientTool: ${err.message}`, 'error');
      // Fallback: rispondi errore per tutte
      const errorResponses = requests.map(r => ({ requestId: r.id, response: { error: err.message } }));
      try { await postTurnResponseBatch(currentTurnId, errorResponses); } catch (e) {}
    }
  }

  async function showPermissionRequest(request) {
    activeRequest = request;
    requestTitleEl.textContent = request.title || 'Conferma modifiche';
    requestPromptEl.textContent = request.prompt || 'Verifica e approva le modifiche.';

    const previewItems = await buildPermissionPreviewItems(request);
    renderRequestSummary(request, previewItems);
    renderRequestPreview(previewItems);

    requestFormEl.innerHTML = '';
    requestFormEl.classList.add('hidden');
    btnRequestPrimary.textContent = request.confirmLabel || 'Approva';
    btnRequestSecondary.textContent = request.cancelLabel || 'Blocca';
    requestActionsEl.classList.remove('hidden');
    requestPanel.classList.remove('hidden');
    addLog(`[${request.taskId || 'runtime'}] In attesa di conferma modifiche`);
  }

  function showUserInputRequest(request) {
    activeRequest = request;
    requestTitleEl.textContent = request.title || 'Mi serve un input';
    requestPromptEl.textContent = request.prompt || 'Compila i campi richiesti.';
    requestSummaryEl.textContent = '';
    requestSummaryEl.classList.add('hidden');
    requestPreviewListEl.innerHTML = '';
    requestPreviewListEl.classList.add('hidden');
    renderRequestForm(request.fields || []);
    btnRequestPrimary.textContent = request.submitLabel || 'Continua';
    btnRequestSecondary.textContent = request.cancelLabel || 'Annulla';
    requestActionsEl.classList.remove('hidden');
    requestPanel.classList.remove('hidden');
    addLog(`[${request.taskId || 'runtime'}] Input utente richiesto`);
  }

  function renderRequestSummary(request, previewItems) {
    const summary = request.summary || {};
    const parts = [];
    const actionCount = summary.totalActions || (request.actions || []).length || previewItems.length;
    if (actionCount) {
      parts.push(`${actionCount} azioni in anteprima`);
    }
    if (summary.affectedSheets && summary.affectedSheets.length > 0) {
      parts.push(`Fogli: ${summary.affectedSheets.join(', ')}`);
    }
    if (summary.affectedTargets && summary.affectedTargets.length > 0) {
      parts.push(`Range: ${summary.affectedTargets.slice(0, 3).join(', ')}`);
    }

    if (parts.length === 0) {
      requestSummaryEl.textContent = '';
      requestSummaryEl.classList.add('hidden');
      return;
    }

    requestSummaryEl.textContent = parts.join(' • ');
    requestSummaryEl.classList.remove('hidden');
  }

  function renderRequestPreview(previewItems) {
    if (!previewItems || previewItems.length === 0) {
      requestPreviewListEl.innerHTML = '';
      requestPreviewListEl.classList.add('hidden');
      return;
    }

    requestPreviewListEl.innerHTML = previewItems.map(item => {
      const meta = [item.sheet, item.target].filter(Boolean).join(' • ');
      const diffBlock = item.diff ? `<div class="request-preview-diff">${escapeHtml(item.diff)}</div>` : '';
      const valueBlock = !item.diff && item.preview ? `<div class="request-preview-value">${escapeHtml(item.preview)}</div>` : '';
      return `
        <li class="request-preview-item">
          <strong>${escapeHtml(item.label || item.kind || 'Modifica')}</strong>
          ${meta ? `<div class="request-preview-meta">${escapeHtml(meta)}</div>` : ''}
          ${diffBlock}
          ${valueBlock}
        </li>
      `;
    }).join('');
    requestPreviewListEl.classList.remove('hidden');
  }

  function normalizeRequestFields(fields) {
    if (!Array.isArray(fields)) return [];

    return fields.map((field, index) => {
      if (typeof field === 'string') {
        const key = field
          .toLowerCase()
          .replace(/[^a-z0-9]+/gi, '_')
          .replace(/^_+|_+$/g, '') || `field_${index + 1}`;

        return {
          key,
          label: field,
          type: 'text',
          required: true
        };
      }

      if (!field || typeof field !== 'object') {
        return {
          key: `field_${index + 1}`,
          label: `Campo ${index + 1}`,
          type: 'text',
          required: false
        };
      }

      const key = field.key || field.name || `field_${index + 1}`;
      return {
        type: 'text',
        required: false,
        ...field,
        key,
        label: field.label || key
      };
    });
  }

  function renderRequestForm(fields) {
    const normalizedFields = normalizeRequestFields(fields);
    const safeFields = normalizedFields.length > 0
      ? normalizedFields
      : [{ key: 'notes', label: 'Dettagli', type: 'textarea', required: true }];

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
        control = `
          <select data-field-key="${escapeAttr(key)}" ${required}>
            ${options.map(option => {
              const value = typeof option === 'string' ? option : option.value;
              const title = typeof option === 'string' ? option : (option.label || option.value);
              const selected = String(value) === defaultValue ? 'selected' : '';
              return `<option value="${escapeAttr(value)}" ${selected}>${escapeHtml(title)}</option>`;
            }).join('')}
          </select>
        `;
      } else {
        const inputType = type === 'number' ? 'number' : (type === 'boolean' ? 'checkbox' : 'text');
        if (inputType === 'checkbox') {
          const checked = defaultValue === 'true' ? 'checked' : '';
          control = `<input type="checkbox" data-field-key="${escapeAttr(key)}" ${checked}>`;
        } else {
          control = `<input type="${inputType}" data-field-key="${escapeAttr(key)}" value="${escapeAttr(defaultValue)}" placeholder="${placeholder}" ${required}>`;
        }
      }

      return `
        <div class="request-field">
          <label>${escapeHtml(label)}</label>
          ${control}
        </div>
      `;
    }).join('');

    requestFormEl.classList.remove('hidden');
  }

  async function handlePrimaryRequestAction() {
    if (!activeRequest) return;

    const request = activeRequest;
    try {
      if (request.type === 'permission') {
        await postTurnResponse(currentTurnId, request.id, { approved: true });
        addLog(`[${request.taskId || 'runtime'}] Modifiche approvate`);
      } else if (request.type === 'userInput') {
        const values = collectRequestFormValues();
        const missingRequired = normalizeRequestFields(request.fields || [])
          .filter(field => field.required)
          .filter(field => {
            const key = field.key || field.name;
            const value = values[key];
            return value === '' || value == null;
          });

        if (missingRequired.length > 0) {
          addLog(`Compila i campi richiesti: ${missingRequired.map(field => field.label || field.key || field.name).join(', ')}`, 'error');
          return;
        }

        await postTurnResponse(currentTurnId, request.id, { values });
        addLog(`[${request.taskId || 'runtime'}] Input inviato`);
      } else if (request.type === 'question') {
        const questions = request.questions || [];
        const answers = questions.map((q, qIdx) => {
          const selSet = activeQuestionSelections.get(qIdx) || new Set();
          if (q.multiSelect) {
            return Array.from(selSet);
          }
          return Array.from(selSet)[0] || '';
        });
        await postTurnResponse(currentTurnId, request.id, { values: { answers } });
        addLog(`[${request.taskId || 'runtime'}] Risposta inviata`);
      }
      hideRequestPanel();
      processToolRequests();
    } catch (err) {
      addLog(`Errore invio risposta: ${err.message}`, 'error');
    }
  }

  async function handleSecondaryRequestAction() {
    if (!activeRequest) return;

    const request = activeRequest;
    try {
      if (request.type === 'permission') {
        await postTurnResponse(currentTurnId, request.id, {
          approved: false,
          reason: 'Modifiche bloccate dall\'utente'
        });
        addLog(`[${request.taskId || 'runtime'}] Modifiche bloccate`, 'error');
      } else if (request.type === 'userInput') {
        await postTurnResponse(currentTurnId, request.id, {
          error: 'Input annullato dall\'utente'
        });
        addLog(`[${request.taskId || 'runtime'}] Input annullato`, 'error');
      } else if (request.type === 'question') {
        await postTurnResponse(currentTurnId, request.id, {
          error: 'Domanda annullata dall\'utente'
        });
        addLog(`[${request.taskId || 'runtime'}] Domanda annullata`, 'error');
      }
      hideRequestPanel();
      processToolRequests();
    } catch (err) {
      addLog(`Errore invio risposta: ${err.message}`, 'error');
    }
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

  // -------- Helpers messaggi --------

  function addMessage(html, type) {
    const id = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
    const div = document.createElement('div');
    div.id = id;
    div.className = `message ${type}-message`;
    div.innerHTML = `<div class="bubble">${html}</div>`;
    messagesContainer.appendChild(div);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    return id;
  }

  function removeMessage(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }

  function showActionsPreview(actions) {
    actionsList.innerHTML = actions.map(a =>
      `<li><span class="code-block">${a.type}</span> → ${escapeHtml(formatActionTarget(a))}</li>`
    ).join('');
    actionsPreview.classList.remove('hidden');
  }

  function hideActionsPreview() {
    actionsPreview.classList.add('hidden');
  }

  function escapeHtml(text) {
    if (text == null) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttr(text) {
    return escapeHtml(text).replace(/"/g, '&quot;');
  }

  function formatActionTarget(action) {
    const target = action.target || action.name || '';
    if (action.sheet && action.target) {
      return `${action.sheet}!${action.target}`;
    }
    return action.sheet || target;
  }

  function summarizeMatrix(value) {
    if (Array.isArray(value)) {
      const rows = value.length;
      const cols = Array.isArray(value[0]) ? value[0].length : 1;
      const sample = JSON.stringify(value.slice(0, 2)).slice(0, 140);
      return `${rows}x${cols} ${sample}${sample.length >= 140 ? '…' : ''}`;
    }

    if (value == null) return '';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 140 ? `${text.slice(0, 140)}…` : text;
  }

  function isRangeWriteAction(action) {
    return ['setCellValue', 'runFormula', 'fillRange', 'writeRange'].includes(action?.type);
  }

  async function buildPermissionPreviewItems(request) {
    const baseItems = Array.isArray(request.preview) ? request.preview : [];
    const actions = Array.isArray(request.actions) ? request.actions : [];
    const enriched = [];

    for (let index = 0; index < Math.max(baseItems.length, actions.length); index += 1) {
      const item = baseItems[index] || {};
      const action = actions[index] || null;
      enriched.push(await enrichPreviewItem(item, action));
    }

    return enriched;
  }

  async function enrichPreviewItem(item, action) {
    if (!action) return item;

    try {
      if (action.type === 'createSheet') {
        const exists = await worksheetExists(action.name || action.sheet);
        return {
          ...item,
          diff: exists
            ? 'Il foglio esiste gia e verra riutilizzato.'
            : 'Verrà creato un nuovo foglio.'
        };
      }

      if (isRangeWriteAction(action)) {
        const current = await readRangeSnapshot({
          sheet: action.sheet,
          target: action.target
        });
        const nextValue = action.formulas || action.values || action.value;
        return {
          ...item,
          diff: `Attuale: ${summarizeMatrix(current.formulas || current.values)}\nNuovo: ${summarizeMatrix(nextValue)}`
        };
      }
    } catch (err) {
      return {
        ...item,
        diff: `Anteprima limitata: ${err.message}`
      };
    }

    return item;
  }

  // -------- Excel Context --------

  async function getExcelContext() {
    try {
      return await Excel.run(async (context) => {
        const maxPreviewRows = 25;
        const maxPreviewCols = 12;
        const allSheetRows = 15;
        const allSheetCols = 8;

        const worksheets = context.workbook.worksheets;
        worksheets.load('items/name');
        const sheet = context.workbook.worksheets.getActiveWorksheet();
        sheet.load('name');
        const selectedRange = context.workbook.getSelectedRange();
        selectedRange.load('address,rowCount,columnCount,rowIndex,columnIndex');
        const usedRange = sheet.getUsedRangeOrNullObject(true);
        usedRange.load('address,rowCount,columnCount,rowIndex,columnIndex');
        await context.sync();

        const selectionPreviewRange = sheet.getRangeByIndexes(
          selectedRange.rowIndex,
          selectedRange.columnIndex,
          Math.min(selectedRange.rowCount, maxPreviewRows),
          Math.min(selectedRange.columnCount, maxPreviewCols)
        );
        selectionPreviewRange.load('values,formulas');

        const ctx = {
          activeSheet: sheet.name,
          workbookSheets: worksheets.items.map(ws => ws.name),
          selectedRange: selectedRange.address,
          selectedValues: null,
          selectedFormulas: null,
          selectionSize: {
            rows: selectedRange.rowCount,
            columns: selectedRange.columnCount
          }
        };
        if (selectedRange.rowCount > maxPreviewRows || selectedRange.columnCount > maxPreviewCols) {
          ctx.selectedRangeTruncated = true;
        }

        let usedPreviewRange = null;
        if (!usedRange.isNullObject) {
          const maxRows = Math.min(usedRange.rowCount, 50);
          const maxCols = Math.min(usedRange.columnCount, 20);
          usedPreviewRange = sheet.getRangeByIndexes(
            usedRange.rowIndex,
            usedRange.columnIndex,
            maxRows,
            maxCols
          );
          usedPreviewRange.load('values');
          ctx.usedRange = usedRange.address;
          ctx.usedRangeSize = {
            rows: usedRange.rowCount,
            columns: usedRange.columnCount
          };
          if (usedRange.rowCount > maxRows || usedRange.columnCount > maxCols) {
            ctx.usedRangeTruncated = true;
            ctx.totalRows = usedRange.rowCount;
            ctx.totalColumns = usedRange.columnCount;
          }
        }

        // ── NEW: Read ALL sheets in the same roundtrip ──
        const allSheetRefs = [];
        for (const ws of worksheets.items) {
          if (ws.name === sheet.name) continue; // skip active sheet (already captured)
          const ur = ws.getUsedRangeOrNullObject(true);
          ur.load('address,rowCount,columnCount,rowIndex,columnIndex');
          allSheetRefs.push({ ws, ur });
        }

        await context.sync();

        ctx.selectedValues = selectionPreviewRange.values;
        ctx.selectedFormulas = selectionPreviewRange.formulas;
        if (usedPreviewRange) {
          ctx.usedRangeData = usedPreviewRange.values;
        }

        // Load previews for non-active sheets
        const sheetPreviews = [];
        for (const { ws, ur } of allSheetRefs) {
          const info = { name: ws.name, rowCount: 0, colCount: 0, preview: null };
          if (!ur.isNullObject) {
            info.rowCount = ur.rowCount;
            info.colCount = ur.columnCount;
            const previewRange = ws.getRangeByIndexes(
              ur.rowIndex, ur.columnIndex,
              Math.min(ur.rowCount, allSheetRows),
              Math.min(ur.columnCount, allSheetCols)
            );
            previewRange.load('values');
            sheetPreviews.push(previewRange);
          }
          ctx.allSheetsData = ctx.allSheetsData || {};
          ctx.allSheetsData[ws.name] = info;
        }

        await context.sync();

        // Fill in previews
        let pi = 0;
        for (const { ws, ur } of allSheetRefs) {
          if (!ur.isNullObject && pi < sheetPreviews.length) {
            const vals = sheetPreviews[pi].values;
            ctx.allSheetsData[ws.name].preview = vals;
            pi++;
          }
        }

        return ctx;
      });
    } catch (e) {
      return { error: e.message };
    }
  }

  async function worksheetExists(sheetName) {
    if (!sheetName) return false;

    return Excel.run(async (context) => {
      const worksheet = context.workbook.worksheets.getItemOrNullObject(sheetName);
      worksheet.load('name');
      await context.sync();
      return !worksheet.isNullObject;
    });
  }

  async function readWorkbookSnapshot(params) {
    const options = params || {};
    const maxRows = Number(options.maxRows) || 20;
    const maxCols = Number(options.maxCols) || 10;

    return Excel.run(async (context) => {
      const worksheets = context.workbook.worksheets;
      worksheets.load('items/name');
      const activeSheet = context.workbook.worksheets.getActiveWorksheet();
      activeSheet.load('name');
      const selectedRange = context.workbook.getSelectedRange();
      selectedRange.load('address,values,formulas,rowCount,columnCount');
      await context.sync();

      const sheetRefs = worksheets.items.map((sheet) => {
        const usedRange = sheet.getUsedRangeOrNullObject(true);
        usedRange.load('address,rowCount,columnCount,rowIndex,columnIndex');
        return { sheet, usedRange, previewRange: null };
      });
      await context.sync();

      for (const ref of sheetRefs) {
        if (ref.usedRange.isNullObject) continue;
        ref.previewRange = ref.sheet.getRangeByIndexes(
          ref.usedRange.rowIndex,
          ref.usedRange.columnIndex,
          Math.min(ref.usedRange.rowCount, maxRows),
          Math.min(ref.usedRange.columnCount, maxCols)
        );
        ref.previewRange.load('values');
      }
      await context.sync();

      return {
        activeSheet: activeSheet.name,
        workbookSheets: worksheets.items.map(ws => ws.name),
        selectedRange: selectedRange.address,
        selectedValues: selectedRange.values,
        selectedFormulas: selectedRange.formulas,
        sheets: sheetRefs.map(({ sheet, usedRange, previewRange }) => ({
          name: sheet.name,
          usedRange: usedRange.isNullObject ? null : usedRange.address,
          rowCount: usedRange.isNullObject ? 0 : usedRange.rowCount,
          columnCount: usedRange.isNullObject ? 0 : usedRange.columnCount,
          preview: usedRange.isNullObject || !previewRange ? [] : previewRange.values
        }))
      };
    });
  }

  async function readSheetSnapshot(params) {
    const options = params || {};
    const sheetName = options.sheet || options.sheetName;
    const maxRows = Number(options.maxRows) || 30;
    const maxCols = Number(options.maxCols) || 12;

    return Excel.run(async (context) => {
      const worksheet = sheetName
        ? context.workbook.worksheets.getItem(sheetName)
        : context.workbook.worksheets.getActiveWorksheet();
      worksheet.load('name');

      const usedRange = worksheet.getUsedRangeOrNullObject(true);
      usedRange.load('address,rowCount,columnCount,rowIndex,columnIndex');
      await context.sync();

      if (usedRange.isNullObject) {
        return {
          sheet: worksheet.name,
          usedRange: null,
          values: [],
          formulas: [],
          rowCount: 0,
          columnCount: 0
        };
      }

      const previewRange = worksheet.getRangeByIndexes(
        usedRange.rowIndex,
        usedRange.columnIndex,
        Math.min(usedRange.rowCount, maxRows),
        Math.min(usedRange.columnCount, maxCols)
      );
      previewRange.load('values,formulas');
      await context.sync();

      return {
        sheet: worksheet.name,
        usedRange: usedRange.address,
        values: previewRange.values,
        formulas: previewRange.formulas,
        rowCount: usedRange.rowCount,
        columnCount: usedRange.columnCount
      };
    });
  }

  async function readRangeSnapshot(params) {
    const options = params || {};
    const parsedTarget = parseTargetReference(options.target);
    const sheetName = options.sheet || options.sheetName || parsedTarget.sheetName;

    return Excel.run(async (context) => {
      const worksheet = sheetName
        ? context.workbook.worksheets.getItem(sheetName)
        : context.workbook.worksheets.getActiveWorksheet();
      worksheet.load('name');
      let target = parsedTarget.rangeAddress || options.target;
      if (!target) {
        const selectedRange = context.workbook.getSelectedRange();
        selectedRange.load('address');
        await context.sync();
        target = selectedRange.address;
      }

      const range = worksheet.getRange(target);
      range.load('address,values,formulas,rowCount,columnCount,numberFormat');
      await context.sync();

      return {
        sheet: worksheet.name,
        target: target,
        address: range.address,
        values: range.values,
        formulas: range.formulas,
        numberFormat: range.numberFormat,
        rowCount: range.rowCount,
        columnCount: range.columnCount
      };
    });
  }

  async function readRangeAsCsv(params) {
    const options = params || {};
    const parsedTarget = parseTargetReference(options.target);
    const sheetName = options.sheet || options.sheetName || parsedTarget.sheetName;
    const maxRows = Number(options.maxRows) || 500;
    const includeHeaders = options.includeHeaders !== false;

    return Excel.run(async (context) => {
      const worksheet = sheetName
        ? context.workbook.worksheets.getItem(sheetName)
        : context.workbook.worksheets.getActiveWorksheet();
      worksheet.load('name');
      let target = parsedTarget.rangeAddress || options.target;
      if (!target) {
        const selectedRange = context.workbook.getSelectedRange();
        selectedRange.load('address');
        await context.sync();
        target = selectedRange.address;
      }

      const range = worksheet.getRange(target);
      range.load('values,rowCount,columnCount');
      await context.sync();

      const rowsToRead = Math.min(range.rowCount, maxRows);
      let values = range.values;
      if (rowsToRead < range.rowCount) {
        const limitedRange = worksheet.getRange(target).getCell(0, 0).getResizedRange(rowsToRead - 1, range.columnCount - 1);
        limitedRange.load('values');
        await context.sync();
        values = limitedRange.values;
      }

      // Convert to CSV
      const escapeCsv = (val) => {
        if (val == null) return '';
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      };

      let csvRows = values.map(row => row.map(escapeCsv).join(','));
      const csv = csvRows.join('\n');

      return {
        sheet: worksheet.name,
        target: target,
        csv: csv,
        rowCount: rowsToRead,
        columnCount: range.columnCount,
        truncated: rowsToRead < range.rowCount
      };
    });
  }

  async function listNamedRanges() {
    return Excel.run(async (context) => {
      context.workbook.load('names/items');
      await context.sync();
      return context.workbook.names.items.map(n => ({
        name: n.name,
        refersTo: n.refersToRange,
        visible: n.visible
      }));
    });
  }

  // -------- Action Execution Queue (thread-safe for Office.js) --------

  function enqueueActions(actions) {
    if (!actions || actions.length === 0) return;
    excelActionQueue.push(actions);
    processQueue();
  }

  async function processQueue() {
    if (isExecutingQueue) return;
    isExecutingQueue = true;
    while (excelActionQueue.length > 0) {
      const batch = excelActionQueue.shift();
      try {
        showActionsPreview(batch);
        await executeActions(batch);
        hideActionsPreview();
      } catch (err) {
        addLog('Errore azioni Excel: ' + err.message, 'error');
      }
    }
    isExecutingQueue = false;
  }

  // -------- Action Execution (extended) --------

  async function executeActions(actions) {
    if (!actions || actions.length === 0) return;

    return Excel.run(async (context) => {
      const defaultSheet = context.workbook.worksheets.getActiveWorksheet();
      const sheetCache = new Map();

      // Pre-resolve all referenced sheets in one round-trip
      const sheetNames = new Set();
      for (const action of actions) {
        const parsedTarget = parseTargetReference(action.target);
        const explicitSheet = action.sheet || action.sheetName || parsedTarget.sheetName;
        if (explicitSheet) sheetNames.add(explicitSheet);
      }
      if (sheetNames.size > 0) {
        const sheetProxies = [];
        for (const name of sheetNames) {
          const proxy = context.workbook.worksheets.getItemOrNullObject(name);
          proxy.load('name');
          sheetProxies.push({ name, proxy });
        }
        await context.sync();
        for (const { name, proxy } of sheetProxies) {
          if (!proxy.isNullObject) {
            sheetCache.set(name, proxy);
          }
        }
      }

      for (const action of actions) {
        try {
          switch (action.type) {
            case 'setCellValue':
              await execSetCellValue(context, sheetCache, defaultSheet, action);
              break;
            case 'runFormula':
              await execRunFormula(context, sheetCache, defaultSheet, action);
              break;
            case 'setCellFormat':
              await execSetCellFormat(context, sheetCache, defaultSheet, action);
              break;
            case 'fillRange':
              await execFillRange(context, sheetCache, defaultSheet, action);
              break;
            case 'writeRange':
              await execWriteRange(context, sheetCache, defaultSheet, action);
              break;
            case 'setCellRange':
              await execSetCellRange(context, sheetCache, defaultSheet, action);
              break;
            case 'createChart':
              await execCreateChart(context, sheetCache, defaultSheet, action);
              break;
            case 'createSheet':
              await execCreateSheet(context, sheetCache, action);
              break;
            case 'renameSheet':
              await execRenameSheet(context, sheetCache, action);
              break;
            case 'deleteSheet':
              await execDeleteSheet(context, sheetCache, action);
              break;
            case 'duplicateSheet':
              await execDuplicateSheet(context, sheetCache, action);
              break;
            case 'copyRange':
              await execCopyRange(context, sheetCache, action);
              break;
            case 'createNamedRange':
              await execCreateNamedRange(context, sheetCache, action);
              break;
            case 'suspendCalculation':
              context.application.calculationMode = Excel.CalculationMode.manual;
              console.log('[Excel] Calculation suspended (manual mode)');
              break;
            case 'resumeCalculation':
              context.application.calculationMode = Excel.CalculationMode.automatic;
              console.log('[Excel] Calculation resumed (automatic mode)');
              break;
            case 'todoWrite':
              updateStepsPanel(action.todos);
              break;
            default:
              console.warn('Azione non supportata:', action.type);
          }
        } catch (actionErr) {
          console.error('Errore azione', action.type, actionErr);
          const detail = actionErr && actionErr.message ? actionErr.message : String(actionErr);
          const where = action.sheet ? ` (sheet=${action.sheet})` : '';
          addLog(`Azione ${action.type} fallita${where}: ${detail}`, 'error');
        }
      }

      await context.sync();
    });
  }

  function parseTargetReference(target) {
    if (typeof target !== 'string') return { rangeAddress: target };
    const match = target.match(/^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/);
    if (!match) return { rangeAddress: target };
    return {
      sheetName: (match[1] || match[2] || '').replace(/''/g, "'"),
      rangeAddress: match[3]
    };
  }

  async function ensureWorksheet(context, sheetCache, sheetName, options) {
    const opts = options || {};
    if (!sheetName) return null;
    if (sheetCache.has(sheetName)) return sheetCache.get(sheetName);

    // Probe first: covers cases where pre-resolution missed the sheet
    const probe = context.workbook.worksheets.getItemOrNullObject(sheetName);
    probe.load('name');
    await context.sync();
    if (!probe.isNullObject) {
      sheetCache.set(sheetName, probe);
      return probe;
    }

    if (!opts.createIfMissing) {
      throw new Error(`Foglio non trovato: ${sheetName}`);
    }

    try {
      const createdSheet = context.workbook.worksheets.add(sheetName);
      sheetCache.set(sheetName, createdSheet);
      await context.sync();
      return createdSheet;
    } catch (err) {
      // Race: sheet got created between probe and add. Retry with get.
      const existing = context.workbook.worksheets.getItem(sheetName);
      sheetCache.set(sheetName, existing);
      return existing;
    }
  }

  async function resolveSheetAndTarget(context, sheetCache, defaultSheet, action) {
    const parsedTarget = parseTargetReference(action.target);
    const explicitSheet = action.sheet || action.sheetName || parsedTarget.sheetName;
    const sheet = explicitSheet
      ? await ensureWorksheet(context, sheetCache, explicitSheet)
      : defaultSheet;
    return {
      sheet,
      target: parsedTarget.rangeAddress || action.target
    };
  }

  async function execSetCellValue(context, sheetCache, defaultSheet, action) {
    const { sheet, target } = await resolveSheetAndTarget(context, sheetCache, defaultSheet, action);
    const range = sheet.getRange(target);
    if (typeof action.value === 'string' && action.value.startsWith('=')) {
      range.formulas = [[action.value]];
    } else {
      range.values = [[action.value]];
    }
  }

  async function execRunFormula(context, sheetCache, defaultSheet, action) {
    const { sheet, target } = await resolveSheetAndTarget(context, sheetCache, defaultSheet, action);
    const range = sheet.getRange(target);
    range.formulas = [[action.value]];
  }

  async function execSetCellFormat(context, sheetCache, defaultSheet, action) {
    const { sheet, target } = await resolveSheetAndTarget(context, sheetCache, defaultSheet, action);
    const range = sheet.getRange(target);
    const fmt = action.options || {};
    if (fmt.backgroundColor) range.format.fill.color = fmt.backgroundColor;
    if (fmt.fontColor) range.format.font.color = fmt.fontColor;
    if (fmt.bold !== undefined) range.format.font.bold = fmt.bold;
    if (fmt.italic !== undefined) range.format.font.italic = fmt.italic;
    if (fmt.numberFormat) range.numberFormat = [[fmt.numberFormat]];
    if (fmt.horizontalAlignment) range.format.horizontalAlignment = fmt.horizontalAlignment;
  }

  async function execFillRange(context, sheetCache, defaultSheet, action) {
    const { sheet, target } = await resolveSheetAndTarget(context, sheetCache, defaultSheet, action);
    const range = sheet.getRange(target);
    if (Array.isArray(action.value)) {
      range.values = action.value;
    } else {
      range.values = [[action.value]];
    }
  }

  async function execWriteRange(context, sheetCache, defaultSheet, action) {
    const { sheet, target } = await resolveSheetAndTarget(context, sheetCache, defaultSheet, action);
    const range = sheet.getRange(target);

    if (Array.isArray(action.formulas)) {
      range.formulas = action.formulas;
      return;
    }

    if (Array.isArray(action.values)) {
      range.values = action.values;
      return;
    }

    if (typeof action.value === 'string' && action.value.startsWith('=')) {
      range.formulas = [[action.value]];
      return;
    }

    range.values = [[action.value]];
  }

  async function execSetCellRange(context, sheetCache, defaultSheet, action) {
    const sheetName = action.sheet || (await getActiveSheetName(context));
    const sheet = await ensureWorksheet(context, sheetCache, sheetName, { createIfMissing: true });
    const cells = action.cells || {};
    const copyToRange = action.copyToRange;
    const allowOverwrite = action.allow_overwrite !== false; // default true for now

    // Collect all cell addresses
    const addresses = Object.keys(cells);
    if (addresses.length === 0 && !copyToRange) return;

    // Overwrite protection: if allow_overwrite is false, check if any cell is non-empty
    if (!allowOverwrite && addresses.length > 0) {
      const rangesToCheck = addresses.map(addr => sheet.getRange(addr));
      rangesToCheck.forEach(r => r.load('values'));
      await context.sync();
      const nonEmpty = addresses.filter((addr, i) => {
        const val = rangesToCheck[i].values[0][0];
        return val !== '' && val !== null && val !== undefined;
      });
      if (nonEmpty.length > 0) {
        throw new Error(`Would overwrite ${nonEmpty.length} non-empty cell(s): ${nonEmpty.slice(0, 5).join(', ')}. Retry with allow_overwrite=true.`);
      }
    }

    // Group cells by row for batching when contiguous
    // For simplicity, write each cell individually
    for (const [addr, spec] of Object.entries(cells)) {
      const cell = sheet.getRange(addr);
      if (spec.formula) {
        cell.formulas = [[spec.formula]];
      } else if (spec.value !== undefined) {
        cell.values = [[spec.value]];
      }
      if (spec.note) {
        cell.comments.add(spec.note);
      }
      if (spec.cellStyles) {
        const fmt = spec.cellStyles;
        if (fmt.fontColor) cell.format.font.color = fmt.fontColor;
        if (fmt.backgroundColor) cell.format.fill.color = fmt.backgroundColor;
        if (fmt.bold !== undefined) cell.format.font.bold = fmt.bold;
        if (fmt.numberFormat) cell.numberFormat = [[fmt.numberFormat]];
      }
    }

    // Activate target sheet so user sees the writes
    try { sheet.activate(); } catch (_) {}

    // Handle copyToRange
    if (copyToRange && addresses.length > 0) {
      const firstAddr = addresses[0];
      const firstCell = sheet.getRange(firstAddr);
      const destRange = sheet.getRange(copyToRange);
      destRange.copyFrom(firstCell, Excel.RangeCopyType.all);
    }

    await context.sync();
  }

  async function getActiveSheetName(context) {
    const sheet = context.workbook.worksheets.getActiveWorksheet();
    sheet.load('name');
    await context.sync();
    return sheet.name;
  }

  async function execCreateChart(context, sheetCache, defaultSheet, action) {
    const { sheet, target } = await resolveSheetAndTarget(context, sheetCache, defaultSheet, action);
    const dataRange = sheet.getRange(target);
    const opts = action.options || {};
    const chartType = opts.chartType || 'ColumnClustered';
    const chart = sheet.charts.add(Excel.ChartType[chartType] || Excel.ChartType.columnClustered, dataRange, 'Auto');
    if (opts.title) chart.title.text = opts.title;
    chart.setPosition("A15", "E30");
  }

  async function execConditionalFormat(context, sheetCache, defaultSheet, action) {
    const { sheet, target } = await resolveSheetAndTarget(context, sheetCache, defaultSheet, action);
    const range = sheet.getRange(target);
    const opts = action.options || {};
    const rule = opts.rule || 'greaterThan';
    const value = opts.value !== undefined ? opts.value : 0;
    const cf = range.conditionalFormats.add(Excel.ConditionalFormatType.cellValue);
    cf.cellValue.format.fill.color = opts.backgroundColor || '#FF0000';
    if (opts.fontColor) cf.cellValue.format.font.color = opts.fontColor;

    const ruleMap = {
      greaterThan: 'greaterThan', lessThan: 'lessThan', equalTo: 'equalTo',
      greaterThanOrEqual: 'greaterThanOrEqual', lessThanOrEqual: 'lessThanOrEqual',
      notEqualTo: 'notEqualTo', between: 'between'
    };
    const operator = ruleMap[rule] || 'greaterThan';

    if (operator === 'between' && opts.value2 !== undefined) {
      cf.cellValue.rule = { formula1: String(value), formula2: String(opts.value2), operator: Excel.ConditionalCellValueOperator[operator] };
    } else {
      cf.cellValue.rule = { formula1: String(value), operator: Excel.ConditionalCellValueOperator[operator] };
    }
  }

  async function execCreateSheet(context, sheetCache, action) {
    const name = action.name || action.sheet || 'NuovoFoglio';
    await ensureWorksheet(context, sheetCache, name, { createIfMissing: true });
  }

  async function execRenameSheet(context, sheetCache, action) {
    const oldName = action.oldName || action.name;
    const newName = action.newName || action.to;
    if (!oldName || !newName) throw new Error('renameSheet requires oldName and newName');
    const sheet = await ensureWorksheet(context, sheetCache, oldName);
    sheet.name = newName;
    sheetCache.delete(oldName);
    sheetCache.set(newName, sheet);
  }

  async function execDeleteSheet(context, sheetCache, action) {
    const name = action.name || action.sheet;
    if (!name) throw new Error('deleteSheet requires name');
    const sheet = await ensureWorksheet(context, sheetCache, name);
    sheet.delete();
    sheetCache.delete(name);
  }

  async function execDuplicateSheet(context, sheetCache, action) {
    const sourceName = action.source || action.name;
    const newName = action.newName || sourceName + ' (copy)';
    if (!sourceName) throw new Error('duplicateSheet requires source name');
    const source = await ensureWorksheet(context, sheetCache, sourceName);
    source.copy(null).name = newName;
  }

  async function execCopyRange(context, sheetCache, action) {
    const fromSheetName = action.fromSheet || action.sheet;
    const toSheetName = action.toSheet || action.fromSheet;
    const fromRange = action.from || action.target;
    const toRange = action.to || action.from;
    if (!fromRange || !toRange) throw new Error('copyRange requires from and to addresses');
    const fromSheet = await ensureWorksheet(context, sheetCache, fromSheetName);
    const toSheet = await ensureWorksheet(context, sheetCache, toSheetName, { createIfMissing: true });
    const srcRange = fromSheet.getRange(fromRange);
    const dstRange = toSheet.getRange(toRange);
    srcRange.copyTo(dstRange);
  }

  async function execCreateNamedRange(context, sheetCache, action) {
    const name = action.name || action.ref;
    const refersTo = action.refersTo || `=${action.sheet}!${action.target}`;
    if (!name) throw new Error('createNamedRange requires a name');
    context.workbook.names.add(name, refersTo);
  }

  // -------- Undo / Redo --------

  async function handleUndo() {
    try {
      await Excel.run(async (context) => {
        context.workbook.undo();
        await context.sync();
      });
      addLog('Undo eseguito');
    } catch (err) {
      addLog('Undo fallito: ' + err.message, 'error');
    }
  }

  async function handleRedo() {
    try {
      await Excel.run(async (context) => {
        context.workbook.redo();
        await context.sync();
      });
      addLog('Redo eseguito');
    } catch (err) {
      addLog('Redo fallito: ' + err.message, 'error');
    }
  }

  function showChatQuestionOptions(questions, agentId) {
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
    if (!msgEl || !agentId) return;

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
      addLog(`Utente ha risposto: ${label}`);
      addMessage(`Risposta: ${escapeHtml(label)}`, 'user');
    }

    // Handle button clicks (options)
    bubble.querySelectorAll('.chat-question-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const label = btn.dataset.label;
        showSelected(label);
        resumeAgentWithResponse(agentId, label);
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
        resumeAgentWithResponse(agentId, value);
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

  // -------- Steps Panel (todo_write) --------

  function updateStepsPanel(todos) {
    if (!todos || todos.length === 0) return;
    const panel = document.getElementById('steps-panel');
    const list = document.getElementById('steps-list');
    panel.classList.remove('hidden');
    panel.classList.add('visible');

    list.innerHTML = todos.map(todo => {
      const statusIcon = {
        pending: '○',
        in_progress: '◐',
        completed: '✓',
        cancelled: '✕'
      }[todo.status] || '○';

      return `
        <div class="step-item ${todo.status}">
          <span class="step-icon">${statusIcon}</span>
          <span class="step-content">${escapeHtml(todo.content)}</span>
          <span class="step-priority priority-${todo.priority || 'medium'}">${todo.priority || 'medium'}</span>
        </div>
      `;
    }).join('');
  }

  // -------- Ask User Question (tappable options) --------

  function showQuestionRequest(request) {
    activeRequest = request;
    activeQuestionSelections = new Map();
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
      qHeader.style.fontSize = '12px';
      qHeader.style.fontWeight = '600';
      qHeader.style.color = '#243b53';
      qHeader.style.marginBottom = '6px';
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
            // Single select: deselect others in same question
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

    btnRequestPrimary.textContent = 'Conferma';
    btnRequestSecondary.textContent = 'Annulla';
    requestActionsEl.classList.remove('hidden');
    requestPanel.classList.remove('hidden');
    addLog(`[${request.taskId || 'runtime'}] Domanda multi-scelta in attesa`);
  }

  // -------- Code Transparency Panel --------

  function createCodePanel() {
    const panel = document.createElement('div');
    panel.id = 'code-panel';
    panel.className = 'code-panel';
    const app = document.getElementById('app');
    app.insertBefore(panel, document.getElementById('input-area'));
    return panel;
  }

})();
