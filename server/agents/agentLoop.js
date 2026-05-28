const fs = require('fs');
const path = require('path');
const { callLLM, callLLMStreaming, getLLMConfig } = require('../tools/llm');
const logger = require('../utils/logger');
const { executeTool, registry } = require('../tools/registry');
const SHARED_SCHEMAS = require('../tools/schemas');
const { validateTaskOutput } = require('./critic');
const streaming = require('./streaming');
const { initializeTools } = require('../utils/toolSearch');
const { detectSkills } = require('../utils/skillSuggest');
const clientReadCache = require('../utils/clientReadCache');

// Tools that mutate the workbook. After any of these runs, the per-agent
// workbook-read cache must be invalidated so the next read sees fresh state.
const MUTATION_TOOLS = new Set([
  'set_cell_range',
  'execute_office_js',
  'execute_python',
  'create_sheet',
  'rename_sheet',
  'delete_sheet',
  'duplicate_sheet',
  'copy_range',
  'create_named_range',
  'execute_excel_formula',
  'set_format',
  'add_chart',
  'suspend_calculation',
  'resume_calculation'
]);

const AGENT_REASONING_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT_AGENT || 'high';
const AGENT_THINKING_FIRST_ITER = process.env.AGENT_THINKING_FIRST_ITER !== 'false';
const AGENT_THINKING_EVERY_ITER = process.env.AGENT_THINKING_EVERY_ITER === 'true';
const AGENT_THINKING_INTERVAL = Math.max(2, Number(process.env.AGENT_THINKING_INTERVAL) || 6);
const AGENT_FORCE_THINKING_AFTER_ERROR = process.env.AGENT_FORCE_THINKING_AFTER_ERROR !== 'false';
const AGENT_USE_STREAMING = process.env.AGENT_USE_STREAMING !== 'false';
const AGENT_LOOP_FAST_MODEL = process.env.AGENT_LOOP_FAST_MODEL || process.env.DEEPSEEK_FALLBACK_MODEL || 'deepseek-v4-flash';
const AGENT_LOOP_DEFAULT_MODEL = process.env.AGENT_LOOP_MODEL || process.env.DEEPSEEK_FALLBACK_MODEL || 'deepseek-v4-flash';
const STAGNATION_WATCH_TOOLS = new Set([
  'read_workbook',
  'read_sheet',
  'get_range_as_csv',
  'get_cell_ranges',
  'build_workbook_graph',
  'execute_office_js'
]);
const STAGNATION_MAX_REPEAT = Math.max(3, Number(process.env.AGENT_STAGNATION_MAX_REPEAT) || 4);
const STAGNATION_ALT_CYCLES = Math.max(2, Number(process.env.AGENT_STAGNATION_ALT_CYCLES) || 3);
const STAGNATION_MAX_TRAIL = Math.max(8, (STAGNATION_ALT_CYCLES * 2) + 2);

function resolveAgentLoopModel(modelOverride, promptVariant) {
  if (modelOverride) return modelOverride;
  if (promptVariant === 'fast') return AGENT_LOOP_FAST_MODEL;
  return AGENT_LOOP_DEFAULT_MODEL;
}

function shouldUseAgentThinking(iteration, state = {}) {
  if (AGENT_THINKING_EVERY_ITER) return true;
  if (state.forceThinkingNext) return true;
  if (AGENT_THINKING_FIRST_ITER && iteration === 1) return true;
  if (AGENT_THINKING_INTERVAL > 0 && iteration % AGENT_THINKING_INTERVAL === 0) return true;
  if (AGENT_FORCE_THINKING_AFTER_ERROR && ((state.consecutiveErrors || 0) > 0 || (state.parseFailureStreak || 0) > 0)) {
    return true;
  }
  return false;
}

function normalizeOpenBBSymbolParams(params = {}) {
  if (!params || typeof params !== 'object') return params;
  if (params.symbol || !params.ticker) return params;
  const next = { ...params, symbol: params.ticker };
  delete next.ticker;
  return next;
}

/* ---------- Message ID helpers for context_snip targeting ---------- */
function generateMsgId() {
  return Math.random().toString(36).slice(2, 8).toLowerCase();
}
function makeUserMessage(content) {
  const id = generateMsgId();
  return { role: 'user', content: `[id:${id}] ${content}` };
}
function extractMsgId(content) {
  const m = String(content).match(/^\[id:([a-z0-9]{6})\]\s*/);
  return m ? m[1] : null;
}
function stripMsgId(content) {
  return String(content).replace(/^\[id:[a-z0-9]{6}\]\s*/, '');
}

/* ---------- Snipped content store (global, per-process) ---------- */
const snippedStore = new Map(); // key: "from_id:to_id" -> { summary, content, timestamp }
const MAX_SNIP_AGE_MS = 30 * 60 * 1000; // 30 min

function cleanupOldSnips() {
  const now = Date.now();
  for (const [key, entry] of snippedStore.entries()) {
    if (now - entry.timestamp > MAX_SNIP_AGE_MS) {
      snippedStore.delete(key);
    }
  }
}

function snipContext(messages, fromId, toId, summary) {
  const indices = [];
  let fromIdx = -1;
  let toIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const id = extractMsgId(messages[i].content);
    if (id === fromId) fromIdx = i;
    if (id === toId) toIdx = i;
  }
  if (fromIdx === -1 || toIdx === -1 || fromIdx > toIdx) {
    return { ok: false, error: `IDs not found or invalid range: ${fromId} -> ${toId}` };
  }
  const snippedContent = messages.slice(fromIdx, toIdx + 1)
    .map(m => `[${m.role}] ${stripMsgId(m.content || '')}`)
    .join('\n');
  const key = `${fromId}:${toId}`;
  snippedStore.set(key, { summary, content: snippedContent, timestamp: Date.now() });
  // Replace snipped range with placeholder
  const placeholder = makeUserMessage(`[snipped: ${summary}] (use retrieve_snipped to expand)`);
  const newMessages = [
    ...messages.slice(0, fromIdx),
    placeholder,
    ...messages.slice(toIdx + 1)
  ];
  messages.length = 0;
  messages.push(...newMessages);
  return { ok: true, removed: toIdx - fromIdx + 1, key };
}

function retrieveSnipped(fromId, search, maxChars = 4000) {
  cleanupOldSnips();
  const results = [];
  for (const [key, entry] of snippedStore.entries()) {
    if (fromId && !key.startsWith(fromId)) continue;
    if (!search || entry.content.toLowerCase().includes(search.toLowerCase()) || entry.summary.toLowerCase().includes(search.toLowerCase())) {
      results.push({ key, summary: entry.summary, content: entry.content.slice(0, maxChars) });
    }
  }
  if (results.length === 0) {
    return { found: false, message: `No snipped content found${search ? ` for "${search}"` : ''}` };
  }
  return { found: true, count: results.length, results };
}

/* ---------- Load System Prompt from file (variant-aware) ---------- */
const PROMPT_VARIANTS = {
  default: 'system-prompt-ib-grade.md',
  fast: 'system-prompt-ib-fast.md',
  analyst: 'system-prompt-analyst.md',
  copilot: 'system-prompt-copilot.md'
};
const PROMPT_CACHE = {};

function loadPromptVariant(variant) {
  if (PROMPT_CACHE[variant]) return PROMPT_CACHE[variant];
  const file = PROMPT_VARIANTS[variant] || PROMPT_VARIANTS.default;
  const filePath = path.join(__dirname, '..', '..', 'docs', file);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    logger.info(`[AgentLoop] Loaded prompt variant "${variant}" from ${filePath} (${content.length} chars)`);
    PROMPT_CACHE[variant] = content;
    return content;
  } catch (e) {
    logger.warn(`[AgentLoop] Could not load prompt "${variant}": ${e.message}. Falling back to inline.`);
    return `You are an expert analyst and spreadsheet builder embedded directly in Microsoft Excel.`;
  }
}

const { getAvailableSkillsForPrompt, readSkill } = require('../skills/loader');
const { updateInstructions, getInstructionsForPrompt } = require('../utils/instructions');

const DEFAULT_PROMPT_VARIANT = process.env.AGENT_PROMPT_VARIANT || 'default';
let AGENT_SYSTEM_PROMPT = loadPromptVariant(DEFAULT_PROMPT_VARIANT);

/* Common output format suffix appended to ANY variant */
const AGENT_SYSTEM_PROMPT_SUFFIX = `\n\n---\n\nOUTPUT FORMAT: Respond with a JSON object containing:\n{\n  "thought": "Your reasoning about what to do next",\n  "tool": "tool_name",\n  "params": { ...tool parameters... }\n}\n\nIMPORTANT: Call exactly one tool per response. The only way to do multiple things in one iteration is the parallel_calls tool, which fans out up to 8 INDEPENDENT read-only calls (reads, OpenBB fetches, bundles) in parallel. Use parallel_calls whenever you would otherwise emit multiple consecutive read-only tool calls — it cuts those N iterations down to 1. Mutations and writes still run sequentially, one per iteration.\n\nEXCEL AGENT WORKFLOW:\n- For complex workbook work, inspect the workbook first, build_workbook_graph for multi-sheet dependency context, create a brief task list, then execute in small visible chunks.\n- Prefer set_cell_range for each logical section instead of many single-cell writes.\n- After important writes, verify touched ranges or formulas before calling done.\n- Report only changes you actually made and checked, with sheet names and ranges.\n- Use allow_overwrite:false when exploring a new range. Use allow_overwrite:true only when the user asked to replace or the target sheet was just created by you.\n\nWHEN THE TASK IS COMPLETE: You MUST call the tool "done" with a summary. Do NOT keep calling other tools after the work is finished. Calling "done" ends the session.\n\nPYTHON RULES:\n- execute_python is ONLY for mathematical calculations on data provided as variables in the code string.\n- execute_python does NOT have access to the Excel workbook file system. Do NOT use openpyxl, xlrd, or any file paths like /tmp/current.xlsx, /files/input/workbook.xlsx, etc.\n- To read or write Excel, always use the dedicated Excel tools (set_cell_range, create_sheet, execute_excel_formula, etc.).\n\nDATA RULES:\n- For public-company valuation work, use available finance tools first (OpenBB/Yahoo, treasury/macro tools when relevant), then visible workbook data.\n- Do not invent live market data. If a value is from training memory or a heuristic, label it as an assumption in the workbook.\n- Add short notes/comments for externally sourced input cells when the write tool supports notes.\n- Search/fetch the web only when the user asks for current source material or when a required data point is unavailable from the provided finance tools.\n\nASK_USER_QUESTION RULES (CRITICAL):\n- The tool ask_user_question is an EMERGENCY BREAK. Use it ONLY when a truly critical piece of information is missing AND cannot be inferred from the workbook context or the user's original request.\n- NEVER ask the user for confirmation before proceeding (e.g. "Should I proceed?", "Continue?", "Go ahead?"). Just DO the work.\n- NEVER ask which sheet to use — the active sheet is provided in the context. If unspecified, default to the active sheet.\n- NEVER ask for a ticker/company name if the user already mentioned it in the original request.\n- NEVER ask for data that is already visible in the workbook context preview. Reference those cells directly.\n- If you are unsure about a minor assumption, make a reasonable default choice and proceed. Do NOT pause the flow.

CITATION RULES:
- Every action explanation MUST include a citation in the format: [A1:D1](<citation:SheetName!A1:D1>)
- Citations help the user trust and verify every change.

BULK WRITE RULES:
- Prefer autoFill and copyFrom over writing cells one-by-one in loops.
- Example: write formula to C2, then autoFill C2:C100 instead of 99 separate set_cell_range calls.
- For bulk formulas, use execute_office_js with calculationMode=manual.

INDUSTRY ADD-IN FORMULAS (use when user mentions Bloomberg, CapIQ, Refinitiv):
- Bloomberg BDH: =BDH("AAPL US Equity","PX_LAST","20240101","20241231")
- Bloomberg BDP: =BDP("AAPL US Equity","PX_LAST")
- CapIQ CIQ: =CIQ("AAPL","IQ_TOTAL_REV")
- Refinitiv TR: =TR("AAPL.O","TR.Revenue")

LIVE DATA POLICY:
- API/tool calls are cheap compared with wrong spreadsheet analysis. When a requested fact, market input, company figure, regulation, management detail, pricing, filing, rate, benchmark, or news item could have changed, verify it with external tools before writing assumptions or formulas.
- Prefer structured finance tools for standardized market and statement data, and use web_search/web_fetch to cross-check, find source documents, current news, investor pages, filings, and any data point the finance tools do not clearly cover.
- Use training memory only for stable concepts, formulas, and modeling methodology. Do not use it as the source for current facts.
- If sources disagree, prefer official filings, company investor relations, central-bank/government/statistical sources, exchange data, or major data providers, and note the chosen source in the workbook when possible.

SKILLS RULES:
- <available_skills> are listed at the top of this prompt.
- BEFORE starting a complex task (DCF, LBO, comps, 3-statement, audit), call read_skill to load the relevant skill instructions.
- NEVER load more than 2 skills per task.
- After loading a skill, follow its structure and formulas exactly.

LIMITATIONS — What You Cannot Do:
- You cannot execute VBA macros.
- You cannot download files from the internet to the user's disk.
- You cannot access external APIs or websites except through the provided tools.
- You cannot create PivotTables or Power Query connections (not yet supported).`;

