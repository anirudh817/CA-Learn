import sys
import unittest
from pathlib import Path

from pydantic import ValidationError


ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


class PipelineParamsContractTests(unittest.TestCase):
    def test_rejects_unknown_statistical_test(self):
        from schemas import PipelineParams

        with self.assertRaises(ValidationError):
            PipelineParams(statistical_test="limma")

    def test_rejects_unknown_multiple_testing_method(self):
        from schemas import PipelineParams

        with self.assertRaises(ValidationError):
            PipelineParams(multiple_testing_method="holm")

    def test_rejects_invalid_numeric_bounds(self):
        from schemas import PipelineParams

        invalid_payloads = [
            {"missing_value_threshold": 1.2},
            {"pvalue_threshold": 0},
            {"fold_change_threshold": 0.9},
            {"wgcna_power": 0},
            {"deep_split": 5},
            {"merge_cut_height": 1.2},
            {"wgcna_auto_power_cutoff": 1.0},
            {"fdr_threshold": 0},
        ]
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                with self.assertRaises(ValidationError):
                    PipelineParams(**payload)

    def test_rejects_variance_correction_without_covariates(self):
        from schemas import PipelineParams

        with self.assertRaises(ValidationError):
            PipelineParams(variance_correction_enabled=True)

    def test_rejects_custom_celltype_reference_without_marker_file(self):
        from schemas import PipelineParams

        with self.assertRaises(ValidationError):
            PipelineParams(celltype_reference="custom")

    def test_rejects_empty_go_categories(self):
        from schemas import PipelineParams

        with self.assertRaises(ValidationError):
            PipelineParams(go_categories=[])

    def test_rejects_unsupported_outlier_mode(self):
        from schemas import PipelineParams

        with self.assertRaises(ValidationError):
            PipelineParams(outlier_mode="two_sided")


if __name__ == "__main__":
    unittest.main()
