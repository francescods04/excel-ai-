# PIANO PARALLELIZZAZIONE + SUBAGENT — Excel AI Agent
*Roadmap tecnica per portare l'agente da 200s+ tipici a target p50 < 25s su DCF completi, mantenendo stabilità e qualità.*

> Documento operativo. Ogni layer è implementabile e testabile in isolamento. Ordinato per **valore / rischio**: i Tier 0–1 sono "no regret" e li ho già iniziati; i Tier 2–3 richiedono refactor profondo e vanno validati prima.

---

## 0. TL;DR

L'agente oggi è dominato da **due costi accoppiati**:

1. **Round-trip LLM seriali**: ogni iterazione è 1 tool call. Su 40 iterazioni → 40 round-trip × 3–5 s di latenza modello = 120–200 s minimo, anche se la maggior parte delle iterazioni non richiede pensiero profondo.
2. **Iterazioni a basso valore informativo**: molte servono solo a "rileggere quello che ho appena scritto" o "raccogliere il prossimo input atomico". L'iterazione costa lo stesso anche se il lavoro è banale.

Il **vero leva** è ridurre il numero di iterazioni mantenendo o aumentando il lavoro per iterazione. Si arriva lì con **parallelizzazione orizzontale** (più chiamate per turno) e **specializzazione verticale** (subagent con contesto ridotto, modello adatto al task, scheduling indipendente).

I tre Tier sono:

| Tier | Cambia                                                          | Win atteso       | Rischio | Stato      |
|------|-----------------------------------------------------------------|------------------|---------|------------|
| 0    | Tool batch + size cap + return values veri                      | 30–40% turni     | basso   | **fatto**  |
| 1    | Speculative prefetch + cache idempotente + pianificazione lazy  | 20–30% latenza   | basso   | da fare    |
| 2    | Subagent pool con isolamento + DAG scheduler                    | 2–3× sul build   | medio   | progetto   |
| 3    | Multi-modello eterogeneo (flash per banale, pro per critico)    | 30–50% costi     | medio   | progetto   |

---

## 1. Diagnosi quantitativa (dai bench attuali)

Dal `bench/runtime_mode_compare.js` su scenari realistici (cfr. file `bench/runtime-mode-compare-2026-05-28*.jsonl`):

### dcf_institutional
- `agent_loop`: 207 012 ms totali, **41 iterazioni**, 7 round-trip client, completato.
  - Latenza media per iterazione = ~5 s. Ipotesi: ~3 s sono LLM cached + ~2 s overhead schedulazione + tool I/O.
- `planned_dag` (pre-fix): 112 730 ms, fallito in planning per LLM finance "troppo debole".
- `planned_dag` (post-fix shell+sources deterministici): planning sceso da 112 s a ~28 s, ma execution ancora seriale per task interdipendenti.

### complex_model_repair
- `planned_dag` (pre-fix): 35 304 ms ma **9/17 task falliti** → percorso fragile.
- `planned_dag` (post-fix OpenBB + planner): 121 290 ms, 13/13 OK → percorso robusto ma lento.

### Anatomia di un DCF agent_loop tipico

| Fase                                | Iterazioni stimate | Necessarie? |
|-------------------------------------|--------------------|-------------|
| read_workbook + read_skill          | 2–4                | sì, ma read_skill spesso duplicato (già dedupato) |
| openbb_equity_profile/metrics/balance/income/cashflow | 5 | **NO**: ora bundle in 1 call (`finance_company_bundle`) |
| openbb_treasury/cpi/fed/gdp/unemployment | 4–5 | **NO**: ora bundle in 1 call (`macro_snapshot`) |
| set_cell_range × N section          | 6–10               | sì, ma alcune indipendenti tra loro |
| execute_office_js (formati, chart)  | 3–6                | sì |
| verifica letture post-scrittura     | 4–8                | **parzialmente NO**: return value di `execute_office_js` adesso evita la rilettura |
| todo_write / context_snip / done    | 3–5                | sì |

Senza bundle e senza parallel_calls, **~12 iterazioni** servono solo a raccogliere input. Con i due cambi del Tier 0 quel blocco scende a **2 iterazioni**.

### Misurazione di riferimento per validare i Tier successivi

