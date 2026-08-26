"""Per-workspace daily quotas for external lookups (P7).

Each workspace gets a rolling daily cap per adapter. Defaults live here;
a workspace admin can override via ``WorkspaceAISettings.daily_quotas_json``.
Cache hits never reach this module, so they don't consume quota.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime

from sqlalchemy.orm import Session

from database import ExternalLookupQuotaUsage, WorkspaceAISettings

log = logging.getLogger(__name__)

DEFAULT_DAILY_LIMITS = {
    "uniprot": 5000,
    "reactome": 5000,
    "string": 1000,
    "pubmed": 500,
}


def _today() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d")


def daily_limit(db: Session, workspace_id: str, adapter_id: str) -> int:
    ws = (
        db.query(WorkspaceAISettings)
        .filter(WorkspaceAISettings.workspace_id == workspace_id)
        .first()
    )
    if ws and ws.daily_quotas_json:
        try:
            override = json.loads(ws.daily_quotas_json)
            if isinstance(override, dict) and adapter_id in override:
                return int(override[adapter_id])
        except Exception:
            pass
    return DEFAULT_DAILY_LIMITS.get(adapter_id, 1000)


def check(db: Session, workspace_id: str, adapter_id: str) -> tuple[bool, int, int]:
    """Return ``(allowed, used_today, limit)`` without mutating anything."""
    limit = daily_limit(db, workspace_id, adapter_id)
    row = (
        db.query(ExternalLookupQuotaUsage)
        .filter(
            ExternalLookupQuotaUsage.workspace_id == workspace_id,
            ExternalLookupQuotaUsage.adapter == adapter_id,
            ExternalLookupQuotaUsage.day == _today(),
        )
        .first()
    )
    used = row.call_count if row else 0
    return (used < limit, used, limit)


def record(db: Session, workspace_id: str, adapter_id: str) -> None:
    """Increment today's usage counter for ``(workspace, adapter)``."""
    try:
        row = (
            db.query(ExternalLookupQuotaUsage)
            .filter(
                ExternalLookupQuotaUsage.workspace_id == workspace_id,
                ExternalLookupQuotaUsage.adapter == adapter_id,
                ExternalLookupQuotaUsage.day == _today(),
            )
            .first()
        )
        if row is not None:
            row.call_count = (row.call_count or 0) + 1
        else:
            row = ExternalLookupQuotaUsage(
                workspace_id=workspace_id,
                adapter=adapter_id,
                day=_today(),
                call_count=1,
            )
        db.add(row)
        db.commit()
    except Exception as exc:
        log.debug("external lookup quota record failed: %s", exc)
        db.rollback()
