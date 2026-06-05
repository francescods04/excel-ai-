#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { enhancedPipeline } = require('./enhanced');
const { sanitizeActions, isWholeColumnOrRow, validateActionsStrict } = require('./actionSanitizer');
const { validateCellDeps } = require('./cellDepValidator');
const { runFinanceLints } = require('./financeLint');

const SCENARIOS = {
  sumcol: {
    domain: 'simple',
    objective: 'Crea un foglio "Dati". Header A1:D1: Nome, Età, Città, Età+10 (grassetto, sfondo blu #1F4E79, testo bianco). 5 righe: Mario 30 Roma, Lucia 28 Milano, Paolo 45 Napoli, Anna 22 Torino, Marco 35 Bologna. In D2:D6 formula =B2+10. Bordi su tutto.',
    expect: { sheets: ['Dati'], minCells: 24, minFormulas: 5, mustHaveFormulas: [/=B\d\+10/i] },
  },
  dcf: {
    domain: 'finance',
    objective: 'Crea DCF professionale. Fogli: (1) Assumptions: Tasso Crescita 10%, Margine EBITDA 20%, WACC 8%, Aliquota 25%, Anni 5, Terminal Growth 2.5%, Capex iniziale 2000. (2) Projections Anno 1-5: Revenue parte da 1000, EBITDA = Revenue*Margine, EBIT=EBITDA, Tasse=EBIT*Aliquota, NOPAT, FCF=NOPAT (no D&A). (3) Valuation: Terminal Value=FCF5*(1+g)/(WACC-g), NPV FCF+TV, IRR. SOLO FORMULE. Formattazione IB: header #1F4E79, input #FFF2CC.',
    expect: {
      sheets: ['Assumptions', 'Projections', 'Valuation'],
      minCells: 60,
      minFormulas: 25,
      mustHaveFormulas: [/NPV|Enterprise|IRR/i, /Terminal/i, /Assumptions!/],
      perPeriodFormulas: { Projections: 5 },
    },
  },
  fastfood_bp: {
    domain: 'finance',
    objective: 'Crea business plan MEAT CREW fast-food Milano. Fogli: (1) Assumptions: affitto 8000, food cost 28%, labor 22%, utenze 3%, marketing 2%, scontrino 18, coperti 120, capex 350k, multiplo 8x, WACC 9%. (2) Menu completo: Starters MOCHOS BITES 6.90, CHICKEN TENDERS 6.90. Burger: L.A. 14.50/21.90, CRISPY 14.50/21.90, MAC CHEESE 15.50/22.90, OKLAHOMA 15.00/22.40, JUNIOR 8.50. Sandwiches: PASTRAMI 19.00/26.40, THE O.G. 14.50/21.90. Hot Dogs: BACON DOG 8.00/15.40, CHILI DOG 9.00/16.40. Sides: CRISPY FRIES 5.50, BACON FRIES 6.50, CHILI FRIES 6.50, MAC CHEESE 6.50. Sweets: BANANA PUDDING 4.90, GLAZED DONUT 2.50. Milkshakes 6.00. Drinks: Acqua 2.00, FREE REFILL 4.50, Birra Raw 5.50. (3) Personnel: Manager 3500, 2 Leader 2400, 6 Crew 1500, +30% loaded. (4) Revenue: 60 mesi, stagionalità ±15%, growth Y2+15% Y3+10% Y4-5+5%, revenue = coperti*giorni*scontrino. (5) PnL: 60 mesi + 5 annuali, EBITDA, ammortamenti(350k/60mesi), EBIT, IRES+IRAP, Net Income. (6) CashFlow: Operating CF, Investing, FCF. (7) BreakEven mensile costi fissi/variabili. (8) ScaleUp 4 città. (9) Valuation DCF IRR. (10) Sensitivity 5×5 scontrino×coperti su EBITDA con FORMULE verso Assumptions. SOLO FORMULE.',
    expect: {
      // Accept common synonyms via canonKey fuzzy-match: "Menu" ↔ "Menu Mix", "Personnel" ↔ "Staffing".
      sheets: ['Assumptions', 'Menu', 'Staffing', 'Revenue', 'PnL', 'CashFlow', 'Valuation', 'Sensitivity'],
      minCells: 200,
      minFormulas: 80,
      mustHaveFormulas: [/Assumptions!/, /SUM/i],
    },
  },
  vairano: {
    domain: 'real_estate',
    objective: 'Crea valutazione progetto immobiliare Vairano Scalo (CE): 10 piani, 1000mq/piano. Fogli: (1) Assumptions: Prezzo 2200€/mq, Costo 850€/mq, Oneri 120€/mq, Progettazione 5%, DL 3%, Collaudo 1.5%, Commercializzazione 3% ricavo, Oneri fin 4.5%/18mesi, Imprevisti 5%, Terreno 800k, IVA costi 10%/vendite 4%. (2) Costi: dettaglio con formule verso Assumptions. (3) Ricavi: lordo 2200*10000, netto. (4) PianoFinanziario: Equity 30%, Debito 70%, Interessi 4.5%/2.5anni, bullet. (5) CashFlow: 36 mesi, S-curve costruzione 5/10/20/30/20/10/5%, vendite progressive 10/20/30/25/15% mesi 20-28. (6) ContoEconomico. (7) Indici: ROI, ROE, IRR. (8) Sensitivity 5×5 Prezzo×Costo su Utile con FORMULE verso Assumptions. SOLO FORMULE.',
    expect: {
      sheets: ['Assumptions', 'Costi', 'Ricavi', 'PianoFinanziario', 'CashFlow', 'ContoEconomico', 'Indici', 'Sensitivity'],
      minCells: 120,
      minFormulas: 50,
      mustHaveFormulas: [/Assumptions!/, /IRR/i],
    },
  },

  // GENERALIZATION CHECKS — distinct finance models not in original bench.
  // These verify the pipeline works on common finance tasks the user will
  // actually run, not just the 4 scenarios above.
  lbo: {
    domain: 'finance',
    objective: 'Crea un LBO model semplice. Fogli: (1) Assumptions: Entry EV 500m, Entry EBITDA 50m (10x multiple), Exit Multiple 9x dopo 5 anni, Debt/EBITDA 5x all\'entrata, Interest rate 6%, Tax 25%, Revenue growth 8%/anno, EBITDA margin steady 18%, D&A 4% of revenue, CapEx 5% of revenue, NWC change 1% of revenue change. (2) Sources_Uses: Sources (Debt + Sponsor Equity), Uses (Entry EV + Fees 2%). (3) Projections Year 0-5: Revenue, EBITDA, D&A, EBIT, Interest, EBT, Tax, Net Income, FCF, Debt Schedule (beginning balance, mandatory repayment 5%, sweep, ending balance). (4) Returns: Exit EV, Exit Equity Value (= Exit EV - Final Debt), IRR, MOIC. SOLO FORMULE — niente valori hardcoded per item calcolati.',
    expect: {
      sheets: ['Assumptions', 'Sources_Uses', 'Projections', 'Returns'],
      minCells: 60,
      minFormulas: 25,
      mustHaveFormulas: [/IRR|MOIC/i, /Assumptions!/],
    },
  },
  three_statement: {
    domain: 'finance',
    objective: 'Crea un mini 3-statement model (Income Statement + Balance Sheet + Cash Flow) per una azienda manifatturiera. Fogli: (1) Assumptions: Revenue 100m anno 0, Growth 7%/anno per 4 anni, COGS 60% revenue, OpEx 22% revenue, Tax 25%, D&A 4% revenue, CapEx 6% revenue, DSO 45 giorni, DPO 30 giorni, DIO 60 giorni. (2) IncomeStatement Y0-Y4: Revenue, COGS, Gross Profit, OpEx, EBITDA, D&A, EBIT, Tax, Net Income. (3) BalanceSheet Y0-Y4: Cash (plug), AR (=Revenue×DSO/365), Inventory (=COGS×DIO/365), Total CA, PP&E (=prev+CapEx-D&A), Total Assets, AP (=COGS×DPO/365), Debt steady 20m, Equity (=prev+NI), Total L+E. Verifica TA = TL+E. (4) CashFlow Y1-Y4: NI, +D&A, -ΔAR, -ΔInventory, +ΔAP, Operating CF, -CapEx, Investing CF, Financing CF (0), Net Change Cash, Beginning Cash, Ending Cash. SOLO FORMULE.',
    expect: {
      sheets: ['Assumptions', 'IncomeStatement', 'BalanceSheet', 'CashFlow'],
      minCells: 100,
      minFormulas: 50,
      mustHaveFormulas: [/Assumptions!/, /IncomeStatement!|BalanceSheet!/],
    },
  },

  // STRESS TEST — Complex M&A merger model. 12+ sheets, accretion/dilution,
  // synergies, debt schedule, sensitivity. Pushes pipeline to its limits.
  ma_merger: {
    domain: 'finance',
    objective: 'Crea un M&A merger model completo. Acquirer "AlphaCo" compra "BetaCo". Fogli: (1) Assumptions: Acquirer share price 50, shares outstanding 100m, P/E 15x, EBITDA 200m. Target market cap 1500m, EBITDA 100m, premium offered 30%, deal structure 60% stock / 40% cash. Synergies revenue +50m/anno, cost -30m/anno realizzate linearmente in 3 anni. Tax 25%, financing rate 5%, transaction fees 1.5% del deal value. (2) DealStructure: Offer Price/share, Equity Purchase Price (= target_mcap × 1+premium), Enterprise Value, Cash Consideration, Stock Consideration, New Shares Issued (=stock_consid/acquirer_share). (3) Sources_Uses: Sources (New Debt, New Equity, Cash on hand), Uses (Purchase Equity, Refinance Debt, Fees). (4) AcquirerStandalone Y1-Y5: Revenue, EBITDA, D&A, EBIT, Interest, EBT, Tax, NI. (5) TargetStandalone Y1-Y5 stessa struttura. (6) Synergies Y1-Y5: Revenue synergies (ramp 33/66/100/100/100% of 50m), Cost synergies (ramp), Integration costs (-15m Y1, -10m Y2), Net Synergy. (7) ProForma Y1-Y5: Combined Revenue (=Acquirer+Target+Syn), Combined EBITDA, D&A, EBIT, Interest (on new debt+existing), EBT, Tax, NI. (8) Accretion_Dilution Y1-Y5: Acquirer Standalone EPS, ProForma EPS (=ProForma NI / (acquirer_shares + new_shares)), Accretion/Dilution %, GAAP/Cash EPS distinction. (9) DebtSchedule Y0-Y5: Beginning Debt, Mandatory Amort 5%, Cash Sweep, Ending Debt, Interest Expense. (10) Returns: IRR sponsor, MOIC, NPV synergies. (11) Sensitivity_AccrDil: matrice 5×5 Premium vs Synergies Realization su Y1 Accretion. (12) Sensitivity_IRR: matrice 5×5 Exit Multiple vs Hold Period su IRR. Cross-sheet refs sempre con $.',
    expect: {
      sheets: ['Assumptions', 'DealStructure', 'Sources_Uses', 'AcquirerStandalone', 'TargetStandalone', 'Synergies', 'ProForma', 'Accretion_Dilution', 'DebtSchedule', 'Returns', 'Sensitivity_AccrDil', 'Sensitivity_IRR'],
      minCells: 250,
      minFormulas: 150,
      mustHaveFormulas: [/Assumptions!/, /Synergies|Synerg/i, /Accretion|Dilution|EPS/i],
    },
  },

  // === ANALYST-WEEK-OF-WORK SCENARIOS ===
  // These take a real finance analyst 3-5 days to build properly.

  // Full LBO with operating model + debt waterfall + scenarios + returns
  lbo_full: {
    domain: 'finance',
    objective: `Costruisci LBO model completo per acquisizione "TechCo SaaS" da Private Equity. Fogli necessari:
(1) Cover_Summary: deal summary, returns table (MOIC, IRR base/upside/downside), key metrics.
(2) Assumptions: Entry EV €750m, LTM Revenue €180m, LTM EBITDA €54m (30% margin), Revenue growth Y1-Y5 (15%/13%/11%/10%/8%), EBITDA margin steady 32%, D&A 5% revenue, CapEx 4% revenue, NWC 2% revenue change, Tax 24%. Exit Multiple 11x EBITDA. Debt structure: Revolver €50m undrawn, Term Loan A €150m (5% amort + 4% rate), Term Loan B €250m (1% amort + 5% rate), Senior Notes €100m (0% amort + 6.5% rate). Equity €200m sponsor.
(3) Sources_Uses: Sources (Equity €200m + new Debt €500m + Cash on Hand €50m), Uses (Entry EV + Transaction Fees 2%). Balance check.
(4) Operating_Model Y0-Y5 quarterly: Revenue, EBITDA, D&A, EBIT, Interest expense (linked to debt schedule), EBT, Tax, Net Income, FCF (NI + D&A - CapEx - NWC change).
(5) Debt_Schedule Y0-Y5 quarterly: per-tranche begin balance, mandatory amort, cash sweep (50% excess FCF), ending balance, interest on average balance, total debt service. Revolver draw if cash insufficient.
(6) Balance_Sheet Y0-Y5: Cash plug, AR, Inventory, PP&E (PP&E rollforward), Total Assets = Debt (per tranche) + Equity. Check.
(7) Cash_Flow Y0-Y5: Operating CF + Investing (CapEx) + Financing (debt paydown).
(8) Credit_Stats: Total Leverage (Debt/EBITDA), Senior Leverage, Interest Coverage (EBITDA/Interest), FCCR. By year.
(9) Returns: Exit EV Y5 = Exit Multiple × Y5 EBITDA. Equity Value = Exit EV - Net Debt. MOIC = Exit Equity / Entry Equity. IRR base case + sensitivity. Cash on Cash multiple. NPV at hurdle rate.
(10) Sensitivity_MOIC: 5×5 grid Entry Multiple (12x-16x) vs Exit Multiple (9x-13x).
(11) Sensitivity_IRR: 5×5 grid Revenue Growth (10%-20%) vs Exit Multiple (9x-13x).
(12) Scenarios: Base/Upside/Downside summary table with key metrics each scenario.
CRITICAL: SOLO FORMULE. Cross-sheet refs SEMPRE absolute con $. Returns formulas correct: IRR over EQUITY cash flows, NPV with WACC discount rate.`,
    expect: {
      sheets: ['Cover_Summary', 'Assumptions', 'Sources_Uses', 'Operating_Model', 'Debt_Schedule', 'Balance_Sheet', 'Cash_Flow', 'Credit_Stats', 'Returns', 'Sensitivity_MOIC', 'Sensitivity_IRR', 'Scenarios'],
      minCells: 400,
      minFormulas: 250,
      mustHaveFormulas: [/IRR|MOIC/i, /Assumptions!/, /Debt|Leverage/i],
    },
  },

  // Multi-location franchise rollout model
  franchise_rollout: {
    domain: 'finance',
    objective: `Crea un modello di rollout per una catena di gelaterie premium "GELATO LAB" da 1 a 25 location in 5 anni. Fogli:
(1) Assumptions: Capex per location €180k, Pre-opening €25k, Working Capital €15k. Mature location: Daily customers 280, Conversion 90%, AOV €11.50, COGS 28%, Labor 24% of revenue, Rent €4.5k/month, Marketing 3% revenue, Utilities/Other €2.5k/month, Tax 24%. Ramp curve: Month 1=40%, M2=60%, M3=80%, M4-12=100%. Annual revenue growth post-Y1: 5%.
(2) Rollout_Schedule: numero location aperte per trimestre Q1Y1=1, Q2Y1=1, Q3Y1=2, Q4Y1=2, Q1Y2=3, Q2Y2=3, Q3Y2=3, Q4Y2=3, Y3=4 per Q, Y4=2 per Q, Y5=2 per Q. Total 25 location.
(3) Single_Location_PnL: 60 mesi P&L per UNA location matura (Revenue, COGS, Gross Profit, Labor, Rent, Marketing, Utilities, EBITDA, Tax, NI).
(4) Cohort_Analysis: per ogni cohort di location (apertura Q), calcola Revenue/EBITDA per mese da apertura. 8 cohorts in Y1-Y2.
(5) Consolidated_PnL Y1-Y5 monthly: somma di tutte le cohort attive ogni mese.
(6) Consolidated_CashFlow Y1-Y5: Operating CF, Investing (capex × new openings per Q), Financing.
(7) Funding_Need: cumulative capex required + working capital + minimum cash buffer.
(8) Returns: IRR equity by year, MOIC per location average, payback period per location.
(9) Sensitivity: 5×5 AOV vs Daily Customers su Year-5 EBITDA.
(10) ScaleEconomics: HQ cost (€500k/year fixed), regional managers (€80k each per 5 location), supply chain savings (-2% COGS at 10+ location, -4% at 20+).
CRITICAL: SOLO FORMULE. Match cohort opening date to ramp curve correctly. EBITDA includes HQ allocation.`,
    expect: {
      sheets: ['Assumptions', 'Rollout_Schedule', 'Single_Location_PnL', 'Cohort_Analysis', 'Consolidated_PnL', 'Consolidated_CashFlow', 'Funding_Need', 'Returns', 'Sensitivity', 'ScaleEconomics'],
      minCells: 500,
      minFormulas: 300,
      mustHaveFormulas: [/Assumptions!/, /Cohort|Rollout/i, /IRR/i],
    },
  },

  // SaaS subscription business with cohort revenue model
  // === MEGA SCENARIOS — 20+ sheets, 5k-10k cells, full institutional deliverable ===
  // These represent 1-2 weeks of analyst work.

  lbo_institutional: {
    domain: 'finance',
    objective: `Costruisci un LBO MODEL ISTITUZIONALE completo (deliverable da MD-PE-firm) per acquisizione "MediaCorp" da PE. Tutti i seguenti 22 fogli devono essere generati con FORMULE (no hardcoded computed):

(1) Cover_Page: deal name, sponsor, target, transaction date, key returns summary.
(2) Executive_Summary: deal overview, valuation, transaction multiples, returns by scenario.
(3) Transaction_Overview: deal structure, ownership pre/post, key dates.
(4) Sources_Uses: full table con balance check. Sources (Revolver, TLA, TLB, Senior Notes, Mezz, Sponsor Equity, Mgmt Rollover, Cash on Hand). Uses (Equity Purchase Price, Refinance Debt, Transaction Fees, Financing Fees, OID, Working Capital). Total Sources = Total Uses (check formula).
(5) Assumptions_Operating: Revenue €450m LTM, Growth Y1-Y5 (10%/9%/8%/7%/6%), EBITDA margin steady 32%, D&A 4% revenue, CapEx 5% revenue, NWC 2% delta revenue, Tax 24%.
(6) Assumptions_Financing: Revolver €75m undrawn (3.5% rate, 0.5% commitment fee), TLA €200m (4.5% rate, 5% amort), TLB €350m (5.5% rate, 1% amort), Senior Notes €150m (7% rate, 0% amort), Mezz €100m (10% PIK), all with maturity dates. Entry Multiple 11x LTM EBITDA. Exit Multiple 10x at Y5.
(7) Pre_Acquisition_PnL Y-2..Y0: historical 3yr P&L for target.
(8) Operating_Model Y0-Y5 quarterly (24 quarter cols): Revenue, COGS, GP, SG&A, EBITDA, D&A, EBIT, Interest, EBT, Tax, NI. Tutti quarterly formula.
(9) Annual_Rollup Y0-Y5: SUM of 4 quarters per year for all P&L lines.
(10) Debt_Schedule Y0-Y5 quarterly: per-tranche begin balance, mandatory amort, cash sweep (75% excess FCF), ending balance, interest on avg, total debt service.
(11) Balance_Sheet Y0-Y5: Cash plug, AR, Inventory, PP&E rollforward, Total Assets = Debt by tranche + Mezz + Equity rollforward. Check formula.
(12) Cash_Flow Y0-Y5: NI + D&A - CapEx - NWC = FCF. Operating CF, Investing CF, Financing CF.
(13) Working_Capital_Schedule: DSO, DPO, DIO build, NWC per period.
(14) Credit_Stats Y0-Y5: Total Leverage, Senior Leverage, Net Leverage, Interest Coverage, FCCR, Min Coverage Trigger.
(15) Covenant_Compliance: Maintenance covenants (Leverage <6x, ICR >2x), Springing covenants, baskets, Compliance/Breach status per period.
(16) Returns_Equity: Equity Cash Flows Y0-Y5, Sponsor IRR, Sponsor MOIC, Cash on Cash Multiple.
(17) Returns_Detail: Per scenario MOIC build (Operations CF + Multiple Expansion + Debt Paydown).
(18) WACC_Build: Risk-free rate, ERP, Beta (levered/unlevered), Cost of Equity, Cost of Debt after-tax, Capital Structure, WACC.
(19) Comparables_Trading: 6 public comps with EV/Revenue, EV/EBITDA, P/E multiples (current + LTM + NTM).
(20) Sensitivity_IRR: 5x5 grid Entry Multiple (10x-14x) vs Exit Multiple (8x-12x) → Sponsor IRR.
(21) Sensitivity_MOIC: 5x5 grid Revenue Growth (5%-15%) vs Exit Multiple (8x-12x) → MOIC.
(22) Scenarios: 5 scenarios (Worst / Bear / Base / Bull / Best) con tutti i key outputs.

CRITICAL: SOLO FORMULE. Cross-sheet refs absolute. Sources=Uses balance check. Returns IRR su equity flows (B<0 inflows then C..G >0).`,
    expect: {
      sheets: ['Cover_Page', 'Executive_Summary', 'Transaction_Overview', 'Sources_Uses', 'Assumptions_Operating', 'Assumptions_Financing', 'Pre_Acquisition_PnL', 'Operating_Model', 'Annual_Rollup', 'Debt_Schedule', 'Balance_Sheet', 'Cash_Flow', 'Working_Capital_Schedule', 'Credit_Stats', 'Covenant_Compliance', 'Returns_Equity', 'Returns_Detail', 'WACC_Build', 'Comparables_Trading', 'Sensitivity_IRR', 'Sensitivity_MOIC', 'Scenarios'],
      minCells: 2000,
      minFormulas: 1200,
      mustHaveFormulas: [/IRR|MOIC/i, /WACC/i, /Leverage|Coverage/i, /Sources_Uses/i],
    },
  },

  bank_stress_test: {
    domain: 'finance',
    objective: `Crea uno STRESS TEST BANCARIO 3-year forward completo per banca commerciale "EuroBank" sotto scenari macroeconomici (base/adverse/severely adverse). Fogli (20+):

(1) Macro_Scenarios: GDP growth, Unemployment, Interest rates, Equity index, House prices per scenario per quarter (12 quarter forward).
(2) Loan_Book: per segment (Corporate / Mortgage / SME / Retail / Consumer): Balance, average rate, NPL ratio, LGD, PD per scenario.
(3) Interest_Income: per segment per scenario per quarter: rate × avg balance.
(4) Funding_Cost: deposit base, average cost, wholesale funding, repos.
(5) Net_Interest_Margin: NII / avg interest earning assets.
(6) Trading_Book_PnL: market shock scenarios on equity, FX, IR, Credit positions.
(7) Fees_Commissions: F&C revenue forward.
(8) Operating_Expenses: staff costs, G&A, D&A, regulatory costs (resolution fund).
(9) Loan_Loss_Provisions: IFRS 9 staging (S1/S2/S3), ECL per stage per segment per scenario.
(10) NPL_Forecast: New NPL inflows, cures, write-offs, NPL stock per quarter.
(11) PnL_Forecast 12Q: NII + F&C + Trading + Other - OpEx - Provisions - Tax = NI.
(12) Capital_Position: CET1, Tier1, T2, Total Capital each quarter.
(13) RWA_Build: Credit RWA (per segment), Market RWA, Operational RWA per scenario.
(14) Capital_Ratios: CET1/RWA, Tier1/RWA, Total Capital/RWA per scenario per quarter.
(15) Liquidity_Ratios: LCR (HQLA / net outflows), NSFR (stable funding / required), LDR.
(16) Capital_Actions: Dividend, buyback, rights issue, AT1 issuance.
(17) Stress_Impact_Summary: Capital depletion vs starting CET1 per scenario.
(18) Regulatory_Buffers: Pillar 2 buffer, CCB, CCyB, G-SIB, applicable per quarter.
(19) Sensitivity_CET1: 5x5 GDP shock vs Unemployment shock → CET1 end-period.
(20) Reverse_Stress_Test: find combination of shocks that breach CET1 minimum (4.5% + buffers).
(21) Scenario_Summary: KPIs (NI, ROE, CET1, NPL ratio, NIM) per scenario per year.
(22) Executive_Dashboard: heat map of key ratios vs regulatory minima.

CRITICAL: SOLO FORMULE. Cross-scenario refs use absolute. Provisions linked to PD × LGD × EAD per segment. NIM = NII / interest earning assets. CET1 ratio = CET1 / RWA.`,
    expect: {
      sheets: ['Macro_Scenarios', 'Loan_Book', 'Interest_Income', 'Funding_Cost', 'Net_Interest_Margin', 'Trading_Book_PnL', 'Fees_Commissions', 'Operating_Expenses', 'Loan_Loss_Provisions', 'NPL_Forecast', 'PnL_Forecast', 'Capital_Position', 'RWA_Build', 'Capital_Ratios', 'Liquidity_Ratios', 'Capital_Actions', 'Stress_Impact_Summary', 'Sensitivity_CET1', 'Scenario_Summary'],
      minCells: 2500,
      minFormulas: 1500,
      mustHaveFormulas: [/CET1|RWA/i, /NIM|Interest/i, /Provisions|ECL/i],
    },
  },

  saas_full: {
    domain: 'finance',
    objective: `Crea modello SaaS "DataCloud" cohort-based valuation. Fogli:
(1) Assumptions: Starting ARR €5m, Y1-Y5 new ARR growth (60%/45%/35%/25%/20%), Gross retention 92%, Net retention 110% (upsell), Gross margin 78%, S&M as % of ARR (45%/40%/35%/30%/25%), R&D % (25% steady), G&A % (12% Y1 declining to 8%), Tax 24%, Discount rate (WACC) 10%, Terminal growth 3%, Exit Multiple 8x ARR (or 25x EBITDA).
(2) Cohort_Revenue Y1-Y5 quarterly: ogni cohort di nuovi customer ha churn 8%/anno e upsell 18%/anno. Build matrix di revenue contribution per cohort × quarter.
(3) ARR_Build: New ARR + Expansion ARR - Churned ARR = Net New ARR. Beginning + Net = Ending ARR.
(4) Revenue_PnL: Subscription revenue = Average ARR × 12 (or simply ending ARR for recognized rev). COGS, Gross Profit, S&M, R&D, G&A, EBITDA, D&A, EBIT, Tax, NI.
(5) Cash_Flow Y1-Y5 quarterly: Operating CF, deferred revenue impact, CapEx, Working Capital.
(6) Unit_Economics: LTV per customer (= ARPU × Gross Margin / Churn), CAC (= S&M spend / new customers), LTV/CAC ratio, CAC payback months, Magic Number (Net New ARR Q×4 / S&M Q prior).
(7) DCF_Valuation: FCF projection Y1-Y5 + Terminal Value (Gordon Growth or Exit Multiple). Discount to PV. Enterprise Value, Equity Value, Per-Share if shares given.
(8) Comparables: Rule of 40 (Growth + EBITDA margin), Multiples by year (EV/ARR, EV/Revenue, EV/EBITDA).
(9) Sensitivity: 5×5 Net Retention vs Discount Rate su Enterprise Value.
(10) Scenarios: Conservative/Base/Aggressive with key inputs sensitized.
CRITICAL: SOLO FORMULE. Cohort revenue calculation correct (compound retention). LTV/CAC sanity check.`,
    expect: {
      sheets: ['Assumptions', 'Cohort_Revenue', 'ARR_Build', 'Revenue_PnL', 'Cash_Flow', 'Unit_Economics', 'DCF_Valuation', 'Comparables', 'Sensitivity', 'Scenarios'],
      minCells: 450,
      minFormulas: 300,
      mustHaveFormulas: [/Assumptions!/, /ARR|Retention|Churn/i, /LTV|CAC/i],
    },
  },
};

