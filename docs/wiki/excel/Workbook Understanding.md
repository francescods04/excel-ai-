# Workbook Understanding

Excel AI must be domain-agnostic. Finance models are one skill, not the product core.

Before the agent writes formulas, formats ranges, creates sheets, or changes workbook structure, it should understand the workbook semantically:
- workbook purpose and likely domain
- sheet roles such as source data, calculation model, dashboard, assumptions, lookup/reference
- tables, ranges, headers, grain, measures, dimensions and time fields
- key cells and formula zones
- cross-sheet dependencies and risks
- recommended next actions and genuinely blocking questions

The AI model owns semantic interpretation. The backend owns grounding and validation.

## Grounding Rules

The model may infer what a table means, but every cited table, range or key cell must exist in the workbook snapshot. Invalid sheet names, cells and ranges are dropped before downstream agents see them.

The output of workbook understanding is read-only. It never mutates Excel. Mutation tools use it as context so they can act on the right ranges with fewer brittle assumptions.

## Relationship To Domain Skills

Domain builders such as DCF, WACC, inventory analysis, HR dashboards or sales summaries should consume workbook understanding instead of reinventing workbook parsing.

Domain-specific deterministic parsers are allowed only as validators or fallbacks. They must not become the primary way the product understands user workbooks.
