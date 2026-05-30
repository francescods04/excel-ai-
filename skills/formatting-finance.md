---
name: formatting-finance
description: Investor-grade Excel formatting patterns for fast, readable, presentation-ready financial workbooks. Goldman/JPMorgan institutional standards.
size: 12KB
---

# Formatting Finance Skill

Use this skill when the user asks for better formatting, precision, polish, investor-grade output, or presentation-ready workbook styling. Also apply when building or modifying any financial model (DCF, LBO, M&A, Three-Statement, Comps, WACC).

## CRITICAL: Format While Writing

**Anti-pattern:** Write all data, then format afterwards in a separate pass. This doubles the work and produces ugly intermediate state.

**Rule:** Every cell written by set_cell_range or bulk_set_cell_ranges MUST include cellStyles with at minimum: fontColor and numberFormat. Use style presets (below) for consistent application.

**When writing data, follow this exact sequence per row:**
1. Determine row type (header / section / input / formula / output / total / check)
2. Write value/formula with the matching `cellStyles` object
3. Use `copyToRange` to propagate the pattern across year columns

**Only use bulk_set_format for:** column widths, row heights, freeze panes, full-row borders, print-ready alignment. Never for cell-level color or number format — those go inline with the data write.

## INSTITUTIONAL COLOR CODING STANDARD (Goldman Sachs / JPMorgan)

This is MANDATORY for all financial models. Every cell with a value or formula must have exactly one of these font colors:

| Cell Type | Font Color | Background | Meaning |
|-----------|-----------|------------|---------|
| **Hardcoded Inputs** | `#0000FF` (Blue) | `#E6F2FF` (Light blue) | Numbers users will change for scenarios |
| **Formulas & Calculations** | `#000000` (Black) | `#FFFFFF` (White) | ALL formulas, computed values |
| **Cross-Sheet Links** | `#008000` (Green) | `#FFFFFF` (White) | Links pulling from other worksheets in same workbook |
| **External Links** | `#FF0000` (Red) | `#FFFFFF` (White) | Links to other files or external data sources |
| **Key Assumptions** | `#0000FF` (Blue) | `#FFFF00` (Yellow bg) | Critical assumptions needing attention |
| **Totals/Subtotals** | `#000000` (Black) | `#F2F2F2` (Light grey) | Bold font, top border |
| **Check Row OK** | `#006100` (Dark green) | `#C6EFCE` (Light green) | Model check passed |
| **Check Row WARN** | `#9C6500` (Dark amber) | `#FFEB9C` (Light amber) | Model check warning |
| **Check Row ERROR** | `#9C0006` (Dark red) | `#FFC7CE` (Light red) | Model check failed |

**DO NOT:**
- Use black font for hardcoded inputs
- Use blue font for formulas
- Leave cells with no color distinction between input and formula
- Use grey font for anything except muted commentary text

## NUMBER FORMATTING STANDARDS

### Currency
- **Syntax:** `$#,##0.0` (one decimal), `$#,##0` (no decimals)
- **Millions:** `$#,##0.0` — ALWAYS specify units in header: "Revenue ($M)"
- **Billions:** `$#,##0.00` — header: "Market Cap ($B)"
- **Per-share:** `$#,##0.00` — header: "Implied Share Price ($)"
- **Zeros as dash:** `$#,##0.0;($#,##0.0);"-"` or `$#,##0.0;[Red]($#,##0.0);"-"`

### Percentages
- **Syntax:** `0.0%` (one decimal) or `0.00%` (two decimals for precision)
- **Zeros as dash:** `0.0%;-0.0%;"-"`
- **Always store as decimals** in cells (0.25 = 25%), format handles display

### Multiples
- **Syntax:** `0.0x` or `0.00x`
- **Examples:** EV/EBITDA, P/E, EV/Revenue

### Integers
- **Syntax:** `#,##0` or `#,##0.0`
- **Examples:** Shares outstanding, headcount, years

### Years/Dates
- **Format years as text strings:** `"2024"` not `2,024`
- **Dates:** `mmm-yyyy` for monthly models, `yyyy` for annual
- **Months:** `mmm` or `mmmm`

