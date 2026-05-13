# DCF Model

## Overview
The Discounted Cash Flow (DCF) model values a company by projecting its future cash flows and discounting them to present value. It is the cornerstone of intrinsic valuation in investment banking.

## Structure

## Analyst Depth Standard

The model must not only create a DCF layout. Each section must show the reasoning path an analyst would use:
- **Sources** — map every major input to workbook data, filings, market data, or an explicit analyst fallback.
- **Assumptions** — derive operating drivers from local evidence when possible and expose fallback assumptions for review.
- **WACC** — triangulate discount rate from risk-free rate, ERP, cost of debt, capital structure, and beta evidence.
- **DCF** — build operating forecasts step-by-step before terminal value and equity bridge.
- **Sensitivity / Scenarios** — show range of outcomes and driver interaction, not just a single implied price.
- **Summary** — link every committee-facing number back to the model.
- **Audit** — check source coverage, formula integrity, valuation mechanics, range analysis, and remaining analyst work.

### 1. Assumptions Sheet
Contains all inputs that drive the model. Organized in sections:

**Revenue & Margin Drivers**
- Revenue ($M) — base year actual or estimate
- Revenue Growth (%) — year-over-year growth rate
- EBITDA Margin (%) — EBITDA / Revenue

**Tax & Capital**
- Tax Rate (%) — marginal effective tax rate
- D&A % of Revenue (%) — depreciation & amortization
- CapEx % of Revenue (%) — capital expenditures
- NWC % of Revenue (%) — net working capital requirement

**Terminal**
- Terminal Growth Rate (%) — long-term GDP-like growth

**Market Data (for WACC)**
- Beta — equity beta from regression or comparables
- Risk-Free Rate (%) — 10-year Treasury yield
- Market Risk Premium (%) — country-specific ERP
- Cost of Debt (%) — yield to maturity on debt
- Target D/E — optimal capital structure

### 2. WACC Sheet
Calculates the discount rate:

```
Cost of Equity (CAPM) = RiskFreeRate + Beta × MarketRiskPremium
After-Tax Cost of Debt = PreTaxCostOfDebt × (1 - TaxRate)
WACC = (E/(D+E)) × CostOfEquity + (D/(D+E)) × CostOfDebt × (1-TaxRate)
```

### 3. DCF Sheet — Projection (5-year minimum)

Column A: Labels (English, professional IB terminology)
Row 2: Year headers ("", "2025E", "2026E", "2027E", "2028E", "2029E", "Terminal")

**Core rows:**
- Revenue ($M) = prior × (1 + growth)
- EBITDA ($M) = Revenue × margin
- D&A ($M) = Revenue × D&A%
- EBIT ($M) = EBITDA - D&A
- Tax ($M) = EBIT × tax rate
- NOPAT ($M) = EBIT - Tax
- (+) D&A ($M) — add back non-cash
- (-) CapEx ($M) — capital investment
- (-) Change in NWC ($M) — working capital investment
- **Unlevered FCF ($M)** = NOPAT + D&A - CapEx - ChangeInNWC

**Discounting:**
- Discount Factor = 1 / (1 + WACC)^year
- PV of FCF ($M) = FCF × Discount Factor

**Terminal Value:**
- Terminal Value (Gordon Growth) = FCF_n × (1 + g) / (WACC - g)
- PV of Terminal Value = TV / (1 + WACC)^n

**Valuation:**
- Enterprise Value ($M) = SUM(PV of FCFs) + PV of TV
- (+) Cash & Equivalents ($M)
- (-) Total Debt ($M)
- **Equity Value ($M)** = EV + Cash - Debt
- Shares Outstanding (M)
- **Implied Share Price ($)** = Equity Value / Shares

### 4. Sensitivity Sheet
Two-way data table: WACC × Terminal Growth
Shows Enterprise Value and Implied Share Price across scenarios.

## Critical Rules
1. **Never hardcode constants in formulas** — always reference Assumptions sheet
2. **Use absolute references ($B$4)** for assumptions that don't change across columns
3. **Use relative references (B5)** for prior-year values that flow across columns
4. **Every data row MUST have a descriptive label in Column A**
5. **Build formulas in this exact order**: Revenue → EBITDA → D&A → EBIT → Tax → NOPAT → (+D&A) → (-CapEx) → (-ΔNWC) → Unlevered FCF
6. **Include a Check row** at the bottom verifying DCF = Equity Value + Net Debt

## Common Pitfalls
- Using levered FCF instead of unlevered FCF
- Forgetting to add back D&A in the FCF build
- Hardcoding WACC instead of referencing the WACC sheet
- Using arithmetic instead of geometric growth for terminal value
- Not sanity-checking implied share price vs market price

## See Also
- [[WACC Model]] — detailed WACC calculation
- [[Terminal Value]] — Gordon Growth vs Exit Multiple methods
- [[Free Cash Flow]] — detailed FCF build
- [[Sensitivity Analysis]] — data table mechanics
- [[DCF Formulas]] — all Excel formulas by section
