from __future__ import annotations

from typing import Optional

from fastapi import Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session

from database import Membership, User, Workspace, get_db
from security import find_session


def get_current_user(
    authorization: Optional[str] = Header(default=None),
    x_session_token: Optional[str] = Header(default=None),
    session_token: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
) -> User:
    raw_token = x_session_token or session_token
    if authorization and authorization.lower().startswith("bearer "):
        raw_token = authorization.split(" ", 1)[1].strip()
    if not raw_token:
        raise HTTPException(status_code=401, detail="Authentication required")
    session = find_session(db, raw_token)
    if not session:
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    user = db.query(User).filter(User.id == session.user_id, User.is_active.is_(True)).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def require_workspace_access(db: Session, user_id: str, workspace_id: str) -> Workspace:
    membership = db.query(Membership).filter(
        Membership.user_id == user_id,
        Membership.workspace_id == workspace_id,
    ).first()
    if not membership:
        raise HTTPException(status_code=403, detail="Workspace access denied")
    workspace = db.query(Workspace).filter(Workspace.id == workspace_id).first()
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return workspace
