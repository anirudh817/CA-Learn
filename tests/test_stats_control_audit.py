import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


class StatsControlAuditTests(unittest.TestCase):
    def test_audit_records_requested_and_effective_controls(self):
        from services.pipeline import _write_stats_control_audit

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            (run_dir / "stage1").mkdir()
            (run_dir / "stage2").mkdir()
            (run_dir / "stage3").mkdir()
            (run_dir / "stage1" / "analysis_summary.json").write_text(
                json.dumps(
                    {
                        "normalization_method": "median",
                        "statistical_test": "wilcoxon",
                        "multiple_testing_method": "bonferroni",
                        "selected_wgcna_power": 6,
                        "wgcna_power_mode": "auto_pick",
                        "wgcna_tom_type": "unsigned",
                        "wgcna_pam_stage": False,
                    }
                ),
                encoding="utf-8",
            )
            (run_dir / "stage2" / "go_summary.json").write_text(
                json.dumps({"background_mode": "gmt_universe", "redundancy_mode": "kappa"}),
                encoding="utf-8",
            )
            (run_dir / "stage3" / "celltype_summary.json").write_text(
                json.dumps(
                    {
                        "reference": "custom",
                        "duplicate_handling": "collapse",
                        "adjust_fet_lookup_requested": True,
                        "adjust_fet_lookup_effective": False,
                        "warnings": ["No cross-species lookup was applied; adjust_fet_lookup was recorded as not applicable."],
                    }
                ),
                encoding="utf-8",
            )

            audit = _write_stats_control_audit(
                "run-1",
                run_dir,
                {
                    "normalization_method": "tin",
                    "statistical_test": "wilcoxon",
                    "multiple_testing_method": "bonferroni",
                    "wgcna_power": 8,
                    "wgcna_power_mode": "auto_pick",
                    "tom_type": "unsigned",
                    "pam_stage": False,
                    "gmt_background_behavior": "gmt_universe",
                    "remove_redundant_go": "kappa",
                    "celltype_reference": "custom",
                    "celltype_duplicate_handling": "collapse",
                    "adjust_fet_lookup": True,
                },
            )

            controls = {entry["key"]: entry for entry in audit["controls"]}
            self.assertEqual(controls["normalization_method"]["status"], "overridden")
            self.assertEqual(controls["normalization_method"]["requested"], "tin")
            self.assertEqual(controls["normalization_method"]["effective"], "median")
            self.assertEqual(controls["wgcna_power"]["effective"], 6)
            self.assertEqual(controls["adjust_fet_lookup"]["status"], "not_applicable")
            self.assertTrue((run_dir / "stats_control_audit.json").exists())


if __name__ == "__main__":
    unittest.main()