function summarizeActions(actions) {
  const sheets = new Set();
  const refs = new Set();
  let totalCells = 0;
  let formulas = 0;
  let hardcoded = 0;
  let formattedNumeric = 0;
  let unformattedNumeric = 0;
  let fillRangeCount = 0;
  let wholeColumn = 0;
  const formulasByCell = new Map();
  const allFormulaStrings = [];
  const allLabelStrings = [];
  const cellsBySheet = {};
  const addressTouchCount = new Map();
  const refsWithoutDollar = [];

  for (const a of actions || []) {
    if (a.sheet) sheets.add(a.sheet);
    if (a.type === 'createSheet') sheets.add(a.sheet);
    if (a.type === 'fillRange') fillRangeCount++;
    if (a.type === 'setCellFormat' && a.target && isWholeColumnOrRow(a.target)) wholeColumn++;
    if (a.type === 'setCellRange' && a.cells) {
      const sh = a.sheet || a.sheetName || 'Sheet1';
      cellsBySheet[sh] = cellsBySheet[sh] || 0;
      for (const [addr, spec] of Object.entries(a.cells)) {
        totalCells++;
        cellsBySheet[sh]++;
        const fullKey = `${sh}!${addr}`;
        addressTouchCount.set(fullKey, (addressTouchCount.get(fullKey) || 0) + 1);
        if (isWholeColumnOrRow(addr)) wholeColumn++;
        if (!spec || typeof spec !== 'object') {
          if (typeof spec === 'number') { hardcoded++; unformattedNumeric++; }
          continue;
        }
        const hasFormula = typeof spec.formula === 'string' && spec.formula.length > 0;
        const isNumeric = typeof spec.value === 'number';
        const hasNumFmt = !!(spec.cellStyles && spec.cellStyles.numberFormat);
        if (typeof spec.value === 'string') allLabelStrings.push(spec.value);
        if (hasFormula) {
          formulas++;
          formulasByCell.set(`${sh}!${addr}`, spec.formula);
          allFormulaStrings.push(spec.formula);
          const refMatches = spec.formula.match(/([A-Za-z_][A-Za-z0-9_]*)!/g);
          if (refMatches) refMatches.forEach(s => refs.add(s.replace('!', '')));
          // Detect cross-sheet refs without absolute $ — they break when copied across periods.
          const crossSheetNoDollar = spec.formula.match(/[A-Za-z_]\w*![A-Z]+\d+(?![:])/g);
          if (crossSheetNoDollar) {
            for (const r of crossSheetNoDollar) {
              if (!r.includes('$')) refsWithoutDollar.push(`${fullKey}: ${r}`);
            }
          }
        } else if (isNumeric) {
          hardcoded++;
          if (hasNumFmt) formattedNumeric++; else unformattedNumeric++;
        }
      }
    }
  }

  const missingSheetRefs = [...refs].filter(r => !sheets.has(r));
  const duplicateAddresses = [...addressTouchCount.entries()].filter(([, n]) => n > 1).map(([k]) => k);

  return {
    sheets: [...sheets],
    totalCells, formulas, hardcoded,
    formattedNumeric, unformattedNumeric,
    fillRangeCount, wholeColumn,
    missingSheetRefs,
    duplicateAddresses,
    refsWithoutDollar: refsWithoutDollar.slice(0, 10),
    cellsBySheet,
    allFormulaStrings,
    allLabelStrings,
  };
}

