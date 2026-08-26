from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from config import (
    APP_ENV,
    AUTH_MODE,
    ENABLE_LOCAL_BOOTSTRAP,
    LOCAL_BOOTSTRAP_DISPLAY_NAME,
    LOCAL_BOOTSTRAP_EMAIL,
    LOCAL_BOOTSTRAP_PASSWORD,
    LOCAL_BOOTSTRAP_PROJECT_NAME,
    LOCAL_BOOTSTRAP_WORKSPACE_NAME,
)
from database import Membership, Project, User, Workspace, WorkspaceRole, get_db
from deps import get_current_user
from schemas import LoginRequest, RegisterRequest, SessionResponse
from security import hash_password, issue_session, verify_password
from services.audit_service import record_audit
from utils import slugify

router = APIRouter()


def _workspace_payloads(db: Session, user_id: str):
    memberships = db.query(Membership, Workspace).join(Workspace, Workspace.id == Membership.workspace_id).filter(
        Membership.user_id == user_id
    ).all()
    return [
        {"id": workspace.id, "name": workspace.name, "slug": workspace.slug, "role": membership.role.value}
        for membership, workspace in memberships
    ]


@router.get("/auth/runtime")
def runtime_status():
    from services.ai.providers.catalog import PROVIDER_CATALOG, default_model_for
    from services.ai_service import get_provider_status

    ai_status = get_provider_status()
    return {
        "app_env": APP_ENV,
        "auth_mode": AUTH_MODE,
        "local_bootstrap_enabled": ENABLE_LOCAL_BOOTSTRAP,
        "ai": ai_status,
        "ai_providers": {
            pid: {
                "label": entry["label"],
                "default_model": default_model_for(pid),
                "platform_configured": ai_status["platform_keys"].get(pid, False),
            }
            for pid, entry in PROVIDER_CATALOG.items()
        },
    }


@router.post("/auth/register", response_model=SessionResponse)
def register(req: RegisterRequest, db: Session = Depends(get_db)):
    existing = db.query(User).filter(User.email == req.email.lower().strip()).first()
    if existing:
        raise HTTPException(status_code=409, detail="User already exists")

    user = User(
        id=secrets.token_hex(12),
        email=req.email.lower().strip(),
        password_hash=hash_password(req.password),
        display_name=req.display_name.strip(),
    )
    db.add(user)
    workspace_name = (req.workspace_name or f"{req.display_name.strip()} Workspace").strip()
    workspace = Workspace(
        id=secrets.token_hex(12),
        name=workspace_name,
        slug=slugify(workspace_name),
        created_by=user.id,
    )
    db.add(workspace)
    db.add(Membership(id=secrets.token_hex(12), user_id=user.id, workspace_id=workspace.id, role=WorkspaceRole.ADMIN))
    default_project = Project(
        id=secrets.token_hex(12),
        workspace_id=workspace.id,
        name="General",
        slug="general",
        description="Default project",
        created_by=user.id,
    )
    db.add(default_project)
    db.commit()
    token, _ = issue_session(db, user.id)
    record_audit(db, "auth.register", user_id=user.id, workspace_id=workspace.id, details={"email": user.email})
    return SessionResponse(
        token=token,
        user={"id": user.id, "email": user.email, "display_name": user.display_name},
        workspaces=[{"id": workspace.id, "name": workspace.name, "slug": workspace.slug, "role": WorkspaceRole.ADMIN.value}],
    )


@router.post("/auth/login", response_model=SessionResponse)
def login(req: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == req.email.lower().strip(), User.is_active.is_(True)).first()
    if not user or not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token, _ = issue_session(db, user.id)
    return SessionResponse(
        token=token,
        user={"id": user.id, "email": user.email, "display_name": user.display_name},
        workspaces=_workspace_payloads(db, user.id),
    )


@router.get("/auth/me")
def me(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return {
        "user": {
            "id": current_user.id,
            "email": current_user.email,
            "display_name": current_user.display_name,
        },
        "workspaces": _workspace_payloads(db, current_user.id),
    }


@router.post("/auth/bootstrap-local", response_model=SessionResponse)
def bootstrap_local(db: Session = Depends(get_db)):
    if AUTH_MODE != "local_bootstrap" or not ENABLE_LOCAL_BOOTSTRAP:
        raise HTTPException(status_code=404, detail="Local bootstrap disabled")
    user = db.query(User).filter(User.email == LOCAL_BOOTSTRAP_EMAIL.lower().strip()).first()
    if not user:
        user = User(
            id=secrets.token_hex(12),
            email=LOCAL_BOOTSTRAP_EMAIL.lower().strip(),
            password_hash=hash_password(LOCAL_BOOTSTRAP_PASSWORD),
            display_name=LOCAL_BOOTSTRAP_DISPLAY_NAME,
        )
        db.add(user)
        workspace = Workspace(
            id=secrets.token_hex(12),
            name=LOCAL_BOOTSTRAP_WORKSPACE_NAME,
            slug=slugify(LOCAL_BOOTSTRAP_WORKSPACE_NAME),
            created_by=user.id,
        )
        db.add(workspace)
        db.add(Membership(id=secrets.token_hex(12), user_id=user.id, workspace_id=workspace.id, role=WorkspaceRole.ADMIN))
        db.add(
            Project(
                id=secrets.token_hex(12),
                workspace_id=workspace.id,
                name=LOCAL_BOOTSTRAP_PROJECT_NAME,
                slug=slugify(LOCAL_BOOTSTRAP_PROJECT_NAME),
                description="Default project",
                created_by=user.id,
            )
        )
        db.commit()
    token, _ = issue_session(db, user.id)
    return SessionResponse(
        token=token,
        user={"id": user.id, "email": user.email, "display_name": user.display_name},
        workspaces=_workspace_payloads(db, user.id),
    )
