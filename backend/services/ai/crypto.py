"""Symmetric encryption for BYOK API keys.

The key material is derived from SESSION_SECRET (already required by the auth
layer). We sha256 the secret then base64url-encode to produce a 32-byte
Fernet key. This keeps the deployment surface minimal — no extra secret to
rotate beyond SESSION_SECRET.

Failure mode: a corrupted or wrong-secret blob returns an empty dict rather
than raising, so a SESSION_SECRET rotation doesn't break the app; it just
makes the user re-paste their key.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from config import SESSION_SECRET

log = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    digest = hashlib.sha256(SESSION_SECRET.encode("utf-8")).digest()
    key = base64.urlsafe_b64encode(digest)
    return Fernet(key)


def encrypt_dict(payload: dict) -> str:
    """Serialize and encrypt a dict. Returns base64 ciphertext string."""
    raw = json.dumps(payload, sort_keys=True).encode("utf-8")
    return _fernet().encrypt(raw).decode("utf-8")


def decrypt_dict(blob: str) -> dict:
    """Decrypt and deserialize. Returns {} on any failure (fail-closed)."""
    if not blob:
        return {}
    try:
        raw = _fernet().decrypt(blob.encode("utf-8"))
        loaded = json.loads(raw.decode("utf-8"))
        return loaded if isinstance(loaded, dict) else {}
    except (InvalidToken, ValueError, json.JSONDecodeError) as exc:
        log.warning("decrypt_dict failed (rotated secret or corrupted blob): %s", exc)
        return {}


def detect_provider_from_key(key: str) -> str | None:
    """Best-effort provider auto-detection from key prefix.

    v1 only recognizes Anthropic. Other prefixes return None and the
    caller treats them as unknown (the UI rejects the key in v1 — no
    OpenAI / Google in v1)."""
    if not key:
        return None
    key = key.strip()
    if key.startswith("sk-ant-"):
        return "anthropic"
    return None
