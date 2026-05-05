# Excel AI Agent — SaaS Roadmap (ultra-detailed)

> **Goal**: trasformare l'attuale agente da prototipo "mid" in un prodotto SaaS vendibile a banche d'investimento, fondi PE, corporate finance team, equity research.
>
> **Tesi**: il valore non è l'AI generica (chiunque può chiamare DeepSeek). Il valore è la combinazione di (a) **capability layer** (code-exec, file ingest, validation), (b) **domain layer** (DCF/LBO/M&A skills battle-tested), (c) **integration layer** (market data, persistent memory). Senza tutti e tre l'analista IB usa Excel + ChatGPT in browser.

---

## Indice
1. [Stato attuale & gap analysis](#stato-attuale--gap-analysis)
2. [**Tier 0 — Bug fix critical (formatting)**](#tier-0--bug-fix-critical-formatting)
3. [Tier 1 — Capability layer](#tier-1--capability-layer)
4. [Tier 2 — Domain moat](#tier-2--domain-moat)
5. [Tier 3 — SaaS infra](#tier-3--saas-infra)
6. [**Observability v2 — structured logging deep-dive**](#observability-v2--structured-logging-deep-dive)
7. [Roadmap 6 sprint](#roadmap-6-sprint)
8. [Sprint 1 deep-dive: Code execution sandbox](#sprint-1-deep-dive-code-execution-sandbox)
9. [Pricing & GTM (preview)](#pricing--gtm-preview)
10. [Decision log & open questions](#decision-log--open-questions)

---

## Stato attuale & gap analysis

### Cosa funziona oggi (commit @ 2026-05-05)
- `agentLoop` con tool calling DeepSeek + Anthropic
- 39 tool registrati (39 → vedi `/api/health`)
- Schema validation centralizzato (`server/tools/schemas.js`)
- Cache stability detection FNV-1a
- todo_write panel UI Anthropic-style
- ask_user_question widget
- Skills lazy-load
- Preflight read prima di overwrite
- SSE streaming
- Bench `bench/agent_e2e.js` p50 25.5s su task simple

### Cosa NON funziona per task complessi
| Gap | Esempio task che fallisce | Impatto |
|---|---|---|
| **Formatting bugs (Tier 0)** | "Applica border bottom thin a header" | Critico — output sembra rotto, 9 bug concreti documentati in sez. 0.2 |
| **No code execution** | "Costruisci LBO 5y su questi 50k row di transazioni" | Critico — agente non può fare math su dataset |
| **No file ingestion** | "Leggi questo 10-K e popola revenue split" | Critico — analyst non lo usa |
| **No multi-agent** | "Costruisci 3-statement LBO completo" | Alto — single loop = 5+ minuti |
| **No validation** | "BS non bilancia di $2M" | Critico — modelli rotti = no trust |
| **No persistent memory** | "Usa stessa WACC del deal Apollo scorso mese" | Medio — friction ripetitiva |
| **No domain skill battle-tested** | "DCF AAPL con sensitivity 9-12%" | Alto — competitor (Numerous, Equals, Rows) hanno template |
| **No market data** | "Pull SEC 10-Q Q2 2025 AAPL" | Alto — copy-paste manuale = friction |
| **No eval harness** | "Modello regredisce dopo prompt change" | Medio — dev velocity |
| **No structured logging / replay** | "Bug task multi-step ieri, debug now" | Critico ops — no corr_id, no replay, no per-tenant filter |
| **No multi-tenancy** | "Team workspace condiviso" | Bloccante per SaaS |

---

## Tier 0 — Bug fix critical (formatting)

> **Discovered 2026-05-05** durante audit. Formatting tools sono **rotti su 4 dimensioni**. Devono essere fixati **prima** di sprint 1 perché ogni domain skill (DCF, LBO) dipende da formatting corretto (negativo in rosso, header in bold, border per separare sezioni). Senza, output sembra amatoriale → no trust → no sale.

### 0.1 Sintomi osservati
- Border non vengono mai applicati anche se LLM li specifica
- Italic ignorato in `set_cell_range` (funziona solo via `set_format`)
- Allineamento orizzontale ignorato in `set_cell_range`
- Color malformati (`"blue"` invece di `"#0000FF"`) falliscono silenziosamente
- Note (`spec.note`) probabilmente non si scrivono — API call sbagliata
- Set di 100 celle con stesso format → 100 round-trip API singoli (lento)

### 0.2 Root cause analysis (file:linea)

#### Bug F1: schema `borderStyles` vuoto
**File**: `server/tools/schemas.js:43`
```js
borderStyles: { type: 'object' }  // ← no properties defined
```
LLM riceve schema senza struttura → genera shape arbitraria → writer non sa cosa farsene.

**Impatto**: alto. Border è fondamentale per modelli finanziari (separare assumption box da output box).

#### Bug F2: `borderStyles` mai eseguito
**File**: `src/excel/writers.js:393-410` (`execSetCellRange`)
```js
if (spec.cellStyles) {
  // ... handles fontColor, backgroundColor, bold, numberFormat
}
// ← NESSUN if (spec.borderStyles) {...}
```
Anche se LLM passa `borderStyles`, viene **silenziosamente droppato**.

**Impatto**: critico. Tool description (`agentLoop.js:343`) promette di supportarlo ma non lo fa.

#### Bug F3: split-brain `set_cell_range` vs `set_format`
**File**: `src/excel/writers.js:308-318` (set_format) vs `393-410` (set_cell_range)

| Property | `set_format` | `set_cell_range` |
|---|---|---|
| `fontColor` | ✅ | ✅ |
| `backgroundColor` | ✅ | ✅ |
| `bold` | ✅ | ✅ |
| `italic` | ✅ | ❌ DROPPED |
| `numberFormat` | ✅ | ✅ |
| `horizontalAlignment` | ✅ | ❌ DROPPED |
| `borderStyles` | ❌ N/A | ❌ DROPPED |
| `verticalAlignment` | ❌ N/A | ❌ DROPPED |
| `wrapText` | ❌ N/A | ❌ DROPPED |
| `indent` | ❌ N/A | ❌ DROPPED |

LLM deve indovinare quale tool usare per quale property → cognitive load → uso sbagliato.

#### Bug F4: nessuna validazione hex color
**File**: tutti i punti che assegnano `range.format.fill.color = X`

LLM passa `"blue"`, `"red"`, `"rgb(255,0,0)"` → Office.js si aspetta `"#RRGGBB"` → assegnamento fallisce silenziosamente o lancia eccezione che kill l'intera batch.

**Impatto**: medio-alto. Senza validazione il primo color sbagliato killa tutta la write.

#### Bug F5: `comments.add()` API errata
**File**: `src/excel/writers.js:401`
```js
if (spec.note) {
  cell.comments.add(spec.note);  // ← API errata
}
```
Office.js API corretta: `worksheet.comments.add(cellAddressString, content, contentType?)` — non `range.comments.add(content)`.

**Impatto**: medio. Note non si scrivono, error swallowed dal try/catch del queue handler.

#### Bug F6: nessun batching per format identici
**File**: `src/excel/writers.js:393-410`

Loop cell-by-cell:
```js
for (const { cellSheet, cellAddr, spec } of resolved) {
  const cell = cellSheet.getRange(cellAddr);  // ← N getRange call
  if (spec.cellStyles) {
    cell.format.font.color = ...  // ← N format API call
  }
}
```
100 celle con stesso format → 100 getRange + 100 format set + 1 sync = lento (~3-5s) e overflow Office.js batch limit.

**Impatto**: alto su task grossi (full LBO assumption table = 200+ celle).

#### Bug F7: snapshot undo non cattura borders
**File**: `src/excel/writers.js:94, 108-113`
```js
range.load('values,formulas,format/fill/color,format/font/color,format/font/bold,numberFormat');
// ← non carica format/borders, non carica italic, non carica alignment
```
Undo non ripristina border né italic né alignment.

#### Bug F8: schema strict reject `cellStyles` extra props
**File**: `server/tools/schemas.js:24-34`

CELL_STYLES non ha `additionalProperties: false`, ma neanche dichiara `italic`, `horizontalAlignment`, `verticalAlignment`, `wrapText`, `borderStyles`. Ajv probabilmente accetta extra props ma writer non le usa → silent drop senza warn.

#### Bug F9: nessuna telemetry per format failure
**File**: tutto il flow

Quando un format fallisce (color invalido, border non applicato), nessun log strutturato. Non c'è metrica `format_apply_success_rate` per tenant. Impossibile sapere se la qualità output sta degradando.

### 0.3 Fix plan (sprint 0 — 3 giorni)

#### Day 1: Schema unification
1. **Estendere `CELL_STYLES`** in `schemas.js` con tutte le props supportate da Office.js range.format:
   ```js
   const CELL_STYLES = {
     type: 'object',
     additionalProperties: false,
     properties: {
       fontColor: HEX_COLOR,
       backgroundColor: HEX_COLOR,
       bold: { type: 'boolean' },
       italic: { type: 'boolean' },
       underline: { type: 'string', enum: ['None', 'Single', 'Double'] },
       fontSize: { type: 'integer', minimum: 6, maximum: 72 },
       fontName: { type: 'string' },
       numberFormat: { type: 'string', description: 'Excel format e.g. "#,##0.00", "0.00%", "$#,##0_);[Red]($#,##0)"' },
       horizontalAlignment: { type: 'string', enum: ['Left', 'Center', 'Right', 'Fill', 'Justify'] },
       verticalAlignment: { type: 'string', enum: ['Top', 'Center', 'Bottom'] },
       wrapText: { type: 'boolean' },
       indent: { type: 'integer', minimum: 0, maximum: 250 }
     }
   };
   ```

2. **Definire `BORDER_STYLES`** properly:
   ```js
   const BORDER_SIDE = {
     type: 'object',
     additionalProperties: false,
     properties: {
       style: { type: 'string', enum: ['None', 'Continuous', 'Dash', 'DashDot', 'DashDotDot', 'Dot', 'Double', 'SlantDashDot'] },
       color: HEX_COLOR,
       weight: { type: 'string', enum: ['Hairline', 'Thin', 'Medium', 'Thick'] }
     }
   };
   const BORDER_STYLES = {
     type: 'object',
     additionalProperties: false,
     properties: {
       top: BORDER_SIDE,
       bottom: BORDER_SIDE,
       left: BORDER_SIDE,
       right: BORDER_SIDE,
       insideHorizontal: BORDER_SIDE,
       insideVertical: BORDER_SIDE,
       diagonalDown: BORDER_SIDE,
       diagonalUp: BORDER_SIDE,
       all: BORDER_SIDE  // shortcut: applies to all sides
     }
   };
   ```

3. **`HEX_COLOR` primitive** con pattern validation:
   ```js
   const HEX_COLOR = {
     type: 'string',
     pattern: '^#[0-9A-Fa-f]{6}$',
     description: 'Hex color in format #RRGGBB (e.g. "#0000FF" for blue). NOT named colors like "blue".'
   };
   ```

#### Day 2: Writer rewrite
4. **Refactor `execSetCellRange`** in `src/excel/writers.js`:
   - Estrarre `applyCellStyles(range, styles)` con TUTTE le props
   - Estrarre `applyBorderStyles(range, borders)` con mapping a Office.js EdgeTop/EdgeBottom/EdgeLeft/EdgeRight/InsideHorizontal/InsideVertical
   - **Batching**: raggruppare celle per format signature (hash del cellStyles+borderStyles JSON), applicare format al range unificato
   - **Color validation**: regex check prima di assegnare. Se invalid → log warn + skip property, non kill batch.
   - **Note fix**: usare `cellSheet.comments.add(cellAddr, spec.note, Excel.CommentContentType.plain)` invece di `range.comments.add()`

5. **Update `set_format`** in writers.js per usare stesse helper functions → no più split-brain.

6. **Snapshot enrichment**: capturare anche borders + italic + alignment per undo completo.

#### Day 3: Validation + telemetry
7. **Eval test** `test/eval/formatting/`:
   - 10 task: "applica border bottom thin black ad A1:F1", "header row bold + bg color #DCE6F1 + center align", etc.
   - Scorer legge formato post-write da Excel, confronta con expected.
8. **Telemetry**: log `format_apply` event con `{ properties_requested, properties_applied, properties_dropped, hex_validation_failures }`. Dashboard mostra success rate.
9. **Update tool description** in agentLoop con esempio borders + named colors warning:
   ```
   "B1": {
     "value": "Header",
     "cellStyles": { "bold": true, "horizontalAlignment": "Center" },
     "borderStyles": {
       "bottom": { "style": "Continuous", "weight": "Medium", "color": "#000000" }
     }
   }
   ```

### 0.4 Definition of done sprint 0
- [ ] Border styles applicati end-to-end (eval test passa)
- [ ] `italic`, `horizontalAlignment`, `wrapText` funzionano in `set_cell_range`
- [ ] Hex color invalido logga warn ma non killa la batch
- [ ] Note (`spec.note`) effettivamente scritte in Excel
- [ ] 100 celle con stesso format = 1 sola format API call (batched)
- [ ] Undo ripristina anche border + italic + alignment
- [ ] Telemetry `format_apply_success_rate` >95% su eval set
- [ ] Schema drift test (`test_schema_drift.js`) esteso a `BORDER_STYLES`

### 0.5 Open question
- **Q-F1**: Mantenere `set_format` come tool separato o consolidare in `set_cell_range`? Pro consolidamento: meno cognitive load LLM. Pro separato: API esplicita per format-only su range esistente.
  - **Raccomandazione**: deprecare `set_format` (rimuovere da TOOL_DEFINITIONS dopo 1 sprint), tutto via `set_cell_range`. Riduce N tool da 39 → 38.

---

## Tier 1 — Capability layer

> Senza questi, agente non può fare task complessi. **Non negoziabili.**

### 1.1 Code execution sandbox (Python)
**Cosa**: ambiente Python isolato con `pandas`, `numpy`, `openpyxl`, `scipy`, `numpy_financial`. Tool `run_python(code, files?)` ritorna stdout/stderr/files generati.

**Perché**:
- Bypass cellLimit 2000 → pandas legge 100k righe in memoria
- Math complessa: regressione OLS, Monte Carlo, ottimizzazione, NPV/IRR su scenari
- Parsing PDF (pypdf2/pdfplumber) → dipendenza per Tier 1.2
- Validation invariants (pandas check) → dipendenza per Tier 1.4
- Subagenti finanziari chiamano `run_python` per calcoli pesanti → dipendenza per Tier 1.3

**Sub-step**: vedi [Sprint 1 deep-dive](#sprint-1-deep-dive-code-execution-sandbox).

### 1.2 File ingestion multimodale
**Cosa**: pipeline per ingest di PDF, xlsx, csv, immagini. Output strutturato che agente può consumare.

**Tool API**:
```
ingest_pdf(file_id) → { pages: [{ text, tables: [...], images: [...] }], metadata }
ingest_xlsx(file_id) → { sheets: [{ name, data: [[...]], formulas: [...] }] }
ingest_csv(file_id) → { columns: [...], preview: [...], stats: {...}, file_path_in_sandbox }
ingest_image(file_id) → { ocr_text, detected_tables, vision_summary }
```

**Sub-step**:
1. **Upload endpoint**: `POST /api/files/upload` (multipart, max 50MB) → ritorna `file_id` + S3/R2 URL signed.
2. **Storage**: Cloudflare R2 (cheap, S3-compatible) — bucket per-tenant prefix.
3. **PDF parser**:
   - Native Anthropic PDF support per 10-K (max 32MB, 100 pages) — pass diretto in messaggio multimodal.
   - Fallback `pdfplumber` in sandbox per estrazione tabelle strutturate.
4. **xlsx parser**: `openpyxl` in sandbox → ritorna struttura sheet completa (incluse formule).
5. **Image OCR**: native Claude vision se `<5MB`, altrimenti Tesseract in sandbox.
6. **Table extraction**: per finanziari (10-K balance sheet) → `camelot` o `tabula-py` in sandbox.
7. **Tool integration**: `ingest_*` tool ritornano risultato strutturato + opzionalmente file_path nel sandbox per `run_python`.

**Test eval**:
- Drop AAPL 10-K → estrae revenue $383B (FY2024) ±0.1%.
- Drop CIM PE 80-pagine → estrae deal stats (TTM EBITDA, multiplo entry).
- Drop screenshot bilancio → OCR + struttura tabella.

**Costo**: R2 storage $0.015/GB/mese, egress free. Anthropic vision $3/M input token (PDF ~1500 token/pagina).

### 1.3 Plan-Execute + Conductor multi-agent
**Cosa**: pattern dove main agent decompone task complesso in subtasks, spawna subagenti specializzati in parallelo, aggrega risultati.

**Architettura**:
```
User: "Build LBO Apple 5y"
  ↓
Main Agent (planner)
  ├─ create_plan() → ["Build assumptions", "Build sources&uses", "Build IS/BS/CF", "Build debt schedule", "Build returns"]
  ├─ spawn_subagent("revenue_projector", task="project AAPL revenue 2025-2029")
  ├─ spawn_subagent("debt_modeler", task="build debt schedule with 6x leverage")
  ├─ spawn_subagent("returns_calc", task="calc IRR/MoIC for sponsor")
  └─ merge_results() → write to Excel via single bulk transaction
```

**Sub-step**:
1. **Conductor service** (`server/agents/conductor.js`):
   - `spawn_subagent(role, task, context_filter)` → spawna nuovo `agentLoop` con system prompt subagente
   - Subagenti hanno tool subset (subagent finanziario non ha `update_chart_style`)
   - Comunicazione via shared filesystem (sandbox) o passing message structured
2. **Plan tool**: `create_plan(steps)` ritorna plan_id, steps tracked in todo_write panel.
3. **Subagent registry**: definizione roles (`revenue_projector`, `debt_modeler`, `validator`, `formatter`).
4. **Result aggregation**: `merge_subagent_results(plan_id)` → main agent riceve summary di ogni subagent + diff Excel proposed.
5. **Bulk transaction**: tutti i write Excel raccolti, applicati in 1 sola `set_cell_range` batch (calc suspended).
6. **Failure handling**: se subagent fallisce → main agent decide se retry, skip, o abort.

**Quando usare**:
- Task con >5 subtask indipendenti (LBO completo, M&A merger model, full DCF + sensitivity)
- Skip per task semplici (1 cell update, lookup)

**Costo**: 3-4 subagenti paralleli = 3-4x token cost ma 60s → 15s wall clock = vale per task complessi.

**Riferimento esistente**: `docs/architecture/multi-agent-conductor.md` (già scritto, verificare se va aggiornato).

### 1.4 Validation layer post-write
**Cosa**: invariants finanziari controllati automaticamente dopo ogni bulk write significativo. Errori ritornati al main loop per self-correct.

**Invariants core**:
| Check | Formula | Tolleranza |
|---|---|---|
| `bs_balance` | `Total Assets == Total Liabilities + Equity` | ±$1 |
| `cf_reconciliation` | `Cash[t] - Cash[t-1] == NetCFO + NetCFI + NetCFF` | ±$1 |
| `ni_to_re` | `Retained Earnings[t] - RE[t-1] == Net Income - Dividends` | ±$1 |
| `margin_sanity` | `Gross Margin between 0% and 100%` | hard |
| `growth_sanity` | `Revenue YoY growth between -50% and +200%` | warn |
| `circular_check` | No formula creates circular reference (unless iterative calc enabled) | hard |
| `formula_consistency` | Adjacent cells in same row use same formula structure | warn |

**Sub-step**:
1. **Tool `validate_model(sheet, model_type)`**:
   - `model_type ∈ ["3-statement", "DCF", "LBO", "comparable", "merger"]`
   - Ritorna `{ passed: bool, errors: [...], warnings: [...] }`
2. **Implementation**: chiamata Excel API per leggere ranges note (BS = "B5:F30"), confronto formule.
3. **Auto-trigger**: dopo bulk write con `cells.length > 50` invoca validate automatically.
4. **Self-correct loop**: se validate fallisce → main agent vede errori → genera fix → retry (max 2 retry).
5. **Skill-aware**: ogni domain skill (DCF/LBO) registra suoi invariants custom.

**Test eval**:
- Inietta BS sbilanciato → validate ritorna error con cella offending.
- Inietta circular reference → validate detecta.
- Margine negativo accidentale → validate warn.

### 1.5 Persistent memory cross-session
**Cosa**: store strutturato per (a) project-level facts (deal, ticker, assumptions), (b) user preferences (formatting, conventions), (c) reusable templates.

**Schema**:
```sql
-- Postgres tables
CREATE TABLE workspaces (id, name, owner_id, created_at);
CREATE TABLE projects (id, workspace_id, name, ticker, deal_type, created_at);
CREATE TABLE memories (
  id, workspace_id, project_id NULL,
  scope ENUM('user','project','workspace'),
  key, value JSONB, source ENUM('user','agent'),
  confidence FLOAT, created_at, updated_at
);
CREATE TABLE templates (id, workspace_id, name, type, content JSONB);
```

**Tool API**:
```
recall_memory(scope, query) → [{ key, value, confidence, last_used }]
save_memory(scope, key, value, source) → { memory_id }
list_templates(type?) → [{ id, name, description }]
apply_template(template_id, target_sheet) → { written_cells, formulas_added }
```

**Sub-step**:
1. **Postgres schema migration** (`server/db/migrations/001_memory.sql`).
2. **Memory service** (`server/services/memory.js`) con scope guard.
3. **Tool integration** in `agentLoop` TOOL_DEFINITIONS.
4. **Auto-extract**: dopo task complete, agente proposes 2-3 facts per save (user approves via ask_user_question).
5. **Auto-recall**: prima di task complesso, agente queries memory per project_id corrente → injection in context.
6. **Embedding search**: per `recall_memory` con query semantica usa `text-embedding-3-small` + cosine sim.

**Privacy**: memory cifrata at rest (AES-256), per-tenant key in KMS.

---

## Tier 2 — Domain moat

> Cosa rende il prodotto **defensibile** vs ChatGPT generico in browser.

### 2.1 Domain skills battle-tested (DCF, LBO, M&A, CCA, PT)
**Cosa**: skill non come prompt loose, ma come **structured workflows** con check intermedi, output deterministici, template Excel allegati.

**Esempio LBO workflow**:
```
Step 1: Collect assumptions (purchase price, leverage, hold period, exit multiple)
  → tool ask_user_question per missing
Step 2: Build sources & uses
  → run_python: calc cash equity, debt tranches
  → write to Sheet "S&U"
  → validate: total sources == total uses
Step 3: Build operating model
  → spawn subagent revenue_projector
  → spawn subagent cost_modeler
  → merge into Sheet "Model"
  → validate: 3-statement linked
Step 4: Build debt schedule
  → run_python: amortization table
  → write to Sheet "Debt"
  → validate: ending balance ties to BS
Step 5: Build returns
  → run_python: calc IRR, MoIC, sources of return
  → write to Sheet "Returns"
  → validate: cash flow waterfall sums correct
Step 6: Sensitivity table
  → loop entry/exit multiples
  → write to Sheet "Sensitivity"
```

**Sub-step**:
1. **Skill DSL**: estensione skills/ con file `.skill.yaml` definendo steps, tool calls, validation.
2. **Skill engine** runtime (`server/skills/engine.js`) che esegue YAML.
3. **Build 5 skill flagship**: DCF, LBO, 3-statement, comparable companies, precedent transactions.
4. **Each skill ships con template Excel** (xlsx pre-formato) → `apply_template` come step 0.
5. **Eval set per skill**: 10 test case ciascuno con ground truth.
6. **Versioning skill**: changelog, rollback se eval regredisce.

### 2.2 Market data integration
**Cosa**: dati live da fonti gratuite/cheap.

**Tool**:
```
fetch_filings(ticker, type='10-K'|'10-Q'|'8-K', limit=5) → [{ filing_date, url, file_id }]
fetch_prices(ticker, range='1y') → { dates: [...], prices: [...] }
fetch_macro(series='GDP'|'CPI'|'FED_FUNDS', range) → time series
fetch_company_facts(ticker) → { revenue, ebitda, fcf, ... } (latest fundamentals)
fetch_comparables(ticker, n=10) → [{ ticker, name, ev_ebitda, p_e, ... }]
```

**Sub-step**:
1. **SEC EDGAR** (free, no key): `fetch_filings`, `fetch_company_facts` via `data.sec.gov/api/xbrl/companyfacts`.
2. **FRED** (free, key): macro data.
3. **Yahoo Finance** (free, scraping): prices, basic fundamentals — fragile, fallback `yfinance` python.
4. **FMP** ($14/mese): comparables, multiples, fundamentals storiche pulite.
5. **Cache layer**: Redis 24h TTL per fundamental data, 1h per prices.
6. **Rate limit**: per-tenant quota (es. 1000 fetch/giorno tier base).

**Cost projection**: $14 (FMP) + $20 (Redis Cloud) + free SEC/FRED = **$34/mese fixed** infra → margin >95% se prezzo $50/utente/mese.

### 2.3 Eval harness + regression
**Cosa**: test set deterministico per misurare qualità output, non solo latency.

**Sub-step**:
1. **Eval framework** (`test/eval/`):
   - Input: prompt + initial state (xlsx)
   - Expected: dict di celle target con valori (±tolleranza)
   - Scorer: cell-level match + formula-level match + structural (column/row counts)
2. **Eval set v1**: 30 task across 5 domain (DCF, LBO, 3-stmt, comparable, sensitivity).
3. **CI integration**: ogni PR runna eval, blocca merge se score scende >5%.
4. **A/B framework**: side-by-side run vecchio vs nuovo prompt, statistical significance test.
5. **Cost tracking**: ogni eval logga token used, latency p50/p99.

**Eval example**:
```yaml
name: dcf_aapl_basic
input:
  prompt: "Build a 5-year DCF for AAPL with WACC 9% and terminal growth 2.5%"
  initial_state: empty_workbook.xlsx
  market_data: { aapl_revenue_2024: 383285 }
expected:
  sheet "DCF":
    B5: { formula: "=B4*(1+5%)", tolerance: 0 }
    F20: { value: 305000000000, tolerance_pct: 5 }
    G25: "Enterprise Value"
scoring:
  cell_match_weight: 0.6
  formula_match_weight: 0.3
  structural_weight: 0.1
threshold: 0.85
```

---

## Tier 3 — SaaS infra

> Necessari per **vendere**. Non differenzianti tecnicamente ma bloccanti commercialmente.

### 3.1 Auth + multi-tenancy + billing
**Sub-step**:
1. **Auth**: Clerk o Auth0 (Google/Microsoft SSO out-of-box).
2. **Multi-tenancy**: row-level security in Postgres su `workspace_id`. Middleware estrae `workspace_id` da JWT.
3. **Billing**: Stripe subscription. Tier:
   - **Solo** $29/mese: 1 user, 500 LLM call/mese, 5 GB storage
   - **Team** $79/user/mese: shared workspace, templates condivisi, 2000 LLM call/user
   - **Enterprise** $custom: SSO Okta/Azure AD, on-prem option, custom skills, SLA
4. **Quota enforcement**: middleware decrementa contatori, blocca quando exhausted.
5. **Usage dashboard**: utente vede LLM call usate, storage, cost.

### 3.2 Observability per-tenant
**Sub-step**:
1. **Metrics**: per tenant, per user → latency p50/p99, cost token, error rate, tool failure rate.
2. **Tracing**: OpenTelemetry → Honeycomb o Grafana Tempo.
3. **Conversation replay**: store full conversation transcript in S3, UI per riprodurre step-by-step.
4. **Alerting**: PagerDuty su error rate >5% o latency p99 >60s.
5. **Dashboard interno**: Grafana board admin per ops team.

### 3.3 Tool subsetting dinamico
**Cosa**: invece di mandare tutti 39 tool in ogni call, manda solo quelli rilevanti per modalità corrente.

**Sub-step**:
1. **Tool grouping**: tag ogni tool con domain (`finance`, `formatting`, `chart`, `data`, `system`).
2. **Mode detection**: classifier piccolo (intent classification) decide modalità da query utente.
3. **Subset selection**: mode → subset di ~10 tool. Always include core 5 (`set_cell_range`, `get_cell_ranges`, `ask_user_question`, `todo_write`, `recall_memory`).
4. **A/B test**: confronta accuracy subset vs full set.

**Beneficio atteso**: -40% input token, +10-20% accuracy (riduce tool selection error che scala con N).

---

## Observability v2 — structured logging deep-dive

> **Stato attuale**: `server/utils/logger.js` (plain text linea-based su `server.log`) + `server/utils/metrics.js` (JSONL daily files). **6 campi** loggati per LLM call. Zero correlation, zero tool log, zero client log, zero replay.
>
> **Perché urgente**: senza structured logging non si può (a) debug task multi-step falliti, (b) misurare quality regression dopo prompt change, (c) supportare clienti enterprise che chiedono SOC2/audit log, (d) trovare bug come quelli formatting (Tier 0) prima che cliente li veda.

### O.1 Cosa manca oggi

| Capability | Stato | Impatto |
|---|---|---|
| Correlation ID end-to-end | ❌ assente | Impossibile tracciare 1 user prompt → tutti i log derivati |
| Tool invocation log strutturato | ❌ assente | Non si sa quale tool fallisce di più, con quali args |
| Client-side error shipping | ❌ assente | Bug Office.js stay in browser console |
| Per-tenant log isolation | ❌ N/A (no tenancy) | Bloccante per SaaS |
| Log retention/rotation | ❌ assente | server.log cresce illimitato |
| Structured query (filter, group) | ❌ plain text | grep-only, no aggregation |
| Replay session step-by-step | ❌ assente | Debug richiede ricostruire da memoria |
| Log levels per modulo | ⚠️ globale | Non si può debug solo writers senza spam tutto |
| Sampling configurabile | ❌ assente | High-volume tool log saturerebbe |
| PII redaction | ❌ assente | Risk se logghi user data |
| Sink esterno (Datadog, Honeycomb) | ❌ assente | Solo file locale |
| Alert su anomaly | ❌ assente | Errore in prod si scopre da customer |

### O.2 Architettura target

```
┌────────────────────────────────────────────────────────────────┐
│ Client (Office.js taskpane)                                    │
│   - logger.client.js → POST /api/log/client (batch every 2s)   │
│   - cattura: console errors, Excel API failures, UI events     │
└─────────────────────────┬──────────────────────────────────────┘
                          │ HTTPS
┌─────────────────────────▼──────────────────────────────────────┐
│ Server (Node.js)                                               │
│                                                                │
│  ┌───────────────┐    ┌─────────────┐    ┌─────────────────┐  │
│  │ Request middleware│ │ AsyncLocalStorage│ │ Event emitter│  │
│  │ - generates corr_id │ - holds context │ │  - log.* events │  │
│  └───────┬───────┘    └──────┬──────┘    └────────┬────────┘  │
│          │                   │                     │           │
│          └───────────────────┴─────────────────────┘           │
│                              │                                 │
│  ┌───────────────────────────▼──────────────────────────────┐  │
│  │                  Structured Logger (pino)                 │  │
│  │  - level filter per module                                │  │
│  │  - automatic context injection (corr_id, tenant_id, user) │  │
│  │  - PII redaction (regex on known fields)                  │  │
│  │  - sampling (debug = 100%, info = 100%, debug verbose=10%)│  │
│  └─────────────┬─────────────────────────────┬───────────────┘  │
│                │                             │                  │
│  ┌─────────────▼──────────┐    ┌────────────▼────────────────┐  │
│  │ Local sinks            │    │ Remote sinks (async)        │  │
│  │ - server.log (rotated) │    │ - Honeycomb / Grafana Loki  │  │
│  │ - sessions/{corr_id}.jsonl  │ - Sentry (errors only)      │  │
│  │ - metrics/{date}.jsonl │    │ - PostHog (product events)  │  │
│  └────────────────────────┘    └─────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

### O.3 Event taxonomy

Tutti gli eventi seguono schema unificato:
```json
{
  "ts": 1714914000123,
  "level": "info",
  "module": "agentLoop|llm|writer|tool|http|sandbox|memory",
  "event": "tool.invoke.start",
  "corr_id": "req_a1b2c3",
  "session_id": "sess_x9y8",
  "tenant_id": "ws_acme",
  "user_id": "u_42",
  "trace": { "parent_span": "sp_p", "span": "sp_q", "duration_ms": null },
  "data": { ...event-specific... }
}
```

**Event taxonomy core** (~30 eventi):

| Module | Event | Quando | Data fields chiave |
|---|---|---|---|
| http | `http.request.start` | nuova request | method, path, body_size |
| http | `http.request.end` | response sent | status, duration_ms |
| agent | `agent.session.start` | new agent session | initial_prompt, model |
| agent | `agent.iteration.start` | nuova iter loop | iter_n, history_size |
| agent | `agent.iteration.end` | iter completa | iter_n, tools_called, duration_ms |
| llm | `llm.call.start` | pre-call | provider, model, prompt_tokens_est |
| llm | `llm.call.chunk` | streaming chunk | bytes, tokens_so_far (sampled 10%) |
| llm | `llm.call.end` | response done | duration_ms, prompt_tokens, completion_tokens, cost_usd, cache_hit_ratio |
| llm | `llm.cache.miss` | cache stability check fail | provider, prev_hash, new_hash |
| tool | `tool.invoke.start` | tool selected | name, args (PII redacted), corr_iter |
| tool | `tool.invoke.end` | result returned | name, duration_ms, success, error_type |
| tool | `tool.client.dispatch` | sent to Office.js client | name, payload_size |
| tool | `tool.client.response` | client returned | name, duration_ms, error |
| writer | `writer.batch.start` | execActions begin | n_actions, types |
| writer | `writer.batch.end` | excel sync done | n_cells, duration_ms, snapshot_size |
| writer | `writer.format.apply` | format applied | properties_requested, properties_applied, dropped, hex_failures |
| writer | `writer.format.invalid` | bad input | property, value, reason |
| writer | `excel.api.error` | Office.js threw | api_call, error_code, message |
| sandbox | `sandbox.exec.start` | run_python begin | code_size, files_count |
| sandbox | `sandbox.exec.end` | done | duration_ms, stdout_size, exit_code |
| memory | `memory.recall` | recall_memory call | scope, query, n_results |
| memory | `memory.save` | save_memory | scope, key, source |
| validation | `validation.run` | validate_model invoked | model_type, passed, n_errors, n_warnings |
| skill | `skill.load` | lazy skill load | name, size_kb, source |
| skill | `skill.execute` | skill workflow run | name, step, duration_ms |

### O.4 Implementation plan (sprint 5 part-time, 4 giorni)

#### Day 1: Core infra
1. **Switch to `pino`**: `npm install pino pino-pretty pino-roll`
   - Motivation: 10x faster than custom logger, structured JSON, mature ecosystem
   - Backward compat: keep `logger.info()` / `logger.warn()` API, internally pino
2. **AsyncLocalStorage context**:
   ```js
   const { AsyncLocalStorage } = require('async_hooks');
   const ctx = new AsyncLocalStorage();
   // middleware: ctx.run({ corr_id, tenant_id, user_id }, () => next())
   // logger automatically reads ctx in formatter
   ```
3. **Correlation ID middleware**:
   ```js
   app.use((req, res, next) => {
     const corr_id = req.headers['x-correlation-id'] || crypto.randomBytes(8).toString('hex');
     res.setHeader('x-correlation-id', corr_id);
     ctx.run({ corr_id, tenant_id: req.tenant?.id, user_id: req.user?.id }, () => next());
   });
   ```
4. **Log rotation**: pino-roll with `frequency: 'daily', size: '100m', retain: 14`

#### Day 2: Event emission
5. **Replace ad-hoc logging** in agentLoop, llm.js, writers.js, tools/registry.js with structured events from taxonomy O.3.
6. **Tool invocation wrapper**: in registry.js wrap every tool execution:
   ```js
   const result = await logSpan('tool.invoke', { name, args: redact(args) }, async () => {
     return await handler(args);
   });
   ```
   `logSpan` emits start + end events with auto-duration.
7. **Per-session JSONL sink**: stream tutti gli event con stesso `session_id` in `server/sessions/{session_id}.jsonl` per replay.

#### Day 3: Client + remote
8. **Client logger** (`src/utils/clientLogger.js`):
   ```js
   const buffer = [];
   function log(level, event, data) {
     buffer.push({ ts: Date.now(), level, event, data, corr_id: getCorrId() });
     if (buffer.length >= 20) flush();
   }
   setInterval(flush, 2000);
   async function flush() {
     if (!buffer.length) return;
     const batch = buffer.splice(0);
     try { await fetch('/api/log/client', { method: 'POST', body: JSON.stringify(batch) }); }
     catch { buffer.unshift(...batch); /* retry next tick */ }
   }
   ```
9. **Capture Office.js failures**: wrap every `Excel.run` con try/catch + `clientLogger.log('error', 'excel.api.error', { ... })`.
10. **PII redaction**: regex su `email`, `api_key`, `token`, `password`, `ssn`. Apply in pino formatter.
11. **Honeycomb integration** (sprint 6 dopo auth, optional MVP): pino-transport with Honeycomb dataset per env. ~$0 free tier per 20M events/month.

#### Day 4: Replay + dashboard
12. **Replay endpoint** `GET /api/sessions/{session_id}/replay`:
    - Returns ordered events
    - Stream via SSE per UI live replay
13. **Internal admin UI** `/admin/sessions`:
    - Search by corr_id, tenant_id, user_id, date range
    - Click session → timeline view with events grouped by module
    - Filter per error / warn only
    - Diff view per agent iteration (system_prompt diff, tools called, response)
14. **Cost dashboard**: per tenant, per day → token in/out, cost USD, by provider.

### O.5 Sampling strategy
- `error`, `warn`: 100% sempre
- `info`: 100% per business event (llm.call.end, tool.invoke.end), 10% per high-frequency (llm.call.chunk)
- `debug`: 1% in prod, 100% in dev
- Override per session: `?debug=1` query param in dev requests forza 100% debug

### O.6 Cost & retention
- Local files: 14 giorni rotation, gzip dopo 1 giorno → ~50MB/giorno → ~700MB total per server
- Honeycomb free tier: 20M events/mese (sufficient per <100 utenti attivi)
- Post free tier: $25/mese per 100M events → marginale vs token cost
- Session JSONL: retained 30 giorni, cold storage R2 dopo

### O.7 Privacy / compliance
- PII redaction by default (regex)
- User can request `GET /api/me/logs` → all events with their `user_id`
- User can request `DELETE /api/me/logs` → soft delete, hard purge dopo 90 giorni
- Log fields explicit allowlist per Honeycomb (no surprise PII leak to vendor)

### O.8 Why pino (vs winston, bunyan, custom)
| Logger | Throughput (op/s) | JSON native | AsyncLocalStorage | Maturità |
|---|---|---|---|---|
| **pino** | 800k | ✅ | ✅ via mixin | ⭐⭐⭐⭐⭐ |
| winston | 50k | ⚠️ via format | ❌ manual | ⭐⭐⭐⭐ |
| bunyan | 70k | ✅ | ❌ manual | ⭐⭐⭐ (no longer maintained) |
| current custom | ~10k (sync writes) | ❌ | ❌ | ⭐ |

Migration path: pino import alias → backward compatible API → graduale switch chiamate ad emit eventi strutturati.

### O.9 Eval / acceptance
- [ ] `corr_id` end-to-end: client log → server log → llm log tutti taggati con stesso ID
- [ ] Replay endpoint ricostruisce session completa di task multi-step
- [ ] Tool failure rate per name disponibile in dashboard
- [ ] Format apply success rate >95% (collegato a Tier 0)
- [ ] Cost per tenant calcolabile dalla query log
- [ ] Log volume <100MB/giorno per 10 utenti attivi
- [ ] PII redaction test: nessun `@gmail.com`, `Bearer xxx`, `sk-xxx` nei log

### O.10 Open question
- **Q-O1**: Honeycomb vs Grafana Loki vs Datadog? Honeycomb best per query exploratory ad alto cardinality, Loki cheap+self-host, Datadog enterprise standard. Raccomandazione: **Honeycomb** free tier per MVP, Loki self-host se cost esplode.
- **Q-O2**: Replay UI build-in admin app o usare Honeycomb trace view? Build-in se vogliamo "white label" enterprise customer.
- **Q-O3**: Per-tenant log isolation a quale livello? File separati, db separato, o solo filtro? Raccomandazione: filtro a query time (single sink), encryption at rest with per-tenant key.

---

## Roadmap 6 sprint

| Sprint | Settimane | Focus | Output verificabile |
|---|---|---|---|
| **0** | 0 (3 giorni) | **Tier 0 formatting bug fix + logging core (pino + corr_id)** | Border/italic/alignment funzionano in `set_cell_range`, eval formatting passa, ogni log ha corr_id |
| **1** | 1-2 | Code exec sandbox + run_python | Bench: agente runna pandas su CSV 50k row, scrive aggregato in Excel |
| **2** | 3 | File ingestion (PDF native + xlsx + csv) | Bench: drop 10-K AAPL → revenue $383B estratto |
| **3** | 4 | Validation layer (5 invariants) | Eval: BS balance check, CF recon, margin sanity passa su 10 modelli |
| **4** | 5-6 | Conductor + plan-execute + 1 subagent role | LBO completo in <120s wall clock con 3 subagent paralleli |
| **5** | 7-8 | Persistent memory + eval harness 30 test + **observability v2 full** (event taxonomy, replay, dashboard) | Cross-session recall, CI eval green, replay funzionante |
| **6** | 9-10 | Auth (Clerk) + Stripe + workspace MVP + per-tenant log isolation | Beta privato 10 utenti paganti, audit log per-tenant |

**Domain skills + market data parallelizzati durante sprint 2-5** (developer separato).

**Sprint 0 è bloccante** per credibilità output Excel. Senza, ogni demo a investor/cliente espone bug formatting.

**Out-of-scope per v1 SaaS** (post-launch):
- Mobile app
- Slack/Teams bot
- API pubblica per terze parti
- Marketplace template

---

## Sprint 1 deep-dive: Code execution sandbox

> Questo è il primo step. Tutto il resto dipende. Da fare bene.

### 1.0 Decision: hosted vs self-host

| Opzione | Pro | Contro | Cost |
|---|---|---|---|
| **E2B** (e2b.dev) | Plug-and-play SDK, fast cold start (~150ms), built-in file system, official Anthropic partner | Vendor lock-in, prezzo scala con uso ($0.00012/sec CPU = ~$10/mese 10 utenti attivi) | $0 setup + ~$10-100/mese |
| **Modal** (modal.com) | Pythonic, generous free tier, batch execution forte | Cold start lento (~1s), meno docs per agent use case | $0-30/mese tier base |
| **Docker self-host** (firecracker VM) | Zero vendor lock, full control, prevedibile | Devops onere, security model complesso, maintenance | $20-50/mese VPS + tempo |
| **Cloudflare Workers + Pyodide** | Edge, ultra-fast | Pyodide limitato (no native pandas full), 30s CPU limit | $5/mese |

**Raccomandazione**: **E2B per MVP** (sprint 1-3), valuta migration a self-host se uso >10k sandbox/mese.

### 1.1 E2B integration
**Sub-step**:
1. **Setup**: `npm install @e2b/code-interpreter`. API key in `.env`.
2. **Service** `server/services/sandbox.js`:
   ```js
   const { Sandbox } = require('@e2b/code-interpreter');

   async function runPython(code, files = [], timeout = 30000) {
     const sandbox = await Sandbox.create({ timeoutMs: timeout });
     try {
       for (const f of files) await sandbox.files.write(f.path, f.content);
       const exec = await sandbox.runCode(code);
       const generated = await sandbox.files.list('/tmp/output');
       return {
         stdout: exec.logs.stdout.join('\n'),
         stderr: exec.logs.stderr.join('\n'),
         result: exec.results,
         files: generated,
         error: exec.error
       };
     } finally {
       await sandbox.kill();
     }
   }
   ```
3. **Per-tenant pool**: warm sandbox pool per workspace (max 3) per ridurre cold start. TTL 5 min idle.
4. **Resource limits**: max 30s wall clock, 1 GB RAM, 1 vCPU per call. Configurable per tier (Enterprise: 5 min, 4GB).

### 1.2 Tool definition
```js
// In agentLoop.js TOOL_DEFINITIONS
{
  type: 'function',
  function: {
    name: 'run_python',
    description: `Execute Python code in sandboxed environment with pandas, numpy, openpyxl, scipy, numpy_financial pre-installed.

Use for:
- Calculations on datasets >2000 cells (pandas faster than tool loop)
- Statistical analysis (regression, correlation, Monte Carlo)
- Financial math (NPV, IRR, bond pricing)
- Data transformation before write to Excel
- Reading/writing files in /tmp/

Output stdout (max 10KB) + files generated in /tmp/output/.

Do NOT use for:
- Single cell calculations (use Excel formula instead)
- Tasks that require iteration with user (use ask_user_question)`,
    parameters: {
      type: 'object',
      required: ['code'],
      properties: {
        code: { type: 'string', description: 'Python code to execute' },
        files: {
          type: 'array',
          items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
          description: 'Optional input files to write to sandbox before execution'
        },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 60000, default: 30000 }
      }
    }
  }
}
```

### 1.3 Output handling
**Sub-step**:
1. **Stdout truncation**: max 10KB. Se exceeds, salva full output in S3 + return `[truncated, full at file_id=xxx]`.
2. **Pandas DataFrame return**: se result è DataFrame, ritorna come `{ shape, columns, head: [...10 rows], dtypes, full_csv_file_id }`.
3. **File detection**: scan `/tmp/output/` post-execution. xlsx files auto-uploaded a R2, ritornati con `file_id`.
4. **Error parsing**: Python tracebacks parsati per estrarre `ExceptionType` + line number → format friendly per LLM.
5. **Plot capture**: matplotlib `plt.savefig()` → png in `/tmp/output/` → ritornato come image che agente può `display_image_to_user(file_id)`.

### 1.4 Excel ↔ sandbox bridge
**Cosa**: agente può passare range Excel → sandbox → ricevere computed back.

**Pattern**:
```js
// Tool: excel_to_python(sheet, range, var_name)
//   → reads Excel range, writes to sandbox /tmp/input/{var_name}.csv
//   → returns { rows: 1234, cols: 5, file_path: '/tmp/input/sales.csv' }

// Then agent calls:
//   run_python({ code: "import pandas as pd; df = pd.read_csv('/tmp/input/sales.csv'); ..." })

// Tool: python_to_excel(file_path_in_sandbox, target_sheet, target_cell)
//   → reads file from sandbox, writes back to Excel via set_cell_range
```

**Sub-step**:
1. Build `excel_to_python` tool che chiama `get_range_as_csv` esistente + write su sandbox.
2. Build `python_to_excel` tool che reads sandbox file + invoca `set_cell_range`.
3. Document pattern in skill template (es. DCF skill: "use excel_to_python for assumptions table, run_python per calc, python_to_excel for results").

### 1.5 Security model
**Threat**:
- Code malicious da utente → mitigato da E2B isolation (firecracker VM)
- Code malicious da agente prompt-injected → mitigato da sandbox
- Data exfiltration da sandbox → mitigato da egress block (E2B no internet di default)
- Resource exhaustion → mitigato da timeout + RAM limit

**Sub-step**:
1. **Egress whitelist**: nessun internet da sandbox per default. Whitelist domains specifici per `fetch_filings` etc (gestito da tool dedicato, non da `run_python`).
2. **Audit log**: ogni `run_python` call logga code + tenant_id + timestamp → SIEM.
3. **Filesystem isolation**: per-call sandbox (no shared state across users).
4. **Output sanitization**: stdout/stderr scanned per PII pattern prima di return (warn user).

### 1.6 Test suite
**Sub-step**:
1. `test/integration/test_sandbox.js`:
   - Basic exec: `print(2+2)` → `"4"`
   - Pandas: load CSV, groupby, return summary
   - Timeout: infinite loop kill correttamente
   - Memory limit: alloc 2GB → OOM caught
   - File output: write xlsx, verify uploaded R2
   - Bridge: excel_to_python → run → python_to_excel roundtrip
2. `test/eval/code_exec/`: 10 task end-to-end (es. "summarize this 50k row CSV by category", "calc IRR of these cashflows").

### 1.7 Performance budget
| Metrica | Target | Rationale |
|---|---|---|
| Sandbox cold start | <500ms p95 | Warm pool keeps p95 low |
| Simple exec (`2+2`) | <300ms | E2B baseline |
| Pandas load 10MB CSV | <2s | Local R2 transfer + load |
| Roundtrip excel→py→excel | <5s | Includes Excel API roundtrips |
| Cost per call | <$0.01 | 30s avg @ $0.00012/sec + R2 transfer |

### 1.8 Migration checklist (post-MVP)
Quando E2B cost >$200/mese o >10k call/mese, considerare migration a self-host:
- Firecracker VM su VPS (Hetzner, Vultr)
- Custom orchestrator (open-source: kata-containers, gVisor)
- Pre-built Docker image con tutte le lib
- Mantenere stesso tool API per zero impact su agentLoop

### 1.9 Sprint 1 timeline (10 working days)

| Day | Task | Owner | Output |
|---|---|---|---|
| 1 | E2B account setup, prototype `run_python` tool | dev | Hello world py exec |
| 2 | Service `sandbox.js` + warm pool + per-tenant isolation | dev | Pool warmup test |
| 3 | Tool definition + agentLoop integration | dev | Agent invokes run_python |
| 4 | Output handling (stdout/stderr/files/DataFrame) | dev | All output types tested |
| 5 | excel_to_python + python_to_excel bridge | dev | Roundtrip test |
| 6 | Security: egress block, audit log, sanitization | dev + sec review | Pen test basic |
| 7 | Test suite (unit + integration) | dev | 90% coverage on sandbox.js |
| 8 | Eval set (10 task) | dev | Eval baseline metrics |
| 9 | Bench: latency, cost per call, p99 cold start | dev | Performance budget verified |
| 10 | Docs + skill template update + demo video | dev | Internal demo |

**Definition of done sprint 1**:
- [ ] `run_python` tool callable da agentLoop
- [ ] 10 eval task passano (>80% accuracy)
- [ ] Latency p95 <2s per task tipo "load 10MB CSV + aggregate"
- [ ] Security review passed (egress block + audit log working)
- [ ] Cost per call documentato in observability
- [ ] Bench mostra agente risolve task "summarize 50k row sales data" che attualmente fallisce

---

## Pricing & GTM (preview)

> Non priorità sprint 1-3 ma da tenere a mente per non fare over-engineering.

**Target customer**:
- Primary: associate/VP IB (Goldman, JPM, MS, boutique M&A) — pain: 60-80h settimana modeling
- Secondary: PE associate — pain: due diligence speed
- Tertiary: corporate dev, equity research

**Wedge**: 1 task killer = "Drop CIM PDF → first-cut LBO model in 5 min vs 4 ore manuale".

**Pricing tier**:
- Solo $29/mese (acquisition)
- Team $79/user/mese (revenue)
- Enterprise $custom (margin)

**GTM v1**:
- Beta privato 10 utenti (network founder Francesco)
- Case study quantitativi (time-to-model reduction)
- Launch su Twitter finance + LinkedIn IB community
- Paid ads su LinkedIn targeting "Investment Banking Associate"

---

## Decision log & open questions

### Decisioni prese
- **D1**: Code-exec sandbox = E2B per MVP (vs self-host) — velocità sviluppo > cost optimization adesso.
- **D2**: Conductor multi-agent solo per task con >5 subtask — overhead non vale per task semplici.
- **D3**: Validation layer = strict (BS balance, CF recon) + warn (margin sanity) — strict bloccano return, warn solo log.
- **D4**: Persistent memory = Postgres + embedding search (no Pinecone/Weaviate per MVP) — ridurre dependency.
- **D5**: Auth = Clerk (vs build custom) — non differenziante, time-to-market priority.
- **D6**: Logger = pino (vs winston/bunyan/custom) — 10x throughput, AsyncLocalStorage native, ecosystem mature.
- **D7**: Sprint 0 (formatting + logging core) precede sprint 1 (sandbox) — formatting bug bloccano demo, logging serve a tracciare bug futuri.
- **D8**: Deprecare `set_format` tool, consolidare in `set_cell_range` — riduce cognitive load LLM e sorgente di bug split-brain.

### Domande aperte
- **Q1**: Domain skills come YAML DSL o pure code (TypeScript class)? YAML più editabile da non-dev, code più potente.
- **Q2**: Market data — partire con FMP $14/mese o solo SEC EDGAR free per MVP?
- **Q3**: Conductor — message passing strutturato (JSON) o shared filesystem? Strutturato più robusto, filesystem più flessibile.
- **Q4**: Eval harness — auto-graded (cell match) sufficiente o serve LLM-as-judge per modelli "directionally correct"?
- **Q5**: Multi-tenancy database — schema-per-tenant o row-level security? RLS più semplice ma performance edge case.

### Rischi
- **R1** (alto): E2B vendor lock-in se prezzi salgono — mitigation: tool API agnostico, migration path documentato (sezione 1.8).
- **R2** (medio): Validation layer troppo strict → blocca task validi → user frustration. Mitigation: tunable threshold per skill, override esplicito utente.
- **R3** (medio): Conductor token cost esplode se main agent + 4 subagent ognuno con 92KB context. Mitigation: context filter aggressivo, subagent prompt minimo.
- **R4** (basso): Stripe + Clerk integration overhead in sprint 6 — mitigation: doc check-in early, no surprise.
- **R5** (alto): se Anthropic/OpenAI rilasciano "Excel agent" nativo prima di noi → wedge perduto. Mitigation: speed, domain depth (loro generici).
- **R6** (alto): bug formatting attuali (Tier 0) emergono in demo cliente → trust killer. Mitigation: sprint 0 fix bloccante prima di sales outreach.
- **R7** (medio): log volume esplode con verbose tool tracing → cost remote sink. Mitigation: sampling debug 1% in prod (sezione O.5), 14 giorni rotation locale.
- **R8** (basso): PII leak in log (user data → Honeycomb) → GDPR risk. Mitigation: regex redaction (O.7) + allowlist explicit per Honeycomb fields.

---

## Appendice — riferimenti

- Stato baseline: `bench/agent_e2e.js 2 simple` p50=25.5s (post-ottimizzazioni 2026-05-05)
- Piano operativo completo: `PIANO_MASTER.md` (Fasi 0-6: registry v2, critic deterministico, formula chunking, smart approval, ecc.)
- Architettura multi-agent: `docs/architecture/multi-agent-conductor.md`
- Schemas tool centralizzati: `server/tools/schemas.js`
- Cache strategy: `server/tools/llm.js` (FNV-1a stability check)
- E2B docs: https://e2b.dev/docs
- SEC EDGAR API: https://www.sec.gov/edgar/sec-api-documentation
- Anthropic PDF support: https://docs.anthropic.com/en/docs/build-with-claude/pdf-support

---

**Last updated**: 2026-05-05
**Owner**: Francesco
**Status**: draft v1 — pending decisione sprint 1 kickoff
