# PIANO MASTER — Excel AI Agent
*Roadmap completa per harness multi-agente specializzato Excel (model-agnostic, financial modeling + data analysis).*

> Documento operativo. Ogni fase è incrementale, testabile in isolamento e non blocca le altre. Le priorità sono ordinate per **rapporto valore/sforzo**.

---

## 0. TL;DR

L'add-in oggi funziona ma soffre di tre problemi fondamentali:

1. **Catena LLM seriale** (Planner → Layout → Formula → Format = 4 round-trip) ⇒ latenza 60–280 s.
2. **Multi-agente "finto"**: i sub-agenti sono solo prompt diversi sullo stesso modello, senza divisione di responsabilità verificabile, senza validator, senza retry strutturato.
3. **Frontend monolitico** (`taskpane.js` ~1450 righe) e **runtime non persistente** (memoria conversazione in-process, niente undo, niente telemetria).

Obiettivo: trasformare il prodotto in un **harness multi-agente "model-agnostic"** stile Claude for Excel con:

- Latenza p50 < 25 s per modelli finance, < 5 s per task semplici.
- Precisione: zero formule rotte sul foglio (validator + retry).
- Generalità: oltre al finance, copre data analysis, pivot, charting, what-if, cleanup, explain.
- Switchabile tra OpenRouter, OpenCode, OpenAI compat (e in prospettiva Anthropic) senza toccare il codice.

---

## 1. Architettura attuale (audit)

### 1.1 Layer fisici

```
Excel Desktop / Online
   │  Office.js
   ▼
src/taskpane.{html,js,css}        ← UI monolitica, gestisce SSE + Office.run
   │  fetch + EventSource
   ▼
server/server.js                  ← Express, /api/turn/* + SSE
   │
   ├── runtime/
   │     turns.js                 ← stato turn, persistenza JSON debounced
   │     conversationMemory.js    ← sliding window 5 turn (in-process)
   │     actionPreview.js         ← preview diff per approvazione
   │     clientRequests.js        ← waiter/sweeper richieste verso il client
   │
   ├── agents/
   │     planner.js               ← LLM planner + fast-path deterministico + heuristic fallback
   │     specialists.js           ← LayoutAgent / FormulaAgent / FormatAgent (LLM, prompt diversi)
   │     streaming.js             ← SSE store con history/heartbeat
   │
   ├── tools/
   │     registry.js              ← tool dispatcher (excel.*, workbook.*, llm.*, yahoo.*)
   │     llm.js                   ← unified call: opencode / openrouter / openai-compat (+ stream)
   │     yahoo.js                 ← yahoo-finance2 con cache TTL
   │
   └── utils/
         graph.js                 ← computeLevels (topological)
         logger.js                ← file log buffered
```

### 1.2 Flusso di un turn

```
UI: POST /api/turn/start ──► turns.startTurn ──► planTurn (async)
                                  │
                                  ├─ planner.plan()
                                  │     ├─ fast-path deterministico (regex su keyword)
                                  │     ├─ LLM streaming (planner)
                                  │     └─ retry x3 → fallback heuristic
                                  │
                                  ├─ auto-execute task safe livello 0 (yahoo.* / workbook.read*)
                                  │
                                  └─ status = awaiting_approval ──► UI mostra piano

UI: POST /api/turn/approve ──► executeTurn
                                  │
                                  └─ per livello topologico (parallelo intra-livello):
                                        ├─ executeTool → specialista LLM
                                        ├─ se action mutation: requestActionPermission (approval)
                                        └─ emit taskActions → UI esegue Excel.run
```

### 1.3 Provider LLM

- `tools/llm.js` astrae 3 provider, supporta cachePrompt OpenRouter (`cache_control: ephemeral`), streaming via SSE per OpenRouter/OpenAI, NON per OpenCode.
- `.env` attuale punta a `deepseek/deepseek-v4-flash` mentre il README dice `moonshotai/kimi-k2.6` ⇒ **drift di config da risolvere subito** (Fase 0).

### 1.4 Stato persistenza

- `server/turns/turn-*.json` salvati con debounce 200 ms; flush sincrono su stato terminale.
- `conversationMemory` solo in RAM, persa al restart del server.
- Nessun database, nessun multi-utente.

---

## 2. Bottleneck e debiti tecnici

