# Run notes — End-to-end runnability + reference-data wiring (2026-06-21)

**Author:** Claude Code · **Branch:** `ssb1` · **Mode:** Docker (the native dev
server has no R and cannot run the pipeline).

## TL;DR

SignalFold now runs the **full pipeline end-to-end** under Docker. A clean run on
the PEAKS Log2 dataset (`RUN-20260621-B866` config) completes with **every stage
green** (variance correction is intentionally skipped — disabled in params):

```
etl ✓  alignment ✓  outlier ✓  normalization ✓  DE ✓
WGCNA ✓  GOparallel ✓  CellTypeFET ✓  deliverables ✓
COMPLETE | modules=22 | sig=1785 | go_terms=535
```

Previously the run hard-failed at Stage 1 (no R), then — once R was available —
the UI froze on "Executing" instead of showing failures, and WGCNA was OOM-killed
on the full feature set. All addressed below.

---

## ⚠️ Parity-sensitive change — needs pipeline-owner (Codex) review

`backend/r_scripts/stage1_parity.R` is **off-limits to AI edits** (parity-validated
scientific core, per CLAUDE.md). It was edited here **at the user's explicit
direction** and **changes numerical output**, so it must go through the parity
discipline (R-vs-reference equivalence) before being treated as validated.

- **What:** WGCNA now runs on the **top-N most-variable features** (default
  **5,000**) instead of all ~18k. DE/volcano still run on the full feature set;
  only the network input is narrowed. Non-network features map back to
  `module_assignments.csv` as `grey`/`Unassigned` (mapping is by feature name, so
  this is safe).
- **Where:** `stage1_parity.R` — new `wgcna_max_features` config read (default
  5000) + a variance filter inserted after `goodSamplesGenes` and before
  `pickSoftThreshold`. `maxBlockSize` is untouched (≤5k stays single-block, so no
  block-boundary artifacts).
- **Why:** single-block WGCNA on ~18k features builds dense feature×feature
  matrices (~2.6 GB each) and was **OOM-killed** (exit -9) on the 8 GB Docker VM.
- **Tunable:** `wgcna_max_features` (R config / per-run param). `0` or negative
  disables the cap (full feature set — needs lots of RAM).
- **Review needed:** confirm the variance-filtered module set is scientifically
  acceptable vs. the all-feature reference, or replace with a different bound.

---

## Reference-data wiring (so the appropriate files can be wired going forward)

Two reference assets were **already committed in the repo** but pointed at empty
placeholders in `backend/data/reference/`. Both are now wired via `config.py`
using the same **override-or-bundled** pattern (mirroring the existing mouse
cell-type wiring). The resolution order is: **per-run param → user override in
`data/reference/` → bundled repo file.**

### GO / pathway gene sets (GMT)

| | |
|---|---|
| Config constant | `DEFAULT_GMT_FILE` (`backend/config.py`) |
| Resolves to | `data/reference/default_GO_gmt.gmt` if present, else the bundled file |
| Bundled file | `backend/r_scripts/GOparallel/Human_GO_AllPathways_noPFOCR_with_GO_iea_September_01_2025_symbol.gmt` (Bader Lab, human, gene symbols; 28,877 sets) |
| Per-run override | `gmt_file` param |
| Consumed by | `backend/services/pipeline_stage2.py` (Python `_load_gmt` + FET) |
| Format | GMT: `name<TAB>description<TAB>gene1<TAB>gene2…` (gene **symbols**) |

**To update/replace:** drop a `.gmt` at `data/reference/default_GO_gmt.gmt` (takes
precedence, survives image rebuilds via the `./data` mount), pass `gmt_file`
per-run, or bump `_BUNDLED_GMT` in `config.py` when the Bader Lab release changes
(the bundled filename is date-stamped).

### Cell-type markers

