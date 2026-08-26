from __future__ import annotations

import secrets
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session

from database import Project, Run, ShareLink, ShareScope, User, get_db
from deps import get_current_user, require_workspace_access
from schemas import ShareLinkCreateRequest
from security import find_session
from services.audit_service import record_audit

router = APIRouter()


@router.post("/share-links")
def create_share_link(
    req: ShareLinkCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_workspace_access(db, current_user.id, req.workspace_id)
    if not req.run_id and not req.project_id:
        raise HTTPException(status_code=400, detail="Run or project share target required")
    if req.run_id:
        run = db.query(Run).filter(Run.id == req.run_id).first()
        if not run or run.workspace_id != req.workspace_id:
            raise HTTPException(status_code=404, detail="Run not found in this workspace")
    if req.project_id:
        project = db.query(Project).filter(Project.id == req.project_id).first()
        if not project or project.workspace_id != req.workspace_id:
            raise HTTPException(status_code=404, detail="Project not found in this workspace")
    scope = ShareScope.RUN if req.run_id else ShareScope.PROJECT
    link = ShareLink(
        id=secrets.token_hex(12),
        workspace_id=req.workspace_id,
        project_id=req.project_id,
        run_id=req.run_id,
        scope=scope,
        title=req.title,
        token=secrets.token_urlsafe(18),
        auth_required=req.auth_required,
        expires_at=req.expires_at,
        created_by=current_user.id,
    )
    db.add(link)
    db.commit()
    record_audit(db, "share_link.created", user_id=current_user.id, workspace_id=req.workspace_id, project_id=req.project_id, run_id=req.run_id, details={"scope": scope.value, "title": req.title})
    return {"id": link.id, "token": link.token, "scope": link.scope.value, "title": link.title, "auth_required": link.auth_required}


@router.get("/share-links")
def list_share_links(workspace_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    require_workspace_access(db, current_user.id, workspace_id)
    links = db.query(ShareLink).filter(ShareLink.workspace_id == workspace_id).order_by(ShareLink.created_at.desc()).all()
    return [
        {
            "id": link.id,
            "title": link.title,
            "scope": link.scope.value,
            "run_id": link.run_id,
            "project_id": link.project_id,
            "token": link.token,
            "auth_required": link.auth_required,
        }
        for link in links
    ]


@router.get("/share-links/{token}")
def resolve_share_link(
    token: str,
    db: Session = Depends(get_db),
    authorization: Optional[str] = Header(default=None),
    x_session_token: Optional[str] = Header(default=None),
    session_token_param: Optional[str] = Query(default=None, alias="session_token"),
):
    link = db.query(ShareLink).filter(ShareLink.token == token).first()
    if not link:
        raise HTTPException(status_code=404, detail="Share link not found")

    # SEC-03: Enforce expiry
    if link.expires_at and link.expires_at < datetime.utcnow():
        raise HTTPException(status_code=410, detail="Share link has expired")

    # SEC-03: Enforce auth_required
    if link.auth_required:
        raw_token = x_session_token or session_token_param
        if authorization and authorization.lower().startswith("bearer "):
            raw_token = authorization.split(" ", 1)[1].strip()
        if not raw_token or not find_session(db, raw_token):
            raise HTTPException(status_code=401, detail="This share link requires authentication")

    run = None
    if link.run_id:
        run = db.query(Run).filter(Run.id == link.run_id).first()
        # Ensure the run actually belongs to the link's workspace
        if run and run.workspace_id != link.workspace_id:
            run = None  # Don't leak cross-workspace run data
    return {
        "id": link.id,
        "title": link.title,
        "scope": link.scope.value,
        "workspace_id": link.workspace_id,
        "project_id": link.project_id,
        "run": {
            "id": run.id,
            "name": run.name,
            "status": run.status.value if hasattr(run.status, "value") else run.status,
            "file_name": run.file_name,
        }
        if run
        else None,
    }