| # | Problema | Impatto | Dove |
|---|----------|---------|------|
| B1 | Catena LLM sequenziale tra specialisti | latenza 30-60 s extra | `runtime/turns.js` `executeTurn` |
| B2 | FormulaAgent unico per modello completo (no chunking) | output enorme, parse fragile, retry costoso | `agents/specialists.js` runFormulaAgent |
| B3 | Plan-cache key è lowercased objective + sheet list | invalida su minimo rephrasing | `agents/planner.js` getPlanCacheKey ✅ normalizzato con strip punteggiatura |
| B4 | OpenCode non streamma (callOpenCodeAI bufferizza) | il planner streaming si attiva solo su OpenRouter | `tools/llm.js` callLLMStreaming |
| B5 | Nessun validator delle formule generate | formule rotte vanno a Excel ⇒ #REF, #NAME | tutto FormulaAgent ✅ critic.js validatore deterministico integrato in executeSingleTask |
| B6 | `executeActions` non raggruppa scritture per sheet | round-trip Office.js inutili | `taskpane.js` executeActions |
| B7 | Prompt specialisti includono `compactResultsForPrompt` JSON-stringify | token spesi in contesto ridondante | `specialists.js` ✅ usesResults filtra risultati rilevanti (Quick Win 3) |
| B8 | Sweeper `clientRequests.js` 60 s troppo lento per timeout brevi | richieste che restano "appese" | `runtime/clientRequests.js` ✅ ridotto a 5s, MAX_PENDING_AGE_MS configurable |
| B9 | `taskpane.js` 1446 righe non modulare | bug cross-feature, no test | `src/taskpane.js` |
| B10 | Tool registry: inputs come stringhe descrittive (no JSON Schema) | LLM non ha contratto stretto, parametri liberi | `tools/registry.js` ✅ v2 con JSON Schema (ajv) su 17 tool
| B11 | Drift `.env` (deepseek vs kimi) | risposte inconsistenti | `.env` ✅ allineato deepseek + creato .env.example |
| B12 | Nessuna telemetria latenza/token/success | impossibile ottimizzare evidence-based | ovunque |
| B13 | Nessun undo lato Excel | errori = pulizia manuale dell'utente | runtime |
| B14 | Conversation memory in-process | restart server azzera contesto | `conversationMemory.js` |
| B15 | `agent-mode-check` keyword-based | falsi positivi/negativi, UX fragile | `taskpane.js` shouldUseAgentMode |
| B16 | SSE replay invia TUTTI gli eventi a riconnessione (anche batch già processati) | duplicazioni gestite a mano con `handledRequestIds` | `agents/streaming.js` |

---

## 3. Obiettivi misurabili

| KPI | Oggi (stimato) | Target Fase 2 | Target Fase 4 |
|-----|----------------|---------------|---------------|
| Latenza p50 — comando semplice (es. "colora di rosso negativi") | 8–15 s | < 4 s | < 2 s |
| Latenza p50 — DCF nuovo | 170–280 s | < 60 s | < 25 s |
| Latenza p95 — DCF nuovo | 280 s+ | < 100 s | < 50 s |
| % formule generate corrette al primo tentativo | sconosciuto | > 85% | > 95% |
| % turn completati senza intervento utente | sconosciuto | > 70% | > 85% |
| Token / DCF (planner+specialisti) | ~12-18k | < 8k | < 5k |
| Switch provider senza modifiche codice | parziale | sì | sì |
| Undo turn | no | parziale | sì |

---

## 4. Roadmap per fasi

> Ogni fase elenca: **goal**, **tasks**, **deliverable**, **rischio**, **come testare**.

### FASE 0 — Fix immediati (giornata 1)

**Goal**: rimuovere drift di config e bug palesi che bloccano misurazione.

**Tasks**:

- [x] **F0.1** Allineare `.env` ↔ README: scelto `deepseek/deepseek-v4-flash`, aggiornato README, creato `.env.example` autoritario.
- [x] **F0.2** Aggiungere `MODEL_PRIMARY` / `MODEL_FAST` / `MODEL_VALIDATOR` separati nel `.env` (preludio Fase 4).
- [x] **F0.3** `tools/llm.js`: emettere `usage` (prompt_tokens, completion_tokens) nel return per OpenRouter/OpenAI; allegato come `_usage` sull'oggetto risultato.
- [x] **F0.4** `tools/llm.js` callOpenRouterAIStream: aggiunto `response_format: { type: 'json_object' }` sui modelli che lo supportano.
- [x] **F0.5** `tools/llm.js`: `response_format` reso opzionale via `LLM_JSON_MODE` env var (default `true`) — protegge provider senza JSON mode.
- [x] **F0.6** Logger: aggiunto `LOG_LEVEL` (error/warn/info/debug). Console.log di `specialists.js` spostati su `logger.info`. File log scrive sempre tutti i livelli.
- [x] **F0.7** `runtime/clientRequests.js`: `SWEEP_INTERVAL_MS` ridotto a 5 s, `MAX_PENDING_AGE_MS` configurabile via env.
- [x] **F0.8** Pulire `server/turns/turn-*.json` su startup oltre `MAX_TURN_FILES` (default 100). Aggiunto `cleanOldTurns()` in `server.js`.
- [x] **F0.9** `package.json`: pinnate versioni esatte, aggiunto `"engines": { "node": ">=18.17" }`.

**Deliverable**: branch `phase-0/cleanup`, config sano, log strutturato.

**Rischio**: basso. Nessuna modifica architetturale.

**Test**: avviare server, fare 3 richieste (semplice, finance, repair), verificare che `usage` compaia nei log.

---

### FASE 1 — Harness multi-agente solido ✅

