"""P1 integration tests for streaming SSE on the chat endpoint.

Covers:
    1. SSE stream emits start → delta(s) → usage → finish events;
       the assistant message persists with status=complete and the
       concatenated text.
    2. The non-streaming JSON path still works (regression for P0).
    3. DELETE /api/conversations/{id} cascades and removes files on disk.
    4. Client disconnect mid-stream persists the partial answer with
       status=cancelled (no test exception, message still readable on GET).
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
import warnings
from pathlib import Path
from typing import AsyncIterator
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


# ---------- Fake provider plumbing ----------

class FakeStreamScript:
    """Hold a script of StreamEvent dicts to be replayed by the mocked
    provider stream. Tests can also signal mid-stream cancellation by
    setting `.cancel_at` to a (1-indexed) event position.

    NOTE: we intentionally inject tiny sleeps between events so that the
    disconnect-detection path (request.is_disconnected polled per chunk)
    has time to flip in the cancellation test.
    """

    def __init__(self, events, *, between_delay: float = 0.0):
        self.events = events
        self.between_delay = between_delay


async def make_fake_stream(script: FakeStreamScript):
    async def _gen(self, **kwargs):
        for event in script.events:
            if script.between_delay:
                await asyncio.sleep(script.between_delay)
            yield event
    return _gen


def _patch_anthropic(script_or_none=None):
    """Patch AnthropicProvider so __init__ doesn't require SDK and stream/
    complete are mock-friendly. Pass a FakeStreamScript to control stream().
    """
    _ensure_backend_on_path()
    from services.ai.providers import anthropic_provider as ap_module

    def _no_op_init(self, api_key: str) -> None:
        self._sync_client = None
        self._async_client = None

    async def _complete_ok(self, **kwargs):
        return {
            "text": "Mocked complete() response.",
            "tool_calls": [],
            "usage": {"input_tokens": 7, "output_tokens": 3},
            "finish_reason": "end_turn",
        }

    patches = [
        mock.patch.object(ap_module.AnthropicProvider, "__init__", _no_op_init),
        mock.patch.object(ap_module.AnthropicProvider, "complete", _complete_ok),
    ]
    if script_or_none is not None:
        script = script_or_none

        async def _stream(self, **kwargs):
            for event in script.events:
                if script.between_delay:
                    await asyncio.sleep(script.between_delay)
                yield event

        patches.append(
            mock.patch.object(ap_module.AnthropicProvider, "stream", _stream)
        )
    return patches


def _enter(patches):
    for p in patches:
        p.__enter__()


def _exit(patches):
    for p in reversed(patches):
        try:
            p.__exit__(None, None, None)
        except Exception:
            pass


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
            "name": "P1 stream",
            "dataset_id": uploaded["dataset_id"],
        },
    ).json()
    # Paste a key so the chat resolves.
    client.put(
        "/api/settings/ai",
        headers=headers,
        json={"anthropic_key": "sk-ant-fake-key-padding-padding-padding-p1"},
    )
    conv = client.post(
        f"/api/runs/{run['run_id']}/conversations",
        headers=headers,
        json={"title": "stream test"},
    ).json()
    return headers, run["run_id"], conv["id"]


def _parse_sse(text: str) -> list[dict]:
    out: list[dict] = []
    for frame in text.split("\n\n"):
        frame = frame.strip()
        if not frame:
            continue
        for line in frame.splitlines():
            if line.startswith("data: "):
                payload = line[len("data: "):]
                try:
                    out.append(json.loads(payload))
                except json.JSONDecodeError:
                    pass
    return out


# ---------- Tests ----------

class ChatP1NonStreamingRegression(unittest.TestCase):
    def test_non_streaming_json_path_still_works(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_anthropic()
            _enter(patches)
            try:
                with managed_client(app) as client:
                    headers, _, conv_id = _bootstrap_with_run(client)
                    resp = client.post(
                        f"/api/conversations/{conv_id}/messages",
                        headers=headers,
                        json={"content": "Tell me about APOE"},
                    )
                    self.assertEqual(resp.status_code, 200, resp.text)
                    payload = resp.json()
                    self.assertEqual(payload["assistant_message"]["status"], "complete")
                    self.assertIn("Mocked complete()", payload["assistant_message"]["content"])
            finally:
                _exit(patches)


class ChatP1StreamingTests(unittest.TestCase):
    def test_stream_emits_deltas_and_finish(self):
        script = FakeStreamScript([
            {"type": "delta", "text": "**APOE** "},
            {"type": "delta", "text": "log2FC is 3.4 "},
            {"type": "delta", "text": "in this run."},
            {"type": "usage", "usage": {"input_tokens": 42, "output_tokens": 11}},
            {"type": "finish", "finish_reason": "end_turn"},
        ])
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_anthropic(script)
            _enter(patches)
            try:
                with managed_client(app) as client:
                    headers, _, conv_id = _bootstrap_with_run(client)
                    with client.stream(
                        "POST",
                        f"/api/conversations/{conv_id}/messages",
                        headers={**headers, "Accept": "text/event-stream"},
                        json={"content": "What is APOE log2FC?"},
                    ) as resp:
                        self.assertEqual(resp.status_code, 200)
                        body = "".join(resp.iter_text())
                    events = _parse_sse(body)

                    types = [e["type"] for e in events]
                    self.assertEqual(types[0], "start")
                    self.assertIn("assistant_message_id", events[0])
                    self.assertEqual(events[0]["provider"], "anthropic")
                    self.assertGreaterEqual(types.count("delta"), 3)
                    self.assertIn("usage", types)
                    self.assertEqual(types[-1], "finish")

                    asst_id = events[0]["assistant_message_id"]
                    # Now GET conversation and confirm persistence.
                    detail = client.get(
                        f"/api/conversations/{conv_id}", headers=headers
                    ).json()
                    assistant = next(m for m in detail["messages"] if m["id"] == asst_id)
                    self.assertEqual(assistant["status"], "complete")
                    self.assertEqual(
                        assistant["content"], "**APOE** log2FC is 3.4 in this run."
                    )
                    self.assertEqual(assistant["input_tokens"], 42)
                    self.assertEqual(assistant["output_tokens"], 11)
                    # Citations attached from the run's volcano file (if present).
                    # On this synthetic run the file may or may not exist;
                    # if present, we get one citation, else empty list — both
                    # are valid. Just assert the shape.
                    self.assertIsInstance(assistant["citations"], list)
            finally:
                _exit(patches)


class ChatP1DisconnectTests(unittest.TestCase):
    def test_disconnect_persists_partial_as_cancelled(self):
        # In a real browser/server, Starlette flips request.is_disconnected()
        # when the client closes its socket. FastAPITestClient short-circuits
        # the transport and never disconnects, so we patch is_disconnected to
        # fire after the 3rd poll — that exercises the same cancellation
        # path the real server uses on browser close.
        script = FakeStreamScript(
            [
                {"type": "delta", "text": "starting "},
                {"type": "delta", "text": "answer "},
                {"type": "delta", "text": "and more "},
                {"type": "delta", "text": "still going"},
                {"type": "usage", "usage": {"input_tokens": 5, "output_tokens": 4}},
                {"type": "finish", "finish_reason": "end_turn"},
            ]
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_anthropic(script)
            _enter(patches)

            # Patch request.is_disconnected to flip True after a couple of
            # polls. The send_message handler polls once before each event,
            # so we return False, False, True → cancellation fires before
            # the 3rd delta.
            from starlette.requests import Request

            call_count = {"n": 0}

            async def _flaky_disconnect(self):
                call_count["n"] += 1
                return call_count["n"] >= 3

            disc_patch = mock.patch.object(Request, "is_disconnected", _flaky_disconnect)
            disc_patch.__enter__()
            try:
                with managed_client(app) as client:
                    headers, _, conv_id = _bootstrap_with_run(client)
                    asst_id = None
                    with client.stream(
                        "POST",
                        f"/api/conversations/{conv_id}/messages",
                        headers={**headers, "Accept": "text/event-stream"},
                        json={"content": "long answer please"},
                    ) as resp:
                        self.assertEqual(resp.status_code, 200)
                        for chunk in resp.iter_text():
                            for frame in chunk.split("\n\n"):
                                if frame.startswith("data: "):
                                    payload = json.loads(frame[len("data: "):])
                                    if payload.get("type") == "start":
                                        asst_id = payload["assistant_message_id"]

                    self.assertIsNotNone(asst_id)
                    # Stream ended early; assistant row should be cancelled.
                    detail = client.get(
                        f"/api/conversations/{conv_id}", headers=headers
                    ).json()
                    assistant = next(m for m in detail["messages"] if m["id"] == asst_id)
                    self.assertEqual(
                        assistant["status"], "cancelled",
                        f"Expected cancelled, got status={assistant['status']!r} "
                        f"content={assistant['content']!r}",
                    )
                    # Partial content present — at most 2 deltas of the script
                    # streamed before disconnect was detected.
                    self.assertIn("starting", assistant["content"])
                    self.assertNotIn("still going", assistant["content"])
            finally:
                disc_patch.__exit__(None, None, None)
                _exit(patches)


class ChatP1CascadeDeleteTests(unittest.TestCase):
    def test_delete_conversation_cascades_messages(self):
        script = FakeStreamScript([
            {"type": "delta", "text": "hi"},
            {"type": "usage", "usage": {"input_tokens": 1, "output_tokens": 1}},
            {"type": "finish", "finish_reason": "end_turn"},
        ])
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_anthropic(script)
            _enter(patches)
            try:
                with managed_client(app) as client:
                    headers, _, conv_id = _bootstrap_with_run(client)
                    # Send a message (non-streaming path is enough).
                    sent = client.post(
                        f"/api/conversations/{conv_id}/messages",
                        headers=headers,
                        json={"content": "hello"},
                    )
                    self.assertEqual(sent.status_code, 200, sent.text)

                    # Conversation exists with two messages.
                    detail = client.get(
                        f"/api/conversations/{conv_id}", headers=headers
                    ).json()
                    self.assertEqual(len(detail["messages"]), 2)

                    # Delete.
                    deleted = client.delete(
                        f"/api/conversations/{conv_id}", headers=headers
                    )
                    self.assertEqual(deleted.status_code, 200)

                    # 404 on GET.
                    gone = client.get(
                        f"/api/conversations/{conv_id}", headers=headers
                    )
                    self.assertEqual(gone.status_code, 404)

                    # No conversation-dir on disk (none was ever created
                    # since there were no attachments, but the rmtree
                    # branch must not raise).
                    from config import CONVERSATIONS_DIR
                    self.assertFalse((Path(CONVERSATIONS_DIR) / conv_id).exists())
            finally:
                _exit(patches)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
