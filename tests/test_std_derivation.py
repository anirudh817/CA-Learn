"""Statistical correctness tests for the qnorm rank-transform used to derive _std trait variants."""
import math
import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("INLINE_RUNS", "1")

from services.pipeline import _qnorm_rank, _expand_traits  # noqa: E402


class QnormRankTests(unittest.TestCase):
    def test_output_has_zero_mean_unit_variance(self):
        """For uniform input, qnorm rank should approximate N(0, 1)."""
        np.random.seed(42)
        x = pd.Series(np.random.uniform(0, 100, 1000))
        out = _qnorm_rank(x)
        self.assertAlmostEqual(out.mean(), 0.0, places=2)
        self.assertAlmostEqual(out.std(ddof=0), 1.0, places=1)

    def test_preserves_nan(self):
        """NaN values in input must remain NaN in output."""
        x = pd.Series([1.0, 2.0, float("nan"), 3.0, 4.0, float("nan")])
        out = _qnorm_rank(x)
        self.assertTrue(math.isnan(out.iloc[2]))
        self.assertTrue(math.isnan(out.iloc[5]))
        self.assertTrue(out.iloc[[0, 1, 3, 4]].notna().all())

    def test_handles_ties_via_average_rank(self):
        """Ties in input should produce identical output values (average-rank semantics)."""
        x = pd.Series([1.0, 2.0, 2.0, 3.0])
        out = _qnorm_rank(x)
        self.assertAlmostEqual(out.iloc[1], out.iloc[2], places=10)

    def test_few_values_returns_all_nan(self):
        """Fewer than 2 non-null values cannot be rank-normalized; output is all NaN."""
        x = pd.Series([float("nan"), float("nan"), 5.0])
        out = _qnorm_rank(x)
        self.assertTrue(out.isna().all())

    def test_monotonic_preserves_order(self):
        """qnorm rank is monotonic — ascending input gives ascending output."""
        x = pd.Series([1.0, 5.0, 10.0, 50.0, 100.0])
        out = _qnorm_rank(x)
        diffs = np.diff(out.values)
        self.assertTrue((diffs > 0).all())

    def test_matches_scipy_implementation(self):
        """Cross-check: our impl should match the inline formula qnorm((rank - 0.5) / n)."""
        x = pd.Series([0.5, 1.2, 3.4, 7.1, 8.8])
        out = _qnorm_rank(x)
        expected_ranks = pd.Series([1.0, 2.0, 3.0, 4.0, 5.0])
        expected = stats.norm.ppf((expected_ranks - 0.5) / 5)
        np.testing.assert_allclose(out.values, expected, atol=1e-10)


class ExpandTraitsTests(unittest.TestCase):
    def test_canonical_columns_replaced_with_raw_and_std(self):
        df = pd.DataFrame({
            "Sample": ["S1", "S2", "S3", "S4", "S5"],
            "T_TAU": [10.0, 20.0, 30.0, 40.0, 50.0],
            "AGE": [60, 70, 80, 75, 65],
        })
        out = _expand_traits(df)
        self.assertNotIn("T_TAU", out.columns)
        self.assertIn("T_TAU_raw", out.columns)
        self.assertIn("T_TAU_std", out.columns)
        self.assertIn("AGE", out.columns)
        np.testing.assert_array_equal(out["T_TAU_raw"].values, df["T_TAU"].values)

    def test_all_three_canonicals_handled(self):
        df = pd.DataFrame({
            "Sample": ["S1", "S2", "S3", "S4"],
            "T_TAU": [1.0, 2.0, 3.0, 4.0],
            "P_TAU": [0.5, 1.0, 1.5, 2.0],
            "ABETA42": [100, 200, 300, 400],
        })
        out = _expand_traits(df)
        for canonical in ("T_TAU", "P_TAU", "ABETA42"):
            self.assertNotIn(canonical, out.columns)
            self.assertIn(f"{canonical}_raw", out.columns)
            self.assertIn(f"{canonical}_std", out.columns)

    def test_passes_through_when_canonical_absent(self):
        df = pd.DataFrame({
            "Sample": ["S1", "S2", "S3"],
            "AD": [0, 1, 1],
            "AGE": [60, 70, 80],
        })
        out = _expand_traits(df)
        self.assertEqual(set(df.columns), set(out.columns))

    def test_existing_raw_std_columns_not_overwritten(self):
        df = pd.DataFrame({
            "Sample": ["S1", "S2", "S3", "S4"],
            "T_TAU": [1.0, 2.0, 3.0, 4.0],
            "T_TAU_raw": [99, 99, 99, 99],
            "T_TAU_std": [-99, -99, -99, -99],
        })
        out = _expand_traits(df)
        self.assertNotIn("T_TAU", out.columns)
        self.assertEqual(out["T_TAU_raw"].iloc[0], 99)
        self.assertEqual(out["T_TAU_std"].iloc[0], -99)

    def test_does_not_mutate_input(self):
        df = pd.DataFrame({"Sample": ["S1", "S2"], "T_TAU": [1.0, 2.0]})
        original_cols = list(df.columns)
        _ = _expand_traits(df)
        self.assertEqual(list(df.columns), original_cols)


if __name__ == "__main__":
    unittest.main()