Vanno tracciate per ogni run:
1. `iteration_count`
2. `llm_round_trips` (≠ iteration quando ci sono retry sullo stesso turno)
3. `tool_calls_total` (somma incluso quanto contenuto in `parallel_calls`)
4. `useful_calls_ratio = tool_calls_total / llm_round_trips` (> 1 = guadagno)
5. `tokens_in / tokens_out / cache_hit_pct` (già tracciato)
6. `time_to_first_action_ms` (UX)
7. `time_to_first_visible_change_ms` (UX)
8. `wallclock_p50 / p95`

Quando l'utility ratio supera ~1.8, abbiamo davvero parallelizzato.

---

## 2. Pattern dal mondo reale a cui ispirarsi

Questi sono i "playbook" che team tecnici di altri domini hanno usato per problemi strutturalmente identici al nostro.

### 2.1 Compiler e build system

- **Make → Bazel/Buck/Nx**. La progressione è la stessa traiettoria che dobbiamo fare: da sequenziale a DAG di task indipendenti con dipendenze esplicite, eseguito in parallelo da un work-stealing scheduler.
- **Insight applicabile**: il nostro `planned_dag` è la giusta direzione, ma oggi è "DAG poveramente sfruttato". Le dipendenze sono troppo conservative (tutto dipende da tutto). Il fix è dichiarare *esplicitamente* le dipendenze fine-grained al planner (es. "audit dipende SOLO da DCF e WACC, non da Assumptions") e poi schedulare il resto in parallelo.
- **Take**: il planner deve produrre un **DAG con livelli (frontier)** e lo scheduler eseguire ogni livello in parallelo, non un elenco lineare di task.
- **Ninja** (sotto Bazel) compie un altro trucco utile: il "command list" è pre-computato, e l'esecuzione è il puro fan-out. Per noi: dopo planning, l'execution non deve mai più chiamare l'LLM se il piano è valido.

### 2.2 Async runtime ed esecuzione concorrente

- **Tokio (Rust), Go goroutines, ZIO fiber, Akka actors**. Modello: task leggeri che cooperano via canali e channels. Lo scheduler usa work-stealing per bilanciare. I dipendenti aspettano via `await`/`select`.
- **Insight applicabile**: ogni subagent dovrebbe essere un task indipendente con un **canale di input** (task da fare) e un **canale di output** (risultati / azioni). L'orchestratore (parent agent) consuma output e re-schedula.
- **Take**: niente thread, bastano `Promise`/`async` con un pool concorrente bounded (es. 4 subagent attivi max per evitare di saturare il provider LLM e i rate limit OpenBB).

### 2.3 Spark / Dask / Ray

- **Spark**: DAG di trasformazioni lazy, materializzate solo all'action. Cataclizmando il piano logico → ottimizzato → eseguito a stage paralleli.
- **Ray**: actor model + futures `.remote()`. Ogni actor ha stato proprio. Esecuzione parallela trasparente: `[fetch.remote(t) for t in tickers]`.
- **Insight applicabile**: il bundle `finance_company_bundle` e `parallel_calls` sono mini versioni di questo. Lo step successivo è esporre **lo stesso pattern come primitivi del planner**: il planner emette un DAG dove i nodi "fetch external data" sono già marcati `parallelizable: true`, e l'executor li raccoglie in `Promise.allSettled`.
- **Take**: introdurre nel planner un campo `parallelGroup: <id>` che marca task indipendenti da eseguire in parallelo. Backward compatible (default `null` → seriale).

### 2.4 ML inference batching

- **vLLM / TGI / Triton**. Il throughput esplode quando si fa "continuous batching": invece di un prompt alla volta, il server raggruppa più richieste e le esegue in un solo forward pass condividendo KV-cache.
- **Insight applicabile**: per noi non gestiamo l'inference (è del provider), ma possiamo **sfruttare la cache del prefix di sistema**. DeepSeek già fa caching automatico (vedo `prompt_cache_hit_tokens` tracciato). Per massimizzarla: **non cambiare il prompt di sistema iterazione su iterazione**, mai. Differenziare l'agent state con messaggi user, non patchando il system prompt.
- **Take**: audit: assicurarsi che il system prompt sia **identico byte-a-byte** tra iterazioni dello stesso turn. Già fatto in `checkSystemPrefixStability` (lo logga). Manca: assert in dev mode.

### 2.5 Branch prediction / speculative execution

