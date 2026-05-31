# Struttura del progetto

Mappa completa della codebase di Excel AI Agent (~155 file sorgente tracciati).

---

## Root

```
excel/
├── README.md              # Documentazione principale
├── AGENTS.md              # Istruzioni per AI coding agents (Claude, OpenCode)
├── package.json           # Script npm, dipendenze
├── .env.example           # Template variabili d'ambiente
├── manifest.xml           # Office Add-in manifest (sviluppo)
├── manifest.prod.xml      # Office Add-in manifest (produzione)
├── vercel.json            # Deploy Vercel serverless
├── Caddyfile              # Reverse proxy VPS
├── Makefile               # Target dev, build, deploy, certs
├── build.js               # Build esbuild (src/main.js → src/taskpane.bundle.js)
├── start-dev.sh           # Avvio ambiente dev completo
├── stop-dev.sh            # Stop ambiente dev
├── install.sh             # Installer macOS per l'add-in
├── deploy.sh              # Deploy VPS (rsync + pm2)
├── tsconfig.json          # TS config (solo per Remotion video)
│
├── src/                   # Frontend — Office.js task pane
├── server/                # Backend — Node.js + Express
├── skills/                # Skill definitions in Markdown (dcf, lbo, wacc, comps, ...)
├── docs/                  # Documentazione
├── test/                  # Test (unitari + integrazione)
├── api/                   # Vercel serverless entry point
├── bench/                 # Benchmark modelli e runtime
├── scripts/               # Script utility
├── supabase/              # Migrazioni SQL
├── public/                # Landing page, video, installer
├── assets/                # Icone add-in (16, 32, 80 px)
├── videos/                # Remotion video source (TSX)
└── python_bridge/         # Python BrowserUse sidecar
```

---

## `src/` — Frontend

### Entry points

| File | Descrizione |
|------|-------------|
| `main.js` | Entry point: orchestra tutti i componenti UI, API call, SSE streaming, ciclo turn |
| `taskpane.js` | Task pane: modalità classica + agent mode, SSE event handling, code esecuzione |
| `taskpane.html` | HTML del task pane: carica Office.js, Supabase, CSS, componenti UI |
| `taskpane.css` | Fogli stili completi: tema glassmorphism, variabili CSS, componenti |
| `taskpane.bundle.js` | Bundle frontend generato da esbuild (committato) |
| `admin.html` | Dashboard admin: monitor modelli, turn history, metriche, costi |
| `commands.html` | Pagina comandi (richiesta dal manifest Office) |

### `src/api/` — Client API

| File | Descrizione |
|------|-------------|
| `api/agent.js` | API client agente: start, resume, post client response |
| `api/config.js` | Config loader: recupera configurazione modelli dal backend |
| `api/turn.js` | API client turn: start, approve, step, steer |

### `src/excel/` — Interazione Excel

| File | Descrizione |
|------|-------------|
| `excel/context.js` | Sniffer contesto workbook: sheet, range, selezione, anteprima formule |
| `excel/parseTarget.js` | Parser target: `Foglio!A1:B10` → `{sheetName, rangeAddress}` |
| `excel/readers.js` | Operazioni lettura: `readSheetSnapshot`, `readRangeSnapshot`, `readFormatSummary` |
| `excel/sheetOps.js` | Operazioni fogli: `ensureWorksheet` — get o create worksheet |
| `excel/writers.js` | Operazioni scrittura: `enqueueActions`, `executeActions`, `undoLastSnapshot` |

### `src/ui/` — Componenti UI

| File | Descrizione |
|------|-------------|
| `ui/chat.js` | Chat: rendering messaggi, typing indicator, scroll |
| `ui/approvalModal.js` | Modal approvazione: preview azioni, conferma prima di scrivere |
| `ui/codePanel.js` | Pannello codice: visualizza codice Office.js eseguito |
| `ui/executionLog.js` | Log esecuzione: tracing azioni in tempo reale |
| `ui/requestPanel.js` | Pannello richieste: form input utente, domande agente |
| `ui/stepsPanel.js` | Pannello step: visualizza todo list dell'agente |
| `ui/tabs.js` | Navigazione tab: chat, tree, log, code |
| `ui/taskTree.js` | Albero task: visualizza DAG del piano, progress bar, timer |
| `ui/toast.js` | Notifiche toast: success/error/info con auto-dismiss |
| `ui/undoBar.js` | Badge undo: mostra pulsante annulla dopo modifiche |

### `src/store/` — Stato

| File | Descrizione |
|------|-------------|
| `store/state.js` | Stato globale: processing, turn/agent ID, code, event source |
| `store/turnMemory.js` | Memoria turn in localStorage: resume dopo reload |

### `src/utils/`

