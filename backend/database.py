from __future__ import annotations

import enum
from datetime import datetime, timedelta

from sqlalchemy import Boolean, Column, DateTime, Enum as SAEnum, ForeignKey, Integer, String, Text, create_engine, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker

from config import DATABASE_URL, SQLITE_CONNECT_ARGS

engine = create_engine(DATABASE_URL, connect_args=SQLITE_CONNECT_ARGS, future=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, future=True)
Base = declarative_base()


class WorkspaceRole(str, enum.Enum):
    ADMIN = "admin"
    MEMBER = "member"
    VIEWER = "viewer"


class RunStatus(str, enum.Enum):
    DRAFT = "draft"
    QUEUED = "queued"
    RUNNING = "running"
    AWAITING_REVIEW = "awaiting_review"
    COMPLETE = "complete"
    FAILED = "failed"
    ARCHIVED = "archived"
    TRASHED = "trashed"


class StageStatus(str, enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETE = "complete"
    FAILED = "failed"
    SKIPPED = "skipped"


class UploadKind(str, enum.Enum):
    PRIMARY = "primary"
    TRAITS = "traits"
    REFERENCE = "reference"


class ShareScope(str, enum.Enum):
    RUN = "run"
    PROJECT = "project"


class MessageRole(str, enum.Enum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    TOOL = "tool"


class AttachmentKind(str, enum.Enum):
    FILE = "file"
    IMAGE = "image"
    RUN_LINK = "run_link"


class ExternalLookupsPolicy(str, enum.Enum):
    ALLOW = "allow"
    DENY = "deny"
    DEFAULT_ON = "default_on"
    DEFAULT_OFF = "default_off"


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True)
    email = Column(String, unique=True, nullable=False)
    password_hash = Column(String, nullable=False)
    display_name = Column(String, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class SessionToken(Base):
    __tablename__ = "session_tokens"

    id = Column(String, primary_key=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    token_hash = Column(String, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_used_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class Workspace(Base):
    __tablename__ = "workspaces"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    slug = Column(String, unique=True, nullable=False)
    created_by = Column(String, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class Membership(Base):
    __tablename__ = "memberships"

    id = Column(String, primary_key=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=False)
    role = Column(SAEnum(WorkspaceRole), default=WorkspaceRole.ADMIN, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class Project(Base):
    __tablename__ = "projects"

    id = Column(String, primary_key=True)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=False)
    name = Column(String, nullable=False)
    slug = Column(String, nullable=False)
    description = Column(Text, default="", nullable=False)
    created_by = Column(String, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class UploadedDataset(Base):
    __tablename__ = "uploaded_datasets"

    id = Column(String, primary_key=True)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=False)
    project_id = Column(String, ForeignKey("projects.id"))
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    file_kind = Column(SAEnum(UploadKind), default=UploadKind.PRIMARY, nullable=False)
    original_name = Column(String, nullable=False)
    stored_path = Column(String, nullable=False)
    size_bytes = Column(Integer, nullable=False)
    uploaded_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    format_detected = Column(String, default="Unknown", nullable=False)
    format_family = Column(String, default="Unknown", nullable=False)
    assay_level = Column(String, default="unknown", nullable=False)
    peptide_count = Column(Integer, default=0)
    sample_count = Column(Integer, default=0)
    dataset_hash = Column(String, default="", nullable=False)
    sniff_metadata_json = Column(Text, default="{}", nullable=False)


class Run(Base):
    __tablename__ = "runs"

    id = Column(String, primary_key=True)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=False)
    project_id = Column(String, ForeignKey("projects.id"))
    created_by = Column(String, ForeignKey("users.id"), nullable=False)
    name = Column(String, nullable=False)
    file_id = Column(String, ForeignKey("uploaded_datasets.id"), nullable=False)
    file_name = Column(String, nullable=False)
    traits_file_id = Column(String, ForeignKey("uploaded_datasets.id"))
    source_run_id = Column(String, ForeignKey("runs.id"))
    duplicate_of_run_id = Column(String, ForeignKey("runs.id"))
    status = Column(SAEnum(RunStatus), default=RunStatus.QUEUED, nullable=False)
    params = Column(Text, default="{}", nullable=False)
    dataset_hash = Column(String, default="", nullable=False)
    param_fingerprint = Column(String, default="", nullable=False)
    analysis_format = Column(String, default="Unknown", nullable=False)
    input_level = Column(String, default="unknown", nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    started_at = Column(DateTime)
    completed_at = Column(DateTime)
    modules_count = Column(Integer)
    sig_peptides = Column(Integer)
    up_peptides = Column(Integer)
    down_peptides = Column(Integer)
    go_terms = Column(Integer)
    error_message = Column(Text)
    log = Column(Text, default="", nullable=False)
    metrics_json = Column(Text, default="{}", nullable=False)
    manifest_path = Column(String, default="", nullable=False)
    trashed_at = Column(DateTime)
    app_version = Column(String, default="", nullable=False)


class RunStageStatus(Base):
    __tablename__ = "run_stage_statuses"

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String, ForeignKey("runs.id"), nullable=False)
    stage_key = Column(String, nullable=False)
    status = Column(SAEnum(StageStatus), default=StageStatus.PENDING, nullable=False)
    progress = Column(Integer, default=0, nullable=False)
    message = Column(Text, default="", nullable=False)
    started_at = Column(DateTime)
    completed_at = Column(DateTime)


class RunFile(Base):
    __tablename__ = "run_files"

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String, ForeignKey("runs.id"), nullable=False)
    stage = Column(String, nullable=False)
    filename = Column(String, nullable=False)
    rel_path = Column(String, nullable=False)
    size_bytes = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class ShareLink(Base):
    __tablename__ = "share_links"

    id = Column(String, primary_key=True)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=False)
    project_id = Column(String, ForeignKey("projects.id"))
    run_id = Column(String, ForeignKey("runs.id"))
    scope = Column(SAEnum(ShareScope), default=ShareScope.RUN, nullable=False)
    title = Column(String, nullable=False)
    token = Column(String, unique=True, nullable=False)
    auth_required = Column(Boolean, default=False, nullable=False)
    expires_at = Column(DateTime)
    created_by = Column(String, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    workspace_id = Column(String, ForeignKey("workspaces.id"))
    project_id = Column(String, ForeignKey("projects.id"))
    run_id = Column(String, ForeignKey("runs.id"))
    user_id = Column(String, ForeignKey("users.id"))
    action_type = Column(String, nullable=False)
    details_json = Column(Text, default="{}", nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


UploadedFile = UploadedDataset


# ---------------------------------------------------------------------------
# AI / Chat models (additive, auto-created on next init_db())
# ---------------------------------------------------------------------------


class UserAISettings(Base):
    __tablename__ = "user_ai_settings"

    user_id = Column(String, ForeignKey("users.id"), primary_key=True)
    default_provider = Column(String, default="anthropic", nullable=False)
    default_model = Column(String, default="", nullable=False)
    encrypted_keys_json = Column(Text, default="", nullable=False)
    # JSON object {provider: "user-supplied label"}. Plain text — not encrypted.
    key_labels_json = Column(Text, default="{}", nullable=False)
    platform_tokens_used_today = Column(Integer, default=0, nullable=False)
    platform_reqs_used_today = Column(Integer, default=0, nullable=False)
    platform_quota_reset_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class WorkspaceAISettings(Base):
    __tablename__ = "workspace_ai_settings"

    workspace_id = Column(String, ForeignKey("workspaces.id"), primary_key=True)
    encrypted_keys_json = Column(Text, default="", nullable=False)
    external_lookups_policy = Column(
        SAEnum(ExternalLookupsPolicy),
        default=ExternalLookupsPolicy.DEFAULT_OFF,
        nullable=False,
    )
    parallel_tool_calls = Column(Boolean, default=False, nullable=False)
    daily_quotas_json = Column(Text, default="{}", nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class Conversation(Base):
    __tablename__ = "conversations"

    id = Column(String, primary_key=True)
    run_id = Column(String, ForeignKey("runs.id"), nullable=True)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=False)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    title = Column(String, default="New conversation", nullable=False)
    provider = Column(String, default="anthropic", nullable=False)
    model = Column(String, default="", nullable=False)
    external_lookups_enabled = Column(Boolean, default=False, nullable=False)
    system_prompt_version = Column(String, default="v1", nullable=False)
    archived = Column(Boolean, default=False, nullable=False)
    pinned_message_id = Column(String, nullable=True)
    pinned_refs_json = Column(Text, default="[]", nullable=False)
    discovery_mode = Column(String, default="auto", nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class Message(Base):
    __tablename__ = "messages"

    id = Column(String, primary_key=True)
    conversation_id = Column(String, ForeignKey("conversations.id"), nullable=False, index=True)
    role = Column(SAEnum(MessageRole), nullable=False)
    content = Column(Text, default="", nullable=False)
    attachments_json = Column(Text, default="[]", nullable=False)
    citations_json = Column(Text, default="[]", nullable=False)
    tool_calls_json = Column(Text, default="[]", nullable=False)
    provider = Column(String, default="", nullable=False)
    model = Column(String, default="", nullable=False)
    input_tokens = Column(Integer, default=0, nullable=False)
    output_tokens = Column(Integer, default=0, nullable=False)
    cost_usd = Column(String, default="", nullable=False)
    parent_message_id = Column(String, nullable=True)
    status = Column(String, default="complete", nullable=False)
    error = Column(Text, default="", nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class Attachment(Base):
    __tablename__ = "attachments"

    id = Column(String, primary_key=True)
    conversation_id = Column(String, ForeignKey("conversations.id"), nullable=False, index=True)
    message_id = Column(String, ForeignKey("messages.id"), nullable=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    kind = Column(SAEnum(AttachmentKind), nullable=False)
    filename = Column(String, nullable=False)
    mime_type = Column(String, default="application/octet-stream", nullable=False)
    size_bytes = Column(Integer, default=0, nullable=False)
    storage_path = Column(String, nullable=False)
    preview_text = Column(Text, default="", nullable=False)
    sha256 = Column(String, default="", nullable=False)
    uploaded_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class ExternalLookupCache(Base):
    __tablename__ = "external_lookup_cache"

    cache_key = Column(String, primary_key=True)
    adapter = Column(String, nullable=False, index=True)
    args_json = Column(Text, nullable=False)
    response_json = Column(Text, nullable=False)
    fetched_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    hit_count = Column(Integer, default=0, nullable=False)


class ExternalLookupQuotaUsage(Base):
    __tablename__ = "external_lookup_quota_usage"

    id = Column(Integer, primary_key=True, autoincrement=True)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=False, index=True)
    adapter = Column(String, nullable=False, index=True)
    day = Column(String, nullable=False, index=True)
    call_count = Column(Integer, default=0, nullable=False)


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    _migrate_sqlite_schema()


def _migrate_sqlite_schema() -> None:
    inspector = inspect(engine)
    statements: list[str] = []
    tables = set(inspector.get_table_names())

    if "runs" in tables:
        run_columns = {column["name"] for column in inspector.get_columns("runs")}
        if "trashed_at" not in run_columns:
            statements.append("ALTER TABLE runs ADD COLUMN trashed_at DATETIME")
        if "app_version" not in run_columns:
            statements.append("ALTER TABLE runs ADD COLUMN app_version TEXT NOT NULL DEFAULT ''")

    if "user_ai_settings" in tables:
        user_ai_cols = {column["name"] for column in inspector.get_columns("user_ai_settings")}
        if "key_labels_json" not in user_ai_cols:
            statements.append("ALTER TABLE user_ai_settings ADD COLUMN key_labels_json TEXT NOT NULL DEFAULT '{}'")

    if "conversations" in tables:
        conversation_cols = {column["name"] for column in inspector.get_columns("conversations")}
        if "pinned_refs_json" not in conversation_cols:
            statements.append("ALTER TABLE conversations ADD COLUMN pinned_refs_json TEXT NOT NULL DEFAULT '[]'")
        if "discovery_mode" not in conversation_cols:
            statements.append("ALTER TABLE conversations ADD COLUMN discovery_mode TEXT NOT NULL DEFAULT 'auto'")

    if not statements:
        return
    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def default_session_expiry() -> datetime:
    return datetime.utcnow() + timedelta(days=30)
