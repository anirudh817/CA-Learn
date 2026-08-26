"""Standalone profile/skill fixtures that the future Pi sidecar must execute."""
from __future__ import annotations

import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MATRIX_PATH = ROOT / "tests" / "contracts" / "pi_runtime_fixture_matrix.json"


def _run(script: Path, *args: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(script), *(str(arg) for arg in args)],
        capture_output=True,
        check=False,
        text=True,
        timeout=5,
    )


class PiRuntimeFixtureContractTests(unittest.TestCase):
    def test_matrix_has_three_profiles_and_four_scripted_skills(self) -> None:
        matrix = json.loads(MATRIX_PATH.read_text(encoding="utf-8"))
        self.assertEqual(matrix["case_count"], 7)
        self.assertEqual(len(matrix["cases"]), 7)
        self.assertEqual(
            sum(case["kind"] == "profile" for case in matrix["cases"]), 3
        )
        self.assertEqual(
            sum(case["kind"] == "skill" for case in matrix["cases"]), 4
        )
        for case in matrix["cases"]:
            self.assertTrue((ROOT / case["asset"]).is_file(), case["id"])
            self.assertTrue(case["automation"].strip(), case["id"])
            self.assertTrue(case["manual_prompt"].strip(), case["id"])
            if case["kind"] == "skill":
                self.assertTrue((ROOT / case["script"]).is_file(), case["id"])

    def test_profiles_encode_evidence_boundaries(self) -> None:
        profile_dir = ROOT / "tests" / "fixtures" / "pi_runtime" / "profiles"
        for path in sorted(profile_dir.glob("*.md")):
            text = path.read_text(encoding="utf-8").lower()
            with self.subTest(profile=path.name):
                self.assertIn("inspired_by:", text)
                self.assertIn("cite", text)
                self.assertTrue("missing" in text or "absent" in text)

    def test_table_summary_script(self) -> None:
        script = ROOT / "tests/fixtures/pi_runtime/skills/table-summary/scripts/summarize_table.py"
        with tempfile.TemporaryDirectory() as tmp:
            source, output = Path(tmp) / "input.csv", Path(tmp) / "summary.json"
            with source.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.writer(handle)
                writer.writerows((("gene", "score"), ("APOE", 2), ("CLU", 4)))
            result = _run(script, source, output)
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(payload["row_count"], 2)
            self.assertEqual(payload["numeric"]["score"]["mean"], 3.0)

    def test_svg_scatter_script(self) -> None:
        script = ROOT / "tests/fixtures/pi_runtime/skills/svg-scatter-preview/scripts/render_scatter.py"
        with tempfile.TemporaryDirectory() as tmp:
            source, output = Path(tmp) / "input.csv", Path(tmp) / "plot.svg"
            source.write_text("x,y\n1,2\n2,4\ninvalid,5\n", encoding="utf-8")
            result = _run(script, source, output, "--x", "x", "--y", "y")
            self.assertEqual(result.returncode, 0, result.stderr)
            svg = output.read_text(encoding="utf-8")
            self.assertEqual(svg.count("<circle "), 2)
            self.assertIn(">x</text>", svg)

    def test_run_manifest_script_is_stable_and_excludes_ai_outputs(self) -> None:
        script = ROOT / "tests/fixtures/pi_runtime/skills/run-manifest/scripts/build_manifest.py"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "run"
            (root / "stage1").mkdir(parents=True)
            (root / "stage1" / "result.tsv").write_text("a\tb\n1\t2\n")
            (root / "ai_insights" / "artifacts").mkdir(parents=True)
            (root / "ai_insights" / "artifacts" / "generated.txt").write_text("skip")
            output = Path(tmp) / "manifest.json"
            result = _run(script, root, output)
            self.assertEqual(result.returncode, 0, result.stderr)
            files = json.loads(output.read_text(encoding="utf-8"))["files"]
            self.assertEqual([item["path"] for item in files], ["stage1/result.tsv"])
            self.assertEqual(len(files[0]["sha256"]), 64)

    def test_runtime_probe_success_failure_and_environment_contract(self) -> None:
        script = ROOT / "tests/fixtures/pi_runtime/skills/runtime-probe/scripts/runtime_probe.py"
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "probe.json"
            success = _run(script, "success", output)
            self.assertEqual(success.returncode, 0, success.stderr)
            self.assertTrue(json.loads(output.read_text(encoding="utf-8"))["ok"])
            failure = _run(script, "fail", output)
            self.assertEqual(failure.returncode, 23)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
