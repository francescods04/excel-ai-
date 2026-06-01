---
name: real-estate-dev-italy
description: Sviluppo immobiliare in Italia — analisi costi/ricavi/finanziamento/valutazione progetto di costruzione (residenziale, terziario, ricettivo). Use for "progetto immobiliare", "valutazione immobile da costruire", "promozione immobiliare", multi-piano, costi di costruzione, oneri urbanizzazione.
size: 7KB
---

# Real Estate Development (Italia) Skill

Usa questa skill per modelli di valutazione finanziaria di progetti immobiliari italiani: residenziale, uffici, alberghiero, retail, mix-use. Particolarmente quando il prompt cita "piani", "mq", "Vairano/Caserta/Milano/...", "costruzione da zero", "promozione immobiliare", "BTC/BTL", o quando l'utente chiede "dividi i costi in sottocosto".

## Workbook Structure (target density)

**Ogni foglio operativo deve raggiungere ~1000 righe quando l'utente lo specifica.**

1. **Assumptions** (50-100 righe): drivers progetto + drivers finanziari + drivers fiscali.
2. **Per-Floor Detail** (units × ~30 voci per piano = 300+ righe per 10 piani): destinazione d'uso, sup lorda, sup commerciale, sup vendibile, prezzo medio/mq, tempo medio assorbimento. UNA RIGA PER PIANO + UNA RIGA PER VOCE.
3. **Cost Breakdown — Sottocosti** (200-1000 righe): vedi tassonomia obbligatoria sotto.
4. **Revenue Schedule** (mensile su 36-60 mesi × N piani = 360-600 righe): velocità di assorbimento mese × piano.
5. **Financing Schedule** (mensile su orizzonte progetto = 36-72 righe per piano + totale): tiraggio mutuo, interessi capitalizzati, rimborso quota capitale, fee bancarie.
6. **Construction Schedule** (mensile per fase = 24-36 mesi): SAL (stato avanzamento lavori) per voce di costo.
7. **Cash Flow** (mensile dettagliato + annuale): operativo + investimenti + finanziario.
8. **P&L** (annuale + cumulativo).
9. **Valuation & Returns**: IRR equity, IRR project, ROE, ROI, NPV, payback, multiple (MOIC), DSCR per periodo.
10. **Sensitivity** (multi-asse): prezzo vendita × costo costruzione, tasso di assorbimento × tasso interesse, ritardo SAL × prezzo. Almeno 3 tabelle 7×7.

## Tassonomia COSTI obbligatoria (italiana, must-have voci)

Quando l'utente chiede "dividi costi in sottocosto", produrre TUTTE queste sezioni come righe distinte (NON aggregare):

### 1. Costi di Acquisizione Area
- Prezzo terreno
- Imposta di registro (9% terreni edificabili, 2% prima casa, vedi caso)
- Imposta ipotecaria fissa €50
- Imposta catastale fissa €50
- Onorario notarile (1-2% del valore)
- Provvigione mediazione (3% + IVA 22%)
- Frazionamenti catastali
- Bonifica/decespugliamento area
- Allacci provvisori cantiere (acqua, energia)

### 2. Costi Tecnici / Soft Cost
- Progettazione architettonica (3-5% costo costruzione)
- Progettazione strutturale (1-2%)
- Progettazione impiantistica (1-2%)
- Coordinamento sicurezza (CSP/CSE) (0.5-1%)
- Direzione Lavori (DL) (1-3%)
- Collaudo statico
- Collaudo impianti
- APE (Attestato Prestazione Energetica)
- Pratiche edilizie (PdC, SCIA, agibilità)
- Frazionamenti finali / accatastamento Docfa

### 3. Oneri Concessori e Costo di Costruzione
- Oneri urbanizzazione primaria (€/mq variabile per Comune)
- Oneri urbanizzazione secondaria
- Contributo costo di costruzione (5-20% del costo convenzionale)
- Monetizzazione standard urbanistici (se applicabile)
- Diritti di segreteria
- Pratiche VVF (Vigili del Fuoco)

