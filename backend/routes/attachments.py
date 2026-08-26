"""Attachment routes — upload, fetch, delete.

P2 fleshes out the upload path:
    POST /api/conversations/{conv_id}/attachments  (multipart, multi-file)

Validation:
    * MIME-or-extension whitelist (CSV/TSV/TXT/MD/JSON/PDF/XLSX + PNG/JPG/JPEG/WebP/GIF)
    * Per-file caps: 25 MB regular / 10 MB image
    * Per-turn cap: 5 images
    * Per-conversation cap: 100 MB total across all attachments

Storage:
    DATA_DIR/conversations/{conv_id}/attachments/{att_id}{ext}

Side effect: PDF/XLSX/CSV/TSV/TXT/MD/JSON get text-extracted and stored in
``Attachment.preview_text`` so the chat turn doesn't pay the extraction cost
per message.
"""
from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from config import (
    AI_ATTACHMENT_MAX_CONV_BYTES,
    AI_ATTACHMENT_MAX_FILE_BYTES,
    AI_ATTACHMENT_MAX_IMAGE_BYTES,
    AI_ATTACHMENT_MAX_IMAGES_PER_TURN,
    CONVERSATIONS_DIR,
)
from database import (
    Attachment,
    AttachmentKind,
    Conversation,
    User,
    get_db,
)
from deps import get_current_user, require_workspace_access
from schemas import AttachmentRead
from services.ai.attachments import (
    ALLOWED_EXTS,
    IMAGE_EXTS,
    extract_preview,
    guess_mime,
    is_image,
)
from services.audit_service import record_audit

log = logging.getLogger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _attachment_with_access(db: Session, att_id: str, user: User) -> tuple[Attachment, Conversation]:
    att = db.query(Attachment).filter(Attachment.id == att_id).first()
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    conv = db.query(Conversation).filter(Conversation.id == att.conversation_id).first()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    require_workspace_access(db, user.id, conv.workspace_id)
    return att, conv


def _conv_with_access(db: Session, conv_id: str, user: User) -> Conversation:
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    require_workspace_access(db, user.id, conv.workspace_id)
    return conv


def _serialize(att: Attachment) -> AttachmentRead:
    return AttachmentRead(
        id=att.id,
        conversation_id=att.conversation_id,
        message_id=att.message_id,
        kind=att.kind.value if hasattr(att.kind, "value") else str(att.kind),
        filename=att.filename,
        mime_type=att.mime_type,
        size_bytes=att.size_bytes,
        uploaded_at=att.uploaded_at,
    )


# ---------------------------------------------------------------------------
# POST /api/conversations/{conv_id}/attachments
# ---------------------------------------------------------------------------

@router.post(
    "/conversations/{conv_id}/attachments",
    response_model=list[AttachmentRead],
)
async def upload_attachments(
    conv_id: str,
    files: list[UploadFile] = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    conv = _conv_with_access(db, conv_id, current_user)

    if not files:
        raise HTTPException(status_code=400, detail="No files provided")

    # Per-conversation total-size budget.
    existing_total = (
        db.query(Attachment)
        .filter(Attachment.conversation_id == conv_id)
        .with_entities(Attachment.size_bytes)
        .all()
    )
    used_bytes = sum(int(s or 0) for (s,) in existing_total)

    # Per-turn image cap.
    incoming_images = 0
    for f in files:
        ext = Path(f.filename or "").suffix.lower()
        if ext in IMAGE_EXTS or is_image(f.content_type or ""):
            incoming_images += 1
    if incoming_images > AI_ATTACHMENT_MAX_IMAGES_PER_TURN:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Too many images in one upload: {incoming_images} > "
                f"{AI_ATTACHMENT_MAX_IMAGES_PER_TURN}"
            ),
        )

    storage_root = Path(CONVERSATIONS_DIR) / conv_id / "attachments"
    storage_root.mkdir(parents=True, exist_ok=True)

    out: list[Attachment] = []
    for f in files:
        ext = Path(f.filename or "").suffix.lower()
        if ext not in ALLOWED_EXTS:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"File type '{ext}' is not allowed. Supported: "
                    + ", ".join(sorted(ALLOWED_EXTS))
                ),
            )

        # Read fully into memory — caps are tight (25 MB) so this is fine.
        content = await f.read()
        size = len(content)
        is_img = ext in IMAGE_EXTS or is_image(f.content_type or "")
        per_file_cap = AI_ATTACHMENT_MAX_IMAGE_BYTES if is_img else AI_ATTACHMENT_MAX_FILE_BYTES
        if size > per_file_cap:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"'{f.filename}' is {size} bytes > {per_file_cap} byte cap"
                    f" ({'image' if is_img else 'file'})."
                ),
            )

        if used_bytes + size > AI_ATTACHMENT_MAX_CONV_BYTES:
            raise HTTPException(
                status_code=413,
                detail=(
                    "This upload would push the conversation past "
                    f"{AI_ATTACHMENT_MAX_CONV_BYTES} bytes "
                    f"({used_bytes} already used)."
                ),
            )

        att_id = secrets.token_hex(12)
        storage_path = storage_root / f"{att_id}{ext}"
        storage_path.write_bytes(content)
        digest = hashlib.sha256(content).hexdigest()

        preview_text = "" if is_img else extract_preview(storage_path, f.filename)

        kind = AttachmentKind.IMAGE if is_img else AttachmentKind.FILE
        att = Attachment(
            id=att_id,
            conversation_id=conv_id,
            message_id=None,  # linked to a message at send time
            user_id=current_user.id,
            kind=kind,
            filename=f.filename or storage_path.name,
            mime_type=(f.content_type or guess_mime(f.filename or "")),
            size_bytes=size,
            storage_path=str(storage_path),
            preview_text=preview_text,
            sha256=digest,
        )
        db.add(att)
        used_bytes += size
        out.append(att)

    db.commit()
    for att in out:
        db.refresh(att)

    record_audit(
        db,
        "chat.attachments.uploaded",
        user_id=current_user.id,
        workspace_id=conv.workspace_id,
        run_id=conv.run_id,
        details={
            "conversation_id": conv_id,
            "count": len(out),
            "ids": [a.id for a in out],
        },
    )

    return [_serialize(a) for a in out]


# ---------------------------------------------------------------------------
# GET / DELETE
# ---------------------------------------------------------------------------

@router.get("/attachments/{att_id}", response_model=AttachmentRead)
def get_attachment(
    att_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    att, _ = _attachment_with_access(db, att_id, current_user)
    return _serialize(att)


@router.get("/attachments/{att_id}/content")
def get_attachment_content(
    att_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    att, _ = _attachment_with_access(db, att_id, current_user)
    path = Path(att.storage_path)
    if not path.exists():
        raise HTTPException(status_code=410, detail="Attachment file missing on disk")
    return FileResponse(
        path=str(path),
        media_type=att.mime_type or "application/octet-stream",
        filename=att.filename,
    )


@router.delete("/attachments/{att_id}")
def delete_attachment(
    att_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    att, conv = _attachment_with_access(db, att_id, current_user)
    try:
        p = Path(att.storage_path)
        if p.exists():
            p.unlink()
    except OSError as exc:
        log.warning("Failed to unlink %s: %s", att.storage_path, exc)
    db.delete(att)
    db.commit()
    record_audit(
        db,
        "chat.attachment.deleted",
        user_id=current_user.id,
        workspace_id=conv.workspace_id,
        run_id=conv.run_id,
        details={"attachment_id": att_id, "conversation_id": conv.id},
    )
    return {"deleted": att_id}
