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
        ("P1", "GENE_A", "blue"),
        ("P2", "GENE_A", "blue"),
        ("P3", "GENE_B", "blue"),
        ("P4", "GENE_C", "grey"),
        ("P5", "GENE_C", "grey"),
    ]
    with (stage1 / "module_assignments.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["peptide_id", "gene", "module_color"])
        writer.writerows(rows)


def _write_markers(path: Path, first_header: str) -> None:
    path.write_text(f"{first_header},Other\nGENE_A,GENE_Z\nGENE_B,GENE_Y\n", encoding="utf-8")


def _write_precision_modules(run_dir: Path) -> None:
    stage1 = run_dir / "stage1"
    stage1.mkdir(parents=True, exist_ok=True)
    rows = [(f"P{i}", f"MARKER_{i}", "blue") for i in range(20)]
    rows.extend((f"G{i}", f"BG_{i}", "grey") for i in range(1000))
    with (stage1 / "module_assignments.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["peptide_id", "gene", "module_color"])
        writer.writerows(rows)


def _write_precision_markers(path: Path) -> None:
    genes = "\n".join(f"MARKER_{i}" for i in range(20))
    path.write_text(f"PreciseCell\n{genes}\n", encoding="utf-8")


class Stage3CelltypeControlTests(unittest.TestCase):
    def test_custom_marker_file_is_primary_reference(self):
        from services.pipeline_stage3 import run_stage3

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            _write_modules(run_dir)
            markers = run_dir / "custom_markers.csv"
            _write_markers(markers, "CustomAstro")

            run_stage3(
                {
                    "celltype_reference": "custom",
                    "celltype_markers_file": str(markers),
                    "celltype_duplicate_handling": "allow",
                },
                run_dir,
                lambda _line: None,
            )

            summary = json.loads((run_dir / "stage3" / "celltype_summary.json").read_text())
            self.assertEqual(summary["reference"], "custom")
            self.assertEqual(summary["marker_source"], str(markers))
            self.assertIn("CustomAstro", summary["cell_types"])

    def test_duplicate_handling_changes_universe_accounting(self):
        from services.pipeline_stage3 import run_stage3

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            _write_modules(run_dir)
            markers = run_dir / "markers.csv"
            _write_markers(markers, "CellA")

            run_stage3(
                {"celltype_markers_file": str(markers), "celltype_duplicate_handling": "allow"},
                run_dir,
                lambda _line: None,
            )
            allow_summary = json.loads((run_dir / "stage3" / "celltype_summary.json").read_text())

            run_stage3(
                {"celltype_markers_file": str(markers), "celltype_duplicate_handling": "collapse"},
                run_dir,
                lambda _line: None,
            )
            collapse_summary = json.loads((run_dir / "stage3" / "celltype_summary.json").read_text())

            self.assertEqual(allow_summary["duplicate_handling"], "allow")
            self.assertEqual(collapse_summary["duplicate_handling"], "collapse")
            self.assertEqual(allow_summary["reference"], "custom")
            self.assertEqual(collapse_summary["reference"], "custom")
            self.assertEqual(allow_summary["universe_size"], 5)
            self.assertGreater(allow_summary["universe_size"], collapse_summary["universe_size"])
            self.assertGreater(collapse_summary["dropped_duplicate_count"], 0)

    def test_lookup_efficiency_adjustment_is_not_silent_without_lookup(self):
        from services.pipeline_stage3 import run_stage3

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            _write_modules(run_dir)
            markers = run_dir / "markers.csv"
            _write_markers(markers, "CellA")

            run_stage3(
                {
                    "celltype_markers_file": str(markers),
                    "adjust_fet_lookup": True,
                    "celltype_species_mode": "human",
                },
                run_dir,
                lambda _line: None,
            )
            summary = json.loads((run_dir / "stage3" / "celltype_summary.json").read_text())
            self.assertFalse(summary["adjust_fet_lookup_effective"])
            self.assertIn("No cross-species lookup was applied", " ".join(summary["warnings"]))

    def test_empty_celltype_summary_still_records_applicability_controls(self):
        from services.pipeline_stage3 import run_stage3

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            markers = run_dir / "markers.csv"
            _write_markers(markers, "CellA")

            run_stage3(
                {
                    "celltype_markers_file": str(markers),
                    "celltype_duplicate_handling": "collapse",
                    "adjust_fet_lookup": True,
                },
                run_dir,
                lambda _line: None,
            )

            summary = json.loads((run_dir / "stage3" / "celltype_summary.json").read_text())
            self.assertEqual(summary["modules_analyzed"], 0)
            self.assertEqual(summary["reference"], "custom")
            self.assertEqual(summary["duplicate_handling"], "collapse")
            self.assertFalse(summary["adjust_fet_lookup_effective"])
            self.assertIn("Module assignments missing", summary["note"])

    def test_celltype_pvalues_are_not_rounded_to_zero(self):
        from services.pipeline_stage3 import run_stage3

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            _write_precision_modules(run_dir)
            markers = run_dir / "markers.csv"
            _write_precision_markers(markers)

            run_stage3(
                {"celltype_markers_file": str(markers), "celltype_duplicate_handling": "allow"},
                run_dir,
                lambda _line: None,
            )

            with (run_dir / "stage3" / "celltype_heatmap_data.csv").open(encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
            pvalue = float(rows[0]["pvalue"])
            self.assertGreater(pvalue, 0.0)
            self.assertLess(pvalue, 1e-8)


if __name__ == "__main__":
    unittest.main()
