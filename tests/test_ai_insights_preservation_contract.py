"""Executable index of the AI Insights behavior that a backend revamp must keep.

The detailed behavior lives in the referenced integration/unit tests.  This
module makes the preservation checklist machine-checkable: every capability
must have unique acceptance criteria and point to real unittest methods, while
the current frontend shell remains covered until its replacement is approved.
"""
from __future__ import annotations

import importlib
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / "tests" / "contracts" / "ai_insights_preservation.json"
PLAN_PATH = (
    ROOT / "docs" / "explanations" / "features" / "ai-insights-revamp-plan.html"
)


def _load_contract() -> dict:
    return json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


class AIInsightsPreservationContractTests(unittest.TestCase):
    def test_checklist_is_complete_and_has_unique_stable_ids(self) -> None:
        contract = _load_contract()
        self.assertEqual(
            contract["source_of_truth"],
            "docs/explanations/features/ai-tab.html",
        )
        capabilities = contract["capabilities"]
        self.assertGreaterEqual(len(capabilities), 16)
        ids = [item["id"] for item in capabilities]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(all(item["capability"].strip() for item in capabilities))
        self.assertTrue(all(item["acceptance"].strip() for item in capabilities))
        self.assertTrue(all(item["evidence"] for item in capabilities))

    def test_target_is_one_pi_sidecar_with_layered_preservation(self) -> None:
        contract = _load_contract()
        architecture = contract["target_architecture"]
        self.assertEqual(architecture["runtime"], "single_pi_sidecar")
        self.assertEqual(
            architecture["mode_semantics"],
            "policy_profiles_on_the_same_pi_runtime",
        )
        self.assertEqual(
            architecture["implemented_standard_policy"],
            "adaptive_server_side_grounding_with_no_pi_skills_or_coding_tools",
        )
        self.assertEqual(architecture["model_selection"], "center_rail_per_turn")

        ids = {item["id"] for item in contract["capabilities"]}
        layered_ids = [
            capability_id
            for layer in contract["layers"].values()
            for capability_id in layer
        ]
        self.assertEqual(set(layered_ids), ids)
        self.assertEqual(len(layered_ids), len(set(layered_ids)))
        self.assertIn(
            "AI-PRES-014", contract["layers"]["foundational_infrastructure"]
        )

    def test_design_document_describes_one_runtime_not_parallel_engines(self) -> None:
        plan = PLAN_PATH.read_text(encoding="utf-8")
        for required in (
            "one Pi sidecar runtime",
            "Standard and Deep Research are policy profiles, not engines or backend paths.",
            "center-rail model/policy/source controls",
            "AI-PRES-014",
            "seven standalone fixtures",
        ):
            self.assertIn(required, plan)
        for stale_parallel_engine_name in (
            "StandardInsightsEngine",
            "AIInsightsService",
            "PiRuntimeClient",
        ):
            self.assertNotIn(stale_parallel_engine_name, plan)

    def test_every_checklist_item_points_to_real_executable_tests(self) -> None:
        for capability in _load_contract()["capabilities"]:
            with self.subTest(capability=capability["id"]):
                for test_id in capability["evidence"]:
                    module_name, class_name, method_name = test_id.rsplit(".", 2)
                    module = importlib.import_module(module_name)
                    test_class = getattr(module, class_name)
                    self.assertTrue(
                        issubclass(test_class, unittest.TestCase),
                        f"{test_id} does not resolve to a unittest.TestCase",
                    )
                    self.assertTrue(
                        callable(getattr(test_class, method_name, None)),
                        f"Missing executable preservation evidence: {test_id}",
                    )

    def test_frontend_cuts_over_to_the_single_sidecar_launcher(self) -> None:
        html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
        app_js = (ROOT / "frontend" / "app.js").read_text(encoding="utf-8")
        sidecar_app = (ROOT / "ai-sidecar" / "public" / "app.js").read_text(
            encoding="utf-8"
        )
        for element_id in ("aiInsightsLauncher", "openAIInsightsBtn"):
            self.assertIn(f'id="{element_id}"', html, element_id)
        for legacy_id in (
            "chatShell",
            "convListItems",
            "convThreadBody",
            "aiSettingsDrawer",
        ):
            self.assertNotIn(f'id="{legacy_id}"', html, legacy_id)
        for behavior in (
            "openAIInsights",
            "SIGNALFOLD_AI_INSIGHTS_URL",
        ):
            self.assertIn(behavior, app_js, behavior)
        for behavior in ("AIInsightsApp", "mount(root", "selectRun", "feedback"):
            self.assertIn(behavior, sidecar_app, behavior)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
