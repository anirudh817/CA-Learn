# Handoff → Codex: Power-user statistics controls

**Audience:** Codex (owner of the parity-validated pipeline + R scripts).
**Author:** Claude (AI-subsystem side). I do **not** edit pipeline code — this
is a context package so you can scope and execute the work with full intent.
**Status:** Parked on the AI side pending your coordination. Tracker item:
*"[P2] Power-user statistics controls (Codex)"*.

---

## Why this is yours, not mine

`pipeline.py`, `pipeline_runner.py`, the stage runners, and `r_scripts/` are
**off-limits to AI edits** (CLAUDE.md) because they're the parity-validated
scientific core. Every item below changes numerical output, so a regression is
silent and scientific — exactly the kind of change that must go through your
parity discipline (R-vs-Python equivalence, fixture comparison), not an
autonomous test-writing loop. I'm handing you *what* and *where*; you own *how*.

## The five controls (from the tracker, expanded with code pointers)

### 1. True TAMPOR with GIS / batch metadata
- **What today does:** normalization is parameterized but does not run a full
  TAMPOR with Global Internal Standard (GIS) / batch-aware correction.
- **Where:** normalization path in `backend/services/pipeline.py` (see
  `_normalize_*` helpers and the stage-1 normalization step); batch metadata
  already flows as `BATCH` in `bundle["traits"]` (see `pipeline.py:1096+`,
  `reserved_cols` at `:1122`).
- **Goal:** real TAMPOR — ratio-to-GIS across batches, with the TAMPOR vs CBN
  choice surfaced as a param. Needs GIS channel/sample identification.

### 2. Variance / covariate correction
- **What today does:** no covariate model (e.g. removing batch/age/sex variance
  before DE).
- **Where:** between normalization and DE in stage 1, `pipeline.py`.
- **Goal:** optional covariate matrix → linear-model correction (limma-style
  `removeBatchEffect` or covariates in the DE design).

### 3. Two-sided outlier semantics
- **What today does:** network-connectivity outlier detection via
  `outlier_removal.R` / `_detect_outliers` (`pipeline.py:1136–1180+`), driven by
  `outlier_z_threshold` (default 2.0) and `outlier_mode` (`low_connectivity`).
  Current semantics are effectively one-sided (low connectivity).
- **Goal:** two-sided semantics — flag both abnormally low **and** high
  connectivity samples; expose the mode as a user control.

### 4. Cross-species CellTypeFET lookup-efficiency
- **What today does:** CellTypeFET enrichment rendered via
  `celltype_viz_runner.R` (`pipeline_stage3.py:20–80+`), single-species marker
  lookup.
- **Goal:** cross-species marker mapping (e.g. human↔mouse ortholog lookup) with
  a lookup-efficiency / coverage metric so users see how many markers resolved.

### 5. Exact GOparallel kappa parity
- **What today does:** Python `_select_kappa_kept_term_keys` greedy kappa pruning
  at `kappa_cut=0.30` (`pipeline_stage2.py:133–176, 419–420`), `_cohen_kappa`
  over gene-set membership vectors. `redundancy_mode` defaults to `"kappa"`.
- **Goal:** confirm exact parity with the reference GOparallel kappa algorithm
  (clustering/linkage order, tie-breaking, universe definition). This is a
  parity-verification task more than a feature.

## How the AI subsystem benefits (why I care)

The chat's retrieval + Discovery layers read these stage outputs as a black box
(`data/runs/{id}/stage{N}/`). Richer, correctly-parity'd stats → richer grounded
biological synthesis downstream. No interface change needed on my side as long
as output **file shapes/locations stay stable** — if any of these change column
names or artifact paths, flag me so I can update retrievers/artifact routing.

## Suggested sequencing (yours to override)
1. #5 (parity verification — lowest risk, pure validation).
2. #3 (outlier semantics — localized).
3. #2 (covariate correction — additive, opt-in).
4. #1 (true TAMPOR — largest, needs GIS identification).
5. #4 (cross-species CellTypeFET — needs ortholog data).

## Open questions for you
- Is GIS channel/sample identification available in current uploads, or does it
  need a detection step (ties into Epic 1 format detection)?
- Do you want these as new pipeline params (smart defaults) or an "advanced"
  disclosure (ties into Epic 2 streamlining)?
- Any of these already partially done in `r_scripts/` that I can't see?
