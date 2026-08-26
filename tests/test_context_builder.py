"""Real-context integration tests for the chat context builder.

These tests run the actual context builder against a real on-disk run
directory (no provider mocking, no shortcuts). They are the regression
gate for the class of bug where a missing optional dependency or a
broken file render silently produces an "[error]"-style string that
gets injected into the model's prompt.

Failure mode the original bug exhibited:
    pandas.DataFrame.to_markdown() requires `tabulate`. Without it,
    to_markdown() raises ImportError. Our context-builder caught the
    exception and put the literal error message into the prompt. The
    model then faithfully reported "the file is unreadable, install
    tabulate" — which is technically what it was told but completely
    useless to the user.

These tests assert that the assembled context contains the actual data
(a known protein symbol, a numeric column header) — NOT just the
filename or an apologetic error sentence.
"""
from __future__ import annotations

import sys
import tempfile
import unittest
import warnings
from pathlib import Path

from tests.test_app import BACKEND_DIR, build_app  # ensures sys.path + env

warnings.simplefilter("ignore", DeprecationWarning)
warnings.simplefilter("ignore", ResourceWarning)


def _ensure_backend_on_path() -> None:
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))


def _write_synthetic_run(data_dir: Path, run_id: str) -> Path:
    run_dir = data_dir / "runs" / run_id
    (run_dir / "stage1").mkdir(parents=True, exist_ok=True)
    (run_dir / "run_manifest.json").write_text(
        '{"format_family":"Generic","input_level":"protein",'
        '"sample_count":6,"feature_count":3}'
    )
    (run_dir / "stage1" / "volcano_results.tsv").write_text(
        "gene\tlog2fc\tadj_pvalue\tdirection\tmodule\n"
        "APOE\t3.41\t0.00012\tupregulated\tM1\n"
        "CLU\t2.83\t0.00089\tupregulated\tM1\n"
        "C3\t-1.92\t0.0021\tdownregulated\tM2\n"
    )
    return run_dir


class ContextBuilderRunSnapshotTests(unittest.TestCase):
    def test_minimal_run_context_includes_real_data(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            # Build the app so DATA_DIR env points at our temp tree.
            build_app(temp_dir)
            _ensure_backend_on_path()
            from services.ai.context_builder import minimal_run_context

            _write_synthetic_run(Path(temp_dir) / "data", "RUN-CTX-001")
            ctx = minimal_run_context("RUN-CTX-001")

            # Manifest highlights present.
            self.assertIn("Format family: Generic", ctx)
            self.assertIn("Sample count: 6", ctx)
            # Actual volcano data made it into the prompt — symbols + numbers.
            self.assertIn("APOE", ctx)
            self.assertIn("CLU", ctx)
            self.assertIn("3.41", ctx)
            self.assertIn("upregulated", ctx)
            # Markdown table rendered: header separator present.
            self.assertIn("---", ctx)
            # And critically: NO error sentences smuggled in.
            for bad in (
                "Could not read",
                "Missing optional dependency",
                "tabulate",
                "ImportError",
                "Exception",
                "Traceback",
            ):
                self.assertNotIn(
                    bad, ctx,
                    f"Context contains suspicious string {bad!r} — extractor likely silently swallowed an error.",
                )

    def test_dataframe_to_markdown_has_no_optional_deps(self) -> None:
        """The hand-rolled renderer must work even with no `tabulate` on PATH."""
        _ensure_backend_on_path()
        from services.ai.context_builder import dataframe_to_markdown
        import pandas as pd

        df = pd.DataFrame(
            {"gene": ["APOE", "CLU"], "log2fc": [3.41, 2.83], "module": ["M1", "M1"]}
        )
        md = dataframe_to_markdown(df)
        self.assertIn("APOE", md)
        self.assertIn("3.41", md)
        self.assertIn("module", md)
        # Markdown shape:
        lines = md.splitlines()
        self.assertGreaterEqual(len(lines), 4)  # header + sep + 2 rows
        self.assertTrue(lines[0].startswith("|"))
        self.assertTrue(lines[1].startswith("|") and "-" in lines[1])

    def test_corrupt_attachment_json_does_not_500(self) -> None:
        """A message row with malformed citations_json should still serialize."""
        _ensure_backend_on_path()
        from routes.conversations import _safe_json_array

        self.assertEqual(_safe_json_array(None), [])
        self.assertEqual(_safe_json_array(""), [])
        self.assertEqual(_safe_json_array("[]"), [])
        self.assertEqual(_safe_json_array('[{"a":1}]'), [{"a": 1}])
        self.assertEqual(_safe_json_array("not json at all"), [])
        self.assertEqual(_safe_json_array('{"oops":true}'), [])  # not an array → []


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
