"""Conversation + message CRUD with streaming SSE.

P0 → P1 evolution:
    The same `POST /conversations/{id}/messages` handler now supports
    two response shapes:

      * `Accept: text/event-stream` → SSE stream of:
            {"type":"start","user_message_id":..,"assistant_message_id":..,
             "provider":..,"model":..}
            {"type":"delta","text":...}                (0..N)
            {"type":"tool_call","tool_call":{...}}    (0..N — P7)
            {"type":"tool_result","tool_result":{...}}(0..N — P7)
            {"type":"usage","input_tokens":..,"output_tokens":..,"cost_usd":..}
            {"type":"finish","finish_reason":..,"citations":[...]}
            OR
            {"type":"error","error":...}

      * any other Accept → JSON `MessageCreateResponse` as before.

    On client disconnect mid-stream we mark the assistant Message
    `status="cancelled"` and persist whatever text accumulated so a refresh
    shows the partial answer.
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
import shutil
import time
from datetime import datetime
from pathlib import Path
from typing import AsyncIterator, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from config import (
    AI_OUTPUT_TOKEN_BUDGET,
    CONVERSATIONS_DIR,
)
from database import (
    Attachment,
    Conversation,
    Message,
    MessageRole,
    Run,
    SessionLocal,
    User,
    get_db,
)
from deps import get_current_user, require_workspace_access
from schemas import (
    ConversationCreate,
    ConversationListItem,
    ConversationPatch,
    ConversationRead,
    MessageCreate,
    MessageCreateResponse,
    MessageRead,
    AttachmentRead,
    ExternalLookupsToggle,
)
from services.ai import key_resolver
from services.ai.context_builder import (
    build_citations,
    build_provider_messages,
    system_prompt,
)
from services.ai.dispatcher import (
    get_provider,
    security_provider,
    select_default_provider,
    select_model,
)
from services.ai.key_resolver import PlatformQuotaExceeded
from services.ai.providers.base import Message as ProviderMessage, ProviderError
from services.ai.providers.catalog import estimate_cost_usd
from services.audit_service import record_audit

log = logging.getLogger(__name__)
router = APIRouter()

MAX_PERSISTENT_PINNED_REFS = 10
MAX_PER_TURN_PINNED_REFS = 10


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_conversation(db: Session, conv_id: str, user: User) -> Conversation:
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    require_workspace_access(db, user.id, conv.workspace_id)
    return conv


def _serialize_attachment(att: Attachment) -> AttachmentRead:
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


def _safe_json_array(raw: Optional[str]) -> list:
    """Parse a JSON-encoded list column; return [] on missing/corrupt data
    rather than 500-ing the request."""
    if not raw:
        return []
    try:
        loaded = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    return loaded if isinstance(loaded, list) else []


def _ref_key(ref: dict) -> str:
    kind = ref.get("kind") or ""
    if kind == "attachment":
        return f"attachment:{ref.get('attachment_id') or ''}"
    return f"run_artifact:{ref.get('run_id') or ''}:{ref.get('rel_path') or ''}"


def _dedupe_refs(refs: list[dict]) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for ref in refs:
        key = _ref_key(ref)
        if key in seen:
            continue
        seen.add(key)
        out.append(ref)
    return out


def _artifact_ref_to_dict(ref) -> dict:
    if isinstance(ref, dict):
        data = dict(ref)
    else:
        data = ref.model_dump()
    return {
        "kind": data.get("kind"),
        "run_id": data.get("run_id"),
        "rel_path": data.get("rel_path"),
        "attachment_id": data.get("attachment_id"),
        "label": data.get("label") or "",
    }


def _normalize_artifact_refs(
    db: Session,
    conv: Conversation,
    refs,
    *,
    limit: int,
) -> list[dict]:
    raw_refs = [_artifact_ref_to_dict(ref) for ref in (refs or [])]
    if len(raw_refs) > limit:
        raise HTTPException(status_code=422, detail=f"At most {limit} pinned refs are allowed")

    normalized: list[dict] = []
    for ref in raw_refs:
        kind = ref.get("kind")
        if kind == "run_artifact":
            run_id = (ref.get("run_id") or conv.run_id or "").strip()
            rel_path = (ref.get("rel_path") or "").strip()
            if not run_id or not rel_path:
                raise HTTPException(status_code=422, detail="run_artifact refs require run_id/current run and rel_path")
            run = db.query(Run).filter(Run.id == run_id).first()
            if not run or run.workspace_id != conv.workspace_id:
                raise HTTPException(status_code=403, detail="Pinned run artifact is not accessible from this workspace")
            status_value = run.status.value if hasattr(run.status, "value") else str(run.status)
            if status_value != "complete":
                raise HTTPException(status_code=422, detail="Only completed runs can be pinned into chat context")
            normalized.append({
                "kind": "run_artifact",
                "run_id": run_id,
                "rel_path": rel_path,
                "attachment_id": None,
                "label": ref.get("label") or Path(rel_path).name,
            })
        elif kind == "attachment":
            attachment_id = (ref.get("attachment_id") or "").strip()
            if not attachment_id:
                raise HTTPException(status_code=422, detail="attachment refs require attachment_id")
            row = (
                db.query(Attachment)
                .filter(Attachment.id == attachment_id, Attachment.conversation_id == conv.id)
                .first()
            )
            if row is None:
                raise HTTPException(status_code=404, detail="Pinned attachment not found")
            normalized.append({
                "kind": "attachment",
                "run_id": None,
                "rel_path": None,
                "attachment_id": attachment_id,
                "label": ref.get("label") or row.filename,
            })
        else:
            raise HTTPException(status_code=422, detail=f"Unsupported pinned ref kind: {kind}")
    return _dedupe_refs(normalized)


def _conversation_pinned_refs(conv: Conversation) -> list[dict]:
    return _safe_json_array(getattr(conv, "pinned_refs_json", "[]"))


def _conversation_discovery_mode(conv: Conversation) -> str:
    mode = (getattr(conv, "discovery_mode", "auto") or "auto").lower()
    return mode if mode in {"auto", "on", "off"} else "auto"


def _serialize_message(db: Session, msg: Message) -> MessageRead:
    att_rows = []
    ids = _safe_json_array(msg.attachments_json)
    if ids:
        att_rows = db.query(Attachment).filter(Attachment.id.in_(ids)).all()
    return MessageRead(
        id=msg.id,
        conversation_id=msg.conversation_id,
        role=msg.role.value if hasattr(msg.role, "value") else str(msg.role),
        content=msg.content or "",
        attachments=[_serialize_attachment(a) for a in att_rows],
        citations=_safe_json_array(msg.citations_json),
        tool_calls=_safe_json_array(msg.tool_calls_json),
        provider=msg.provider or "",
        model=msg.model or "",
        input_tokens=msg.input_tokens or 0,
        output_tokens=msg.output_tokens or 0,
        cost_usd=msg.cost_usd or "",
        parent_message_id=msg.parent_message_id,
        status=msg.status or "complete",
        error=msg.error or "",
        created_at=msg.created_at,
    )


def _serialize_conversation(db: Session, conv: Conversation, *, with_messages: bool) -> ConversationRead:
    msgs: list[MessageRead] = []
    if with_messages:
        rows = (
            db.query(Message)
            .filter(Message.conversation_id == conv.id)
            .order_by(Message.created_at.asc(), Message.id.asc())
            .all()
        )
        msgs = [_serialize_message(db, m) for m in rows]
    return ConversationRead(
        id=conv.id,
        run_id=conv.run_id,
        workspace_id=conv.workspace_id,
        user_id=conv.user_id,
        title=conv.title,
        provider=conv.provider,
        model=conv.model,
        archived=conv.archived,
        external_lookups_enabled=conv.external_lookups_enabled,
        pinned_message_id=conv.pinned_message_id,
        pinned_refs=_conversation_pinned_refs(conv),
        discovery_mode=_conversation_discovery_mode(conv),
        created_at=conv.created_at,
        updated_at=conv.updated_at,
        messages=msgs,
    )


def _auto_title(question: str) -> str:
    q = (question or "").strip().splitlines()[0] if question else "New conversation"
    q = q.strip()
    if len(q) > 80:
        q = q[:77].rstrip() + "..."
    return q or "New conversation"


# ---------------------------------------------------------------------------
# Conversation CRUD
# ---------------------------------------------------------------------------

@router.post("/runs/{run_id}/conversations", response_model=ConversationRead)
def create_conversation_on_run(
    run_id: str,
    req: ConversationCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    run = db.query(Run).filter(Run.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    require_workspace_access(db, current_user.id, run.workspace_id)

    provider = req.provider or select_default_provider(
        db, user_id=current_user.id, workspace_id=run.workspace_id
    )
    model = select_model(db, user_id=current_user.id, provider=provider, requested=req.model)

    conv = Conversation(
        id=secrets.token_hex(12),
        run_id=run_id,
        workspace_id=run.workspace_id,
        user_id=current_user.id,
        title=req.title or "New conversation",
        provider=provider,
        model=model,
    )
    db.add(conv)
    db.commit()
    db.refresh(conv)
    record_audit(
        db,
        "chat.conversation.created",
        user_id=current_user.id,
        workspace_id=run.workspace_id,
        run_id=run_id,
        details={"conversation_id": conv.id, "provider": provider, "model": model},
    )
    return _serialize_conversation(db, conv, with_messages=True)


@router.get("/runs/{run_id}/conversations", response_model=list[ConversationListItem])
def list_conversations_for_run(
    run_id: str,
    include_archived: bool = False,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    run = db.query(Run).filter(Run.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    require_workspace_access(db, current_user.id, run.workspace_id)

    q = db.query(Conversation).filter(Conversation.run_id == run_id)
    if not include_archived:
        q = q.filter(Conversation.archived.is_(False))
    rows = q.order_by(Conversation.updated_at.desc()).all()

    out: list[ConversationListItem] = []
    for conv in rows:
        message_count = db.query(Message).filter(Message.conversation_id == conv.id).count()
        out.append(
            ConversationListItem(
                id=conv.id,
                run_id=conv.run_id,
                workspace_id=conv.workspace_id,
                title=conv.title,
                provider=conv.provider,
                model=conv.model,
                archived=conv.archived,
                external_lookups_enabled=conv.external_lookups_enabled,
                created_at=conv.created_at,
                updated_at=conv.updated_at,
                message_count=message_count,
            )
        )
    return out


@router.get("/conversations/{conv_id}", response_model=ConversationRead)
def get_conversation(
    conv_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    conv = _load_conversation(db, conv_id, current_user)
    return _serialize_conversation(db, conv, with_messages=True)


@router.patch("/conversations/{conv_id}", response_model=ConversationRead)
def patch_conversation(
    conv_id: str,
    req: ConversationPatch,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    conv = _load_conversation(db, conv_id, current_user)
    if req.title is not None:
        conv.title = req.title.strip() or conv.title
    if req.archived is not None:
        conv.archived = bool(req.archived)
    if req.provider is not None:
        conv.provider = req.provider
    if req.model is not None:
        conv.model = req.model
    if req.external_lookups_enabled is not None:
        conv.external_lookups_enabled = bool(req.external_lookups_enabled)
    if req.pinned_refs is not None:
        normalized = _normalize_artifact_refs(
            db, conv, req.pinned_refs, limit=MAX_PERSISTENT_PINNED_REFS
        )
        conv.pinned_refs_json = json.dumps(normalized)
    if req.discovery_mode is not None:
        conv.discovery_mode = req.discovery_mode
    conv.updated_at = datetime.utcnow()
    db.add(conv)
    db.commit()
    db.refresh(conv)
    record_audit(
        db,
        "chat.conversation.patched",
        user_id=current_user.id,
        workspace_id=conv.workspace_id,
        run_id=conv.run_id,
        details={
            "conversation_id": conv.id,
            "fields": [k for k in req.model_dump(exclude_unset=True).keys()],
        },
    )
    return _serialize_conversation(db, conv, with_messages=True)


@router.delete("/conversations/{conv_id}")
def delete_conversation(
    conv_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    conv = _load_conversation(db, conv_id, current_user)
    workspace_id = conv.workspace_id
    run_id = conv.run_id

    # Cascade: attachments (with files on disk) → messages → conversation.
    attachments = db.query(Attachment).filter(Attachment.conversation_id == conv_id).all()
    for att in attachments:
        try:
            p = Path(att.storage_path)
            if p.exists():
                p.unlink()
        except OSError as exc:
            log.warning("Failed to unlink attachment %s: %s", att.id, exc)
        db.delete(att)

    db.query(Message).filter(Message.conversation_id == conv_id).delete(synchronize_session=False)
    db.delete(conv)
    db.commit()

    conv_dir = CONVERSATIONS_DIR / conv_id
    if conv_dir.exists():
        try:
            shutil.rmtree(conv_dir)
        except OSError as exc:
            log.warning("Failed to rmtree %s: %s", conv_dir, exc)

    record_audit(
        db,
        "chat.conversation.deleted",
        user_id=current_user.id,
        workspace_id=workspace_id,
        run_id=run_id,
        details={"conversation_id": conv_id},
    )
    return {"deleted": conv_id}


@router.post("/conversations/{conv_id}/clear")
def clear_conversation(
    conv_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    conv = _load_conversation(db, conv_id, current_user)
    db.query(Message).filter(Message.conversation_id == conv_id).delete(synchronize_session=False)
    conv.updated_at = datetime.utcnow()
    db.add(conv)
    db.commit()
    record_audit(
        db,
        "chat.conversation.cleared",
        user_id=current_user.id,
        workspace_id=conv.workspace_id,
        run_id=conv.run_id,
        details={"conversation_id": conv_id},
    )
    return {"cleared": conv_id}


@router.post("/conversations/{conv_id}/messages/{msg_id}/pin")
def pin_message(
    conv_id: str,
    msg_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Pin (or unpin if already pinned) a single message in a conversation."""
    conv = _load_conversation(db, conv_id, current_user)
    msg = (
        db.query(Message)
        .filter(Message.id == msg_id, Message.conversation_id == conv_id)
        .first()
    )
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found in this conversation")
    if conv.pinned_message_id == msg_id:
        conv.pinned_message_id = None
        action = "unpinned"
    else:
        conv.pinned_message_id = msg_id
        action = "pinned"
    conv.updated_at = datetime.utcnow()
    db.add(conv)
    db.commit()
    record_audit(
        db,
        f"chat.message.{action}",
        user_id=current_user.id,
        workspace_id=conv.workspace_id,
        run_id=conv.run_id,
        details={"conversation_id": conv_id, "message_id": msg_id},
    )
    return {"action": action, "conversation_id": conv_id, "message_id": msg_id}


