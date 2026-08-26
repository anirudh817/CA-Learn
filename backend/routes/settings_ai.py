"""AI settings routes — BYOK keys, provider/model defaults, workspace policy.

Keys are encrypted at rest (Fernet keyed off SESSION_SECRET) and never
returned to the client. Responses surface only ``has_*_key`` booleans plus a
per-provider summary with the resolved source.
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import (
    ExternalLookupsPolicy,
    Membership,
    User,
    Workspace,
    WorkspaceAISettings,
    WorkspaceRole,
    get_db,
)
from deps import get_current_user, require_workspace_access
from schemas import (
    AIKeyUpdate,
    AISettingsRead,
    ProviderCatalogEntry,
    ProviderKeyStatus,
    ProviderModelEntry,
    WorkspaceAISettingsUpdate,
)
from services.ai import crypto, key_resolver
from services.ai.dispatcher import (
    get_provider,
    provider_status_summary,
)
from services.ai.key_resolver import (
    InvalidKeyFormat,
    get_user_key_labels,
    mask_key,
    quota_status,
    resolve_key,
    set_user_default,
    set_user_key,
    set_user_key_label,
)
from services.ai.providers.base import ProviderError
from services.ai.providers.catalog import (
    PROVIDER_CATALOG,
    default_model_for,
    list_providers,
)
from services.audit_service import record_audit

router = APIRouter()


# ---------------------------------------------------------------------------
# Catalog / discovery (used by Settings drawer)
# ---------------------------------------------------------------------------

@router.get("/settings/ai/providers", response_model=list[ProviderCatalogEntry])
def get_provider_catalog():
    out: list[ProviderCatalogEntry] = []
    for entry in list_providers():
        out.append(
            ProviderCatalogEntry(
                id=entry["id"],
                label=entry["label"],
                default_model=entry["default_model"],
                models=[ProviderModelEntry(**m) for m in entry["models"]],
            )
        )
    return out


# ---------------------------------------------------------------------------
# User AI settings (BYOK + default provider/model)
# ---------------------------------------------------------------------------

def _build_settings_payload(
    db: Session, user: User, *, default_workspace_id: str | None
) -> AISettingsRead:
    settings = key_resolver._user_settings(db, user.id)  # type: ignore[attr-defined]
    user_keys = crypto.decrypt_dict(settings.encrypted_keys_json)
    labels = get_user_key_labels(db, user.id)
    summary = provider_status_summary(
        db, user_id=user.id, workspace_id=default_workspace_id
    )
    providers_payload = {
        pid: ProviderKeyStatus(
            configured=summary[pid]["configured"],
            source=summary[pid]["source"],
            label=summary[pid]["label"],
            default_model=summary[pid]["default_model"],
        )
        for pid in summary
    }
    provider = "anthropic"  # v1 — locked
    model = settings.default_model or default_model_for(provider)
    anth_key = user_keys.get("anthropic", "")
    return AISettingsRead(
        provider=provider,
        model=model,
        has_anthropic_key=bool(anth_key),
        anthropic_key_preview=mask_key(anth_key) if anth_key else "",
        anthropic_key_label=labels.get("anthropic", ""),
        providers=providers_payload,
        platform_quota=quota_status(db, user.id),
    )


def _first_workspace(db: Session, user_id: str) -> str | None:
    """Used to surface platform/workspace key fallback in /settings/ai.

    The route is per-user, but a user may belong to multiple workspaces. We
    pick the first workspace by membership creation order for the summary
    only; per-request resolution always uses the conversation's workspace.
    """
    row = (
        db.query(Membership)
        .filter(Membership.user_id == user_id)
        .order_by(Membership.created_at.asc())
        .first()
    )
    return row.workspace_id if row else None


@router.get("/settings/ai", response_model=AISettingsRead)
def get_ai_settings(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    workspace_id = _first_workspace(db, current_user.id)
    return _build_settings_payload(db, current_user, default_workspace_id=workspace_id)


@router.put("/settings/ai", response_model=AISettingsRead)
def put_ai_settings(
    req: AIKeyUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    fields = req.model_dump(exclude_unset=True)

    key_updates_applied: list[str] = []
    if "anthropic_key" in fields:
        try:
            set_user_key(db, current_user.id, "anthropic", fields["anthropic_key"])
        except InvalidKeyFormat as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        key_updates_applied.append("anthropic")
    if "anthropic_key_label" in fields:
        set_user_key_label(db, current_user.id, "anthropic", fields["anthropic_key_label"])

    # ``provider`` is locked to anthropic in v1 — accept the field for
    # forward compatibility, ignore any other value.
    model = fields.get("model")
    if model is not None:
        set_user_default(db, current_user.id, provider="anthropic", model=model)

    workspace_id = _first_workspace(db, current_user.id)
    record_audit(
        db,
        "chat.settings.updated",
        user_id=current_user.id,
        workspace_id=workspace_id,
        details={"keys_updated": key_updates_applied, "model": model},
    )
    return _build_settings_payload(db, current_user, default_workspace_id=workspace_id)


@router.post("/settings/ai/test")
async def test_ai_key(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Cheapest possible round-trip to Anthropic to verify the saved key works.
    Returns ``{ok: True}`` on success, ``{ok: False, detail: "..."}`` on
    auth/network failure — never raises so the UI can render either path."""
    workspace_id = _first_workspace(db, current_user.id)
    resolved = resolve_key(
        db, user_id=current_user.id, workspace_id=workspace_id, provider="anthropic"
    )
    if not resolved.key:
        return {
            "ok": False,
            "source": "missing",
            "detail": "No Anthropic API key configured. Paste one in the field above first.",
        }
    try:
        provider = get_provider("anthropic", resolved.key)
        # 1-token, 1-message ping. Catches 401/403/network/SSL issues for ~$0.0001.
        await provider.complete(
            model="claude-haiku-4-5",
            system="",
            messages=[{"role": "user", "content": [{"type": "text", "text": "ping"}]}],
            tools=None,
            max_output_tokens=8,
        )
        return {"ok": True, "source": resolved.source, "detail": "Key works — Anthropic accepted the test request."}
    except ProviderError as exc:
        return {"ok": False, "source": resolved.source, "detail": str(exc)}
    except Exception as exc:  # pragma: no cover
        return {"ok": False, "source": resolved.source, "detail": f"Test failed: {exc}"}


