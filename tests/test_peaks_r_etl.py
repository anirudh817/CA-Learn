"""Tests for the Python invoker that wraps peaks_DataLoader_Flexible.R."""
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


class PeaksEtlRscriptPathTests(unittest.TestCase):
    def test_returns_none_when_rscript_missing(self):
        from services.pipeline import _peaks_etl_rscript_path

        with patch("services.pipeline.shutil.which", return_value=None):
            self.assertIsNone(_peaks_etl_rscript_path())

    def test_returns_path_when_rscript_present_and_script_exists(self):
        from services.pipeline import _peaks_etl_rscript_path

        with patch("services.pipeline.shutil.which", return_value="/usr/bin/Rscript"):
            result = _peaks_etl_rscript_path()
            self.assertIsNotNone(result)
            self.assertTrue(str(result).endswith("peaks_DataLoader_Flexible.R"))


class RunPeaksEtlViaRTests(unittest.TestCase):
    def test_raises_when_rscript_missing(self):
        from services.pipeline import _run_peaks_etl_via_r

        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "01_input"
            input_file = Path(tmp) / "fake.csv"
            input_file.write_text("Accession,Peptide,Area S1\n")

            with patch("services.pipeline.shutil.which", return_value=None):
                with self.assertRaises(RuntimeError):
                    _run_peaks_etl_via_r(
                        input_file,
                        output_dir,
                        missing_threshold=0.5,
                        cohort1="Control",
                        cohort2="Disease",
                        log_fn=lambda _: None,
                    )

    def test_writes_wrapper_script_and_invokes_rscript(self):
        from services.pipeline import _run_peaks_etl_via_r

        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "01_input"
            input_file = Path(tmp) / "input.csv"
            input_file.write_text("Accession,Peptide,Area S1\n")

            mock_result = MagicMock()
            mock_result.returncode = 0
            mock_result.stdout = "[peaks_etl] features=18135 samples=60\n"
            mock_result.stderr = ""

            # Pre-create the expected output so the post-check passes
            output_dir.mkdir(parents=True)
            (output_dir / "PEAKS_Abundance_Matrix.csv").write_text("dummy")

            with patch("services.pipeline.shutil.which", return_value="/usr/bin/Rscript"):
                with patch("services.pipeline.subprocess.run", return_value=mock_result) as mock_run:
                    result = _run_peaks_etl_via_r(
                        input_file,
                        output_dir,
                        missing_threshold=0.5,
                        cohort1="Control",
                        cohort2="Disease",
                        log_fn=lambda _: None,
                    )

            wrapper_path = output_dir / "_peaks_etl_invoke.R"
            self.assertTrue(wrapper_path.exists())
            content = wrapper_path.read_text()
            self.assertIn("peaks_DataLoader_Flexible", content)
            self.assertIn("missingValueThreshold = 0.5", content)
            self.assertIn("Control", content)
            self.assertIn("Disease", content)
            self.assertEqual(result["abundance_path"], output_dir / "PEAKS_Abundance_Matrix.csv")

            # Subprocess called with --vanilla and the wrapper script
            mock_run.assert_called_once()
            args = mock_run.call_args[0][0]
            self.assertEqual(args[0], "Rscript")
            self.assertIn("--vanilla", args)

    def test_raises_on_nonzero_exit(self):
        from services.pipeline import _run_peaks_etl_via_r

        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "01_input"
            input_file = Path(tmp) / "input.csv"
            input_file.write_text("Accession,Peptide,Area S1\n")

            mock_result = MagicMock()
            mock_result.returncode = 1
            mock_result.stdout = ""
            mock_result.stderr = "Error: bad input\n"

            with patch("services.pipeline.shutil.which", return_value="/usr/bin/Rscript"):
                with patch("services.pipeline.subprocess.run", return_value=mock_result):
                    with self.assertRaises(RuntimeError):
                        _run_peaks_etl_via_r(
                            input_file,
                            output_dir,
                            missing_threshold=0.5,
                            cohort1="Control",
                            cohort2="Disease",
                            log_fn=lambda _: None,
                        )


class RunPeaksEtlViaR_RealRTests(unittest.TestCase):
    """Skipped unless Rscript is on PATH AND the Sweden raw file exists."""

    SWEDEN_FILE = Path("/Users/anirudhs/Documents/ClientServices/Eisai/data/sweden-cohort-raw/PeaksPeptide List Sweden Cohort.csv")

    def test_real_etl_produces_18135_features(self):
        if not shutil.which("Rscript"):
            self.skipTest("Rscript not on PATH")
        if not self.SWEDEN_FILE.exists():
            self.skipTest(f"Sweden raw file not present at {self.SWEDEN_FILE}")

        from services.pipeline import _run_peaks_etl_via_r
        import pandas as pd

        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "01_input"
            messages: list[str] = []
            result = _run_peaks_etl_via_r(
                self.SWEDEN_FILE,
                output_dir,
                missing_threshold=0.5,
                cohort1="Control",
                cohort2="AD",
                log_fn=messages.append,
            )

            abundance_path = result["abundance_path"]
            self.assertTrue(abundance_path.exists())
            df = pd.read_csv(abundance_path, index_col=0)
            # Reference: 18,135 features. Gate threshold: ≥17,228 (≥95%).
            self.assertGreaterEqual(len(df), 17228, f"Got {len(df)} features, need ≥17228")
            # PTM annotations preserved in the index
            ptm_count = sum(1 for fid in df.index if "(+" in str(fid))
            self.assertGreater(ptm_count, 100, "Expected PTM annotations in feature IDs")


if __name__ == "__main__":
    unittest.main()
