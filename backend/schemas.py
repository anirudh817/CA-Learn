from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


class RegisterRequest(BaseModel):
    email: str
    password: str
    display_name: str
    workspace_name: Optional[str] = None


class LoginRequest(BaseModel):
    email: str
    password: str


class SessionResponse(BaseModel):
    token: str
    user: dict[str, Any]
    workspaces: list[dict[str, Any]]


class WorkspaceCreateRequest(BaseModel):
    name: str


class ProjectCreateRequest(BaseModel):
    workspace_id: str
    name: str
    description: str = ""


class PipelineParams(BaseModel):
    normalization_method: Literal["median", "mean", "quantile", "tin", "zscore", "none"] = "median"
    normalization_strategy: Literal["column"] = "column"
    normalization_center: Literal["median"] = "median"
    tampor_mode: Literal["one_way"] = "one_way"
    tampor_iterations: int = Field(default=1, ge=1, le=1)
    imputation_method: Literal["none"] = "none"
    missing_value_threshold: float = Field(default=0.5, ge=0, le=1)
    log_transform: bool = True
    min_samples_present: int = Field(default=3, ge=1)
    outlier_z_threshold: float = Field(default=3.0, gt=0)
    outlier_mode: Literal["low_connectivity"] = "low_connectivity"
    variance_correction_enabled: bool = False
    variance_correction_method: Literal["linear_regression", "residual"] = "linear_regression"
    batch_covariates: list[str] = Field(default_factory=list)
    preserve_biological_variables: list[str] = Field(default_factory=list)
    statistical_test: Literal["t-test", "wilcoxon"] = "t-test"
    pvalue_threshold: float = Field(default=0.05, gt=0, le=1)
    fold_change_threshold: float = Field(default=1.5, ge=1)
    use_adjusted_pvalue: bool = True
    multiple_testing_method: Literal["fdr_bh", "bonferroni"] = "fdr_bh"
    wgcna_power: int = Field(default=8, ge=1, le=20)
    wgcna_power_mode: Literal["fixed", "auto_pick"] = "fixed"
    wgcna_auto_power_cutoff: float = Field(default=0.8, gt=0, lt=1)
    min_module_size: int = Field(default=20, ge=2)
    deep_split: int = Field(default=3, ge=0, le=4)
    merge_cut_height: float = Field(default=0.30, ge=0, le=1)
    network_type: Literal["signed", "unsigned"] = "signed"
    correlation_type: Literal["bicor", "pearson"] = "bicor"
    tom_type: Literal["signed", "unsigned"] = "signed"
    pam_stage: bool = True
    gmt_background_behavior: Literal["measured_features", "gmt_universe"] = "measured_features"
    go_categories: list[str] = Field(default_factory=lambda: ["BP", "MF", "CC"])
    fdr_threshold: float = Field(default=0.05, gt=0, le=1)
    remove_redundant_go: Literal["none", "kappa"] = "kappa"
    min_hits_per_ontology: int = Field(default=5, ge=1)
    go_min_hits: int = Field(default=5, ge=1)
    heatmap_scale: Literal["minusLogFDR", "p.unadj"] = "minusLogFDR"
    adjust_fet_lookup: bool = False
    celltype_reference: Literal["human_sharma_zhang_union", "mouse_reference", "custom"] = "human_sharma_zhang_union"
    celltype_species_mode: Literal["human", "mouse"] = "human"
    celltype_duplicate_handling: Literal["allow", "collapse"] = "allow"
    gis_handling: str = "auto"
    gmt_file: Optional[str] = None
    celltype_markers_file: Optional[str] = None

    @field_validator("go_categories")
    @classmethod
    def _validate_go_categories(cls, value: list[str]) -> list[str]:
        allowed = {"BP", "MF", "CC"}
        if not value:
            raise ValueError("go_categories must contain at least one category")
        invalid = sorted(set(value) - allowed)
        if invalid:
            raise ValueError(f"unsupported GO categories: {invalid}")
        return value

    @model_validator(mode="after")
    def _validate_applicability(self) -> "PipelineParams":
        if self.variance_correction_enabled and not self.batch_covariates:
            raise ValueError("variance_correction_enabled requires at least one batch_covariate")
        if self.celltype_reference == "custom" and not self.celltype_markers_file:
            raise ValueError("celltype_reference='custom' requires celltype_markers_file")
        if self.normalization_strategy != "column":
            raise ValueError("only column normalization strategy is currently implemented")
        return self


class CreateRunRequest(BaseModel):
    workspace_id: str
    project_id: Optional[str] = None
    name: str
    dataset_id: str
    traits_dataset_id: Optional[str] = None
    cohort1: str = "Control"
    cohort2: str = "Disease"
    source_run_id: Optional[str] = None
    params: PipelineParams = Field(default_factory=PipelineParams)


class CompareRunsRequest(BaseModel):
    left_run_id: str
    right_run_id: str


class ShareLinkCreateRequest(BaseModel):
    workspace_id: str
    project_id: Optional[str] = None
    run_id: Optional[str] = None
    title: str
    auth_required: bool = False
    expires_at: Optional[datetime] = None


# ---------------------------------------------------------------------------
# AI / Chat schemas
# ---------------------------------------------------------------------------

# Legacy schemas retained for any external consumers; the legacy route now
# returns HTTP 410 with a migration hint.
class AIQueryRequest(BaseModel):
    question: str
    run_ids: list[str] = Field(default_factory=list)


