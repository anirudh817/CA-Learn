"""Tests for Excel-corrupted gene-symbol fixer."""
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("INLINE_RUNS", "1")

from services.gene_name_fix import fix_excel_corrupted_gene, EXCEL_GENE_CORRUPTION_FIX  # noqa: E402


class GeneNameFixTests(unittest.TestCase):
    def test_septin_family(self):
        self.assertEqual(fix_excel_corrupted_gene("7-Sep"), "SEPTIN7")
        self.assertEqual(fix_excel_corrupted_gene("2-Sep"), "SEPTIN2")
        self.assertEqual(fix_excel_corrupted_gene("11-Sep"), "SEPTIN11")

    def test_marchf_family(self):
        self.assertEqual(fix_excel_corrupted_gene("1-Mar"), "MARCHF1")
        self.assertEqual(fix_excel_corrupted_gene("8-Mar"), "MARCHF8")

    def test_passthrough_uncorrupted(self):
        self.assertEqual(fix_excel_corrupted_gene("APOE"), "APOE")
        self.assertEqual(fix_excel_corrupted_gene("YWHAB"), "YWHAB")
        self.assertEqual(fix_excel_corrupted_gene("Q15019"), "Q15019")

    def test_empty_and_none(self):
        self.assertEqual(fix_excel_corrupted_gene(""), "")
        self.assertEqual(fix_excel_corrupted_gene(None), "")
        self.assertEqual(fix_excel_corrupted_gene("   "), "")

    def test_strips_whitespace(self):
        self.assertEqual(fix_excel_corrupted_gene("  7-Sep  "), "SEPTIN7")

    def test_non_string_coerced(self):
        # Numeric input — coerce to string and pass through
        self.assertEqual(fix_excel_corrupted_gene(42), "42")

    def test_corruption_table_completeness(self):
        # All common date-corrupted gene names must be in the table
        common_victims = {"1-Sep", "7-Sep", "11-Sep", "1-Mar", "5-Mar"}
        for victim in common_victims:
            self.assertIn(victim, EXCEL_GENE_CORRUPTION_FIX,
                          f"{victim} missing from corruption fix table")


if __name__ == "__main__":
    unittest.main()
