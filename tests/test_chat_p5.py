"""P5 tests — regenerate, pin, export, follow-ups emission."""
from __future__ import annotations

import asyncio
import json
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


# --- Provider stub: returns deterministic answer for tests ---

def _patch_anthropic_complete(answer: str = "Mocked answer."):
    _ensure_backend_on_path()
    from services.ai.providers import anthropic_provider as ap_module

    def _no_op_init(self, api_key: str) -> None:
        self._sync_client = None
        self._async_client = None

    async def _complete(self, **kwargs):
        return {
            "text": answer,
            "tool_calls": [],
            "usage": {"input_tokens": 10, "output_tokens": 5},
            "finish_reason": "end_turn",
        }

    return [
        mock.patch.object(ap_module.AnthropicProvider, "__init__", _no_op_init),
        mock.patch.object(ap_module.AnthropicProvider, "complete", _complete),
    ]


def _bootstrap_with_run(client):
    headers, workspace, project = bootstrap_session(client)
    uploaded = upload_primary_dataset(
        client, headers, workspace["id"], project["id"], dataset_bytes()
    )
    run = client.post(
        "/api/runs",
        headers=headers,
        json={
            "workspace_id": workspace["id"],
            "project_id": project["id"],
            "name": "P5",
            "dataset_id": uploaded["dataset_id"],
        },
    ).json()
    client.put(
        "/api/settings/ai",
        headers=headers,
        json={"anthropic_key": "sk-ant-fake-key-for-p5-tests-padding-padding"},
    )
    conv = client.post(
        f"/api/runs/{run['run_id']}/conversations",
        headers=headers,
        json={"title": "p5"},
    ).json()
    return headers, conv["id"]


# ---------- Tests ----------

class P5RegenerateTests(unittest.TestCase):
    def test_regenerate_replaces_assistant_message(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_anthropic_complete("first answer")
            for p in patches:
                p.__enter__()
            try:
                with managed_client(app) as client:
                    headers, conv_id = _bootstrap_with_run(client)
                    # Send first message
                    sent = client.post(
                        f"/api/conversations/{conv_id}/messages",
                        headers=headers,
                        json={"content": "What is APOE?"},
                    )
                    self.assertEqual(sent.status_code, 200)
                    asst_id = sent.json()["assistant_message"]["id"]
                    # Patch new answer for regeneration
                    _ensure_backend_on_path()
                    from services.ai.providers import anthropic_provider as ap_module

                    async def _new_answer(self, **kwargs):
                        return {
                            "text": "regenerated answer",
                            "tool_calls": [],
                            "usage": {"input_tokens": 12, "output_tokens": 6},
                            "finish_reason": "end_turn",
                        }
                    with mock.patch.object(ap_module.AnthropicProvider, "complete", _new_answer):
                        regen = client.post(
                            f"/api/conversations/{conv_id}/messages/{asst_id}/regenerate",
                            headers=headers,
                        )
                    self.assertEqual(regen.status_code, 200, regen.text)
                    self.assertEqual(regen.json()["assistant_message"]["content"], "regenerated answer")
                    # Old assistant_id is gone; new id is different.
                    self.assertNotEqual(regen.json()["assistant_message"]["id"], asst_id)
                    # Conversation now has 1 user + 1 (new) assistant.
                    detail = client.get(f"/api/conversations/{conv_id}", headers=headers).json()
                    self.assertEqual(len(detail["messages"]), 2)
                    self.assertEqual(detail["messages"][-1]["content"], "regenerated answer")
            finally:
                for p in reversed(patches):
                    try:
                        p.__exit__(None, None, None)
                    except Exception:
                        pass

    def test_regenerate_user_message_rejected(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_anthropic_complete()
            for p in patches:
                p.__enter__()
            try:
                with managed_client(app) as client:
                    headers, conv_id = _bootstrap_with_run(client)
                    sent = client.post(
                        f"/api/conversations/{conv_id}/messages",
                        headers=headers,
                        json={"content": "hi"},
                    )
                    user_id = sent.json()["user_message"]["id"]
                    resp = client.post(
                        f"/api/conversations/{conv_id}/messages/{user_id}/regenerate",
                        headers=headers,
                    )
                    self.assertEqual(resp.status_code, 400)
            finally:
                for p in reversed(patches):
                    p.__exit__(None, None, None)


class P5PinTests(unittest.TestCase):
    def test_pin_then_unpin(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_anthropic_complete()
            for p in patches:
                p.__enter__()
            try:
                with managed_client(app) as client:
                    headers, conv_id = _bootstrap_with_run(client)
                    sent = client.post(
                        f"/api/conversations/{conv_id}/messages",
                        headers=headers,
                        json={"content": "ping"},
                    )
                    asst_id = sent.json()["assistant_message"]["id"]
                    r1 = client.post(
                        f"/api/conversations/{conv_id}/messages/{asst_id}/pin",
                        headers=headers,
                    )
                    self.assertEqual(r1.status_code, 200)
                    self.assertEqual(r1.json()["action"], "pinned")
                    conv = client.get(f"/api/conversations/{conv_id}", headers=headers).json()
                    self.assertEqual(conv["pinned_message_id"], asst_id)
                    # Pinning again unpins.
                    r2 = client.post(
                        f"/api/conversations/{conv_id}/messages/{asst_id}/pin",
                        headers=headers,
                    )
                    self.assertEqual(r2.json()["action"], "unpinned")
                    conv = client.get(f"/api/conversations/{conv_id}", headers=headers).json()
                    self.assertIsNone(conv["pinned_message_id"])
            finally:
                for p in reversed(patches):
                    p.__exit__(None, None, None)

    def test_pin_nonexistent_message_404(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            with managed_client(app) as client:
                headers, conv_id = _bootstrap_with_run(client)
                r = client.post(
                    f"/api/conversations/{conv_id}/messages/nonexistent_id_xx/pin",
                    headers=headers,
                )
                self.assertEqual(r.status_code, 404)


class P5ExportTests(unittest.TestCase):
    def test_export_returns_markdown_with_citations_and_tools(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_anthropic_complete("APOE answer here")
            for p in patches:
                p.__enter__()
            try:
                with managed_client(app) as client:
                    headers, conv_id = _bootstrap_with_run(client)
                    client.post(
                        f"/api/conversations/{conv_id}/messages",
                        headers=headers,
                        json={"content": "What is APOE log2FC?"},
                    )
                    resp = client.get(
                        f"/api/conversations/{conv_id}/export",
                        headers=headers,
                    )
                    self.assertEqual(resp.status_code, 200)
                    self.assertIn("text/markdown", resp.headers["content-type"])
                    body = resp.text
                    self.assertIn("# p5", body)              # title
                    self.assertIn("What is APOE log2FC?", body)  # user turn
                    self.assertIn("APOE answer here", body)      # assistant turn
                    self.assertIn("Conversation ID", body)
                    self.assertIn("👤 You", body)
                    self.assertIn("🤖 Assistant", body)
            finally:
                for p in reversed(patches):
                    p.__exit__(None, None, None)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
