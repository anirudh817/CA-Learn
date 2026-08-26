"""Provider client cache and default-provider selection.

v1 only registers Anthropic. The dict-of-providers shape is preserved so
adding OpenAI / Google later is a single-line entry in ``_PROVIDER_CLASSES``
plus the matching ``*_provider.py`` module.

Clients are expensive to construct (each holds an httpx connection pool),
so we cache by (provider, sha256(key)). Rotating a key flushes the
corresponding cache entry automatically because the cache key changes.
"""
from __future__ import annotations

import hashlib
from functools import lru_cache
from typing import Optional

from sqlalchemy.orm import Session

from .key_resolver import has_any_key, resolve_key, ProviderName
from .providers.anthropic_provider import AnthropicProvider
from .providers.base import Provider, ProviderError
from .providers.catalog import PROVIDER_CATALOG, default_model_for


_PROVIDER_CLASSES = {
    "anthropic": AnthropicProvider,
}


@lru_cache(maxsize=64)
def _cached_provider(provider: str, key_digest: str, raw_key: str) -> Provider:
    cls = _PROVIDER_CLASSES.get(provider)
    if cls is None:
        raise ProviderError(
            f"Provider '{provider}' is not enabled in this build. "
            "Only 'anthropic' is supported in v1.",
            status=400,
        )
    return cls(api_key=raw_key)


def get_provider(provider: str, api_key: str) -> Provider:
    if not api_key:
        raise ProviderError(f"No API key available for provider '{provider}'", status=401)
    digest = hashlib.sha256(api_key.encode("utf-8")).hexdigest()
    return _cached_provider(provider, digest, api_key)


def security_provider(fallback: Provider, *, security_key: Optional[str] = None) -> Provider:
    """Provider for the LLM safety judges.

    The judges fail OPEN, so if their provider is starved (rate-limit, quota,
    outage) the gate silently allows. Running them on the chat key couples that
    risk to chat load — and lets a BYOK user throttle their OWN key to bypass
    the gate. When ``AI_SECURITY_ANTHROPIC_API_KEY`` is configured the judges
    run on that dedicated key/quota instead, independent of chat. When unset,
    fall back to the chat provider so existing deployments are unchanged.

    The dedicated key is always resolved as Anthropic — the judges are
    Haiku-only regardless of which provider the chat uses.

    ``security_key`` overrides the config lookup (tests); ``""`` forces
    fallback. The config value is read dynamically so it stays patchable.
    """
    import config

    key = security_key if security_key is not None else getattr(config, "AI_SECURITY_ANTHROPIC_API_KEY", "")
    key = (key or "").strip()  # a whitespace-only env value is a misconfig, not a key
    if not key:
        return fallback
    # This call is evaluated OUTSIDE the judge's internal fail-open guard, so it
    # must never raise — a broken dedicated key must degrade to the chat provider
    # (and let the judge run there), never break the chat turn.
    try:
        return get_provider("anthropic", key)
    except Exception as exc:  # noqa: BLE001 — fail open onto the chat provider
        import logging

        logging.getLogger(__name__).warning(
            "Dedicated security provider unavailable, falling back to chat provider: %s", exc
        )
        return fallback


def select_default_provider(
    db: Session,
    *,
    user_id: str,
    workspace_id: Optional[str],
    fallback: str = "anthropic",
) -> str:
    """Return the provider to use when the caller didn't specify one.

    In v1 only Anthropic is registered, so this collapses to "anthropic"
    in practice. The full resolution flow is kept so future multi-provider
    additions Just Work.
    """
    from database import UserAISettings

    user_settings = db.query(UserAISettings).filter(UserAISettings.user_id == user_id).first()
    sources = has_any_key(db, user_id=user_id, workspace_id=workspace_id)

    preferred = (user_settings.default_provider if user_settings else "") or ""
    if preferred in PROVIDER_CATALOG and sources.get(preferred, "missing") != "missing":
        return preferred

    for candidate in PROVIDER_CATALOG.keys():
        if sources.get(candidate, "missing") != "missing":
            return candidate

    return fallback


def select_model(db: Session, *, user_id: str, provider: str, requested: Optional[str]) -> str:
    """Pick the model for a turn: explicit > user default > catalog default."""
    if requested:
        return requested
    from database import UserAISettings

    user_settings = db.query(UserAISettings).filter(UserAISettings.user_id == user_id).first()
    if user_settings and user_settings.default_model:
        return user_settings.default_model
    return default_model_for(provider)


def provider_status_summary(db: Session, *, user_id: str, workspace_id: Optional[str]) -> dict:
    """Used by /api/auth/runtime and Settings drawer to surface which providers are configured."""
    sources = has_any_key(db, user_id=user_id, workspace_id=workspace_id)
    return {
        provider: {
            "configured": source != "missing",
            "source": source,
            "label": PROVIDER_CATALOG[provider]["label"],
            "default_model": default_model_for(provider),
        }
        for provider, source in sources.items()
    }
