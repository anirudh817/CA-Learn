import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


def _write_modules(run_dir: Path) -> None:
    stage1 = run_dir / "stage1"
    stage1.mkdir(parents=True, exist_ok=True)
    rows = [
        ("GENE_A", "blue"),
        ("GENE_B", "blue"),
        ("GENE_C", "blue"),
        ("GENE_X", "blue"),
        ("GENE_D", "grey"),
    ]
    with (stage1 / "module_assignments.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["gene", "module_color"])
        writer.writerows(rows)


def _write_modules_for_kappa(run_dir: Path) -> None:
    stage1 = run_dir / "stage1"
    stage1.mkdir(parents=True, exist_ok=True)
    rows = [(f"GENE_{i}", "blue") for i in range(4)]
    rows.extend((f"BG_{i}", "grey") for i in range(60))
    with (stage1 / "module_assignments.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["gene", "module_color"])
        writer.writerows(rows)


def _write_gmt(path: Path) -> None:
    path.write_text(
        "\n".join(
            [
                "TERM_ALPHA%GOBP%GOBP\tna\tGENE_A\tGENE_B\tGENE_C\tGENE_D\tGENE_E\tGENE_F",
                "TERM_ALPHA_COPY%GOBP%GOBP\tna\tGENE_A\tGENE_B\tGENE_C\tGENE_D\tGENE_E\tGENE_F",
                "TERM_BETA%GOMF%GOMF\tna\tGENE_Z\tGENE_Y\tGENE_Q",
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def _write_kappa_gmt(path: Path) -> None:
    path.write_text(
        "\n".join(
            [
                "TERM_ALPHA%GOBP%GOBP\tna\tGENE_0\tGENE_1\tGENE_2\tGENE_3",
                "TERM_ALPHA_COPY%GOBP%GOBP\tna\tGENE_0\tGENE_1\tGENE_2\tGENE_3",
                "TERM_BETA%GOBP%GOBP\tna\tBG_0\tBG_1\tBG_2\tBG_3",
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def _write_modules_for_depletion(run_dir: Path) -> None:
    stage1 = run_dir / "stage1"
    stage1.mkdir(parents=True, exist_ok=True)
    rows = [
        ("GENE_A", "blue"),
        ("GENE_A", "blue"),
        ("GENE_B", "blue"),
        ("GENE_C", "red"),
        ("GENE_D", "red"),
    ]
    with (stage1 / "module_assignments.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["gene", "module_color"])
        writer.writerows(rows)


class Stage2GoControlTests(unittest.TestCase):
    def test_background_mode_changes_universe_size_and_is_summarized(self):
        from services.pipeline_stage2 import run_stage2

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            _write_modules(run_dir)
            gmt = run_dir / "terms.gmt"
            _write_gmt(gmt)

            run_stage2(
                {
                    "gmt_file": str(gmt),
                    "go_categories": ["BP", "MF"],
                    "min_hits_per_ontology": 1,
                    "gmt_background_behavior": "measured_features",
                },
                run_dir,
                lambda _line: None,
            )
            measured_summary = json.loads((run_dir / "stage2" / "go_summary.json").read_text())

            run_stage2(
                {
                    "gmt_file": str(gmt),
                    "go_categories": ["BP", "MF"],
                    "min_hits_per_ontology": 1,
                    "gmt_background_behavior": "gmt_universe",
                },
                run_dir,
                lambda _line: None,
            )
            gmt_summary = json.loads((run_dir / "stage2" / "go_summary.json").read_text())

            self.assertEqual(measured_summary["background_mode"], "measured_features")
            self.assertEqual(gmt_summary["background_mode"], "gmt_universe")
            self.assertNotEqual(measured_summary["universe_size"], gmt_summary["universe_size"])
            self.assertGreater(gmt_summary["gmt_universe_gene_count"], measured_summary["measured_gene_count"])

    def test_kappa_redundancy_writes_pruned_derived_outputs(self):
        from services.pipeline_stage2 import run_stage2

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            _write_modules_for_kappa(run_dir)
            gmt = run_dir / "terms.gmt"
            _write_kappa_gmt(gmt)

            run_stage2(
                {
                    "gmt_file": str(gmt),
                    "go_categories": ["BP"],
                    "min_hits_per_ontology": 1,
                    "remove_redundant_go": "kappa",
                },
                run_dir,
                lambda _line: None,
            )

            pruned = run_dir / "stage2" / "go_enrichment_redundancy_removed.csv"
            full = run_dir / "stage2" / "go_enrichment_all.csv"
            self.assertTrue(pruned.exists())
            self.assertTrue(full.exists())
            with full.open(newline="", encoding="utf-8") as handle:
                full_terms = [row["term"] for row in csv.DictReader(handle)]
            with pruned.open(newline="", encoding="utf-8") as handle:
                pruned_terms = [row["term"] for row in csv.DictReader(handle)]
            redundant_terms = {"TERM ALPHA", "TERM ALPHA COPY"}
            self.assertTrue(redundant_terms.issubset(set(full_terms)))
            self.assertEqual(len(redundant_terms & set(pruned_terms)), 1)
            self.assertNotIn("TERM BETA", set(pruned_terms))

    def test_empty_go_result_still_records_effective_controls(self):
        from services.pipeline_stage2 import run_stage2

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            _write_modules(run_dir)
            gmt = run_dir / "terms.gmt"
            _write_gmt(gmt)

            run_stage2(
                {
                    "gmt_file": str(gmt),
                    "go_categories": ["BP"],
                    "min_hits_per_ontology": 99,
                    "gmt_background_behavior": "gmt_universe",
                    "remove_redundant_go": "none",
                },
                run_dir,
                lambda _line: None,
            )

            stage2 = run_dir / "stage2"
            summary = json.loads((stage2 / "go_summary.json").read_text())
            self.assertEqual(summary["significant_terms"], 0)
            self.assertEqual(summary["background_mode"], "gmt_universe")
            self.assertEqual(summary["redundancy_mode"], "none")
            self.assertEqual(summary["min_hits_per_ontology"], 99)
            self.assertTrue((stage2 / "go_pvalues_matrix.csv").exists())
            self.assertFalse((stage2 / "go_enrichment_redundancy_removed.csv").exists())

    def test_full_go_matrix_keeps_depletion_rows_below_overlap_threshold(self):
        from services.pipeline_stage2 import run_stage2

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            _write_modules_for_depletion(run_dir)
            gmt = run_dir / "terms.gmt"
            gmt.write_text("TERM_RED%GOBP%GOBP\tna\tGENE_C\tGENE_D\n", encoding="utf-8")

            run_stage2(
                {
                    "gmt_file": str(gmt),
                    "go_categories": ["BP"],
                    "min_hits_per_ontology": 2,
                    "remove_redundant_go": "none",
                },
                run_dir,
                lambda _line: None,
            )

            with (run_dir / "stage2" / "go_enrichment_all.csv").open(encoding="utf-8") as handle:
                full = list(csv.DictReader(handle))
            by_module = {(row["module"], row["term"]): row for row in full}
            self.assertIn(("blue", "TERM RED"), by_module)
            self.assertIn(("red", "TERM RED"), by_module)
            self.assertEqual(int(by_module[("blue", "TERM RED")]["hits"]), 0)
            self.assertLess(float(by_module[("blue", "TERM RED")]["zscore"]), 0)

            summary = json.loads((run_dir / "stage2" / "go_summary.json").read_text())
            self.assertEqual(summary["universe_size"], 4)
            self.assertEqual(summary["measured_gene_count"], 4)
            self.assertEqual(summary["measured_feature_count"], 5)


if __name__ == "__main__":
    unittest.main()