const ACTIVE_AGENT_SYSTEM_PROMPT_SUFFIX = AGENT_SYSTEM_PROMPT_SUFFIX.replace(
  '- Search/fetch the web only when the user asks for current source material or when a required data point is unavailable from the provided finance tools.',
  '- Search/fetch the web whenever current source material can improve accuracy, especially for mutable market, company, regulatory, pricing, filing, rate, benchmark, or news inputs.'
);

AGENT_SYSTEM_PROMPT += ACTIVE_AGENT_SYSTEM_PROMPT_SUFFIX;

function getSystemPrompt(variant) {
  const v = variant || DEFAULT_PROMPT_VARIANT;
  const base = loadPromptVariant(v);
  const skillsBlock = getAvailableSkillsForPrompt();
  const instructionsBlock = getInstructionsForPrompt();
  // Prepend available skills to the prompt (lightweight index, not full content)
  const skillsPrefix = skillsBlock ? skillsBlock + '\n\n' : '';
  const instructionsPrefix = instructionsBlock ? instructionsBlock + '\n\n' : '';
  return skillsPrefix + instructionsPrefix + base + ACTIVE_AGENT_SYSTEM_PROMPT_SUFFIX;
}

/* ---------- Tool Definitions (OpenAI function calling schema) ---------- */

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_workbook',
      description: 'Read the current Excel workbook structure and data. Returns the already-captured workbook context.',
      parameters: {
        type: 'object',
        properties: {
          maxRows: { type: 'number', description: 'Max rows to read per sheet' },
          maxCols: { type: 'number', description: 'Max cols to read per sheet' },
          includeFormulas: { type: 'boolean', description: 'Include formulas in each sheet preview (default true)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'build_workbook_graph',
      description: 'Build a semantic WorkbookGraph for the current workbook: sheet roles, detected tables, formulas, cross-sheet dependencies, Excel errors and financial objects. Use before audits, repairs, model completion and multi-sheet analysis.',
      parameters: {
        type: 'object',
        properties: {
          maxRows: { type: 'number', description: 'Max rows to scan per sheet' },
          maxCols: { type: 'number', description: 'Max cols to scan per sheet' },
          workbookName: { type: 'string', description: 'Optional workbook label' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_sheet',
      description: 'Read a specific Excel sheet',
      parameters: {
        type: 'object',
        properties: {
          sheet: { type: 'string', description: 'Sheet name' },
          maxRows: { type: 'number' },
          maxCols: { type: 'number' }
        },
        required: ['sheet']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_cell_ranges',
      description: 'Read specific cell ranges (values, formulas, formatting) across multiple sheets. Supports batch multi-range read in one call. Use this to read scattered data (e.g., headers and totals) efficiently.\n\nExample:\n{\n  "ranges": [\n    { "sheet": "SINTECO_S_R_L", "target": "A1:H1" },\n    { "sheet": "SINTECO_S_R_L", "target": "A1112:H1114" }\n  ]\n}',
      parameters: {
        type: 'object',
        properties: {
          ranges: {
            type: 'array',
            description: 'Array of range specs to read',
            items: {
              type: 'object',
              properties: {
                sheet: { type: 'string', description: 'Sheet name' },
                target: { type: 'string', description: 'Range in A1 notation (e.g. "A1:H100")' },
                maxRows: { type: 'number', description: 'Max rows per range (default 100)' }
              },
              required: ['sheet', 'target']
            }
          }
        },
        required: ['ranges']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_range_as_csv',
      description: 'Read a range as CSV string for pandas analysis. Preferred for large data. Set maxRows if you only need a preview (e.g. 100 for inspection). Omit maxRows to read ALL rows in the range.',
      parameters: {
        type: 'object',
        properties: {
          sheet: { type: 'string', description: 'Sheet name' },
          target: { type: 'string', description: 'Range (e.g. A1:D100)' },
          maxRows: { type: 'number', description: 'Max rows to return (omit to read ALL rows)' },
          includeHeaders: { type: 'boolean', description: 'Include header row' }
        },
        required: ['sheet', 'target']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_sheet',
      description: 'Create a new Excel sheet',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Sheet name' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rename_sheet',
      description: 'Rename an existing Excel sheet',
      parameters: {
        type: 'object',
        properties: {
          old_name: { type: 'string', description: 'Current sheet name' },
          new_name: { type: 'string', description: 'New sheet name' }
        },
        required: ['old_name', 'new_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_sheet',
      description: 'Delete an Excel sheet. WARNING: irreversible!',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Sheet name to delete' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'duplicate_sheet',
      description: 'Duplicate an existing sheet (exact copy)',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source sheet name to copy' },
          new_name: { type: 'string', description: 'Name for the new sheet (default: "Source (copy)")' }
        },
        required: ['source']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'copy_range',
      description: 'Copy a range from one sheet to another (formulas, values, formatting). Use for cross-sheet data movement.',
      parameters: {
        type: 'object',
        properties: {
          from_sheet: { type: 'string', description: 'Source sheet name' },
          from: { type: 'string', description: 'Source range in A1 notation (e.g. "A1:B10")' },
          to_sheet: { type: 'string', description: 'Destination sheet name' },
          to: { type: 'string', description: 'Destination range in A1 notation (e.g. "C5")' }
        },
        required: ['from_sheet', 'from', 'to_sheet', 'to']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_named_range',
      description: 'Create a named range/reference that can be used across ALL sheets in formulas. Ideal for shared inputs like "Revenue", "TaxRate", "Beta". Creates Excel defined names.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name for the reference (e.g. "Revenue", "WACC", "TaxRate")' },
          refers_to: { type: 'string', description: 'Cell reference (e.g. "=Assumptions!B3")' }
        },
        required: ['name', 'refers_to']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_named_ranges',
      description: 'List all named ranges in the workbook with their references',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_cell_range',
      description: `Write cells using a map of A1 addresses to {value, formula, note, cellStyles, borderStyles}. Supports copyToRange for pattern fill. Supports allow_overwrite for overwrite protection. This is the PRIMARY write tool.\n\nExample:\n{\n  "sheet": "Sheet1",\n  "cells": {\n    "A1": { "value": "Revenue" },\n    "B1": { "value": 100, "cellStyles": { "fontColor": "#0000FF" } },\n    "B2": { "formula": "=B1*1.05" }\n  },\n  "copyToRange": "B2:B10",\n  "allow_overwrite": false\n}`,
      // Schema sourced from server/tools/schemas.js (single source of truth, also used by registry.js)
      parameters: SHARED_SCHEMAS.SET_CELL_RANGE
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_format',
      description: 'Apply formatting to a cell range (colors, font, number format, alignment, widths/heights, borders)',
      parameters: {
        type: 'object',
        properties: {
          sheet: { type: 'string' },
          target: { type: 'string' },
          options: {
            type: 'object',
            properties: {
              backgroundColor: { type: 'string' },
              fontColor: { type: 'string' },
              bold: { type: 'boolean' },
              italic: { type: 'boolean' },
              fontSize: { type: 'number' },
              fontName: { type: 'string' },
              numberFormat: { type: 'string' },
              horizontalAlignment: { type: 'string' },
              verticalAlignment: { type: 'string' },
              wrapText: { type: 'boolean' },
              columnWidth: { type: 'number' },
              rowHeight: { type: 'number' },
              borderBottomColor: { type: 'string' },
              borderTopColor: { type: 'string' },
              borders: { type: 'object' }
            }
          }
        },
        required: ['sheet', 'target', 'options']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execute_excel_formula',
      description: 'Write an Excel formula to a cell for Excel engine evaluation (XIRR, XNPV, etc). Writes the formula, letting Excel compute the result.\n\nExample:\n{\n  "sheet": "Valuation",\n  "target": "B10",\n  "formula": "=XIRR(B2:B9,A2:A9,0.1)"\n}',
      parameters: {
        type: 'object',
        properties: {
          sheet: { type: 'string', description: 'Sheet name' },
          target: { type: 'string', description: 'Cell address in A1 notation (e.g. "B10")' },
          formula: { type: 'string', description: 'Excel formula with = prefix (e.g. "=SUM(A1:A10)")' },
          note: { type: 'string', description: 'Optional cell comment' }
        },
        required: ['sheet', 'target', 'formula']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_chart',
      description: 'Add a native Excel chart',
      parameters: {
        type: 'object',
        properties: {
          sheet: { type: 'string' },
          target: { type: 'string', description: 'Data range for the chart' },
          options: {
            type: 'object',
            properties: {
              chartType: { type: 'string', enum: ['ColumnClustered', 'Line', 'Pie', 'Scatter', 'BarClustered'] },
              title: { type: 'string' }
            }
          }
        },
        required: ['sheet', 'target', 'options']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execute_python',
      description: 'Execute Python code for complex calculations. Return result as string or JSON.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Python code to execute' }
        },
        required: ['code']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_user_question',
      description: `Ask the user a question with tappable options. Use for clarifications, plan approval, or mid-task check-ins.\n\nExample:\n{\n  "questions": [\n    {\n      "header": "Proceed?",\n      "question": "Should I proceed with the DCF build?",\n      "options": [\n        { "label": "Yes", "description": "Build the DCF" },\n        { "label": "No", "description": "Cancel" }\n      ]\n    }\n  ]\n}`,
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              required: ['question', 'options'],
              properties: {
                header: { type: 'string', description: 'Short heading shown above the question' },
                question: { type: 'string', description: 'The question text' },
                options: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 4,
                  items: {
                    type: 'object',
                    required: ['label', 'description'],
                    properties: {
                      label: { type: 'string', description: 'Tappable button label (short)' },
                      description: { type: 'string', description: 'One-line context shown under label' }
                    }
                  }
                },
                multiSelect: { type: 'boolean' }
              }
            }
          }
        },
        required: ['questions']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: `Update the task list shown to the user as a "Steps" panel. Wholesale replacement — pass the entire list every time.\n\nRULES:\n- Only ONE task in_progress at a time. Move to in_progress BEFORE starting work, completed IMMEDIATELY after.\n- Never mark completed if it failed or only partially done.\n- When all tasks completed, the panel auto-clears.\n- Skip for single-step or trivial tasks.\n\nFIELDS:\n- content: short imperative phrase (<10 words), e.g. "Build revenue projections"\n- activeForm: present-continuous shown as spinner text while in_progress, e.g. "Building revenue projections"\n- status: pending → in_progress → completed (or cancelled)\n\nExample:\n{\n  "todos": [\n    { "content": "Set up assumptions", "activeForm": "Setting up assumptions", "status": "completed" },\n    { "content": "Build revenue projections", "activeForm": "Building revenue projections", "status": "in_progress" }\n  ]\n}`,
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'Short imperative phrase (<10 words)' },
                activeForm: { type: 'string', description: 'Present-continuous form shown while in_progress' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
                priority: { type: 'string', enum: ['high', 'medium', 'low'] }
              },
              required: ['content', 'status']
            }
          }
        },
        required: ['todos']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execute_office_js',
      description: `Execute arbitrary Office.js JavaScript code on the Excel client. Use for complex formatting, sheet operations, charts, pivot tables, conditional formatting, data validation — anything not covered by structured tools.

PREFERRED over execute_python for ALL Excel-specific operations.

KEY PATTERNS:

1. BULK FORMULA WRITES (suspend calculation):
\`\`\`javascript
context.application.load("calculationMode");
await context.sync();
const savedMode = context.application.calculationMode;
context.application.calculationMode = Excel.CalculationMode.manual;
await context.sync();
try {
  // ... write all formulas ...
} finally {
  context.application.calculationMode = savedMode;
  await context.sync();
}
\`\`\`

2. FILL FORMULAS (autoFill):
\`\`\`javascript
sheet.getRange("C2").formulas = [["=A2+B2"]];
sheet.getRange("C2").autoFill("C2:C100", Excel.AutoFillType.fillDefault);
await context.sync();
\`\`\`

3. MERGE CELLS + FORMAT TITLE:
\`\`\`javascript
sheet.getRange("A1:H1").merge(false);
sheet.getRange("A1").format.fill.color = "#0D1F2D";
sheet.getRange("A1").format.font.color = "#FFFFFF";
sheet.getRange("A1").format.font.bold = true;
\`\`\`

4. COLUMN WIDTHS / FREEZE:
\`\`\`javascript
sheet.getRange("A:A").format.columnWidth = 230;
sheet.getRange("B:B").format.columnWidth = 85;
sheet.freezePanes.freezeAt("B2");
\`\`\`

5. BORDERS / ROW HEIGHTS / NUMBER FORMATS:
\`\`\`javascript
const r = sheet.getRange("A10:D10");
r.format.borders.getItem("EdgeBottom").style = "Continuous";
r.format.borders.getItem("EdgeBottom").color = "#B0C8D5";
r.format.rowHeight = 22;
r.numberFormat = [["0.0%"]];\`\`\`

6. CLEAR CELLS:
\`\`\`javascript
sheet.getRange("C2:C3").clear(Excel.ClearApplyTo.contents);
\`\`\`

7. VERIFY FORMULAS AFTER WRITE:
\`\`\`javascript
const check = sheet.getRange("B10:B20");
check.load(["values", "formulas"]);
await context.sync();
const errors = check.values.flat().filter(v => typeof v === "string" && v.startsWith("#"));
\`\`\`

IMPORTANT: DO NOT wrap in Excel.run yourself — it's already wrapped. Use 'context' parameter. Always load() before read, sync() before use. Return JSON-serializable results.

RETURN VALUE: The value you return from the script is delivered back to you as the tool result (under "value"), together with any console.log lines (under "logs"). Use return statements to bring data back into the loop instead of issuing a separate read_range right after. This avoids redundant round-trips.`,
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Office.js JavaScript code. Receives "context" param (Excel.RequestContext). DO NOT wrap in Excel.run(). Return JSON-serializable data to get it back in the tool result.' }
        },
        required: ['code']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'context_snip',
      description: 'Compress a range of previous messages to save context window. Provide from_id and to_id (message IDs like "abc123" from [id:abc123] tags) and a 1-sentence summary. The compressed content is stored and can be retrieved later with retrieve_snipped.',
      parameters: {
        type: 'object',
        properties: {
          from_id: { type: 'string', description: 'Start message ID (e.g. "abc123")' },
          to_id: { type: 'string', description: 'End message ID (e.g. "def456")' },
          summary: { type: 'string', description: 'One-sentence summary of what was snipped' }
        },
        required: ['from_id', 'to_id', 'summary']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'retrieve_snipped',
      description: 'Retrieve previously compressed message content by searching for a term. Use when you need details that were snipped earlier.',
      parameters: {
        type: 'object',
        properties: {
          from_id: { type: 'string', description: 'Optional: start message ID to narrow search' },
          search: { type: 'string', description: 'Keyword to search in snipped content' },
          max_chars: { type: 'number', description: 'Max characters to return (default 4000)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_instructions',
      description: 'Update persistent user preferences. Use for broad style changes ("use Oxford commas", "bold titles", "Italian language"). NOT for task-specific changes. Supports find/replace or append.',
      parameters: {
        type: 'object',
        properties: {
          find: { type: 'string', description: 'Text to find for replacement' },
          replace: { type: 'string', description: 'Replacement text' },
          append: { type: 'string', description: 'Text to append at end of instructions' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_instructions',
      description: 'Read the current persistent user preferences (style, formatting, language, defaults).',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_skill',
      description: 'Load a skill document on-demand before starting a complex task. Use for DCF, LBO, WACC, comps, 3-statement, audit, or data cleaning. Returns structured instructions and formulas.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name: dcf-model, wacc-model, lbo-model, comps-analysis, three-statement, clean-data, audit-xls' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: 'Signal that the task is complete',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Summary of what was accomplished' }
        }
      }
    }
  },
  /* ---------- OpenBB Financial Data Tools ---------- */
  {
    type: 'function',
    function: {
      name: 'openbb_equity_profile',
      description: 'Company profile: description, sector, market cap, employees, beta, dividend yield. Provider: yfinance (free)',
      parameters: {
        type: 'object', required: ['symbol'],
        properties: { symbol: { type: 'string', description: 'Ticker symbol (e.g. AAPL)' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'openbb_equity_metrics',
      description: 'Key financial metrics: PE ratio, forward PE, PEG, EV/EBITDA, ROE, ROA, margins, growth rates, debt/equity. Provider: yfinance (free)',
      parameters: {
        type: 'object', required: ['symbol'],
        properties: { symbol: { type: 'string' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'openbb_equity_balance',
      description: 'Balance sheet: cash, receivables, inventory, total assets, total debt, shareholders equity. Period: annual|quarter. Provider: yfinance (free)',
      parameters: {
        type: 'object', required: ['symbol'],
        properties: {
          symbol: { type: 'string' },
          period: { type: 'string', enum: ['annual', 'quarter'] }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'openbb_equity_income',
      description: 'Income statement: revenue, COGS, gross profit, EBITDA, EBIT, net income, EPS. Period: annual|quarter. Provider: yfinance (free)',
      parameters: {
        type: 'object', required: ['symbol'],
        properties: {
          symbol: { type: 'string' },
          period: { type: 'string', enum: ['annual', 'quarter'] }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'openbb_equity_cashflow',
      description: 'Cash flow statement: operating/investing/financing cash flows, free cash flow, CapEx. Provider: yfinance (free)',
      parameters: {
        type: 'object', required: ['symbol'],
        properties: {
          symbol: { type: 'string' },
          period: { type: 'string', enum: ['annual', 'quarter'] }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'openbb_treasury_rates',
      description: 'Current US Treasury rates for all maturities (1mo-30y). Use for risk-free rate in DCF/WACC. Provider: federal_reserve (free)',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'openbb_fed_rate',
      description: 'Effective Federal Funds Rate (Fed policy rate). Provider: federal_reserve (free)',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'openbb_cpi',
      description: 'Consumer Price Index (inflation) by country. Country: united_states, italy, etc. Provider: oecd (free). ALWAYS use this instead of guessing inflation.',
      parameters: {
        type: 'object',
        properties: { country: { type: 'string', description: 'Country name (e.g. united_states, italy)' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'openbb_gdp',
      description: 'Real GDP growth by country. Provider: oecd (free)',
      parameters: {
        type: 'object',
        properties: { country: { type: 'string' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'openbb_unemployment',
      description: 'Unemployment rate by country. Provider: oecd (free)',
      parameters: {
        type: 'object',
        properties: { country: { type: 'string' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finance_company_bundle',
      description: 'Fetch profile + metrics + balance + income + cashflow for one ticker IN PARALLEL and return them as a single merged object. Use this at the start of any company analysis instead of issuing five separate openbb_equity_* calls — saves ~4 LLM turns. Returns { symbol, period, profile, metrics, balance, income, cashflow, errors }. Datasets that fail are surfaced under errors but the rest is still returned.',
      parameters: {
        type: 'object',
        required: ['symbol'],
        properties: {
          symbol: { type: 'string', description: 'Ticker symbol (e.g. AAPL)' },
          period: { type: 'string', enum: ['annual', 'quarter'], description: 'Period for income/balance/cashflow (default annual)' },
          include: {
            type: 'array',
            description: 'Subset of datasets to fetch (default = all five). Items: profile|metrics|balance|income|cashflow',
            items: { type: 'string', enum: ['profile', 'metrics', 'balance', 'income', 'cashflow'] }
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'macro_snapshot',
      description: 'Fetch treasury rates + fed funds rate + CPI + GDP + unemployment IN PARALLEL for WACC / risk-free / inflation inputs. Returns { country, treasury, fed_rate, cpi, gdp, unemployment, errors }. Replaces ~4 sequential openbb_* macro calls.',
      parameters: {
        type: 'object',
        properties: {
          country: { type: 'string', description: 'Country for CPI/GDP/unemployment (default united_states)' },
          include: {
            type: 'array',
            description: 'Subset of macro series to fetch (default = all). Items: treasury|fed_rate|cpi|gdp|unemployment',
            items: { type: 'string', enum: ['treasury', 'fed_rate', 'cpi', 'gdp', 'unemployment'] }
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'suspend_calculation',
      description: 'Suspend Excel automatic calculation (switch to manual) before large bulk writes to prevent UI freeze and crashes. Always pair with resume_calculation.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'resume_calculation',
      description: 'Resume Excel automatic calculation after bulk operations are complete. Call this after suspend_calculation.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_tools',
      description: 'Search available tools by keyword or description. Use this when you are unsure which tool to use for a task, or to discover the correct tool name and its parameters. Returns the most relevant tools with descriptions and parameter schemas.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you want to do, e.g. "calculate WACC" or "download stock prices"' },
          top_k: { type: 'number', description: 'Max results to return (default 5)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'parallel_calls',
      description: `Execute MULTIPLE independent read-only tools in PARALLEL in a single iteration. Use this when you need several pieces of data that do NOT depend on each other (e.g. read three unrelated ranges, fetch profile + macro + named ranges at once). Cuts N independent LLM round-trips down to 1.

ONLY read / idempotent tools are allowed inside the batch. Mutations (set_cell_range, execute_office_js, execute_python, create_sheet, etc.), control flow (done, ask_user_question, todo_write), and context tools (context_snip) MUST run sequentially and are rejected here. Max 8 calls per batch.

Returns { results: [{ tool, ok, value | error }, ...] } where index matches the input order.

Example:
{
  "calls": [
    { "tool": "get_cell_ranges", "params": { "ranges": [{ "sheet": "DCF", "target": "A1:H10" }] } },
    { "tool": "openbb_treasury_rates", "params": {} },
    { "tool": "openbb_equity_profile", "params": { "symbol": "AAPL" } }
  ]
}`,
      parameters: {
        type: 'object',
        required: ['calls'],
        properties: {
          calls: {
            type: 'array',
            minItems: 2,
            maxItems: 8,
            items: {
              type: 'object',
              required: ['tool', 'params'],
              properties: {
                tool: { type: 'string', description: 'Name of an allowed read-only tool' },
                params: { type: 'object', description: 'Parameters for that tool' }
              }
            }
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_setting',
      description: 'Suggest a setting change to the user via an inline widget. Use this when you notice a mismatch between user intent and current settings (e.g., wrong currency, wrong date format, wrong decimal places). The user can accept or dismiss the suggestion.',
      parameters: {
        type: 'object',
        properties: {
          setting: { type: 'string', description: 'Setting key, e.g. "currency", "date_format", "decimal_places", "language"' },
          current_value: { type: 'string', description: 'Current value of the setting' },
          suggested_value: { type: 'string', description: 'Suggested new value' },
          reason: { type: 'string', description: 'Why this change is recommended' }
        },
        required: ['setting', 'current_value', 'suggested_value', 'reason']
      }
    }
  }
];

/* ---------- BM25 tool index ---------- */
initializeTools(TOOL_DEFINITIONS);

/* ---------- Context helpers ---------- */

function truncateMatrix(value, maxRows, maxCols) {
  if (!Array.isArray(value)) return value;
  return value.slice(0, maxRows).map(row =>
    Array.isArray(row) ? row.slice(0, maxCols) : row
  );
}

// Recursively trim very long arrays while preserving shape so the LLM can
// still reason about structure (head + tail with explicit "truncated" marker).
function trimDeepArrays(value, opts) {
  const maxItems = opts && opts.maxItems > 0 ? opts.maxItems : 12;
  const maxDepth = opts && opts.maxDepth > 0 ? opts.maxDepth : 8;
  function walk(v, depth) {
    if (depth > maxDepth) return v;
    if (Array.isArray(v)) {
      if (v.length <= maxItems) return v.map(item => walk(item, depth + 1));
      const headCount = Math.max(1, Math.floor(maxItems * 0.75));
      const tailCount = Math.max(1, maxItems - headCount - 1);
      const head = v.slice(0, headCount).map(item => walk(item, depth + 1));
      const tail = v.slice(v.length - tailCount).map(item => walk(item, depth + 1));
      const marker = { _truncated: true, _droppedItems: v.length - headCount - tailCount, _originalLength: v.length };
      return [...head, marker, ...tail];
    }
    if (v && typeof v === 'object') {
      const out = Array.isArray(v) ? [] : {};
      for (const k of Object.keys(v)) {
        out[k] = walk(v[k], depth + 1);
      }
      return out;
    }
    return v;
  }
  return walk(value, 0);
}

// Format a tool result for injection into the agent message history with a hard size cap.
// Strategy:
//   1) Honor _message override if the tool provides one.
//   2) If the compact JSON fits, use indented JSON (readable).
//   3) If too large, recursively trim long arrays and try again.
//   4) Last resort: hard truncate the compact JSON with an explicit marker.
function formatToolResultForMessages(toolResult, toolName, opts = {}) {
  if (toolResult && toolResult._message) {
    const msg = String(toolResult._message);
    const cap = Number(opts.maxChars) || Number(process.env.AGENT_TOOL_RESULT_MAX_CHARS) || 12000;
    return msg.length > cap ? msg.slice(0, cap) + `\n...[truncated ${msg.length - cap} chars]` : msg;
  }
  const cap = Number(opts.maxChars) || Number(process.env.AGENT_TOOL_RESULT_MAX_CHARS) || 12000;
  let compact;
  try { compact = JSON.stringify(toolResult); } catch (_) { compact = String(toolResult); }
  if (compact == null) compact = 'null';
  if (compact.length <= cap) {
    try {
      return `Tool result for ${toolName}:\n${JSON.stringify(toolResult, null, 2)}`;
    } catch (_) {
      return `Tool result for ${toolName}:\n${compact}`;
    }
  }
  // Try array trimming
  try {
    const trimmed = trimDeepArrays(toolResult, { maxItems: 10 });
    const trimmedJson = JSON.stringify(trimmed, null, 2);
    if (trimmedJson.length <= cap) {
      return `Tool result for ${toolName} (long arrays truncated; head + tail kept):\n${trimmedJson}`;
    }
    // Aggressive trim
    const aggressive = trimDeepArrays(toolResult, { maxItems: 5, maxDepth: 6 });
    const aggressiveJson = JSON.stringify(aggressive, null, 2);
    if (aggressiveJson.length <= cap) {
      return `Tool result for ${toolName} (arrays aggressively truncated):\n${aggressiveJson}`;
    }
  } catch (_) { /* fall through to hard cap */ }
  // Hard cap on compact form
  return `Tool result for ${toolName} [HARD-TRUNCATED ${compact.length} -> ${cap} chars; the original was too large to fit the agent context]:\n${compact.slice(0, cap)}\n...[truncated]`;
}

function compactAgentContext(context) {
  if (!context || typeof context !== 'object') return {};
  const out = {
    activeSheet: context.activeSheet,
    workbookSheets: Array.isArray(context.workbookSheets) ? context.workbookSheets.slice(0, 24) : [],
    sheetCount: context.sheetCount || (Array.isArray(context.workbookSheets) ? context.workbookSheets.length : 0),
    selectedRange: context.selectedRange,
    selectionSize: context.selectionSize,
    selectedPreview: truncateMatrix(context.selectedValues, 12, 8),
    selectedFormulasPreview: truncateMatrix(context.selectedFormulas, 12, 8),
    sheets: {}
  };
  const all = context.allSheetsData || {};
  for (const [name, info] of Object.entries(all)) {
    if (!info) continue;
    const isActive = info.isActive || name === context.activeSheet;
    out.sheets[name] = {
      isActive: !!isActive,
      usedRange: info.usedRange || null,
      rowCount: info.rowCount || 0,
      columnCount: info.columnCount || 0,
      truncated: !!info.truncated,
      empty: !!info.empty,
      omitted: !!info.omitted,
      preview: truncateMatrix(info.preview, isActive ? 30 : 10, isActive ? 14 : 8),
      formulas: isActive ? truncateMatrix(info.formulas, 30, 14) : undefined
    };
  }
  return out;
}

function buildWorkbookOverview(context) {
  if (!context || typeof context !== 'object') return 'Workbook overview: (no context)';
  const lines = [];
  lines.push(`Workbook overview — active sheet: "${context.activeSheet || '?'}", total sheets: ${context.sheetCount || (context.workbookSheets || []).length}`);
  const all = context.allSheetsData || {};
  for (const [name, info] of Object.entries(all)) {
    if (!info) continue;
    const tag = info.isActive || name === context.activeSheet ? ' [ACTIVE]' : '';
    if (info.empty) {
      lines.push(`  • "${name}"${tag}: empty`);
    } else if (info.omitted) {
      lines.push(`  • "${name}"${tag}: ${info.usedRange || '?'} (${info.rowCount}×${info.columnCount}) — preview omitted (sheet limit)`);
    } else {
      lines.push(`  • "${name}"${tag}: ${info.usedRange || '?'} (${info.rowCount}×${info.columnCount})${info.truncated ? ' [truncated]' : ''}`);
    }
  }
  if (lines.length === 1 && Array.isArray(context.workbookSheets)) {
    lines.push('  ' + context.workbookSheets.join(', '));
  }
  return lines.join('\n');
}

/* ---------- Auto-answer trivial questions to protect flow ---------- */

function normalizeQuestion(q) {
  if (typeof q === 'string') return { text: q, options: [] };
  if (!q || typeof q !== 'object') return { text: '', options: [] };
  const text = String(q.header || q.question || q.text || q.prompt || q.title || '');
  const opts = Array.isArray(q.options) ? q.options : [];
  return { text: text.toLowerCase(), options: opts };
}

function tryAutoAnswer(questionData, context, objective) {
  if (!Array.isArray(questionData)) questionData = [questionData];
  const answers = [];
  let autoAnsweredCount = 0;

  for (const rawQ of questionData) {
    const q = normalizeQuestion(rawQ);
    const text = q.text;
    let answer = null;

    // 1. Generic confirmations / proceed questions → always Yes
    const confirmationPatterns = [
      /should i proceed/, /shall i proceed/, /do you want me to proceed/, /want me to continue/,
      /should i continue/, /go ahead/, /proceed\?/, /continue\?/, /ok to proceed/,
      /vuoi che proceda/, /procedo\?/, /devo procedere/, /continuo\?/, /vado avanti/
    ];
    if (confirmationPatterns.some(p => p.test(text))) {
      answer = 'Yes';
    }

    // 2. Which sheet → default to active sheet
    if (!answer && /(which|what) sheet/.test(text)) {
      answer = context?.activeSheet || 'Active sheet';
    }
    if (!answer && /(quale|in quale) foglio/.test(text)) {
      answer = context?.activeSheet || 'Foglio attivo';
    }

    // 3. Ticker / company name already in objective
    if (!answer && /(ticker|symbol|company name|nome dell.azienda|titolo)/.test(text)) {
      const knownTickers = ['AAPL','MSFT','GOOGL','GOOG','TSLA','AMZN','META','NVDA','NFLX','JPM','V','WMT','DIS','BA','GE','IBM','INTC','AMD','CRM','UBER'];
      const objUpper = String(objective || '').toUpperCase();
      const matched = knownTickers.find(t => objUpper.includes(t));
      if (matched) answer = matched;
    }

    // 4. "What is the revenue / EBITDA / etc." when data is in context
    if (!answer && /(what is|what are|qual è|quali sono)/.test(text)) {
      const hasWorkbookData = context && (
        context.selectedValues?.length > 0 ||
        context.usedRangeData?.length > 0 ||
        Object.keys(context.allSheetsData || {}).length > 0
      );
      if (hasWorkbookData) {
        answer = 'Use the data already present in the workbook';
      }
    }

    // 5. Empty / malformed questions
    if (!answer && text.trim().length === 0) {
      answer = 'Please proceed with the available information.';
    }

    if (answer) {
      answers.push(answer);
      autoAnsweredCount++;
    } else {
      // Cannot auto-answer this one → abort whole auto-answer and let UI handle it
      return null;
    }
  }

  if (autoAnsweredCount === 0) return null;
  return answers.length === 1 ? answers[0] : answers.join(' | ');
}

function normalizeQuestionResponsePayload(response) {
  if (response == null) return { answers: [] };
  if (response.values && typeof response.values === 'object') return response.values;
  if (Array.isArray(response.answers)) return { answers: response.answers };
  if (typeof response.answers === 'string') return { answers: [response.answers] };
  if (typeof response === 'string') return { answers: [response] };
  return response;
}

function normalizeStagnationValue(value, depth = 0) {
  if (value == null) return value;
  if (depth >= 4) return '[depth-limit]';
  if (typeof value === 'string') {
    return value.length > 160 ? `${value.slice(0, 160)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 8).map(item => normalizeStagnationValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = normalizeStagnationValue(value[key], depth + 1);
      return acc;
    }, {});
  }
  return String(value);
}

function buildToolStagnationSignature(toolName, params = {}) {
  return `${toolName}:${JSON.stringify(normalizeStagnationValue(params))}`;
}

function detectToolStagnation(trail, maxRepeat = STAGNATION_MAX_REPEAT, altCycles = STAGNATION_ALT_CYCLES) {
  if (!Array.isArray(trail) || trail.length === 0) return null;
  const last = trail[trail.length - 1];
  if (!last || !STAGNATION_WATCH_TOOLS.has(last.toolName)) return null;

  if (trail.length >= maxRepeat) {
    const repeated = trail.slice(-maxRepeat);
    if (repeated.every(entry => entry.signature === last.signature)) {
      return {
        pattern: 'repeat',
        entries: repeated
      };
    }
  }

  const alternatingWindow = altCycles * 2;
  if (trail.length >= alternatingWindow) {
    const alternating = trail.slice(-alternatingWindow);
    const first = alternating[0];
    const second = alternating[1];
    if (
      first &&
      second &&
      first.signature !== second.signature &&
      STAGNATION_WATCH_TOOLS.has(first.toolName) &&
      STAGNATION_WATCH_TOOLS.has(second.toolName) &&
      alternating.every((entry, index) => (
        index % 2 === 0
          ? entry.signature === first.signature
          : entry.signature === second.signature
      ))
    ) {
      return {
        pattern: 'alternating',
        entries: alternating
      };
    }
  }

  return null;
}

function formatToolStagnationReason(stagnation) {
  if (!stagnation || !Array.isArray(stagnation.entries) || stagnation.entries.length === 0) {
    return 'stagnation_detected';
  }
  if (stagnation.pattern === 'repeat') {
    return `stagnation_repeat:${stagnation.entries[0].toolName}:x${stagnation.entries.length}`;
  }
  if (stagnation.pattern === 'alternating' && stagnation.entries.length >= 2) {
    const first = stagnation.entries[0].toolName;
    const second = stagnation.entries[1].toolName;
    return `stagnation_cycle:${first}->${second}:x${Math.floor(stagnation.entries.length / 2)}`;
  }
  return `stagnation_${stagnation.pattern}`;
}

/* ---------- Agent Loop ---------- */

async function runAgentLoop(objective, context, options = {}) {
  const maxIterations = options.maxIterations || Number(process.env.AGENT_MAX_ITER) || 200;
  const maxConsecutiveErrors = options.maxConsecutiveErrors || 4;
  const timeoutMs = options.timeoutMs || Number(process.env.AGENT_LLM_TIMEOUT_MS) || 300000;
  const fallbackTimeoutMs = options.fallbackTimeoutMs || Number(process.env.AGENT_LLM_FALLBACK_TIMEOUT_MS) || 180000;
  const onEvent = options.onEvent || (() => {});

  const FATAL_ERROR_PATTERNS = [
    /no api key configured/i,
    /invalid api key/i,
    /authentication failed/i,
    /unauthorized/i,
    /402/i,
    /payment required/i,
    /credit exhausted/i,
    /insufficient quota/i,
    /rate limit/i
  ];

  // Build enhanced user prompt with known-data hints for common companies
  const compactCtx = compactAgentContext(context);
  const overview = buildWorkbookOverview(context);
  let userPrompt = `Goal: ${objective}\n\n${overview}\n\nWorkbook context (compact JSON):\n${JSON.stringify(compactCtx, null, 2)}\n\nProceed step by step. When writing, ALWAYS pass an explicit "sheet" parameter — the active sheet at task start may NOT be where the user wants the data.`;
  const lowerObjective = objective.toLowerCase();
  if (lowerObjective.includes('apple') || lowerObjective.includes('aapl')) {
    userPrompt += `\n\nHINT — These publicly known Apple FY2024 figures are rough sanity-check anchors, not live sources:\n- Revenue: ~$394B\n- Net Income: ~$97B\n- EBITDA: ~$120B\n- CapEx: ~$10B\n- D&A: ~$12B\n- Shares Outstanding: ~15.5B\n- Cash & Equivalents: ~$70B\n- Total Debt: ~$110B\n- Tax Rate: ~16%\nVerify or update current market/filing inputs with tools when available, then build the model with visible sources and review flags.`;
  }

  const promptVariant = options.promptVariant || DEFAULT_PROMPT_VARIANT;
  const systemPromptForRun = getSystemPrompt(promptVariant);
  const modelForRun = resolveAgentLoopModel(options.modelOverride, promptVariant);
  logger.info(`[AgentLoop] Using prompt variant "${promptVariant}" (${systemPromptForRun.length} chars)`);

  // Auto-skill suggest: preload skill if user message matches known keywords
  const suggestedSkills = detectSkills(objective);
  let skillReminder = '';
  if (suggestedSkills.length > 0) {
    const loaded = suggestedSkills.map(name => readSkill(name)).filter(Boolean);
    if (loaded.length > 0) {
      skillReminder = `<system-reminder>\nPre-loaded skill${loaded.length > 1 ? 's' : ''} based on user request: ${suggestedSkills.join(', ')}.\n\n` +
        loaded.map(s => `--- ${s.name} ---\n${s.content.slice(0, 4000)}`).join('\n\n') +
        '\n</system-reminder>';
      logger.info(`[AgentLoop] Auto-preloaded skills: ${suggestedSkills.join(', ')}`);
    }
  }

  const systemPromptAddendum = typeof options.systemPromptAddendum === 'string' && options.systemPromptAddendum.trim()
    ? '\n\n' + options.systemPromptAddendum.trim()
    : '';
  const messages = options.resumeMessages || [
    { role: 'system', content: systemPromptForRun + (skillReminder ? '\n\n' + skillReminder : '') + systemPromptAddendum },
    makeUserMessage(userPrompt)
  ];

  const results = options.resumeResults || [];
  let iteration = options.resumeIteration || 0;
  let done = false;
  const codeLog = options.resumeCodeLog || [];

  logger.info(`[AgentLoop] Starting loop for: ${objective}`);
  onEvent('agentStarted', { objective, iteration });

  let webSearchCount = 0;
  const MAX_WEB_SEARCH = Number(process.env.AGENT_MAX_WEB_SEARCH) || 20;
  let consecutiveErrors = 0;
  let lastErrorMessage = '';
  let aborted = false;
  let abortReason = '';
  let forceThinkingNext = false;
  let parseFailureStreak = 0;
  const loadedSkillNames = new Set();
  const recentToolTrail = [];

  while (!done && iteration < maxIterations) {
    iteration++;
    logger.info(`[AgentLoop] Iteration ${iteration}/${maxIterations}`);
    onEvent('iterationStart', { iteration, maxIterations });

    // Drain steering queue: messages user sent mid-execution are injected here
    // before the next LLM call. Classified upstream as ADDENDUM (context) or INTERRUPT (priority redirect).
    if (typeof options.pullSteerMessages === 'function') {
      try {
        const steerItems = options.pullSteerMessages() || [];
        for (const item of steerItems) {
          if (!item || !item.text) continue;
          const isInterrupt = item.kind === 'interrupt';
          const wrapped = isInterrupt
            ? `<user-interrupt iteration="${iteration}">\nThe user issued a mid-execution DIRECTIVE. Reassess immediately: drop in-progress steps that conflict with it. Acknowledge briefly in your next "thought" and act on the new directive.\n\nDirective: ${item.text}\n</user-interrupt>`
            : `<user-addendum iteration="${iteration}">\nAdditional info from the user (continue current work, integrate this into the ongoing task):\n${item.text}\n</user-addendum>`;
          messages.push(makeUserMessage(wrapped));
          recentToolTrail.length = 0;
          onEvent('agentSteered', { iteration, kind: item.kind, text: item.text });
          logger.info(`[AgentLoop] Steer injected (${item.kind}): ${item.text.slice(0, 120)}`);
        }
      } catch (steerErr) {
        logger.warn(`[AgentLoop] pullSteerMessages failed: ${steerErr.message}`);
      }
    }

    try {
      const useThinking = shouldUseAgentThinking(iteration, {
        forceThinkingNext,
        consecutiveErrors,
        parseFailureStreak
      });
      const turnId = options.turnId || options.agentId;
      const callOpts = {
        messages,
        timeoutMs,
        fallbackTimeoutMs,
        label: `AgentLoop iter ${iteration}`,
        modelOverride: modelForRun,
        thinkingDisabled: !useThinking,
        reasoningEffort: useThinking ? (process.env.DEEPSEEK_REASONING_EFFORT || 'high') : AGENT_REASONING_EFFORT
      };

      let llmResult;
      if (AGENT_USE_STREAMING && turnId && !useThinking) {
        // Stream non-thinking responses for live UI feedback (thinking responses are JSON-only at end)
        const accumulated = await callLLMStreaming({
          ...callOpts,
          label: `AgentLoop iter ${iteration} stream`,
          onChunk: (delta, text, isDone) => {
            if (delta || isDone) {
              try { streaming.sendLLMProgress(turnId, text, isDone); } catch (_) {}
            }
          }
        });
        // Parse the streamed JSON
        try {
          llmResult = JSON.parse(accumulated);
        } catch (e) {
          llmResult = { raw: accumulated, jsonError: e.message };
        }
      } else {
        llmResult = await callLLM(callOpts);
      }

      // Detect JSON parse failure from LLM layer (raw payload returned, no parsed fields)
      const parseFailed = !!(llmResult && llmResult.raw && llmResult.jsonError);
      if (parseFailed) {
        parseFailureStreak++;
        if (AGENT_FORCE_THINKING_AFTER_ERROR) forceThinkingNext = true;
        logger.warn(`[AgentLoop] iter ${iteration} LLM JSON parse failed: ${llmResult.jsonError}`);
        onEvent('iterationError', { iteration, error: `LLM JSON parse failed: ${llmResult.jsonError}` });
        messages.push(makeUserMessage(
          `Your previous response was not valid JSON (${llmResult.jsonError}). Reply with ONLY a single JSON object {"thought","tool","params"} — no extra text, no trailing characters. Continue the task from where you left off.`
        ));
        continue;
      }
      parseFailureStreak = 0;
      if (useThinking) forceThinkingNext = false;

      // Extract thought and tool call from LLM response
      const thought = llmResult.thought || llmResult.reasoning || '';
      const toolName = llmResult.tool || llmResult.action || '';
      const params = llmResult.params || llmResult.parameters || llmResult.arguments || {};

      logger.info(`[AgentLoop] Thought: ${thought.slice(0, 120)}`);
      logger.info(`[AgentLoop] Tool: ${toolName}`);
      onEvent('thought', { iteration, thought: thought.slice(0, 300), tool: toolName });

      // Append assistant message
      messages.push({
        role: 'assistant',
        content: JSON.stringify({ thought, tool: toolName, params })
      });

      // Empty/noop tool — never auto-done. Force LLM to either call `done` or continue.
      if (!toolName || toolName === '' || toolName === 'noop' || toolName === 'none') {
        messages.push(makeUserMessage(
          'No tool was called. If task is complete, call tool "done" with a summary. Otherwise continue with the next tool.'
        ));
        continue;
      }

      // Enforce max web search attempts
      if (toolName === 'web_search' || toolName === 'web_fetch') {
        webSearchCount++;
        if (webSearchCount > MAX_WEB_SEARCH) {
          const blockMsg = `Maximum web search attempts (${MAX_WEB_SEARCH}) reached. Use the sourced information already gathered, label any remaining uncertain inputs as assumptions, and continue the model. Do NOT search again.`;
          logger.info(`[AgentLoop] ${blockMsg}`);
          messages.push(makeUserMessage(blockMsg));
          results.push({ type: 'error', error: blockMsg });
          onEvent('iterationError', { iteration, error: blockMsg });
          continue;
        }
      }

      // Handle done
      if (toolName === 'done') {
        done = true;
        results.push({ type: 'done', summary: params.summary || 'Task completed' });
        messages.push(makeUserMessage('Task completed successfully.'));
        onEvent('agentDone', { summary: params.summary || 'Task completed', iteration });
        break;
      }

      // Handle ask_user / ask_user_question — try auto-answer first, then pause only if needed
      if (toolName === 'ask_user' || toolName === 'ask_user_question') {
        let questionData = toolName === 'ask_user_question'
          ? params.questions
          : params.question;

        // Fallback: LLM might send singular 'question' instead of 'questions'
        if (!questionData && params.question) {
          questionData = Array.isArray(params.question) ? params.question : [params.question];
        }

        // Validate: if still no valid question data, tell LLM to retry
        if (!questionData || (Array.isArray(questionData) && questionData.length === 0)) {
          const retryMsg = 'You called ask_user_question with no valid questions. The "questions" parameter must be a non-empty array of objects with "question" (or "header") and "options" fields. Call ask_user_question again with a proper question.';
          logger.warn(`[AgentLoop] ask_user_question called with empty/invalid questions: ${JSON.stringify(params).slice(0, 200)}`);
          messages.push(makeUserMessage(retryMsg));
          continue;
        }

        // Try auto-answer to protect flow from trivial questions
        const autoAnswer = tryAutoAnswer(questionData, context, objective);
        if (autoAnswer) {
          logger.info(`[AgentLoop] Auto-answered question: "${JSON.stringify(questionData).slice(0, 120)}" → "${autoAnswer}"`);
          messages.push(makeUserMessage(
            `Auto-answered: ${autoAnswer}. Do NOT ask again unless absolutely critical. Proceed with the task.`
          ));
          results.push({ type: 'ask_user', question: questionData, autoAnswer });
          onEvent('agentAutoAnswer', { question: questionData, answer: autoAnswer, iteration });
          continue;
        }

        if (typeof options.requestQuestion === 'function') {
          logger.info(`[AgentLoop] requestQuestion callback handling ${Array.isArray(questionData) ? questionData.length : 1} prompt(s)`);
          onEvent('agentPaused', { reason: 'user_input_required', question: questionData, iteration, handledInline: true });
          const userResponse = await options.requestQuestion(questionData, { iteration, objective });
          const normalizedResponse = normalizeQuestionResponsePayload(userResponse);
          messages.push({
            role: 'user',
            content: `User response: ${JSON.stringify(normalizedResponse)}`
          });
          results.push({ type: 'ask_user', question: questionData, response: normalizedResponse });
          onEvent('agentResumed', { question: questionData, response: normalizedResponse, iteration });
          continue;
        }

        results.push({ type: 'ask_user', question: questionData });
        // SSE payload: only send what the client UI needs (not messages/results/codeLog)
        logger.info(`[AgentLoop] PAUSING loop — emitting agentPaused to ${typeof onEvent === 'function' ? 'client' : 'no one'}`);
        const eventPayload = { reason: 'user_input_required', question: questionData, iteration };
        onEvent('agentPaused', eventPayload);
        logger.info(`[AgentLoop] agentPaused emitted with question count=${Array.isArray(questionData) ? questionData.length : 1}`);
        return {
          status: 'paused',
          reason: 'user_input_required',
          question: questionData,
          messages,
          results,
          iteration,
          codeLog,
          context
        };
      }

      // Handle context_snip — managed directly in the loop (needs access to messages array)
      if (toolName === 'context_snip') {
        const snipResult = snipContext(messages, params.from_id, params.to_id, params.summary);
        logger.info(`[AgentLoop] context_snip: ${snipResult.ok ? 'removed ' + snipResult.removed + ' messages' : 'failed: ' + snipResult.error}`);
        messages.push(makeUserMessage(`Context snipped: ${params.summary}`));
        results.push({ type: 'context_snip', ...snipResult });
        onEvent('contextSnip', snipResult);
        continue;
      }

      // Handle retrieve_snipped — lookup in global store
      if (toolName === 'retrieve_snipped') {
        const retrieved = retrieveSnipped(params.from_id, params.search, params.max_chars);
        logger.info(`[AgentLoop] retrieve_snipped: ${retrieved.found ? retrieved.count + ' results' : 'none found'}`);
        messages.push(makeUserMessage(`Retrieved snipped context: ${JSON.stringify(retrieved.results?.map(r => r.summary) || [])}`));
        results.push({ type: 'retrieve_snipped', ...retrieved });
        onEvent('retrieveSnipped', retrieved);
        continue;
      }

      if (toolName === 'read_skill') {
        const skillName = String(params?.name || '').trim();
        if (skillName && loadedSkillNames.has(skillName)) {
          const duplicateSkillMsg = `Skill "${skillName}" is already loaded in context. Do not call read_skill again. Proceed with workbook/data/build tools.`;
          logger.info(`[AgentLoop] ${duplicateSkillMsg}`);
          results.push({ type: 'read_skill_duplicate', name: skillName });
          onEvent('iterationError', { iteration, error: duplicateSkillMsg });
          messages.push(makeUserMessage(duplicateSkillMsg));
          continue;
        }
      }

      // Execute tool
      const toolResult = await executeAgentTool(toolName, params, context, options.requestClientTool);

      if (toolName === 'read_skill') {
        const skillName = String(params?.name || '').trim();
        if (skillName) loadedSkillNames.add(skillName);
      }

      // Handle todo_write — pass to client as UI update, don't pause
      if (toolName === 'todo_write') {
        const todos = Array.isArray(params.todos) ? params.todos : [];
        results.push({ type: 'todo_write', todos });
        onEvent('todoWrite', { todos });
        if (todos.length > 0) {
          messages.push(makeUserMessage(
            `Task list updated: ${todos.map(t => `[${t.status}] ${t.content}`).join(', ')}`
          ));
        } else {
          messages.push(makeUserMessage('Task list updated.'));
        }
        continue;
      }

      // Handle preflight conflict (e.g. set_cell_range with allow_overwrite=false)
      if (toolResult && toolResult._preflight && toolResult._preflight.conflict) {
        logger.warn(`[AgentLoop] Preflight conflict blocked ${toolName}: ${toolResult._message}`);
        onEvent('preflightConflict', { tool: toolName, ...toolResult._preflight });
        results.push({ type: 'preflight_conflict', tool: toolName, ...toolResult._preflight });
        messages.push(makeUserMessage(toolResult._message));
        continue;
      }

      // Emit actions for Excel mutations
      if (toolResult && toolResult.actions && toolResult.actions.length > 0) {
        // Auto-add explanation + citation if missing (Anthropic pattern)
        const enrichedActions = toolResult.actions.map((a, idx) => {
          let enriched = a;
          if (!a.explanation) {
            const parts = [a.type];
            if (a.sheet) parts.push(`on ${a.sheet}`);
            if (a.target) parts.push(a.target);
            else if (a.cells) parts.push(`${Object.keys(a.cells).length} cells`);
            else if (a.name) parts.push(`"${a.name}"`);
            const explanation = parts.join(' ').slice(0, 50);
            enriched = { ...a, explanation };
          }
          // Propagate preflight metadata to client for trust UX
          if (idx === 0 && toolResult._preflight) {
            enriched = { ...enriched, _preflight: toolResult._preflight };
          }
          return enriched;
        });
        onEvent('actions', { tool: toolName, actions: enrichedActions });
      }

      // Log code transparency
      if (toolName === 'execute_python') {
        codeLog.push({ type: 'python', code: params.code, result: toolResult });
        onEvent('codeLog', { code: params.code, result: toolResult });
      }

      // Invalidate workbook-read cache after any mutation so the next read
      // crosses the wire instead of returning a pre-write snapshot.
      if (MUTATION_TOOLS.has(toolName) && options.agentId) {
        try {
          const n = clientReadCache.invalidate(options.agentId);
          if (n > 0) logger.info(`[AgentLoop] read cache invalidated (${n} entries) after ${toolName}`);
        } catch (_) { /* defensive — cache is optional */ }
      }

      results.push({ type: 'tool', tool: toolName, params, result: toolResult });
      consecutiveErrors = 0;
      lastErrorMessage = '';

      // Append tool result — bounded by AGENT_TOOL_RESULT_MAX_CHARS to keep
      // the prompt size predictable across long iterations.
      const resultMsg = formatToolResultForMessages(toolResult, toolName);
      messages.push(makeUserMessage(resultMsg));
      onEvent('toolResult', { iteration, tool: toolName, result: toolResult });

      recentToolTrail.push({
        iteration,
        toolName,
        signature: buildToolStagnationSignature(toolName, params)
      });
      if (recentToolTrail.length > STAGNATION_MAX_TRAIL) {
        recentToolTrail.splice(0, recentToolTrail.length - STAGNATION_MAX_TRAIL);
      }
      const stagnation = detectToolStagnation(recentToolTrail);
      if (stagnation) {
        aborted = true;
        abortReason = formatToolStagnationReason(stagnation);
        results.push({
          type: 'error',
          error: abortReason,
          stagnation: true,
          pattern: stagnation.pattern,
          tools: stagnation.entries.map(entry => entry.toolName)
        });
        logger.warn(`[AgentLoop] Stagnation detected (${abortReason})`);
        onEvent('iterationError', {
          iteration,
          error: abortReason,
          stagnation: true,
          pattern: stagnation.pattern
        });
        break;
      }

      // Auto-compact context if too large (LLM should also call context_snip explicitly)
      const AUTO_COMPACT_LIMIT = Number(process.env.AGENT_AUTO_COMPACT_LIMIT) || 80;
      if (messages.length > AUTO_COMPACT_LIMIT) {
        const keepCount = Number(process.env.AGENT_AUTO_COMPACT_KEEP) || 12;
        const toCompact = messages.slice(1, messages.length - keepCount);
        // Find first and last user message IDs in the range for snipContext
        const userMsgs = toCompact.filter(m => m.role === 'user');
        let snipApplied = false;
        if (userMsgs.length >= 2) {
          const firstId = extractMsgId(userMsgs[0].content);
          const lastId = extractMsgId(userMsgs[userMsgs.length - 1].content);
          if (firstId && lastId) {
            const snipResult = snipContext(messages, firstId, lastId, 'Auto-compacted history');
            if (snipResult.ok) {
              logger.info(`[AgentLoop] Auto-snipped ${snipResult.removed} messages (${firstId}..${lastId}). New length: ${messages.length}`);
              snipApplied = true;
            }
          }
        }
        // Fallback to old text summary if snipContext failed
        if (!snipApplied) {
          const compacted = toCompact.filter(m => {
            if (m.role === 'assistant') {
              try { const p = JSON.parse(m.content); return p.tool && !['done','todo_write','context_snip'].includes(p.tool); }
              catch (_) { return m.content.length > 50; }
            }
            return m.role === 'user' && !m.content.startsWith('Tool result') && !m.content.startsWith('CONVERSATION SUMMARY');
          });
          const compactLines = compacted.map(m => {
            if (m.role === 'assistant') {
              try { const p = JSON.parse(m.content); return `[${p.tool}] ${(p.thought||'').slice(0,100)}`; }
              catch (_) { return m.content.slice(0,100); }
            }
            return m.content.slice(0,100);
          });
          if (compactLines.length > 0) {
            const summary = 'AUTO-COMPACTED HISTORY (' + toCompact.length + ' msgs):\n' + compactLines.join('\n').slice(0, 3000);
            const newMsgs = [messages[0]];
            newMsgs.push(makeUserMessage(summary + '\n\nContinue from where you left off.'));
            newMsgs.push(...messages.slice(messages.length - keepCount));
            messages.length = 0;
            messages.push(...newMsgs);
            logger.info(`[AgentLoop] Auto-compacted ${toCompact.length} messages. New length: ${messages.length}`);
          }
        }
      }

    } catch (error) {
      logger.error(`[AgentLoop] Error iteration ${iteration}: ${error.message}`);
      const isFatal = FATAL_ERROR_PATTERNS.some(p => p.test(error.message || ''));
      if (isFatal) {
        aborted = true;
        abortReason = `fatal_error: ${error.message}`;
        results.push({ type: 'error', error: error.message, fatal: true });
        onEvent('iterationError', { iteration, error: error.message, fatal: true });
        logger.error(`[AgentLoop] Fatal error → abort: ${error.message}`);
        break;
      }
      if (error.message === lastErrorMessage) {
        consecutiveErrors++;
      } else {
        consecutiveErrors = 1;
        lastErrorMessage = error.message;
      }
      results.push({ type: 'error', error: error.message });
      onEvent('iterationError', { iteration, error: error.message });
      if (AGENT_FORCE_THINKING_AFTER_ERROR) forceThinkingNext = true;
      if (consecutiveErrors >= maxConsecutiveErrors) {
        aborted = true;
        abortReason = `repeated_error_x${consecutiveErrors}: ${error.message}`;
        logger.error(`[AgentLoop] Same error ${consecutiveErrors}x → abort: ${error.message}`);
        break;
      }
      messages.push(makeUserMessage(
        `Error: ${error.message}. Please try a different approach.`
      ));
    }
  }

  logger.info(`[AgentLoop] Completed after ${iteration} iterations${aborted ? ` (aborted: ${abortReason})` : ''}`);
  const finalStatus = done ? 'completed' : (aborted ? 'aborted' : 'max_iterations');
  const finalSummary = done
    ? results.find(r => r.type === 'done')?.summary
    : (aborted ? abortReason : 'Reached max iterations');

  return {
    status: finalStatus,
    results,
    messages,
    iteration,
    codeLog,
    summary: finalSummary
  };
}

/* ---------- Tool Execution Router ---------- */

function normalizeAgentParams(toolName, params) {
  if (!params || typeof params !== 'object') return params || {};
  const p = { ...params };
  // Sheet aliases: LLM may emit sheetName / sheet_name / worksheet
  if (p.sheet === undefined) {
    if (p.sheetName !== undefined) p.sheet = p.sheetName;
    else if (p.sheet_name !== undefined) p.sheet = p.sheet_name;
    else if (p.worksheet !== undefined) p.sheet = p.worksheet;
    else if (p.worksheetName !== undefined) p.sheet = p.worksheetName;
  }
  // Target aliases: range / address / cell
  if (p.target === undefined) {
    if (p.range !== undefined) p.target = p.range;
    else if (p.address !== undefined) p.target = p.address;
    else if (p.cell !== undefined) p.target = p.cell;
  }
  // copy_range: snake/camel aliases
  if (toolName === 'copy_range') {
    if (p.from_sheet === undefined && p.fromSheet !== undefined) p.from_sheet = p.fromSheet;
    if (p.to_sheet === undefined && p.toSheet !== undefined) p.to_sheet = p.toSheet;
  }
  // rename_sheet
  if (toolName === 'rename_sheet') {
    if (p.old_name === undefined && p.oldName !== undefined) p.old_name = p.oldName;
    if (p.new_name === undefined && p.newName !== undefined) p.new_name = p.newName;
  }
  // duplicate_sheet
  if (toolName === 'duplicate_sheet') {
    if (p.new_name === undefined && p.newName !== undefined) p.new_name = p.newName;
  }
  // create_named_range
  if (toolName === 'create_named_range') {
    if (p.refers_to === undefined && p.refersTo !== undefined) p.refers_to = p.refersTo;
  }
  return p;
}

/* ---------- Preflight helpers for cell range bounding box ---------- */
function colToIndex(col) {
  let idx = 0;
  for (let i = 0; i < col.length; i++) {
    idx = idx * 26 + (col.charCodeAt(i) - 64);
  }
  return idx;
}
function indexToCol(idx) {
  let col = '';
  while (idx > 0) {
    const rem = (idx - 1) % 26;
    col = String.fromCharCode(65 + rem) + col;
    idx = Math.floor((idx - 1) / 26);
  }
  return col;
}
function getCellRangeBounds(cellMap) {
  const cells = Object.keys(cellMap || {});
  if (cells.length === 0) return null;
  let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
  for (const addr of cells) {
    const m = addr.match(/^([A-Z]+)(\d+)$/);
    if (!m) continue;
    const col = colToIndex(m[1]);
    const row = parseInt(m[2], 10);
    minCol = Math.min(minCol, col);
    maxCol = Math.max(maxCol, col);
    minRow = Math.min(minRow, row);
    maxRow = Math.max(maxRow, row);
  }
  if (minCol === Infinity) return null;
  return `${indexToCol(minCol)}${minRow}:${indexToCol(maxCol)}${maxRow}`;
}

// Allowlist of tool names that are safe to run inside parallel_calls.
// Strictly read-only / idempotent. Mutations, control flow, and context
// manipulation tools are excluded — they MUST run sequentially.
const PARALLEL_SAFE_TOOLS = new Set([
  'read_workbook',
  'read_sheet',
  'get_cell_ranges',
  'get_range_as_csv',
  'list_named_ranges',
  'build_workbook_graph',
  'read_instructions',
  'read_skill',
  'search_tools',
  'openbb_equity_profile',
  'openbb_equity_metrics',
  'openbb_equity_balance',
  'openbb_equity_income',
  'openbb_equity_cashflow',
  'openbb_treasury_rates',
  'openbb_fed_rate',
  'openbb_cpi',
  'openbb_gdp',
  'openbb_unemployment',
  'finance_company_bundle',
  'macro_snapshot'
]);

async function executeAgentTool(toolName, params, context, requestClientTool) {
  params = normalizeAgentParams(toolName, params);
  // Build a memory object compatible with registry.executeTool so that
  // workbook.* tools can access requestClientTool via memory.runtime.
  const toolMemory = { context };
  if (requestClientTool) toolMemory.runtime = { requestClientTool };
  switch (toolName) {
    case 'parallel_calls': {
      const callsInput = Array.isArray(params && params.calls) ? params.calls : [];
      if (callsInput.length === 0) {
        return { error: 'parallel_calls: "calls" must be a non-empty array' };
      }
      if (callsInput.length > 8) {
        return { error: `parallel_calls: max 8 calls per batch, got ${callsInput.length}` };
      }
      const planned = callsInput.map((c, idx) => {
        const tool = c && typeof c.tool === 'string' ? c.tool : '';
        const innerParams = c && typeof c.params === 'object' && c.params !== null ? c.params : {};
        if (!tool) {
          return { idx, tool, ok: false, error: 'missing "tool" field', skipped: true };
        }
        if (tool === 'parallel_calls') {
          return { idx, tool, ok: false, error: 'parallel_calls cannot be nested', skipped: true };
        }
        if (!PARALLEL_SAFE_TOOLS.has(tool)) {
          return { idx, tool, ok: false, error: `tool "${tool}" not allowed inside parallel_calls (read-only allowlist only)`, skipped: true };
        }
        return { idx, tool, params: innerParams };
      });
      const runnable = planned.filter(p => !p.skipped);
      const settled = await Promise.allSettled(runnable.map(p =>
        executeAgentTool(p.tool, p.params, context, requestClientTool)
      ));
      // Stitch results back in original input order.
      const results = new Array(callsInput.length);
      let runIdx = 0;
      for (const p of planned) {
        if (p.skipped) {
          results[p.idx] = { tool: p.tool, ok: false, error: p.error };
          continue;
        }
        const r = settled[runIdx++];
        if (r.status === 'fulfilled') {
          const val = r.value;
          if (val && val.error) {
            results[p.idx] = { tool: p.tool, ok: false, error: val.error };
          } else {
            results[p.idx] = { tool: p.tool, ok: true, value: val };
          }
        } else {
          const msg = r.reason && r.reason.message ? r.reason.message : String(r.reason);
          results[p.idx] = { tool: p.tool, ok: false, error: msg };
        }
      }
      const okCount = results.filter(r => r.ok).length;
      const errCount = results.length - okCount;
      return {
        results,
        summary: { total: results.length, ok: okCount, errors: errCount }
      };
    }
    case 'read_workbook': {
      // Try client round-trip for fresh data if available
      if (requestClientTool) {
        try {
          const data = await requestClientTool('workbook.readWorkbook', {
            maxRows: params.maxRows || 80,
            maxCols: params.maxCols || 32,
            includeFormulas: params.includeFormulas !== false
          });
          return {
            activeSheet: data.activeSheet || context?.activeSheet,
            workbookSheets: data.workbookSheets || [],
            selectedRange: data.selectedRange,
            selectedValues: data.selectedValues,
            selectedFormulas: data.selectedFormulas,
            allSheetsData: (data.sheets || []).reduce((acc, s) => {
              acc[s.name] = {
                usedRange: s.usedRange,
                rowCount: s.rowCount,
                columnCount: s.columnCount,
                preview: s.preview || [],
                formulas: s.formulas || []
              };
              return acc;
            }, {})
          };
        } catch (err) {
          logger.warn(`[AgentLoop] Client read failed for read_workbook: ${err.message}. Falling back to static context.`);
        }
      }
      return {
        activeSheet: context?.activeSheet,
        workbookSheets: context?.workbookSheets,
        selectedRange: context?.selectedRange,
        selectedValues: context?.selectedValues,
        usedRangeData: context?.usedRangeData,
        allSheetsData: context?.allSheetsData
      };
    }
    case 'build_workbook_graph': {
      let snapshot = context || {};
      if (requestClientTool) {
        try {
          snapshot = await requestClientTool('workbook.readWorkbook', {
            maxRows: params.maxRows || 160,
            maxCols: params.maxCols || 50,
            includeFormulas: true
          });
        } catch (err) {
          logger.warn(`[AgentLoop] Client read failed for build_workbook_graph: ${err.message}. Falling back to static context.`);
        }
      }
      const result = await executeTool('workbook.buildGraph', {
        snapshot,
        workbookName: params.workbookName,
        source: 'agent_loop'
      }, toolMemory);
      return result.data;
    }
    case 'read_sheet': {
      if (requestClientTool) {
        try {
          const data = await requestClientTool('workbook.readSheet', {
            sheet: params.sheet,
            maxRows: params.maxRows || 200,
            maxCols: params.maxCols || 20
          });
          return {
            sheet: data.sheet || params.sheet,
            usedRange: data.usedRange,
            usedRangeData: data.values || [],
            rowCount: data.rowCount || 0,
            columnCount: data.columnCount || 0
          };
        } catch (err) {
          logger.warn(`[AgentLoop] Client read failed for read_sheet: ${err.message}. Falling back to static context.`);
        }
      }
      // Fallback: try to get data from the specific sheet if available in allSheetsData
      if (params.sheet && context?.allSheetsData && context.allSheetsData[params.sheet]) {
        const sheetData = context.allSheetsData[params.sheet];
        return {
          sheet: params.sheet,
          usedRange: sheetData.usedRange || context?.usedRange,
          usedRangeData: sheetData.preview || [],
          rowCount: sheetData.rowCount || 0,
          columnCount: sheetData.columnCount || 0
        };
      }
      return {
        sheet: params.sheet || context?.activeSheet,
        usedRange: context?.usedRange,
        usedRangeData: context?.usedRangeData,
        rowCount: context?.totalRows || context?.usedRangeSize?.rows,
        columnCount: context?.totalColumns || context?.usedRangeSize?.columns
      };
    }
    case 'get_range_as_csv': {
      // If requestClientTool is available, do a real client-side read
      // Otherwise fall back to static context (read-only agent, no UI open)
      if (requestClientTool) {
        try {
          const data = await requestClientTool('workbook.readRange', {
            sheet: params.sheet,
            target: params.target,
            maxRows: params.maxRows || 0,  // 0 = no limit
            format: 'csv'
          });
          return {
            sheet: data.sheet || params.sheet,
            target: data.target || params.target,
            csv: data.csv || '',
            rowCount: data.rowCount || 0,
            columnCount: data.columnCount || 0,
            truncated: data.truncated || false
          };
        } catch (err) {
          // Fall back to static context if client read fails
          logger.warn(`[AgentLoop] Client read failed for get_range_as_csv: ${err.message}. Falling back to static context.`);
        }
      }
      // Fallback: static context — build CSV from values if available
      let values = context?.selectedValues || context?.usedRangeData || [];
      let sourceSheet = params.sheet || context?.activeSheet;
      let targetRange = params.target || context?.selectedRange;
      let rowCount = values.length;
      let columnCount = values.length > 0 ? values[0].length : 0;

      // Try to get data from the specific sheet if available
      if (params.sheet && context?.allSheetsData && context.allSheetsData[params.sheet]) {
        const sheetData = context.allSheetsData[params.sheet];
        if (sheetData.preview && sheetData.preview.length > 0) {
          values = sheetData.preview;
          sourceSheet = params.sheet;
          targetRange = params.target || sheetData.usedRange;
          rowCount = sheetData.preview.length;
          columnCount = sheetData.preview.length > 0 ? sheetData.preview[0].length : 0;
        }
      }

      // Apply maxRows limit if specified
      const maxRows = Number(params.maxRows) || 500;
      if (values.length > maxRows) {
        values = values.slice(0, maxRows);
        rowCount = maxRows;
      }

      const escapeCsv = (val) => {
        if (val == null) return '';
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      };
      const csv = values.map(row => row.map(escapeCsv).join(',')).join('\n');
      return {
        sheet: sourceSheet,
        target: targetRange,
        csv,
        rowCount,
        columnCount,
        truncated: values.length < rowCount,
        _warning: 'Using stale static context (client read unavailable). Data may be truncated.'
      };
    }
    case 'get_cell_ranges': {
      const ranges = params.ranges || [];
      if (ranges.length === 0) {
        return { ranges: [], _warning: 'No ranges specified' };
      }
      // If requestClientTool is available, batch-read all ranges from client
      if (requestClientTool) {
        const results = [];
        for (const rangeSpec of ranges) {
          try {
            const data = await requestClientTool('workbook.readRange', {
              sheet: rangeSpec.sheet,
              target: rangeSpec.target,
              maxRows: rangeSpec.maxRows || 100,
              format: 'snapshot'
            });
            results.push({
              sheet: data.sheet || rangeSpec.sheet,
              target: data.target || rangeSpec.target,
              values: data.values || [],
              formulas: data.formulas || [],
              rowCount: data.rowCount || 0,
              columnCount: data.columnCount || 0,
              error: null
            });
          } catch (err) {
            results.push({
              sheet: rangeSpec.sheet,
              target: rangeSpec.target,
              values: [],
              formulas: [],
              rowCount: 0,
              columnCount: 0,
              error: err.message
            });
          }
        }
        return { ranges: results };
      }
      // Fallback: extract from static context (allSheetsData or selectedValues)
      logger.warn('[AgentLoop] get_cell_ranges called without client connection. Using static context.');
      const fallbackRanges = [];
      for (const rangeSpec of ranges) {
        const sheetName = rangeSpec.sheet || context?.activeSheet;
        let values = [];
        let formulas = [];
        let rowCount = 0;
        let columnCount = 0;
        let resolvedTarget = rangeSpec.target;

        if (sheetName && context?.allSheetsData && context.allSheetsData[sheetName]) {
          const sheetData = context.allSheetsData[sheetName];
          if (sheetData.preview && sheetData.preview.length > 0) {
            values = sheetData.preview;
            rowCount = sheetData.preview.length;
            columnCount = sheetData.preview.length > 0 ? sheetData.preview[0].length : 0;
            resolvedTarget = rangeSpec.target || sheetData.usedRange;
          }
        } else if (context?.selectedValues && (!rangeSpec.sheet || rangeSpec.sheet === context?.activeSheet)) {
          values = context.selectedValues;
          rowCount = values.length;
          columnCount = values.length > 0 ? values[0].length : 0;
          resolvedTarget = rangeSpec.target || context?.selectedRange;
        }

        fallbackRanges.push({
          sheet: sheetName,
          target: resolvedTarget,
          values,
          formulas,
          rowCount,
          columnCount,
          error: null
        });
      }
      return {
        ranges: fallbackRanges,
        _warning: 'Using stale static context (client read unavailable). Data may be incomplete.'
      };
    }
    case 'create_sheet': {
      return {
        actions: [{ type: 'createSheet', name: params.name }]
      };
    }
    case 'rename_sheet': {
      return {
        actions: [{ type: 'renameSheet', oldName: params.old_name, newName: params.new_name }]
      };
    }
    case 'delete_sheet': {
      return {
        actions: [{ type: 'deleteSheet', name: params.name }]
      };
    }
    case 'duplicate_sheet': {
      return {
        actions: [{ type: 'duplicateSheet', source: params.source, newName: params.new_name || (params.source + ' (copy)') }]
      };
    }
    case 'copy_range': {
      return {
        actions: [{ type: 'copyRange', fromSheet: params.from_sheet, toSheet: params.to_sheet, from: params.from, to: params.to }]
      };
    }
    case 'create_named_range': {
      return {
        actions: [{ type: 'createNamedRange', name: params.name, refersTo: params.refers_to }]
      };
    }
    case 'list_named_ranges': {
      if (requestClientTool) {
        try {
          const data = await requestClientTool('workbook.listNamedRanges', params || {});
          return data;
        } catch (err) {
          logger.warn(`[AgentLoop] Client read failed for list_named_ranges: ${err.message}`);
          return { error: err.message, namedRanges: [] };
        }
      }
      // Fallback: try registry (may fail in agent mode without runtime)
      try {
        const r = await executeTool('workbook.listNamedRanges', params || {}, toolMemory);
        return r.data || r;
      } catch (err) {
        return { error: err.message, namedRanges: [] };
      }
    }
    case 'set_cell_range': {
      // Normalize copyToRange: accept string or {patternCell, range}
      let copyToRange = params.copyToRange;
      if (copyToRange && typeof copyToRange === 'object' && copyToRange.range) {
        copyToRange = copyToRange.range;
      }
      const targetSheet = params.sheet || context?.activeSheet;
      if (!params.sheet) {
        logger.warn(`[AgentLoop] set_cell_range called without 'sheet' param; defaulting to activeSheet="${targetSheet}". LLM should specify sheet explicitly.`);
      }

      // Preflight read: verify target cells are empty before writing (trust UX)
      if (params.allow_overwrite === false && requestClientTool && params.cells && Object.keys(params.cells).length > 0) {
        const bounds = getCellRangeBounds(params.cells);
        if (bounds) {
          try {
            const preflight = await requestClientTool('workbook.readRange', {
              sheet: targetSheet,
              target: bounds,
              format: 'snapshot'
            });
            const values = preflight.values || [];
            const nonEmpty = [];
            for (let r = 0; r < values.length && nonEmpty.length < 5; r++) {
              for (let c = 0; c < values[r].length && nonEmpty.length < 5; c++) {
                const v = values[r][c];
                if (v !== null && v !== undefined && v !== '') {
                  nonEmpty.push({ row: r + 1, col: indexToCol(colToIndex(bounds.match(/^([A-Z]+)/)[1]) + c), value: String(v).slice(0, 50) });
                }
              }
            }
            if (nonEmpty.length > 0) {
              const conflictMsg = `Preflight CONFLICT: ${nonEmpty.length}+ cells in ${targetSheet}!${bounds} already contain data. Use allow_overwrite:true to force, or choose a different range.`;
              logger.warn(`[AgentLoop] ${conflictMsg}`);
              return {
                actions: [],
                _preflight: { conflict: true, range: bounds, sample: nonEmpty },
                _message: conflictMsg
              };
            }
          } catch (err) {
            logger.warn(`[AgentLoop] Preflight read failed for set_cell_range: ${err.message}. Proceeding without check.`);
          }
        }
      }

      return {
        actions: [{
          type: 'setCellRange',
          sheet: targetSheet,
          cells: params.cells,
          copyToRange: copyToRange,
          allow_overwrite: params.allow_overwrite,
          explanation: `Write ${Object.keys(params.cells || {}).length} cells to ${targetSheet}`
        }]
      };
    }
    case 'set_format': {
      const targetSheet = params.sheet || context?.activeSheet;
      if (!params.sheet) logger.warn(`[AgentLoop] set_format without 'sheet'; defaulting to "${targetSheet}".`);
      return {
        actions: [{
          type: 'setCellFormat',
          sheet: targetSheet,
          target: params.target,
          options: params.options
        }]
      };
    }
    case 'execute_excel_formula': {
      const targetSheet = params.sheet || context?.activeSheet;
      if (!params.sheet) logger.warn(`[AgentLoop] execute_excel_formula without 'sheet'; defaulting to "${targetSheet}".`);
      return {
        actions: [{
          type: 'setCellRange',
          sheet: targetSheet,
          cells: {
            [params.target]: {
              formula: params.formula,
              ...(params.note ? { note: params.note } : {})
            }
          }
        }]
      };
    }
    case 'add_chart': {
      const targetSheet = params.sheet || context?.activeSheet;
      if (!params.sheet) logger.warn(`[AgentLoop] add_chart without 'sheet'; defaulting to "${targetSheet}".`);
      return {
        actions: [{
          type: 'createChart',
          sheet: targetSheet,
          target: params.target,
          options: params.options
        }]
      };
    }
    case 'execute_python': {
      return await executePythonCode(params.code);
    }
    case 'web_search': {
      const searchResult = await executeTool('web.search', params || {}, toolMemory);
      return searchResult.data || searchResult;
    }
    case 'web_fetch': {
      const fetchResult = await executeTool('web.fetch', params || {}, toolMemory);
      return fetchResult.data || fetchResult;
    }
    case 'ask_user_question': {
      return {
        type: 'ask_user_question',
        questions: params.questions
      };
    }
    case 'todo_write': {
      return {
        type: 'todo_write',
        todos: params.todos
      };
    }
    case 'execute_office_js': {
      // RPC path: wait for the client to execute and return real values/logs/errors.
      // This avoids the legacy fire-and-forget echo, which forced the LLM to spend
      // extra iterations on read-after-write verification.
      if (requestClientTool) {
        try {
          const rpc = await requestClientTool('runJavaScript', {
            code: params.code
          });
          // rpc shape from client: { ok, value, logs, error }
          if (rpc && rpc.error) {
            return {
              error: rpc.error,
              logs: Array.isArray(rpc.logs) ? rpc.logs : [],
              _message: `execute_office_js error: ${rpc.error}${Array.isArray(rpc.logs) && rpc.logs.length ? `\nLogs:\n${rpc.logs.join('\n').slice(0, 1500)}` : ''}`
            };
          }
          return {
            ok: true,
            value: rpc && Object.prototype.hasOwnProperty.call(rpc, 'value') ? rpc.value : null,
            logs: rpc && Array.isArray(rpc.logs) ? rpc.logs : []
          };
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          // Fall through to legacy fire-and-forget on transport failure
          logger.warn(`[AgentLoop] execute_office_js RPC failed (${msg}); falling back to legacy action dispatch`);
          return {
            actions: [{ type: 'runJavaScript', code: params.code }],
            _message: `execute_office_js dispatched via legacy action (RPC failed: ${msg}). Result values are NOT returned in this path.`
          };
        }
      }
      // Legacy fire-and-forget when no client channel is available (e.g. server-only test harness).
      return {
        actions: [{
          type: 'runJavaScript',
          code: params.code
        }]
      };
    }
    case 'context_snip': {
      // Trigger real context compaction if conversation is too long
      const COMPACT_THRESHOLD = 25;
      if (messages.length > COMPACT_THRESHOLD) {
        const keepCount = 8; // keep last 8 messages for continuity
        const toCompact = messages.slice(1, messages.length - keepCount); // skip system prompt, keep recent
        // Build a summary of compacted messages
        const summaryParts = [];
        for (const m of toCompact) {
          if (m.role === 'assistant') {
            try {
              const parsed = JSON.parse(m.content);
              if (parsed.tool && parsed.tool !== 'done' && parsed.tool !== 'todo_write' && parsed.tool !== 'context_snip') {
                summaryParts.push(`[${parsed.tool}]: ${(parsed.thought || '').slice(0, 80)}`);
              }
            } catch (_) {
              summaryParts.push(m.content.slice(0, 80));
            }
          } else if (m.role === 'user' && m.content.startsWith('Tool result')) {
            // Skip tool results in summary
            continue;
          }
        }
        const summary = summaryParts.length > 0
          ? 'CONVERSATION SUMMARY (compressed ' + toCompact.length + ' messages):\n' + summaryParts.join('\n').slice(0, 2000)
          : '';

        // Replace old messages: keep system prompt + summary + recent messages
        const newMessages = [messages[0]]; // system prompt
        if (summary) {
          newMessages.push(makeUserMessage(summary + '\n\nContinue from where you left off.'));
        }
        newMessages.push(...messages.slice(messages.length - keepCount));
        // Mutate the array in-place
        messages.length = 0;
        messages.push(...newMessages);
        logger.info(`[AgentLoop] Context compacted: ${toCompact.length} messages -> summary (${summary.length} chars). New length: ${messages.length}`);
      }
      return { ok: true, note: `Context snip applied. Messages: ${messages.length}` };
    }
    /* ---------- Bundled finance calls (parallel) ---------- */
    case 'finance_company_bundle': {
      const symbolNorm = normalizeOpenBBSymbolParams(params || {});
      const symbol = symbolNorm.symbol;
      if (!symbol) {
        return { error: 'finance_company_bundle: "symbol" is required' };
      }
      const period = (params && params.period) === 'quarter' ? 'quarter' : 'annual';
      const wanted = Array.isArray(params && params.include) && params.include.length
        ? new Set(params.include)
        : new Set(['profile', 'metrics', 'balance', 'income', 'cashflow']);
      const baseArgs = { ...symbolNorm };
      const periodArgs = { ...symbolNorm, period };
      const datasets = [
        wanted.has('profile')   && ['profile',  () => executeTool('openbb.equity.profile',                 baseArgs,   toolMemory)],
        wanted.has('metrics')   && ['metrics',  () => executeTool('openbb.equity.fundamentals.metrics',    baseArgs,   toolMemory)],
        wanted.has('balance')   && ['balance',  () => executeTool('openbb.equity.fundamentals.balance',    periodArgs, toolMemory)],
        wanted.has('income')    && ['income',   () => executeTool('openbb.equity.fundamentals.income',     periodArgs, toolMemory)],
        wanted.has('cashflow')  && ['cashflow', () => executeTool('openbb.equity.fundamentals.cash',       periodArgs, toolMemory)]
      ].filter(Boolean);
      const settled = await Promise.allSettled(datasets.map(([, fn]) => fn()));
      const out = { symbol, period, errors: {} };
      settled.forEach((res, idx) => {
        const key = datasets[idx][0];
        if (res.status === 'fulfilled') {
          out[key] = (res.value && res.value.data !== undefined) ? res.value.data : res.value;
        } else {
          const msg = res.reason && res.reason.message ? res.reason.message : String(res.reason);
          out.errors[key] = msg;
        }
      });
      if (Object.keys(out.errors).length === 0) delete out.errors;
      return out;
    }
    case 'macro_snapshot': {
      const country = (params && params.country) || 'united_states';
      const wanted = Array.isArray(params && params.include) && params.include.length
        ? new Set(params.include)
        : new Set(['treasury', 'fed_rate', 'cpi', 'gdp', 'unemployment']);
      const datasets = [
        wanted.has('treasury')     && ['treasury',     () => executeTool('openbb.fixedincome.treasury', {}, toolMemory)],
        wanted.has('fed_rate')     && ['fed_rate',     () => executeTool('openbb.fixedincome.effr',     {}, toolMemory)],
        wanted.has('cpi')          && ['cpi',          () => executeTool('openbb.economy.cpi',          { country }, toolMemory)],
        wanted.has('gdp')          && ['gdp',          () => executeTool('openbb.economy.gdp_real',     { country }, toolMemory)],
        wanted.has('unemployment') && ['unemployment', () => executeTool('openbb.economy.unemployment', { country }, toolMemory)]
      ].filter(Boolean);
      const settled = await Promise.allSettled(datasets.map(([, fn]) => fn()));
      const out = { country, errors: {} };
      settled.forEach((res, idx) => {
        const key = datasets[idx][0];
        if (res.status === 'fulfilled') {
          out[key] = (res.value && res.value.data !== undefined) ? res.value.data : res.value;
        } else {
          const msg = res.reason && res.reason.message ? res.reason.message : String(res.reason);
          out.errors[key] = msg;
        }
      });
      if (Object.keys(out.errors).length === 0) delete out.errors;
      return out;
    }
    /* ---------- OpenBB Financial Data ---------- */
    case 'openbb_equity_profile': {
      const r = await executeTool('openbb.equity.profile', normalizeOpenBBSymbolParams(params || {}), toolMemory);
      return r.data || r;
    }
    case 'openbb_equity_metrics': {
      const r = await executeTool('openbb.equity.fundamentals.metrics', normalizeOpenBBSymbolParams(params || {}), toolMemory);
      return r.data || r;
    }
    case 'openbb_equity_balance': {
      const r = await executeTool('openbb.equity.fundamentals.balance', normalizeOpenBBSymbolParams(params || {}), toolMemory);
      return r.data || r;
    }
    case 'openbb_equity_income': {
      const r = await executeTool('openbb.equity.fundamentals.income', normalizeOpenBBSymbolParams(params || {}), toolMemory);
      return r.data || r;
    }
    case 'openbb_equity_cashflow': {
      const r = await executeTool('openbb.equity.fundamentals.cash', normalizeOpenBBSymbolParams(params || {}), toolMemory);
      return r.data || r;
    }
    case 'openbb_treasury_rates': {
      const r = await executeTool('openbb.fixedincome.treasury', params || {}, toolMemory);
      return r.data || r;
    }
    case 'openbb_fed_rate': {
      const r = await executeTool('openbb.fixedincome.effr', params || {}, toolMemory);
      return r.data || r;
    }
    case 'openbb_cpi': {
      const r = await executeTool('openbb.economy.cpi', params || {}, toolMemory);
      return r.data || r;
    }
    case 'openbb_gdp': {
      const r = await executeTool('openbb.economy.gdp_real', params || {}, toolMemory);
      return r.data || r;
    }
    case 'openbb_unemployment': {
      const r = await executeTool('openbb.economy.unemployment', params || {}, toolMemory);
      return r.data || r;
    }
    case 'read_skill': {
      const skillData = readSkill(params && params.name);
      return skillData;
    }
    case 'update_instructions': {
      const result = updateInstructions(params);
      return { data: result, actions: [] };
    }
    case 'read_instructions': {
      const instr = require('../utils/instructions');
      return { data: { content: instr.loadInstructions() }, actions: [] };
    }
    default:
      // Fallback: try registry tool (e.g. yahoo.quote, llm.planLayout, etc.)
      if (registry.has(toolName)) {
        const result = await executeTool(toolName, params || {}, {
          runtime: { requestClientTool: requestClientTool || (async () => { throw new Error('Client tool not available'); }) }
        });
        return result.data || result;
      }
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

/* ---------- Python Execution ---------- */
const { executePython } = require('../tools/python');

async function executePythonCode(code) {
  logger.info(`[Python] Executing code (${code.length} chars)`);
  try {
    const result = await executePython(code);
    return { success: true, result: result.stdout, stderr: result.stderr, code };
  } catch (e) {
    return { success: false, error: e.message, code };
  }
}

module.exports = {
  runAgentLoop,
  TOOL_DEFINITIONS,
  AGENT_SYSTEM_PROMPT,
  getSystemPrompt,
  PROMPT_VARIANTS,
  getCellRangeBounds,
  colToIndex,
  indexToCol,
  resolveAgentLoopModel,
  shouldUseAgentThinking,
  buildToolStagnationSignature,
  detectToolStagnation,
  formatToolStagnationReason,
  executeAgentTool,
  formatToolResultForMessages,
  trimDeepArrays
};
