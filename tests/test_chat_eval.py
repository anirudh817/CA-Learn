"""Framework tests for the P3 eval harness.

These verify the *plumbing* of the eval system — dataset loading, score
computation, end-to-end runner against a mocked provider. They run in CI
without Anthropic credentials.

The actual semantic quality of the chat is measured by running the CLI
against the real provider with a real key; see the bootstrap dataset's
notes for which cases are expected to fail at P0–P2 levels (they will, by
design — that's how P4 progress will be measured).
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
import warnings
from pathlib import Path

from tests.test_app import BACKEND_DIR, build_app

warnings.simplefilter("ignore", DeprecationWarning)
warnings.simplefilter("ignore", ResourceWarning)


def _ensure_backend_on_path() -> None:
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))


# Force backend import path before importing eval modules (build_app sets env).
with tempfile.TemporaryDirectory() as _td:
    build_app(_td)
_ensure_backend_on_path()


from services.ai.eval.dataset import (  # noqa: E402
    EvalCase,
    EvalDataset,
    datasets_dir,
    load_dataset,
)
from services.ai.eval.judges import (  # noqa: E402
    citation_correctness,
    forbidden_hits,
    keyword_recall,
)
from services.ai.eval.runner import run_case, run_suite  # noqa: E402


# ---------- Fake provider ----------

class FakeProvider:
    """Records every prompt it gets, returns a canned answer per case ID."""

    name = "anthropic"

    def __init__(self, answers: dict[str, str]):
        self.answers = answers
        self.calls: list[dict] = []

    def list_models(self):
        return []

    async def complete(self, *, model, system, messages, tools=None, max_output_tokens=2000):
        # Find the user question in the messages so we can decide which canned
        # answer to return.
        user_text = ""
        for m in messages:
            if m["role"] == "user":
                for p in m["content"]:
                    if p.get("type") == "text":
                        user_text += p["text"] + "\n"
        # Match the canned answer keyed by a substring of the question.
        chosen_answer = "Default canned answer."
        for key, ans in self.answers.items():
            if key in user_text:
                chosen_answer = ans
                break
        self.calls.append({"model": model, "system": system, "user_text": user_text})
        return {
            "text": chosen_answer,
            "tool_calls": [],
            "usage": {"input_tokens": 50, "output_tokens": 20},
            "finish_reason": "end_turn",
        }

    async def stream(self, **kwargs):  # pragma: no cover - unused in eval
        if False:
            yield {}


# ---------- Tests ----------

class EvalDatasetTests(unittest.TestCase):
    def test_bootstrap_dataset_loads_and_validates(self):
        path = datasets_dir() / "bootstrap.json"
        ds = load_dataset(path)
        self.assertEqual(ds.name, "bootstrap")
        self.assertGreaterEqual(len(ds), 5)
        # Every case has a recognised category.
        from services.ai.eval.dataset import CATEGORY

        for c in ds.cases:
            self.assertIn(c.category, CATEGORY)
            self.assertTrue(c.question.strip())
            self.assertTrue(c.run_id.startswith("RUN-"))
        # At least one anti-hallucination case present (regression gate).
        self.assertTrue(any(c.category == "anti_hallucination" for c in ds.cases))

    def test_dataset_filter_by_id_and_tag(self):
        cases = [
            EvalCase(id="a", question="q?", run_id="RUN-x", category="summary", tags=["foo"]),
            EvalCase(id="b", question="q?", run_id="RUN-x", category="summary", tags=["bar"]),
            EvalCase(id="c", question="q?", run_id="RUN-x", category="summary", tags=["foo", "bar"]),
        ]
        ds = EvalDataset(name="t", description="", cases=cases)
        self.assertEqual([c.id for c in ds.filter(ids=["a", "c"]).cases], ["a", "c"])
        self.assertEqual([c.id for c in ds.filter(tags=["bar"]).cases], ["b", "c"])

    def test_invalid_category_raises(self):
        with self.assertRaises(ValueError):
            EvalCase(id="x", question="q?", run_id="RUN-x", category="nonsense")


class JudgesTests(unittest.TestCase):
    def test_keyword_recall_partial(self):
        out = keyword_recall("APOE is in module turquoise", ["APOE", "turquoise", "M3", "cyan"])
        self.assertEqual(out["score"], 0.5)
        self.assertEqual(set(out["hits"]), {"APOE", "turquoise"})
        self.assertEqual(set(out["misses"]), {"M3", "cyan"})

    def test_keyword_recall_case_insensitive(self):
        out = keyword_recall("apoe and Turquoise", ["APOE", "turquoise"])
        self.assertEqual(out["score"], 1.0)

    def test_forbidden_hits_detects(self):
        out = forbidden_hits("the file is not present in this run", ["not present"])
        self.assertEqual(out["count"], 1)
        self.assertEqual(out["hits"], ["not present"])

    def test_citation_correctness_substring_match(self):
        out = citation_correctness(
            cited_files=["stage1/volcano_results.tsv"],
            must_cite_files=["volcano_results.tsv"],
        )
        self.assertEqual(out["score"], 1.0)

    def test_citation_correctness_missing(self):
        out = citation_correctness(
            cited_files=["stage1/volcano_results.tsv"],
            must_cite_files=["stage2/go_enrichment_all.csv"],
        )
        self.assertEqual(out["score"], 0.0)
        self.assertEqual(out["missing"], ["stage2/go_enrichment_all.csv"])


class RunnerEndToEndTests(unittest.TestCase):
    def test_runner_scores_passing_and_failing_cases(self):
        # Two cases: one we expect to pass (canned answer hits all keywords),
        # one we expect to fail (canned answer contains a forbidden phrase).
        cases = [
            EvalCase(
                id="good",
                question="What is APOE's log2FC in this run?",
                run_id="RUN-FAKE-001",
                category="single_protein",
                expected_keywords=["APOE", "turquoise"],
                forbidden_substrings=["not present"],
                must_cite_files=[],
                min_keyword_recall=0.5,
            ),
            EvalCase(
                id="bad",
                question="List hub proteins in Module M3.",
                run_id="RUN-FAKE-001",
                category="module",
                expected_keywords=["hub", "M3"],
                forbidden_substrings=["not present", "no data"],
                must_cite_files=[],
                min_keyword_recall=0.5,
            ),
        ]
        ds = EvalDataset(name="mini", description="", cases=cases)
        provider = FakeProvider(answers={
            "APOE": "**APOE** sits in the turquoise module with multiple peptides.",
            "M3":   "Module M3 hubs are not present in this excerpt; no data attached.",
        })
        suite = asyncio.get_event_loop().run_until_complete(
            run_suite(ds, provider=provider, model="claude-sonnet-4-6")
        )
        self.assertEqual(suite.run_count, 2)
        self.assertEqual(suite.pass_count, 1)
        self.assertEqual(suite.fail_count, 1)
        good = next(c for c in suite.cases if c.case_id == "good")
        bad = next(c for c in suite.cases if c.case_id == "bad")
        self.assertTrue(good.passed)
        self.assertFalse(bad.passed)
        self.assertEqual(bad.forbidden_hit_count, 2)
        # Provider got called exactly twice with the right model.
        self.assertEqual(len(provider.calls), 2)
        for call in provider.calls:
            self.assertEqual(call["model"], "claude-sonnet-4-6")

    def test_runner_handles_provider_error_gracefully(self):
        cases = [
            EvalCase(
                id="err",
                question="anything",
                run_id="RUN-FAKE-001",
                category="summary",
                expected_keywords=["whatever"],
            )
        ]

        class ExplodingProvider(FakeProvider):
            async def complete(self, **kwargs):
                raise RuntimeError("simulated provider blowup")

        ds = EvalDataset(name="boom", description="", cases=cases)
        suite = asyncio.get_event_loop().run_until_complete(
            run_suite(ds, provider=ExplodingProvider(answers={}), model="claude-sonnet-4-6")
        )
        self.assertEqual(suite.error_count, 1)
        self.assertEqual(suite.pass_count, 0)
        self.assertIn("simulated provider blowup", suite.cases[0].error)


class RegressionCheckTests(unittest.TestCase):
    def test_regression_detected_when_score_drops(self):
        from services.ai.eval.runner import SuiteResult, regression_check

        current = SuiteResult(
            dataset_name="x", run_count=2, pass_count=1, fail_count=1, error_count=0,
            avg_keyword_recall=0.50, avg_citation_score=0.50,
            avg_faithfulness_score=None, total_forbidden_hits=0,
            total_input_tokens=0, total_output_tokens=0, elapsed_s=0.0, cases=[],
        )
        with tempfile.TemporaryDirectory() as td:
            baseline_path = Path(td) / "baseline.json"
            baseline_path.write_text(
                '{"avg_keyword_recall": 0.80, "avg_citation_score": 0.80, "pass_rate": 0.80}'
            )
            check = regression_check(current, baseline_path, tolerance=0.05)
            self.assertFalse(check["ok"])
            self.assertIn("keyword_recall", check["regressed_metrics"])

    def test_no_regression_within_tolerance(self):
        from services.ai.eval.runner import SuiteResult, regression_check

        current = SuiteResult(
            dataset_name="x", run_count=2, pass_count=2, fail_count=0, error_count=0,
            avg_keyword_recall=0.78, avg_citation_score=0.78,
            avg_faithfulness_score=None, total_forbidden_hits=0,
            total_input_tokens=0, total_output_tokens=0, elapsed_s=0.0, cases=[],
        )
        with tempfile.TemporaryDirectory() as td:
            baseline_path = Path(td) / "baseline.json"
            baseline_path.write_text(
                '{"avg_keyword_recall": 0.80, "avg_citation_score": 0.80, "pass_rate": 1.0}'
            )
            check = regression_check(current, baseline_path, tolerance=0.05)
            self.assertTrue(check["ok"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
