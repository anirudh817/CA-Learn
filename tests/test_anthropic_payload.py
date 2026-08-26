"""Regression tests for the exact kwargs we hand to the Anthropic SDK.

The bug we're guarding against: passing ``tools=None`` (or ``system=None``)
to ``messages.create()`` / ``messages.stream()`` causes the SDK to serialize
``"tools": null`` into the HTTP body, and Anthropic's API rejects that with
``tools: Input should be a valid array``.

These tests mock at the AsyncAnthropic.messages level — NOT at our
AnthropicProvider.complete / .stream level — so future regressions in how
we build the request payload are caught before they hit prod.
"""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


class FakeMessageContent:
    type = "text"
    text = "hello"


class FakeUsage:
    input_tokens = 4
    output_tokens = 2


class FakeMessage:
    content = [FakeMessageContent()]
    usage = FakeUsage()
    stop_reason = "end_turn"


class _AsyncStreamCtx:
    def __init__(self):
        self.events_iter = iter([])

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def __aiter__(self):
        async def _gen():
            for ev in self.events_iter:
                yield ev
        return _gen()

    async def get_final_message(self):
        return FakeMessage()


def _make_provider_with_fake_clients(create_recorder, stream_recorder):
    from services.ai.providers.anthropic_provider import AnthropicProvider

    fake_create = mock.AsyncMock(return_value=FakeMessage())
    fake_stream = mock.MagicMock(return_value=_AsyncStreamCtx())

    def _spy_create(**kwargs):
        create_recorder.append(kwargs)
        return fake_create(**kwargs)

    def _spy_stream(**kwargs):
        stream_recorder.append(kwargs)
        return fake_stream(**kwargs)

    fake_messages = mock.MagicMock()
    fake_messages.create = _spy_create
    fake_messages.stream = _spy_stream

    fake_async_client = mock.MagicMock()
    fake_async_client.messages = fake_messages

    # Bypass the real __init__ which constructs the real anthropic clients.
    provider = AnthropicProvider.__new__(AnthropicProvider)
    provider._async_client = fake_async_client
    provider._sync_client = None
    return provider


class TestAnthropicPayloadOmitsNoneKwargs(unittest.TestCase):
    def test_complete_omits_tools_when_none(self) -> None:
        recorded = []
        provider = _make_provider_with_fake_clients(recorded, [])
        asyncio.get_event_loop().run_until_complete(
            provider.complete(
                model="claude-sonnet-4-6",
                system="You are SignalFold Assistant.",
                messages=[{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
                tools=None,
                max_output_tokens=4000,
            )
        )
        self.assertEqual(len(recorded), 1)
        kwargs = recorded[0]
        # The fix: `tools` must not appear in the SDK call at all.
        self.assertNotIn("tools", kwargs)
        # Sanity: required kwargs are present.
        self.assertEqual(kwargs["model"], "claude-sonnet-4-6")
        self.assertEqual(kwargs["max_tokens"], 4000)
        self.assertEqual(kwargs["system"], "You are SignalFold Assistant.")
        self.assertEqual(len(kwargs["messages"]), 1)

    def test_complete_includes_tools_when_provided(self) -> None:
        recorded = []
        provider = _make_provider_with_fake_clients(recorded, [])
        asyncio.get_event_loop().run_until_complete(
            provider.complete(
                model="claude-sonnet-4-6",
                system="",
                messages=[{"role": "user", "content": [{"type": "text", "text": "x"}]}],
                tools=[
                    {
                        "name": "lookup_uniprot",
                        "description": "Look up UniProt for a symbol.",
                        "input_schema": {"type": "object", "properties": {"q": {"type": "string"}}},
                    }
                ],
            )
        )
        kwargs = recorded[0]
        self.assertIn("tools", kwargs)
        self.assertEqual(len(kwargs["tools"]), 1)
        self.assertEqual(kwargs["tools"][0]["name"], "lookup_uniprot")
        # system="" should be omitted too — Anthropic doesn't accept empty string.
        self.assertNotIn("system", kwargs)

    def test_stream_omits_tools_when_none(self) -> None:
        recorded = []
        provider = _make_provider_with_fake_clients([], recorded)

        async def consume():
            async for _ in provider.stream(
                model="claude-sonnet-4-6",
                system="hello",
                messages=[{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
                tools=None,
                max_output_tokens=4000,
            ):
                pass

        asyncio.get_event_loop().run_until_complete(consume())
        self.assertEqual(len(recorded), 1)
        kwargs = recorded[0]
        self.assertNotIn("tools", kwargs)
        self.assertEqual(kwargs["system"], "hello")
        self.assertEqual(kwargs["model"], "claude-sonnet-4-6")

    def test_stream_omits_tools_when_empty_list(self) -> None:
        recorded = []
        provider = _make_provider_with_fake_clients([], recorded)

        async def consume():
            async for _ in provider.stream(
                model="claude-sonnet-4-6",
                system="x",
                messages=[{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
                tools=[],
                max_output_tokens=4000,
            ):
                pass

        asyncio.get_event_loop().run_until_complete(consume())
        self.assertNotIn("tools", recorded[0])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