class AIQueryResponse(BaseModel):
    status: str
    provider: str
    markdown: str
    citations: list[dict[str, Any]] = Field(default_factory=list)
    available: bool = True


# ----- Settings -----
class AIKeyUpdate(BaseModel):
    """Body for PUT /api/settings/ai. All fields optional; only provided
    fields are updated. Passing an empty string clears that key.

    v1 only accepts ``anthropic_key`` — other provider fields removed.
    ``provider`` is also retained but always normalized to ``"anthropic"``
    on the server side (model is the only meaningful knob today).
    """

    provider: Optional[str] = None
    model: Optional[str] = None
    anthropic_key: Optional[str] = None
    anthropic_key_label: Optional[str] = None


class ProviderKeyStatus(BaseModel):
    configured: bool
    source: Literal["user", "workspace", "platform", "missing"]
    label: str
    default_model: str


class AISettingsRead(BaseModel):
    provider: str
    model: str
    has_anthropic_key: bool
    anthropic_key_preview: str = ""    # e.g. "sk-ant-•••••3K2j" — only present when has_anthropic_key=true
    anthropic_key_label: str = ""      # user-supplied nickname for the key
    providers: dict[str, ProviderKeyStatus]
    platform_quota: dict[str, Any]


class ProviderModelEntry(BaseModel):
    id: str
    label: str
    vision: bool
    max_input: int
    max_output: int
    cost_in_per_1m: float
    cost_out_per_1m: float


class ProviderCatalogEntry(BaseModel):
    id: str
    label: str
    default_model: str
    models: list[ProviderModelEntry]


class WorkspaceAISettingsUpdate(BaseModel):
    anthropic_key: Optional[str] = None
    external_lookups_policy: Optional[Literal["allow", "deny", "default_on", "default_off"]] = None
    parallel_tool_calls: Optional[bool] = None


# ----- Conversation -----
class ArtifactRef(BaseModel):
    """A file the user explicitly pinned / @-mentioned into a turn.

    Either a run artifact (a path under data/runs/{run_id}/) or one of the
    conversation's own uploaded attachments. ``run_id`` is optional for
    current-run artifacts and required only for cross-run references.
    """

    kind: Literal["run_artifact", "attachment"]
    run_id: Optional[str] = None         # run_artifact, defaults to conversation run
    rel_path: Optional[str] = None       # run_artifact
    attachment_id: Optional[str] = None  # attachment
    label: str = ""


class ConversationCreate(BaseModel):
    title: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None


class ConversationPatch(BaseModel):
    title: Optional[str] = None
    archived: Optional[bool] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    external_lookups_enabled: Optional[bool] = None
    pinned_refs: Optional[list[ArtifactRef]] = None
    discovery_mode: Optional[Literal["auto", "on", "off"]] = None


class ExternalLookupsToggle(BaseModel):
    enabled: bool


class ConversationListItem(BaseModel):
    id: str
    run_id: Optional[str]
    workspace_id: str
    title: str
    provider: str
    model: str
    archived: bool
    external_lookups_enabled: bool
    created_at: datetime
    updated_at: datetime
    message_count: int = 0


# ----- Messages -----
class CitationEntry(BaseModel):
    file_path: str
    run_id: Optional[str] = None
    row_ids: list[Any] = Field(default_factory=list)


class ToolCallEntry(BaseModel):
    adapter: str
    args: dict[str, Any] = Field(default_factory=dict)
    status: str
    cached: bool = False
    latency_ms: Optional[int] = None
    error: Optional[str] = None


class AttachmentRead(BaseModel):
    id: str
    conversation_id: str
    message_id: Optional[str]
    kind: Literal["file", "image", "run_link"]
    filename: str
    mime_type: str
    size_bytes: int
    uploaded_at: datetime


class MessageRead(BaseModel):
    id: str
    conversation_id: str
    role: Literal["user", "assistant", "system", "tool"]
    content: str
    attachments: list[AttachmentRead] = Field(default_factory=list)
    citations: list[CitationEntry] = Field(default_factory=list)
    tool_calls: list[ToolCallEntry] = Field(default_factory=list)
    provider: str = ""
    model: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: str = ""
    parent_message_id: Optional[str] = None
    status: str = "complete"
    error: str = ""
    created_at: datetime


class ConversationRead(BaseModel):
    id: str
    run_id: Optional[str]
    workspace_id: str
    user_id: str
    title: str
    provider: str
    model: str
    archived: bool
    external_lookups_enabled: bool
    pinned_message_id: Optional[str]
    pinned_refs: list[ArtifactRef] = Field(default_factory=list)
    discovery_mode: Literal["auto", "on", "off"] = "auto"
    created_at: datetime
    updated_at: datetime
    messages: list[MessageRead] = Field(default_factory=list)


class MessageCreate(BaseModel):
    content: str
    attachment_ids: list[str] = Field(default_factory=list)
    pinned_refs: list[ArtifactRef] = Field(default_factory=list)


class MessageCreateResponse(BaseModel):
    user_message: MessageRead
    assistant_message: MessageRead


class RunSummary(BaseModel):
    id: str
    name: str
    status: str
    created_at: datetime
    completed_at: Optional[datetime] = None
    file_name: str
    modules_count: Optional[int] = None
    sig_peptides: Optional[int] = None
    up_peptides: Optional[int] = None
    down_peptides: Optional[int] = None
    go_terms: Optional[int] = None
    params: dict[str, Any] = Field(default_factory=dict)
    error_message: Optional[str] = None