### Negative Numbers
- **Use parentheses** `(123)` not minus `-123`
- **Custom format:** `$#,##0.0;($#,##0.0);"-"`

## STYLE PRESETS (for cellStyles in set_cell_range / bulk_set_cell_ranges)

### Structural Presets
| Preset | Use Case | Key Properties |
|--------|----------|---------------|
| `title` | Workbook/sheet title row (Row 1) | bg #1F4E78, font white, bold, 14pt, merge across columns |
| `section` | Major section separator | bg #D9E1F2, font black, bold, 10pt, top border |
| `table_header` | Table column headers (Row 2) | bg #404040, font white, bold, 10pt, center align |
| `label` | Row labels (Column A) | font black, left align, indent 1 |

### Data Presets
| Preset | Use Case | Font Color | Background | Number Format |
|--------|----------|------------|------------|---------------|
| `input` | Generic hardcoded input | #0000FF | #E6F2FF | General |
| `input_pct` | Percentage input | #0000FF | #E6F2FF | 0.0% |
| `input_int` | Integer input | #0000FF | #E6F2FF | #,##0 |
| `input_eur` | Currency input (EUR) | #0000FF | #E6F2FF | #,##0.0 EUR |
| `input_usd` | Currency input (USD) | #0000FF | #E6F2FF | $#,##0.0 |
| `formula` | Calculated cell | #000000 | #FFFFFF | General |
| `formula_pct` | Calculated percentage | #000000 | #FFFFFF | 0.0% |
| `formula_int` | Calculated integer | #000000 | #FFFFFF | #,##0 |
| `formula_eur` | Calculated EUR | #000000 | #FFFFFF | #,##0.0 EUR |
| `formula_usd` | Calculated USD | #000000 | #FFFFFF | $#,##0.0 |
| `internal_link` | Cross-sheet reference | #008000 | #FFFFFF | (inherit) |
| `external_link` | External file reference | #FF0000 | #FFFFFF | (inherit) |

### Summary Presets
| Preset | Use Case | Key Properties |
|--------|----------|---------------|
| `output` | Generic KPI / output | font black, bold, bg #F2F2F2 |
| `output_pct` | Percentage KPI | font black, bold, 0.0%, bg #F2F2F2 |
| `output_eur` | Currency KPI (EUR) | font black, bold, #,##0.0 EUR, bg #F2F2F2 |
| `output_usd` | Currency KPI (USD) | font black, bold, $#,##0.0, bg #F2F2F2 |
| `output_multiple` | Multiple KPI | font black, bold, 0.0x, bg #F2F2F2 |
| `output_per_share` | Per-share KPI | font black, bold, $#,##0.00, bg #F2F2F2 |
| `total` | Total row | font black, bold, bg #F2F2F2, top border thin black |
| `subtotal` | Subtotale row | font black, bold, bg #F9F9F9, top border thin |

### Check Presets
| Preset | Use Case | Key Properties |
|--------|----------|---------------|
| `check_ok` | Check passed | font #006100, bg #C6EFCE, italic |
| `check_warn` | Check warning | font #9C6500, bg #FFEB9C, italic |
| `check_error` | Check failed | font #9C0006, bg #FFC7CE, italic |

### Scenario Presets
| Preset | Use Case | Key Properties |
|--------|----------|---------------|
| `scenario_base` | Base case | font black, bg #FFFFFF |
| `scenario_upside` | Upside case | font #006100, bg #C6EFCE |
| `scenario_downside` | Downside case | font #9C0006, bg #FFC7CE |

## LAYOUT PATTERNS

### Standard Financial Model Layout
```
Row 1:  TITLE ROW — merge A1:H1, bg #1F4E78, white bold 14pt
Row 2:  HEADER ROW — year labels B2:H2, bg #404040, white bold 10pt, center
Row 3+:  Data rows — see type-specific formatting below
```

### Column Widths (Financial Model)
- **Column A (labels):** 210-255px, left-aligned, indent 1
- **Data columns (B onwards):** 92-120px, uniform width, right-aligned
- **Use uniform column widths** for all data columns — don't vary per column

### Freeze Panes
- Freeze at `B3` (below header row, after label column) for wide models
- Freeze at `A3` (below header row) for narrow models