**Goal**: trasformare i "sub-agent specialisti" da prompt-different a veri ruoli con responsabilità verificabili e contratto schema-typed.

#### 1.1 Tool Registry v2 con JSON Schema ✅

`server/tools/registry.js` esteso con:

```js
registerTool('excel.createSheet', handler, {
  description: '...',
  schema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 31, pattern: '^[^\\\\/?*\\[\\]:]+$' },
      position: { type: 'integer', minimum: 0 }
    }
  },
  outputSchema: { type: 'object', properties: { sheetName: { type: 'string' } } },
  category: 'mutation',           // mutation | read | analysis | external
  costHint: 'low',                // low | medium | high
  requiresApproval: 'auto'        // auto | always | never
});
```

Motivazioni:

- Il **planner** può iniettare nel system-prompt `JSON.stringify(allToolSchemas)` e usare `tool_use` (Anthropic) o `tools` (OpenAI). Niente più tool name liberi.
- Il **runtime** valida i `params` prima di eseguire (Ajv). Risparmiato un giro a vuoto su parametri storti.
- L'UI sa quali tool esistono e può offrire suggerimenti diretti senza LLM.

#### 1.2 Catalogo agenti definitivo

| Agente | Responsabilità | Tool che orchestra | Modello consigliato |
|--------|----------------|--------------------|---------------------|
| **Orchestrator (Planner)** | scompone l'obiettivo in task DAG, sceglie agenti | meta — produce `tasks[]` | reasoning forte (es. Sonnet 4.6 / Kimi K2.6 / GPT-4.1) |
| **DataAgent** | recupera dati esterni / legge workbook | `yahoo.*`, `workbook.read*`, futuro `web.fetch`, `csv.parse` | model fast |
| **LayoutAgent** | progetta cellMap, sezioni, fogli, naming | output: layout JSON | reasoning medio |
| **FormulaAgent** | scrive formule per *una* sezione (chunked) | output: `{actions:[{type:runFormula,...}]}` | reasoning forte (formule = critico) |
| **FormatAgent** | stile finance / tabella / pivot | output: `{actions:[{type:setCellFormat,...}]}` | model fast |
| **AnalystAgent** | spiega un foglio, suggerisce KPI, anomalie | read-only, output testuale + chart suggerito | reasoning medio |
| **CriticAgent** | valida output FormulaAgent (sintassi + ref + dimensioni) | non LLM se possibile, fallback LLM | model fast |
| **NarratorAgent** | risposta finale in chat ("ho creato X, Y, Z") | model fast |

#### 1.3 Critic / Validator (FORMULA)

Nuovo `server/agents/critic.js`. **Non LLM in prima istanza** — validatore deterministico:

1. Parser AST formule via libreria (`formula-parser` / `hot-formula-parser` / scrivere mini-parser).
2. Check: ogni `=...` finisce coerentemente, parentesi bilanciate, riferimenti `Sheet!A1` esistono nel piano del LayoutAgent.
3. Se la formula referenzia un range non ancora dichiarato dal LayoutAgent ⇒ errore strutturato.
4. Se valida ⇒ pass-through.
5. Se non valida ⇒ ritorna `{ok:false, errors:[...]}` al runtime → retry FormulaAgent con system-prompt arricchito dagli errori (max 2 retry).

#### 1.4 Approvazione "smart"

Oggi: ogni task con mutation chiede approval. UX rumorosa.

Nuovo:

- Approvazione **per turn** (default), non per task.
- Eccezioni: task marcati `requiresApproval:'always'` (es. `excel.deleteSheet`, `workbook.clear`) restano per-task.
- Diff aggregato a livello di turn nel pannello iniziale, non popup ripetuti.

**Deliverable**:
- [x] `server/tools/registry.js` v2 con `schema` JSON su tutti i 17 tool esistenti (ajv@8.17.1).
- [x] `server/agents/critic.js` — validatore deterministico: sintassi, parentesi, rif. A1, sheet noti, funzioni Excel.
- [x] `server/agents/narrator.js` — sintesi turn in linguaggio naturale (LLM + fallback deterministico).
- [x] `runtime/turns.js`: hook `validateTaskOutput(result, layout)` prima di emit `taskActions`.
- [x] `runtime/turns.js`: smart approval — `requiresApproval` dal registry (`always`/`auto`/`never`) + categoria `read`.
- [x] Nuovi env: `CRITIC_STRICT` (rigoroso su funzioni sconosciute), `NARRATOR_TIMEOUT_MS`.

**Rischio**: verificato basso. Registry v2 retrocompatibile (export invariato `{ executeTool, tools, registry }`). Critic non blocca l'esecuzione, solo warning su log.

---

### FASE 2 — Performance (parallelismo + streaming + cache)

**Goal**: portare DCF da ~3 minuti a < 60 s.

#### 2.1 Chunking FormulaAgent ✅

**Stato**: IMPLEMENTATO

Oggi: `params.section: 'full_model'` → un solo LLM call enorme.

