"""P10/P11 integration tests — persistent pins, cross-run refs, Discovery mode."""
from __future__ import annotations

import sys
import tempfile
import unittest
import warnings
from pathlib import Path
from unittest import mock

from tests.test_app import (
    BACKEND_DIR,
    bootstrap_session,
    build_app,
    dataset_bytes,
    managed_client,
    upload_primary_dataset,
)

warnings.simplefilter("ignore", DeprecationWarning)
warnings.simplefilter("ignore", ResourceWarning)


def _ensure_backend_on_path() -> None:
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))


class _Capture:
    last_messages = None
    calls = 0


def _patch_capture():
    _ensure_backend_on_path()
    from services.ai.providers import anthropic_provider as ap

    def _no_op_init(self, api_key: str) -> None:
        self._sync_client = None
        self._async_client = None

    async def _complete(self, **kwargs):
        _Capture.calls += 1
        _Capture.last_messages = kwargs.get("messages")
        return {
            "text": "ok",
            "tool_calls": [],
            "usage": {"input_tokens": 1, "output_tokens": 1},
            "finish_reason": "end_turn",
        }

    return [
        mock.patch("config.AI_SECURITY_LLM_JUDGE", False),
        mock.patch.object(ap.AnthropicProvider, "__init__", _no_op_init),
        mock.patch.object(ap.AnthropicProvider, "complete", _complete),
    ]


def _write_run(run_id: str, *, apoe_value: str = "3.41") -> None:
    _ensure_backend_on_path()
    from config import RUNS_DIR

    run_dir = Path(RUNS_DIR) / run_id
    (run_dir / "stage1").mkdir(parents=True, exist_ok=True)
    (run_dir / "stage2").mkdir(parents=True, exist_ok=True)
    (run_dir / "stage3").mkdir(parents=True, exist_ok=True)
    (run_dir / "run_manifest.json").write_text(
        '{"format_family":"Generic","input_level":"protein",'
        '"sample_count":12,"feature_count":4,"comparison":"AD vs Control"}'
    )
    (run_dir / "stage1" / "volcano_results.tsv").write_text(
        "gene\tlog2fc\tadj_pvalue\tdirection\tmodule\n"
        f"APOE\t{apoe_value}\t0.00012\tup\tturquoise\n"
        "CLU\t2.83\t0.00089\tup\tturquoise\n"
        "GFAP\t1.21\t0.0021\tup\tblue\n"
        "C3\t-1.92\t0.004\tdown\tgreen\n"
    )
    (run_dir / "stage2" / "go_enrichment_all.csv").write_text(
        "module,term,category,pvalue,fdr,zscore,hits,hit_genes\n"
        "turquoise,synaptic signaling,BP,1e-6,1e-5,4,5,APOE;CLU\n"
        "blue,gliogenesis,BP,1e-4,1e-3,3,3,GFAP\n"
    )
    (run_dir / "stage3" / "celltype_heatmap_data.csv").write_text(
        "module,cell_type,pvalue,fdr\n"
        "turquoise,Neuron,1e-6,1e-5\n"
        "blue,Microglia,1e-5,1e-4\n"
    )
    (run_dir / "stage1" / "module_trait_correlations.csv").write_text(
        "module,trait,correlation,pvalue,adj_pvalue\n"
        "turquoise,amyloid_beta,0.72,0.001,0.01\n"
    )


def _add_run_row(client, headers, workspace, project, run_id: str, name: str) -> None:
    _ensure_backend_on_path()
    import database

    uploaded = upload_primary_dataset(
        client, headers, workspace["id"], project["id"], dataset_bytes()
    )
    db = database.SessionLocal()
    try:
        db.add(database.Run(
            id=run_id,
            workspace_id=workspace["id"],
            project_id=project["id"],
            created_by=db.query(database.User).first().id,
            name=name,
            file_id=uploaded["dataset_id"],
            file_name="cohort.csv",
            status=database.RunStatus.COMPLETE,
        ))
        db.commit()
    finally:
        db.close()


def _bootstrap_two_runs(client):
    _write_run("RUN-P10-A", apoe_value="3.41")
    _write_run("RUN-P10-B", apoe_value="-1.25")
    headers, workspace, project = bootstrap_session(client)
    _add_run_row(client, headers, workspace, project, "RUN-P10-A", "primary run")
    _add_run_row(client, headers, workspace, project, "RUN-P10-B", "comparison run")
    client.put(
        "/api/settings/ai",
        headers=headers,
        json={"anthropic_key": "sk-ant-fake-key-padding-padding-p10"},
    )
    conv = client.post(
        "/api/runs/RUN-P10-A/conversations", headers=headers, json={}
    ).json()
    return headers, conv["id"]


def _last_user_text() -> str:
    user_turn = _Capture.last_messages[-1]
    return "\n".join(p["text"] for p in user_turn["content"] if p["type"] == "text")


