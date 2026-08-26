"""Resolve an API key for a (user, workspace, provider) tuple.

Precedence:
    1. User-supplied key (UserAISettings.encrypted_keys_json)
    2. Workspace-supplied key (WorkspaceAISettings.encrypted_keys_json)
    3. Platform env var (ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY)

When the resolved source is "platform", record_platform_usage() enforces a
per-user daily quota. PlatformQuotaExceeded is raised; routes translate to
HTTP 429 with a BYOK hint.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal, Optional

from sqlalchemy.orm import Session

from config import (
    AI_PLATFORM_DAILY_REQS,
    AI_PLATFORM_DAILY_TOKENS,
    ANTHROPIC_API_KEY,
)
from database import UserAISettings, WorkspaceAISettings

from . import crypto

KeySource = Literal["user", "workspace", "platform", "missing"]
# v1 only registers Anthropic. The Literal is narrow on purpose — adding a
# provider means widening this and the PLATFORM_ENV_KEYS table.
ProviderName = Literal["anthropic"]

PLATFORM_ENV_KEYS: dict[ProviderName, str] = {
    "anthropic": ANTHROPIC_API_KEY,
}


class PlatformQuotaExceeded(Exception):
    """Raised when a user has exhausted the platform-provided key daily quota."""

    def __init__(self, *, limit_tokens: int, limit_reqs: int, resets_at: datetime):
        self.limit_tokens = limit_tokens
        self.limit_reqs = limit_reqs
        self.resets_at = resets_at
        super().__init__("Daily platform AI quota exceeded")


@dataclass
class ResolvedKey:
    key: str
    source: KeySource


def _user_settings(db: Session, user_id: str) -> UserAISettings:
    row = db.query(UserAISettings).filter(UserAISettings.user_id == user_id).first()
    if row is None:
        row = UserAISettings(user_id=user_id)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def _workspace_settings(db: Session, workspace_id: str) -> WorkspaceAISettings:
    row = db.query(WorkspaceAISettings).filter(
        WorkspaceAISettings.workspace_id == workspace_id
    ).first()
    if row is None:
        row = WorkspaceAISettings(workspace_id=workspace_id)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def resolve_key(
    db: Session,
    *,
    user_id: str,
    workspace_id: Optional[str],
    provider: ProviderName,
) -> ResolvedKey:
    user_keys = crypto.decrypt_dict(_user_settings(db, user_id).encrypted_keys_json)
    if (key := user_keys.get(provider)):
        return ResolvedKey(key=key, source="user")

    if workspace_id:
        ws_keys = crypto.decrypt_dict(_workspace_settings(db, workspace_id).encrypted_keys_json)
        if (key := ws_keys.get(provider)):
            return ResolvedKey(key=key, source="workspace")

    platform = PLATFORM_ENV_KEYS.get(provider, "")
    if platform:
        return ResolvedKey(key=platform, source="platform")

    return ResolvedKey(key="", source="missing")


def has_any_key(db: Session, *, user_id: str, workspace_id: Optional[str]) -> dict[ProviderName, KeySource]:
    """Return per-provider source for status display."""
    out: dict[ProviderName, KeySource] = {}
    for provider in ("anthropic",):  # type: ignore[assignment]
        out[provider] = resolve_key(
            db, user_id=user_id, workspace_id=workspace_id, provider=provider
        ).source
    return out


class InvalidKeyFormat(ValueError):
    """Raised when a saved key fails basic format validation."""


def _validate_key_format(provider: ProviderName, key: str) -> str:
    """Strip whitespace and validate basic prefix shape. Returns the cleaned
    key. Raises InvalidKeyFormat on obvious problems."""
    cleaned = (key or "").strip()
    if not cleaned:
        return cleaned
    if provider == "anthropic" and not cleaned.startswith("sk-ant-"):
        raise InvalidKeyFormat(
            "Anthropic API keys start with 'sk-ant-'. Double-check what you pasted — "
            "it looks like the wrong format."
        )
    if len(cleaned) < 20:
        raise InvalidKeyFormat(
            "That key looks too short to be valid — did the paste get truncated?"
        )
    # Anthropic keys contain only printable ASCII; reject anything weird.
    if any(ord(c) < 0x21 or ord(c) > 0x7E for c in cleaned):
        raise InvalidKeyFormat(
            "Key contains unprintable or non-ASCII characters — re-copy and paste."
        )
    return cleaned


def set_user_key(db: Session, user_id: str, provider: ProviderName, key: Optional[str]) -> None:
    """Set or clear a single provider key on the user record (encrypted).
    Whitespace is trimmed and basic format is validated before storage."""
    settings = _user_settings(db, user_id)
    keys = crypto.decrypt_dict(settings.encrypted_keys_json)
    if key:
        cleaned = _validate_key_format(provider, key)
        if cleaned:
            keys[provider] = cleaned
        else:
            keys.pop(provider, None)
    else:
        keys.pop(provider, None)
        # Also clear the label when the key is cleared.
        labels = _decode_labels(settings.key_labels_json)
        labels.pop(provider, None)
        settings.key_labels_json = json.dumps(labels)
    settings.encrypted_keys_json = crypto.encrypt_dict(keys)
    settings.updated_at = datetime.utcnow()
    db.add(settings)
    db.commit()
    # Bust the provider-client cache for this key so a corrected key takes
    # effect immediately instead of reusing the old cached httpx client.
    try:
        from .dispatcher import _cached_provider  # type: ignore[attr-defined]
        _cached_provider.cache_clear()
    except Exception:  # pragma: no cover - defensive
        pass


def _decode_labels(raw: Optional[str]) -> dict:
    if not raw:
        return {}
    try:
        loaded = json.loads(raw)
        return loaded if isinstance(loaded, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def set_user_key_label(db: Session, user_id: str, provider: ProviderName, label: Optional[str]) -> None:
    """Set or clear a user-supplied label for a provider key."""
    settings = _user_settings(db, user_id)
    labels = _decode_labels(settings.key_labels_json)
    label = (label or "").strip()[:60] if label else ""
    if label:
        labels[provider] = label
    else:
        labels.pop(provider, None)
    settings.key_labels_json = json.dumps(labels)
    settings.updated_at = datetime.utcnow()
    db.add(settings)
    db.commit()


def get_user_key_labels(db: Session, user_id: str) -> dict:
    settings = _user_settings(db, user_id)
    return _decode_labels(settings.key_labels_json)


def mask_key(key: str) -> str:
    """Return a visual preview of an API key — first 7 + last 4 chars,
    middle replaced with bullets. Returns empty string for empty input.
    Example: 'sk-ant-…XXXX' → 'sk-ant-•••XXXX'.
    """
    if not key:
        return ""
    if len(key) <= 11:
        return "•" * len(key)
    head = key[:7]
    tail = key[-4:]
    return f"{head}•••••{tail}"


def set_user_default(db: Session, user_id: str, *, provider: Optional[str], model: Optional[str]) -> None:
    settings = _user_settings(db, user_id)
    if provider is not None:
        settings.default_provider = provider
    if model is not None:
        settings.default_model = model
    settings.updated_at = datetime.utcnow()
    db.add(settings)
    db.commit()


def set_workspace_key(
    db: Session, workspace_id: str, provider: ProviderName, key: Optional[str]
) -> None:
    settings = _workspace_settings(db, workspace_id)
    keys = crypto.decrypt_dict(settings.encrypted_keys_json)
    if key:
        keys[provider] = key
    else:
        keys.pop(provider, None)
    settings.encrypted_keys_json = crypto.encrypt_dict(keys)
    settings.updated_at = datetime.utcnow()
    db.add(settings)
    db.commit()


def _start_of_today_utc() -> datetime:
    now = datetime.utcnow()
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def _next_quota_reset(now: Optional[datetime] = None) -> datetime:
    base = (now or datetime.utcnow()).replace(hour=0, minute=0, second=0, microsecond=0)
    return base + timedelta(days=1)


def quota_status(db: Session, user_id: str) -> dict:
    settings = _user_settings(db, user_id)
    if settings.platform_quota_reset_at <= datetime.utcnow():
        settings.platform_tokens_used_today = 0
        settings.platform_reqs_used_today = 0
        settings.platform_quota_reset_at = _next_quota_reset()
        db.add(settings)
        db.commit()
    return {
        "tokens_used": settings.platform_tokens_used_today,
        "tokens_limit": AI_PLATFORM_DAILY_TOKENS,
        "reqs_used": settings.platform_reqs_used_today,
        "reqs_limit": AI_PLATFORM_DAILY_REQS,
        "resets_at": settings.platform_quota_reset_at.isoformat() + "Z",
    }


def check_platform_quota(db: Session, user_id: str) -> None:
    """Raise PlatformQuotaExceeded if a NEW platform request would exceed limits."""
    status = quota_status(db, user_id)
    if status["reqs_used"] >= status["reqs_limit"]:
        raise PlatformQuotaExceeded(
            limit_tokens=status["tokens_limit"],
            limit_reqs=status["reqs_limit"],
            resets_at=datetime.fromisoformat(status["resets_at"].rstrip("Z")),
        )


def record_platform_usage(db: Session, user_id: str, *, input_tokens: int, output_tokens: int) -> None:
    settings = _user_settings(db, user_id)
    if settings.platform_quota_reset_at <= datetime.utcnow():
        settings.platform_tokens_used_today = 0
        settings.platform_reqs_used_today = 0
        settings.platform_quota_reset_at = _next_quota_reset()
    settings.platform_reqs_used_today += 1
    settings.platform_tokens_used_today += int(input_tokens) + int(output_tokens)
    settings.updated_at = datetime.utcnow()
    db.add(settings)
    db.commit()
