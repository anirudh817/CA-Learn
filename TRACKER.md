# SignalFold — Tracker / Backlog

Living to-do list. Status/history lives in [`CHANGELOG.md`](./CHANGELOG.md);
architecture in [`CLAUDE.md`](./CLAUDE.md). Tags: **[P0]** critical · **[P1]**
high · **[P2]** medium · **[P3]** later. **(Codex)** = touches the
Codex-owned pipeline/ETL — coordinate before changing.

---

## 🚩 Epic 1 — Universal proteomics ingestion + auto-detection [P0] (Codex)

**Vision:** a user drops in *any* proteomics export — Spectronaut, DIA-NN,
MaxQuant, FragPipe, PEAKS, Proteome Discoverer, Skyline — TMT or LFQ or DIA, and
the app auto-detects the format and assay type, maps it to the canonical matrix,
and runs the right analysis. **Today we've only validated one PEAKS-style
dataset, so outputs are predictable; this is the single biggest unlock for
product–market fit.**

**Foundation that already exists:** the ETL `_build_canonical_bundle()`,
`resolve_pipeline_profile()` (keys off `format_family` + `assay_level`), the
pre-run QC modal, and dataset **detector metadata** (`run_ready` gate). The epic
extends this from one format to many and makes routing automatic.

**Decomposition:**
1. **Format fingerprinting** — identify the source tool from file
   structure/headers/columns:
   - Spectronaut (DIA report, long format), DIA-NN (`report.tsv`/`pg_matrix`),
     MaxQuant (`proteinGroups.txt` / `evidence.txt`), FragPipe/Philosopher
     (`combined_protein.tsv`), PEAKS, Proteome Discoverer, Skyline.
   - Quant type: **TMT** (reporter-ion channels), LFQ/intensity, iBAQ, DIA.
2. **Schema mapping** — map each format's columns → canonical fields
   (protein/peptide IDs, per-sample intensities, modifications, contaminants/decoys).
3. **Assay-level + PTM detection** — peptide vs protein level; PTM presence
   (the v1.1 cascade fix showed PTM handling is high-stakes).
4. **TMT specifics** — channel → sample mapping, reference channel, plex layout,
   the normalization implications (TAMPOR/CBN choice).
5. **Detection-confirmation gate (UI)** — show "Detected: Spectronaut DIA,
   protein-level, 16 samples, no TMT — correct?" with confirm/override before a
   run starts. Reuse the existing QC-modal pattern.
6. **Column-mapping fallback** — when detection is ambiguous, let the user map
   columns manually (mapping UI) instead of failing.
7. **Per-format test fixtures** — acquire/synthesize a small real export from
   each tool; today's single dataset is why outputs look deterministic. This is
   the gate for trusting the feature.
8. **Param auto-suggest** — recommend pipeline params from the detected format
   (e.g., normalization method, comparison setup).

**Risks / coordination:** ETL + pipeline are Codex-owned. Format detection
should live in a **pre-ETL detection layer** so it doesn't entangle the
parity-validated pipeline. Sequencing: detection + mapping + confirmation UI
first (additive, low risk to existing path), then per-format ETL routing.

**Effort:** multi-week epic. Break into: (a) detection library + fixtures,
(b) confirmation/mapping UI, (c) per-format ETL routing, (d) validation per format.

---

## 🚩 Epic 2 — Streamline the end-to-end workflow [P1]

