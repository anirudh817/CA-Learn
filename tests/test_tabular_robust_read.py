"""Tests for robust tabular reading (the GO-FET parse-failure fix).

Reproduces the production failure: a `.txt` export whose real delimiter is NOT
the comma the extension implies, where the naive reader raised
"Expected 1 fields in line N, saw 2" and the chat saw zero rows.
"""
from __future__ import annotations

import sys
import tempfile
import unittest
import warnings
from pathlib import Path

from tests.test_app import BACKEND_DIR, build_app

warnings.simplefilter("ignore", DeprecationWarning)
warnings.simplefilter("ignore", ResourceWarning)

with tempfile.TemporaryDirectory() as _td:
    build_app(_td)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.ai.tabular import read_table  # noqa: E402


class RobustReadTests(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.dir = Path(self._td.name)

    def tearDown(self):
        self._td.cleanup()

    def _write(self, name, text):
        p = self.dir / name
        p.write_text(text)
        return p

    def test_tab_delimited_txt_parses(self):
        # A GO-FET-style .txt that is actually tab-delimited (the extension
        # implies comma; the naive reader would choke).
        rows = ["GO_term\tmodule\tpvalue\tfdr"]
        for i in range(40):
            rows.append(f"GO:00000{i:02d}\tturquoise\t0.0{i}\t0.1{i}")
        df = read_table(self._write("GSA-GO-FET.txt", "\n".join(rows)))
        self.assertIsNotNone(df)
        self.assertGreater(len(df), 30)
        self.assertGreaterEqual(df.shape[1], 3)

    def test_irregular_row_does_not_abort_read(self):
        # Most lines have one comma-free token; one line sneaks a comma — the
        # exact "Expected 1 fields, saw 2" trigger. Must still return rows.
        lines = ["term"] + [f"value_{i}" for i in range(600)]
        lines[531] = "value_531,extra"  # the offending line ~532
        df = read_table(self._write("weird.txt", "\n".join(lines)))
        self.assertIsNotNone(df)
        self.assertGreater(len(df), 100)

    def test_clean_csv_still_parses_normally(self):
        df = read_table(self._write("clean.csv", "gene,log2fc\nAPOE,1.2\nCLU,0.8"))
        self.assertIsNotNone(df)
        self.assertEqual(list(df.columns), ["gene", "log2fc"])
        self.assertEqual(len(df), 2)

    def test_clean_tsv_parses(self):
        df = read_table(self._write("x.tsv", "gene\tlog2fc\nAPOE\t1.2\nCLU\t0.8"))
        self.assertIsNotNone(df)
        self.assertEqual(list(df.columns), ["gene", "log2fc"])

    def test_prose_txt_is_not_split_into_a_table(self):
        # A summary paragraph must NOT be shredded into a multi-column table by
        # a whitespace split (the M4 regression). It should read as ≤1 column.
        prose = (
            "This run analyzed 60 samples across two cohorts.\n"
            "The turquoise module was the largest with 6355 members.\n"
            "Differential expression highlighted synaptic proteins.\n"
        )
        df = read_table(self._write("PEAKS_Volcano_Summary.txt", prose))
        self.assertIsNotNone(df)
        self.assertLessEqual(df.shape[1], 1)

    def test_single_column_with_spaces_stays_one_column(self):
        # Values containing spaces must not be split into bogus columns (M3).
        text = "description\nApolipoprotein E precursor\nClusterin isoform 1\n"
        df = read_table(self._write("descriptions.csv", text))
        self.assertIsNotNone(df)
        self.assertEqual(df.shape[1], 1)

    def test_semicolon_delimited_is_detected(self):
        text = "gene;log2fc;fdr\n" + "\n".join(f"G{i};0.{i};0.0{i}" for i in range(20))
        df = read_table(self._write("euro.csv", text))
        self.assertIsNotNone(df)
        self.assertGreaterEqual(df.shape[1], 3)

    def test_nrows_is_respected(self):
        rows = ["a,b"] + [f"{i},{i}" for i in range(100)]
        df = read_table(self._write("big.csv", "\n".join(rows)), nrows=10)
        self.assertIsNotNone(df)
        self.assertEqual(len(df), 10)


if __name__ == "__main__":
    unittest.main()
