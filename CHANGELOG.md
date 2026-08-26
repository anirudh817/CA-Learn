# SignalFold — Changelog & Status

The canonical record of what SignalFold is and how it has evolved. Architecture
and commands live in [`CLAUDE.md`](./CLAUDE.md).

## What this is

SignalFold is a self-hosted FastAPI web platform that productionizes an R
proteomics pipeline. It automates normalization (TAMPOR/CBN), WGCNA module
detection (bicor + dynamicTreeCut), GO enrichment (piano-style signed FET
z-scores), and cell-type deconvolution — delivered as an interactive web UI with
downloadable deliverable bundles matching the Eisai Spec Pep client format. On
top of the pipeline sits an **AI Biological Inference Chat** so scientists can
converse with their run data.

**Stack:** FastAPI + vanilla JS SPA + SQLite + Docker/nginx. No frontend build
step. R runs as a subprocess inside Docker.

**Reference assets (read-only):**
- Gold-standard deliverable: `~/Documents/ClientServices/Eisai/deliverables/cleaned-runs/PeaksPep-42M/`
- R source pipeline: `~/Documents/MoonShot/code/analytics_core/`

## Deep Research — unified native Pi scientific skills (2026-06-23)

- **One-liner:** approved Deep Research plans now expose genuine vendored
  `SKILL.md` packages to a controlled Pi session instead of dispatching
  same-named TypeScript substitutes.
- **One-liner:** Operations distinguishes allowed, loaded, activated, and
  executed skills/tools with source, environment, hash, and rerun provenance.
- **One-liner:** all 17 selected scientific skill packages are source/hash
  locked, license inventoried, and honestly marked ready, reference-only, or
  disabled.
- Removed `ResearchSkillRunner` and manifest-only third-party placeholders;
  Standard remains zero-skill and zero-execution.
- Added the allowlisted gateway, native Stage 1 stability skill/tool, isolated
  uv heavy environments, network/secondary-LLM blocks, and truthful OCC labels.
- Real heavy-script smokes passed for PyOpenMS 3.5.0, PyDESeq2 0.5.4, and
  Scanpy 1.12.1. See the self-contained [native Pi skills implementation
  report](docs/explanations/features/deep-research-native-pi-skills.html).

## AI Insights Deep Research — first useful release (2026-06-23)

- **One-liner:** researchers can now plan, approve, leave, resume, inspect, and
  re-run a run-scoped investigation that produces reproducible evidence—not a
  longer chat answer.
- Replaced Deep Research's filename-order 180 KB snapshot with Standard's
  adaptive/BM25 grounding substrate and a frozen `ResearchScopeManifest`
  containing selected artifact rows, stage configs, exclusions, and SHA-256
  hashes. Standard behavior remains behind its compatibility facade and its
  characterization suite is unchanged.
- Added durable SQLite research jobs, steps, events, claims, evidence, and
  computation records with plan approval, idempotent launch, checkpoints,
  restart recovery, pause/resume/stop, retry, and exact re-run endpoints.
- Added two launch workflows (Finding Stress Test and Ranked Pathway
  Investigation) plus a repository-owned, provider-neutral skill catalog. Four
  deterministic offline entrypoints are enabled: EDA, Stage 1 threshold
  stability, Stage 2 ORA ranking, and scientific SVG output. Skills receive
  immutable manifest-selected inputs and cannot construct arbitrary shell or
  network calls.
- Added schema-validated evidence cards with separate pipeline, computation,
  external-consistency, and replication dimensions. Interpretation/hypothesis
  cards cannot pass validation without external evidence; v1 therefore reports
  external consistency as `not-assessed` instead of inventing corroboration.
- Every successful job emits and registers all eight required deliverables:
  decision summary, self-contained HTML report, evidence JSON, artifact index,
  computation manifest, re-run spec, open questions, and recommended next step.
- The standalone UI now changes from Standard chat to a Deep Research job rail,
  workflow launcher, editable approval surface, checkpoint stepper, inspector,
  evidence cards, lifecycle controls, and artifact package. Standard chat stays
  the default fast surface.
- Verification: sidecar typecheck; full sidecar test suite including adaptive
  grounding regressions and a new API-level three-skill/eight-output job; live
  browser verification against `RUN-E2E-VERIFY` for launch, plan, preflight,
  job rail, inspector, and restart-restored state.

