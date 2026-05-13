# WACC Model

## Overview
The Weighted Average Cost of Capital (WACC) represents a company's blended cost of capital across all sources, including equity and debt. It is the discount rate used in DCF valuation.

## Formula
```
WACC = (E / (D + E)) × Re + (D / (D + E)) × Rd × (1 - T)
```
Where:
- E = Market value of equity
- D = Market value of debt
- Re = Cost of equity
- Rd = Cost of debt
- T = Marginal tax rate

## Cost of Equity (CAPM)

```
Re = Rf + β × (Rm - Rf)
```

Where:
- Rf = Risk-free rate (10-year Treasury yield)
- β = Equity beta (levered)
- (Rm - Rf) = Market Risk Premium (ERP)

### Beta Considerations
- **Levered beta** (βL) reflects both business risk and financial leverage
- **Unlevered beta** (βU) = βL / (1 + (1-T) × D/E)
- When using comparable company betas, always unlever first, then relever to target D/E
- For public companies, do not rely on a single beta datapoint. Compare observed regression beta with peer/sector beta and document the selected beta.
- If peer data is unavailable, keep the peer/sector beta row visible and flag it for analyst review rather than hiding the assumption.

### Typical Values (US Market)
- Risk-Free Rate: 4.0% - 5.0% (varies with Treasury yields)
- Equity Risk Premium: 5.0% - 6.5%
- Market-implied ERP can be derived from S&P 500 forward earnings yield minus Rf

## Cost of Debt

### Methods
1. **Yield to Maturity** on outstanding bonds (most accurate)
2. **Interest expense / Total debt** from financial statements (approximate)
3. **Credit spread + Rf** based on credit rating

### After-Tax Cost
```
After-Tax Rd = Pre-Tax Rd × (1 - T)
```
Interest is tax-deductible, so the after-tax cost is lower.

## Capital Structure

### Market Value Weights
Always use **market values**, not book values:
- E = Share price × Shares outstanding
- D = Market value of debt (book value is acceptable approximation if market value unavailable)

### Target vs Current
- Use **target capital structure** for valuation if the company is expected to move toward it
- Use **current capital structure** for stable, mature companies
- For LBOs, use the post-transaction capital structure

## WACC by Sector (Typical Ranges)
| Sector | WACC Range | Notes |
|--------|-----------|-------|
| Technology | 8% - 12% | High beta, low debt |
| Utilities | 5% - 7% | Low beta, high debt |
| Financials | 9% - 13% | Regulatory capital requirements |
| Healthcare | 7% - 10% | Defensive, moderate leverage |
| Energy | 7% - 11% | Cyclical, asset-intensive |
| Consumer Staples | 6% - 9% | Defensive, stable cash flows |

## Excel Implementation

### Sheet Layout
Row 1: "WACC Calculation" (title, merged, dark blue header)
Row 2: Section headers (grey background, white bold)

**Cost of Equity Section:**
- Risk-Free Rate (%) = Assumptions!B8
- Selected Beta = selected beta from the beta evidence section
- Market Risk Premium (%) = Assumptions!B10
- **Cost of Equity (%)** = B2 + B3 × B4

**Beta Evidence Section:**
- Observed Levered Beta = company regression / market-data beta
- Peer / Sector Levered Beta = median comparable beta where available
- Unlevered Peer Beta = Peer Beta / (1 + (1-Tax Rate) × D/E)
- Relevered Peer Beta = Unlevered Beta × (1 + (1-Tax Rate) × Target D/E)
- Selected Beta = average or analyst-selected blend of observed and relevered peer beta

**Cost of Debt Section:**
- Pre-Tax Cost of Debt (%) = Assumptions!B11
- Tax Rate (%) = Assumptions!B5
- **After-Tax Cost of Debt (%)** = B8 × (1 - B9)

**Capital Structure:**
- Market Value of Equity ($M) = Assumptions!B12
- Market Value of Debt ($M) = Assumptions!B13
- Total Capital ($M) = SUM(B12:B13)
- Equity Weight (%) = B12 / B14
- Debt Weight (%) = B13 / B14

**WACC:**
- **WACC (%)** = B7 × B15 + B10 × B16

## See Also
- [[DCF Model]] — where WACC is used as discount rate
- [[Beta]] — levered and unlevered beta mechanics
- [[Cost of Debt]] — detailed methods and sources
