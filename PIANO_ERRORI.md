# Piano: analisi profonda + fix errori Excel AI Agent

## Context

Cartella `/Users/francescodelsesto/Downloads/mm/excel/` = backend Node + Excel add-in (taskpane). Provider LLM attivo (`.env`): `xiaomi/mimo-v2.5-pro` con fallback `deepseek/deepseek-v4-flash`, instradato via OpenRouter (l'utente ha crediti lì). **Vincolo: NON cambiare modelli.**

Server già attivo (`server.log` mostra avvio 13:36 + agent run 13:37). Simulatori = `bench/dcf_e2e.js` (latency planner) e `test-e2e-mock-client.js` (run completo turn DCF). Analisi statica + ispezione `server/turns/*.json` mostra errori reali ricorrenti.

Obiettivo: catalogare bug bloccanti + degradazioni + drift, con fix puntuali.

---

## Errori trovati

### CRITICI (bloccano funzionalità)

**C1. `streaming` non importato in `planner.js`**
- File: `server/agents/planner.js:658`
- `streaming.sendLLMProgress(turnId, text, isDone)` chiamato dentro `onChunk` ma il modulo non è mai `require`-ato.
- Effetto: ramo streaming del planner lancia `ReferenceError` silenziato dentro `readline.on('line')` → progress UX persa, `catch (streamError)` cattura e degrada a non-streaming.
- Fix: aggiungere `const streaming = require('./streaming');` in cima a `planner.js`.

**C2. `runAgentLoop` passa context grezzo dove la registry vuole `memory.runtime`**
- File: `server/agents/agentLoop.js:346,398-411` + `server/tools/registry.js:481,494,517`
- `executeAgentTool('read_workbook',…)` chiama `executeTool('workbook.readWorkbook', params, context)` dove `context = req.body.context`. I tool registry cercano `memory.runtime?.requestClientTool` → throw `Runtime workbook non disponibile`. Idem `read_sheet`, `get_range_as_csv`.
- Sintomo (`server.log:25`): l'agent al primo step prova `web_search` (non disponibile), poi ripiega su `ask_user_question` → loop semi-bloccato perché non legge mai il workbook.
- Fix: in `runAgentLoop` costruire un runtime equivalente a `buildRuntimeHelpers` di `runtime/turns.js`, con SSE proprio o riusando il path turn-based. Alternativa minima: per `read_*` usare context client già letto e passare i dati direttamente.

**C3. `/api/agent/start` await bloccante senza streaming**
- File: `server/server.js:233-262` + `src/taskpane.js:188-217`
- L'endpoint fa `await agentPromise` (50 iter × 180s) prima di `res.json(...)`. Frontend resta in `await startRes.json()` senza SSE → UI congelata; pause `ask_user_question` non viste finché loop non finisce. `/api/agent/respond` è stub (`server.js:271`).
- Fix: `/api/agent/start` ritorna `{agentId}` immediato + esecuzione async + SSE su `/api/agent/stream/:id`. Implementare `/api/agent/respond` per riprendere il loop accodando `userResponse` a `messages` e ripartendo l'iterazione.

**C4. Critic regex bug `RE_A1_REF.test()` con flag /g**
- File: `server/agents/critic.js:6,219`
- `RE_A1_REF` ha flag `/g`. `.test()` su regex globale è stateful: `lastIndex` avanza, validazioni successive su array di action diventano non deterministiche. `setCellValue.target = 'A5'` non matcha `RE_A1_REF` (richiede sheet prefix) e arriva a `RE_A1_SIMPLE` con stato regex sporco.
- Fix: togliere flag `/g` da `RE_A1_REF` (esiste già `RE_A1_SIMPLE`), o resettare `RE_A1_REF.lastIndex = 0` prima di `.test()`, o creare regex non globale per i test.

### MAJOR (degradano UX o sono incoerenti)

**M1. `web_search` / `web_fetch` invitati ma non disponibili**
- File: `server/agents/agentLoop.js:464-475` + `docs/system-prompt-ib-grade.md`
- Log reale: primo tool che il modello chiama è `web_search`. Ritorna error → iterazione successiva fa `ask_user_question`.
- Fix: rimuovere riferimenti a web_search dal system prompt, eliminare/non-pubblicizzare i tool definitions per web_*.

**M2. Tool `set_cell_values` legacy emette `writeRange` con shape diversa**
- File: `server/agents/agentLoop.js:430-440`
- Ritorna `{type:'writeRange', target, values}`; il frontend si aspetta `setCellRange` con mappa cells. Mismatch.
- Fix: rimuovere il caso o normalizzarlo a `setCellRange`.

**M3. FormatAgent / FormulaAgent timeout troppo aggressivi**
- File: `server/agents/specialists.js:4-11` + `.env:60-63`
- xiaomi/mimo-v2.5-pro su prompt grossi (system prompt 72k char + context) ha p50 ~5–13s e p95 oltre 30s. Errori reali: `FormatAgent LLM fallback timeout after 35000ms`, `FormulaAgent sensitivity.data_table fallback timeout after 18000ms`.
- Fix `.env`: `FORMAT_TIMEOUT_MS=120000`, `FORMAT_FALLBACK_TIMEOUT_MS=60000`, `FORMULA_SECTION_TIMEOUT_MS=120000`, `FORMULA_SECTION_FALLBACK_TIMEOUT_MS=60000`. (Modello invariato.)

**M4. `shouldRetryWithFallback` ritorna sempre `true`**
- File: `server/tools/llm.js:252-271`
- Ultimo statement `return true` → anche errori 401/400 (API key, prompt malformato) attivano retry sul fallback, raddoppiando latenza/costo.
- Fix: `if (error.response?.status >= 400 && error.response.status < 500 && [400,401,403,422].includes(error.response.status)) return false;`

**M5. 404 sporadici su OpenRouter — NON cambiare model ID**
- Confermato dall'utente: provider xiaomi connesso a OpenRouter. Sia primario sia fallback restano invariati.
- I `Request failed with status code 404` nei turn vecchi sono transitori (router OpenRouter / disponibilità modello). M4 li attenua.
- Azione: nessun cambio a `XIAOMI_MODEL` / `XIAOMI_FALLBACK_MODEL`.

**M6. `callOpenAICompat` non sanifica risposta JSON**
- File: `server/tools/llm.js:209`
- `JSON.parse(content)` senza `extractJSON`/`sanitizeJSON` → crash se modello restituisce markdown ```json``` o testo prima della struttura. Provider `openai` generico non protetto.
- Fix: usare `extractJSON` come per OpenCode, con fallback `{raw,jsonError}`.

### MINOR / DRIFT

**D1. Commenti / docstring obsoleti**
- `test-e2e-mock-client.js:3-4` e `test-llm-fallback.js`: parlano di `kimi-k2.6` ma env usa xiaomi. Solo commenti.

**D2. `setLLMConfig` non propaga api key dynamic per OpenRouter**
- File: `server/tools/llm.js:39-42` + `callOpenRouterAI`
- `dynamicConfig.apiKey` non letto da `callOpenRouterAI` (usa costante module-load). `/api/config/llm` non cambia davvero la key.
- Fix: in `callOpenRouterAI` usare `dynamicConfig.apiKey || OPENROUTER_API_KEY`.

**D3. `npx http-server` referenziato in `package.json:10` ma non in deps**
- Cosmetico se si usa solo `npm start`.

**D4. `agent/respond` body contract**
- `src/taskpane.js:211` ha TODO "handle user response to resume". Coerente con backend stub. Risolto da C3.

**D5. `executeProviderCall` aggiunge +10000ms al timeout**
- File: `server/tools/llm.js:289`. Coerente (outer wrap fissa scadenza); non bug ma serve commento.

**D6. `/api/turn/respond-batch`**
- File: `server/server.js:90-111`. Passa per `respondToTurnRequest` come `/respond` → dovrebbe emettere `toolRequestResolved`. Verifica empirica con e2e.

---

## Fix consigliati (ordine di esecuzione)

1. **C1**: `require('./streaming')` in `planner.js` (1 riga).
2. **C4**: togliere `/g` da `RE_A1_REF` o reset `lastIndex` in `critic.js`.
3. **M1**: rimuovere case `web_search`/`web_fetch` da `executeAgentTool` + togliere menzioni dal prompt.
4. **M3**: aggiornare `.env` (timeout only).
5. **M4**: corretta logica retry in `llm.js`.
6. **M6**: sanificare `callOpenAICompat`.
7. **C2**: refactor `executeAgentTool` con runtime tipo `buildRuntimeHelpers`.
8. **C3**: `/api/agent/start` async + SSE, `/api/agent/respond` reale, frontend aggancio SSE.
9. **D1/D2/D3/D4**: commenti + propagazione config dynamic.
10. **M5**: nessun cambio model ID. 404 mitigati da M4.

---

## File chiave (da modificare)

- `server/agents/planner.js` — C1
- `server/agents/critic.js` — C4
- `server/agents/agentLoop.js` — M1, M2, C2
- `server/agents/specialists.js` — M3 (env)
- `server/tools/llm.js` — M4, M6, D2
- `server/server.js` — C3
- `src/taskpane.js` — C3 lato client
- `.env` — M3 (timeout)
- `test-e2e-mock-client.js`, `test-llm-fallback.js` — D1

---

## Verifica end-to-end

1. **Backend smoke**: `./stop-dev.sh && ./start-dev.sh` → `curl http://localhost:3000/api/health` = `{ok:true}`.
2. **Static check**: `node test-backend.js` → tutti pass (no LLM, fast-path planner).
3. **LLM round-trip**: `node test-llm-fallback.js` → planner entro 30s.
4. **E2E mock**: `node test-e2e-mock-client.js` → DCF AAPL senza errori `Runtime workbook non disponibile`, no timeout Format/Formula, status `completed`.
5. **Bench**: `node bench/dcf_e2e.js 5 dcf` → p95 plan < 30s; `bench/results-*.jsonl` senza `error`.
6. **Critic regex**: `node -e "const c=require('./server/agents/critic');console.log(c.validateActions([{type:'setCellValue',target:'A5',sheet:'X'},{type:'setCellValue',target:'A6',sheet:'X'}]))"` → entrambe valide.
7. **Agent loop**: via taskpane "fai un DCF di Apple" → progress streaming, no freeze, ripresa dopo `ask_user_question`.

---

## Note vincoli

- **Modelli LLM invariati**: primario `xiaomi/mimo-v2.5-pro`, fallback `deepseek/deepseek-v4-flash`. Provider xiaomi via OpenRouter.
- Solo timeout, prompt, plumbing e logica retry vengono toccati.
- Nessun cambio `OPENROUTER_API_KEY` / `XIAOMI_API_KEY`.
