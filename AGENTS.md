# AGENTS.md

This file provides guidance to Codex when working with code in this repository. Project history, status, and the AI-chat milestone log live in [`CHANGELOG.md`](./CHANGELOG.md). This mirrors [`CLAUDE.md`](./CLAUDE.md) — keep the two in sync.

**Ownership note:** Codex owns the core pipeline (`backend/services/pipeline.py`, `pipeline_runner.py`, stage runners, `backend/r_scripts/`). The AI chat subsystem (`backend/services/ai/`, chat routes, `frontend/modules/chat.js`) is maintained separately — treat it as read-only unless explicitly asked to change it.

## Working Branch — `ssb1`

**All work in this repository happens on the `ssb1` branch** (branched from `main`). Codex and Claude Code share this single branch — do not diverge onto separate branches.

- Before starting any task, make sure you are on `ssb1`: `git checkout ssb1` (create it from `main` if missing: `git checkout -b ssb1 main`).
- Commit every change onto `ssb1`. **Never commit directly to `main`.**
- Do not create additional feature branches or worktrees unless the user explicitly asks.
- Keep `main` clean; only integrate `ssb1` → `main` when the user explicitly requests it.

## Python Environment

This project does **not** follow the global "uv-only" Python rule — that rule does not apply here. Plain `pip` against your normal Python interpreter is fine (e.g. `pip install -r backend/requirements.txt`, see Commands below). A `.venv` with all dependencies already exists and is fine to use, but no specific tool or virtualenv is required.

## Commands

**Start dev server (auto-selects port, prefers 8000):**
```bash
python3 -m proteomics_ai.devserver
```

**Start directly on port 8000:**
```bash
uvicorn main:app --reload
```

**Run all tests:**
```bash
PYTHONPYCACHEPREFIX=/tmp/pycache MPLCONFIGDIR=/tmp/matplotlib PYTHONDONTWRITEBYTECODE=1 \
python3 -m unittest discover -s tests -v
```

**Run a single test file:**
```bash
PYTHONPYCACHEPREFIX=/tmp/pycache MPLCONFIGDIR=/tmp/matplotlib PYTHONDONTWRITEBYTECODE=1 \
python3 -m unittest tests.test_app -v
```

**Docker:**
```bash
docker-compose up --build
```

**Install dependencies:**
```bash
pip install -r backend/requirements.txt
```

## Architecture

SignalFold is a FastAPI monolith serving both a REST API (`/api/*`) and a vanilla JS SPA (no build step). The pipeline runs in a background daemon thread — there is no task queue.

**Layer structure:** HTTP routes → service layer → pipeline execution → filesystem artifacts

### Backend (`backend/`)

- `backend/main.py` — app factory (`create_app()`); registers all routers; sets up SPA fallback
- `backend/config.py` — all path/env config: `DATA_DIR`, `DATABASE_URL`, `ANTHROPIC_API_KEY`, `INLINE_RUNS`, etc.
- `backend/database.py` — all SQLAlchemy models. Pipeline domain: `User`, `SessionToken`, `Workspace`, `Membership`, `Project`, `UploadedDataset`, `Run`, `RunStageStatus`, `RunFile`, `ShareLink`, `AuditEvent`. AI-chat domain: `UserAISettings`, `WorkspaceAISettings`, `Conversation`, `Message`, `Attachment`, `ExternalLookupCache`, `ExternalLookupQuotaUsage`. All additive/auto-created — no migration step.
- `backend/routes/` — one `APIRouter` per resource domain; every protected endpoint uses `Depends(get_current_user)`. Pipeline: `auth`, `workspaces`, `projects`, `upload`, `runs`, `results`, `compare`, `share_links`, `audit`. AI chat: `conversations`, `attachments`, `settings_ai`. `ai` is the deprecated single-shot endpoint.
- `backend/services/pipeline.py` — **primary pipeline engine** (~2000 lines); all three stages plus ETL (`_build_canonical_bundle`)
- `backend/services/deliverables.py` — post-pipeline output packaging; `resolve_pipeline_profile()` determines naming from `format_family` + `assay_level`
- `backend/services/artifacts.py` — builds `artifact_index.json`; tab routing via heuristic string matching
- `backend/services/pipeline_runner.py` — **vestigial R-subprocess engine; not invoked by any active route**
- `backend/services/ai/` — AI chat subsystem (Anthropic-only v1; hybrid retrieval, agentic tool-use, opt-in external lookups, anti-exfiltration security, eval harness). See `CLAUDE.md` for the full breakdown.

