"""Anthropic provider — wraps anthropic.AsyncAnthropic.

Streams `messages.stream(...)` and translates the SDK's event types into our
canonical StreamEvent shape. The complete() method is a convenience used by
the P0 non-streaming POST and by tests.

Image parts are translated to Anthropic's `{"type":"image","source":{"type":"base64",...}}`.
Tool definitions are passed through as-is (Anthropic accepts the JSON-schema
input_schema directly).
"""
from __future__ import annotations

import logging
from typing import Any, AsyncIterator, Optional

from .base import Message, MessagePart, Provider, ProviderError, StreamEvent, Tool
from .catalog import PROVIDER_CATALOG

log = logging.getLogger(__name__)


def _to_anthropic_messages(messages: list[Message]) -> tuple[list[dict], Optional[str]]:
    """Split system messages out (Anthropic takes system as top-level param).

    Returns (non_system_messages, combined_system_text).
    """
    system_chunks: list[str] = []
    out: list[dict] = []
    for msg in messages:
        if msg["role"] == "system":
            for part in msg["content"]:
                if part.get("type") == "text":
                    system_chunks.append(part["text"])
            continue
        out.append({"role": msg["role"], "content": _to_anthropic_content(msg["content"])})
    sys_combined = "\n\n".join(system_chunks) if system_chunks else None
    return out, sys_combined


def _build_tool_schemas(tools: Optional[list[Tool]]) -> list[dict]:
    """Translate canonical Tool dicts to Anthropic's native shape.

    Returns ``[]`` (not ``None``) when the input is empty/None so the caller
    can do a simple truthiness check before deciding whether to include the
    ``tools=`` kwarg on the SDK call. Anthropic rejects ``tools: null`` in
    the request body, so we must omit the field entirely when empty.
    """
    if not tools:
        return []
    return [
        {"name": t["name"], "description": t["description"], "input_schema": t["input_schema"]}
        for t in tools
    ]


