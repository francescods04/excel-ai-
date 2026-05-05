---
name: clean-data
description: Data cleaning and transformation in Excel — detect anomalies, standardize formats, fill gaps
size: 3.1KB
---

# Clean Data Skill

## Common Issues
1. Merged cells in tables → unmerge and fill down
2. Inconsistent date formats → standardize to YYYY-MM-DD
3. Mixed number/text → convert to numeric
4. Leading/trailing spaces → TRIM()
5. Duplicate rows → Remove Duplicates or COUNTIF
6. Empty rows → filter and delete

## Excel Tools
- Flash Fill (Ctrl+E) for pattern extraction
- Text to Columns for splitting
- Find & Replace with wildcards
- Conditional formatting to highlight anomalies
- Data Validation to prevent future issues

## Formulas
- =TRIM(CLEAN(A1)) for text cleanup
- =VALUE(A1) for text→number
- =IFERROR(A1/B1,0) for error handling
- =UNIQUE(range) for deduplication