- **CPU branch predictor**, **GitHub Copilot's speculative completions**, **OpenAI Predictive Outputs**. L'idea: indovinare il prossimo passo e iniziarlo *prima* che venga richiesto. Se l'ipotesi era giusta, hai latenza zero; se sbagliata, scarti.
- **Insight applicabile**: dopo `read_workbook`, il pattern più probabile è "ora chiama un OpenBB equity". Possiamo iniziare un prefetch speculativo sui dati OpenBB del ticker noto **mentre l'LLM sta pensando al prossimo step**. Se serve, è già pronto.
- **Take**: implementare un **prefetch pool** lato server. Dopo iterazione N che ritorna un workbook con ticker noto, fire-and-forget `openbb_equity_profile(ticker)`. Cache risultato. Quando arriva la richiesta vera, restituisci dalla cache.
- **Rischio**: spreco di chiamate (costo OpenBB è trascurabile, è gratis), ma costo cognitivo: la cache deve avere TTL e essere invalidata se il ticker cambia.

### 2.6 Service mesh / circuit breaker

- **Envoy, Istio, Hystrix**. Pattern: timeout aggressivi + circuit breaker + retry con backoff exponential.
- **Insight applicabile**: il client roundtrip ha timeout 30 s fisso (vedi `makeRequestClientTool`). Per `execute_office_js` su modelli grandi potrebbe non bastare; per `read_range` 30 s è troppo.
- **Take**: timeout configurabile per tool. Default piccolo (5 s) per i read, più lungo (60 s) per `runJavaScript`. Aggiungere retry con backoff su provider OpenBB (già parzialmente fatto in `openbb.js`).

### 2.7 Multi-agent frameworks (stato dell'arte)

- **LangGraph (LangChain)**: grafo a stati espliciti, ogni nodo è un agente o un tool, transizioni condizionate.
- **CrewAI**: ruoli specializzati (Researcher, Writer, Analyst) con goal espliciti e delega tra loro.
- **AutoGen (Microsoft)**: gruppi di agenti che chattano tra loro; uno è il manager, gli altri specialisti.
- **OpenAI Swarm / Anthropic Claude Code subagents**: agent dispatch dinamico con `Task` tool che lancia un subagent isolato e ne attende il risultato.
- **MetaGPT / SWE-agent**: pipeline a stadi (Architect → Engineer → QA) con artefatti tipizzati tra stadi.

**Lezione comune**:
- I subagent **funzionano** quando hanno **contesto stretto** e **output tipizzato**.
- Falliscono quando si sovrappongono in responsabilità o condividono uno stato mutabile.
- L'orchestratore deve essere "stupido": non riasoning, solo routing.

**Take**:
- Già abbiamo profili agente in `excelHarness.js` (workbookScout, marketScout, modelArchitect, modelAnalyst, formulaEngineer, formatDesigner, auditReviewer). Sono **descrizioni**, non runtime. Da promuovere a istanze runtime separate con loop indipendente.

### 2.8 Database query planner

- **PostgreSQL / Snowflake**: cost-based optimizer trasforma una query in un piano. Il piano è valutato per costo stimato (CPU, I/O, network) e parallelizzato a livello di operatore.
- **Insight applicabile**: il nostro planner LLM non ragiona in costi. Decide ordine e parallelismo "a sentimento". Aggiungere un **cost annotator** post-LLM che marca ogni task con stime `(latency_ms, tokens, requiresApproval)` e poi il scheduler usa quelle stime per:
  - mettere i task long-running in testa (critical path)
  - tenerli paralleli ai short
  - non sprecare slot di parallelismo su roba che è già nel critical path

### 2.9 GraphQL DataLoader

- **DataLoader** (Facebook): batching + caching automatici per N+1 problem.
- **Insight applicabile**: oggi `get_cell_ranges` accetta già più range in un call. Manca: **dedupe trasparente**. Se il LLM chiede `B2:B10` in due iterazioni vicine, sprechiamo I/O. Un dataloader per range fa cache + dedupe (TTL piccola, es. 30 s, per tollerare modifiche).
- **Take**: cache-aside per i tool read deterministici sui dati workbook, con invalidazione su qualsiasi `setCellRange` / `runJavaScript`.

---

## 3. Architettura proposta — Tier per tier

### Tier 0 — Già implementato in questa sessione

