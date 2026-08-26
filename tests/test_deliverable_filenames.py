"""Filename correctness post-fix: AD/Disease, raw/std variants."""
import os
import sys
import unittest
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("INLINE_RUNS", "1")


class TraitStemTests(unittest.TestCase):
    """Unit tests for _trait_output_stem — the function that names per-trait CSVs."""

    def test_ad_in_disease_status_folder_yields_AD(self):
        from services.deliverables import _trait_output_stem
        self.assertEqual(_trait_output_stem("AD", "disease_status"), "AD")
        self.assertEqual(_trait_output_stem("ADStatus", "disease_status"), "AD")
        self.assertEqual(_trait_output_stem("disease", "disease_status"), "Disease")

    def test_ttau_raw_yields_T_TAU_raw(self):
        from services.deliverables import _trait_output_stem
        self.assertEqual(_trait_output_stem("T_TAU_raw", "total_tau"), "T_TAU_raw")

    def test_ttau_std_yields_T_TAU_std(self):
        from services.deliverables import _trait_output_stem
        self.assertEqual(_trait_output_stem("T_TAU_std", "total_tau"), "T_TAU_std")

    def test_ptau_variants(self):
        from services.deliverables import _trait_output_stem
        self.assertEqual(_trait_output_stem("P_TAU_raw", "phospho_tau"), "P_TAU_raw")
        self.assertEqual(_trait_output_stem("P_TAU_std", "phospho_tau"), "P_TAU_std")

    def test_abeta_variants(self):
        from services.deliverables import _trait_output_stem
        self.assertEqual(_trait_output_stem("ABETA42_raw", "amyloid_beta"), "ABETA42_raw")
        self.assertEqual(_trait_output_stem("ABETA42_std", "amyloid_beta"), "ABETA42_std")


class FilenamesE2ETests(unittest.TestCase):
    """Verify _expand_traits + _trait_output_stem produce the expected variant
    filenames end-to-end (without running the full pipeline)."""

    def test_e2e_raw_and_std_csvs_emitted(self):
        from services import pipeline as pipeline_module
        from services.deliverables import _trait_output_stem

        traits_input = pd.DataFrame({
            "Sample": [f"S{i}" for i in range(40)],
            "T_TAU": [(i + 1) * 1.0 for i in range(40)],
            "P_TAU": [(i + 1) * 0.3 for i in range(40)],
            "ABETA42": [(i + 1) * 100 for i in range(40)],
            "AD": [i % 2 for i in range(40)],
        })
        expanded = pipeline_module._expand_traits(traits_input)

        for col in ("T_TAU_raw", "T_TAU_std", "P_TAU_raw", "P_TAU_std", "ABETA42_raw", "ABETA42_std"):
            self.assertIn(col, expanded.columns, f"Expected {col} in expanded traits")

        self.assertEqual(_trait_output_stem("T_TAU_raw", "total_tau"), "T_TAU_raw")
        self.assertEqual(_trait_output_stem("T_TAU_std", "total_tau"), "T_TAU_std")
        self.assertEqual(_trait_output_stem("P_TAU_raw", "phospho_tau"), "P_TAU_raw")
        self.assertEqual(_trait_output_stem("P_TAU_std", "phospho_tau"), "P_TAU_std")
        self.assertEqual(_trait_output_stem("ABETA42_raw", "amyloid_beta"), "ABETA42_raw")
        self.assertEqual(_trait_output_stem("ABETA42_std", "amyloid_beta"), "ABETA42_std")
        self.assertEqual(_trait_output_stem("AD", "disease_status"), "AD")


if __name__ == "__main__":
    unittest.main()
