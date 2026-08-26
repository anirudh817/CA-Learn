"""SHA-256 response cache for external lookups (P7).

Identical lookups (same adapter + same normalized args) reuse a stored
response for ``AI_EXTERNAL_LOOKUP_CACHE_TTL_HOURS``. Cache hits do NOT count
toward quotas — they never leave the platform.
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from config import AI_EXTERNAL_LOOKUP_CACHE_TTL_HOURS
from database import ExternalLookupCache

log = logging.getLogger(__name__)


def cache_key(adapter_id: str, normalized_args: dict) -> str:
    payload = adapter_id + ":" + json.dumps(normalized_args, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def get(db: Session, key: str) -> Optional[dict]:
    """Return the cached response dict, or None on miss / expiry."""
    try:
        row = db.query(ExternalLookupCache).filter(ExternalLookupCache.cache_key == key).first()
        if row is None:
            return None
        if row.expires_at < datetime.utcnow():
            return None
        row.hit_count = (row.hit_count or 0) + 1
        db.add(row)
        db.commit()
        return json.loads(row.response_json)
    except Exception as exc:  # cache must never break a lookup
        log.debug("external lookup cache get failed: %s", exc)
        return None


def put(db: Session, key: str, adapter_id: str, normalized_args: dict, response: dict) -> None:
    now = datetime.utcnow()
    expires = now + timedelta(hours=AI_EXTERNAL_LOOKUP_CACHE_TTL_HOURS)
    try:
        existing = db.query(ExternalLookupCache).filter(ExternalLookupCache.cache_key == key).first()
        if existing is not None:
            existing.response_json = json.dumps(response)
            existing.fetched_at = now
            existing.expires_at = expires
            db.add(existing)
        else:
            db.add(ExternalLookupCache(
                cache_key=key,
                adapter=adapter_id,
                args_json=json.dumps(normalized_args),
                response_json=json.dumps(response),
                fetched_at=now,
                expires_at=expires,
                hit_count=0,
            ))
        db.commit()
    except Exception as exc:
        log.debug("external lookup cache put failed: %s", exc)
        db.rollback()
