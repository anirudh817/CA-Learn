"""External-lookup dispatcher (P7).

One entry point — ``dispatch`` — runs a single external database lookup
through the full safety chain:

    unknown-tool guard → normalize args → cache → per-conversation hourly
    cap → per-workspace daily quota → circuit breaker → HTTP call (1 retry,
    timeout) → cache write + quota record

It NEVER raises. Every failure mode (timeout, quota, breaker open, HTTP
error) comes back as a ``DispatchResult`` with ``is_error`` set and a
``content`` string that tells the model to fall back to pipeline data and
general knowledge.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

import httpx
from sqlalchemy.orm import Session

from config import (
    AI_EXTERNAL_LOOKUP_MAX_CONCURRENCY,
    AI_EXTERNAL_LOOKUP_MAX_PER_CONV_PER_HOUR,
    AI_EXTERNAL_LOOKUP_TIMEOUT_S,
)

from . import cache as _cache
from . import quotas as _quotas
from .base import NOT_FOUND, OK, QUOTA_EXCEEDED, TIMEOUT, UNAVAILABLE, Adapter
from .pubmed import PubMedAdapter
from .reactome import ReactomeAdapter
from .string_db import StringAdapter
from .uniprot import UniProtAdapter

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Adapter registry
# ---------------------------------------------------------------------------

_ADAPTER_LIST: list[Adapter] = [
    UniProtAdapter(),
    ReactomeAdapter(),
    StringAdapter(),
    PubMedAdapter(),
]
ADAPTERS: dict[str, Adapter] = {a.tool_name: a for a in _ADAPTER_LIST}
EXTERNAL_TOOL_NAMES: set[str] = set(ADAPTERS.keys())


def external_tool_schemas() -> list[dict]:
    """Tool schemas to expose to the model when external lookups are on."""
    return [a.tool_schema() for a in _ADAPTER_LIST]


# ---------------------------------------------------------------------------
# Circuit breaker — 2 consecutive failures → open 60s
# ---------------------------------------------------------------------------

_BREAKER_THRESHOLD = 2
_BREAKER_COOLDOWN_S = 60.0


class _Breaker:
    def __init__(self) -> None:
        self.failures = 0
        self.opened_at = 0.0

    def is_open(self) -> bool:
        if self.failures < _BREAKER_THRESHOLD:
            return False
        # After the cooldown we allow a probe call (half-open).
        return (time.monotonic() - self.opened_at) < _BREAKER_COOLDOWN_S

    def record_success(self) -> None:
        self.failures = 0
        self.opened_at = 0.0

    def record_failure(self) -> None:
        self.failures += 1
        if self.failures >= _BREAKER_THRESHOLD:
            self.opened_at = time.monotonic()


_breakers: dict[str, _Breaker] = {}

# Per-conversation hourly cap — process-memory rolling window.
_conv_calls: dict[str, list[datetime]] = {}

# Shared HTTP client (lazy — pools connections across calls). Concurrency is
# bounded by httpx's own connection pool, so no extra semaphore is needed.
_client: Optional[httpx.AsyncClient] = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            timeout=AI_EXTERNAL_LOOKUP_TIMEOUT_S,
            limits=httpx.Limits(max_connections=max(1, AI_EXTERNAL_LOOKUP_MAX_CONCURRENCY)),
            headers={"User-Agent": "SignalFold/1.0 (proteomics analysis)"},
            follow_redirects=True,
        )
    return _client


def _check_conv_hourly(conversation_id: str) -> bool:
    """True if this conversation is under its hourly external-lookup cap."""
    cutoff = datetime.utcnow() - timedelta(hours=1)
    calls = [t for t in _conv_calls.get(conversation_id, []) if t >= cutoff]
    _conv_calls[conversation_id] = calls
    return len(calls) < AI_EXTERNAL_LOOKUP_MAX_PER_CONV_PER_HOUR


def _record_conv_hourly(conversation_id: str) -> None:
    _conv_calls.setdefault(conversation_id, []).append(datetime.utcnow())


# ---------------------------------------------------------------------------
# Result shape handed back to the streaming loop
# ---------------------------------------------------------------------------

@dataclass
class DispatchResult:
    name: str
    status: str = OK
    content: str = ""
    references: list[dict] = field(default_factory=list)
    cached: bool = False
    latency_ms: int = 0
    error_kind: Optional[str] = None    # quota_exceeded | circuit_open | timeout | unavailable | unknown

    @property
    def is_error(self) -> bool:
        return self.status not in (OK, NOT_FOUND)

    @property
    def rows_returned(self) -> int:
        return len(self.references)


def _fallback_note(reason: str) -> str:
    return (
        f"[external lookup unavailable] {reason} "
        "Answer the user from the pipeline run data and clearly-labelled "
        "general knowledge instead; do not invent an external result."
    )


async def _call_with_retry(adapter: Adapter, norm: dict):
    """Call the adapter at most twice, each bounded by a timeout."""
    last_exc: Optional[Exception] = None
    client = _get_client()
    for _ in range(2):
        try:
            return await asyncio.wait_for(
                adapter.fetch(norm, client),
                timeout=AI_EXTERNAL_LOOKUP_TIMEOUT_S + 1.0,
            )
        except asyncio.TimeoutError as exc:
            last_exc = exc
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
    raise last_exc if last_exc else RuntimeError("external lookup failed")


async def dispatch(
    db: Session,
    name: str,
    args: dict,
    *,
    workspace_id: str,
    conversation_id: str,
) -> DispatchResult:
    start = time.monotonic()

    def _elapsed() -> int:
        return int((time.monotonic() - start) * 1000)

    adapter = ADAPTERS.get(name)
    if adapter is None:
        return DispatchResult(
            name=name, status=UNAVAILABLE, error_kind="unknown",
            content=_fallback_note(f"'{name}' is not a known external lookup."),
            latency_ms=_elapsed(),
        )

    norm = adapter.normalize_args(args or {})
    key = _cache.cache_key(adapter.id, norm)

    # 1. Cache — free, never leaves the platform, no quota cost.
    cached = _cache.get(db, key)
    if cached is not None:
        return DispatchResult(
            name=name,
            status=cached.get("status", OK),
            content=cached.get("content", ""),
            references=cached.get("references", []),
            cached=True,
            latency_ms=_elapsed(),
        )

    # 2. Per-conversation hourly cap.
    if not _check_conv_hourly(conversation_id):
        return DispatchResult(
            name=name, status=UNAVAILABLE, error_kind="rate_limited",
            content=_fallback_note("This conversation hit its hourly external-lookup limit."),
            latency_ms=_elapsed(),
        )

    # 3. Per-workspace daily quota.
    allowed, used, limit = _quotas.check(db, workspace_id, adapter.id)
    if not allowed:
        return DispatchResult(
            name=name, status=QUOTA_EXCEEDED, error_kind="quota_exceeded",
            content=_fallback_note(f"The workspace reached its daily {adapter.id} quota ({limit})."),
            latency_ms=_elapsed(),
        )

    # 4. Circuit breaker.
    breaker = _breakers.setdefault(adapter.id, _Breaker())
    if breaker.is_open():
        return DispatchResult(
            name=name, status=UNAVAILABLE, error_kind="circuit_open",
            content=_fallback_note(f"{adapter.id} is temporarily unreachable after repeated failures."),
            latency_ms=_elapsed(),
        )

    # 5. HTTP call (1 retry, hard timeout).
    try:
        result = await _call_with_retry(adapter, norm)
    except asyncio.TimeoutError:
        breaker.record_failure()
        return DispatchResult(
            name=name, status=TIMEOUT, error_kind="timeout",
            content=_fallback_note(f"{adapter.id} did not respond in time."),
            latency_ms=_elapsed(),
        )
    except Exception as exc:  # noqa: BLE001
        breaker.record_failure()
        log.warning("external lookup %s failed: %s", adapter.id, exc)
        return DispatchResult(
            name=name, status=UNAVAILABLE, error_kind="unavailable",
            content=_fallback_note(f"{adapter.id} lookup failed."),
            latency_ms=_elapsed(),
        )

    # Adapter returned a structured result. A transport-style failure still
    # trips the breaker; a clean not_found / ok does not.
    if result.status in (UNAVAILABLE, TIMEOUT):
        breaker.record_failure()
        return DispatchResult(
            name=name, status=result.status,
            error_kind=result.status,
            content=_fallback_note(result.reason or f"{adapter.id} unavailable."),
            latency_ms=_elapsed(),
        )

    breaker.record_success()
    _quotas.record(db, workspace_id, adapter.id)
    _record_conv_hourly(conversation_id)

    response_payload = {
        "status": result.status,
        "content": result.content,
        "references": result.references_as_dicts(),
    }
    _cache.put(db, key, adapter.id, norm, response_payload)

    return DispatchResult(
        name=name,
        status=result.status,
        content=result.content or (result.reason if result.status == NOT_FOUND else ""),
        references=result.references_as_dicts(),
        cached=False,
        latency_ms=_elapsed(),
    )