def _to_anthropic_content(parts: list[MessagePart]) -> list[dict]:
    converted: list[dict] = []
    for part in parts:
        ptype = part.get("type")
        if ptype == "text":
            converted.append({"type": "text", "text": part["text"]})
        elif ptype == "image":
            converted.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": part.get("mime", "image/png"),
                    "data": part["data_b64"],
                },
            })
        elif ptype == "tool_use":
            converted.append({
                "type": "tool_use",
                "id": part["id"],
                "name": part["name"],
                "input": part.get("input", {}),
            })
        elif ptype == "tool_result":
            content = part.get("content", "")
            if isinstance(content, list):
                inner = _to_anthropic_content(content)
            else:
                inner = [{"type": "text", "text": str(content)}]
            entry: dict = {
                "type": "tool_result",
                "tool_use_id": part["tool_use_id"],
                "content": inner,
            }
            if part.get("is_error"):
                entry["is_error"] = True
            converted.append(entry)
    return converted


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, api_key: str) -> None:
        try:
            import anthropic  # type: ignore
        except ImportError as exc:
            raise ProviderError("anthropic SDK not installed", retryable=False) from exc
        self._anthropic = anthropic
        self._sync_client = anthropic.Anthropic(api_key=api_key)
        self._async_client = anthropic.AsyncAnthropic(api_key=api_key)

    # ----- discovery -----------------------------------------------------
    def list_models(self) -> list[dict[str, Any]]:
        return PROVIDER_CATALOG["anthropic"]["models"]

    # ----- non-streaming (test / fallback path) --------------------------
    async def complete(
        self,
        *,
        model: str,
        system: str,
        messages: list[Message],
        tools: Optional[list[Tool]] = None,
        max_output_tokens: int = 4000,
    ) -> dict[str, Any]:
        anthropic_msgs, embedded_system = _to_anthropic_messages(messages)
        sys_text = "\n\n".join([s for s in (system, embedded_system) if s])
        # Anthropic rejects `tools: null` and `system: null` — omit these
        # kwargs entirely when there is no value to send.
        kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": max_output_tokens,
            "messages": anthropic_msgs,
        }
        if sys_text:
            kwargs["system"] = sys_text
        tool_schemas = _build_tool_schemas(tools)
        if tool_schemas:
            kwargs["tools"] = tool_schemas
        try:
            from anthropic import AuthenticationError  # type: ignore
        except ImportError:
            AuthenticationError = ()  # type: ignore[assignment]
        try:
            resp = await self._async_client.messages.create(**kwargs)
        except AuthenticationError as exc:
            raise ProviderError(
                "Anthropic rejected the saved API key (HTTP 401). Re-paste your "
                "Anthropic key in Settings → AI (the saved one may be mistyped, "
                "revoked, or lack access to this model).",
                status=401,
                retryable=False,
            ) from exc
        except Exception as exc:  # pragma: no cover - depends on SDK exceptions
            raise ProviderError(f"anthropic complete failed: {exc}", retryable=False) from exc

        text_chunks: list[str] = []
        tool_calls: list[dict] = []
        for block in resp.content:
            btype = getattr(block, "type", "")
            if btype == "text":
                text_chunks.append(block.text)
            elif btype == "tool_use":
                tool_calls.append({"id": block.id, "name": block.name, "input": dict(block.input or {})})
        usage = {
            "input_tokens": int(getattr(resp.usage, "input_tokens", 0) or 0),
            "output_tokens": int(getattr(resp.usage, "output_tokens", 0) or 0),
        }
        return {
            "text": "".join(text_chunks).strip(),
            "tool_calls": tool_calls,
            "usage": usage,
            "finish_reason": getattr(resp, "stop_reason", "") or "end_turn",
        }

    # ----- streaming -----------------------------------------------------
    async def stream(
        self,
        *,
        model: str,
        system: str,
        messages: list[Message],
        tools: Optional[list[Tool]] = None,
        max_output_tokens: int = 4000,
    ) -> AsyncIterator[StreamEvent]:
        anthropic_msgs, embedded_system = _to_anthropic_messages(messages)
        sys_text = "\n\n".join([s for s in (system, embedded_system) if s])
        # Anthropic rejects `tools: null` and `system: null` — omit these
        # kwargs entirely when there is no value to send.
        kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": max_output_tokens,
            "messages": anthropic_msgs,
        }
        if sys_text:
            kwargs["system"] = sys_text
        tool_schemas = _build_tool_schemas(tools)
        if tool_schemas:
            kwargs["tools"] = tool_schemas

        # Streaming through Anthropic's async context manager.
        # Authentication errors are recoverable by the user (re-paste key) —
        # surface them as a clean StreamEvent with a friendly message so the
        # chat doesn't show a raw 401 JSON dump.
        try:
            from anthropic import AuthenticationError  # type: ignore
        except ImportError:
            AuthenticationError = ()  # type: ignore[assignment]

        try:
            async with self._async_client.messages.stream(**kwargs) as stream:
                async for event in stream:
                    etype = getattr(event, "type", "")
                    if etype == "content_block_delta":
                        delta = getattr(event, "delta", None)
                        text = getattr(delta, "text", None) if delta else None
                        if text:
                            yield {"type": "delta", "text": text}
                    elif etype == "content_block_stop":
                        # When a tool_use block finishes, surface it as a tool_call event.
                        block = getattr(event, "content_block", None)
                        if block is not None and getattr(block, "type", "") == "tool_use":
                            yield {
                                "type": "tool_call",
                                "tool_call": {
                                    "id": block.id,
                                    "name": block.name,
                                    "input": dict(getattr(block, "input", {}) or {}),
                                },
                            }
                # Final usage + stop reason.
                final = await stream.get_final_message()
                yield {
                    "type": "usage",
                    "usage": {
                        "input_tokens": int(getattr(final.usage, "input_tokens", 0) or 0),
                        "output_tokens": int(getattr(final.usage, "output_tokens", 0) or 0),
                    },
                }
                yield {"type": "finish", "finish_reason": getattr(final, "stop_reason", "") or "end_turn"}
        except AuthenticationError as exc:
            log.warning("Anthropic auth rejected: %s", exc)
            yield {
                "type": "error",
                "error": (
                    "Anthropic rejected the saved API key (HTTP 401). The key may "
                    "have been mistyped, has trailing whitespace, was revoked, or "
                    "doesn't have access to this model. Open Settings → AI, click "
                    "the trash to clear the saved key, then paste a fresh one from "
                    "console.anthropic.com."
                ),
                "error_code": "auth",
            }
        except Exception as exc:  # pragma: no cover - depends on SDK runtime
            log.exception("Anthropic stream failed")
            yield {"type": "error", "error": str(exc)}
