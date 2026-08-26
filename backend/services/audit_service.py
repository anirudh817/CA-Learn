from __future__ import annotations

import json
from typing import Any, Optional

from database import AuditEvent


def record_audit(
    db,
    action_type: str,
    *,
    user_id: Optional[str] = None,
    workspace_id: Optional[str] = None,
    project_id: Optional[str] = None,
    run_id: Optional[str] = None,
    details: Optional[dict[str, Any]] = None,
) -> None:
    event = AuditEvent(
        user_id=user_id,
        workspace_id=workspace_id,
        project_id=project_id,
        run_id=run_id,
        action_type=action_type,
        details_json=json.dumps(details or {}, sort_keys=True),
    )
    db.add(event)
    db.commit()
