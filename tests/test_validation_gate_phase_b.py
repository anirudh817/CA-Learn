"""Phase B validation gate: app's DE + WGCNA output vs. Eisai PeaksPep-42M reference.

Two assertions:
  1. Log2FC Pearson r ≥ 0.95 between app and reference (per matched feature)
  2. Module ARI ≥ 0.7 (adjusted_rand_score, label-permutation-invariant)

Both run the FULL pipeline end-to-end on the Sweden raw file. Skipped when
Rscript or reference deliverables are not present.
"""
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("INLINE_RUNS", "1")


SWEDEN_FILE = Path("/Users/anirudhs/Documents/ClientServices/Eisai/data/sweden-cohort-raw/PeaksPeptide List Sweden Cohort.csv")
REF_BASE = Path("/Users/anirudhs/Documents/ClientServices/Eisai/deliverables/cleaned-runs/PeaksPep-42M")
REF_VOLCANO = REF_BASE / "03_analysis_CBN_median" / "PEAKS_Volcano_Results_All.csv"
REF_MODULES = REF_BASE / "05_network_CBN_median" / "PEAKS_WGCNA_Module_Assignments_with_kME.csv"


def _all_inputs_available() -> tuple[bool, str]:
    if not shutil.which("Rscript"):
        return False, "Rscript not on PATH"
    if not SWEDEN_FILE.exists():
        return False, f"Sweden raw not present at {SWEDEN_FILE}"
    if not REF_VOLCANO.exists():
        return False, f"Reference volcano not at {REF_VOLCANO}"
    if not REF_MODULES.exists():
        return False, f"Reference modules not at {REF_MODULES}"
    return True, ""