| | |
|---|---|
| Config constants | `DEFAULT_CELLTYPE_MARKERS` (human), `DEFAULT_CELLTYPE_MARKERS_MOUSE` (mouse) |
| Human resolves to | `data/reference/default_celltype_markers.csv` if present, else bundled human file |
| Bundled human file | `backend/r_scripts/CellTypeFET/MyGene-Human-SharmaZhangUnion.csv` |
| Bundled mouse file | `backend/r_scripts/CellTypeFET/MyGene-Mouse-SharmaZhangUnion.csv` |
| Per-run override | `celltype_markers_file` param (sets reference to `custom`) |
| Selection logic | `pipeline_stage3.py::_resolve_celltype_controls` — custom → `mouse_reference` → human default |
| Format | CSV; one column per cell type (`Astrocytes,Microglia,Neuron,Oligodendrocytes,Endothelia`), values = gene symbols |

**To add a new species/reference:** add the CSV under
`r_scripts/CellTypeFET/`, add a `DEFAULT_CELLTYPE_MARKERS_<X>` constant in
`config.py`, and extend the `reference ==` branch in
`pipeline_stage3.py::_resolve_celltype_controls`.

> Note: only the **GO** and **cell-type** defaults were wired this session (per
> user request). The `go.obo` redundancy file is **not** required because the
> configured redundancy mode is `kappa` (igraph-based), not OBO-based.

---

## Other changes (file-by-file)

- **`backend/config.py`** — wired `DEFAULT_GMT_FILE` and human
  `DEFAULT_CELLTYPE_MARKERS` to bundled repo files with `data/reference/`
  overrides (see above). *Not off-limits.*
- **`frontend/app.js` + `frontend/index.html`** — failed runs now render a
  visible **"Run failed"** state (red progress bar, subtitle, persistent banner
  with the real `error_message`) instead of a silent frozen "Executing". New
  `markRunFailed()` / `addFailureCard()`; both SSE failure paths route through it
  (idempotent); reset clears it. CSS: `.run-failure-banner`, `.progress-fill.failed`.
- **`proteomics_ai/devserver.py`** — binds **one predictable port** (`$PORT`,
  default 8000) and **fails loudly if busy** instead of silently drifting to 8001
  (which created two indistinguishable instances). Warns at startup if `Rscript`
  is missing (native server can't run the pipeline). `find_available_port`
  replaced by `resolve_port`.
- **`run.sh`** — `bg` mode now surfaces startup errors / a died process instead of
  timing out silently.
- **`docker-compose.yml`** — mounts `./frontend` into the backend container so
  `:8000` serves the live frontend (matches the existing nginx mount; avoids stale
  frontend baked into the image).
- **`tests/test_app.py`** — replaced the `find_available_port` test with
  `resolve_port` tests (default 8000, `$PORT` honored, fail-loud on busy).
- **`tests/e2e/run_failure_ui.spec.js`** *(new)* — browser regression test: a
  failed run shows the failure banner + red bar + "Run failed" subtitle.
- **`CLAUDE.md`** — corrected the stale "Dual-Engine Note": Stage 1 is **R-only**
  and hard-fails without R (the Python WGCNA fallback was removed in `26ea50e`).

## How to run

```bash
docker compose up -d      # backend :8000 (with R) + nginx :8080
# open http://localhost:8000
docker compose down       # stop
```

**Do not use `./run.sh` for pipeline work** — it's the native server with no R;
Stage 1 will fail. Data persists across restarts via the `./data` volume.

## Verification performed

- Full pipeline COMPLETE end-to-end on the real Docker stack (all stages above).
- WGCNA: no OOM with the top-5k filter (was SIGKILL/exit -9 at full feature set;
  cgroup `oom_kill 1`, Docker VM = 8 GB).
- GO: 535 significant terms (27,165 gene sets loaded).
- Cell-type FET: outputs produced (human markers wired).
- e2e browser suite: 6 passed (incl. new failure-UI spec).
- `resolve_port` unit tests: passed.

## Known follow-ups (not done this session)

- **WGCNA memory vs. feature count** — top-5k is the mitigation on an 8 GB Docker
  VM. Raising `wgcna_max_features` or removing the cap needs more RAM. Parity
  review of the filtered module set is outstanding (see warning above).
- **Run de-duplication** — re-running identical data+params returns the prior run
  (including failed ones); start a fresh analysis or change a param to force a new
  run.
