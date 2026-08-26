"""Backend conversation-isolation tests — the server-side half of the
cross-conversation bleed fix.

The frontend registry (tests/chatStreams.test.mjs) proves view-state isolation;
these prove the API/persistence layer keeps two conversations on the same run
completely separate, including across a streaming turn.
"""
from __future__ import annotations

import json
import tempfile
import unittest
import warnings

from tests.test_app import build_app, managed_client
from tests.test_chat_p1 import (
    FakeStreamScript,
    _bootstrap_with_run,
    _enter,
    _exit,
    _parse_sse,
    _patch_anthropic,
)

warnings.simplefilter("ignore", DeprecationWarning)
warnings.simplefilter("ignore", ResourceWarning)


def _second_conversation(client, headers, run_id, title="conv B"):
    return client.post(
        f"/api/runs/{run_id}/conversations",
        headers=headers,
        json={"title": title},
    ).json()["id"]


def _messages(client, headers, conv_id):
    return client.get(f"/api/conversations/{conv_id}", headers=headers).json().get("messages", [])


class ConversationIsolationTests(unittest.TestCase):
    def test_two_conversations_keep_separate_histories(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_anthropic()  # non-streaming complete() mock
            _enter(patches)
            try:
                with managed_client(app) as client:
                    headers, run_id, conv_a = _bootstrap_with_run(client)
                    conv_b = _second_conversation(client, headers, run_id)
                    self.assertNotEqual(conv_a, conv_b)

                    client.post(f"/api/conversations/{conv_a}/messages",
                                headers=headers, json={"content": "QUESTION-FOR-A"})
                    client.post(f"/api/conversations/{conv_b}/messages",
                                headers=headers, json={"content": "QUESTION-FOR-B"})

                    a_msgs = _messages(client, headers, conv_a)
                    b_msgs = _messages(client, headers, conv_b)
                    a_text = " ".join(m.get("content", "") for m in a_msgs)
                    b_text = " ".join(m.get("content", "") for m in b_msgs)

                    # Each conversation sees ONLY its own user turn.
                    self.assertIn("QUESTION-FOR-A", a_text)
                    self.assertNotIn("QUESTION-FOR-B", a_text)
                    self.assertIn("QUESTION-FOR-B", b_text)
                    self.assertNotIn("QUESTION-FOR-A", b_text)
                    # Each got exactly one user + one assistant turn.
                    self.assertEqual(len(a_msgs), 2)
                    self.assertEqual(len(b_msgs), 2)
            finally:
                _exit(patches)

    def test_streaming_post_persists_only_to_target_conversation(self):
        script = FakeStreamScript([
            {"type": "delta", "text": "alpha "},
            {"type": "delta", "text": "answer"},
            {"type": "usage", "usage": {"input_tokens": 5, "output_tokens": 2}},
            {"type": "finish", "finish_reason": "end_turn"},
        ])
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_anthropic(script)
            _enter(patches)
            try:
                with managed_client(app) as client:
                    headers, run_id, conv_a = _bootstrap_with_run(client)
                    conv_b = _second_conversation(client, headers, run_id)

                    # Stream a turn into A only.
                    with client.stream(
                        "POST",
                        f"/api/conversations/{conv_a}/messages",
                        headers={**headers, "Accept": "text/event-stream"},
                        json={"content": "stream into A"},
                    ) as resp:
                        self.assertEqual(resp.status_code, 200)
                        events = _parse_sse("".join(resp.iter_text()))
                    self.assertTrue(any(e.get("type") == "finish" for e in events))

                    a_msgs = _messages(client, headers, conv_a)
                    b_msgs = _messages(client, headers, conv_b)
                    a_assistant = " ".join(
                        m.get("content", "") for m in a_msgs if m.get("role") == "assistant"
                    )
                    # A captured the streamed answer; B was never touched.
                    self.assertIn("alpha answer", a_assistant)
                    self.assertEqual(len(b_msgs), 0, f"conv B must stay empty, got: {b_msgs}")
            finally:
                _exit(patches)

    def test_sequential_streams_to_both_do_not_cross_persist(self):
        script_a = FakeStreamScript([
            {"type": "delta", "text": "AAA"},
            {"type": "finish", "finish_reason": "end_turn"},
        ])
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_anthropic(script_a)
            _enter(patches)
            try:
                with managed_client(app) as client:
                    headers, run_id, conv_a = _bootstrap_with_run(client)
                    conv_b = _second_conversation(client, headers, run_id)
                    for cid in (conv_a, conv_b):
                        with client.stream(
                            "POST",
                            f"/api/conversations/{cid}/messages",
                            headers={**headers, "Accept": "text/event-stream"},
                            json={"content": f"stream into {cid}"},
                        ) as resp:
                            "".join(resp.iter_text())
                    a_msgs = _messages(client, headers, conv_a)
                    b_msgs = _messages(client, headers, conv_b)
                    # Each conversation has exactly its own user+assistant pair.
                    self.assertEqual(len(a_msgs), 2)
                    self.assertEqual(len(b_msgs), 2)
                    self.assertIn(conv_a, " ".join(m.get("content", "") for m in a_msgs))
                    self.assertNotIn(conv_a, " ".join(m.get("content", "") for m in b_msgs))
            finally:
                _exit(patches)


if __name__ == "__main__":
    unittest.main()
