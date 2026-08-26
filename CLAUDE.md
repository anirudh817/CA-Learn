# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. Project history, status, and the AI-chat milestone log live in [`CHANGELOG.md`](./CHANGELOG.md).

## Working Branch — `ssb1`

**All work in this repository happens on the `ssb1` branch** (branched from `main`). Claude Code and Codex share this single branch — do not diverge onto separate branches.

- Before starting any task, make sure you are on `ssb1`: `git checkout ssb1` (create it from `main` if missing: `git checkout -b ssb1 main`).
- Commit every change onto `ssb1`. **Never commit directly to `main`.**
- Do not create additional feature branches or worktrees unless the user explicitly asks.
- Keep `main` clean; only integrate `ssb1` → `main` when the user explicitly requests it.

## Python Environment

This project does **not** follow the global "uv-only" Python rule — that rule does not apply here. Plain `pip` against your normal Python interpreter is fine (e.g. `pip install -r backend/requirements.txt`, see Commands below). A `.venv` with all dependencies already exists and is fine to use, but no specific tool or virtualenv is required.

## Commands

**Start dev server (binds port 8000; set `PORT` to override — fails loudly if the port is busy):**
```bash
python3 -m proteomics_ai.devserver      # or: PORT=8002 python3 -m proteomics_ai.devserver
```

**Start directly on port 8000:**
```bash
uvicorn main:app --reload
```

**AI Insights sidecar (separate Node process on :4317):** the main app's "Open AI Insights" button just points a browser at :4317 — it does **not** start the sidecar, so AI Insights only works when the sidecar is also running. Manage both via `run.sh`, which uses a consistent `verb [scope]` grammar (scope = `all` | `app` | `ai`, default `all`):
```bash
./run.sh start [all|app|ai] [fg]    # start (background; add fg for one service)
./run.sh stop  [all|app|ai]         # stop
./run.sh restart [all|app|ai] [fg]  # stop then start
./run.sh status                     # what is up on :8000 and :4317
# Shorthands (unchanged): `./run.sh` (app fg), `./run.sh bg`, `./run.sh ai [bg|stop]`, `./run.sh all` (= start all)
```
`start ai`/`start all` auto-build the free-form research Docker jail image if missing; `stop` removes leftover jail containers. A still-held port that run.sh didn't start (e.g. the Docker stack on :8000) is reported, not killed.

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
- `backend/routes/` — one `APIRouter` per resource domain; every protected endpoint uses `Depends(get_current_user)`. Pipeline: `auth`, `workspaces`, `projects`, `upload`, `runs`, `results`, `compare`, `share_links`, `audit`. AI chat (**legacy — mounted but rollback/parity-only since the AI Insights v2 sidecar migration; the live AI Insights UI is the Node `ai-sidecar/`, not these routes**): `conversations` (chat CRUD + streaming POST), `attachments` (multipart), `settings_ai` (BYOK keys + workspace policy). `ai` is the deprecated single-shot endpoint (returns 410).
- `backend/services/pipeline.py` — **primary pipeline engine** (~2000 lines); all three stages plus ETL (`_build_canonical_bundle`)
- `backend/services/deliverables.py` — post-pipeline output packaging; `resolve_pipeline_profile()` determines naming from `format_family` + `assay_level`
- `backend/services/artifacts.py` — builds `artifact_index.json`; tab routing via heuristic string matching
- `backend/services/pipeline_runner.py` — **vestigial R-subprocess engine; not invoked by any active route**
- `backend/services/ai/` — **legacy Python AI chat subsystem** — superseded by the Node `ai-sidecar/`; mounted but rollback/parity-only (see below)

### AI chat subsystem (`backend/services/ai/`) — LEGACY (pre-v2, rollback-only)

> **The live AI Insights moved to the standalone Node `ai-sidecar/` (:4317) in v2.** Standard chat **and** Deep Research are now two **policy profiles on one Pi runtime** there (`ai-sidecar/src/runtime.ts`; `capabilitiesForPolicy` gates tools/Python to `deep-research` + execution mode — `standard` gets none). The Python subsystem described below is **mounted in `create_app()` but not reached by the live product** — only the test suite calls it; it is retained as rollback/parity until the migration gate is accepted (see `CHANGELOG.md` "AI Insights v2"). **For any AI Insights / chat / Standard-Mode work, look in `ai-sidecar/`, not here.**

Persistent, multimodal chat letting scientists converse with a run's data.
**Anthropic-only in v1** (provider abstraction exists; only `anthropic_provider.py` is implemented). Reads `data/runs/{run_id}/` as a black box.

