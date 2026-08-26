"""Mathematical correctness of kME matrix: peptides perfectly aligned with their assigned ME should kME ≈ 1."""
import os
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("INLINE_RUNS", "1")


class KmeMathTests(unittest.TestCase):
    def test_kme_recovers_module_assignment(self):
        """A peptide that IS its module's eigengene should have kME ≈ 1 to that ME."""
        from services.deliverables import _compute_kme_matrix_python

        rng = np.random.RandomState(23)
        n_samples = 30
        sample_ids = [f"S{i}" for i in range(n_samples)]
        me_t = rng.normal(size=n_samples)
        me_b = rng.normal(size=n_samples)
        me_g = rng.normal(size=n_samples)
        mes = pd.DataFrame({"MEturquoise": me_t, "MEblue": me_b, "MEbrown": me_g}, index=sample_ids)

        normalized = pd.DataFrame(
            {sid: [me_t[i], me_b[i], me_g[i]] for i, sid in enumerate(sample_ids)},
            index=["pep_t", "pep_b", "pep_g"],
        )

        kme = _compute_kme_matrix_python(normalized, mes)
        self.assertAlmostEqual(kme.loc["pep_t", "kMEturquoise"], 1.0, places=6)
        self.assertAlmostEqual(kme.loc["pep_b", "kMEblue"], 1.0, places=6)
        self.assertAlmostEqual(kme.loc["pep_g", "kMEbrown"], 1.0, places=6)
        self.assertLess(abs(kme.loc["pep_t", "kMEblue"]), 0.5)

    def test_kme_anti_correlation(self):
        """A peptide that is the negative of its ME should kME ≈ -1."""
        from services.deliverables import _compute_kme_matrix_python

        rng = np.random.RandomState(29)
        n_samples = 30
        sample_ids = [f"S{i}" for i in range(n_samples)]
        me = rng.normal(size=n_samples)
        mes = pd.DataFrame({"MEturquoise": me}, index=sample_ids)
        normalized = pd.DataFrame(
            {sid: [-me[i]] for i, sid in enumerate(sample_ids)},
            index=["pep_anti"],
        )
        kme = _compute_kme_matrix_python(normalized, mes)
        self.assertAlmostEqual(kme.loc["pep_anti", "kMEturquoise"], -1.0, places=6)

    def test_kme_value_range_for_random_data(self):
        """For random uncorrelated data, kME values should be in [-1, 1] and not consistently 1."""
        from services.deliverables import _compute_kme_matrix_python

        rng = np.random.RandomState(37)
        sample_ids = [f"S{i}" for i in range(40)]
        normalized = pd.DataFrame(
            rng.normal(size=(20, 40)),
            index=[f"p{i}" for i in range(20)],
            columns=sample_ids,
        )
        mes = pd.DataFrame(
            rng.normal(size=(40, 5)),
            index=sample_ids,
            columns=[f"ME{c}" for c in ["turquoise", "blue", "brown", "yellow", "green"]],
        )
        kme = _compute_kme_matrix_python(normalized, mes)
        # Range
        self.assertGreaterEqual(kme.values.min(), -1.0001)
        self.assertLessEqual(kme.values.max(), 1.0001)
        # For 20×5 random: most values should be |kME| < 0.5
        below_half = (kme.abs() < 0.5).sum().sum()
        total = kme.shape[0] * kme.shape[1]
        self.assertGreater(below_half / total, 0.5)


if __name__ == "__main__":
    unittest.main()