| File | Descrizione |
|------|-------------|
| `utils/html.js` | Escape HTML, formattazione range, riepilogo matrici |

---

## `server/` — Backend

### `server/` — Entry point

| File | Descrizione |
|------|-------------|
| `server.js` | Express server: CORS, HTTPS, health check, API routing, SSE streaming |

### `server/agents/` — Agenti AI

| File | Descrizione | Righe |
|------|-------------|-------|
| `agentLoop.js` | Loop reattivo con tool calling, streaming, triage routing | 4441 |
| `architect.js` | Genera blueprint (DAG slice) con una singola chiamata LLM | ~400 |
| `architectStepwise.js` | Architect stepwise: avanza un passo per round, supporta onde parallele | ~1000 |
| `conductor.js` | Orchestra esecuzione parallela di specialisti con grafo dipendenze | ~300 |
| `critic.js` | Validazione output: regex formula/A1, conflitti cross-sheet, sanity check | ~150 |
| `narrator.js` | Riepilogo in italiano: fogli modificati, formule scritte, prossimi passi | ~50 |
| `parallelOrchestrator.js` | Orchestratore DAG parallelo: esegue blueprint con workers isolati | ~300 |
| `planner.js` | Legacy — genera piani sequenziali, model routing, analyst depth | 2047 |
| `specialists.js` | Agenti specializzati: layout, formule, formattazione con contesto wiki | ~500 |
| `streaming.js` | SSE streaming manager: broadcast eventi, history replay, heartbeat | ~200 |
| `triage.js` | Classificatore complessità: decide routing (single_agent / architect / deep_plan) | ~150 |

### `server/runtime/` — Turn lifecycle e safety

| File | Descrizione |
|------|-------------|
| `turns.js` | Engine turn: start/step/approve/execute/complete, integrazione agent loop | 3262 |
| `actionPreview.js` | Preview azioni: classifica mutation vs read-only, costruisce anteprima per UI |
| `clientRequests.js` | Gestione richieste client: coda, scadenza per permessi/input/domande |
| `conversationMemory.js` | Memoria conversazione: buffer RAM + persistenza file, compaction via LLM |
| `excelHarness.js` | Profili harness agente: ruoli, permessi, budget per plan/build/scout/format |
| `prefetchPolicy.js` | Classificatore prefetch: quali chiamate tool possono essere prefetchate |
| `safetyLimits.js` | Limiti safety: max task piano, azioni per task, payload, client SSE |
| `undo.js` | Undo azioni: produce inverse per createSheet, createChart, renameSheet, duplicateSheet |
| `undoStack.js` | Undo stack granulare: push/pop snapshot pre-mutazione con redo |

### `server/tools/` — Integrazioni esterne

| File | Descrizione |
|------|-------------|
| `llm.js` | Astrazione provider LLM: DeepSeek (primario), OpenRouter (fallback), streaming, context caching, retry | 918 |
| `registry.js` | Tool registry: schemi JSON per tutti i tool Excel, validazione AJV, dispatch | 1759 |
| `schemas.js` | Schemi condivisi: fogli, range A1, valori cella, opzioni formattazione |
| `web.js` | Web search: Wikipedia, DuckDuckGo, Tavily, Brave, SerpAPI | 535 |
| `yahoo.js` | Yahoo Finance client: quote, storico, fondamentali con cache TTL |
| `openbb.js` | OpenBB terminal: equity, fixed income, economia | 827 |
| `research.js` | Ricerca finanziaria: competitor, industria, equity research |
| `browserAgent.js` | Browser-use sidecar: chiama servizio Python headless Chromium |
| `python.js` | Sandbox Python: spawn subprocess con timeout, cattura stdout/stderr |

### `server/models/` — Modelli finanziari

| File | Descrizione |
|------|-------------|
| `dcfAiBuilder.js` | Builder DCF assistito da AI: costruzione iterativa sezione per sezione |
| `dcfTemplate.js` | Template DCF deterministico: assumptions, WACC, DCF con valori default e formattazione | 1486 |
| `financeModelCatalog.js` | Catalogo modelli: DCF, LBO, M&A, 3-statement, comps, credit, DDM |
| `formatTemplate.js` | Template formattazione: palette colori, number format, bordi |
| `workbookGraph.js` | Grafo dipendenze workbook: riferimenti formule tra fogli/celle |
| `workbookUnderstanding.js` | Comprensione semantica workbook via LLM prima di ogni mutazione |
| `workbookAiSchema.js` | Schema AI workbook: mappa dati a line item finanziari canonici |
| `analystDepth.js` | Playbook analyst depth: workplan strutturato per modelli istituzionali |

### `server/utils/` — Utility

