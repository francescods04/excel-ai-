---
name: audit-xls
description: Audit and review Excel models — trace precedents/dependents, check for errors, document assumptions
size: 4.3KB
---

# Audit Excel Skill

## Audit Checklist
1. All formulas have = prefix
2. No hardcoded numbers in calculation rows
3. Circular references resolved or documented
4. Cross-sheet references valid (no #REF!)
5. Sensitivity analysis included
6. Model balanced: BS assets = liabilities + equity

## Excel Audit Tools
- Trace Precedents (Alt+M+P)
- Trace Dependents (Alt+M+D)
- Error Checking (Formulas → Error Checking)
- Evaluate Formula (F9 in formula bar)
- Watch Window for key cells

## Documentation
- Assumptions sheet with source citations
- Version history in hidden sheet
- Color coding legend
- Instruction tab for users
