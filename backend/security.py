from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime
from typing import Optional

from database import SessionToken, default_session_expiry


def hash_password(password: str, salt: Optional[str] = None) -> str:
    actual_salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), actual_salt.encode("utf-8"), 120000)
    return f"{actual_salt}${digest.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        salt, _ = stored_hash.split("$", 1)
    except ValueError:
        return False
    expected = hash_password(password, salt=salt)
    return hmac.compare_digest(expected, stored_hash)


def issue_session(db, user_id: str) -> tuple[str, SessionToken]:
    raw_token = secrets.token_urlsafe(32)
    token_record = SessionToken(
        id=secrets.token_hex(12),
        user_id=user_id,
        token_hash=hashlib.sha256(raw_token.encode("utf-8")).hexdigest(),
        expires_at=default_session_expiry(),
        last_used_at=datetime.utcnow(),
    )
    db.add(token_record)
    db.commit()
    db.refresh(token_record)
    return raw_token, token_record


def find_session(db, raw_token: str) -> Optional[SessionToken]:
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    session = db.query(SessionToken).filter(SessionToken.token_hash == token_hash).first()
    if not session:
        return None
    if session.expires_at < datetime.utcnow():
        return None
    session.last_used_at = datetime.utcnow()
    db.commit()
    return session
