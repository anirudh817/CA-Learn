"""Verify kME_Matrix.csv is the peptide x module signedKME matrix, not the hubs frame."""
import os
import shutil
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("INLINE_RUNS", "1")


class StageOneKmeMatrixWriteTests(unittest.TestCase):
    """The R script must include a kme_matrix.csv write call."""

    def test_stage1_parity_r_writes_kme_matrix(self):
        script = ROOT / "backend" / "r_scripts" / "stage1_parity.R"
        text = script.read_text()
        self.assertIn("kme_matrix.csv", text, "stage1_parity.R must write kme_matrix.csv")
        # The write should pull from the kME_matrix variable (signedKME output)
        self.assertIn("kME_matrix", text)


class KmeMatrixPythonFallbackTests(unittest.TestCase):
    """When stage1/kme_matrix.csv is absent, Python fallback computes peptide x module
    kME from MEs and the normalized matrix."""

    def test_python_fallback_compute(self):
        from services.deliverables import _compute_kme_matrix_python

        rng = np.random.RandomState(42)
        sample_ids = [f"S{i}" for i in range(20)]
        # Three peptides; we'll force their relationships to specific MEs.
        normalized = pd.DataFrame(
            rng.normal(size=(3, 20)),
            index=["peptide_1", "peptide_2", "peptide_3"],
            columns=sample_ids,
        )
        # Force ME columns: turquoise == peptide_1, blue == -peptide_2, brown == peptide_3
        mes = pd.DataFrame({
            "MEturquoise": normalized.loc["peptide_1"].values,
            "MEblue": -normalized.loc["peptide_2"].values,
            "MEbrown": normalized.loc["peptide_3"].values,
        }, index=sample_ids)

        kme = _compute_kme_matrix_python(normalized, mes)
        self.assertEqual(set(kme.columns), {"kMEturquoise", "kMEblue", "kMEbrown"})
        self.assertEqual(list(kme.index), ["peptide_1", "peptide_2", "peptide_3"])
        # peptide_1 should have kMEturquoise ≈ 1
        self.assertAlmostEqual(kme.loc["peptide_1", "kMEturquoise"], 1.0, places=5)
        # peptide_2 should have kMEblue ≈ 1 (we negated the ME so two negs cancel? No:
        # we set ME = -peptide_2, so cor(peptide_2, ME) = -1)
        self.assertAlmostEqual(kme.loc["peptide_2", "kMEblue"], -1.0, places=5)
        self.assertAlmostEqual(kme.loc["peptide_3", "kMEbrown"], 1.0, places=5)

    def test_python_fallback_handles_missing_inputs(self):
        from services.deliverables import _compute_kme_matrix_python

        result = _compute_kme_matrix_python(pd.DataFrame(), pd.DataFrame())
        self.assertTrue(result.empty)


class StageOneNativeRPdfTests(unittest.TestCase):
    """Native R 01/02 PDFs land in stage1/ when R runs."""

    def test_native_r_top_level_pdfs_emitted(self):
        if not shutil.which("Rscript"):
            self.skipTest("Rscript not on PATH")
        runs_root = ROOT / "data" / "runs"
        if not runs_root.exists():
            self.skipTest("No data/runs directory")
        for run_dir in sorted([p for p in runs_root.iterdir() if p.is_dir()], reverse=True):
            sample = run_dir / "stage1" / "sample_clustering_qc.pdf"
            power = run_dir / "stage1" / "power_selection.pdf"
            if sample.exists() or power.exists():
                self.assertTrue(sample.exists(), "sample_clustering_qc.pdf missing")
                self.assertTrue(power.exists(), "power_selection.pdf missing")
                self.assertGreater(sample.stat().st_size, 1000)
                self.assertGreater(power.stat().st_size, 1000)
                return
        self.skipTest("No run with stage1 native R PDFs yet")


if __name__ == "__main__":
    unittest.main()