- `crypto.py` — Fernet encryption for stored API keys (derived from `SESSION_SECRET`)
- `key_resolver.py` — key precedence (user → workspace → env) + quota
- `dispatcher.py` — provider client cache
- `providers/` — `base.py` (Provider Protocol), `catalog.py` (models/costs), `anthropic_provider.py`
- `artifact_index.py` / `retrievers.py` / `query_rewriter.py` / `context_builder.py` — **hybrid retrieval**: intent-routed table slices assembled into per-turn context (the layer that makes chat useful)
- `tools.py` — agentic tool-use loop (4-iteration cap, safety guards)
- `attachments.py` — PDF/xlsx text extraction
- `external_lookups/` — opt-in external biology: `uniprot`, `reactome`, `string_db`, `pubmed` adapters behind a `dispatcher` safety chain (cache → conv-hourly cap → workspace daily quota → circuit breaker → 1-retry timeout). Default OFF.
- `security.py` — anti-exfiltration: input regex blocker, output scrubber, LLM-judge classifiers, extraction rate limiter. The chat must never reveal methodology, USP, pipeline internals, source code, or model identity.
- `eval/` — evaluation harness (`runner`, `judges`, `dataset`, `cli`) with `datasets/bootstrap.json` and `datasets/red_team.json`

**Off-limits to AI edits (pipeline-owned):** `pipeline.py`, `pipeline_runner.py`, stage runners, `r_scripts/`.

### Frontend (`frontend/`)

`index.html` (shell) + `app.js` plus a small `frontend/modules/` set loaded by `app.js`: `results.js`, `runHistory.js`, `uploadPreview.js`. No build step. State lives in a single global `STATE` object. All HTTP calls go through `APP.api()` / `APP.apiJson()`. Page navigation via `APP.go(page)` toggling `.active` on `.page` elements.

> **`frontend/modules/chat.js` (+ `chatStreams.js`) is the old in-monolith AI chat UI, ORPHANED at runtime** — `app.js` does not import it; the "AI Insights" tab is just a launcher to the sidecar (:4317). The dead Playwright specs that drove this UI (`tests/e2e/chat_*.spec.js`) were removed — they failed at setup (`window.APP.chat` no longer exists). The two JS files are **retained** only because the kept Python rollback suite still binds them: `tests/test_chat_p10_p11.py` reads `chat.js` (asserts on its content) and `tests/chatStreams.test.mjs` imports `chatStreams.js`. They should retire with the rest of the legacy Python chat stack when the migration gate is accepted.

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
- `proteomics_ai/devserver.py` → same factory; binds a fixed port (`PORT`, default 8000) and aborts if busy (dev preferred)
- `proteomics_ai/app.py` — thin shim used by some deployment configs

### Dual-Engine Note

`pipeline.py:run_stage1()` is **R-only**: it requires both `Rscript` on `PATH` and `backend/r_scripts/stage1_parity.R`, delegating to an R subprocess (`_run_stage1_via_r`). If either is missing it **hard-fails** with `RuntimeError("R Stage 1 is required but unavailable…")` — there is no pure-Python fallback (the Python WGCNA path was removed in commit `26ea50e`, RPIP-07). Consequently the pipeline only runs end-to-end where R is provisioned (the `Dockerfile` installs r-base + WGCNA/limma/etc.); a bare native dev server with no R fails at Stage 1 right after ETL. `pipeline_runner.py` is a separate legacy engine not wired to any active route.

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
| `AI_EXTERNAL_LOOKUP_*` | see `config.py` | External-lookup cache TTL, timeout, per-turn/per-hour caps, concurrency |
| `AI_SECURITY_LLM_JUDGE` | `1` | Enable Haiku input/output safety classifiers |
| `AI_SECURITY_ANTHROPIC_API_KEY` | — | Dedicated key for the fail-open safety judges so chat rate-limits/quota can't starve the gate; falls back to the chat-resolved provider when unset |
| `AI_SECURITY_RATE_LIMIT_*` | `5` / `10` | Extraction-attempt threshold + window (minutes) |

## Test Environment

Tests require `INLINE_RUNS=1` (set implicitly via the env prefix above). ~40 test files. Pipeline: `tests/test_app.py` (main), `tests/test_r_pipeline.py`, `tests/test_stage2_zscore.py`, `tests/test_validation_gate_phase_c.py`, etc. AI chat: `tests/test_chat_p*.py` (per-milestone), `tests/test_chat_eval.py`, `tests/test_chat_security.py`, `tests/test_anthropic_payload.py`.