@router.post("/conversations/{conv_id}/messages/{msg_id}/regenerate", response_model=MessageCreateResponse)
async def regenerate_message(
    conv_id: str,
    msg_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Re-runs the assistant turn for the given message.

    Implementation: delete the target assistant message + any messages
    after it, then call send_message logic with the previous user turn's
    content. Non-streaming for simplicity; the client refetches the
    conversation after the call returns.
    """
    conv = _load_conversation(db, conv_id, current_user)
    target = (
        db.query(Message)
        .filter(Message.id == msg_id, Message.conversation_id == conv_id)
        .first()
    )
    if not target:
        raise HTTPException(status_code=404, detail="Message not found in this conversation")
    if target.role != MessageRole.ASSISTANT:
        raise HTTPException(status_code=400, detail="Only assistant messages can be regenerated.")

    # Find the user message this assistant turn was a reply to.
    parent_user = None
    if target.parent_message_id:
        parent_user = db.query(Message).filter(Message.id == target.parent_message_id).first()
    if not parent_user or parent_user.role != MessageRole.USER:
        raise HTTPException(status_code=400, detail="Cannot find the user turn this answer replied to.")

    # Remove the assistant message + everything after it in this conversation.
    db.query(Message).filter(
        Message.conversation_id == conv_id,
        Message.created_at >= target.created_at,
    ).delete(synchronize_session=False)
    db.commit()

    # Resolve provider + tools and run a fresh non-streaming completion using
    # the original user-message content (attachments are kept by reference).
    try:
        attachment_ids = json.loads(parent_user.attachments_json or "[]")
    except json.JSONDecodeError:
        attachment_ids = []
    attachments = _load_attachments(db, conv_id, attachment_ids)

    provider_name = conv.provider or "anthropic"
    model = conv.model or "claude-sonnet-4-6"
    resolved = key_resolver.resolve_key(
        db,
        user_id=current_user.id,
        workspace_id=conv.workspace_id,
        provider=provider_name,  # type: ignore[arg-type]
    )
    if not resolved.key:
        raise HTTPException(status_code=400, detail="No API key configured. Open Settings → AI.")
    if resolved.source == "platform":
        try:
            key_resolver.check_platform_quota(db, current_user.id)
        except PlatformQuotaExceeded as exc:
            raise HTTPException(status_code=429, detail={"message": "Platform quota exceeded.", "resets_at": exc.resets_at.isoformat() + "Z"})

    try:
        provider = get_provider(provider_name, resolved.key)
    except ProviderError as exc:
        raise HTTPException(status_code=exc.status or 500, detail=str(exc))

    messages = build_provider_messages(db, conv, parent_user.content or "", attachments)
    system_text = system_prompt()
    citations = build_citations(conv, attachments, user_content=parent_user.content or "")

    try:
        result = await provider.complete(
            model=model,
            system=system_text,
            messages=messages,
            tools=None,  # regenerate skips tool-use for determinism; client can switch model & ask again
            max_output_tokens=min(AI_OUTPUT_TOKEN_BUDGET, 4000),
        )
    except ProviderError as exc:
        raise HTTPException(status_code=exc.status or 502, detail=str(exc))

    usage = result.get("usage", {}) or {}
    in_t = int(usage.get("input_tokens", 0) or 0)
    out_t = int(usage.get("output_tokens", 0) or 0)
    if resolved.source == "platform":
        key_resolver.record_platform_usage(db, current_user.id, input_tokens=in_t, output_tokens=out_t)
    cost = estimate_cost_usd(provider_name, model, in_t, out_t)

    # Gate 4 — output security. The regenerate path previously persisted the
    # raw model text with NO scrub and NO leak-judge, bypassing the
    # anti-exfiltration layer that the streaming path enforces. Mirror it here:
    # regex-scrub fixed identifiers, then run the LLM leak-judge for prose
    # methodology/identity leaks, replacing with the standard refusal if hit.
    from services.ai.security import (
        STANDARD_REFUSAL as _REFUSAL,
        heuristic_output_leak as _heur,
        scrub_output as _scrub_regen,
    )
    raw_text = result.get("text") or ""
    answer_text = _scrub_regen(raw_text)
    regen_redacted = False
    leak_reason = ""
    # Fail-CLOSED deterministic backstop — runs regardless of the LLM judge,
    # so a judge outage/rate-limit can't slip a leak through this path.
    hb_leak, hb_reason = _heur(raw_text)
    if hb_leak:
        regen_redacted = True
        leak_reason = f"heuristic:{hb_reason}"
    try:
        from config import (
            AI_SECURITY_JUDGE_MODEL as _JM,
            AI_SECURITY_LLM_JUDGE as _JUDGE_ON,
        )
        from services.ai.security import classify_output_for_leak as _classify_out

        if not regen_redacted and _JUDGE_ON and answer_text.strip():
            out_verdict = await _classify_out(
                answer_text, provider=security_provider(provider), model=_JM
            )
            if out_verdict.leaked:
                regen_redacted = True
                leak_reason = f"judge:{out_verdict.reason}"
    except Exception as exc:  # pragma: no cover — judge fails open; heuristic already ran
        log.warning("Regenerate output judge failed (fail-open): %s", exc)
    if regen_redacted:
        answer_text = _REFUSAL
        record_audit(
            db,
            "chat.message.blocked.output_leak",
            user_id=current_user.id,
            workspace_id=conv.workspace_id,
            run_id=conv.run_id,
            details={
                "conversation_id": conv.id,
                "endpoint": "regenerate",
                "reason": leak_reason,
            },
        )

    new_assistant = Message(
        id=secrets.token_hex(12),
        conversation_id=conv.id,
        role=MessageRole.ASSISTANT,
        content=answer_text,
        citations_json=json.dumps(citations),
        tool_calls_json="[]",
        provider=provider_name,
        model=model,
        input_tokens=in_t,
        output_tokens=out_t,
        cost_usd=f"{cost:.6f}" if cost is not None else "",
        parent_message_id=parent_user.id,
        status="redacted" if regen_redacted else "complete",
    )
    db.add(new_assistant)
    conv.updated_at = datetime.utcnow()
    db.add(conv)
    db.commit()
    db.refresh(new_assistant)
    record_audit(
        db,
        "chat.message.regenerated",
        user_id=current_user.id,
        workspace_id=conv.workspace_id,
        run_id=conv.run_id,
        details={"conversation_id": conv_id, "old_message_id": msg_id, "new_message_id": new_assistant.id},
    )
    return MessageCreateResponse(
        user_message=_serialize_message(db, parent_user),
        assistant_message=_serialize_message(db, new_assistant),
    )


@router.get("/conversations/{conv_id}/export")
def export_conversation(
    conv_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Markdown export of a conversation — questions + answers + citations
    + tool-call breadcrumbs, suitable for pasting into a lab notebook."""
    from fastapi.responses import PlainTextResponse

    conv = _load_conversation(db, conv_id, current_user)
    rows = (
        db.query(Message)
        .filter(Message.conversation_id == conv_id)
        .order_by(Message.created_at.asc(), Message.id.asc())
        .all()
    )
    lines: list[str] = [
        f"# {conv.title or 'Conversation'}",
        f"",
        f"- Conversation ID: `{conv.id}`",
        f"- Run: `{conv.run_id or '—'}`",
        f"- Provider: {conv.provider} · model: {conv.model or '—'}",
        f"- Exported: {datetime.utcnow().isoformat()}Z",
        f"",
        "---",
        "",
    ]
    for m in rows:
        role = m.role.value if hasattr(m.role, "value") else str(m.role)
        ts = m.created_at.isoformat() if m.created_at else ""
        if role == "user":
            lines.append(f"## 👤 You · {ts}")
            lines.append("")
            lines.append(m.content or "_(empty)_")
        elif role == "assistant":
            lines.append(f"## 🤖 Assistant · {ts}")
            lines.append(f"_{m.provider or 'anthropic'} · {m.model or ''} · {m.input_tokens}→{m.output_tokens} tok · ≈ ${m.cost_usd}_")
            lines.append("")
            lines.append(m.content or "_(empty)_")
            cites = _safe_json_array(m.citations_json)
            if cites:
                lines.append("")
                lines.append("**Sources cited:**")
                for c in cites:
                    fp = c.get("file_path") or c.get("file") or ""
                    rid = c.get("run_id") or ""
                    lines.append(f"- `{fp}`" + (f" (run {rid})" if rid else ""))
            tools = _safe_json_array(m.tool_calls_json)
            if tools:
                lines.append("")
                lines.append("**Tools called:**")
                for t in tools:
                    adapter = t.get("adapter") or t.get("name") or ""
                    args = t.get("args") or {}
                    rows_returned = (t.get("result") or {}).get("rows_returned", "")
                    lines.append(f"- `{adapter}({json.dumps(args)})` → {rows_returned} rows")
        lines.append("")
        lines.append("---")
        lines.append("")

    body = "\n".join(lines)
    record_audit(
        db,
        "chat.conversation.exported",
        user_id=current_user.id,
        workspace_id=conv.workspace_id,
        run_id=conv.run_id,
        details={"conversation_id": conv_id, "format": "md"},
    )
    safe_name = (conv.title or "conversation").replace("/", "-").replace("\\", "-")
    return PlainTextResponse(
        body,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.md"'},
    )


@router.put("/conversations/{conv_id}/external-lookups", response_model=ConversationRead)
def toggle_external_lookups(
    conv_id: str,
    req: ExternalLookupsToggle,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    conv = _load_conversation(db, conv_id, current_user)
    from database import WorkspaceAISettings, ExternalLookupsPolicy

    ws_settings = db.query(WorkspaceAISettings).filter(
        WorkspaceAISettings.workspace_id == conv.workspace_id
    ).first()
    if ws_settings and ws_settings.external_lookups_policy == ExternalLookupsPolicy.DENY and req.enabled:
        raise HTTPException(
            status_code=403,
            detail="External lookups are disabled for this workspace by an admin.",
        )
    conv.external_lookups_enabled = req.enabled
    conv.updated_at = datetime.utcnow()
    db.add(conv)
    db.commit()
    db.refresh(conv)
    record_audit(
        db,
        "chat.external_lookups.toggled",
        user_id=current_user.id,
        workspace_id=conv.workspace_id,
        run_id=conv.run_id,
        details={"conversation_id": conv.id, "enabled": req.enabled},
    )
    return _serialize_conversation(db, conv, with_messages=False)


# ---------------------------------------------------------------------------
# Context panel (P9) — artifact browser for @-mention / pin
# ---------------------------------------------------------------------------

_FAMILY_GROUPS = {
    "volcano": "Differential expression",
    "network": "Network & modules",
    "go": "GO enrichment",
    "cells": "Cell types",
    "input": "Input data",
    "report": "Reports & summaries",
}
_GROUP_ORDER = [
    "Differential expression", "Network & modules", "GO enrichment",
    "Cell types", "Input data", "Reports & summaries", "Other",
]


@router.get("/conversations/{conv_id}/context-panel")
def get_context_panel(
    conv_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Files the user can browse + pin into a turn: the run's artifacts
    (grouped by family) and this conversation's own uploaded attachments."""
    conv = _load_conversation(db, conv_id, current_user)

    run_artifacts: list[dict] = []
    if conv.run_id:
        from config import RUNS_DIR
        from services.ai.artifact_index import get_index

        index = get_index(conv.run_id, RUNS_DIR)
        grouped: dict[str, list[dict]] = {}
        for r in index.records:
            prefix = (r.family or "").split(".")[0]
            group = _FAMILY_GROUPS.get(prefix, "Other")
            grouped.setdefault(group, []).append({
                "rel_path": r.rel_path,
                "label": r.rel_path.split("/")[-1],
                "family": r.family,
                "kind": r.kind,
                "size_bytes": r.size_bytes,
                "row_count": r.row_count,
            })
        for group in _GROUP_ORDER:
            if grouped.get(group):
                run_artifacts.append({
                    "group": group,
                    "items": sorted(grouped[group], key=lambda i: i["label"]),
                })

    attachments = (
        db.query(Attachment)
        .filter(Attachment.conversation_id == conv.id)
        .order_by(Attachment.uploaded_at.asc())
        .all()
    )
    local_files = [{
        "attachment_id": a.id,
        "label": a.filename,
        "kind": a.kind.value if hasattr(a.kind, "value") else str(a.kind),
        "size_bytes": a.size_bytes,
    } for a in attachments]

    workspace_run_rows = (
        db.query(Run)
        .filter(Run.workspace_id == conv.workspace_id, Run.status == "COMPLETE")
        .order_by(Run.completed_at.desc().nullslast(), Run.created_at.desc())
        .limit(25)
        .all()
    )
    workspace_runs = []
    from config import RUNS_DIR
    from services.ai.artifact_index import get_index

    for r in workspace_run_rows:
        artifacts = []
        try:
            index = get_index(r.id, RUNS_DIR)
            artifacts = [
                {
                    "rel_path": rec.rel_path,
                    "label": rec.rel_path.split("/")[-1],
                    "family": rec.family,
                    "kind": rec.kind,
                    "size_bytes": rec.size_bytes,
                    "row_count": rec.row_count,
                }
                for rec in index.records[:50]
            ]
        except Exception as exc:  # noqa: BLE001
            log.debug("Could not index workspace run %s for context panel: %s", r.id, exc)
        workspace_runs.append({
            "run_id": r.id,
            "label": r.name,
            "status": r.status.value if hasattr(r.status, "value") else str(r.status),
            "created_at": r.created_at,
            "completed_at": r.completed_at,
            "current": r.id == conv.run_id,
            "artifacts": artifacts,
        })

    return {
        "conversation_id": conv.id,
        "run_id": conv.run_id,
        "run_artifacts": run_artifacts,
        "local_files": local_files,
        "workspace_runs": workspace_runs,
    }


# ---------------------------------------------------------------------------
# Send message — JSON or SSE depending on Accept header
# ---------------------------------------------------------------------------

def _wants_stream(request: Request) -> bool:
    accept = (request.headers.get("accept") or "").lower()
    return "text/event-stream" in accept


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, default=str)}\n\n"


def _persist_user_message(
    db: Session, conv: Conversation, req: MessageCreate
) -> Message:
    user_msg = Message(
        id=secrets.token_hex(12),
        conversation_id=conv.id,
        role=MessageRole.USER,
        content=req.content or "",
        attachments_json=json.dumps(req.attachment_ids or []),
    )
    if conv.title == "New conversation" and (req.content or "").strip():
        conv.title = _auto_title(req.content)
    db.add(user_msg)
    db.add(conv)
    db.commit()
    db.refresh(user_msg)
    db.refresh(conv)
    return user_msg


def _load_attachments(db: Session, conv_id: str, attachment_ids: list[str]) -> list[Attachment]:
    """Load attachments belonging to this conversation only (workspace
    isolation is already enforced by the conversation access check)."""
    if not attachment_ids:
        return []
    rows = (
        db.query(Attachment)
        .filter(
            Attachment.id.in_(attachment_ids),
            Attachment.conversation_id == conv_id,
        )
        .all()
    )
    # Preserve client-supplied order.
    by_id = {a.id: a for a in rows}
    return [by_id[aid] for aid in attachment_ids if aid in by_id]


def _link_attachments_to_message(db: Session, attachments: list[Attachment], message_id: str) -> None:
    if not attachments:
        return
    for att in attachments:
        if not att.message_id:
            att.message_id = message_id
            db.add(att)
    db.commit()


def _build_refusal_response(
    db: Session,
    conv: Conversation,
    user_msg: Message,
    *,
    refusal_text: str,
    wants_stream: bool,
):
    """Persist a standard refusal as the assistant turn and return it in
    whichever transport the client asked for. Shared by the regex input
    blocker AND the LLM-judge input classifier so the refusal UX is
    identical regardless of which security layer caught the attempt."""
    assistant_refusal = Message(
        id=secrets.token_hex(12),
        conversation_id=conv.id,
        role=MessageRole.ASSISTANT,
        content=refusal_text,
        provider="anthropic",
        model=conv.model or "",
        status="complete",
        parent_message_id=user_msg.id,
    )
    db.add(assistant_refusal)
    conv.updated_at = datetime.utcnow()
    db.add(conv)
    db.commit()
    db.refresh(assistant_refusal)

    if wants_stream:
        user_msg_id_s = user_msg.id
        asst_id_s = assistant_refusal.id
        text_s = refusal_text
        model_s = conv.model or ""

        async def refusal_gen():
            yield _sse({
                "type": "start",
                "user_message_id": user_msg_id_s,
                "assistant_message_id": asst_id_s,
                "provider": "anthropic",
                "model": model_s,
            })
            yield _sse({"type": "delta", "text": text_s})
            yield _sse({
                "type": "usage",
                "input_tokens": 0,
                "output_tokens": 0,
                "cost_usd": 0,
                "key_source": "user",
            })
            yield _sse({"type": "finish", "finish_reason": "refusal", "citations": []})

        return StreamingResponse(
            refusal_gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
    return MessageCreateResponse(
        user_message=_serialize_message(db, user_msg),
        assistant_message=_serialize_message(db, assistant_refusal),
    )


@router.post("/conversations/{conv_id}/messages")
async def send_message(
    conv_id: str,
    req: MessageCreate,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    conv = _load_conversation(db, conv_id, current_user)
    per_turn_pinned_refs = _normalize_artifact_refs(
        db, conv, req.pinned_refs or [], limit=MAX_PER_TURN_PINNED_REFS
    )
    persistent_pinned_refs = _normalize_artifact_refs(
        db, conv, _conversation_pinned_refs(conv), limit=MAX_PERSISTENT_PINNED_REFS
    )
    merged_pinned_refs = _dedupe_refs(persistent_pinned_refs + per_turn_pinned_refs)

    user_msg = _persist_user_message(db, conv, req)
    attachments = _load_attachments(db, conv_id, req.attachment_ids or [])
    if attachments:
        _link_attachments_to_message(db, attachments, user_msg.id)
    record_audit(
        db,
        "chat.message.sent",
        user_id=current_user.id,
        workspace_id=conv.workspace_id,
        run_id=conv.run_id,
        details={
            "conversation_id": conv.id,
            "message_id": user_msg.id,
            "attachment_count": len(attachments),
        },
    )

    # ===================================================================
    # SECURITY GATES (P12) — ordered cheapest-first.
    # ===================================================================
    from services.ai.security import (
        STANDARD_REFUSAL,
        check_extraction_rate_limit,
        check_input_for_extraction_attempt,
    )

    # Gate 1 — rate limiter. A user who has tripped the input defenses
    # repeatedly in the rolling window is actively probing; throttle the
    # whole chat surface (HTTP 429) until the window clears.
    rl = check_extraction_rate_limit(db, current_user.id)
    if rl.throttled:
        record_audit(
            db,
            "chat.message.blocked.rate_limited",
            user_id=current_user.id,
            workspace_id=conv.workspace_id,
            run_id=conv.run_id,
            details={
                "conversation_id": conv.id,
                "blocked_count": rl.blocked_count,
                "window_minutes": rl.window_minutes,
            },
        )
        raise HTTPException(
            status_code=429,
            detail={
                "message": (
                    f"Too many blocked requests ({rl.blocked_count} in the last "
                    f"{rl.window_minutes} minutes). Chat is paused for a short "
                    "cooldown. Ask questions about your run's results to resume."
                ),
                "kind": "extraction_rate_limit",
                "window_minutes": rl.window_minutes,
            },
        )

    # Gate 2 — regex input blocker. Catches the obvious extraction/jailbreak
    # phrasings for free, before any LLM call. Audit the reason tag but never
    # tell the user *why* — that would leak the pattern list.
    check = check_input_for_extraction_attempt(req.content or "")
    if check.blocked:
        record_audit(
            db,
            "chat.message.blocked.extraction_attempt",
            user_id=current_user.id,
            workspace_id=conv.workspace_id,
            run_id=conv.run_id,
            details={
                "conversation_id": conv.id,
                "message_id": user_msg.id,
                "reason": check.reason,
                "layer": "regex",
            },
        )
        return _build_refusal_response(
            db, conv, user_msg,
            refusal_text=check.refusal_text,
            wants_stream=_wants_stream(request),
        )

    provider_name = conv.provider or select_default_provider(
        db, user_id=current_user.id, workspace_id=conv.workspace_id
    )
    model = conv.model or select_model(
        db, user_id=current_user.id, provider=provider_name, requested=None
    )
    resolved = key_resolver.resolve_key(
        db,
        user_id=current_user.id,
        workspace_id=conv.workspace_id,
        provider=provider_name,  # type: ignore[arg-type]
    )

    # --- No key path: persist + return error message immediately ---
    if not resolved.key:
        assistant_err = Message(
            id=secrets.token_hex(12),
            conversation_id=conv.id,
            role=MessageRole.ASSISTANT,
            content="",
            provider=provider_name,
            model=model,
            status="error",
            error=(
                f"No API key configured for provider '{provider_name}'. "
                "Paste a key in Settings → AI to enable chat."
            ),
            parent_message_id=user_msg.id,
        )
        db.add(assistant_err)
        db.commit()
        db.refresh(assistant_err)
        if _wants_stream(request):
            # CRITICAL: capture every attribute we'll need into plain locals
            # BEFORE building the generator. The request-scoped `db` session
            # is closed by FastAPI as soon as this handler returns the
            # StreamingResponse; accessing ORM-bound attributes from inside
            # the generator afterwards raises DetachedInstanceError.
            err_user_message_id = user_msg.id
            err_assistant_message_id = assistant_err.id
            err_provider_name = provider_name
            err_model = model
            err_error_text = assistant_err.error

            async def err_gen():
                yield _sse({
                    "type": "start",
                    "user_message_id": err_user_message_id,
                    "assistant_message_id": err_assistant_message_id,
                    "provider": err_provider_name,
                    "model": err_model,
                })
                yield _sse({"type": "error", "error": err_error_text})
            return StreamingResponse(
                err_gen(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )
        return MessageCreateResponse(
            user_message=_serialize_message(db, user_msg),
            assistant_message=_serialize_message(db, assistant_err),
        )

    # --- Platform quota gate ---
    if resolved.source == "platform":
        try:
            key_resolver.check_platform_quota(db, current_user.id)
        except PlatformQuotaExceeded as exc:
            # Same 429 shape for both transport modes (the JSON detail is what
            # the streaming UI also shows in its banner).
            raise HTTPException(
                status_code=429,
                detail={
                    "message": "Daily platform AI quota exceeded.",
                    "tokens_limit": exc.limit_tokens,
                    "reqs_limit": exc.limit_reqs,
                    "resets_at": exc.resets_at.isoformat() + "Z",
                    "remedy": "Add your own provider key in Settings → AI to continue.",
                },
            )

    try:
        provider = get_provider(provider_name, resolved.key)
    except ProviderError as exc:
        raise HTTPException(status_code=exc.status or 500, detail=str(exc))

    # Gate 3 — LLM-judge input classifier (P12 L3a). The regex blocker only
    # catches what its patterns anticipate; this Haiku call reasons about
    # *intent* and catches novel extraction framings. Fails open — a judge
    # error never blocks legitimate chat (the regex layer + system prompt
    # still protect). Config-gated via AI_SECURITY_LLM_JUDGE.
    from config import (
        AI_SECURITY_JUDGE_MODEL as _JUDGE_MODEL,
        AI_SECURITY_LLM_JUDGE as _LLM_JUDGE_ON,
    )

    if _LLM_JUDGE_ON:
        from services.ai.security import classify_input_intent

        verdict = await classify_input_intent(
            req.content or "", provider=security_provider(provider), model=_JUDGE_MODEL
        )
        if verdict.verdict == "block":
            record_audit(
                db,
                "chat.message.blocked.extraction_attempt",
                user_id=current_user.id,
                workspace_id=conv.workspace_id,
                run_id=conv.run_id,
                details={
                    "conversation_id": conv.id,
                    "message_id": user_msg.id,
                    "reason": verdict.reason,
                    "layer": "llm_judge",
                },
            )
            return _build_refusal_response(
                db, conv, user_msg,
                refusal_text=STANDARD_REFUSAL,
                wants_stream=_wants_stream(request),
            )

    messages = build_provider_messages(
        db, conv, req.content or "", attachments, pinned_refs=merged_pinned_refs
    )
    from services.ai.context_builder import discovery_active

    system_text = system_prompt(
        "v3" if discovery_active(conv, req.content or "") else "v2"
    )
    citations = build_citations(conv, attachments, user_content=req.content or "")
    # Pinned run artifacts are explicit sources — surface them as citations.
    for ref in merged_pinned_refs:
        if ref.get("kind") == "run_artifact" and ref.get("rel_path"):
            if not any(c.get("file_path") == ref.get("rel_path") and c.get("run_id") == ref.get("run_id") for c in citations):
                citations.append({"file_path": ref.get("rel_path"), "run_id": ref.get("run_id") or conv.run_id})
    # Tool-use (P4 wave 2) — exposed to the streaming path only. Tools
    # only make sense when the conversation is bound to a run on disk.
    from services.ai.context_builder import get_default_tools as _get_default_tools
    tools = _get_default_tools() if conv.run_id else None
    parallel_tools = False
    # P7: external biology lookups — opt-in per conversation; a workspace
    # admin set to DENY suppresses them even if the conversation flag is on.
    if conv.external_lookups_enabled:
        from database import ExternalLookupsPolicy, WorkspaceAISettings

        ws_ai = (
            db.query(WorkspaceAISettings)
            .filter(WorkspaceAISettings.workspace_id == conv.workspace_id)
            .first()
        )
        if not (ws_ai and ws_ai.external_lookups_policy == ExternalLookupsPolicy.DENY):
            from services.ai.external_lookups.dispatcher import external_tool_schemas

            tools = (tools or []) + external_tool_schemas()
        # P8: workspace admins may allow concurrent external lookups.
        parallel_tools = bool(ws_ai and ws_ai.parallel_tool_calls)

    # ----- STREAMING PATH -----
    if _wants_stream(request):
        # Pre-create the assistant row with status="streaming" so the
        # client immediately gets an ID to render against. The async
        # generator opens its own SessionLocal (the request-scoped session
        # is closed by the time we start yielding).
        assistant_id = secrets.token_hex(12)
        bootstrap_db = SessionLocal()
        try:
            placeholder = Message(
                id=assistant_id,
                conversation_id=conv.id,
                role=MessageRole.ASSISTANT,
                content="",
                provider=provider_name,
                model=model,
                status="streaming",
                parent_message_id=user_msg.id,
                citations_json=json.dumps(citations),
            )
            bootstrap_db.add(placeholder)
            bootstrap_db.commit()
        finally:
            bootstrap_db.close()

        # Snapshot for the generator (we won't carry the original db Session
        # into an async generator — see runs.py:300-356 for the canonical
        # pattern this mirrors).
        user_message_id = user_msg.id
        conversation_id = conv.id
        workspace_id = conv.workspace_id
        user_id = current_user.id
        run_id = conv.run_id
        platform_source = resolved.source == "platform"

        return StreamingResponse(
            _stream_assistant_turn(
                provider=provider,
                model=model,
                provider_name=provider_name,
                system_text=system_text,
                messages=messages,
                tools=tools,
                user_message_id=user_message_id,
                assistant_message_id=assistant_id,
                conversation_id=conversation_id,
                workspace_id=workspace_id,
                user_id=user_id,
                run_id=run_id,
                platform_source=platform_source,
                citations=citations,
                request=request,
                parallel_tools=parallel_tools,
            ),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # ----- NON-STREAMING PATH (legacy / tests / fallback) -----
    try:
        result = await provider.complete(
            model=model,
            system=system_text,
            messages=messages,
            tools=None,
            max_output_tokens=min(AI_OUTPUT_TOKEN_BUDGET, 4000),
        )
    except ProviderError as exc:
        assistant = Message(
            id=secrets.token_hex(12),
            conversation_id=conv.id,
            role=MessageRole.ASSISTANT,
            content="",
            provider=provider_name,
            model=model,
            status="error",
            error=str(exc),
            parent_message_id=user_msg.id,
        )
        db.add(assistant)
        db.commit()
        db.refresh(assistant)
        return MessageCreateResponse(
            user_message=_serialize_message(db, user_msg),
            assistant_message=_serialize_message(db, assistant),
        )
    except Exception as exc:  # pragma: no cover
        log.exception("Provider complete failed")
        raise HTTPException(status_code=502, detail=f"Provider call failed: {exc}")

    usage = result.get("usage", {}) or {}
    in_tokens = int(usage.get("input_tokens", 0) or 0)
    out_tokens = int(usage.get("output_tokens", 0) or 0)
    if resolved.source == "platform":
        key_resolver.record_platform_usage(
            db, current_user.id, input_tokens=in_tokens, output_tokens=out_tokens
        )

    cost = estimate_cost_usd(provider_name, model, in_tokens, out_tokens)
    # SECURITY: scrub internal identifiers on the non-streaming path too.
    from services.ai.security import (
        STANDARD_REFUSAL as _REFUSAL,
        heuristic_output_leak as _heur,
        scrub_output as _scrub_complete,
    )
    raw_text = result.get("text") or ""
    safe_text = _scrub_complete(raw_text)
    leaked = False
    leak_reason = ""

    # Gate 4 — output leak detection. Fail-CLOSED heuristic backstop first
    # (independent of the LLM judge), then the fail-open LLM judge for prose
    # methodology leaks. Non-streaming path is clean: a leak is fully
    # suppressed before returning.
    hb_leak, hb_reason = _heur(raw_text)
    if hb_leak:
        leaked = True
        leak_reason = f"heuristic:{hb_reason}"
    if not leaked and _LLM_JUDGE_ON and safe_text.strip():
        from services.ai.security import classify_output_for_leak

        out_verdict = await classify_output_for_leak(
            safe_text, provider=security_provider(provider), model=_JUDGE_MODEL
        )
        if out_verdict.leaked:
            leaked = True
            leak_reason = f"judge:{out_verdict.reason}"
    if leaked:
        record_audit(
            db,
            "chat.message.blocked.output_leak",
            user_id=current_user.id,
            workspace_id=conv.workspace_id,
            run_id=conv.run_id,
            details={
                "conversation_id": conv.id,
                "message_id": user_msg.id,
                "reason": leak_reason,
            },
        )
        safe_text = _REFUSAL

    assistant = Message(
        id=secrets.token_hex(12),
        conversation_id=conv.id,
        role=MessageRole.ASSISTANT,
        content=safe_text,
        citations_json=json.dumps(citations),
        tool_calls_json="[]",
        provider=provider_name,
        model=model,
        input_tokens=in_tokens,
        output_tokens=out_tokens,
        cost_usd=f"{cost:.6f}" if cost is not None else "",
        parent_message_id=user_msg.id,
        status="redacted" if leaked else "complete",
    )
    db.add(assistant)
    conv.updated_at = datetime.utcnow()
    db.add(conv)
    db.commit()
    db.refresh(assistant)

    return MessageCreateResponse(
        user_message=_serialize_message(db, user_msg),
        assistant_message=_serialize_message(db, assistant),
    )


MAX_TOOL_ITERATIONS = 4  # Hard cap per assistant turn (spec said 8; 4 is safer for v1)


def _assistant_turn_with_tools(text_parts: list[str], tool_calls: list[dict]) -> ProviderMessage:
    """Build an assistant ProviderMessage that mixes any text the model
    emitted with the tool_use blocks it asked for. This becomes part of
    `running_messages` so the model's next round sees its own previous
    output."""
    content: list = []
    text = "".join(text_parts).strip()
    if text:
        content.append({"type": "text", "text": text})
    for tc in tool_calls:
        content.append({
            "type": "tool_use",
            "id": tc.get("id", ""),
            "name": tc.get("name", ""),
            "input": tc.get("input") or {},
        })
    return ProviderMessage(role="assistant", content=content)


async def _stream_assistant_turn(
    *,
    provider,
    model: str,
    provider_name: str,
    system_text: str,
    messages: list[ProviderMessage],
    tools: Optional[list[dict]],
    user_message_id: str,
    assistant_message_id: str,
    conversation_id: str,
    workspace_id: str,
    user_id: str,
    run_id: Optional[str],
    platform_source: bool,
    citations: list[dict],
    request: Request,
    parallel_tools: bool = False,
) -> AsyncIterator[bytes]:
    """SSE generator with multi-iteration tool-use loop.

    Loop invariants:
      - At most ``MAX_TOOL_ITERATIONS`` provider rounds per turn.
      - After the cap, we inject a final "tool budget exhausted" user
        message and let the model emit a closing answer.
      - Every tool call's args + result are recorded on
        ``Message.tool_calls_json`` for audit and UI breadcrumbs.
      - Opens its own ``SessionLocal()`` — never reuses the request-scoped
        session (FastAPI closes it before the generator yields).
      - Yields ``tool_call`` and ``tool_result`` SSE events so the UI can
        show what data the model is fetching.
    """
    # Lazy imports inside the generator so the route module's import-time
    # cost doesn't grow.
    from config import RUNS_DIR as _RUNS_DIR
    from services.ai.tools import dispatch as _dispatch_tool
    from services.ai.external_lookups.dispatcher import (
        EXTERNAL_TOOL_NAMES as _EXTERNAL_TOOLS,
        dispatch as _dispatch_external,
    )

    yield _sse({
        "type": "start",
        "user_message_id": user_message_id,
        "assistant_message_id": assistant_message_id,
        "provider": provider_name,
        "model": model,
    })

    accumulated_text_parts: list[str] = []
    accumulated_tool_calls: list[dict] = []   # for Message.tool_calls_json
    usage: dict[str, int] = {"input_tokens": 0, "output_tokens": 0}
    finish_reason = ""
    error_message: Optional[str] = None
    last_persist = time.monotonic()
    PERSIST_EVERY_S = 0.75

    async def _persist_partial(*, status: str, error: str = "") -> None:
        nonlocal last_persist
        last_persist = time.monotonic()
        local_db = SessionLocal()
        try:
            msg = local_db.query(Message).filter(Message.id == assistant_message_id).first()
            if not msg:
                return
            msg.content = "".join(accumulated_text_parts)
            msg.status = status
            msg.error = error
            msg.input_tokens = usage["input_tokens"]
            msg.output_tokens = usage["output_tokens"]
            if accumulated_tool_calls:
                msg.tool_calls_json = json.dumps(accumulated_tool_calls)
            local_db.add(msg)
            local_db.commit()
        finally:
            local_db.close()

    # `running_messages` mutates across iterations to include each
    # assistant-with-tool_use turn + each user-with-tool_result turn.
    running_messages: list[ProviderMessage] = list(messages)
    cancelled = False
    iteration = 0

    try:
        while iteration < MAX_TOOL_ITERATIONS + 1:
            iteration += 1
            iteration_tool_calls: list[dict] = []   # raw {id, name, input} from provider
            iteration_text_parts: list[str] = []

            try:
                async for event in provider.stream(
                    model=model,
                    system=system_text,
                    messages=running_messages,
                    tools=tools,
                    max_output_tokens=min(AI_OUTPUT_TOKEN_BUDGET, 4000),
                ):
                    if await request.is_disconnected():
                        cancelled = True
                        break

                    etype = event.get("type")
                    if etype == "delta" and event.get("text"):
                        # SECURITY: scrub any internal identifiers (tool
                        # names, module paths, model IDs) before they reach
                        # the client.
                        from services.ai.security import scrub_output as _scrub
                        clean = _scrub(event["text"])
                        iteration_text_parts.append(clean)
                        accumulated_text_parts.append(clean)
                        yield _sse({"type": "delta", "text": clean})
                    elif etype == "tool_call":
                        tc = event.get("tool_call", {}) or {}
                        iteration_tool_calls.append(tc)
                        is_external = tc.get("name", "") in _EXTERNAL_TOOLS
                        accumulated_tool_calls.append({
                            "id": tc.get("id", ""),
                            "iteration": iteration,
                            "adapter": tc.get("name", ""),
                            "args": tc.get("input", {}),
                            "status": "called",
                            "external": is_external,
                        })
                        yield _sse({
                            "type": "tool_call",
                            "tool_call": tc,
                            "external": is_external,
                        })
                    elif etype == "usage":
                        u = event.get("usage", {}) or {}
                        usage["input_tokens"] += int(u.get("input_tokens", 0) or 0)
                        usage["output_tokens"] += int(u.get("output_tokens", 0) or 0)
                    elif etype == "finish":
                        finish_reason = event.get("finish_reason", "")
                    elif etype == "error":
                        error_message = event.get("error", "Provider stream error")
                        break

                    if time.monotonic() - last_persist >= PERSIST_EVERY_S:
                        await _persist_partial(status="streaming")
            except asyncio.CancelledError:
                cancelled = True
                await _persist_partial(status="cancelled")
                raise

            if cancelled or error_message:
                break

            # No tool calls? Model is done — exit the loop.
            if not iteration_tool_calls:
                break

            # Tool budget exhausted? Inject a tool_budget_exhausted result
            # so the model knows to wrap up with whatever it has.
            if iteration >= MAX_TOOL_ITERATIONS:
                # Append assistant turn with the unexecuted tool calls
                running_messages.append(_assistant_turn_with_tools(iteration_text_parts, iteration_tool_calls))
                # Synthetic tool_result blocks telling the model to stop.
                stop_blocks = [
                    {
                        "type": "tool_result",
                        "tool_use_id": tc.get("id", ""),
                        "content": (
                            f"[tool budget exhausted — {MAX_TOOL_ITERATIONS} tool round(s) "
                            "used this turn] Answer the user's question with the data "
                            "you've already retrieved. Do not make any more tool calls."
                        ),
                        "is_error": False,
                    }
                    for tc in iteration_tool_calls
                ]
                running_messages.append({"role": "user", "content": stop_blocks})
                # Loop to allow one more round of pure text from the model.
                # The while-loop guard `iteration < MAX_TOOL_ITERATIONS + 1`
                # allows exactly ONE more pass.
                for tc in iteration_tool_calls:
                    yield _sse({
                        "type": "tool_result",
                        "name": tc.get("name", ""),
                        "tool_use_id": tc.get("id", ""),
                        "is_error": False,
                        "rows_returned": 0,
                        "latency_ms": 0,
                        "summary": "tool budget exhausted — wrap up",
                    })
                continue

            # Normal path: dispatch each tool, build tool_result blocks.
            # Run-data tools (P4) go to the run-data dispatcher; external
            # biology lookups (P7) go to the external dispatcher, which
            # carries resolved references back for the UI breadcrumbs.
            running_messages.append(_assistant_turn_with_tools(iteration_text_parts, iteration_tool_calls))

            async def _dispatch_one(tc: dict) -> dict:
                """Run one tool call (run-data or external) and normalise the
                outcome into a uniform dict for the build/yield loop."""
                name = tc.get("name") or ""
                args = tc.get("input") or {}
                tc_id = tc.get("id", "")
                if name in _EXTERNAL_TOOLS:
                    ext_db = SessionLocal()
                    try:
                        ext = await _dispatch_external(
                            ext_db, name, args,
                            workspace_id=workspace_id,
                            conversation_id=conversation_id,
                        )
                    finally:
                        ext_db.close()
                    return {
                        "tc_id": tc_id, "name": name,
                        "content": ext.content, "is_error": ext.is_error,
                        "rows_returned": ext.rows_returned, "latency_ms": ext.latency_ms,
                        "error_kind": ext.error_kind, "cited_files": [],
                        "result_summary": {
                            "rows_returned": ext.rows_returned, "is_error": ext.is_error,
                            "latency_ms": ext.latency_ms, "error_kind": ext.error_kind,
                            "cited_files": [], "external": True, "cached": ext.cached,
                            "status": ext.status, "references": ext.references,
                        },
                        "sse_extra": {
                            "external": True, "cached": ext.cached,
                            "references": ext.references, "cited_files": [],
                        },
                        "summary": (
                            f"{len(ext.references)} reference(s)"
                            + (" · cached" if ext.cached else "")
                            if not ext.is_error
                            else f"unavailable: {ext.error_kind or 'error'}"
                        ),
                    }
                result = await _dispatch_tool(
                    name=name, args=args, run_id=run_id or "", runs_dir=_RUNS_DIR,
                )
                return {
                    "tc_id": tc_id, "name": name,
                    "content": result.content, "is_error": result.is_error,
                    "rows_returned": result.rows_returned, "latency_ms": result.latency_ms,
                    "error_kind": result.error_kind, "cited_files": result.cited_files,
                    "result_summary": {
                        "rows_returned": result.rows_returned, "is_error": result.is_error,
                        "latency_ms": result.latency_ms, "error_kind": result.error_kind,
                        "cited_files": result.cited_files, "external": False,
                    },
                    "sse_extra": {"external": False, "cited_files": result.cited_files},
                    "summary": (
                        f"{result.rows_returned} rows"
                        if not result.is_error
                        else f"error: {result.error_kind or 'unknown'}"
                    ),
                }

            # Parallel mode (P8) — a workspace admin can allow concurrent
            # dispatch when the model emits multiple tool calls at once.
            if parallel_tools and len(iteration_tool_calls) > 1:
                dispatched = list(await asyncio.gather(
                    *[_dispatch_one(tc) for tc in iteration_tool_calls]
                ))
            else:
                dispatched = [await _dispatch_one(tc) for tc in iteration_tool_calls]

            result_blocks: list[dict] = []
            for d in dispatched:
                for f in d["cited_files"]:
                    if not any(c.get("file_path") == f for c in citations):
                        citations.append({"file_path": f, "run_id": run_id})
                # Scrub the CLIENT-facing + persisted result fields (summary,
                # breadcrumb) so an internal identifier in a tool result can't
                # surface in the UI or stored history (audit M2). The
                # model-facing `content` is left intact — the model needs the
                # raw run data, and its eventual answer is itself scrubbed +
                # leak-judged downstream.
                from services.ai.security import scrub_output as _scrub_tr
                _scrub_if_str = lambda v: _scrub_tr(v) if isinstance(v, str) else v
                safe_summary = _scrub_if_str(d["summary"])
                safe_result_summary = _scrub_if_str(d["result_summary"])
                # Attach the result onto its accumulated entry, matched by id.
                for entry in accumulated_tool_calls:
                    if entry.get("id") == d["tc_id"] and "result" not in entry:
                        entry["result"] = safe_result_summary
                        entry["status"] = "error" if d["is_error"] else "done"
                        break
                result_blocks.append({
                    "type": "tool_result",
                    "tool_use_id": d["tc_id"],
                    "content": d["content"],
                    "is_error": d["is_error"],
                })
                yield _sse({
                    "type": "tool_result",
                    "name": d["name"],
                    "tool_use_id": d["tc_id"],
                    "is_error": d["is_error"],
                    "rows_returned": d["rows_returned"],
                    "latency_ms": d["latency_ms"],
                    "error_kind": d["error_kind"],
                    "summary": safe_summary,
                    **d["sse_extra"],
                })

            running_messages.append({"role": "user", "content": result_blocks})
            # Loop back — model will get a new turn with the tool results.

    except asyncio.CancelledError:
        cancelled = True
        await _persist_partial(status="cancelled")
        raise
    except Exception as exc:  # pragma: no cover
        log.exception("Streaming turn failed")
        error_message = str(exc)

    if cancelled:
        await _persist_partial(status="cancelled")
        return

    if error_message:
        await _persist_partial(status="error", error=error_message)
        yield _sse({"type": "error", "error": error_message})
        return

    # Gate 4 (streaming) — LLM-judge output classifier (P12 L3b). The per-
    # delta regex scrubber already ran live; this catches PROSE methodology
    # leaks that no regex can detect. Streaming can't un-send tokens the
    # client already saw, so on a detected leak we (a) overwrite the
    # persisted content with the standard refusal — a page reload shows the
    # clean version, (b) emit a `redacted` SSE event so the live UI replaces
    # the bubble immediately, (c) audit-log the incident.
    final_answer_text = "".join(accumulated_text_parts)
    redacted = False
    leak_reason = ""
    # Fail-CLOSED deterministic backstop — runs first, independent of the LLM
    # judge, so a Haiku outage/rate-limit can't slip a leak past this gate.
    try:
        from services.ai.security import heuristic_output_leak as _heur
        hb_leak, hb_reason = _heur(final_answer_text)
        if hb_leak:
            redacted = True
            leak_reason = f"heuristic:{hb_reason}"
    except Exception as exc:  # pragma: no cover
        log.warning("Streaming leak backstop failed: %s", exc)
    try:
        from config import (
            AI_SECURITY_JUDGE_MODEL as _JM,
            AI_SECURITY_LLM_JUDGE as _JUDGE_ON,
        )

        if not redacted and _JUDGE_ON and final_answer_text.strip():
            from services.ai.security import classify_output_for_leak as _classify_out

            out_verdict = await _classify_out(
                final_answer_text, provider=security_provider(provider), model=_JM
            )
            if out_verdict.leaked:
                redacted = True
                leak_reason = f"judge:{out_verdict.reason}"
    except Exception as exc:  # pragma: no cover — judge fails open; heuristic already ran
        log.warning("Streaming output judge failed (fail-open): %s", exc)
    if redacted:
        from services.ai.security import STANDARD_REFUSAL as _REFUSAL

        final_answer_text = _REFUSAL
        audit_db = SessionLocal()
        try:
            record_audit(
                audit_db,
                "chat.message.blocked.output_leak",
                user_id=user_id,
                workspace_id=workspace_id,
                run_id=run_id,
                details={
                    "conversation_id": conversation_id,
                    "assistant_message_id": assistant_message_id,
                    "reason": leak_reason,
                },
            )
        finally:
            audit_db.close()

    # Finalize: record platform usage, persist final assistant message,
    # emit usage + finish events with cost estimate.
    final_db = SessionLocal()
    try:
        if platform_source:
            key_resolver.record_platform_usage(
                final_db,
                user_id,
                input_tokens=usage["input_tokens"],
                output_tokens=usage["output_tokens"],
            )
        cost = estimate_cost_usd(
            provider_name, model, usage["input_tokens"], usage["output_tokens"]
        )
        msg = final_db.query(Message).filter(Message.id == assistant_message_id).first()
        if msg is not None:
            msg.content = final_answer_text
            msg.input_tokens = usage["input_tokens"]
            msg.output_tokens = usage["output_tokens"]
            msg.cost_usd = f"{cost:.6f}" if cost is not None else ""
            msg.status = "redacted" if redacted else "complete"
            msg.error = ""
            if accumulated_tool_calls:
                msg.tool_calls_json = json.dumps(accumulated_tool_calls)
            final_db.add(msg)
            # Bump conv.updated_at for sort order.
            conv_row = final_db.query(Conversation).filter(
                Conversation.id == conversation_id
            ).first()
            if conv_row is not None:
                conv_row.updated_at = datetime.utcnow()
                final_db.add(conv_row)
            final_db.commit()
    finally:
        final_db.close()

    # If the output judge flagged a leak, tell the live client to replace
    # the bubble it just streamed with the clean refusal.
    if redacted:
        yield _sse({"type": "redacted", "text": final_answer_text})

    # When the platform key was the source for this turn, surface the fresh
    # quota snapshot so the UI gauge can refresh without an extra round-trip.
    # When the user has their own key, omit the quota field entirely — the
    # platform quota doesn't apply to them.
    usage_event: dict = {
        "type": "usage",
        "input_tokens": usage["input_tokens"],
        "output_tokens": usage["output_tokens"],
        "cost_usd": estimate_cost_usd(
            provider_name, model, usage["input_tokens"], usage["output_tokens"]
        ),
        "key_source": "platform" if platform_source else "user",
    }
    if platform_source:
        from services.ai.key_resolver import quota_status as _quota_status
        snapshot_db = SessionLocal()
        try:
            usage_event["platform_quota"] = _quota_status(snapshot_db, user_id)
        finally:
            snapshot_db.close()
    yield _sse(usage_event)
    yield _sse({
        "type": "finish",
        "finish_reason": finish_reason or "stop",
        "citations": citations,
    })

    # Follow-up question chips (P5.2). Cheap Haiku call; failure is silent
    # — followups are pure polish and must never break the main turn.
    # Skipped entirely when the answer was redacted — we don't want chips
    # generated from leaked content.
    if not redacted:
        try:
            from services.ai.context_builder import generate_followups as _gen_fu

            original_question = ""
            for m in reversed(messages):
                if m.get("role") == "user":
                    for p in m.get("content") or []:
                        if isinstance(p, dict) and p.get("type") == "text":
                            original_question = p.get("text") or ""
                            break
                    if original_question:
                        break
            followups = await _gen_fu(
                question=original_question,
                answer=final_answer_text,
                provider=provider,
                model="claude-haiku-4-5",
            )
            if followups:
                yield _sse({"type": "followups", "items": followups})
        except Exception as exc:  # pragma: no cover
            log.debug("Follow-up emission failed: %s", exc)