---

## Current status (2026-06-17)

| Area | Status |
|---|---|
| Core 3-stage pipeline + deliverables | Shipped, parity-validated against reference |
| Clinical traits wiring + visualization | Shipped |
| Outlier-review mid-run checkpoint | Shipped (browser UAT recommended) |
| Stats control contract | Shipped |
| **AI Biological Inference Chat** | **Shipped (v1-complete framework)** |

**AI chat is complete, including Wave 3.** The chat finds the right slice of a
large run, ground answers in the run's artifacts, attaches files/images, pulls
opt-in external biology (UniProt, Reactome, STRING, PubMed), surfaces
provenance, tracks cost, and refuses to leak product internals. Wave 3 (the
last retrieval piece) is now shipped: a relevance **reranker** so the context
budget keeps the most relevant chunks, and a conversation-history
**summarizer** that compresses old turns once history passes 70% of the input
budget.

**Provider scope: Anthropic-only.** Multi-provider (OpenAI/Google) is dropped
from scope. The catalog/dispatcher keep a provider-shaped structure so it could
be re-added mechanically later, but only the Anthropic provider exists and the
"bring any key" ambition is intentionally not pursued.

**Security hardening (2026-06-17):** an adversarial audit of the
anti-exfiltration layer drove fixes that close confirmed IP-leak paths — see
the AI-chat history below.

**Known soft spots:**
- Full in-browser UAT of the chat UI and the volcano table / outlier-review
  modal is still recommended before calling the UI production-polished.
- Residual security items remain tracked (see history); the highest-severity
  bypasses are fixed.

---

## Pipeline history

### v1.0 — Core platform hardening (merged 2026-04-29, `2cbd74b`)
Started from a brownfield codebase with the 3-stage pipeline present but broken.
Fixed across 8 phases: CORS/token/share-link security, removed bogus metadata
injection and hardcodes, wired the R pipeline (Dockerfile + `stage1_parity.R`
with bicor/dynamicTreeCut/mergeCloseModules/kME), piano-style signed FET
z-scores with global BH FDR, pre-run QC modal, parameter audit trail, pipeline
versioning, full 45-color WGCNA palette, `Complete_Results.xlsx` deliverable,
and broad UI polish.

### v1.1 — Scientific cascade fix (merged 2026-05-02, `833c496`)
An audit found outputs diverged from the Eisai reference at every layer. Root
cause: ETL stripped ~10K PTM-modified peptides and CBN normalization math was
wrong, cascading downstream.
- **ETL + normalization:** fixed PTM stripping; rewrote CBN to match
  `peaks_DataNormalization_ColumnBased.R`. Gate: 18,135 features, 100% within
  ±0.5 log2 of reference.
- **DE + WGCNA:** verified limma::eBayes; confirmed correct modules. Gate:
  log2FC Pearson r = 1.000; module ARI = 0.838.
- **Enrichment + CellType FET:** verified signed z-score; fixed FET
  universe-size bug.

### v1.2 — Traits + visualization polish (2026-05-02)
- Clinical CSV (T_TAU, P_TAU, ABETA42) fully wired into PEAKS; `_raw`/`_std`
  expansion; per-trait `Associated_Modules.csv`; biomarker synonym normalization.
- GO/CellType Plotly annotations (z-score text, significance stars); pheatmap
  PDFs listed first.
- Volcano interactive DE table (search, filters, sort, pagination) — browser UAT
  still recommended.

### Production readiness + outlier review (2026-05-15)
- Run submission blocks datasets with `run_ready=false` (HTTP 422); trait
  Associated-Modules routing fixed.
- Outlier sample removal: bicor connectivity detection, `AWAITING_REVIEW` status,
  mid-run `threading.Event` blocking, `POST /api/runs/{run_id}/review-outliers`
  + SSE `outlier_review` events + per-sample review modal.

### Stats control contract (2026-05-15, Phase C resolved 2026-05-16)
- Configure controls now follow an explicit contract: active controls wired into
  computation, unsupported ones disabled/gated, invalid states rejected.
- Stage 1 honors DE method, WGCNA power/TOM/PAM, bicor/Pearson diagnostics;
  Stage 2 honors GO background mode and redundancy pruning; Stage 3 honors
  human/mouse/custom CellTypeFET references.