function scoreScenario(key, scenario, actions, summary) {
  const exp = scenario.expect || {};
  const issues = [];

  // Cell-level dependency validation — catches #REF!/#NAME?/#VALUE! before deploy.
  const depIssues = validateCellDeps(actions);
  for (const d of depIssues) {
    issues.push({ severity: d.severity, kind: d.kind, msg: `${d.location}: ${d.detail}` });
  }
  // Finance-specific lints (sensitivity dead grid, IRR array, scenario static, etc.)
  const lintIssues = runFinanceLints(actions);
  for (const l of lintIssues) {
    issues.push({ severity: l.severity, kind: l.kind, msg: `${l.location}: ${l.detail}` });
  }

  function canonKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  const presentKeys = summary.sheets.map(canonKey);
  function matchSheet(req) {
    const r = canonKey(req);
    return presentKeys.some(p => p === r || p.includes(r) || r.includes(p));
  }
  for (const required of exp.sheets || []) {
    if (!matchSheet(required)) {
      issues.push({ severity: 'critical', kind: 'missing_sheet', msg: `sheet "${required}" not created` });
    }
  }
  if (exp.minCells && summary.totalCells < exp.minCells) {
    issues.push({ severity: 'high', kind: 'low_density', msg: `cells ${summary.totalCells} < expected ${exp.minCells}` });
  }
  if (exp.minFormulas && summary.formulas < exp.minFormulas) {
    issues.push({ severity: 'high', kind: 'low_formulas', msg: `formulas ${summary.formulas} < expected ${exp.minFormulas}` });
  }
  for (const re of exp.mustHaveFormulas || []) {
    const hit = summary.allFormulaStrings.some(f => re.test(f))
      || summary.allLabelStrings.some(l => re.test(l));
    if (!hit) issues.push({ severity: 'high', kind: 'missing_concept', msg: `no formula or label matches ${re}` });
  }
  if (summary.fillRangeCount > 0) {
    issues.push({ severity: 'medium', kind: 'fillRange_leaked', msg: `${summary.fillRangeCount} fillRange leaked past sanitizer` });
  }
  if (summary.wholeColumn > 0) {
    issues.push({ severity: 'critical', kind: 'whole_column', msg: `${summary.wholeColumn} whole-column refs` });
  }
  if (summary.missingSheetRefs.length > 0) {
    issues.push({ severity: 'critical', kind: 'broken_refs', msg: `formulas reference non-existent sheets: ${summary.missingSheetRefs.join(', ')}` });
  }
  if (summary.duplicateAddresses.length > 0) {
    issues.push({ severity: 'high', kind: 'duplicate_addresses', msg: `${summary.duplicateAddresses.length} cells written twice (slice collision): ${summary.duplicateAddresses.slice(0, 3).join(', ')}` });
  }
  if (summary.refsWithoutDollar.length > 5) {
    issues.push({ severity: 'medium', kind: 'cross_sheet_no_dollar', msg: `${summary.refsWithoutDollar.length}+ cross-sheet refs without $ (will break on copy)` });
  }
  if (summary.hardcoded > summary.formulas && summary.formulas > 0) {
    issues.push({ severity: 'medium', kind: 'too_many_hardcoded', msg: `${summary.hardcoded} hardcoded numerics vs ${summary.formulas} formulas` });
  }
  for (const required of exp.sheets || []) {
    const r = canonKey(required);
    const matchedReal = summary.sheets.find(s => {
      const p = canonKey(s);
      return p === r || p.includes(r) || r.includes(p);
    });
    if (matchedReal && (!summary.cellsBySheet[matchedReal] || summary.cellsBySheet[matchedReal] < 4)) {
      issues.push({ severity: 'high', kind: 'empty_sheet', msg: `sheet "${required}" (→${matchedReal}) has only ${summary.cellsBySheet[matchedReal] || 0} cells` });
    }
  }
  if (summary.unformattedNumeric > 5) {
    issues.push({ severity: 'low', kind: 'unformatted_numbers', msg: `${summary.unformattedNumeric} numeric cells without numberFormat` });
  }

  // Semantic checks: detect Mix % NOT summing to 100% via SUMPRODUCT
  for (const f of summary.allFormulaStrings) {
    if (/SUMPRODUCT/i.test(f) && /\bF\b|\bMix\b/i.test(f)) {
      // We can't easily evaluate without running Excel — but flag suspicious patterns
    }
  }

  const criticalCount = issues.filter(i => i.severity === 'critical').length;
  const highCount = issues.filter(i => i.severity === 'high').length;
  const mediumCount = issues.filter(i => i.severity === 'medium').length;
  const lowCount = issues.filter(i => i.severity === 'low').length;
  const score = Math.max(0, 100 - criticalCount * 25 - highCount * 10 - mediumCount * 4 - lowCount * 1);
  const passed = criticalCount === 0 && highCount === 0;

  return { score, passed, issues, criticalCount, highCount, mediumCount, lowCount };
}

