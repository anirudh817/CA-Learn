from __future__ import annotations

import os
from pathlib import Path

try:
    from dotenv import load_dotenv
except Exception:  # pragma: no cover - optional dependency
    load_dotenv = None

BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent

if load_dotenv:
    load_dotenv(PROJECT_DIR / ".env")
    load_dotenv(BASE_DIR / ".env")

APP_NAME = "ProteomicsAI"
APP_VERSION = "2.0.0"
APP_ENV = os.getenv("APP_ENV", "local").strip().lower()
IS_LOCAL_ENV = APP_ENV in {"local", "dev", "development", "test"}

DATA_DIR = Path(os.getenv("DATA_DIR", str(PROJECT_DIR / "data"))).resolve()
UPLOADS_DIR = DATA_DIR / "uploads"
RUNS_DIR = DATA_DIR / "runs"
EXPORTS_DIR = DATA_DIR / "exports"
SCRATCH_DIR = DATA_DIR / "scratch"
CONVERSATIONS_DIR = DATA_DIR / "conversations"
FRONTEND_DIR = PROJECT_DIR / "frontend"
REFERENCE_DATA_DIR = BASE_DIR / "data" / "reference"

for directory in (DATA_DIR, UPLOADS_DIR, RUNS_DIR, EXPORTS_DIR, SCRATCH_DIR, CONVERSATIONS_DIR, REFERENCE_DATA_DIR):
    directory.mkdir(parents=True, exist_ok=True)

# GO/pathway gene sets. Prefer a user-installed override at
# data/reference/default_GO_gmt.gmt; otherwise fall back to the human GMT bundled
# in the repo (Bader Lab AllPathways, gene symbols) so GO enrichment works out of
# the box. Override per-run via the gmt_file param.
_REFERENCE_GMT_OVERRIDE = REFERENCE_DATA_DIR / "default_GO_gmt.gmt"
_BUNDLED_GMT = BASE_DIR / "r_scripts" / "GOparallel" / "Human_GO_AllPathways_noPFOCR_with_GO_iea_September_01_2025_symbol.gmt"
DEFAULT_GMT_FILE = _REFERENCE_GMT_OVERRIDE if _REFERENCE_GMT_OVERRIDE.exists() else _BUNDLED_GMT
# Human cell-type markers (default reference). Prefer a user-installed override at
# data/reference/default_celltype_markers.csv; otherwise fall back to the human
# Sharma/Zhang marker set bundled in the repo (parallel to the mouse wiring below),
# so cell-type FET works out of the box. Override per-run via celltype_markers_file.
_REFERENCE_CELLTYPE_OVERRIDE = REFERENCE_DATA_DIR / "default_celltype_markers.csv"
_BUNDLED_CELLTYPE_HUMAN = BASE_DIR / "r_scripts" / "CellTypeFET" / "MyGene-Human-SharmaZhangUnion.csv"
DEFAULT_CELLTYPE_MARKERS = _REFERENCE_CELLTYPE_OVERRIDE if _REFERENCE_CELLTYPE_OVERRIDE.exists() else _BUNDLED_CELLTYPE_HUMAN
DEFAULT_CELLTYPE_MARKERS_MOUSE = BASE_DIR / "r_scripts" / "CellTypeFET" / "MyGene-Mouse-SharmaZhangUnion.csv"
DEFAULT_UNIPROT_GENE_LOOKUP = REFERENCE_DATA_DIR / "uniprot_gene_lookup.csv"

_configured_database_url = os.getenv("DATABASE_URL", "").strip()
if _configured_database_url:
    DATABASE_URL = _configured_database_url
elif IS_LOCAL_ENV:
    DATABASE_URL = f"sqlite:///{DATA_DIR / 'proteomics.db'}"
else:  # pragma: no cover - production misconfiguration guard
    raise RuntimeError("DATABASE_URL must be configured when APP_ENV is not local")
SQLITE_CONNECT_ARGS = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

MAX_UPLOAD_SIZE = int(os.getenv("MAX_UPLOAD_SIZE_MB", "2000")) * 1024 * 1024
ALLOWED_EXTENSIONS = {".csv", ".tsv", ".xlsx", ".txt", ".parquet"}

# --- AI / Chat configuration ---
# v1: Anthropic-only. Other provider env vars intentionally absent — re-add
# them here if the provider abstraction is ever re-expanded.
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
NCBI_API_KEY = os.getenv("NCBI_API_KEY", "")  # optional for PubMed higher rate

AI_DEFAULT_PROVIDER = "anthropic"
AI_INPUT_TOKEN_BUDGET = int(os.getenv("AI_INPUT_TOKEN_BUDGET", "100000"))
AI_OUTPUT_TOKEN_BUDGET = int(os.getenv("AI_OUTPUT_TOKEN_BUDGET", "4000"))
AI_HISTORY_SUMMARIZE_AT = float(os.getenv("AI_HISTORY_SUMMARIZE_AT", "0.70"))
# Wave 3: number of recent turns (≈2 messages each) kept verbatim when older
# history is compressed into a summary.
AI_HISTORY_KEEP_RECENT_TURNS = int(os.getenv("AI_HISTORY_KEEP_RECENT_TURNS", "4"))
AI_PLATFORM_DAILY_TOKENS = int(os.getenv("AI_PLATFORM_DAILY_TOKENS", "200000"))
AI_PLATFORM_DAILY_REQS = int(os.getenv("AI_PLATFORM_DAILY_REQS", "50"))

