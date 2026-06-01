/**
 * Complex multi-domain benchmark scenarios.
 *
 * Hard, many-interaction tasks across three domains — finance, data science,
 * real estate — designed to surface quality differences between models and
 * thinking modes. Each scenario provides:
 *   - domain       : 'finance' | 'data_science' | 'real_estate'
 *   - objective    : the user prompt (intentionally demanding)
 *   - context      : mock workbook state (same shape turns.startTurn expects).
 *                    Empty Sheet1 => "build from scratch". allSheetsData with
 *                    previews => "read, reason, then extend/repair" (forces
 *                    more client reads and grounding).
 *   - rubric       : weighted checkpoints used by the LLM-judge to score quality
 *                    of the agent's EMITTED actions (sheets/cells/formulas/notes).
 *                    The harness stubs Excel reads, so the judge scores plan and
 *                    construction quality, not live numeric results.
 *
 * Consumed by bench/model_cost_quality.js. Add scenarios freely; keys must be unique.
 */

'use strict';

const emptyWorkbook = (sheet = 'Sheet1') => ({
  activeSheet: sheet,
  workbookSheets: [sheet],
  sheets: [{ name: sheet, usedRange: { rowCount: 0, columnCount: 0 } }]
});

const SCENARIOS = {
  /* ============================== FINANCE ============================== */

  fin_lbo_full: {
    domain: 'finance',
    objective:
      'Crea da zero un modello LBO completo (~800-1000 righe) per un target tech (CrowdStrike, CRWD). Includi: Cover & Summary, Sources & Uses, Transaction Assumptions, Debt Schedule (Term Loan A/B + Revolver + Senior Notes con cash sweep), Operating Model 3-statement (IS/BS/CFS) a 5 anni, Free Cash Flow + debt paydown waterfall, Returns (MoM, IRR sponsor, IRR per exit multiple), Sensitivity (entry x exit multiple), Credit Stats (Total/Senior Leverage, Interest Coverage), e note sulle fonti delle assumptions. Usa named range per le assumptions chiave e scenari base/upside/downside.',
    context: emptyWorkbook(),
    loopPromptVariant: 'default',
    rubric: [
      'All required sheets exist (Summary, Sources & Uses, Assumptions, Debt Schedule, IS, BS, CFS, FCF/Waterfall, Returns, Sensitivity, Credit Stats)',
      'Debt schedule models multiple tranches with interest, mandatory amortization and a cash-flow sweep that actually reduces balances',
      '3 statements are linked (net income -> retained earnings/BS, FCF -> cash -> BS, no plugged cash)',
      'Returns computed from an equity cash-flow series (entry equity out, exit equity in) — IRR/MoM via formulas, not hardcoded',
      'Sensitivity table is a real 2-way data table (entry x exit), not static numbers',
      'Assumptions centralized + named ranges + source notes on key inputs',
      'No #REF!/circularity hacks; credit stats reference the debt schedule'
    ]
  },

  fin_merger_accretion: {
    domain: 'finance',
    objective:
      'Costruisci un merger model M&A: acquirer (ticker BUY) acquisisce target (ticker TGT) in cash+stock. Parti dai 3-statement standalone presenti, poi: purchase price allocation (goodwill, step-up), financing mix (new debt + azioni emesse), pro forma combined income statement con sinergie (cost + revenue) e nuovi interessi, accretion/dilution dell\'EPS anno 1-3, e una sensitivity EPS accretion vs % cash e vs sinergie. Evidenzia il break-even delle sinergie.',
    context: {
      activeSheet: 'PF_Combined',
      workbookSheets: ['BUY_IS', 'TGT_IS', 'Assumptions', 'PF_Combined'],
      sheets: [
        { name: 'BUY_IS', usedRange: { rowCount: 30, columnCount: 7 } },
        { name: 'TGT_IS', usedRange: { rowCount: 28, columnCount: 7 } },
        { name: 'Assumptions', usedRange: { rowCount: 20, columnCount: 4 } },
        { name: 'PF_Combined', usedRange: { rowCount: 5, columnCount: 7 } }
      ],
      allSheetsData: {
        BUY_IS: {
          usedRange: 'BUY_IS!A1:G30', rowCount: 30, columnCount: 7,
          preview: [['$M', '2023A', '2024A', '2025E', '2026E'], ['Revenue', 8200, 9100, 10100, 11100], ['EBIT', 1640, 1870, 2120, 2380], ['Net Income', 1180, 1350, 1530, 1720], ['Shares (M)', 410, 410, 412, 414]]
        },
        TGT_IS: {
          usedRange: 'TGT_IS!A1:G28', rowCount: 28, columnCount: 7,
          preview: [['$M', '2023A', '2024A', '2025E', '2026E'], ['Revenue', 2100, 2400, 2760, 3120], ['EBIT', 315, 384, 470, 562], ['Net Income', 210, 260, 325, 400], ['Shares (M)', 120, 121, 122, 123]]
        },
        Assumptions: {
          usedRange: 'Assumptions!A1:D20', rowCount: 20, columnCount: 4,
          preview: [['Driver', 'Value'], ['Offer premium', '30%'], ['% Cash', '60%'], ['New debt rate', '6.5%'], ['Cost synergies (run-rate)', 180], ['Tax rate', '25%']]
        },
        PF_Combined: { isActive: true, usedRange: 'PF_Combined!A1:G5', rowCount: 5, columnCount: 7, preview: [['Pro Forma', '2025E', '2026E', '2027E']] }
      }
    },
    loopPromptVariant: 'default',
    rubric: [
      'Purchase price + premium computed from target shares/price; PPA produces goodwill and step-up',
      'Financing split (cash vs stock) drives new debt, new shares issued, and incremental interest',
      'Pro forma combined IS = BUY + TGT + synergies - new interest (after-tax), built with formulas referencing standalones',
      'EPS accretion/dilution = PF EPS vs standalone acquirer EPS, for 3 years',
      'Synergy phase-in and break-even synergy level addressed',
      'Sensitivity of accretion vs %cash and vs synergies is a real data table',
      'Outputs reference Assumptions (premium, %cash, rate, synergies) — no magic numbers'
    ]
  },

  fin_credit_covenant: {
    domain: 'finance',
    objective:
      'Sviluppa un\'analisi creditizia su un emittente levered: a partire dal debt stack e dal forecast EBITDA presenti, costruisci il cash flow available for debt service, un cash sweep waterfall multi-tranche (Revolver -> TLA -> TLB), il calcolo dei covenant (Total Leverage, Senior Leverage, Interest Coverage, Fixed Charge Coverage) con headroom vs i limiti, e un toggle di scenario (base/downside) che mostra in quale anno il covenant viene breachato. Aggiungi note metodologiche.',
    context: {
      activeSheet: 'Credit',
      workbookSheets: ['DebtStack', 'Forecast', 'Credit'],
      sheets: [
        { name: 'DebtStack', usedRange: { rowCount: 16, columnCount: 6 } },
        { name: 'Forecast', usedRange: { rowCount: 24, columnCount: 8 } },
        { name: 'Credit', usedRange: { rowCount: 3, columnCount: 8 } }
      ],
      allSheetsData: {
        DebtStack: {
          usedRange: 'DebtStack!A1:F16', rowCount: 16, columnCount: 6,
          preview: [['Tranche', 'Amount', 'Rate', 'Amort %/yr', 'Covenant'], ['Revolver', 100, 'SOFR+300', 0, ''], ['Term Loan A', 400, 'SOFR+350', '10%', 'Total Lev <= 5.0x'], ['Term Loan B', 800, 'SOFR+450', '1%', 'Senior Lev <= 4.0x']]
        },
        Forecast: {
          usedRange: 'Forecast!A1:H24', rowCount: 24, columnCount: 8,
          preview: [['$M', '2025E', '2026E', '2027E', '2028E', '2029E'], ['EBITDA', 320, 350, 372, 395, 420], ['Capex', 70, 74, 78, 82, 86], ['Cash taxes', 38, 44, 49, 55, 61], ['Delta NWC', 12, 14, 12, 15, 13]]
        },
        Credit: { isActive: true, usedRange: 'Credit!A1:H3', rowCount: 3, columnCount: 8, preview: [['Credit Metrics', '2025E', '2026E', '2027E']] }
      }
    },
    loopPromptVariant: 'default',
    rubric: [
      'CFADS built from EBITDA - capex - cash taxes - delta NWC, by year, via formulas',
      'Cash sweep waterfall applies CFADS across tranches in priority and reduces balances year over year',
      'All four covenant ratios computed each year referencing debt balances and EBITDA',
      'Headroom vs each covenant limit shown; breach year flagged (e.g., conditional logic)',
      'Scenario toggle (base/downside) actually changes EBITDA path and breach outcome',
      'SOFR/spread used for interest; no hardcoded interest',
      'Methodology notes on key cells'
    ]
  },

  /* ============================ DATA SCIENCE ============================ */

  ds_churn_cohort_ltv: {
    domain: 'data_science',
    objective:
      'Dai dati grezzi di sottoscrizioni presenti (una riga per cliente con signup date, plan, MRR, churn date), costruisci un\'analisi completa: tabella di cohort retention mensile (triangolo), curve di retention per cohort, churn rate mensile e annualizzato, LTV per plan (con discounting), e una previsione di MRR a 12 mesi basata su retention osservata e nuovi acquisti. Aggiungi un mini-dashboard con i KPI e formattazione condizionale sul triangolo di retention.',
    context: {
      activeSheet: 'subs_raw',
      workbookSheets: ['subs_raw'],
      sheets: [{ name: 'subs_raw', usedRange: { rowCount: 5000, columnCount: 7 } }],
      allSheetsData: {
        subs_raw: {
          isActive: true, usedRange: 'subs_raw!A1:G5000', rowCount: 5000, columnCount: 7,
          preview: [
            ['customer_id', 'signup_date', 'plan', 'mrr', 'churn_date', 'country', 'channel'],
            ['C0001', '2024-01-05', 'Pro', 99, '', 'US', 'organic'],
            ['C0002', '2024-01-08', 'Starter', 29, '2024-07-15', 'IT', 'paid'],
            ['C0003', '2024-02-02', 'Enterprise', 499, '', 'DE', 'sales']
          ]
        }
      }
    },
    loopPromptVariant: 'default',
    rubric: [
      'Monthly cohort retention triangle built (cohorts as rows, months-since-signup as columns)',
      'Retention/churn computed from signup_date vs churn_date logic (counts active per period), not invented',
      'Churn rate monthly + annualized; LTV per plan uses MRR, churn and a discount factor',
      '12-month MRR forecast combines surviving base (retention) + new adds assumption',
      'KPI dashboard (active subs, MRR, churn%, LTV, ARPU) with formulas',
      'Conditional formatting applied to the retention triangle',
      'Handles censored rows (no churn_date = still active) correctly'
    ]
  },

  ds_sales_forecast_seasonal: {
    domain: 'data_science',
    objective:
      'Dalla serie storica di vendite mensili presente (36 mesi), costruisci un forecast a 18 mesi: decomposizione trend/stagionalità (indici stagionali mensili), media mobile, modello di forecast (trend + indice stagionale), bande di scenario (P10/P50/P90), e un backtest dell\'accuratezza (MAPE/MAE) su un holdout degli ultimi 6 mesi. Mostra grafici e una tabella driver (crescita, stagionalità) modificabile.',
    context: {
      activeSheet: 'sales_ts',
      workbookSheets: ['sales_ts'],
      sheets: [{ name: 'sales_ts', usedRange: { rowCount: 37, columnCount: 4 } }],
      allSheetsData: {
        sales_ts: {
          isActive: true, usedRange: 'sales_ts!A1:D37', rowCount: 37, columnCount: 4,
          preview: [
            ['month', 'units', 'revenue', 'promo_flag'],
            ['2023-01', 1200, 84000, 0],
            ['2023-02', 1100, 77000, 0],
            ['2023-03', 1450, 101500, 1],
            ['2023-12', 2100, 147000, 1]
          ]
        }
      }
    },
    loopPromptVariant: 'default',
    rubric: [
      'Seasonal indices (12) derived from history and normalized (~average 1.0)',
      'Trend estimated (moving average or regression) and combined with seasonality for the forecast',
      '18-month forward forecast via formulas referencing trend + seasonal index',
      'P10/P50/P90 scenario bands present and driven by an assumption (volatility/error)',
      'Backtest on a 6-month holdout with MAPE/MAE computed by formula',
      'Driver table (growth, seasonality) is editable and flows into the forecast',
      'At least one chart of actual vs forecast'
    ]
  },

  ds_clean_pivot_dashboard: {
    domain: 'data_science',
    objective:
      'Hai dati grezzi sporchi su due fogli (transazioni e anagrafica prodotti) con duplicati, date in formati misti, numeri come testo, categorie incoerenti. Pulisci e normalizza in un foglio Clean (dedup, parsing date, cast numerici, mapping categorie canoniche, join col prodotto), poi crea pivot di sintesi (ricavi per categoria x mese, margine per prodotto, top-10 prodotti) e un dashboard KPI con formattazione condizionale. Documenta le regole di pulizia applicate.',
    context: {
      activeSheet: 'tx_raw',
      workbookSheets: ['tx_raw', 'products_raw'],
      sheets: [
        { name: 'tx_raw', usedRange: { rowCount: 8000, columnCount: 8 } },
        { name: 'products_raw', usedRange: { rowCount: 320, columnCount: 5 } }
      ],
      allSheetsData: {
        tx_raw: {
          isActive: true, usedRange: 'tx_raw!A1:H8000', rowCount: 8000, columnCount: 8,
          preview: [
            ['order_id', 'date', 'sku', 'qty', 'price', 'category', 'country', 'channel'],
            ['1001', '03/05/2024', 'A-100', '2', '19.90', 'Electronics', 'IT', 'web'],
            ['1001', '2024-05-03', 'A-100', '2', '19,90', 'electronics', 'IT', 'WEB'],
            ['1002', 'May 4 2024', 'B-200', '1', '49.00', 'Home', 'DE', 'store']
          ]
        },
        products_raw: {
          usedRange: 'products_raw!A1:E320', rowCount: 320, columnCount: 5,
          preview: [['sku', 'name', 'cost', 'brand', 'cat_canonical'], ['A-100', 'USB Cable', 8.5, 'Acme', 'Electronics'], ['B-200', 'Lamp', 22.0, 'Lumio', 'Home']]
        }
      }
    },
    loopPromptVariant: 'default',
    rubric: [
      'Clean sheet: duplicates removed (e.g., order 1001 collapsed), dates normalized to one format, numeric casts (19,90 -> 19.90)',
      'Category normalization to canonical values (electronics/Electronics unified) via mapping',
      'Join transactions to product cost/brand to compute margin',
      'Pivot summaries: revenue by category x month, margin by product, top-10 products',
      'KPI dashboard with conditional formatting',
      'Cleaning rules documented in notes or a rules sheet',
      'Original raw sheets left intact (non-destructive)'
    ]
  },

  /* ============================ REAL ESTATE ============================ */

  re_multifamily_valueadd: {
    domain: 'real_estate',
    objective:
      'Costruisci un modello di acquisizione value-add per un multifamily da 220 unità a partire dal rent roll e dal T-12 presenti. Includi: unit mix e rent roll riepilogo, pro forma NOI (in-place vs stabilizzato dopo rinnovi), piano capex per unità, debt sizing su LTV e DSCR (con sweep su tassi), cash flow leveraged a 10 anni con uscita su exit cap, rendimenti (IRR levered/unlevered, equity multiple), e una sensitivity (exit cap x rent growth). Note sulle assumptions chiave.',
    context: {
      activeSheet: 'RentRoll',
      workbookSheets: ['RentRoll', 'T12', 'Assumptions', 'Model'],
      sheets: [
        { name: 'RentRoll', usedRange: { rowCount: 221, columnCount: 6 } },
        { name: 'T12', usedRange: { rowCount: 40, columnCount: 14 } },
        { name: 'Assumptions', usedRange: { rowCount: 24, columnCount: 4 } },
        { name: 'Model', usedRange: { rowCount: 3, columnCount: 12 } }
      ],
      allSheetsData: {
        RentRoll: {
          isActive: true, usedRange: 'RentRoll!A1:F221', rowCount: 221, columnCount: 6,
          preview: [['unit', 'type', 'sqft', 'in_place_rent', 'market_rent', 'status'], ['101', '1BR', 650, 1350, 1550, 'occupied'], ['102', '2BR', 950, 1800, 2050, 'occupied'], ['103', '1BR', 650, 0, 1550, 'vacant']]
        },
        T12: {
          usedRange: 'T12!A1:N40', rowCount: 40, columnCount: 14,
          preview: [['Line', 'Annual'], ['Gross Potential Rent', 4250000], ['Vacancy', -310000], ['Other Income', 180000], ['OpEx Total', -1850000], ['NOI', 2270000]]
        },
        Assumptions: {
          usedRange: 'Assumptions!A1:D24', rowCount: 24, columnCount: 4,
          preview: [['Driver', 'Value'], ['Purchase Price', 38000000], ['Exit Cap', '5.5%'], ['Rent Growth', '3.0%'], ['LTV', '65%'], ['Min DSCR', '1.25x'], ['Reno cost/unit', 8500], ['Hold (yrs)', 10]]
        },
        Model: { isActive: false, usedRange: 'Model!A1:L3', rowCount: 3, columnCount: 12, preview: [['Year', '0', '1', '2', '3']] }
      }
    },
    loopPromptVariant: 'default',
    rubric: [
      'Unit-mix + rent roll summary (count by type, in-place vs market rent, loss-to-lease)',
      'Stabilized NOI builds from renovated rents, vacancy, other income, OpEx — vs in-place NOI',
      'Capex/renovation program scheduled and funded',
      'Debt sized by the BINDING constraint of LTV and DSCR (not just LTV); rate sweep present',
      '10-year leveraged cash flow with exit value = stabilized NOI / exit cap, minus debt payoff',
      'IRR (levered + unlevered) and equity multiple from the cash-flow series via formulas',
      'Sensitivity table exit cap x rent growth; assumptions centralized with notes'
    ]
  },

  re_development_proforma: {
    domain: 'real_estate',
    objective:
      'Crea da zero una pro forma di sviluppo ground-up per un progetto residenziale da 180 unità: budget di costruzione (hard/soft cost, contingency, land), draw schedule a S-curve con interessi capitalizzati sul construction loan, assorbimento/lease-up mensile fino alla stabilizzazione, valore stabilizzato (NOI / cap), profitto di sviluppo e yield-on-cost vs market cap (developer spread), e una waterfall di distribuzione GP/LP con preferred return e promote a più hurdle. Scenari su costi di costruzione e velocità di assorbimento.',
    context: emptyWorkbook('Dev'),
    loopPromptVariant: 'default',
    rubric: [
      'Construction budget: land + hard + soft + contingency, total dev cost (TDC)',
      'S-curve draw schedule with capitalized interest on the outstanding loan balance',
      'Lease-up/absorption schedule ramps occupancy to stabilization over months',
      'Stabilized value = stabilized NOI / cap; development profit = value - TDC',
      'Yield-on-cost vs market cap rate => developer spread shown',
      'GP/LP equity waterfall with preferred return + promote across multiple hurdles (IRR or multiple based)',
      'Scenario levers on construction cost and absorption speed flow through to returns'
    ]
  },

  re_reit_nav: {
    domain: 'real_estate',
    objective:
      'Costruisci un modello NAV per un REIT a partire dal portafoglio immobili presente (NOI per asset, mercato/cap): valuta ogni asset per cap rate, somma il gross asset value, sottrai il debito (a valore di mercato dato lo spread tassi) e altre passività, aggiungi cassa/altri asset, deriva il NAV totale e per azione, confronta col prezzo per azione (premio/sconto a NAV), e calcola FFO e AFFO con i relativi multipli. Includi una sensitivity del NAV/share alla variazione dei cap rate (+/- 50/100 bps).',
    context: {
      activeSheet: 'Portfolio',
      workbookSheets: ['Portfolio', 'CapStack', 'NAV'],
      sheets: [
        { name: 'Portfolio', usedRange: { rowCount: 60, columnCount: 7 } },
        { name: 'CapStack', usedRange: { rowCount: 14, columnCount: 5 } },
        { name: 'NAV', usedRange: { rowCount: 3, columnCount: 6 } }
      ],
      allSheetsData: {
        Portfolio: {
          isActive: true, usedRange: 'Portfolio!A1:G60', rowCount: 60, columnCount: 7,
          preview: [['asset', 'market', 'type', 'noi', 'market_cap_rate', 'occupancy', 'sqft'], ['Tower A', 'NYC', 'Office', 42000000, '6.0%', '92%', 850000], ['Mall B', 'LA', 'Retail', 28000000, '7.0%', '88%', 1200000], ['Logi C', 'DAL', 'Industrial', 19000000, '5.25%', '97%', 1500000]]
        },
        CapStack: {
          usedRange: 'CapStack!A1:E14', rowCount: 14, columnCount: 5,
          preview: [['Item', 'Book', 'Rate', 'Maturity'], ['Mortgage Pool', 1850000000, '4.2%', '2028'], ['Unsecured Notes', 900000000, '3.8%', '2031'], ['Cash', 220000000, '', ''], ['Shares Out (M)', 415, '', ''], ['Price/share', 78.5, '', '']]
        },
        NAV: { isActive: false, usedRange: 'NAV!A1:F3', rowCount: 3, columnCount: 6, preview: [['NAV Build', 'Value']] }
      }
    },
    loopPromptVariant: 'default',
    rubric: [
      'Each asset valued = NOI / market cap rate; gross asset value summed across portfolio',
      'Debt marked to market given rate spread vs coupon (not just book), other liabilities subtracted',
      'NAV = GAV - net debt - other liabilities + cash/other assets; NAV per share = NAV / shares',
      'Premium/discount to NAV = price/share vs NAV/share',
      'FFO and AFFO computed (net income + D&A - gains; AFFO less recurring capex) with multiples',
      'Sensitivity of NAV/share to cap-rate shifts (+/- 50/100 bps) as a real table',
      'Outputs reference Portfolio + CapStack via formulas; key assumptions noted'
    ]
  },

  re_vairano_10piani: {
    domain: 'real_estate',
    objective:
      "fai un excel super completo per fare la valutazione della realizzazione di un progetto immobiliare da 0, l'immobile sarà un 10 piani a Vairano Scalo in provincia di Caserta di circa 1000 mq per piano. Fai un'analisi super complessa di costi e ricavi, finanziamenti, dividi i costi in vari sottocosto. L'excel deve essere completo con ogni foglio circa 1000 righe.",
    context: emptyWorkbook('Sheet1'),
    loopPromptVariant: 'default',
    rubric: [
      'Assumptions sheet con tutti i driver: superficie totale, prezzi/mq per piano, costi/mq, % oneri, ltc/ltv, tassi mutuo, IRES/IRAP, IVA — TUTTI con label IT esatti e valori numerici (non placeholder)',
      'Assumptions DEVE includere righe esplicite per Equity Investito, Debito Totale, WACC/Costo Capitale — non possono mancare se poi c\'è una valutazione',
      'Cost Breakdown con sottocosti italiani granulari: acquisizione area (terreno, registro 9%, notarile, mediazione, bonifica), tecnici (progettazione architettonica/strutturale/impiantistica %, DL, CSP/CSE, collaudi, APE, pratiche), oneri concessori (urbanizzazione primaria/secondaria, contributo costruzione), costruzione (strutture, tamponamenti, impianti elettrico/idrico/termico/condizionamento/VMC/fotovoltaico, finiture, infissi, ascensori), sicurezza cantiere, finanziari, imposte, commerciali, contingency',
      'Per-Floor Detail con 10 piani × N unità (residenziale/commerciale), superfici lorda/commerciale/vendibile per piano, prezzi differenziati per piano alto/basso — righe DI DATI VERI, no padding repetitivo',
      'Revenue Schedule mensile con assorbimento progressivo (ramp 24-48 mesi) e ricavi incassati per mese per piano — formule, non valori hardcoded',
      'Construction Schedule con S-curve mensile su SAL per fasi: acquisizione → progettazione → fondazioni → strutture → impianti → finiture → consegna. % completamento progressivo, costi mese × fase',
      'Financing Schedule con tiraggio SAL (tipicamente 30/40/30 o S-curve), interessi capitalizzati durante costruzione, periodo pre-ammortamento, rimborso post-vendite',
      'Cash Flow mensile completo per orizzonte ≥36 mesi: 1 riga per mese (non sentinel-rows-only), con Ricavi Incassati, Costi, Imposte, Flusso Operativo, Tiraggio/Rimborso Mutuo, Interessi, Flusso Netto, Cassa Cumulata',
      'P&L annuale per orizzonte completo (4-6 anni), con Ricavi, COGS, Soft Cost, EBITDA, Interessi, IRES+IRAP, Utile Netto, Cumulato — formule che roll-up da Cash Flow + Cost Breakdown',
      'Valuation con IRR Equity, IRR Progetto, NPV (WACC), ROE, ROI, MOIC, Payback — formule reali contro Cash Flow / Assumptions, non valori hardcoded. DSCR per periodo con min/medio. Se Equity/Debito/WACC mancanti su Assumptions, IFERROR + "INPUT MANCANTE" — mai numeri fabbricati.',
      'Sensitivity con almeno 2-3 tabelle 7×7 reali (formule basate su data tables o offset): Prezzo vendita vs Costo costruzione, Tasso assorbimento vs Tasso interesse, Ritardo SAL vs Prezzo — non solo header'
    ]
  }
};

const DOMAINS = ['finance', 'data_science', 'real_estate'];

function scenarioKeysByDomain(domain) {
  return Object.keys(SCENARIOS).filter(k => SCENARIOS[k].domain === domain);
}

module.exports = { SCENARIOS, DOMAINS, scenarioKeysByDomain };
