"""Phase A validation gate: app's R-ETL output vs. Eisai PeaksPep-42M reference.

Two assertions, both required for Phase A to be considered complete:

  1. Feature count gate: ETL output has >= 17,228 rows (95% of reference's 18,135)
  2. Log2 parity gate: post-CBN log2 values match reference within 0.5 for >= 95% of cells

Both are skipped when:
  - Rscript is not on PATH (R-dependent)
  - Sweden raw file is not present
  - Reference deliverable is not present

Local dev should have all three; CI may not.
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
REF_ABUNDANCE = REF_BASE / "01_input" / "PEAKS_Abundance_Matrix.csv"
REF_LOG2_NORMALIZED = REF_BASE / "02_normalized_CBN_median" / "PEAKS_Normalized_Log2_Data.csv"


def _all_inputs_available() -> tuple[bool, str]:
    if not shutil.which("Rscript"):
        return False, "Rscript not on PATH"
    if not SWEDEN_FILE.exists():
        return False, f"Sweden raw not present at {SWEDEN_FILE}"
    if not REF_ABUNDANCE.exists():
        return False, f"Reference abundance matrix not at {REF_ABUNDANCE}"
    if not REF_LOG2_NORMALIZED.exists():
        return False, f"Reference normalized log2 not at {REF_LOG2_NORMALIZED}"
    return True, ""


class PhaseAValidationGateTests(unittest.TestCase):
    """E2E validation: run R ETL+Norm on Sweden raw, diff against reference."""

    def setUp(self):
        ok, reason = _all_inputs_available()
        if not ok:
            self.skipTest(reason)

    def _run_etl_and_norm(self, tmp: Path) -> tuple[Path, Path]:
        from services.pipeline import _run_peaks_etl_via_r, _run_peaks_norm_via_r

        etl_dir = tmp / "01_input"
        norm_dir = tmp / "02_normalized_CBN_median"

        etl = _run_peaks_etl_via_r(
            SWEDEN_FILE, etl_dir,
            missing_threshold=0.5,
            cohort1="Control", cohort2="AD",
            log_fn=lambda _: None,
        )
        norm = _run_peaks_norm_via_r(
            etl["log2_path"], etl["traits_path"], norm_dir,
            method="median",
            log_fn=lambda _: None,
        )
        return etl["abundance_path"], norm["log2_normalized"]

    def test_gate_1_feature_count(self):
        """Gate 1: app's ETL produces >= 17,228 features (95% of ref's 18,135)."""
        with tempfile.TemporaryDirectory() as tmp_str:
            tmp = Path(tmp_str)
            abundance_path, _ = self._run_etl_and_norm(tmp)
            app_df = pd.read_csv(abundance_path, index_col=0)
            ref_df = pd.read_csv(REF_ABUNDANCE, index_col=0)

            print(f"\n  App features: {len(app_df)}")
            print(f"  Reference features: {len(ref_df)}")
            print(f"  Gate threshold: >= 17,228 (95% of ref)")

            self.assertGreaterEqual(
                len(app_df), 17228,
                f"GATE FAIL: only {len(app_df)} features, need >= 17,228"
            )
            # Bonus: how many features are in COMMON (exact ID match) with reference?
            common = set(app_df.index) & set(ref_df.index)
            print(f"  Exact-ID match with reference: {len(common)} / {len(ref_df)} ({100*len(common)/len(ref_df):.1f}%)")
            self.assertGreaterEqual(
                len(common), int(0.85 * len(ref_df)),
                f"Only {len(common)} of {len(ref_df)} reference features are present by exact ID match"
            )

    def test_gate_2_log2_parity(self):
        """Gate 2: per-cell |app−ref| < 0.5 for >= 95% of shared (feature, sample) cells."""
        with tempfile.TemporaryDirectory() as tmp_str:
            tmp = Path(tmp_str)
            _, log2_normalized_path = self._run_etl_and_norm(tmp)

            app_df = pd.read_csv(log2_normalized_path, index_col=0)
            ref_df = pd.read_csv(REF_LOG2_NORMALIZED, index_col=0)

            # Intersect on features (feature_id index) and samples (columns)
            common_features = sorted(set(app_df.index) & set(ref_df.index))
            common_samples = sorted(set(app_df.columns) & set(ref_df.columns))

            print(f"\n  Common features: {len(common_features)}")
            print(f"  Common samples: {len(common_samples)}")

            self.assertGreater(len(common_features), 1000,
                               f"Need >1000 common features; only {len(common_features)} matched")
            self.assertGreater(len(common_samples), 10,
                               f"Need >10 common samples; only {len(common_samples)} matched")

            app_sub = app_df.loc[common_features, common_samples]
            ref_sub = ref_df.loc[common_features, common_samples]
            diffs = (app_sub - ref_sub).abs().values
            valid_mask = ~np.isnan(diffs)
            n_valid = int(valid_mask.sum())
            n_within = int((diffs[valid_mask] < 0.5).sum())
            pct_within = 100 * n_within / n_valid if n_valid else 0

            # Distribution diagnostics
            try:
                pcts = np.nanpercentile(diffs[valid_mask], [50, 75, 90, 95, 99])
                print(f"  |app−ref| percentiles (50/75/90/95/99): {pcts.round(3)}")
            except Exception:
                pass
            print(f"  Cells within ±0.5: {n_within}/{n_valid} ({pct_within:.1f}%)")
            print(f"  Gate threshold: >= 95%")

            self.assertGreaterEqual(
                pct_within, 95.0,
                f"GATE FAIL: only {pct_within:.1f}% of cells within ±0.5 (need >= 95%)"
            )


if __name__ == "__main__":
    unittest.main()
