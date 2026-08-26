"""Mathematical correctness of module-trait correlations: round-trip with scipy."""
import os
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("INLINE_RUNS", "1")


class CorrelationMathTests(unittest.TestCase):
    def test_synthetic_orthogonal_recovery(self):
        """For an orthogonal pair, r ≈ 0; for a perfect linear pair, r ≈ ±1."""
        np.random.seed(7)
        x = np.random.normal(size=200)
        y_orthogonal = np.random.normal(size=200)
        y_linear = 2 * x + 0.001 * np.random.normal(size=200)

        r_orth, p_orth = stats.pearsonr(x, y_orthogonal)
        r_lin, p_lin = stats.pearsonr(x, y_linear)

        self.assertLess(abs(r_orth), 0.2)
        self.assertGreater(p_orth, 0.005)
        self.assertGreater(r_lin, 0.99)
        self.assertLess(p_lin, 1e-100)

    def test_kme_python_fallback_matches_pearson(self):
        """_compute_kme_matrix_python output must equal scipy.stats.pearsonr per cell."""
        from services.deliverables import _compute_kme_matrix_python

        rng = np.random.RandomState(11)
        sample_ids = [f"S{i}" for i in range(50)]
        normalized = pd.DataFrame(
            rng.normal(size=(5, 50)),
            index=[f"pep_{i}" for i in range(5)],
            columns=sample_ids,
        )
        mes = pd.DataFrame(
            rng.normal(size=(50, 3)),
            index=sample_ids,
            columns=["MEturquoise", "MEblue", "MEbrown"],
        )

        kme = _compute_kme_matrix_python(normalized, mes)
        for pep in normalized.index:
            for me in mes.columns:
                expected = stats.pearsonr(normalized.loc[pep], mes[me])
                cell = kme.loc[pep, me.replace("ME", "kME", 1)]
                self.assertAlmostEqual(cell, expected.statistic, places=6,
                                       msg=f"kME[{pep},{me}] mismatch")


if __name__ == "__main__":
    unittest.main()
