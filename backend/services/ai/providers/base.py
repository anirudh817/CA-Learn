"""Provider protocol and shared message shapes.

The chat layer above this knows nothing about provider SDKs. It builds a
canonical list[Message] and a canonical list[Tool], then calls
``provider.stream(...)`` and iterates ``StreamEvent`` items.

Canonical Message shape:
    {"role": "user" | "assistant" | "system" | "tool",
     "content": list[MessagePart]}

Canonical MessagePart shapes:
    {"type": "text",       "text": str}
    {"type": "image",      "mime": str, "data_b64": str}
    {"type": "tool_use",   "id": str, "name": str, "input": dict}
    {"type": "tool_result","tool_use_id": str, "content": str | list[MessagePart]}

Canonical Tool shape (passed verbatim to provider; each provider adapter
translates to its native schema):
    {"name": str, "description": str, "input_schema": dict}  # JSON schema
"""
from __future__ import annotations

from typing import Any, AsyncIterator, Literal, Optional, Protocol, TypedDict, Union


class TextPart(TypedDict):
    type: Literal["text"]
    text: str


class ImagePart(TypedDict):
    type: Literal["image"]
    mime: str
    data_b64: str


class ToolUsePart(TypedDict):
    type: Literal["tool_use"]
    id: str
    name: str
    input: dict[str, Any]


class ToolResultPart(TypedDict, total=False):
    type: Literal["tool_result"]
    tool_use_id: str
    content: Any
    is_error: bool


MessagePart = Union[TextPart, ImagePart, ToolUsePart, ToolResultPart]


class Message(TypedDict):
    role: Literal["user", "assistant", "system", "tool"]
    content: list[MessagePart]


class Tool(TypedDict):
    name: str
    description: str
    input_schema: dict[str, Any]


class StreamEvent(TypedDict, total=False):
    type: Literal["delta", "tool_call", "usage", "finish", "error"]
    text: str
    tool_call: dict[str, Any]   # {"id": str, "name": str, "input": dict}
    usage: dict[str, int]       # {"input_tokens": int, "output_tokens": int}
    finish_reason: str
    error: str


class ProviderError(Exception):
    """Raised when a provider returns a non-retryable error."""

    def __init__(self, message: str, *, status: Optional[int] = None, retryable: bool = False) -> None:
        super().__init__(message)
        self.status = status
        self.retryable = retryable


class Provider(Protocol):
    """Common provider surface."""

    name: str

    def list_models(self) -> list[dict[str, Any]]:
        ...

    async def stream(
        self,
        *,
        model: str,
        system: str,
        messages: list[Message],
        tools: Optional[list[Tool]] = None,
        max_output_tokens: int = 4000,
    ) -> AsyncIterator[StreamEvent]:
        ...

    async def complete(
        self,
        *,
        model: str,
        system: str,
        messages: list[Message],
        tools: Optional[list[Tool]] = None,
        max_output_tokens: int = 4000,
    ) -> dict[str, Any]:
        """Non-streaming completion. Returns ``{"text": str, "tool_calls": list,
        "usage": {"input_tokens": int, "output_tokens": int}, "finish_reason": str}``.
        Useful for tests and the non-SSE path at P0.
        """
        ...