- Every run writes `stats_control_audit.json` (requested vs. effective values).
- Phase C parity, after aligning WGCNA controls to the reference (power 4 / min
  module size 15 / deepSplit 4 / merge cut 0.15): module ARI = 0.996; GO z-score
  Pearson r = 0.927; CellTypeFET 93.8% within ±2 log10(p).

---

## AI Biological Inference Chat — history

Persistent, multimodal chat letting scientists converse with their run data;
Anthropic-only in v1; reads `data/runs/{run_id}/` as a black box.

| Milestone | What shipped |
|---|---|
| Foundations | DB tables (conversations/messages/attachments/AI settings), provider abstraction, streaming SSE, conversation CRUD UI |
| Attachments | File + image attachments with vision (PDF/xlsx extraction) |
| Evaluation harness | Eval framework + bootstrap dataset + CLI + LLM-judge |
| **Hybrid retrieval** | **Artifact index + intent-routed retrievers + query rewriter + agentic tool-use loop (4-iter cap, safety guards).** |
| **Hybrid retrieval — Wave 3** | **Relevance reranker (`reranker.py`) so the budget cut keeps the most relevant chunks, not whatever came first in dispatch order; conversation-history summarizer (`summarizer.py`) compressing old turns past 70% of the input budget while keeping recent turns verbatim. Wired into `retrieve()` and `build_provider_messages`; 9 Wave-3 tests.** |
| Provenance & UX | Grounded badges, sources panel, follow-ups, regenerate, pin, export, session cost meter |
| Cost & limits | Platform-quota gauge, 429 surfacing, per-conversation cost rollup |
| External lookups | UniProt + Reactome + STRING + PubMed adapters; cache → quota → circuit-breaker safety chain; default OFF, opt-in toggle; parallel dispatch; admin workspace policy panel |
| Context panel & mentions | Collapsible artifact/file panel, `@`-mention picker, persistent + per-turn pins, same-workspace cross-run refs |
| Biological interpretation | Conversation-scoped Discovery mode (`auto`/`on`/`off`); artifact-grounded biological landscape with explicit unavailable markers |
| Security | System-prompt confidentiality rules, regex input blocker + output scrubber, attachment-injection wrapping, Haiku LLM-judge classifiers, extraction rate limiter (HTTP 429). Anti-exfiltration: chat must never reveal methodology, USP, pipeline internals, source code, or model identity. |
| Security hardening (2026-06-17) | Adversarial audit + fixes: (1) the **regenerate** endpoint now runs the output scrubber + LLM leak-judge (it previously persisted raw model text, bypassing all output security); (2) `read_file_slice` and `@`-mention pins now **block internal-methodology files** inside the run dir (`config_stage*.json`, `*.R`/`*.py`/`*.sh`, `*.log`, `stats_control_audit.json`, parity scripts) so pipeline parameters/source can't be exfiltrated; (3) frontend `javascript:`/`data:` URL XSS in external-lookup links closed via a scheme allowlist. New tests: `InternalFileBlockingTests`. |
| Security hardening II (2026-06-18) | (H4) **Fail-CLOSED output backstop** — a deterministic `heuristic_output_leak()` now runs on every answer (streaming, non-streaming, regenerate) independent of the fail-open LLM judge, so a judge outage/rate-limit can't slip a leak through; catches model/vendor identity, methodology prose (query-rewriter, schema-aware retrieval, artifact index, RAG, embeddings, FastAPI) and source-code paths, while allowing legitimate science + run-data paths. (H2) **Indirect prompt-injection detection** — attachment + pinned content carrying instruction-style text now gets a loud per-block neutralization banner. New tests: `HeuristicOutputLeakTests`, `InjectionMarkerTests`. |
| UI/UX polish (2026-06-18) | Streaming "thinking" indicator (no dead air before first token); composer stays enabled while streaming; retry button on failed sends; double-submit/concurrent-stream guard; attachments no longer wiped on a failed send; modal/drawer Escape-to-close + focus-on-open + focus-restore + Tab focus-trap + ARIA dialog roles; `javascript:` URL XSS allowlist; stale internal-jargon tooltips replaced. |
| **Conversation isolation — each chat is its own agent (2026-06-18)** | Fixed a bug where a streaming conversation bled its tokens into a different conversation the user navigated to, then blanked it on finish. Streaming was bound to global view-state; now each conversation owns an independent stream via a per-conversation registry (`frontend/modules/chatStreams.js`), the DOM is a projection of only the on-screen conversation, the post-stream reload is `convId`-scoped, and switching into a live stream re-projects its progress. Conversations now stream concurrently and independently. Also: redacted answers can no longer be re-rendered as normal answers (security); over-fetch reduced (seq-gated context-panel). Reviewed by adversarial code-review + test-coverage agents. **Tests:** `chatStreams.test.mjs` (17, node), `test_chat_isolation.py` (3), and a **Playwright e2e suite** (`tests/e2e/`, 3 tests, GREEN against the real app) — the no-bleed test is **red-verified** (fails on the pre-fix `chat.js`, passes on the fix). |
| **Robust tabular reading (2026-06-18)** | A GO-FET `.txt` export (tab-delimited despite the extension) raised "Expected 1 fields…" and the chat answered from zero rows. New `backend/services/ai/tabular.py` detects the delimiter from file content (never a whitespace catch-all, so prose/space-containing single columns aren't shredded) and skips irregular rows. Wired into retrievers, `read_file_slice` (with a table-vs-prose heuristic for `.txt`), and `lookup_protein`/`lookup_module`. **Tests:** `test_tabular_robust_read.py` (8), plus `.txt` heuristic tests. |
| **AI Insights v2 pre-refactor contract + design (2026-06-21, corrected 2026-06-21)** | Captured the shipped AI behavior as a 16-item machine-readable preservation checklist (`tests/contracts/ai_insights_preservation.json`) with an executable evidence/index test. The approved architecture direction is **one canonical Pi sidecar**: Standard and Deep Research are policy profiles on the same runtime and share foundational security, streaming, credentials, persistence, provenance, costs, and evaluation. The sidecar serves a standalone run-selectable UI first and the same component embeds later. Added seven standalone profile/skill fixtures (three evidence-bound profiles, four deterministic Python skills) for regression and manual testing while real Tier-1/Tier-2 work remains deferred. The HTML plan also covers center-rail model switching, per-turn data sources, durable Artifacts/Notes/feedback, three-model eval+synthesis, TDD phases, migration, and a “no vestiges” gate. **No runtime behavior changed; implementation awaits approval.** |

---

## Deferred / backlog

- **AI chat — residual security items** (lower severity, after the 2026-06-18
  hardening): isolate the LLM judge on a separate key/quota so chat
  rate-limits can't influence it; count successful-bypass probes (not just
  blocked ones) toward the extraction rate limit.
