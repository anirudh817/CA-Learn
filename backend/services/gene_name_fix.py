"""Excel-corrupted gene-symbol fixer.

When proteomics CSVs are opened/saved in Excel, gene names matching date patterns
(SEPT* → 2-Sep, MARCH* → 1-Mar, etc.) get auto-converted to date strings.
HGNC's symbol-checker maintains the canonical mapping; this module embeds it.

Reference: https://www.genenames.org/help/symbol-checker/
"""
from __future__ import annotations

# Excel auto-conversion victims (canonical HGNC symbols on the right).
EXCEL_GENE_CORRUPTION_FIX: dict[str, str] = {
    # SEPTIN family — Excel converts to "N-Sep"
    "1-Sep": "SEPTIN1", "2-Sep": "SEPTIN2", "3-Sep": "SEPTIN3", "4-Sep": "SEPTIN4",
    "5-Sep": "SEPTIN5", "6-Sep": "SEPTIN6", "7-Sep": "SEPTIN7", "8-Sep": "SEPTIN8",
    "9-Sep": "SEPTIN9", "10-Sep": "SEPTIN10", "11-Sep": "SEPTIN11", "12-Sep": "SEPTIN12",
    "14-Sep": "SEPTIN14",
    # MARCH (E3 ubiquitin ligase) family — Excel converts to "N-Mar"
    "1-Mar": "MARCHF1", "2-Mar": "MARCHF2", "3-Mar": "MARCHF3", "4-Mar": "MARCHF4",
    "5-Mar": "MARCHF5", "6-Mar": "MARCHF6", "7-Mar": "MARCHF7", "8-Mar": "MARCHF8",
    "9-Mar": "MARCHF9", "10-Mar": "MARCHF10", "11-Mar": "MARCHF11",
    # Less common date-clashes
    "1-Dec": "DELEC1",
    "1-Apr": "APR1",
    "1-Oct": "POU2F1",
    "3-Oct": "POU3F1",
    "4-Oct": "POU5F1",
    "11-Mar-19": "MARCH11",  # Some Excel exports add the year
}


def fix_excel_corrupted_gene(name: object) -> str:
    """Return the canonical HGNC symbol for an Excel-corrupted gene name.

    Pass-through for any name not in the corruption table. Non-string
    inputs are coerced to string; empty / None returns empty string.
    """
    if name is None:
        return ""
    text = str(name).strip()
    if not text:
        return ""
    return EXCEL_GENE_CORRUPTION_FIX.get(text, text)
