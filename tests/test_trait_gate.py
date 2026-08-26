"""Conditional gate: per-trait pipeline runs only when usable trait metadata exists."""
import os
import sys
import unittest
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("INLINE_RUNS", "1")


class HasUsableTraitsTests(unittest.TestCase):
    def setUp(self):
        from services.deliverables import _has_usable_traits  # noqa
        self._fn = _has_usable_traits

    def test_only_sample_column_returns_false(self):
        df = pd.DataFrame({"Sample": [f"S{i}" for i in range(10)]})
        self.assertFalse(self._fn(df))

    def test_all_null_trait_returns_false(self):
        df = pd.DataFrame({"Sample": ["S1", "S2", "S3"], "AD": [None, None, None]})
        self.assertFalse(self._fn(df))

    def test_three_non_null_below_threshold(self):
        df = pd.DataFrame({"Sample": ["S1", "S2", "S3", "S4"], "AD": [0, 1, 0, None]})
        self.assertFalse(self._fn(df, min_non_null=4))

    def test_four_non_null_meets_threshold(self):
        df = pd.DataFrame({
            "Sample": ["S1", "S2", "S3", "S4", "S5"],
            "AD": [0, 1, 0, 1, None],
        })
        self.assertTrue(self._fn(df, min_non_null=4))

    def test_mixed_columns_one_qualifies(self):
        df = pd.DataFrame({
            "Sample": ["S1", "S2", "S3", "S4", "S5"],
            "EMPTY": [None, None, None, None, None],
            "AGE": [60, 70, 80, 75, 65],
        })
        self.assertTrue(self._fn(df, min_non_null=4))

    def test_sample_case_insensitive(self):
        df = pd.DataFrame({"sample": ["S1"], "Disease": [1]})
        self.assertFalse(self._fn(df, min_non_null=4))


if __name__ == "__main__":
    unittest.main()