| Fix | File | Effetto |
|---|---|---|
| `execute_office_js` ora ritorna `value + logs` veri al loop | `server/agents/agentLoop.js`, `src/main.js`, `src/excel/writers.js` | LLM non rilegge dopo scrittura → -4..8 iter per DCF |
| `finance_company_bundle` (5 OpenBB equity in parallelo) | `server/agents/agentLoop.js` | -4 iter per DCF gather phase |
| `macro_snapshot` (5 macro in parallelo) | idem | -4 iter per WACC gather phase |
| `parallel_calls` (fan-out fino a 8 read-only) | idem | -2..6 iter sul read phase |
| Tool result size cap (default 12k chars) | idem | prompt cresce piano → throughput LLM costante |
| Test unitari `test_execute_office_js_rpc.js`, `test_finance_bundle.js`, `test_parallel_calls.js`, `test_tool_result_size_cap.js` | `test/unit/` | regressione protetta |

**Risultato atteso su scenario `dcf_institutional`** (proiezione, da validare con bench live):
- Iterazioni: 41 → 22–25
- Wallclock: 207 s → 105–130 s (assumendo 4 s/iter cached)

### Tier 1 — Quick wins a basso rischio (prossimi 1–2 giorni)

#### 1.1 Speculative prefetch dei dati ovvi

- Dopo `read_workbook`, se il context expone un ticker (`AAPL` etc.) e il task è una valuation, lanciare in background `finance_company_bundle({symbol})` e `macro_snapshot()` e memorizzarli in `agentMemory`.
- Quando l'LLM chiede dopo (probabilmente lo farà), servire dalla cache. Latenza percepita ≈ 0.
- Cache TTL 5 min. Invalidazione: cambio ticker o turn-end.
- Implementazione: hook in `executeAgentTool('read_workbook')` post-success.

#### 1.2 DataLoader-style cache per workbook read

- Wrapper su `get_cell_ranges` / `read_range`: chiave = sheet+target+maxRows.
- TTL = 30 s OR fino al prossimo write su quel range (invalidazione fine).
- Tracking hit-rate via telemetry.

#### 1.3 Trim dinamico del system prompt per fase

