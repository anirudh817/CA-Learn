import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STAGE1_R = ROOT / "backend" / "r_scripts" / "stage1_parity.R"


class Stage1StatsControlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = STAGE1_R.read_text(encoding="utf-8")

    def test_multiple_testing_method_is_used_for_adjusted_pvalues(self):
        self.assertIn("multiple_testing_method", self.script)
        self.assertRegex(self.script, r"p\.adjust\(pvalues,\s*method\s*=\s*p_adjust_method\)")
        self.assertIn('"bonferroni"', self.script)

    def test_wgcna_auto_power_mode_selects_effective_power_from_diagnostics(self):
        self.assertIn("wgcna_power_mode", self.script)
        self.assertIn("wgcna_auto_power_cutoff", self.script)
        self.assertRegex(self.script, r"selected_power\s*<-\s*auto_selected_power")

    def test_tom_type_and_pam_stage_are_passed_to_blockwise_modules(self):
        self.assertIn("wgcna_tom_type", self.script)
        self.assertIn("wgcna_pam_stage", self.script)
        self.assertRegex(self.script, r"TOMType\s*=\s*tom_type")
        self.assertRegex(self.script, r"pamStage\s*=\s*pam_stage")

    def test_stage1_summary_reports_effective_controls(self):
        required_summary_keys = [
            "multiple_testing_method",
            "wgcna_power_mode",
            "wgcna_auto_power_cutoff",
            "wgcna_tom_type",
            "wgcna_pam_stage",
        ]
        for key in required_summary_keys:
            with self.subTest(key=key):
                self.assertIn(key, self.script)


if __name__ == "__main__":
    unittest.main()