Nuovo: il planner emette **un task FormulaAgent per sezione**. Tutti i task formula hanno solo deps su layout + createSheet, quindi eseguono **in parallelo** allo stesso livello topologico.

Modifiche:
- `planner.js`: system prompt aggiornato con regola chunking + esempio task graph per-sezione; fallback DCF plan emette 6 task formula (t6-t11) invece di 1
- `specialists.js`: `runFormulaAgent` usa `FORMULA_SECTION_SYSTEM_PROMPT` e timeout ridotto (25s vs 45s) quando `params.section !== 'full_model'`
- `compactResultsForPrompt`: accetta `usesResults` per filtrare solo risultati rilevanti (Quick Win 3)
- Sezioni DCF di default: `assumptions.inputs`, `wacc.wacc_calc`, `dcf.revenue_proj`, `dcf.fcf_proj`, `dcf.terminal_value`, `dcf.enterprise_value`
- Stima: 6 task × ~8s paralleli ≈ 8-12s totali invece di 1 × 35s

**Rischio**: medio. Concurrency satura LLM provider (6 chiamate simultanee). Monitorare rate limit.

**Test**: Eseguire DCF AAPL con il nuovo fallback plan, verificare topologia livelli e tempo totale.

#### 2.2 Pipelining Layout → Formula

Oggi Format aspetta che Formula finisca tutti i chunk. In realtà:

- Formato di **header / colonne / numberFormat** dipende solo dal Layout (sezioni dichiarate).
- Formato **condizionale** dipende dal Formula (range con valori reali).

Splittare FormatAgent in `format.headers` (parallelo a Formula) + `format.conditional` (deps Formula).

#### 2.3 Streaming OpenCode (B4)

OpenCode espone `/session/:id/message` non-streaming oggi. Verificare se supporta `?stream=true` o eventsource — altrimenti **emettere progress fake** dal server (es. ping ogni 2 s con il bytes accumulati dal `axios` stream se possibile, in alternativa solo "thinking..." UX).

#### 2.4 Plan cache più intelligente (B3)

Sostituire chiave string-based con embedding semantico:

- Locale: hash MinHash su tokens dell'obiettivo + sheet list. Lookup approssimato.
- Remoto (futuro): vector store (Postgres pgvector / Chroma).
- TTL 30 min su cache esatte, 10 min su cache fuzzy.

#### 2.5 Riduzione token specialisti (B7)

`compactResultsForPrompt`: oggi serializza JSON di tutti i `results` precedenti. Sostituire con **selezione esplicita**: i task dichiarano `usesResults: ['t1','t3']` e il runtime passa solo quelli, già filtrati per dimensione.

#### 2.6 Batch Office.js (B6)

`taskpane.js` `executeActions`:

- Raggruppa `setCellFormat` contigui sullo stesso sheet+range adiacente.
- Una sola `context.sync()` per batch (oggi una a fine).
- Pre-load di tutti gli `Excel.ChartType` in init.

#### 2.7 Prefetch durante approvazione

Mentre l'utente legge il piano e clicca "Esegui", il server può:

- Lanciare in background i task **read-only del livello 1** (oggi solo livello 0).
- Pre-warmare la session OpenCode (`/session POST` se assente).

#### 2.8 Pruning history SSE

Mantenere solo gli eventi *replay-utili* (`turnStarted`, `planUpdated`, `itemCompleted` finale, `turnAwaitingApproval`, `pendingRequest` non risolte). Evita di ri-mandare 200 log a riconnessione.

**Deliverable**:
- [x] `agents/planner.js`: system prompt aggiornato, fallback DCF chunked (t6-t11)
- [x] `agents/specialists.js`: `runFormulaAgent` section-aware, `FORMULA_SECTION_SYSTEM_PROMPT`, timeout 25s sezioni
- [x] `agents/specialists.js`: `compactResultsForPrompt` filtra `usesResults` (Quick Win 3)
- [x] Nuovi env: `FORMULA_SECTION_TIMEOUT_MS` (25000), `FORMULA_SECTION_FALLBACK_TIMEOUT_MS` (18000)
- [ ] `agents/streaming.js`: history pruning
- [ ] `tools/llm.js`: streaming OpenCode (best effort)
- [ ] benchmark script `bench/dcf_e2e.js`

**Rischio**: medio. Parallelismo aumenta race su `runtime.results`. Aggiungere lock per `_dedupCache`.

**Test**:
- Bench: DCF AAPL 5 run, p50 e p95.
- Profilo: `clinic.js flame` su `executeTurn`.

---

### FASE 3 — Precisione + self-correction

**Goal**: portare la % di output corretto al primo colpo > 95%.

#### 3.1 Loop critic → retry (estesa Fase 1)

```
FormulaAgent → CriticAgent
   ok    → emit
   error → FormulaAgent (system_prompt += errors) [retry max 2]
   error → fallback: chiede input utente con preview formule rotte
```

#### 3.2 Schema validation runtime

Ogni `result.actions[]` validato contro `actionSchema` prima di entrare in coda Excel:

