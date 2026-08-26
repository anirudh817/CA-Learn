"""Thin facade kept for backwards compatibility with /api/auth/runtime.

The real chat logic now lives under :mod:`services.ai`. This module re-exports
``get_provider_status`` so the auth runtime endpoint and the deprecated
``/api/ai/query`` shim don't need to know about the new layout.

Anything older that imported from ``services.ai_service`` will continue to
import cleanly; the legacy AnthropicProvider / DisabledProvider classes have
been removed and replaced with a small status helper.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

from config import ANTHROPIC_API_KEY


def get_provider_status(db: Optional[Session] = None, user_id: Optional[str] = None) -> dict:
    """Lightweight status for runtime endpoint when no DB session / user is available.

    The richer per-provider status (including BYOK source) is exposed by
    :func:`services.ai.dispatcher.provider_status_summary` and surfaced via
    ``/api/settings/ai``. This helper is intentionally cheap so the public
    runtime endpoint stays unauthenticated.
    """
    configured = {"anthropic": bool(ANTHROPIC_API_KEY)}
    any_configured = any(configured.values())
    return {
        "provider": "anthropic",
        "available": any_configured,
        "status": "configured" if any_configured else "disabled",
        "reason": None if any_configured else "missing_api_key",
        "setup_hint": (
            None
            if any_configured
            else "Paste an Anthropic API key in Settings → AI to enable chat. No env var needed."
        ),
        "platform_keys": configured,
    }
