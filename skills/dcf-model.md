---
name: dcf-model
description: Discounted Cash Flow valuation model — build 5-year projections, WACC, terminal value, sensitivity tables
size: 8.2KB
---

# DCF Model Skill

## Structure
1. Assumptions sheet: revenue drivers, margins, tax, capex, terminal growth
2. WACC sheet: CAPM cost of equity, after-tax cost of debt, WACC formula
3. DCF sheet: 5-year FCF projection, discount factors, PV of FCF, terminal value
4. Sensitivity sheet: 2-way data table (WACC × Terminal Growth)

## Key Formulas
- Revenue(t) = Revenue(t-1) × (1 + growth)
- EBITDA = Revenue × margin
- Unlevered FCF = NOPAT + D&A - CapEx - ΔNWC
- Terminal Value = FCF_n × (1+g) / (WACC - g)
- Enterprise Value = Σ PV(FCF) + PV(TV)

## Excel Patterns
- Use cross-sheet references: =Assumptions!B3
- Blue font for input cells, black for calculations, grey for headers
- Number format: millions with 1 decimal, percentages as 0.0%
