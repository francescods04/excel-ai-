---
name: business-plan
description: Investor-ready business plan and unit economics workbook for owned-location restaurant, retail, and site-launch cases
size: 5.2KB
---

# Business Plan Skill

Use this skill for investor-facing business plans, especially restaurant, fast food, retail, venue, single-location launch, and owned-location rollout cases.

## Workbook Structure
1. Executive Summary: concept, location, positioning, launch ask, base-case outputs.
2. Assumptions: operating days, traffic, conversion, average order value, menu mix, ramp, inflation, taxes, COGS, labor, utilities, marketing, maintenance, insurance, capex, working capital.
3. Menu Economics: menu table with price, menu/non-menu option, estimated COGS %, expected mix %, gross profit per item, weighted AOV and blended COGS.
4. Revenue Model: daily customers, transactions, AOV, monthly seasonality, monthly and annual revenue.
5. Staffing and Opex: FTE plan, wages, payroll taxes, rent/owned-property treatment, utilities, marketing, admin, software, waste.
6. P&L: revenue, COGS, gross profit, labor, occupancy, other opex, EBITDA, D&A, EBIT, tax, net income.
7. Cash Flow: EBITDA, taxes, working capital, capex, free cash flow, cumulative cash flow.
8. Funding / Use of Funds: initial capex, pre-opening costs, launch marketing, opening working capital, contingency, total funding required.
9. Investor Returns: payback, cash-on-cash, scenario IRR if there is an explicit investment/cash-flow timeline.
10. Sensitivity: customers vs AOV, COGS vs labor, downside/base/upside.
11. Dashboard: KPIs and scenario summary.

## Modeling Rules
- Do not turn a restaurant or site-launch business plan into an LBO unless the user explicitly asks for LBO, leverage buyout, entry multiple, exit multiple, sponsor returns, debt schedule, or MOIC.
- If the user says the locations are owned and not franchised, model this as a company-owned unit. Keep franchise fees, royalty income, and franchisee economics out of the base case.
- Keep assumptions in one clearly labeled sheet. Formulas in all model sheets must reference assumption cells or named ranges, not random hardcoded cells.
- Build a menu mix table first, then compute AOV and blended COGS from the mix. Do not reference header cells such as "COGS %" in formulas.
- For an owned property/location, do not invent rent unless the user asks for market rent. Use property opex/maintenance or an optional imputed rent sensitivity, labeled clearly.
- Separate launch capex from recurring opex. Pre-opening payroll and launch marketing belong in Use of Funds / Cash Flow, not recurring monthly P&L unless explicitly recurring.
- If exact market data is missing, use conservative labeled assumptions and annotate the input cells with notes.

## Speed Pattern
- Create all needed sheets first with bulk_create_sheets.
- Populate Assumptions, Menu Economics, Revenue Model, P&L, Cash Flow, and Dashboard with 3-6 bulk_set_cell_ranges calls total.
- Use style_preset on every written cell so formatting lands with the write.
- Verify only the most important blocks: Assumptions table, P&L totals, Dashboard KPIs, and error checks.

## Formatting Defaults
- Titles: style_preset "title".
- Section bands: style_preset "section".
- Input assumptions: "input", "input_pct", "input_int", "input_eur".
- Formulas: "formula", "formula_pct", "formula_eur".
- Outputs/KPIs: "output", "output_pct", "output_eur", "output_multiple".
- Checks: "check_ok" or "check_warn".

## Core Checks
- Menu mix sums to 100%.
- Revenue equals transactions x AOV.
- Blended COGS comes from menu economics.
- Annual P&L ties to monthly revenue.
- Cash flow includes initial investment and capex timing.
- Scenario tables reference the same driver cells as the base model.
