'use strict';

const state = {
  isProcessing: false,
  currentTurnId: null,
  currentPlanTasks: null,
  currentAgentId: null,
  eventSource: null,
  agentEventSource: null,
  requestQueue: [],
  activeRequest: null,
  isProcessingRequestQueue: false,
  handledActionBatchIds: new Set(),
  handledRequestIds: new Set(),
  taskTreeCache: new Map(),
  activeQuestionSelections: new Map(),
  excelActionQueue: [],
  isExecutingQueue: false,
  logBuffer: [],
  logFlushTimer: null,
  logFlushRaf: null,
  turnStartTime: null,
  elapsedTimer: null,
  undoStack: [], // Stack of mutation snapshots for client-side undo
  isAgentPaused: false, // True when agent is waiting for user response
  pausedAgentId: null, // AgentId of the paused agent (for resume)
};

export default state;