# Attachment caps (bytes)
AI_ATTACHMENT_MAX_FILE_BYTES = int(os.getenv("AI_ATTACHMENT_MAX_FILE_MB", "25")) * 1024 * 1024
AI_ATTACHMENT_MAX_IMAGE_BYTES = int(os.getenv("AI_ATTACHMENT_MAX_IMAGE_MB", "10")) * 1024 * 1024
AI_ATTACHMENT_MAX_CONV_BYTES = int(os.getenv("AI_ATTACHMENT_MAX_CONV_MB", "100")) * 1024 * 1024
AI_ATTACHMENT_MAX_IMAGES_PER_TURN = int(os.getenv("AI_ATTACHMENT_MAX_IMAGES_PER_TURN", "5"))

# External lookups
AI_EXTERNAL_LOOKUP_CACHE_TTL_HOURS = int(os.getenv("AI_EXTERNAL_LOOKUP_CACHE_TTL_HOURS", "24"))
AI_EXTERNAL_LOOKUP_TIMEOUT_S = float(os.getenv("AI_EXTERNAL_LOOKUP_TIMEOUT_S", "5.0"))
AI_EXTERNAL_LOOKUP_MAX_PER_TURN = int(os.getenv("AI_EXTERNAL_LOOKUP_MAX_PER_TURN", "8"))
AI_EXTERNAL_LOOKUP_MAX_PER_CONV_PER_HOUR = int(os.getenv("AI_EXTERNAL_LOOKUP_MAX_PER_CONV_PER_HOUR", "30"))
AI_EXTERNAL_LOOKUP_MAX_CONCURRENCY = int(os.getenv("AI_EXTERNAL_LOOKUP_MAX_CONCURRENCY", "4"))

# Security & anti-exfiltration (P12)
# LLM-judge classifiers add ~1 cheap Haiku call each per turn (~$0.001, ~400ms).
# Disable for trusted internal-only deployments to save that overhead.
AI_SECURITY_LLM_JUDGE = os.getenv("AI_SECURITY_LLM_JUDGE", "1") == "1"
AI_SECURITY_JUDGE_MODEL = os.getenv("AI_SECURITY_JUDGE_MODEL", "claude-haiku-4-5")
# Dedicated Anthropic key for the fail-open safety judges. When set, the judges
# run on their own key/quota so chat rate-limits (or a BYOK user throttling
# their own key) can't starve — and thus silently disable — the security gate.
# Unset (default) falls back to the chat-resolved provider; existing behavior.
AI_SECURITY_ANTHROPIC_API_KEY = os.getenv("AI_SECURITY_ANTHROPIC_API_KEY", "")
# Rolling-window throttle on prompt-extraction attempts.
AI_SECURITY_RATE_LIMIT_THRESHOLD = int(os.getenv("AI_SECURITY_RATE_LIMIT_THRESHOLD", "5"))
AI_SECURITY_RATE_LIMIT_WINDOW_MIN = int(os.getenv("AI_SECURITY_RATE_LIMIT_WINDOW_MIN", "10"))

_configured_session_secret = os.getenv("SESSION_SECRET", "").strip()
if _configured_session_secret:
    SESSION_SECRET = _configured_session_secret
elif IS_LOCAL_ENV:
    SESSION_SECRET = "proteomicsai-local-secret"
else:  # pragma: no cover - production misconfiguration guard
    raise RuntimeError("SESSION_SECRET must be configured when APP_ENV is not local")
INLINE_RUNS = os.getenv("INLINE_RUNS", "0") == "1"
ENABLE_LOCAL_BOOTSTRAP = os.getenv("ENABLE_LOCAL_BOOTSTRAP", os.getenv("ENABLE_DEMO_BOOTSTRAP", "1" if IS_LOCAL_ENV else "0")) == "1"
AUTH_MODE = os.getenv("AUTH_MODE", "local_bootstrap" if ENABLE_LOCAL_BOOTSTRAP else "credentials").strip().lower()
LOCAL_BOOTSTRAP_EMAIL = os.getenv("LOCAL_BOOTSTRAP_EMAIL", "admin@local.signalfold")
LOCAL_BOOTSTRAP_PASSWORD = os.getenv("LOCAL_BOOTSTRAP_PASSWORD", "local-bootstrap-only")
LOCAL_BOOTSTRAP_DISPLAY_NAME = os.getenv("LOCAL_BOOTSTRAP_DISPLAY_NAME", "Local Workspace Admin")
LOCAL_BOOTSTRAP_WORKSPACE_NAME = os.getenv("LOCAL_BOOTSTRAP_WORKSPACE_NAME", "Local Workspace")
LOCAL_BOOTSTRAP_PROJECT_NAME = os.getenv("LOCAL_BOOTSTRAP_PROJECT_NAME", "General")