| File | Descrizione |
|------|-------------|
| `logger.js` | Logger Pino: pretty in dev, JSON in produzione |
| `llmTrace.js` | Trace LLM: log strutturato di ogni chiamata (request/response/timing) | 313 |
| `metrics.js` | Metriche uso: file JSONL giornalieri con token, costi, latenze |
| `pricing.js` | Modello prezzi LLM: rate per milione token (DeepSeek V4 Flash/Pro) |
| `clientReadCache.js` | Cache letture client: DataLoader-style, TTL, invalidazione mutazioni |
| `instructions.js` | Preferenze utente persistenti da `docs/user-instructions.md` |
| `sheetParser.js` | Parser dati foglio: scopre automaticamente dati finanziari da matrici Excel | 614 |
| `formatOptions.js` | Normalizzatore opzioni formato: colori, allineamento, font, number format |
| `skillSuggest.js` | Suggeritore skill: rileva keyword (DCF, LBO, comps) e raccomanda preload |
| `executionContext.js` | Contesto esecuzione AsyncLocalStorage: turnId/userId/sessionId |
| `runtimeOutcomeSummary.js` | Riepilogo outcome: scansiona turn completati, estrae metriche |
| `equityIntent.js` | Mappatura azienda→ticker: 100+ aziende con fuzzy matching |
| `toolSearch.js` | Ricerca tool: TF-IDF su nomi/descrizioni tool per selezione |
| `graph.js` | Utilità DAG: livelli dipendenze con DFS e rilevamento cicli |
| `publicUrl.js` | Risoluzione URL pubblico: Vercel, Cloudflare Tunnel, env |

### Altri moduli

| File | Descrizione |
|------|-------------|
| `auth/middleware.js` | Middleware auth: valida JWT Supabase, attacca userId a request |
| `db/init.js` | Inizializzazione SQLite: tabelle turns, metrics, turns_json, WAL mode |
| `supabase/client.js` | Client Supabase server-side per database/query |
| `telemetry/tracker.js` | Telemetria: eventi batched a Supabase con flush 5 secondi |
| `skills/loader.js` | Loader skill: lazy-load file `.md` da `skills/`, cache 5 minuti |
| `wiki/ingest.js` | Ingestione wiki: estrae testo da PDF, chunk, crea pagine knowledge base | 314 |
| `wiki/loader.js` | Loader wiki: carica tutte le pagine markdown dai domini |

---

## `skills/` — Definizioni skill AI

| File | Dominio |
|------|---------|
| `dcf-model.md` | DCF: proiezioni 5 anni, WACC, terminal value, sensitivity |
| `lbo-model.md` | LBO: sources & uses, debt schedule, MOIC, IRR |
| `wacc-model.md` | WACC: CAPM, costo equity/debito, struttura capitale |
| `comps-analysis.md` | Comps: trading comps, precedent transactions, multipli |
| `three-statement.md` | 3-Statement: conto economico, stato patrimoniale, cash flow |
| `business-plan.md` | Business plan: unit economics, revenue, staffing, P&L |
| `formatting-finance.md` | Formattazione investment banking: standard Goldman/JPMorgan |
| `audit-xls.md` | Audit Excel: integrità formule, riferimenti, errori |
| `clean-data.md` | Pulizia dati: anomalie, standardizzazione, deduplicazione |

---

## `docs/` — Documentazione

| File | Descrizione |
|------|-------------|
| `CONTRIBUTING.md` | Guida per contribuire |
| `PROJECT_STRUCTURE.md` | Questo file |
| `deepseek-context-caching.md` | Ottimizzazione caching DeepSeek |
| `user-instructions.md` | Preferenze utente persistenti |
| `system-prompt-analyst.md` | Persona analyst: esplorazione dati, profiling |
| `system-prompt-copilot.md` | Persona copilot: comandi rapidi, single-shot |
| `system-prompt-ib-fast.md` | Persona IB fast: qualità + velocità |
| `system-prompt-ib-grade.md` | Persona IB grade: investment banking istituzionale |
| `system-prompt-har.md` | Snapshot raw prompt Claude (da HAR) |
| `claude-excel-system-prompt.md` | Reverse-engineering prompt Claude for Excel |
| `architecture/multi-agent-conductor.md` | Architettura conductor multi-agente |
| `architecture/saas-roadmap.md` | Roadmap SaaS: tier 0-6, gap analysis |
| `wiki/WISHLIST.md` | Lista libri per arricchire knowledge base |
| `wiki/accounting/` | Knowledge base contabilità (schema, index) |
| `wiki/excel/` | Knowledge base Excel (formule, tecniche, workbook understanding) |
| `wiki/finance/` | Knowledge base finanza (DCF, WACC, beta, CAPM, terminal value) |

---