### Frontend (`frontend/`)

`index.html` (shell) + `app.js` plus a small `frontend/modules/` set: `chat.js` (AI chat UI), `results.js`, `runHistory.js`, `uploadPreview.js`. No build step. State lives in a single global `STATE` object. All HTTP calls go through `APP.api()` / `APP.apiJson()`. Page navigation via `APP.go(page)` toggling `.active` on `.page` elements.

### Pipeline Flow

```
Upload → UploadedDataset row
  → POST /api/runs → Run row (QUEUED) → background thread
    → _build_canonical_bundle()       [ETL: input/canonical_matrix.csv]
    → run_stage1()                    [normalization + DE + WGCNA-equiv → stage1/]
    → run_stage2()                    [GO enrichment → stage2/]
    → run_stage3()                    [cell type FET → stage3/]
    → deliverables.emit_legacy_bundle() [client-deliverable folder packaging]
    → artifacts.write_artifact_index()  [artifact_index.json]
  → Run.status = COMPLETE
```

All stage outputs land in `data/runs/{run_id}/stage{N}/`. SSE endpoint (`GET /api/runs/{run_id}/events`) polls `Run.log` column every 500ms.

### Entry Points

- `main.py` → `app_loader.py` → `backend/main.py:create_app()` (production / uvicorn)
- `proteomics_ai/devserver.py` → same factory with port auto-selection (dev preferred)
- `proteomics_ai/app.py` — thin shim used by some deployment configs

### Dual-Engine Note

`pipeline.py:run_stage1()` checks for `stage1_parity.R` — if R is installed and the script exists, it delegates to an R subprocess; otherwise runs pure Python. `pipeline_runner.py` is a separate legacy engine not wired to any active route.

## Key Conventions

**Python:**
- Route handlers: `dependency injection → auth check → query → mutation → audit record → return dict`
- Pipeline stage functions always call `step_callback("key", "running", ...)` on entry, `step_callback("key", "complete", 100, ...)` on success, and write empty output files on skip/fail (never raise)
- All pipeline logging through `log_fn(f"[{_ts()}] ...")` — no logging library
- Config passed to stages as plain `dict`, also written as `config_stageN.json` for reproducibility
- `INLINE_RUNS=1` env var makes pipeline run synchronously (used in tests)

**JavaScript:**
- All state mutations directly on `STATE.*`; all API calls through `APP.api()` / `APP.apiJson()`
- All user-supplied / API-returned strings through `escapeHtml()` before `innerHTML` insertion
- Download/iframe URLs use `withToken(url)` (query param) not `Authorization` header
- Pipeline param inputs use `p_` DOM ID prefix (e.g., `p_norm`, `p_power`, `p_adjp`)

## Key Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `DATA_DIR` | `./data` | Runtime data root |
| `DATABASE_URL` | `sqlite:///data/proteomics.db` | Database path |
| `ANTHROPIC_API_KEY` | — | Env-level fallback key for AI chat (users normally bring their own via the settings drawer) |
| `INLINE_RUNS` | `0` | `1` = synchronous pipeline (tests) |
| `SESSION_SECRET` | `proteomics-local-secret` | Auth token signing **and** Fernet key derivation for stored API keys; required when `APP_ENV` is not `local` |
| `ENABLE_DEMO_BOOTSTRAP` | `1` | Auto-create demo workspace on startup |
| `NCBI_API_KEY` | — | Optional; higher PubMed lookup rate |
| `AI_EXTERNAL_LOOKUP_*` | see `config.py` | External-lookup cache TTL, timeout, caps, concurrency |
| `AI_SECURITY_*` | see `config.py` | LLM-judge classifiers + extraction rate limiting |

## Test Environment

Tests require `INLINE_RUNS=1` (set implicitly via the env prefix above). ~40 test files. Pipeline: `tests/test_app.py` (main), `tests/test_r_pipeline.py`, `tests/test_stage2_zscore.py`, `tests/test_validation_gate_phase_c.py`. AI chat: `tests/test_chat_p*.py`, `tests/test_chat_eval.py`, `tests/test_chat_security.py`, `tests/test_anthropic_payload.py`.