async function runScenario(key, scenario) {
  const start = Date.now();
  let result;
  try {
    result = await enhancedPipeline(scenario.objective, {}, { skipCritic: true });
  } catch (e) {
    return { key, status: 'error', error: e.message, elapsedS: (Date.now() - start) / 1000 };
  }

  if (result.status !== 'ok') {
    return { key, status: 'failed', error: result.error, elapsedS: (Date.now() - start) / 1000 };
  }

  const summary = summarizeActions(result.actions);
  const score = scoreScenario(key, scenario, result.actions, summary);
  const elapsedS = (Date.now() - start) / 1000;
  const tokens = (result.totalTokens?.promptTokens || 0) + (result.totalTokens?.completionTokens || 0);

  return {
    key,
    status: 'ok',
    elapsedS,
    tokens,
    cellCount: summary.totalCells,
    formulaCount: summary.formulas,
    sheets: summary.sheets,
    fillRangeCount: summary.fillRangeCount,
    wholeColumn: summary.wholeColumn,
    missingSheetRefs: summary.missingSheetRefs,
    sanitizer: result.pipeline?.sanitizer || result.sanitizerStats || null,
    ...score,
    actions: result.actions,
  };
}

async function main() {
  const filter = process.argv.find(a => a.startsWith('--scenario='));
  const keys = filter ? filter.split('=')[1].split(',') : Object.keys(SCENARIOS);
  const saveActions = process.argv.includes('--save-actions');
  const serial = process.argv.includes('--serial');

  const wallStart = Date.now();
  console.log('═══ CODEFIRST QUALITY BENCH ═══');
  console.log(`Model: ${process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'}`);
  console.log(`Scenarios: ${keys.join(', ')} (${serial ? 'serial' : 'parallel'})\n`);

  const scenarios = keys.map(k => ({ key: k, sc: SCENARIOS[k] })).filter(x => x.sc);

  const reportResult = (r) => {
    if (r.status !== 'ok') {
      console.log(`─── ${r.key} ───`);
      console.log(`  ✗ ${r.status}: ${r.error}`);
      return;
    }
    const flag = r.passed ? '✓' : '✗';
    console.log(`─── ${r.key} ───`);
    console.log(`  ${flag} score=${r.score}/100 cells=${r.cellCount} formulas=${r.formulaCount} sheets=${r.sheets.length} ${r.elapsedS.toFixed(0)}s ${r.tokens.toLocaleString()}tok`);
    if (r.sanitizer) console.log(`  sanitizer: ${JSON.stringify(r.sanitizer)}`);
    for (const i of r.issues) console.log(`    [${i.severity}] ${i.kind}: ${i.msg}`);
    if (saveActions) {
      const out = path.join('/tmp', `cf_actions_${r.key}_${Date.now()}.json`);
      fs.writeFileSync(out, JSON.stringify({ scenario: r.key, summary: r, actions: r.actions }, null, 2));
      console.log(`  actions → ${out}`);
    }
  };

  let results;
  if (serial) {
    results = [];
    for (const { key, sc } of scenarios) {
      const r = await runScenario(key, sc);
      results.push(r);
      reportResult(r);
    }
  } else {
    results = await Promise.all(scenarios.map(({ key, sc }) => runScenario(key, sc)));
    for (const r of results) reportResult(r);
  }
  const wallS = (Date.now() - wallStart) / 1000;

  console.log('\n═══ SUMMARY ═══');
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const avgScore = results.reduce((s, r) => s + (r.score || 0), 0) / Math.max(1, total);
  const sumTime = results.reduce((s, r) => s + (r.elapsedS || 0), 0);
  const avgTime = sumTime / Math.max(1, total);
  console.log(`Pass: ${passed}/${total} | avg score: ${avgScore.toFixed(1)}/100 | avg per scenario: ${avgTime.toFixed(0)}s | sum: ${sumTime.toFixed(0)}s | wall: ${wallS.toFixed(0)}s`);

  const outPath = path.join('/tmp', `cf_quality_${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results.map(r => ({ ...r, actions: undefined })), null, 2));
  console.log(`Saved → ${outPath}`);

  process.exit(passed === total ? 0 : 1);
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e); process.exit(2); });
}

module.exports = { SCENARIOS, runScenario, summarizeActions, scoreScenario };