## `test/` — Test

| File | Modulo testato |
|------|---------------|
| `test/unit/test_triage.js` | Triage: classificazione, validazione, fallback |
| `test/unit/test_architect.js` | Architect: blueprint, validazione, estrazione JSON |
| `test/unit/test_architect_stepwise.js` | Architect stepwise: init, advance, collect batch |
| `test/unit/test_parallel_orchestrator.js` | Orchestrator parallelo: DAG, onde, isolamento failure |
| `test/unit/test_agent_step.js` | Agent step: init run, step con LLM mockato |
| `test/unit/test_stepwise_turn.js` | Stepwise turn: risoluzione engine, safety rollout |
| `test/unit/test_dcf_backend.js` | DCF backend: planner, template, AI builder, format, critic |
| `test/unit/test_workbook_graph.js` | Grafo workbook: estrazione riferimenti, classificazione fogli |
| `test/unit/test_finance_bundle.js` | Finance bundle: stubbing tool registry |
| `test/unit/test_action_preview.js` | Action preview: classificazione mutation |
| `test/unit/test_runtime_safety.js` | Safety limits: piani, azioni, stagnazione |
| `test/unit/test_runtime_outcomes.js` | Outcome summary: scan turn, metriche |
| `test/unit/test_bulk_setup.js` | Bulk setup: create/delete multipli fogli |
| `test/unit/test_bulk_write_format.js` | Bulk write + format: stili, merge, protezione overwrite |
| `test/unit/test_client_read_cache.js` | Client read cache: hit/miss, invalidazione, TTL |
| `test/unit/test_parallel_calls.js` | Chiamate parallele: step con più tool call |
| `test/unit/test_tool_result_size_cap.js` | Tool result cap: troncamento, trim array |
| `test/unit/test_execute_office_js_rpc.js` | Execute Office.js RPC: serializzazione, errori |
| `test/unit/test_llm_trace.js` | LLM trace: write/read/summarize, cap content |
| `test/unit/test_schema_drift.js` | Schema drift: allineamento lato LLM vs registry |
| `test/unit/test_preflight.js` | Preflight: bounds range, conversioni colonna, conflitti |
| `test/unit/test_production_manifest.js` | Manifest produzione: URL rewrite, base URL inference |
| `test-backend.js` | Integrazione backend: health check, planner fast-path |
| `test-e2e-mock-client.js` | E2E mock: simula client Excel per turn DCF |
| `test-llm-fallback.js` | Fallback LLM: stream timeout, retry |

---

## `bench/` — Benchmark

| File | Descrizione |
|------|-------------|
| `agent_e2e.js` | Benchmark agent loop end-to-end |
| `dcf_e2e.js` | Latenza planner DCF p50/p95 |
| `llm_plan_compare.js` | Confronto A/B modelli su planner |
| `model_cost_quality.js` | Costo/qualità modelli flash vs pro |
| `model_cost_quality_report.js` | Report cross-config costo/qualità |
| `runtime_mode_compare.js` | Confronto planned_dag vs agent_loop |
| `scenarios_complex.js` | Definizioni scenario benchmark complessi |
| `progress.js` | Dashboard progress live |
| `sweep_models.sh` | Sweep automatico flash/pro x thinking |

---

## `scripts/`

| File | Descrizione |
|------|-------------|
| `analyze-llm-traces.js` | Analisi trace LLM: summary latenza/costo/token |
| `build-production-manifest.js` | Genera manifest Office per HTTPS production |

---

## `supabase/` — Migrazioni

| File | Descrizione |
|------|-------------|
| `001_schema.sql` | Schema core: tabelle turns, events, metrics, api_keys con RLS |
| `002_add_full_json_to_turns.sql` | Aggiunge colonna `full_json JSONB` per state hydration serverless |
| `003_create_admin_user.sql` | Crea utente admin demo con password bcrypt |

---

## `python_bridge/`

| File | Descrizione |
|------|-------------|
| `browseruse_server.py` | Server FastAPI per browser-use: headless Chromium autonomo | 195 |
| `start_browseruse.sh` | Script avvio sidecar con dipendenze e Playwright |

---

## `videos/src/` — Remotion (video marketing)

| File | Descrizione |
|------|-------------|
| `index.ts` | Entry point Remotion |
| `Root.tsx` | Definizione composizioni (5 video) |
| `HeroBackground.tsx` | Sfondo animato: griglia noise con overlay glowing |
| `LogoAnimation.tsx` | Animazione logo: reveal con spring e glow pulse |
| `TerminalDemo.tsx` | Demo terminale: prompt/azione/output per video prodotto |
| `UseCaseSlides.tsx` | Slide use case: contabilità, reporting, tax, controllo, riconciliazione |