- **Dead-file cleanup (done 2026-06-18):** removed `proteomics_ai/legacy_runtime/`
  (old pre-FastAPI prototype) and `backend/services/legacy/` (quarantined
  `pipeline_runner.py` copy) — both verified unreferenced repo-wide; app still
  boots (77 routes). `routes/ai.py` kept on purpose (intentional 410-Gone
  migration stub, not dead code).
- **Additional AI providers:** out of scope (Anthropic-only); the abstraction
  could host OpenAI/Google later if revisited.
- **Power-user statistics controls:** true TAMPOR with GIS/batch metadata,
  variance/covariate correction, two-sided outlier semantics, cross-species
  CellTypeFET lookup-efficiency, exact GOparallel kappa parity.
- **Browser UAT:** volcano table, outlier-review modal, full chat UI.
# AI Insights v2 — standalone Pi sidecar (2026-06-21)

- Added the canonical Node/Pi sidecar with run-scoped SQLite persistence,
  encrypted Anthropic/OpenRouter BYOK, stable SSE events, per-turn model and
  source snapshots, immutable run grounding, cost attribution, feedback/notes,
  attachment isolation, and run-owned artifacts.
- Added one mountable vanilla-JS AI Insights app with completed-run selection,
  Standard/Deep Research policies, a searchable provider/model picker,
  Context/Artifacts rails, per-answer feedback/Notes, and secure configuration.
- Replaced the embedded legacy chat DOM with a current-run launcher to the
  standalone sidecar; the old Python subsystem remains only as rollback/parity
  coverage until the remaining migration gate is accepted.