@router.delete("/settings/ai/keys/{provider}", response_model=AISettingsRead)
def delete_ai_key(
    provider: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if provider not in PROVIDER_CATALOG:
        raise HTTPException(status_code=400, detail=f"Unknown provider '{provider}'")
    set_user_key(db, current_user.id, provider, None)  # type: ignore[arg-type]
    workspace_id = _first_workspace(db, current_user.id)
    record_audit(
        db,
        "chat.settings.key.cleared",
        user_id=current_user.id,
        workspace_id=workspace_id,
        details={"provider": provider},
    )
    return _build_settings_payload(db, current_user, default_workspace_id=workspace_id)


# ---------------------------------------------------------------------------
# Workspace-level AI settings (admin only)
# ---------------------------------------------------------------------------

def _require_admin(db: Session, user_id: str, workspace_id: str) -> Workspace:
    workspace = require_workspace_access(db, user_id, workspace_id)
    membership = (
        db.query(Membership)
        .filter(Membership.user_id == user_id, Membership.workspace_id == workspace_id)
        .first()
    )
    if not membership or membership.role != WorkspaceRole.ADMIN:
        raise HTTPException(status_code=403, detail="Workspace admin role required")
    return workspace


@router.put("/workspaces/{workspace_id}/ai-settings")
def put_workspace_ai_settings(
    workspace_id: str,
    req: WorkspaceAISettingsUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_admin(db, current_user.id, workspace_id)
    settings = key_resolver._workspace_settings(db, workspace_id)  # type: ignore[attr-defined]
    keys = crypto.decrypt_dict(settings.encrypted_keys_json)
    fields = req.model_dump(exclude_unset=True)
    if "anthropic_key" in fields:
        val = fields["anthropic_key"]
        if val:
            keys["anthropic"] = val
        else:
            keys.pop("anthropic", None)
    settings.encrypted_keys_json = crypto.encrypt_dict(keys)
    if req.external_lookups_policy is not None:
        settings.external_lookups_policy = ExternalLookupsPolicy(req.external_lookups_policy)
    if req.parallel_tool_calls is not None:
        settings.parallel_tool_calls = req.parallel_tool_calls
    settings.updated_at = datetime.utcnow()
    db.add(settings)
    db.commit()
    record_audit(
        db,
        "chat.workspace_settings.updated",
        user_id=current_user.id,
        workspace_id=workspace_id,
        details={"fields": list(fields.keys())},
    )
    return {
        "workspace_id": workspace_id,
        "external_lookups_policy": settings.external_lookups_policy.value,
        "parallel_tool_calls": settings.parallel_tool_calls,
        "has_anthropic_key": bool(keys.get("anthropic")),
    }


@router.get("/workspaces/{workspace_id}/ai-settings")
def get_workspace_ai_settings(
    workspace_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Admin-only — current external-lookups policy, parallel-mode flag, and
    per-adapter daily usage. Powers the workspace admin panel; a non-admin
    gets HTTP 403 (the frontend hides the panel on that response)."""
    _require_admin(db, current_user.id, workspace_id)
    settings = key_resolver._workspace_settings(db, workspace_id)  # type: ignore[attr-defined]
    keys = crypto.decrypt_dict(settings.encrypted_keys_json)

    from services.ai.external_lookups import quotas as _quotas
    from services.ai.external_lookups.dispatcher import ADAPTERS

    adapter_usage = []
    for adapter_id in sorted({a.id for a in ADAPTERS.values()}):
        _, used, limit = _quotas.check(db, workspace_id, adapter_id)
        adapter_usage.append({
            "adapter": adapter_id,
            "used_today": used,
            "daily_limit": limit,
        })

    return {
        "workspace_id": workspace_id,
        "external_lookups_policy": settings.external_lookups_policy.value,
        "parallel_tool_calls": settings.parallel_tool_calls,
        "has_anthropic_key": bool(keys.get("anthropic")),
        "adapter_usage": adapter_usage,
    }