class PersistentPinTests(unittest.TestCase):
    def test_conversation_migration_columns_exist_and_corrupt_json_is_safe(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            with managed_client(app) as client:
                headers, conv_id = _bootstrap_two_runs(client)
                _ensure_backend_on_path()
                import database

                columns = {
                    c["name"]
                    for c in database.inspect(database.engine).get_columns("conversations")
                }
                self.assertIn("pinned_refs_json", columns)
                self.assertIn("discovery_mode", columns)

                db = database.SessionLocal()
                try:
                    conv = db.query(database.Conversation).filter_by(id=conv_id).first()
                    conv.pinned_refs_json = "not json"
                    db.add(conv)
                    db.commit()
                finally:
                    db.close()

                resp = client.get(f"/api/conversations/{conv_id}", headers=headers)
                self.assertEqual(resp.status_code, 200, resp.text)
                self.assertEqual(resp.json()["pinned_refs"], [])
                self.assertEqual(resp.json()["discovery_mode"], "auto")

    def test_context_panel_lists_same_workspace_runs(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            with managed_client(app) as client:
                headers, conv_id = _bootstrap_two_runs(client)
                resp = client.get(f"/api/conversations/{conv_id}/context-panel", headers=headers)
                self.assertEqual(resp.status_code, 200, resp.text)
                runs = resp.json()["workspace_runs"]
                labels = {r["label"] for r in runs}
                self.assertIn("primary run", labels)
                self.assertIn("comparison run", labels)

    def test_persistent_pin_survives_across_messages_and_can_be_removed(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_capture()
            for p in patches:
                p.__enter__()
            try:
                with managed_client(app) as client:
                    headers, conv_id = _bootstrap_two_runs(client)
                    patch = client.patch(
                        f"/api/conversations/{conv_id}",
                        headers=headers,
                        json={
                            "pinned_refs": [{
                                "kind": "run_artifact",
                                "rel_path": "stage1/volcano_results.tsv",
                                "label": "volcano_results.tsv",
                            }]
                        },
                    )
                    self.assertEqual(patch.status_code, 200, patch.text)
                    self.assertEqual(len(patch.json()["pinned_refs"]), 1)

                    sent1 = client.post(
                        f"/api/conversations/{conv_id}/messages",
                        headers=headers,
                        json={"content": "first message"},
                    )
                    self.assertEqual(sent1.status_code, 200, sent1.text)
                    self.assertIn("Pinned context", _last_user_text())
                    self.assertIn("APOE", _last_user_text())

                    sent2 = client.post(
                        f"/api/conversations/{conv_id}/messages",
                        headers=headers,
                        json={"content": "second message"},
                    )
                    self.assertEqual(sent2.status_code, 200, sent2.text)
                    self.assertIn("Pinned context", _last_user_text())

                    unpin = client.patch(
                        f"/api/conversations/{conv_id}",
                        headers=headers,
                        json={"pinned_refs": []},
                    )
                    self.assertEqual(unpin.status_code, 200, unpin.text)
                    sent3 = client.post(
                        f"/api/conversations/{conv_id}/messages",
                        headers=headers,
                        json={"content": "third message"},
                    )
                    self.assertEqual(sent3.status_code, 200, sent3.text)
                    self.assertNotIn("Pinned context", _last_user_text())
            finally:
                for p in reversed(patches):
                    p.__exit__(None, None, None)

    def test_cross_run_pin_loads_same_workspace_artifact(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_capture()
            for p in patches:
                p.__enter__()
            try:
                with managed_client(app) as client:
                    headers, conv_id = _bootstrap_two_runs(client)
                    sent = client.post(
                        f"/api/conversations/{conv_id}/messages",
                        headers=headers,
                        json={
                            "content": "compare the pinned run",
                            "pinned_refs": [{
                                "kind": "run_artifact",
                                "run_id": "RUN-P10-B",
                                "rel_path": "stage1/volcano_results.tsv",
                                "label": "comparison volcano",
                            }],
                        },
                    )
                    self.assertEqual(sent.status_code, 200, sent.text)
                    text = _last_user_text()
                    self.assertIn("RUN-P10-B", text)
                    self.assertIn("-1.25", text)
            finally:
                for p in reversed(patches):
                    p.__exit__(None, None, None)

    def test_cross_workspace_run_artifact_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            with managed_client(app) as client:
                headers, conv_id = _bootstrap_two_runs(client)
                _write_run("RUN-OTHER-WS", apoe_value="9.99")

                _ensure_backend_on_path()
                import database

                db = database.SessionLocal()
                try:
                    user = db.query(database.User).first()
                    other_ws = database.Workspace(
                        id="OTHER-WS",
                        name="Other workspace",
                        slug="other-workspace",
                        created_by=user.id,
                    )
                    other_project = database.Project(
                        id="OTHER-PROJ",
                        workspace_id=other_ws.id,
                        name="Other project",
                        slug="other-project",
                        created_by=user.id,
                    )
                    other_dataset = database.UploadedDataset(
                        id="OTHER-DATASET",
                        workspace_id=other_ws.id,
                        project_id=other_project.id,
                        user_id=user.id,
                        original_name="other.csv",
                        stored_path="/tmp/other.csv",
                        size_bytes=1,
                    )
                    other_run = database.Run(
                        id="RUN-OTHER-WS",
                        workspace_id=other_ws.id,
                        project_id=other_project.id,
                        created_by=user.id,
                        name="other workspace run",
                        file_id=other_dataset.id,
                        file_name="other.csv",
                        status=database.RunStatus.COMPLETE,
                    )
                    db.add_all([other_ws, other_project, other_dataset, other_run])
                    db.commit()
                finally:
                    db.close()

                resp = client.post(
                    f"/api/conversations/{conv_id}/messages",
                    headers=headers,
                    json={
                        "content": "try forbidden run",
                        "pinned_refs": [{
                            "kind": "run_artifact",
                            "run_id": "RUN-OTHER-WS",
                            "rel_path": "stage1/volcano_results.tsv",
                            "label": "other",
                        }],
                    },
                )
                self.assertEqual(resp.status_code, 403, resp.text)

    def test_pin_cap_is_enforced(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            with managed_client(app) as client:
                headers, conv_id = _bootstrap_two_runs(client)
                refs = [
                    {
                        "kind": "run_artifact",
                        "rel_path": f"stage1/file_{i}.csv",
                        "label": f"file {i}",
                    }
                    for i in range(11)
                ]
                resp = client.patch(
                    f"/api/conversations/{conv_id}",
                    headers=headers,
                    json={"pinned_refs": refs},
                )
                self.assertEqual(resp.status_code, 422, resp.text)


class DiscoveryModeTests(unittest.TestCase):
    def test_auto_discovery_adds_biological_landscape_for_interpretation_questions(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_capture()
            for p in patches:
                p.__enter__()
            try:
                with managed_client(app) as client:
                    headers, conv_id = _bootstrap_two_runs(client)
                    sent = client.post(
                        f"/api/conversations/{conv_id}/messages",
                        headers=headers,
                        json={"content": "What does this mean biologically for AD pathology?"},
                    )
                    self.assertEqual(sent.status_code, 200, sent.text)
                    text = _last_user_text()
                    self.assertIn("Biological landscape", text)
                    self.assertIn("synaptic signaling", text)
                    self.assertIn("Neuron", text)
                    self.assertIn("amyloid_beta", text)
            finally:
                for p in reversed(patches):
                    p.__exit__(None, None, None)

    def test_discovery_off_suppresses_landscape_for_interpretation_questions(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_capture()
            for p in patches:
                p.__enter__()
            try:
                with managed_client(app) as client:
                    headers, conv_id = _bootstrap_two_runs(client)
                    patch = client.patch(
                        f"/api/conversations/{conv_id}",
                        headers=headers,
                        json={"discovery_mode": "off"},
                    )
                    self.assertEqual(patch.status_code, 200, patch.text)
                    sent = client.post(
                        f"/api/conversations/{conv_id}/messages",
                        headers=headers,
                        json={"content": "What does this mean biologically for AD pathology?"},
                    )
                    self.assertEqual(sent.status_code, 200, sent.text)
                    self.assertNotIn("Biological landscape", _last_user_text())
            finally:
                for p in reversed(patches):
                    p.__exit__(None, None, None)

    def test_discovery_on_adds_landscape_for_simple_lookup(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_capture()
            for p in patches:
                p.__enter__()
            try:
                with managed_client(app) as client:
                    headers, conv_id = _bootstrap_two_runs(client)
                    patch = client.patch(
                        f"/api/conversations/{conv_id}",
                        headers=headers,
                        json={"discovery_mode": "on"},
                    )
                    self.assertEqual(patch.status_code, 200, patch.text)
                    sent = client.post(
                        f"/api/conversations/{conv_id}/messages",
                        headers=headers,
                        json={"content": "What is APOE log2FC?"},
                    )
                    self.assertEqual(sent.status_code, 200, sent.text)
                    self.assertIn("Biological landscape", _last_user_text())
            finally:
                for p in reversed(patches):
                    p.__exit__(None, None, None)


class FrontendRegressionTests(unittest.TestCase):
    def test_per_turn_mentions_preserve_cross_run_id_in_send_payload(self):
        root = Path(__file__).resolve().parents[1]
        js = (root / "frontend" / "modules" / "chat.js").read_text()
        self.assertIn("run_id: r.run_id || null", js)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
