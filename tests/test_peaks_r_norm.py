"""Tests for the Python invoker of peaks_DataNormalization_ColumnBased.R."""
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("INLINE_RUNS", "1")


class PeaksNormRscriptPathTests(unittest.TestCase):
    def test_returns_none_when_rscript_missing(self):
        from services.pipeline import _peaks_norm_rscript_path

        with patch("services.pipeline.shutil.which", return_value=None):
            self.assertIsNone(_peaks_norm_rscript_path())

    def test_returns_path_when_present(self):
        from services.pipeline import _peaks_norm_rscript_path

        with patch("services.pipeline.shutil.which", return_value="/usr/bin/Rscript"):
            result = _peaks_norm_rscript_path()
            self.assertIsNotNone(result)
            self.assertTrue(str(result).endswith("peaks_DataNormalization_ColumnBased.R"))


class RunPeaksNormViaRTests(unittest.TestCase):
    def test_raises_when_rscript_missing(self):
        from services.pipeline import _run_peaks_norm_via_r

        with tempfile.TemporaryDirectory() as tmp:
            log2 = Path(tmp) / "log2.csv"
            log2.write_text("x\n")
            traits = Path(tmp) / "traits.csv"
            traits.write_text("SAMPLE_ID\n")
            output_dir = Path(tmp) / "02_normalized_CBN_median"

            with patch("services.pipeline.shutil.which", return_value=None):
                with self.assertRaises(RuntimeError):
                    _run_peaks_norm_via_r(
                        log2, traits, output_dir, method="median", log_fn=lambda _: None
                    )

    def test_raises_when_log2_input_missing(self):
        from services.pipeline import _run_peaks_norm_via_r

        with tempfile.TemporaryDirectory() as tmp:
            log2_missing = Path(tmp) / "no.csv"  # not created
            traits = Path(tmp) / "traits.csv"
            traits.write_text("SAMPLE_ID\n")
            output_dir = Path(tmp) / "02_normalized_CBN_median"

            with patch("services.pipeline.shutil.which", return_value="/usr/bin/Rscript"):
                with self.assertRaises(RuntimeError):
                    _run_peaks_norm_via_r(
                        log2_missing, traits, output_dir, method="median", log_fn=lambda _: None
                    )

    def test_writes_wrapper_and_invokes(self):
        from services.pipeline import _run_peaks_norm_via_r

        with tempfile.TemporaryDirectory() as tmp:
            log2 = Path(tmp) / "log2.csv"
            log2.write_text(",S1,S2\nA,1,2\nB,3,4\n")
            traits = Path(tmp) / "traits.csv"
            traits.write_text("SAMPLE_ID,GROUP\nS1,Control\nS2,Disease\n")
            output_dir = Path(tmp) / "02_normalized_CBN_median"
            output_dir.mkdir(parents=True)
            (output_dir / "PEAKS_Normalized_Log2_Data.csv").write_text("dummy")

            mock_result = MagicMock()
            mock_result.returncode = 0
            mock_result.stdout = "[peaks_norm] features=18135 samples=60\n"
            mock_result.stderr = ""

            with patch("services.pipeline.shutil.which", return_value="/usr/bin/Rscript"):
                with patch("services.pipeline.subprocess.run", return_value=mock_result):
                    result = _run_peaks_norm_via_r(
                        log2, traits, output_dir, method="median", log_fn=lambda _: None
                    )

            wrapper = output_dir / "_peaks_norm_invoke.R"
            self.assertTrue(wrapper.exists())
            content = wrapper.read_text()
            self.assertIn("peaks_ColumnNormalization", content)
            self.assertIn("median", content)
            self.assertEqual(result["log2_normalized"], output_dir / "PEAKS_Normalized_Log2_Data.csv")


class RunPeaksNormViaR_RealRTests(unittest.TestCase):
    """End-to-end: run R ETL on Sweden raw, then R norm on its output."""

    SWEDEN_FILE = Path("/Users/anirudhs/Documents/ClientServices/Eisai/data/sweden-cohort-raw/PeaksPeptide List Sweden Cohort.csv")

    def test_real_normalization_chain(self):
        if not shutil.which("Rscript"):
            self.skipTest("Rscript not on PATH")
        if not self.SWEDEN_FILE.exists():
            self.skipTest(f"Sweden raw file not present at {self.SWEDEN_FILE}")

        from services.pipeline import _run_peaks_etl_via_r, _run_peaks_norm_via_r
        import pandas as pd

        with tempfile.TemporaryDirectory() as tmp:
            etl_dir = Path(tmp) / "01_input"
            norm_dir = Path(tmp) / "02_normalized_CBN_median"

            etl_result = _run_peaks_etl_via_r(
                self.SWEDEN_FILE, etl_dir,
                missing_threshold=0.5, cohort1="Control", cohort2="AD",
                log_fn=lambda _: None,
            )
            log2_path = etl_result["log2_path"]
            traits_path = etl_result["traits_path"]
            self.assertIsNotNone(log2_path)
            self.assertIsNotNone(traits_path)

            norm_result = _run_peaks_norm_via_r(
                log2_path, traits_path, norm_dir,
                method="median", log_fn=lambda _: None,
            )
            self.assertTrue(norm_result["log2_normalized"].exists())
            df = pd.read_csv(norm_result["log2_normalized"], index_col=0)
            self.assertGreaterEqual(len(df), 17228)
            # After median centering, column medians should be approximately equal
            col_medians = df.median(axis=0)
            # Spread of medians should be very small post-CBN
            self.assertLess(col_medians.max() - col_medians.min(), 0.1,
                            f"CBN median spread too large: {col_medians.max() - col_medians.min()}")


if __name__ == "__main__":
    unittest.main()
