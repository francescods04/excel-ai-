---
name: wacc-model
description: Weighted Average Cost of Capital — CAPM, cost of debt, capital structure, target D/E
size: 4.1KB
---

# WACC Model Skill

## Components
1. Risk-free rate: use 10-year Treasury (openbb.fixedincome.treasury)
2. Equity risk premium: use openbb.economy.risk_premium
3. Beta: from Yahoo Finance or comparable companies
4. Cost of debt: yield to maturity on outstanding debt, tax-adjusted
5. Capital structure: target D/E or market value weights

## Formulas
- Cost of Equity = Rf + β × ERP
- Cost of Debt (after-tax) = Pre-tax cost × (1 - Tax Rate)
- WACC = (E/V) × Ke + (D/V) × Kd × (1 - Tax Rate)

## Excel Layout
- Section 1: Market data (Beta, Rf, ERP)
- Section 2: Cost of equity calculation
- Section 3: Cost of debt calculation
- Section 4: WACC output with sensitivity