### Section Structure
Every sheet should follow this visual hierarchy:
1. Title row (dark blue, white text, bold, merged)
2. Header row (dark grey, white text, bold)
3. Section headers (light blue-grey bg, black text, bold, top border)
4. Input rows (light blue bg, blue text)
5. Formula rows (white bg, black text)
6. Total/subtotal rows (light grey bg, bold, top border)
7. Check rows (colored bg based on status, italic)

### Dashboard Layout
- Keep compact: KPI row at top, scenario selector/table, summary chart-ready table, key checks
- All KPIs on one row with clear labels
- Below: the main data table formatted for investor presentation

## HARDCODED VALUES POLICY

**Anti-pattern:** Embedding business assumptions (tax rates, growth rates, margins) directly in formulas.

**Rule:** Every business assumption must live in a labeled cell and be referenced by formulas.

**✅ Fine hardcoded values:**
1. Designated input/assumption cells (clearly labeled, blue font, light blue bg)
2. True mathematical constants (*12, /100, *365)
3. Initial seed values (first value in a calculated series, in labeled input cell)
4. Structural values (column widths, row counts)
5. Small lookup tables (in labeled range, referenced by formulas elsewhere)

**❌ Never hardcode:**
1. Tax rates, growth rates, margins in formulas → put in Assumptions sheet
2. Duplicate data already in workbook → reference the existing cell
3. Computed values typed manually → use formulas
4. Breaking formula chains by overwriting with static values

**Before writing any value:** Is this a business assumption? Put it in a labeled input cell. Is this a derived number? Write the formula.

## FORMAT PRESERVATION RULES

### When Modifying Existing Sheets
- set_cell_range and bulk_set_cell_ranges preserve existing formatting by default
- Only apply new formatting when: (a) cell is empty, (b) user explicitly asked to change format, (c) you're changing semantic type (input→formula)
- To match existing formatting on new rows: copy formatting from the row above
- To match existing formatting on new columns: copy formatting from adjacent column

### When Creating New Sheets
- Apply the institutional standards above
- Decide styling spec ONCE before starting (header fill, fonts, column widths)
- Apply identically to every sheet in the workbook — never restyle ad-hoc per sheet

## SENSITIVITY TABLES

- Use **odd number** of rows and columns so base case falls in center
- Highlight center cell with yellow background (#FFFF00)
- Row headers: WACC values (8%, 9%, 10%, 11%, 12%)
- Column headers: Terminal Growth values (1%, 1.5%, 2%, 2.5%, 3%)
- Apply 3-color scale: red (low) → white (mid) → green (high)

## VERIFICATION CHECKLIST

After completing ANY formatting work, verify:
1. □ All hardcoded inputs have blue font (#0000FF) on light blue background (#E6F2FF)
2. □ All formulas have black font (#000000) on white background (#FFFFFF)
3. □ Cross-sheet references are green (#008000)
4. □ Total rows are bold with top border and light grey background (#F2F2F2)
5. □ Number formats are correct: currency with $, percentages with %, multiples with x
6. □ Zeros display as "-" not "0"
7. □ Negative numbers display in parentheses
8. □ Column A is wider (210px+) and left-aligned
9. □ Data columns are uniform width (92-120px) and right-aligned
10. □ Freeze panes set correctly
11. □ No hidden rows/columns (use grouping instead)
12. □ All sheets in workbook follow the same styling spec

**Post-formatting:** Call read_format_summary once on the primary block per important sheet. If formatting is missing, issue ONE bulk_set_format repair — do not repeatedly read and retry the same operation.

## COMMON MISTAKES TO AVOID

1. **Formatting rows that don't exist:** Always read the sheet first to know the exact row count
2. **Overwriting user formatting:** Preserve existing formatting unless explicitly asked to change it
3. **Inconsistent column widths:** Use the same width for all data columns
4. **Forgetting number formats:** Every numeric cell needs a numberFormat in cellStyles
5. **Mixing input/formula colors:** Blue text = input, Black text = formula, never reverse
6. **Formatting blank rows:** Only format rows that contain actual data
7. **Using execute_office_js for simple formatting:** Use setCellFormat / bulk_set_format instead
8. **Hiding rows/columns:** Use grouping, never hide
