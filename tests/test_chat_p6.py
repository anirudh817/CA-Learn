"""P6 tests — platform-quota gauge data in usage SSE + 429 error shape."""
from __future__ import annotations

import asyncio
import json
import os
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


def _patch_anthropic_stream(deltas=None):
    """Patch the streaming + complete methods on AnthropicProvider so we
    don't hit the network and we can assert on the event shape."""
    _ensure_backend_on_path()
    from services.ai.providers import anthropic_provider as ap_module

    deltas = deltas or [
        {"type": "delta", "text": "ok."},
        {"type": "usage", "usage": {"input_tokens": 10, "output_tokens": 4}},
        {"type": "finish", "finish_reason": "end_turn"},
    ]

    def _no_op_init(self, api_key: str) -> None:
        self._sync_client = None
        self._async_client = None

    async def _stream(self, **kwargs):
        for d in deltas:
            yield d

    async def _complete(self, **kwargs):
        return {"text": "ok.", "tool_calls": [], "usage": {"input_tokens": 10, "output_tokens": 4}, "finish_reason": "end_turn"}

    return [
        mock.patch.object(ap_module.AnthropicProvider, "__init__", _no_op_init),
        mock.patch.object(ap_module.AnthropicProvider, "stream", _stream),
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
            "name": "P6",
            "dataset_id": uploaded["dataset_id"],
        },
    ).json()
    return headers, run["run_id"], workspace, project


def _read_sse(body_text: str) -> list[dict]:
    events: list[dict] = []
    for frame in body_text.split("\n\n"):
        for line in frame.splitlines():
            if line.startswith("data: "):
                try:
                    events.append(json.loads(line[len("data: "):]))
                except json.JSONDecodeError:
                    pass
    return events


# ---------- Tests ----------

class P6PlatformQuotaInUsageEventTests(unittest.TestCase):
    def test_usage_event_carries_quota_when_platform_key_used(self):
        # Force platform key path — user never sets their own key, but the
        # ANTHROPIC_API_KEY env var IS set so resolver picks "platform".
        os.environ["ANTHROPIC_API_KEY"] = "sk-ant-platform-fake-key-padding-1234567890"
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                app = build_app(temp_dir)
                patches = _patch_anthropic_stream()
                for p in patches:
                    p.__enter__()
                try:
                    with managed_client(app) as client:
                        headers, run_id, _, _ = _bootstrap_with_run(client)
                        conv = client.post(
                            f"/api/runs/{run_id}/conversations",
                            headers=headers,
                            json={},
                        ).json()
                        with client.stream(
                            "POST",
                            f"/api/conversations/{conv['id']}/messages",
                            headers={**headers, "Accept": "text/event-stream"},
                            json={"content": "hello"},
                        ) as resp:
                            self.assertEqual(resp.status_code, 200)
                            body = "".join(resp.iter_text())
                        events = _read_sse(body)
                        usage_evt = next((e for e in events if e["type"] == "usage"), None)
                        self.assertIsNotNone(usage_evt)
                        self.assertEqual(usage_evt["key_source"], "platform")
                        self.assertIn("platform_quota", usage_evt)
                        q = usage_evt["platform_quota"]
                        for k in ("tokens_used", "tokens_limit", "reqs_used", "reqs_limit", "resets_at"):
                            self.assertIn(k, q, f"missing {k} in platform_quota")
                        # After one request, reqs_used should be 1.
                        self.assertGreaterEqual(q["reqs_used"], 1)
                finally:
                    for p in reversed(patches):
                        p.__exit__(None, None, None)
        finally:
            os.environ.pop("ANTHROPIC_API_KEY", None)

    def test_usage_event_omits_quota_when_byok(self):
        # User pastes their own key — quota is irrelevant; event should
        # NOT include platform_quota.
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_anthropic_stream()
            for p in patches:
                p.__enter__()
            try:
                with managed_client(app) as client:
                    headers, run_id, _, _ = _bootstrap_with_run(client)
                    client.put(
                        "/api/settings/ai",
                        headers=headers,
                        json={"anthropic_key": "sk-ant-byok-fake-padding-1234567890"},
                    )
                    conv = client.post(
                        f"/api/runs/{run_id}/conversations",
                        headers=headers,
                        json={},
                    ).json()
                    with client.stream(
                        "POST",
                        f"/api/conversations/{conv['id']}/messages",
                        headers={**headers, "Accept": "text/event-stream"},
                        json={"content": "hi"},
                    ) as resp:
                        self.assertEqual(resp.status_code, 200)
                        body = "".join(resp.iter_text())
                    events = _read_sse(body)
                    usage_evt = next((e for e in events if e["type"] == "usage"), None)
                    self.assertIsNotNone(usage_evt)
                    self.assertEqual(usage_evt["key_source"], "user")
                    self.assertNotIn("platform_quota", usage_evt)
            finally:
                for p in reversed(patches):
                    p.__exit__(None, None, None)


class P6QuotaExceededShapeTests(unittest.TestCase):
    def test_429_detail_is_structured_for_ui(self):
        os.environ["AI_PLATFORM_DAILY_REQS"] = "1"
        os.environ["AI_PLATFORM_DAILY_TOKENS"] = "10000000"
        os.environ["ANTHROPIC_API_KEY"] = "sk-ant-platform-fake-key-padding-1234567890"
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                app = build_app(temp_dir)
                patches = _patch_anthropic_stream()
                for p in patches:
                    p.__enter__()
                try:
                    with managed_client(app) as client:
                        headers, run_id, _, _ = _bootstrap_with_run(client)
                        conv = client.post(
                            f"/api/runs/{run_id}/conversations",
                            headers=headers,
                            json={},
                        ).json()
                        # First request consumes the quota of 1.
                        ok = client.post(
                            f"/api/conversations/{conv['id']}/messages",
                            headers=headers,
                            json={"content": "first"},
                        )
                        self.assertEqual(ok.status_code, 200)
                        # Second request must 429 with structured detail.
                        blocked = client.post(
                            f"/api/conversations/{conv['id']}/messages",
                            headers=headers,
                            json={"content": "second"},
                        )
                        self.assertEqual(blocked.status_code, 429, blocked.text)
                        detail = blocked.json()["detail"]
                        self.assertIn("message", detail)
                        self.assertIn("resets_at", detail)
                        self.assertIn("remedy", detail)
                        self.assertIn("Settings", detail["remedy"])
                        self.assertIn("reqs_limit", detail)
                finally:
                    for p in reversed(patches):
                        p.__exit__(None, None, None)
        finally:
            os.environ.pop("AI_PLATFORM_DAILY_REQS", None)
            os.environ.pop("AI_PLATFORM_DAILY_TOKENS", None)
            os.environ.pop("ANTHROPIC_API_KEY", None)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
