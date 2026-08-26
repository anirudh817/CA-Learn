from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import Membership, Project, User, Workspace, WorkspaceRole, get_db
from deps import get_current_user
from schemas import WorkspaceCreateRequest
from services.audit_service import record_audit
from utils import slugify

router = APIRouter()


@router.get("/workspaces")
def list_workspaces(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    memberships = db.query(Membership, Workspace).join(Workspace, Workspace.id == Membership.workspace_id).filter(
        Membership.user_id == current_user.id
    ).all()
    return [
        {"id": workspace.id, "name": workspace.name, "slug": workspace.slug, "role": membership.role.value}
        for membership, workspace in memberships
    ]


@router.post("/workspaces")
def create_workspace(
    req: WorkspaceCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    workspace = Workspace(
        id=secrets.token_hex(12),
        name=req.name.strip(),
        slug=slugify(req.name),
        created_by=current_user.id,
    )
    db.add(workspace)
    db.add(Membership(id=secrets.token_hex(12), user_id=current_user.id, workspace_id=workspace.id, role=WorkspaceRole.ADMIN))
    db.add(Project(id=secrets.token_hex(12), workspace_id=workspace.id, name="General", slug="general", description="Default project", created_by=current_user.id))
    db.commit()
    record_audit(db, "workspace.created", user_id=current_user.id, workspace_id=workspace.id, details={"name": workspace.name})
    return {"id": workspace.id, "name": workspace.name, "slug": workspace.slug, "role": WorkspaceRole.ADMIN.value}
