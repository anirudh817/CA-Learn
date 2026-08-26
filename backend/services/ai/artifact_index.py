"""Per-run artifact index.

Catalogues every file produced by a SignalFold pipeline run so the chat
retrieval layer can route a question to the right file without hard-coding
filenames.

Multi-pipeline safety:
    - PRIMARY source: `data/runs/{run_id}/artifact_index.json` (written by
      Codex's `services/artifacts.py:write_artifact_index`). Authoritative
      when present.
    - FALLBACK: filesystem scan with content-based classification. Older runs
      and runs from variant pipelines that didn't write the index file are
      still searchable.

Schema-aware:
    For tabular files we record the column list and row count. Retrievers
    look at columns, not filenames — so a pipeline that renames
    `volcano_results.tsv` → `de_table.csv` is still recognized as a "DE
    results" file because the columns match the family signature.

Cache:
    In-process, keyed by (run_id, mtime of run dir). Re-reads when the
    pipeline writes new files. Cheap to call repeatedly.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Family signatures — content-based classification
# ---------------------------------------------------------------------------
# Each family is a stable identifier used by retrievers + citations. The
# `column_signatures` list is "any one of these column-sets matches".
# Order matters when a file matches multiple — first hit wins.

FAMILY_SIGNATURES: list[dict] = [
    {
        "family": "volcano.results",
        "kind": "tabular",
        "filename_hints": ["volcano_results", "de_results", "differential", "volcano"],
        "column_signatures": [
            {"gene", "log2fc", "adj_pvalue"},
            {"gene", "log2fc", "padj"},
            {"protein", "log2fc", "adj_pvalue"},
            {"feature_id", "log2fc", "adj_pvalue"},
            {"feature_id", "log2fc", "pvalue"},
        ],
    },
    {
        "family": "volcano.upregulated",
        "kind": "tabular",
        "filename_hints": ["upregulated", "up_regulated"],
        "column_signatures": [{"gene", "log2fc", "adj_pvalue"}, {"feature_id", "log2fc"}],
    },
    {
        "family": "volcano.downregulated",
        "kind": "tabular",
        "filename_hints": ["downregulated", "down_regulated"],
        "column_signatures": [{"gene", "log2fc", "adj_pvalue"}, {"feature_id", "log2fc"}],
    },
    {
        "family": "network.assignments",
        "kind": "tabular",
        "filename_hints": ["module_assignments", "module_membership", "wgcna_modules"],
        "column_signatures": [
            {"gene", "module_color"},
            {"gene", "module"},
            {"peptide_id", "module_color"},
            {"feature_id", "module_color"},
        ],
    },
    {
        "family": "network.eigengenes",
        "kind": "tabular",
        "filename_hints": ["module_eigengenes", "eigengenes"],
        "column_signatures": [{"sample_name"}, {"sample"}],
    },
    {
        "family": "network.hub_proteins",
        "kind": "tabular",
        # Hub-protein outputs that the WGCNA / network stages produce.
        # Column shapes vary (some have kME, some have hub_score, some are
        # ranked lists) — we lean on the filename for this one.
        "filename_hints": ["hub_protein", "hub_proteins", "hub_gene", "all_hub"],
        "column_signatures": [],
    },
    {
        "family": "network.kme",
        "kind": "tabular",
        "filename_hints": ["kme_matrix", "kme"],
        "column_signatures": [{"gene"}, {"feature_id"}, {"peptide_id"}],
    },
    {
        "family": "network.module_trait",
        "kind": "tabular",
        "filename_hints": ["module_trait_cor", "module_trait", "module_phenotype"],
        # IMPORTANT: keep this signature specific — must require both module_color
        # AND a correlation column. A bare {module} would steal GO and cell-type
        # files (which also have a "module" column).
        "column_signatures": [{"module_color"}],
    },
    {
        "family": "go.enrichment",
        "kind": "tabular",
        "filename_hints": ["go_enrichment_all", "go_enrichment", "gsea_results", "enrichment"],
        "column_signatures": [
            {"module", "term", "pvalue"},
            {"module", "term", "fdr"},
            {"term", "pvalue", "module"},
        ],
    },
    {
        "family": "go.matrix",
        "kind": "tabular",
        "filename_hints": ["go_fdr_matrix", "go_pvalues_matrix", "go_zscore_matrix"],
        "column_signatures": [],   # wide-format — column names are GO terms
    },
    {
        "family": "cells.matrix",
        "kind": "tabular",
        "filename_hints": ["celltype_heatmap_data", "celltype_fdr", "celltype_matrix"],
        "column_signatures": [
            {"module", "cell_type", "fdr"},
            {"module", "cell_type", "pvalue"},
        ],
    },
    {
        "family": "cells.hit_list",
        "kind": "tabular",
        "filename_hints": ["celltype_hitliststats", "celltype_hits"],
        "column_signatures": [{"gene"}, {"feature_id"}],
    },
    {
        "family": "input.matrix",
        "kind": "tabular",
        "filename_hints": ["cleaned_matrix", "normalized_matrix", "abundance"],
        "column_signatures": [{"gene"}, {"feature_id"}],
    },
    {
        "family": "input.samples",
        "kind": "tabular",
        "filename_hints": ["sample_metadata", "samples", "traits"],
        "column_signatures": [{"sample"}, {"sample_name"}, {"sample_key"}],
    },
    {
        "family": "report.manifest",
        "kind": "json",
        "filename_hints": ["run_manifest", "manifest"],
        "column_signatures": [],
    },
    {
        "family": "report.params",
        "kind": "json",
        "filename_hints": ["params"],
        "column_signatures": [],
    },
    {
        "family": "report.profile",
        "kind": "json",
        "filename_hints": ["pipeline_profile"],
        "column_signatures": [],
    },
    {
        "family": "report.summary",
        "kind": "json",
        "filename_hints": ["analysis_summary", "go_summary", "celltype_summary", "volcano_summary"],
        "column_signatures": [],
    },
    {
        "family": "report.top_proteins",
        "kind": "json",
        "filename_hints": ["top_proteins", "hub_proteins"],
        "column_signatures": [],
    },
    {
        "family": "report.dashboard",
        "kind": "html",
        "filename_hints": ["dashboard", "interactive"],
        "column_signatures": [],
    },
    {
        "family": "report.plot",
        "kind": "pdf",
        "filename_hints": [],   # PDFs caught by extension
        "column_signatures": [],
    },
]


# ---------------------------------------------------------------------------
# Data shapes
# ---------------------------------------------------------------------------

@dataclass
class ArtifactRecord:
    rel_path: str
    abs_path: str
    family: str
    kind: str                     # "tabular" | "json" | "html" | "pdf" | "binary"
    columns: list[str] = field(default_factory=list)
    row_count: Optional[int] = None
    size_bytes: int = 0
    # Stage/tab if we can read it from artifact_index.json; else derived from path.
    stage: str = ""
    tab: str = ""


@dataclass
class ArtifactIndex:
    run_id: str
    run_dir: Path
    records: list[ArtifactRecord]

    # ------------------- query helpers --------------------------

    def by_family(self, family: str) -> list[ArtifactRecord]:
        return [r for r in self.records if r.family == family]

    def first(self, family: str) -> Optional[ArtifactRecord]:
        for r in self.records:
            if r.family == family:
                return r
        return None

    def by_kind(self, kind: str) -> list[ArtifactRecord]:
        return [r for r in self.records if r.kind == kind]

    def families_present(self) -> set[str]:
        return {r.family for r in self.records}

    def table_of_contents(self, *, max_files: int = 40) -> str:
        """Compact markdown ToC for inclusion in the model's context.

        Shows the model what *kinds* of data exist in this run so it knows
        what it can ask for via tool-use — without dumping all the data.
        """
        lines = [f"### Available artifacts for run `{self.run_id}`"]
        by_fam: dict[str, list[ArtifactRecord]] = {}
        for r in self.records:
            by_fam.setdefault(r.family, []).append(r)
        shown = 0
        # Order families with the most-asked-about first.
        family_order = [
            "volcano.results", "network.assignments", "network.kme",
            "network.module_trait", "network.eigengenes",
            "go.enrichment", "cells.matrix", "cells.hit_list",
            "input.matrix", "input.samples",
            "report.manifest", "report.params", "report.top_proteins",
            "report.summary",
        ]
        # Render in priority order first, then anything left over.
        seen_fam: set[str] = set()
        for fam in family_order:
            if fam not in by_fam or shown >= max_files:
                continue
            for r in by_fam[fam]:
                cols = f" — columns: {', '.join(r.columns[:8])}{'…' if len(r.columns) > 8 else ''}" if r.columns else ""
                rows = f" ({r.row_count:,} rows)" if r.row_count else ""
                lines.append(f"- `{r.rel_path}`  [{r.family}]{rows}{cols}")
                shown += 1
                if shown >= max_files:
                    break
            seen_fam.add(fam)
        for fam, items in by_fam.items():
            if shown >= max_files:
                break
            if fam in seen_fam:
                continue
            for r in items:
                lines.append(f"- `{r.rel_path}`  [{r.family}]")
                shown += 1
                if shown >= max_files:
                    break
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Build / load
# ---------------------------------------------------------------------------

def _classify_by_filename(name: str) -> Optional[str]:
    """Cheap hint-based family lookup. May return None — caller will then
    try the column-based signature path."""
    low = name.lower()
    for sig in FAMILY_SIGNATURES:
        for hint in sig["filename_hints"]:
            if hint in low:
                return sig["family"]
    # PDF / HTML catch-all by extension
    if low.endswith(".pdf"):
        return "report.plot"
    if low.endswith(".html"):
        return "report.dashboard"
    return None


def _classify_by_columns(columns: set[str]) -> Optional[str]:
    """Match columns (lowercased) to a family signature."""
    if not columns:
        return None
    lower = {c.lower().strip() for c in columns}
    for sig in FAMILY_SIGNATURES:
        for required in sig["column_signatures"]:
            req_lower = {c.lower() for c in required}
            if req_lower.issubset(lower):
                return sig["family"]
    return None


def _peek_tabular(path: Path) -> tuple[list[str], Optional[int]]:
    """Read just the header + estimate row count without loading the whole file."""
    try:
        ext = path.suffix.lower()
        sep = "\t" if ext == ".tsv" else ","
        with path.open("r", errors="replace") as fh:
            first = fh.readline()
            cols = [c.strip().strip('"') for c in first.rstrip("\n").split(sep) if c.strip()]
        # Row count via line count − 1 header. Cheap.
        try:
            with path.open("rb") as fh:
                n = sum(1 for _ in fh) - 1
        except OSError:
            n = None
        return cols, max(n, 0) if n is not None else None
    except OSError as exc:
        log.warning("peek failed for %s: %s", path, exc)
        return [], None


def _stage_and_tab_from_path(rel_path: str) -> tuple[str, str]:
    parts = rel_path.split("/", 1)
    if not parts:
        return "", ""
    head = parts[0].lower()
    if head.startswith("stage"):
        return head, ""
    if head in {"input", "01_input"}:
        return "input", "input"
    return head, ""


def _build_from_artifact_index_json(run_id: str, run_dir: Path, raw: dict) -> ArtifactIndex:
    records: list[ArtifactRecord] = []
    for entry in raw.get("artifacts", []) or []:
        rel_path = entry.get("rel_path") or ""
        if not rel_path:
            continue
        abs_path = run_dir / rel_path
        family_hint = entry.get("artifact_family") or ""
        kind = entry.get("kind") or ""
        # Trust the pipeline's family name when present, else re-classify.
        family = family_hint or _classify_by_filename(rel_path) or "other"
        columns: list[str] = []
        row_count: Optional[int] = None
        size_bytes = int(entry.get("size_bytes") or 0)
        # For tabular families, peek to get real column names.
        if abs_path.exists() and abs_path.suffix.lower() in {".csv", ".tsv"}:
            columns, row_count = _peek_tabular(abs_path)
            # Refine family via columns if hint was generic or wrong.
            refined = _classify_by_columns(set(columns))
            if refined and (family == "other" or family.endswith(".tables")):
                family = refined
        elif abs_path.suffix.lower() in {".pdf", ".html", ".json"} and not family:
            family = _classify_by_filename(rel_path) or family or "other"

        records.append(ArtifactRecord(
            rel_path=rel_path,
            abs_path=str(abs_path),
            family=family,
            kind=kind or ("tabular" if abs_path.suffix.lower() in {".csv", ".tsv"} else
                         "json" if abs_path.suffix.lower() == ".json" else
                         "html" if abs_path.suffix.lower() == ".html" else
                         "pdf" if abs_path.suffix.lower() == ".pdf" else "binary"),
            columns=columns,
            row_count=row_count,
            size_bytes=size_bytes,
            stage=entry.get("stage") or "",
            tab=entry.get("tab") or "",
        ))
    return ArtifactIndex(run_id=run_id, run_dir=run_dir, records=records)


def _build_from_filesystem(run_id: str, run_dir: Path) -> ArtifactIndex:
    records: list[ArtifactRecord] = []
    if not run_dir.exists():
        return ArtifactIndex(run_id=run_id, run_dir=run_dir, records=records)
    for path in sorted(run_dir.rglob("*")):
        if not path.is_file():
            continue
        # Skip noise.
        if any(seg.startswith(".") for seg in path.parts):
            continue
        suffix = path.suffix.lower()
        if suffix in {".rdata", ".rds", ".rda"}:
            continue
        rel = path.relative_to(run_dir).as_posix()
        family_hint = _classify_by_filename(rel)
        kind = "binary"
        columns: list[str] = []
        row_count: Optional[int] = None
        if suffix in {".csv", ".tsv"}:
            kind = "tabular"
            columns, row_count = _peek_tabular(path)
            # Filename hint wins when present — it's more specific than
            # columns alone (e.g. a hub-proteins file may have the same
            # columns as module-assignments; only the filename reveals
            # which family it actually belongs to).
            family = family_hint or _classify_by_columns(set(columns)) or "other"
        elif suffix == ".json":
            kind = "json"
            family = family_hint or "other"
        elif suffix == ".pdf":
            kind = "pdf"
            family = family_hint or "report.plot"
        elif suffix in {".html", ".htm"}:
            kind = "html"
            family = family_hint or "report.dashboard"
        else:
            family = family_hint or "other"

        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        stage, tab = _stage_and_tab_from_path(rel)
        records.append(ArtifactRecord(
            rel_path=rel,
            abs_path=str(path),
            family=family,
            kind=kind,
            columns=columns,
            row_count=row_count,
            size_bytes=size,
            stage=stage,
            tab=tab,
        ))
    return ArtifactIndex(run_id=run_id, run_dir=run_dir, records=records)


def build_index(run_id: str, run_dir: Path) -> ArtifactIndex:
    """Authoritative entry point. Tries artifact_index.json first, then
    falls back to a filesystem scan."""
    if not run_dir.exists():
        return ArtifactIndex(run_id=run_id, run_dir=run_dir, records=[])
    aij = run_dir / "artifact_index.json"
    if aij.exists():
        try:
            raw = json.loads(aij.read_text())
            return _build_from_artifact_index_json(run_id, run_dir, raw)
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("artifact_index.json unparseable for %s: %s — falling back to scan", run_id, exc)
    return _build_from_filesystem(run_id, run_dir)


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

@lru_cache(maxsize=32)
def _cached_index(run_id: str, run_dir_str: str, mtime_signature: float) -> ArtifactIndex:
    return build_index(run_id, Path(run_dir_str))


def get_index(run_id: str, runs_dir: Path) -> ArtifactIndex:
    """Cached accessor. Invalidates when the run directory's mtime changes
    (which it does whenever the pipeline writes a new file)."""
    run_dir = runs_dir / run_id
    if not run_dir.exists():
        return ArtifactIndex(run_id=run_id, run_dir=run_dir, records=[])
    try:
        sig = max(
            (run_dir.stat().st_mtime,
             *(p.stat().st_mtime for p in run_dir.iterdir() if p.is_dir())),
        )
    except OSError:
        sig = 0.0
    return _cached_index(run_id, str(run_dir), sig)


def clear_cache() -> None:
    _cached_index.cache_clear()
