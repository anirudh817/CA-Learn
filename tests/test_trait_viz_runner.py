"""Python-side contract tests for the trait_viz_runner.R invoker."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("INLINE_RUNS", "1")


class TraitVizRunnerScriptExistsTests(unittest.TestCase):
    def test_trait_viz_runner_r_file_exists(self):
        script = ROOT / "backend" / "r_scripts" / "trait_viz_runner.R"
        self.assertTrue(script.exists(), f"Expected {script} to exist")

    def test_runner_uses_labeledHeatmap_and_corPvalueStudent(self):
        """Sanity that the R viz code uses canonical WGCNA functions."""
        text = (ROOT / "backend" / "r_scripts" / "trait_viz_runner.R").read_text()
        self.assertIn("labeledHeatmap", text)
        self.assertIn("corPvalueStudent", text)
        self.assertIn("greenWhiteRed", text)
        self.assertIn("cor.test", text)


class TraitVizRscriptPathTests(unittest.TestCase):
    def test_returns_none_when_rscript_missing(self):
        from services.deliverables import _trait_viz_rscript_path

        with patch("services.deliverables.shutil.which", return_value=None):
            self.assertIsNone(_trait_viz_rscript_path())

    def test_returns_path_when_rscript_present_and_script_exists(self):
        from services.deliverables import _trait_viz_rscript_path

        with patch("services.deliverables.shutil.which", return_value="/usr/local/bin/Rscript"):
            result = _trait_viz_rscript_path()
            self.assertIsNotNone(result)
            self.assertTrue(str(result).endswith("trait_viz_runner.R"))


class RunTraitVizContractTests(unittest.TestCase):
    def test_raises_when_rscript_missing(self):
        from services.deliverables import _run_trait_viz_via_r

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp) / "RUN-X"
            (run_dir / "stage1").mkdir(parents=True)
            (run_dir / "05_network_CBN_median").mkdir(parents=True)
            profile = {"deliverable_prefix": "PEAKS", "normalization_tag": "CBN_median", "display_prefix": "Spec Pep"}
            buckets = {"total_tau": ["T_TAU_raw"]}

            with patch("services.deliverables.shutil.which", return_value=None):
                with self.assertRaises(RuntimeError):
                    _run_trait_viz_via_r(run_dir, profile, buckets, ["T_TAU_raw"], lambda msg: None)

    def test_writes_config_json(self):
        from services.deliverables import _run_trait_viz_via_r

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp) / "RUN-X"
            (run_dir / "stage1").mkdir(parents=True)
            (run_dir / "05_network_CBN_median").mkdir(parents=True)
            profile = {"deliverable_prefix": "PEAKS", "normalization_tag": "CBN_median", "display_prefix": "Spec Pep"}
            buckets = {"total_tau": ["T_TAU_raw"]}

            mock_result = MagicMock()
            mock_result.returncode = 0
            mock_result.stdout = "[trait_viz] complete\n"
            mock_result.stderr = ""
            with patch("services.deliverables.shutil.which", return_value="/usr/bin/Rscript"):
                with patch("services.deliverables.subprocess.run", return_value=mock_result):
                    _run_trait_viz_via_r(run_dir, profile, buckets, ["T_TAU_raw"], lambda msg: None)

            config_path = run_dir / "stage1" / "trait_viz_config.json"
            self.assertTrue(config_path.exists())
            cfg = json.loads(config_path.read_text())
            self.assertEqual(cfg["prefix"], "PEAKS")
            self.assertEqual(cfg["trait_buckets"], buckets)
            self.assertEqual(cfg["all_traits"], ["T_TAU_raw"])

    def test_raises_on_nonzero_exit(self):
        from services.deliverables import _run_trait_viz_via_r

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp) / "RUN-X"
            (run_dir / "stage1").mkdir(parents=True)
            (run_dir / "05_network_CBN_median").mkdir(parents=True)
            profile = {"deliverable_prefix": "PEAKS", "normalization_tag": "CBN_median"}

            mock_result = MagicMock()
            mock_result.returncode = 3
            mock_result.stdout = ""
            mock_result.stderr = "ERROR: missing R packages\n"
            with patch("services.deliverables.shutil.which", return_value="/usr/bin/Rscript"):
                with patch("services.deliverables.subprocess.run", return_value=mock_result):
                    with self.assertRaises(RuntimeError):
                        _run_trait_viz_via_r(run_dir, profile, {"total_tau": ["T_TAU"]}, ["T_TAU"], lambda msg: None)


if __name__ == "__main__":
    unittest.main()