- Fixed failed turns that reappeared as a permanent `Thinking…` message, added
  a bounded provider-turn deadline, and made local `.env` credentials win over
  inherited blank shell variables. The conversation model control is now a
  strict dropdown whose visible catalog entries are configured and persisted
  from **Configuration & summary**. Restyled the standalone workspace to match
  SignalFold's warm pipeline UI tokens, spacing, controls, and feedback states.
- Fixed manual Stop so it cancels the browser stream immediately and cannot be
  held in a `STOP` state by a reluctant provider. The server now terminates and
  persists cancelled turns independently, treats empty completions as explicit
  failures, and heals legacy model display names (such as `MiniMax M3`) to
  canonical OpenRouter IDs before rendering or saving the model menu.
- Added Artificial Analysis Intelligence Index scores and OpenRouter per-token
  costs to both model menus, with persisted Intelligence, Cost, and 7:2:1
  blended intelligence-per-dollar sorting. Reasoning disclosures now retain
  their open state through streaming/canonical refreshes and reasoning traces
  are persisted. Fixed mid-conversation model changes returning HTTP 500 by
  preserving omitted non-null conversation fields during model-only updates.
- Added the config-gated developer Operational Control Center at
  `/operations` (2026-06-22). It records bounded, secret-scrubbed operational
  turns from the canonical sidecar path: scrubbed prompt captures + hashes,
  grounding file/byte/truncation manifests, Pi lifecycle and message flow,
  SSE counts, tool/skill/Python start/end frames, usage, persistence, errors,
  and terminal duration. The read-only dashboard separates advertised skills,
  Pi-discovered skills, registered tools, and observed executions, exposing
  that the current four advertised Python skills are not executable while the
  Pi session remains `tools: []`. Disable with `AI_OPERATIONS_CENTER=0` or
  `AI_DEVELOPER_MODE=0`; retention defaults to the newest 100 turns.
- Enabled and validated Pi tool/Python/skill execution in the sidecar
  (2026-06-22), behind a hard gate (`AI_DEVELOPER_MODE=1` **and**
  `AI_PYTHON_EXECUTION` ≠ `disabled`; production stays at `tools: []`). When the
  gate is open the Pi session registers `read`, `bash`, `write`, `edit`, and a
  `save_artifact` custom tool, and injects four committed validation skills from
  `ai-sidecar/skills/` via `skillsOverride` (`sf-runtime-probe`,
  `sf-echo-script`, `sf-python-compute`, `sf-artifact-report`), each with a
  deterministic sentinel. `diagnostics().registeredTools` and the
  `session_created` payload now report the real tools, clearing both operations
  warnings and flipping `pythonExecutable` to true; `executionCategory()` was
  made deterministic so per-turn traces count skill/python/tool unambiguously,
  and `save_artifact` persists a skill's output under `ai_insights/artifacts/`
  and registers it in `GET /api/artifacts`. Verified end-to-end against a real
  completed run: every skill runs, emits its sentinel, and the artifact lands on
  disk and in the index, with the `/operations` page rendering the categorized
  frames. Covered by `tests/execution.test.ts` (incl. a production-lock guard)
  and the opt-in `npm run test:live-skills` smoke. Execution is developer-local
  (work-dir `cwd`, output scrubbing intact, not OS-sandboxed); `AI_PI_MAX_TOOL_ROUNDS`
  remains inert with the turn-timeout deadline as the enforced multi-round bound.
- Rebuilt Standard mode grounding as an adaptive, deterministic path in the
  canonical Node/Pi sidecar (2026-06-22). Every turn gets a compact run card;
  general/help questions get zero raw run rows; protein, module, GO, cell-type,
  and cross-modal questions use schema-aware, entity-filtered, relevance-ranked,
  row- and token-bounded retrieval that survives variant filenames. Standard
  Pi sessions now enforce `tools: []` and an empty skill catalogue even in
  developer mode, while the Deep Research expansion seam remains intact.
  Added durable-history compaction/pin preservation, citation/provenance export,
  and split uncached/cache-write/cache-read/cumulative telemetry. On
  `RUN-E2E-VERIFY`, deterministic grounding fell from approximately 25.2k tokens
  to 2.1k for definitions, 4.0–10.0k for representative lookups, and 10.2k for
  cross-modal synthesis. Design and measurements:
  `docs/explanations/features/ai-insights-standard-adaptive-grounding.html`.