Reduce the path **upload → detect → confirm → configure → run → results → chat**
to as few deliberate steps as possible.
- Smart defaults from detected format (Epic 1 #8) → "Run with recommended
  settings" one-click.
- Clearer run progress/status (stage-by-stage, ETA, what's happening now).
- Collapse manual parameter entry behind an "advanced" disclosure; sensible
  defaults up front.
- Tighter upload → first-result loop; remove dead clicks.
- Surface "what to do next" affordances at each stage.

---

## Near-term product backlog

- **[P1] Real browser UAT (Playwright).** ✅ First e2e suite is live and
  GREEN at `tests/e2e/chat_isolation.spec.js` (3 tests: no-bleed,
  switch-back, redaction) — runs against the real app with a controlled SSE
  stream; the no-bleed test is **red-verified** (fails on pre-fix `chat.js`).
  Next: expand to the full flow (login → open run → chat → attach → pin →
  external lookup) and wire into CI.
- **[P1] Eval suite through the live security gates.** The red-team eval
  currently exercises only the system prompt, not the deployed regex/judge/
  fail-closed-backstop chain. Wire it through the real gates so CI catches any
  regression in the hardening work.
- **[P1] Richer Discovery-mode biology.** P11 shipped as a framework; its value
  scales with the downstream biological synthesis it can ground in. The product
  differentiator.
- **[P2] Isolate the LLM judge on a separate key/quota** so chat rate-limits
  can't influence it (now lower urgency given the fail-closed backstop).
- **[P2] Production hardening.** Dev harness runs `bypassPermissions`; before
  shared deployment lock `SESSION_SECRET` enforcement, CORS, infra rate limiting.
- **[P2] Power-user statistics controls (Codex):** true TAMPOR with GIS/batch
  metadata, variance/covariate correction, two-sided outlier semantics,
  cross-species CellTypeFET lookup-efficiency, exact GOparallel kappa parity.

## 🚩 Epic 3 — Portability & deployability [P1]

**Vision:** a SignalFold install can be moved to another machine — a demo
laptop, a colleague's workstation, a client site — without hand-surgery on the
database. Today it effectively cannot. Surfaced 2026-08-25 while preparing a
client demo on a second laptop.

- **[P0] Absolute paths stored in the database.** `uploaded_datasets.stored_path`
  and `runs.manifest_path` are written as absolute host paths
  (`/Users/<user>/…/data/uploads/…`). Any relocation — different user, different
  checkout dir, container vs native — silently breaks dataset cards and
  manifests while the app still boots and lists runs. **Fix:** store
  `DATA_DIR`-relative paths, resolve against `DATA_DIR` at read time, and
  migrate existing rows on startup.
- **[P1] No supported way to move or seed an install.** `data/` is gitignored
  and 4.2 GB; there is no export/import path. **Fix:** an `export-bundle` /
  `import-bundle` command that packs selected runs + their dataset rows + the
  needed DB records into a portable archive, rewriting paths on import.
- **[P1] R is a hard dependency with no non-Docker path.** `run_stage1()` fails
  with `RuntimeError("R Stage 1 is required but unavailable…")` when `Rscript`
  or `stage1_parity.R` is missing, so a live run is impossible on any machine
  that cannot run Docker (common on locked-down corporate laptops). **Fix:**
  either publish a prebuilt image so no local R build is needed, or restore a
  Python fallback for Stage 1. At minimum, document Docker as a hard
  requirement for *running* (vs *viewing*) analyses.
- **[P2] Orphaned run directories and dangling run rows.** 31 directories exist
  under `data/runs/` against 16 DB rows; conversely, DB rows whose directories
  are absent render in run history and 404 on open. **Fix:** a reconcile/GC
  command plus a existence check before listing.
- **[P2] Uploads are never garbage-collected or deduplicated.** `data/uploads/`
  is 1.8 GB across 71 files, including a single 424 MB CSV (over GitHub's
  100 MB file limit, so it also blocks any git-based transfer) and repeated
  re-uploads of identical content — `dataset_hash` is already computed but not
  used to dedupe. **Fix:** dedupe by `dataset_hash` + a retention policy.
- **[P2] Run duration is unpredictable and unsurfaced.** Measured: 6 min for a
  5.9 MB / 59-sample PEAKS input vs **53 min** for a 26.6 MB / 60-sample one.
  Nothing in the UI warns before launch. **Fix:** estimate from
  feature × sample count and show it at run-configure time. Related to Epic 2.
- **[P3] `CHANGELOG.md` is stale.** Last entry is 2026-06-23; ~55 commits landed
  after it (the entire current Deep Research surface: Arbiter council, in-thread
  re-run, whole-run catalog, tiered deliverables). Anyone onboarding from the
  changelog gets a wrong picture of the product.

---

## Audit residue (lower severity, from the 2026-06 security/UI audits)

- [P2] Stream-time (not post-hoc) leak detection on the streaming path.
- [P3] Widen the output-scrubber model-ID / vendor regex further.
- [P3] Mention-dropdown stale-option hardening; cost pill only shows on active
  conversation; native `confirm()`/`alert()` → styled modals.

## Demo-day quick wins (safe, additive, frontend-mostly)

- [P2] Suggested **starter questions** in the empty chat state (clickable,
  run-grounded) — smooths demo flow, shows breadth, zero backend risk.
- [P2] **Loading state** when opening a conversation (no frozen-looking gap).
- [P2] Surface the **detected format/assay** (from existing detector metadata)
  on the upload card — a visible teaser for Epic 1.

---

_Created 2026-06-18. Add items as they surface; promote from backlog when scheduled._
