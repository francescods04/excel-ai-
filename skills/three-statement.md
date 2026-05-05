---
name: three-statement
description: Integrated 3-statement financial model — income statement, balance sheet, cash flow with circular references
size: 7.8KB
---

# 3-Statement Model Skill

## Structure
1. Income Statement: revenue to net income
2. Balance Sheet: assets, liabilities, equity with plug (cash or revolver)
3. Cash Flow Statement: operating, investing, financing
4. Supporting schedules: D&A, working capital, debt, equity

## Circular References
- Interest expense depends on average debt balance
- Average debt depends on cash flow
- Solution: iterative calculation or manual average

## Excel Techniques
- Use SUMIFS for historical aggregation
- Color code: blue=input, black=calc, green=link, yellow=hardcode
- Add error checks: BS balance, cash reconciliation
- Freeze panes at row 1, column B
