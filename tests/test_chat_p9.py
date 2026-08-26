"""P9 integration tests — Context Panel + @-mention / pinned refs.

Covers:
  1. The context-panel endpoint groups run artifacts by family and lists
     the conversation's own uploaded attachments.
  2. A pinned run artifact is resolved and its content reaches the provider.
  3. A pinned attachment is resolved and its content reaches the provider.

The provider is mocked; the LLM-judge gates are disabled so the capture
mock sees the real chat turn (not a judge call).
"""
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
from tests.test_chat_p4_tools import _write_minimal_run

warnings.simplefilter("ignore", DeprecationWarning)
warnings.simplefilter("ignore", ResourceWarning)


def _ensure_backend_on_path() -> None:
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))


class _Capture:
    last_messages = None


def _patch_capture():
    """Patch the Anthropic provider to capture the outgoing chat turn, and
    turn off the LLM-judge gates so their own provider calls don't pollute
    the capture."""
    _ensure_backend_on_path()
    from services.ai.providers import anthropic_provider as ap

    def _no_op_init(self, api_key: str) -> None:
        self._sync_client = None
        self._async_client = None

    async def _complete(self, **kwargs):
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


def _bootstrap_run_conv(client):
    """Bootstrap a session, write a synthetic run to disk + a Run row, and
    open a conversation on it. Returns (headers, conv_id)."""
    _ensure_backend_on_path()
    from config import RUNS_DIR

    _write_minimal_run(Path(RUNS_DIR.parent), "RUN-P9")

    headers, workspace, project = bootstrap_session(client)
    uploaded = upload_primary_dataset(
        client, headers, workspace["id"], project["id"], dataset_bytes()
    )
    import database

    db = database.SessionLocal()
    try:
        db.add(database.Run(
            id="RUN-P9",
            workspace_id=workspace["id"],
            project_id=project["id"],
            created_by=db.query(database.User).first().id,
            name="p9 test",
            file_id=uploaded["dataset_id"],
            file_name="cohort.csv",
            status=database.RunStatus.COMPLETE,
        ))
        db.commit()
    finally:
        db.close()

    client.put(
        "/api/settings/ai",
        headers=headers,
        json={"anthropic_key": "sk-ant-fake-key-padding-padding-p9"},
    )
    conv = client.post(
        "/api/runs/RUN-P9/conversations", headers=headers, json={}
    ).json()
    return headers, conv["id"]


class ContextPanelEndpointTests(unittest.TestCase):
    def test_context_panel_groups_run_artifacts(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            with managed_client(app) as client:
                headers, conv_id = _bootstrap_run_conv(client)
                resp = client.get(
                    f"/api/conversations/{conv_id}/context-panel", headers=headers
                )
                self.assertEqual(resp.status_code, 200, resp.text)
                data = resp.json()
                groups = {g["group"] for g in data["run_artifacts"]}
                # The synthetic run has DE, module and GO files.
                self.assertIn("Differential expression", groups)
                all_labels = [
                    it["label"]
                    for g in data["run_artifacts"]
                    for it in g["items"]
                ]
                self.assertIn("volcano_results.tsv", all_labels)
                self.assertEqual(data["local_files"], [])

    def test_context_panel_lists_conversation_attachments(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            with managed_client(app) as client:
                headers, conv_id = _bootstrap_run_conv(client)
                up = client.post(
                    f"/api/conversations/{conv_id}/attachments",
                    headers=headers,
                    files={"files": ("notes.csv", b"gene,note\nAPOE,risk\n", "text/csv")},
                )
                self.assertEqual(up.status_code, 200, up.text)
                resp = client.get(
                    f"/api/conversations/{conv_id}/context-panel", headers=headers
                )
                self.assertEqual(resp.status_code, 200, resp.text)
                local = resp.json()["local_files"]
                self.assertEqual(len(local), 1)
                self.assertEqual(local[0]["label"], "notes.csv")
                self.assertTrue(local[0]["attachment_id"])


class PinnedRefsTests(unittest.TestCase):
    def test_pinned_run_artifact_reaches_provider(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_capture()
            for p in patches:
                p.__enter__()
            try:
                with managed_client(app) as client:
                    headers, conv_id = _bootstrap_run_conv(client)
                    _Capture.last_messages = None
                    sent = client.post(
                        f"/api/conversations/{conv_id}/messages",
                        headers=headers,
                        json={
                            "content": "summarise the pinned file",
                            "pinned_refs": [{
                                "kind": "run_artifact",
                                "rel_path": "stage1/volcano_results.tsv",
                                "label": "volcano_results.tsv",
                            }],
                        },
                    )
                    self.assertEqual(sent.status_code, 200, sent.text)
                    self.assertIsNotNone(_Capture.last_messages)
                    user_turn = _Capture.last_messages[-1]
                    text = "\n".join(
                        p["text"] for p in user_turn["content"] if p["type"] == "text"
                    )
                    self.assertIn("Pinned context", text)
                    self.assertIn("volcano_results.tsv", text)
                    # Actual file content — a value from the synthetic run.
                    self.assertIn("APOE", text)
            finally:
                for p in reversed(patches):
                    try:
                        p.__exit__(None, None, None)
                    except Exception:
                        pass

    def test_pinned_attachment_reaches_provider(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_capture()
            for p in patches:
                p.__enter__()
            try:
                with managed_client(app) as client:
                    headers, conv_id = _bootstrap_run_conv(client)
                    up = client.post(
                        f"/api/conversations/{conv_id}/attachments",
                        headers=headers,
                        files={"files": ("pinme.csv", b"gene,score\nCLU,9.9\n", "text/csv")},
                    )
                    self.assertEqual(up.status_code, 200, up.text)
                    aid = up.json()[0]["id"]
                    _Capture.last_messages = None
                    sent = client.post(
                        f"/api/conversations/{conv_id}/messages",
                        headers=headers,
                        json={
                            "content": "what is in the pinned file",
                            "pinned_refs": [{
                                "kind": "attachment",
                                "attachment_id": aid,
                                "label": "pinme.csv",
                            }],
                        },
                    )
                    self.assertEqual(sent.status_code, 200, sent.text)
                    user_turn = _Capture.last_messages[-1]
                    text = "\n".join(
                        p["text"] for p in user_turn["content"] if p["type"] == "text"
                    )
                    self.assertIn("Pinned file", text)
                    self.assertIn("pinme.csv", text)
                    self.assertIn("CLU", text)
            finally:
                for p in reversed(patches):
                    try:
                        p.__exit__(None, None, None)
                    except Exception:
                        pass


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