### 4. Costi di Costruzione (split per fase/voce — qui si raggiungono le righe)
**Strutture**:
- Scavi e movimentazione terra
- Fondazioni (platea, plinti, magrone)
- Pilastri e travi in c.a.
- Solai
- Scale in c.a.
- Vano ascensore
- Copertura piana / falde
**Tamponamenti e divisori**:
- Tamponamenti perimetrali (mattoni / blocchi termici)
- Divisori interni
- Isolamento a cappotto esterno
- Intonaci interni / esterni
**Impianti** (per piano):
- Impianto elettrico (€/mq)
- Impianto idrico-sanitario (€/mq)
- Impianto termico (caldaie, pompa di calore, fan-coil)
- Impianto condizionamento
- Ventilazione meccanica controllata (VMC)
- Impianto rilevazione incendi
- Impianto TV / fibra
- Impianto fotovoltaico (obbligatorio nuovi edifici)
- Ascensori (€20-40K cad per piano)
**Finiture** (per piano):
- Massetti e sottofondi
- Pavimenti (gres, parquet, ceramica)
- Rivestimenti bagni/cucine
- Infissi esterni (alluminio/PVC/legno)
- Infissi interni
- Sanitari + rubinetterie
- Cucine (se incluse)
- Tinteggiature
- Controsoffitti
- Porte blindate
**Esterni**:
- Sistemazione esterna / pavimentazioni
- Recinzioni
- Cancelli motorizzati
- Verde / giardinaggio
- Impianto irrigazione
- Illuminazione esterna
- Posti auto coperti / scoperti

### 5. Costi di Sicurezza Cantiere
- DPI
- Ponteggi
- Cartelli e segnaletica
- Vigilanza notturna
- Recinzione cantiere
- Box uffici / spogliatoi

### 6. Costi Finanziari
- Istruttoria mutuo costruzione (0.5-1%)
- Perizia bancaria
- Fideiussioni
- Interessi su mutuo (capitalizzati durante costruzione)
- Commissioni gestione (€/anno)
- Imposta sostitutiva mutuo (0.25% o 2%)

### 7. Imposte e Tasse
- IVA su costruzione (10% residenziale ord., 4% prima casa, 22% terziario)
- IMU sull'area (anche edificabile)
- TASI/TARI durante costruzione (se applicabile)
- IRES sui ricavi a fine progetto (24%)
- IRAP (3.9% circa)

### 8. Costi Commerciali e Marketing
- Mediazione su vendite (3% + IVA 22%)
- Marketing/showroom
- Pubblicità portali (idealista, immobiliare.it)
- Render 3D / virtual tour
- Brochure / catalogo
- Costi notarili compromessi (a carico parte)

### 9. Contingency
- Imprevisti tecnici (5-10% costo costruzione)
- Riserva ritardo SAL
- Riserva variazione prezzo materiali

## Revenue Side

- Prezzo vendita €/mq per piano (piani alti +5-10%)
- Mix vendita: residenziale, terziario, box auto, cantine
- Curve di assorbimento (% mese): preliminare, atto, saldo
- Sconti commerciali medi (2-5%)
- Permute (se applicabili)

## Financing — Mutuo Costruzione

- LTC (loan to cost) tipico 60-70%
- LTV (loan to value) 60-80%
- Tasso (Euribor 3m + spread 200-350bp)
- Durata 18-36 mesi
- Tiraggio per SAL (es. 30/40/30 sui SAL)
- Rimborso bullet alla vendita

## Modeling Rules

- **MAI usare etichette inglesi tipo "Construction Cost"**: l'utente è italiano, le voci devono essere italiane.
- **Una voce per riga** (NON aggregare "Strutture" in 1 riga — minimo 7 sottorighe).
- **Per i 10 piani**: matrice 10 piani × N voci. Esempio Construction sheet: 10 piani × 15 voci = 150 righe solo strutture + 10 × 12 voci impianti = 120 righe impianti + ... → si arriva a 1000+ facilmente.
- **Formule devono referenziare Assumptions**, non hard-coded.
- **Tutti gli importi in EUR**, formato `#.##0`.
- **Currency `€`** non `$`.
- **Periodi mensili** dove richiesta dettaglio temporale (no annuali).

## Anti-pattern

- ❌ "Cost Breakdown" con 14 righe e 1 formula `=B4*(1+0.03)^(A5-A4)` ripetuta = fake density.
- ❌ Voci generiche `Materials`, `Labor`, `Equipment`.
- ❌ Nessuna voce IVA / oneri urbanizzazione / DL = non è un modello immobiliare italiano.
- ❌ Tasso interesse 5% senza specificare base (Euribor + spread).
- ❌ Revenue su orizzonte unico senza curva di assorbimento.

## Output checklist (verifica prima di done)

1. Almeno 4 fogli con ≥800 righe ognuno
2. Per-Floor Detail con 10 righe piani
3. Cost Breakdown con ALMENO 80 voci italiane distinte (vedi tassonomia)
4. IVA presente come riga separata, almeno 2 aliquote
5. Oneri urbanizzazione presenti come voce
6. DL presente come voce tecnica
7. Mutuo costruzione modellato con tiraggio SAL
8. IRR equity e IRR project entrambi presenti in Valuation
9. Sensitivity ≥3 tabelle 7×7
10. Tutte voci in italiano