- `setCellValue.target` deve matchare A1 regex.
- `runFormula.value` deve iniziare con `=`.
- `fillRange.value` deve essere matrice 2D.
- `createChart.options.chartType` deve essere in `Excel.ChartType` enum.

#### 3.3 Conversation memory persistente (B14)

`conversationMemory.js`:

- Persistere su `server/memory/{userId}/conversation.json` (oggi non c'è auth → singolo profilo `default`).
- Compaction automatica quando supera 20 turn (riassunto LLM dei più vecchi).
- API: `getRelevantMemory(objective)` che filtra per similarità invece di restituire ultimi 5.

#### 3.4 Undo turn (B13)

Prima di applicare `taskActions` su Excel, salvare in `turn.undo.snapshots` il valore corrente delle celle target. Endpoint `POST /api/turn/:id/undo`:

- Riapplica gli snapshot in ordine inverso.
- Se il foglio è stato creato dal turn, lo elimina (con conferma).

Vincolo: snapshot solo per `setCellValue/runFormula/fillRange/writeRange` con range dichiarato. `createChart` undo = `chart.delete()`.

#### 3.5 Disambiguazione "agent mode" (B15)

Sostituire keyword-match con **mini-classificatore deterministico**:

- Se l'obiettivo include nomi-azione semplici (`colora`, `somma`, `media`, `evidenzia`) e cita celle esplicite (`A1:B10`) → fast-path no-LLM (azione diretta).
- Se include keyword finance OR il piano risultante avrebbe > 3 task → agent mode.
- Sennò → un solo LLM call con tool_use libero (single-shot).

#### 3.6 Few-shot library

`server/agents/examples/` con ~30 esempi cherry-picked di:
- request → plan
- request → formule corrette
- request → formato

Iniettati come few-shot dinamici (cosine similarity sull'obiettivo).

**Deliverable**:
- `agents/critic.js` espanso.
- `agents/examples/` con seed iniziale.
- `runtime/undo.js`.
- API undo + UI button.

**Rischio**: medio-alto. Snapshot diff può essere pesante su range grandi.

**Test**: regression suite in `test/regressions/` con 20 turn registrati (input + expected actions diff).

---

### FASE 4 — UX e modularizzazione frontend

**Goal**: rendere il taskpane manutenibile e introdurre il concetto di "modello per task".

#### 4.1 Bundle frontend con esbuild (già dep)

`build.js` esiste ma non è usato per il taskpane. Estrarre `src/taskpane.js` in moduli:

```
src/
├── taskpane.html
├── taskpane.css
├── main.js                       (entrypoint Office.onReady)
├── ui/
│   ├── chat.js                   (addMessage, log buffer)
│   ├── agentPanel.js             (taskTree render, status update)
│   ├── requestPanel.js           (permission/userInput modali)
│   └── actionsPreview.js
├── excel/
│   ├── context.js                (getExcelContext)
│   ├── readers.js                (readWorkbookSnapshot, readSheet, readRange)
│   ├── writers.js                (executeActions split per tipo)
│   └── parseTarget.js
├── api/
│   ├── turn.js                   (start/approve/respond)
│   └── sse.js                    (openEventStream con auto-reconnect)
└── store/
    └── turnState.js              (currentTurnId, plan, queue)
```

Build target ES2020, output `dist/taskpane.bundle.js`. `manifest.xml` referenzia `dist/`.

#### 4.2 Selettore modello in UI

Nuovo dropdown nel pannello header:

- "Auto" (planner = forte, specialisti = fast)
- "Velocità" (tutto = fast)
- "Precisione" (tutto = forte)
- "Custom..." (override per agente, salvato in localStorage)

Server endpoint `GET /api/models` ritorna lista modelli configurati lato `.env` (whitelist) per popolare il dropdown.

#### 4.3 Pannello "Spiega" (AnalystAgent)

Pulsante "Spiega questo foglio" che invia automaticamente:

```
{
  message: "Spiega il foglio attivo, evidenzia anomalie, suggerisci 3 KPI mancanti.",
  context: <full sheet snapshot>
}
```

Risultato: testo + suggerimenti azione cliccabili (one-click apply).

#### 4.4 Cronologia turn

Nuovo tab "Storia": lista turn passati (da `server/turns/`) con:
- objective
- status
- duration
- pulsante "Re-run con stessi parametri"
- pulsante "Undo"

#### 4.5 Indicatori di costo

Mostrare in tempo reale token usati e costo stimato (tabella prezzi statica per modello).

**Deliverable**:
- Frontend bundled, < 200 KB gzipped.
- Selettore modello funzionante.
- Tab storia.

**Rischio**: medio. Cambia il caricamento (assicurare cache-busting in dev).

**Test**: Lighthouse + smoke test manuali Excel Desktop + Excel Online.

---

### FASE 5 — Generalizzazione: data analysis oltre il finance

**Goal**: l'agente non serve solo per DCF/WACC/LBO. Diventa Excel-generalist.

#### 5.1 Nuovi tool

| Tool | Descrizione | Prima istanza |
|------|-------------|---------------|
| `data.profile` | profilo statistico (count, nulls, dtype, min/max/mean/std) di un range | server (no LLM) |
| `data.detectTable` | identifica header riga, tipo colonne, primary key | server eur/server LLM |
| `data.pivot` | crea PivotTable Excel da range + righe/colonne/valori | client Office.js |
| `data.sortFilter` | applica AutoFilter / Sort | client |
| `chart.recommend` | dato un range, suggerisce 3 chart types con motivo | LLM |
| `formula.explain` | spiega in italiano una formula selezionata | LLM |
| `formula.fix` | analizza #REF/#NAME/#VALUE in selezione e propone fix | LLM + critic |
| `cleanup.detect` | trova merged cells inutili, righe vuote, header duplicati | server |
| `whatIf.scenario` | crea Scenario Manager da assumption set | client |

Tutti registrati in `tools/registry.js` v2 con schema. Il planner aggiorna prompt automaticamente perché legge il registry dinamico.

#### 5.2 Capability-based prompting

Nel system prompt del planner, sostituire la lista hardcoded di tool con:

```
TOOL DISPONIBILI:
${tools.list().map(name => `- ${name}: ${tools.meta(name).description}`).join('\n')}
```

Così aggiungere un tool = registrarlo, niente prompt da editare.

#### 5.3 Modes

L'utente può attivare modi top-level che cambiano il system prompt del planner:

- `mode: finance` (oggi implicito)
- `mode: analyst` (data exploration, niente formule WACC)
- `mode: cleanup` (refactoring foglio esistente)
- `mode: copilot` (single-shot, no piano)

Persistito in localStorage.

**Deliverable**:
- 9 nuovi tool in `tools/data.js`, `tools/chart.js`, `tools/formula.js`.
- Seed di esempi few-shot per ognuno.
- Toggle modalità in UI.

**Rischio**: basso. I nuovi tool sono additive.

**Test**: 10 dataset finti (CSV → import) con task di analisi.

---

### FASE 6 — Telemetria, testing, observability

**Goal**: misurare e prevenire regressioni.

#### 6.1 Telemetria server

Nuovo `server/utils/metrics.js`:

- Per ogni LLM call: provider, model, label, latency_ms, prompt_tokens, completion_tokens, success, retry_count.
- Per ogni turn: total_duration_ms, task_count, mutation_count, approval_required.
- Per ogni tool: latency_ms, errors.
- Persistenza JSON-lines in `server/metrics/YYYY-MM-DD.jsonl`.
- Endpoint `GET /api/metrics/summary?since=...` che aggrega.

Aggiungere panel di debug `/debug/metrics` (HTML statico).

#### 6.2 Test suite

```
test/
├── unit/
│   ├── critic.test.js
│   ├── graph.test.js
│   ├── llm-providers.test.js   (mocked axios)
│   └── registry-schema.test.js
├── integration/
│   ├── turn-lifecycle.test.js
│   └── planner-fastpath.test.js
└── e2e/
    └── (Playwright headed Excel Online — opzionale)
```

Framework: `node --test` (built-in) o `vitest`. Nessun framework grosso.

#### 6.3 Lint + type hints

- Aggiungere `jsconfig.json` con `checkJs: true`.
- JSDoc tipizzato sui module pubblici di `runtime/`, `agents/`, `tools/`.
- Pre-commit hook (`husky` o `simple-git-hooks`) con `eslint --max-warnings=0`.

#### 6.4 CI

`.github/workflows/test.yml`: install + test + bench (smoke). Niente deploy.

**Deliverable**:
- 60+ unit test.
- Metrics dashboard funzionante.
- CI verde.

**Rischio**: basso.

**Test**: meta — il test del fatto che ci siano test.

---

## 5. Specifica tecnica: Tool Registry v2

`server/tools/registry.js` rifattorizzato:

```js
const Ajv = require('ajv');
const ajv = new Ajv({ removeAdditional: 'failing', useDefaults: true, coerceTypes: 'array' });

class ToolRegistry {
  register(name, handler, definition) {
    if (!definition.schema) throw new Error(`Tool ${name} senza schema`);
    const validate = ajv.compile(definition.schema);
    this._tools.set(name, { handler, definition, validate });
  }

  async execute(name, params, runtime) {
    const entry = this._tools.get(name);
    if (!entry) throw new Error(`Tool sconosciuto: ${name}`);
    if (!entry.validate(params)) {
      throw new Error(`Params non validi per ${name}: ${ajv.errorsText(entry.validate.errors)}`);
    }
    return entry.handler(params, runtime);
  }

  toolUseSchemas(provider) {
    // produce array compatibile con OpenAI tools / Anthropic tool_use / OpenRouter functions
    return [...this._tools.entries()].map(([name, { definition }]) => ({
      type: 'function',
      function: {
        name,
        description: definition.description,
        parameters: definition.schema
      }
    }));
  }
}
```

Vantaggio: il planner può fare *function calling nativo* invece di parsare JSON libero.

---

## 6. Specifica tecnica: Critic deterministico

`server/agents/critic.js`:

```js
function validateFormula(formulaString, layout) {
  if (!formulaString.startsWith('=')) return { ok:false, error:'no leading =' };
  if (!isParenthesesBalanced(formulaString)) return { ok:false, error:'unbalanced parens' };
  const refs = extractA1References(formulaString); // e.g. ['Assumptions!B5','DCF!C2:C7']
  for (const ref of refs) {
    if (!layout.references.has(ref)) {
      return { ok:false, error:`unknown ref ${ref}` };
    }
  }
  return { ok:true, refs };
}

function validateActions(actions, layout) {
  const errors = [];
  for (const a of actions) {
    if (a.type === 'runFormula') {
      const r = validateFormula(a.value, layout);
      if (!r.ok) errors.push({ action:a, error:r.error });
    }
    if (a.type === 'fillRange' && !Array.isArray(a.value)) {
      errors.push({ action:a, error:'fillRange.value must be 2D array' });
    }
    // ...
  }
  return errors;
}
```

Helper `extractA1References` può usare regex `/(?:'([^']+)'|([A-Za-z_]\w*))!\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?/g` con white-list di nomi sheet noti.

---

## 7. Specifica tecnica: SSE event taxonomy v2

| Evento | Quando | Replay-safe |
|--------|--------|-------------|
| `turnStarted` | turn creato | sì (snapshot) |
| `planUpdated` | piano disponibile o modificato | sì (snapshot) |
| `turnAwaitingApproval` | piano pronto da approvare | sì se ancora in attesa |
| `itemStarted` | task partito | parziale (skip se già completato) |
| `itemCompleted` | task finito | sì |
| `taskActions` | nuove azioni Excel da eseguire | sì se non già `acked` dal client |
| `toolRequest` / `toolRequestBatch` | runtime chiede al client | sì se ancora pending |
| `toolRequestResolved` | runtime ha ricevuto risposta | non re-inviato in replay |
| `log` | log line | NO replay (volume troppo alto) |
| `llmProgress` | LLM streaming chunk | NO replay |
| `metrics` (nuovo) | latenza/token correnti | NO replay |
| `turnCompleted` | terminale | sì |

Il client invia `?lastEventId=...` (header standard SSE) → server filtra history > lastEventId.

---

## 8. Specifica tecnica: Conversation memory v2

`server/runtime/conversationMemory.js`:

```js
class MemoryStore {
  constructor(userId='default') { /* load from disk */ }

  async addTurn({ turnId, objective, planSummary, sheetsCreated, success, duration }) { ... }

  async getRelevant(objective, k=3) {
    // 1. exact-match recent (last 10 turn) bonus
    // 2. cosine sim su MinHash / embedding locale
    // 3. ritorna top-k + always last 1
  }

  async compact() {
    // se > 20 turn → riassumi i meno recenti via LLM (model fast) in unico blob
  }
}
```

Persistenza: `server/memory/{userId}.json`. Locking semplice via flag in-memory.

---

## 9. Specifica tecnica: Undo

```js
// runtime/undo.js
async function captureSnapshot(turn, action) {
  if (action.type !== 'runFormula' && action.type !== 'setCellValue' && action.type !== 'fillRange') return null;
  const before = await runtime.requestClientTool('workbook.readRange', {
    sheet: action.sheet, target: action.target
  });
  return { type:'restoreRange', sheet:action.sheet, target:action.target, values:before.values, formulas:before.formulas };
}

async function applyUndo(turn) {
  for (const snap of [...turn.undoSnapshots].reverse()) {
    if (snap.type === 'restoreRange') {
      // emit action setRange(values, formulas)
    } else if (snap.type === 'deleteSheet') {
      // emit action deleteSheet
    }
  }
}
```

Limit: snapshot solo sui range esplicitamente modificati. Se utente ha modificato manualmente nel frattempo, l'undo lo sovrascrive (warning in UI).

---

## 10. Pricing / perf budget

Stima per DCF AAPL completo (target Fase 4, model `kimi-k2.6` / `claude-sonnet-4-6`):

| Step | LLM call | Token in | Token out | Tempo |
|------|----------|----------|-----------|-------|
| Planner | 1 | 1.8k | 1.0k | 4 s |
| LayoutAgent | 1 | 1.5k | 1.5k | 4 s |
| Yahoo data (3 chiamate parallelo) | 0 | 0 | 0 | 1 s |
| FormulaAgent × 8 sezioni (parallelo) | 8 | 2.5k each | 1.0k each | 5 s |
| Critic deterministico | 0 | 0 | 0 | 0.1 s |
| FormatAgent headers | 1 | 1.0k | 0.8k | 3 s |
| FormatAgent conditional | 1 | 1.2k | 0.8k | 3 s |
| Narrator | 1 | 0.5k | 0.3k | 2 s |
| Excel apply (batch) | 0 | 0 | 0 | 2 s |
| **Totale** | **12** | **~25k** | **~12k** | **~24 s** |

Costo OpenRouter Kimi K2.6 (~$0.6/Mtok in, $2.5/Mtok out): ~$0.045 per DCF. Sostenibile.

---

## 11. Test plan riassuntivo

| Livello | Cosa | Tool |
|---------|------|------|
| Unit | critic, registry-schema, graph, llm provider routing | `node --test` |
| Integration | turn lifecycle, planner fast-path, dedup, undo | `node --test` con Express supertest |
| Bench | DCF AAPL p50/p95, simple-format p50 | script custom + JSON output |
| Regression | 20 input → expected `actions[]` (snapshot) | `node --test` con JSON snapshot |
| Manual | Excel Desktop + Excel Online checklist | `docs/manual_qa.md` |

---

## 12. Roadmap temporale (stimata, sviluppatore solo Francesco)

| Settimana | Fase | Output principale |
|-----------|------|-------------------|
| ~~1~~ ✅ | ~~Fase 0~~ completato | config sano, log puliti |
| 2-3 ✅ | ~~Fase 1~~ completato (registry v2 + critic + narrator) | tool tipizzati, formule validate, smart approval |
| 4 | Fase 2.1-2.3 (chunking + parallelismo) | DCF in <60 s |
| 5 | Fase 2.4-2.8 (cache + batch + prefetch) | DCF in <40 s |
| 6 | Fase 3 (retry + memoria + undo) | UX robusta |
| 7-8 | Fase 4 (frontend modulare + selettore modello) | bundle pulito, dropdown modello |
| 9 | Fase 5 (data analysis tools) | Excel-generalist |
| 10 | Fase 6 (test + CI + dashboard) | qualità sostenibile |

---

## 13. Quick wins (1-2 ore l'uno) — fai subito

1. [x] `.env` ↔ README allineato (F0.1). ✅
2. [x] `pendingRequests` sweeper a 5 s (F0.7). ✅
3. [x] `compactResultsForPrompt` filtra solo `usesResults` dichiarati nel task (B7) — anche senza schema completo, già taglia 30-40% token. ✅
4. [ ] Frontend: cache `Excel.ChartType` enum + `parseTargetReference` riutilizza match precompilato.
5. [x] `planner.js` plan cache: normalizzazione "rimuovi punti/virgole/case" alla cache key. ✅
6. [ ] `turns.js` `enforceActiveTurnsLimit`: separare "in memoria" da "su disco" — non rileggere mai due volte la stessa turn dal file system se è in cache.
7. [x] `Cache-Control: no-store` su `/api/turn/stream/*` per evitare buffering proxy. ✅
8. [ ] UI: indicatore "tempo trascorso" nel pannello (`Math.floor((Date.now()-startedAt)/1000)s`) — UX percepita migliore senza cambiare nulla server.

---

## 14. Decisioni aperte (da discutere)

1. **Provider primario**: continuare con OpenRouter come default o passare ad Anthropic diretto (tool_use nativo, prompt caching ufficiale)?
2. **Multi-utente**: il prodotto è single-user oggi. Vale la pena progettare auth dal Fase 3 (Microsoft SSO via Office.context) o rimandare?
3. **Storage**: file-system continua a bastare? (attuale ~50 turn = ~2 MB). SQLite leggero potrebbe semplificare query telemetria.
4. **Excel Online**: oggi richiede ngrok. Ha senso un docker compose con tunnel automatico?
5. **Embedding locale**: per memoria semantica, usare API esterna (cara a turn) o `transformers.js` lato server (CPU heavy)?

---

## 15. Riferimenti file → fase

| File | Fasi che lo toccano |
|------|---------------------|
| `server/server.js` | 1 (endpoint metrics), 4 (manifest path) |
| `server/runtime/turns.js` | 1, 2, 3 |
| `server/runtime/conversationMemory.js` | 3 |
| `server/runtime/clientRequests.js` | 0, 2 |
| `server/runtime/actionPreview.js` | 1 (smart approval) |
| `server/agents/planner.js` | 1, 2, 3, 5 |
| `server/agents/specialists.js` | 1, 2 |
| `server/agents/streaming.js` | 2 (history pruning), 6 (metrics events) |
| `server/agents/critic.js` | 1 ✅, 3 |
| `server/agents/narrator.js` | 1 ✅ |
| `server/tools/registry.js` | 1 ✅, 5 |
| `server/tools/llm.js` | 0, 2 |
| `server/tools/yahoo.js` | — |
| `server/tools/data.js` *(nuovo)* | 5 |
| `server/utils/metrics.js` *(nuovo)* | 6 |
| `src/taskpane.js` | 4 (split), 5 (UI nuove modalità) |
| `manifest.xml` | 4 (cambio path bundle) |
| `package.json` | 0, 4, 6 |
| `.env` / `.env.example` | 0, 4 (nuovi MODEL_* keys) |

---

*Fine documento. Per ciascuna fase si raccomanda branch separato + PR review prima del merge.*