class PhaseBValidationGateTests(unittest.TestCase):
    """Run app pipeline end-to-end, diff DE + WGCNA outputs against reference."""

    @classmethod
    def setUpClass(cls):
        ok, reason = _all_inputs_available()
        if not ok:
            raise unittest.SkipTest(reason)

        # Run the full pipeline ONCE for both gate tests (expensive)
        cls._tmp_dir = tempfile.TemporaryDirectory()
        cls._run_dir = Path(cls._tmp_dir.name) / "RUN-PHASEB"
        cls._run_dir.mkdir()
        (cls._run_dir / "input").mkdir()
        # Copy the Sweden raw into the run's input dir as the canonical primary
        primary_input = cls._run_dir / "input" / "primary.csv"
        shutil.copy(SWEDEN_FILE, primary_input)

        from services.pipeline import _build_canonical_bundle, run_stage1

        params = {
            "format_family": "PEAKS",
            "input_level": "peptide",
            "cohort1": "Control",
            "cohort2": "AD",
            # group1_name/group2_name are stage1_parity.R's CONFIG keys; cohort1/2 are
            # used by the Python ETL — must pass both for the full pipeline.
            "group1_name": "Control",
            "group2_name": "AD",
            "missing_value_threshold": 0.5,
            "min_samples_present": 4,
            "log_transform": True,  # cleaned_matrix.csv from R-ETL is linear; need log2 in stage1
            "value_scale": "linear",
            "normalization_method": "median",
            "normalization_tag": "CBN_median",
            "wgcna_soft_threshold": 6,
            "wgcna_min_module_size": 20,
            "wgcna_deep_split": 3,
            "wgcna_merge_cut_height": 0.30,
            "wgcna_network_type": "signed",
            "wgcna_correlation_type": "bicor",
            "wgcna_hub_percentile": 0.2,
            "fold_change_threshold": 1.5,
            "pvalue_threshold": 0.05,
            "use_adjusted_pvalue": True,
            "statistical_test": "t-test",
        }

        log_lines: list[str] = []
        log_fn = log_lines.append
        manifest = _build_canonical_bundle(str(primary_input), params, cls._run_dir, log_fn)
        cls._etl_manifest = manifest

        stage_config = {
            **params,
            "input_dir": str(cls._run_dir / "input"),
            "output_directory": str(cls._run_dir / "stage1"),
            "run_dir": str(cls._run_dir),
            "wgcna_seed": 42,
        }
        run_stage1(stage_config, cls._run_dir, log_fn)
        cls._log = "\n".join(log_lines)

    @classmethod
    def tearDownClass(cls):
        cls._tmp_dir.cleanup()

    def test_gate_b1_log2fc_pearson(self):
        """Log2FC Pearson r ≥ 0.95 vs reference."""
        from scipy import stats

        app_volcano_path = self._run_dir / "stage1" / "volcano_results.tsv"
        self.assertTrue(app_volcano_path.exists(), f"Missing {app_volcano_path}\nLog tail:\n{self._log[-2000:]}")
        app_df = pd.read_csv(app_volcano_path, sep="\t")
        ref_df = pd.read_csv(REF_VOLCANO)

        # Match by feature_id == Peptide_ID
        merged = app_df.merge(
            ref_df[["Peptide_ID", "Log2FC"]].rename(columns={"Peptide_ID": "feature_id", "Log2FC": "ref_log2fc"}),
            on="feature_id",
            how="inner",
        )
        merged = merged.dropna(subset=["log2fc", "ref_log2fc"])

        n = len(merged)
        print(f"\n  Common features: {n}")
        self.assertGreater(n, 1000, f"Need >1000 common features for stat power; got {n}")

        # Reference uses Log2FC as AD_Mean - Control_Mean. App's stage1_parity.R
        # may compute either direction depending on cohort1/cohort2 ordering.
        r_pos, _ = stats.pearsonr(merged["log2fc"], merged["ref_log2fc"])
        r_neg, _ = stats.pearsonr(-merged["log2fc"], merged["ref_log2fc"])
        r_best = max(r_pos, r_neg)
        print(f"  Log2FC Pearson r (positive direction): {r_pos:.3f}")
        print(f"  Log2FC Pearson r (negated direction): {r_neg:.3f}")
        print(f"  Best |r|: {r_best:.3f}")
        print(f"  Gate threshold: ≥ 0.95")
        self.assertGreaterEqual(r_best, 0.95, f"GATE FAIL: Pearson r = {r_best:.3f} < 0.95")

    def test_gate_b2_module_ari(self):
        """Module ARI ≥ 0.7 vs reference."""
        from sklearn.metrics import adjusted_rand_score

        app_modules_path = self._run_dir / "stage1" / "module_assignments.csv"
        self.assertTrue(app_modules_path.exists(), f"Missing {app_modules_path}\nLog tail:\n{self._log[-2000:]}")
        app_df = pd.read_csv(app_modules_path)
        ref_df = pd.read_csv(REF_MODULES)

        # Reference column "Peptide" is the feature ID; app column varies — try both
        app_id_col = "feature_id" if "feature_id" in app_df.columns else "peptide_id"
        ref_id_col = "Peptide"

        merged = app_df.merge(
            ref_df[[ref_id_col, "Assigned_Module"]].rename(columns={ref_id_col: app_id_col, "Assigned_Module": "ref_module"}),
            on=app_id_col,
            how="inner",
        )
        n = len(merged)
        print(f"\n  Common features (by ID): {n}")
        self.assertGreater(n, 1000, f"Need >1000 common features for ARI; got {n}")

        ari = adjusted_rand_score(merged["ref_module"].astype(str), merged["module_color"].astype(str))
        print(f"  Module ARI: {ari:.3f}")
        print(f"  Gate threshold: ≥ 0.7")

        # Distribution check (informational)
        common_modules_app = merged["module_color"].value_counts().head(10)
        common_modules_ref = merged["ref_module"].value_counts().head(10)
        print(f"  Top 10 app modules:\n    {dict(common_modules_app)}")
        print(f"  Top 10 ref modules:\n    {dict(common_modules_ref)}")

        self.assertGreaterEqual(ari, 0.7, f"GATE FAIL: ARI = {ari:.3f} < 0.7")


if __name__ == "__main__":
    unittest.main()