- Detect fase corrente (planning / build / verify) dal task / dall'iterazione corrente.
- In build phase: skip-load le sezioni "OpenBB tool list verbose" e "execute_office_js code patterns" (l'LLM le ha già viste e cachate).
- Variant `system-prompt-ib-grade.md` + un `system-prompt-ib-build.md` minimal (~10k chars).
- Cache-aware: cambiare prompt invalida la prefix cache, quindi solo all'inizio di una fase, non intra-iterazione.

#### 1.4 Modello eterogeneo per ruolo

- `triage` e `planner` già su flash + no-thinking (visto in `test_runtime_safety.js`).
- Aggiungere: `format-only` task → flash, no thinking.
- `audit` (con verify) → pro + thinking.
- `analytics` (DCF building con calcoli) → pro, thinking opzionale.
- Implementazione: `resolveAgentLoopModel(...)` già accetta variant; estendere mapping.

#### 1.5 Timeout per-tool

- `requestClientTool` timeout configurabile per tool name.
- Read piccoli: 5 s. `runJavaScript`: 60 s. `readWorkbook` (full): 30 s.
- Esposto via `executeAgentTool` opzioni.

#### 1.6 Critic veloce dopo write batch

- Dopo ogni `set_cell_range` o `execute_office_js` che ha modificato N≥10 celle, lanciare un *critic veloce* (LLM flash, no thinking, prompt minimal) che valuta solo: "ci sono errori #VALUE/#REF/#NAME/#DIV/0 in questo range?".
- Se ok, salta il verify successivo del main agent.
- Se errori, restituisci al main agent come tool result con lista esatta dei problemi.
- Risparmia 2–3 iter di verify manuale.

### Tier 2 — Subagent pool con isolamento (medio termine)

Oggi i "subagent" sono prompt variants su un unico loop. Il salto qualitativo è renderli **istanze separate** orchestrate da un parent.

#### 2.1 Architettura

```
┌────────────────────────────────────────────────────────┐
│             OrchestratorAgent (main loop)              │
│   - mantiene piano (DAG)                               │
│   - sceglie chi spawnare                               │
│   - aggrega risultati                                  │
│   - decide done                                        │
└─────────────────┬────────────────┬─────────────────────┘
                  │                │
       ┌──────────▼──────┐  ┌──────▼──────────┐
       │ ResearchAgent   │  │ BuilderAgent    │   (pool, max 3 attivi)
       │ - workbookScout │  │ - formulaEng    │
       │ - marketScout   │  │ - formatDesigner│
       │ - read-only     │  │ - modelArchitect│
       └──────────┬──────┘  └──────┬──────────┘
                  │                │
                  └────────┬───────┘
                           │
                  ┌────────▼────────┐
                  │ CriticAgent     │  (fast model, narrow scope)
                  │ - audit reviewer│
                  │ - read-only     │
                  └─────────────────┘
```

#### 2.2 Protocollo

- Task tipizzato: `{ id, role, objective, inputs, outputs_expected, deadline_ms }`.
- L'orchestrator emette task sulla queue.
- Subagent prende un task → esegue il proprio mini-loop → emette `{ status, outputs, actions, telemetry }`.
- Orchestrator non rilegge tutta la conversazione del subagent, solo `outputs` + summary. Compressione naturale.

#### 2.3 Implementazione concreta

- Già esiste `excelHarness.js` con profili. Aggiungere `runSubagent(profile, task)` che internamente chiama `runAgentLoop` con prompt = profile.role + task.objective, contesto ridotto, step budget = profile.stepBudget.
- Pool: `Promise.all` su max 3 subagent attivi, queue sui restanti.
- Risultati raccolti in `aggregateSubagentResults({ id, outputs, actions, telemetry })`.
- Side effect: Excel actions sono **collezionate** e applicate dal parent in batch (no race condition perché parent è single-writer).

#### 2.4 Vincoli e rischi

- **Costo token**: ogni subagent ha proprio system prompt. Per evitare esplosione: prompt subagent **minimi** (~5–8k chars), no example library completa, solo la sua specialità.
- **Coerenza azioni**: due subagent che vogliono scrivere su `Assumptions!B3` deve essere catturato dall'orchestrator. Soluzione: subagent emette *intent*, non actions dirette. Orchestrator valida e applica.
- **Latency overhead**: ogni subagent fa min 2 LLM calls (objective in, output fuori). Per task < 10s sequenziali, il subagent non conviene. Calibrare la soglia.

### Tier 3 — Multi-LLM eterogeneo + critic-in-the-loop (lungo termine)

#### 3.1 Provider routing dinamico

- Mantenere il pool DeepSeek pro/flash + opzionale OpenRouter come fallback.
- Aggiungere: routing per task complexity. Es. Anthropic Haiku per format-only, Claude Sonnet per audit/verify, Claude Opus per planner critico.
- Astratto via `tools/llm.js` con tracciamento per provider/latency.

#### 3.2 Critic-in-the-loop

- Pattern Reflexion / Constitutional AI: ogni N iter, lancia un critic agent che valuta il main agent.
- Critic restituisce: `{ on_track: bool, drift_detected: string|null, suggested_correction: string|null }`.
- Se `on_track=true`, no-op (poca latency, fast model).
- Se drift, inserisce un user message correttivo nel main loop senza interrompere.

#### 3.3 Self-improving prompt library

- Tracciare via `llmTrace` quali turn falliscono per prompt issue (parse failure, wrong tool).
- Builder offline che aggrega traces → propone patch al system prompt → A/B test via `bench/runtime_mode_compare.js`.

---

## 4. Roadmap proposta (priorità + sequenza)

| # | Item | Tier | Sforzo | Win | Rischio |
|---|------|------|--------|-----|---------|
| 1 | ✅ Tool RPC return + bundle + size cap + parallel_calls | 0 | done | done | done |
| 2 | Speculative prefetch (Tier 1.1) | 1 | 1d | 1.5–3 s/run | basso |
| 3 | DataLoader workbook reads (1.2) | 1 | 1d | 2–4 s/run | basso |
| 4 | Per-tool timeout (1.5) | 1 | 0.5d | stabilità | basso |
| 5 | Critic veloce post-write (1.6) | 1 | 1d | -2 iter/run | basso |
| 6 | Model routing per ruolo esteso (1.4) | 1 | 0.5d | -20% latency | basso |
| 7 | Trim dinamico prompt per fase (1.3) | 1 | 1.5d | -10% latency, -30% token in | medio (cache invalidation) |
| 8 | Subagent pool isolato (Tier 2) | 2 | 4–6d | -40% wallclock build | medio |
| 9 | Critic-in-the-loop (Tier 3.2) | 3 | 3d | +qualità | medio |
| 10 | Multi-provider routing dinamico (3.1) | 3 | 2d | -30% costi | basso (codice), medio (test) |

**Suggerimento**: item 2–6 si possono fare in parallelo, ognuno è un PR atomico testabile col bench harness esistente.

---

## 5. Metriche per validare ogni step

Per ogni cambio:

1. Eseguire `npm run bench:modes -- 2 dcf_institutional,complex_model_repair planned_dag,agent_loop`.
2. Verificare regressioni: confronto JSONL con baseline (timestamp pre-fix).
3. Telemetria runtime live (vedi `server/utils/runtimeOutcomeSummary.js`): aggregare ultimi N turn, controllare `iteration_count`, `wallclock_ms`, `errors`.
4. `prompt_cache_hit_pct`: deve restare ≥ 80% per DeepSeek (oggi è il caso). Cala = qualcosa cambia il system prompt iterazione su iterazione → bug.

### Target finali

| Scenario               | Baseline   | Tier 0 target | Tier 1 target | Tier 2 target |
|------------------------|------------|---------------|---------------|---------------|
| dcf_institutional      | 207 s, 41 iter | 130 s, 25 iter | 90 s, 18 iter | 60 s, 12 iter |
| complex_model_repair   | 121 s, 13 task | 100 s, 13 task | 70 s, 13 task | 45 s, 13 task |
| Format-only (semplice) | 25–40 s    | 20 s          | 12 s          | 8 s           |

---

## 6. Decisioni architetturali da prendere prima

Prima di partire con Tier 2/3 servono scelte:

1. **Subagent come processo separato o stesso Node event loop?**
   - Stesso loop = semplice, condivide cache LLM HTTP keep-alive, ma rischio di blocco se uno è lento.
   - Worker thread = isolamento vero ma overhead serializzazione + cache LLM duplicata.
   - **Raccomandazione**: stesso loop, async, con pool bounded a 3. Worker thread non serve finché non c'è CPU bound (siamo I/O bound).

2. **Provider multipli simultanei?**
   - Sì se costo OpenRouter non esplode. Cap a 2 provider attivi.
   - **Raccomandazione**: DeepSeek principale, Anthropic Haiku come critic veloce.

3. **Cache persistente cross-turn?**
   - I dati OpenBB cambiano lentamente. Cache 1 ora su `equity_profile`, 6 ore su `treasury_rates`.
   - **Raccomandazione**: sì, in-process LRU + invalidazione esplicita su user request.

4. **Approval UX in mondo parallelo?**
   - Se 3 subagent vogliono scrivere e l'utente deve approvare ogni mutazione, la UX collassa.
   - **Raccomandazione**: approval **a livello orchestrator**, non subagent. Subagent emette intent, parent mostra all'utente il diff aggregato di tutti gli intent ready-to-apply.

---

## 7. Cosa NON fare

- ❌ **Stream multiplo di tool calls nello stesso LLM response**: il provider supporta OpenAI-style `tool_calls` array, ma il nostro custom JSON format `{thought, tool, params}` non lo fa. Andare al native tool calling è 2 settimane di lavoro e rischia regressioni profonde. `parallel_calls` come tool è equivalente funzionalmente e 100x meno rischio.
- ❌ **Parallelizzare le write**: race condition garantite su `set_cell_range` paralleli sullo stesso sheet. Mantenere ogni mutazione sequenziale. Parallel solo per read + fetch.
- ❌ **Allargare contesto subagent**: tentazione di "passare tutta la storia" al subagent. Sbagliato. Subagent prende solo input tipizzati per il suo task. Storia rimane all'orchestrator.
- ❌ **Modello unico per tutto**: anti-pattern. Flash per banale, pro per ragionamento, audit con thinking. Routing per ruolo.
- ❌ **Speculative prefetch su tutto**: solo su pattern che hanno hit-rate ≥ 70% storicamente (validare con telemetry prima di committare).

---

## 8. Allegato: fonti / pattern di riferimento

- *Bazel: Build Systems at Google*, Wright, Winter, Loo (book + paper SoSP).
- *Designing Data-Intensive Applications*, Kleppmann — capitoli su batch & stream processing.
- *Anthropic Multi-Agent Research blog* (Claude Code subagent pattern).
- *LangGraph documentation* — state machines per agent orchestration.
- *CrewAI / AutoGen* — ruoli specializzati e protocolli di delega.
- *Apache Spark internals* — DAG scheduler e Catalyst optimizer.
- *Ray docs* — actor model + futures.
- *DataLoader (Facebook)* — batching/caching per N+1.
- *vLLM / TGI* — continuous batching, prefix caching, KV reuse.
- *OpenAI Predictive Outputs* — speculative completions.
- *Hystrix / Envoy* — circuit breaker patterns.

---

*Fine documento. Aggiornare dopo ogni Tier completato con numeri di bench reali e lezioni apprese.*
