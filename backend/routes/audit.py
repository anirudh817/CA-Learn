from __future__ import annotations

import json
import math
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from database import AuditEvent, User, get_db
from deps import get_current_user, require_workspace_access

router = APIRouter()


@router.get("/audit")
def list_audit_events(
    workspace_id: str,
    project_id: Optional[str] = None,
    run_id: Optional[str] = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=250),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_workspace_access(db, current_user.id, workspace_id)
    query = db.query(AuditEvent).filter(AuditEvent.workspace_id == workspace_id)
    if project_id:
        query = query.filter(AuditEvent.project_id == project_id)
    if run_id:
        query = query.filter(AuditEvent.run_id == run_id)
    total = query.count()
    page_size = max(1, min(page_size, 250))
    page = max(1, page)
    offset = (page - 1) * page_size
    events = query.order_by(AuditEvent.created_at.desc()).offset(offset).limit(page_size).all()
    return {
        "events": [
            {
                "id": event.id,
                "action_type": event.action_type,
                "workspace_id": event.workspace_id,
                "project_id": event.project_id,
                "run_id": event.run_id,
                "user_id": event.user_id,
                "created_at": event.created_at.isoformat(),
                "details": json.loads(event.details_json or "{}"),
            }
            for event in events
        ],
        "page": page,
        "page_size": page_size,
        "total": total,
        "total_pages": max(1, math.ceil(total / page_size)) if total else 1,
    }
