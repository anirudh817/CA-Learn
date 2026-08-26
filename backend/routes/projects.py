from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import Project, User, get_db
from deps import get_current_user, require_workspace_access
from schemas import ProjectCreateRequest
from services.audit_service import record_audit
from utils import slugify

router = APIRouter()


@router.get("/projects")
def list_projects(workspace_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    require_workspace_access(db, current_user.id, workspace_id)
    projects = db.query(Project).filter(Project.workspace_id == workspace_id).order_by(Project.created_at.desc()).all()
    return [
        {"id": project.id, "workspace_id": project.workspace_id, "name": project.name, "slug": project.slug, "description": project.description}
        for project in projects
    ]


@router.post("/projects")
def create_project(
    req: ProjectCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_workspace_access(db, current_user.id, req.workspace_id)
    slug = slugify(req.name)
    existing = db.query(Project).filter(Project.workspace_id == req.workspace_id, Project.slug == slug).first()
    if existing:
        raise HTTPException(status_code=409, detail="Project already exists")
    project = Project(
        id=secrets.token_hex(12),
        workspace_id=req.workspace_id,
        name=req.name.strip(),
        slug=slug,
        description=req.description.strip(),
        created_by=current_user.id,
    )
    db.add(project)
    db.commit()
    record_audit(db, "project.created", user_id=current_user.id, workspace_id=req.workspace_id, project_id=project.id, details={"name": project.name})
    return {"id": project.id, "workspace_id": project.workspace_id, "name": project.name, "slug": project.slug, "description": project.description}
