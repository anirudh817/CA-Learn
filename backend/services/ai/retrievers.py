"""Schema-aware structured retrievers — the heart of P4.

Each retriever:
  - Accepts an :class:`ArtifactIndex` and a :class:`QueryIntent`.
  - Picks the right file(s) from the index by family (not by hardcoded name).
  - Looks at the file's actual columns to decide HOW to filter.
  - Returns a :class:`RetrievedChunk` with rendered markdown + citation
    metadata (file path + row IDs).

Why schema-aware:
  Different pipelines name files differently. The volcano file may be
  ``stage1/volcano_results.tsv`` in one pipeline and ``de/results.csv`` in
  another. By keying off the column signature rather than the path, our
  retrievers work across runs.

Returned chunks are markdown blocks small enough to live inside an LLM
prompt budget — see ``DEFAULT_ROW_LIMIT`` and ``CHUNK_MAX_CHARS``.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from .artifact_index import ArtifactIndex, ArtifactRecord
from .context_builder import dataframe_to_markdown
from .query_rewriter import QueryIntent

log = logging.getLogger(__name__)


DEFAULT_ROW_LIMIT = 80         # never return more rows than this from a single retriever
CHUNK_MAX_CHARS = 20_000       # hard cap on rendered chunk size


# ---------------------------------------------------------------------------
# Chunk + citation shape
# ---------------------------------------------------------------------------

@dataclass
class RetrievedChunk:
    family: str
    rel_path: str
    title: str                      # short human-readable header
    body: str                       # rendered markdown (table / quote / json)
    citations: list[dict] = field(default_factory=list)
    rows_returned: int = 0
    rows_total: Optional[int] = None
    truncated: bool = False
    notes: str = ""

    def to_prompt_block(self) -> str:
        head = f"### {self.title}  —  `{self.rel_path}`"
        meta = []
        if self.rows_total is not None:
            meta.append(f"{self.rows_returned} of {self.rows_total:,} rows shown")
        elif self.rows_returned:
            meta.append(f"{self.rows_returned} rows")
        if self.truncated:
            meta.append("truncated")
        if self.notes:
            meta.append(self.notes)
        meta_line = f"_({'; '.join(meta)})_" if meta else ""
        return f"{head}\n{meta_line}\n\n{self.body}".strip()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_tabular(record: ArtifactRecord, *, nrows: Optional[int] = None):
    # Robust read: tolerates files whose real delimiter doesn't match their
    # extension (e.g. a tab/whitespace-delimited GO-FET `.txt`), which used to
    # raise "Expected 1 fields…" and leave the chat with zero rows.
    from .tabular import read_table

    return read_table(record.abs_path, nrows=nrows)


def _pick_column(df, candidates: list[str]) -> Optional[str]:
    """First column from ``candidates`` (case-insensitive) present in df."""
    lower = {c.lower(): c for c in df.columns}
    for c in candidates:
        if c.lower() in lower:
            return lower[c.lower()]
    return None


def _trim_to_chars(text: str, limit: int = CHUNK_MAX_CHARS) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    return text[:limit].rstrip() + "\n\n[…truncated]", True


def _row_ids_for(df, gene_col: Optional[str], rows) -> list[Any]:
    """Compose a citation row-IDs list from a filtered slice."""
    if rows is None or rows.empty:
        return []
    idx = list(rows.index)
    if gene_col and gene_col in rows.columns:
        return [{"index": int(i), "symbol": str(rows.loc[i, gene_col])} for i in idx[:50]]
    return [int(i) for i in idx[:50]]


def _build_chunk(
    *,
    record: ArtifactRecord,
    title: str,
    df,
    rows_returned: int,
    rows_total: int,
    citations: list[dict],
    notes: str = "",
) -> RetrievedChunk:
    body = dataframe_to_markdown(df) if df is not None and len(df) else "_(no matching rows)_"
    body, truncated = _trim_to_chars(body)
    return RetrievedChunk(
        family=record.family,
        rel_path=record.rel_path,
        title=title,
        body=body,
        citations=citations,
        rows_returned=rows_returned,
        rows_total=rows_total,
        truncated=truncated,
        notes=notes,
    )


# ---------------------------------------------------------------------------
# Per-family retrievers
# ---------------------------------------------------------------------------

def retrieve_volcano(
    index: ArtifactIndex,
    intent: QueryIntent,
    *,
    limit: int = DEFAULT_ROW_LIMIT,
) -> list[RetrievedChunk]:
    """Differential expression results.

    Behavior by intent:
      - ``protein_lookup``         — filter to the named symbols
      - ``significance_ranking``   — top N by adj_pvalue ascending
      - ``module_query``           — filter by module
      - default                    — top N by adj_pvalue
    """
    record = index.first("volcano.results") or index.first("volcano.upregulated")
    if record is None:
        return []
    df = _load_tabular(record)
    if df is None or df.empty:
        return []
    total = len(df)
    gene_col = _pick_column(df, ["gene", "protein", "feature_id", "peptide_id"])
    pval_col = _pick_column(df, ["adj_pvalue", "padj", "fdr", "qvalue", "pvalue"])
    module_col = _pick_column(df, ["module", "module_color"])

    proteins = [p.upper() for p in intent.entities.get("proteins", [])]
    modules = [m.lower() for m in intent.entities.get("modules", [])]

    selected = None
    notes_parts: list[str] = []

    if proteins and gene_col is not None:
        mask = df[gene_col].astype(str).str.upper().str.contains(
            "|".join(re.escape(p) for p in proteins), regex=True, na=False
        )
        selected = df[mask].copy()
        if pval_col is not None and not selected.empty:
            selected = selected.sort_values(by=pval_col, ascending=True)
        notes_parts.append(f"filtered by symbol(s): {', '.join(proteins)}")
    elif modules and module_col is not None:
        mask = df[module_col].astype(str).str.lower().isin(modules)
        selected = df[mask].copy()
        if pval_col is not None and not selected.empty:
            selected = selected.sort_values(by=pval_col, ascending=True)
        notes_parts.append(f"filtered by module(s): {', '.join(modules)}")
    elif intent.intent_type == "significance_ranking":
        if pval_col is not None:
            selected = df.sort_values(by=pval_col, ascending=True).head(limit)
        else:
            selected = df.head(limit)
        notes_parts.append(f"top {len(selected)} by {pval_col or 'order'}")
    else:
        # Default: top hits by adj p-value (gives a far more useful snapshot
        # than alphabetical, which was the P0–P2 behavior).
        if pval_col is not None:
            selected = df.sort_values(by=pval_col, ascending=True).head(limit)
        else:
            selected = df.head(limit)
        notes_parts.append(f"top {len(selected)} by {pval_col or 'order'}")

    if selected is None or selected.empty:
        # Always show *something* — fall back to a small sample.
        sample = df.head(min(10, total))
        return [_build_chunk(
            record=record,
            title="Differential expression — no exact match",
            df=sample,
            rows_returned=len(sample),
            rows_total=total,
            citations=[{"file_path": record.rel_path, "run_id": index.run_id, "row_ids": []}],
            notes="no rows matched the query; showing first 10 for orientation",
        )]

    selected = selected.head(limit)
    citations = [{
        "file_path": record.rel_path,
        "run_id": index.run_id,
        "row_ids": _row_ids_for(df, gene_col, selected),
    }]
    return [_build_chunk(
        record=record,
        title="Differential expression",
        df=selected,
        rows_returned=len(selected),
        rows_total=total,
        citations=citations,
        notes="; ".join(notes_parts),
    )]


def retrieve_modules(
    index: ArtifactIndex,
    intent: QueryIntent,
    *,
    limit: int = DEFAULT_ROW_LIMIT,
) -> list[RetrievedChunk]:
    """Module membership + hub proteins.

    For ``module_query`` with a named module: return high-kME members of
    that module. For ``protein_lookup``: return the symbol's module
    assignment(s). For ``module_list``: return per-module size counts.
    """
    record = index.first("network.assignments")
    if record is None:
        return []
    df = _load_tabular(record)
    if df is None or df.empty:
        return []
    total = len(df)
    gene_col = _pick_column(df, ["gene", "feature_id", "peptide_id", "protein"])
    module_col = _pick_column(df, ["module_color", "module"])
    kme_col = _pick_column(df, ["kME", "kme", "kME_value"])
    if module_col is None:
        return []

    proteins = [p.upper() for p in intent.entities.get("proteins", [])]
    modules = [m.lower() for m in intent.entities.get("modules", [])]
    chunks: list[RetrievedChunk] = []

    if intent.intent_type == "module_list":
        sizes = df.groupby(module_col).size().reset_index(name="member_count")
        sizes = sizes.sort_values("member_count", ascending=False).head(limit)
        chunks.append(_build_chunk(
            record=record,
            title=f"Module sizes (total modules: {df[module_col].nunique()})",
            df=sizes,
            rows_returned=len(sizes),
            rows_total=df[module_col].nunique(),
            citations=[{"file_path": record.rel_path, "run_id": index.run_id, "row_ids": []}],
            notes="row count per module_color",
        ))
        return chunks

    if proteins and gene_col is not None:
        mask = df[gene_col].astype(str).str.upper().str.contains(
            "|".join(re.escape(p) for p in proteins), regex=True, na=False
        )
        sel = df[mask].copy()
        if not sel.empty:
            chunks.append(_build_chunk(
                record=record,
                title=f"Module assignments for {', '.join(proteins)}",
                df=sel.head(limit),
                rows_returned=min(len(sel), limit),
                rows_total=len(sel),
                citations=[{"file_path": record.rel_path, "run_id": index.run_id,
                            "row_ids": _row_ids_for(df, gene_col, sel.head(limit))}],
                notes=f"per-peptide/protein module + kME for {', '.join(proteins)}",
            ))

    if modules:
        # Multi-module comparison: when the user names ≥2 modules (e.g.
        # "turquoise vs black") we MUST return rows from each, not just
        # the first N overall (which gets dominated by the larger module).
        if len(modules) >= 2:
            per_module_cap = max(15, limit // len(modules))
            per_module_frames = []
            for mod in modules:
                m_mask = df[module_col].astype(str).str.lower() == mod
                m_sel = df[m_mask].copy()
                if kme_col is not None and not m_sel.empty:
                    m_sel = m_sel.sort_values(by=kme_col, ascending=False)
                per_module_frames.append(m_sel.head(per_module_cap))
            sel_combined = (
                per_module_frames[0]
                if len(per_module_frames) == 1
                else __import__("pandas").concat(per_module_frames, ignore_index=False)
            )
            if not sel_combined.empty:
                chunks.append(_build_chunk(
                    record=record,
                    title=f"Top members per module — comparison: {', '.join(modules)}",
                    df=sel_combined,
                    rows_returned=len(sel_combined),
                    rows_total=int(
                        df[module_col].astype(str).str.lower().isin(modules).sum()
                    ),
                    citations=[{"file_path": record.rel_path, "run_id": index.run_id,
                                "row_ids": _row_ids_for(df, gene_col, sel_combined)}],
                    notes=f"top {per_module_cap}/module by {kme_col} desc" if kme_col else f"top {per_module_cap}/module",
                ))
        else:
            mask = df[module_col].astype(str).str.lower().isin(modules)
            sel = df[mask].copy()
            if not sel.empty and kme_col is not None:
                sel = sel.sort_values(by=kme_col, ascending=False)
            sel = sel.head(limit)
            if not sel.empty:
                chunks.append(_build_chunk(
                    record=record,
                    title=f"Top members of module(s): {', '.join(modules)}",
                    df=sel,
                    rows_returned=len(sel),
                    rows_total=int(mask.sum()),
                    citations=[{"file_path": record.rel_path, "run_id": index.run_id,
                                "row_ids": _row_ids_for(df, gene_col, sel)}],
                    notes=f"sorted by {kme_col} desc" if kme_col else "first N matches",
                ))

    # If a dedicated hub-proteins file exists (e.g. WGCNA's All_Hub_Proteins
    # output), include it for any module-related question — its rows are
    # explicitly hub-tagged so it gives much better signal than module
    # assignments alone.
    for hub_rec in index.by_family("network.hub_proteins"):
        hub_df = _load_tabular(hub_rec)
        if hub_df is None or hub_df.empty:
            continue
        h_module_col = _pick_column(hub_df, ["module_color", "module"])
        h_gene_col = _pick_column(hub_df, ["gene", "feature_id", "peptide_id"])
        if modules and h_module_col is not None:
            h_mask = hub_df[h_module_col].astype(str).str.lower().isin(modules)
            h_sel = hub_df[h_mask].copy()
        else:
            h_sel = hub_df.copy()
        h_sel = h_sel.head(limit)
        if h_sel.empty:
            continue
        chunks.append(_build_chunk(
            record=hub_rec,
            title="Hub proteins (per-module hub list)",
            df=h_sel,
            rows_returned=len(h_sel),
            rows_total=len(hub_df),
            citations=[{"file_path": hub_rec.rel_path, "run_id": index.run_id,
                        "row_ids": _row_ids_for(hub_df, h_gene_col, h_sel)}],
            notes=("filtered to module(s): " + ", ".join(modules)) if modules else "all hubs",
        ))

    # Also include top-hub-proteins JSON if available — it's a curated summary.
    hubs = index.first("report.top_proteins")
    if hubs is not None:
        try:
            data = json.loads(Path(hubs.abs_path).read_text())
            text = "```json\n" + json.dumps(data, indent=2)[:CHUNK_MAX_CHARS] + "\n```"
            chunks.append(RetrievedChunk(
                family=hubs.family,
                rel_path=hubs.rel_path,
                title="Top / hub proteins summary",
                body=text,
                citations=[{"file_path": hubs.rel_path, "run_id": index.run_id, "row_ids": []}],
                rows_returned=0,
                rows_total=None,
                notes="pipeline-generated top-protein digest",
            ))
        except Exception as exc:
            log.debug("Could not include top_proteins.json: %s", exc)

    return chunks


def retrieve_module_trait(
    index: ArtifactIndex,
    intent: QueryIntent,
    *,
    limit: int = DEFAULT_ROW_LIMIT,
) -> list[RetrievedChunk]:
    record = index.first("network.module_trait")
    if record is None:
        return []
    df = _load_tabular(record)
    if df is None or df.empty:
        return []
    total = len(df)
    sel = df.head(limit)
    return [_build_chunk(
        record=record,
        title="Module–trait correlations",
        df=sel,
        rows_returned=len(sel),
        rows_total=total,
        citations=[{"file_path": record.rel_path, "run_id": index.run_id,
                    "row_ids": [int(i) for i in sel.index]}],
        notes="module × trait correlation + p-value matrix",
    )]


def retrieve_go(
    index: ArtifactIndex,
    intent: QueryIntent,
    *,
    limit: int = 30,
) -> list[RetrievedChunk]:
    record = index.first("go.enrichment")
    if record is None:
        return []
    df = _load_tabular(record)
    if df is None or df.empty:
        return []
    total = len(df)
    fdr_col = _pick_column(df, ["fdr", "adj_pvalue", "padj", "qvalue"])
    pval_col = _pick_column(df, ["pvalue"])
    module_col = _pick_column(df, ["module"])
    sort_col = fdr_col or pval_col

    modules = [m.lower() for m in intent.entities.get("modules", [])]
    chunks: list[RetrievedChunk] = []

    if modules and module_col is not None:
        mask = df[module_col].astype(str).str.lower().isin(modules)
        sel = df[mask].copy()
        if sort_col and not sel.empty:
            sel = sel.sort_values(by=sort_col, ascending=True)
        sel = sel.head(limit)
        chunks.append(_build_chunk(
            record=record,
            title=f"GO enrichment for module(s): {', '.join(modules)}",
            df=sel,
            rows_returned=len(sel),
            rows_total=int(mask.sum()),
            citations=[{"file_path": record.rel_path, "run_id": index.run_id,
                        "row_ids": [int(i) for i in sel.index]}],
            notes=f"sorted by {sort_col} asc" if sort_col else "first N rows",
        ))
        return chunks

    # No specific modules — top enriched terms across all modules.
    sig_col = fdr_col or pval_col
    if sig_col is not None:
        sel = df[df[sig_col].notna()].sort_values(by=sig_col, ascending=True).head(limit)
    else:
        sel = df.head(limit)
    chunks.append(_build_chunk(
        record=record,
        title="Top GO/pathway enrichment results",
        df=sel,
        rows_returned=len(sel),
        rows_total=total,
        citations=[{"file_path": record.rel_path, "run_id": index.run_id,
                    "row_ids": [int(i) for i in sel.index]}],
        notes=f"sorted by {sig_col} asc" if sig_col else "first N rows",
    ))
    return chunks


def retrieve_cell_type(
    index: ArtifactIndex,
    intent: QueryIntent,
    *,
    limit: int = DEFAULT_ROW_LIMIT,
) -> list[RetrievedChunk]:
    record = index.first("cells.matrix")
    if record is None:
        return []
    df = _load_tabular(record)
    if df is None or df.empty:
        return []
    total = len(df)
    cell_col = _pick_column(df, ["cell_type", "celltype", "cell"])
    fdr_col = _pick_column(df, ["fdr", "adj_pvalue", "padj"])
    pval_col = _pick_column(df, ["pvalue"])
    module_col = _pick_column(df, ["module"])
    sort_col = fdr_col or pval_col

    cells = [c.lower() for c in intent.entities.get("cell_types", [])]
    chunks: list[RetrievedChunk] = []

    sel = df.copy()
    notes_parts: list[str] = []
    if cells and cell_col is not None:
        mask = sel[cell_col].astype(str).str.lower().str.contains(
            "|".join(re.escape(c) for c in cells), regex=True, na=False
        )
        sel = sel[mask]
        notes_parts.append(f"filtered to cell types: {', '.join(cells)}")
    if sort_col:
        sel = sel.sort_values(by=sort_col, ascending=True)
        notes_parts.append(f"sorted by {sort_col} asc")
    sel = sel.head(limit)
    if sel.empty:
        sel = df.head(20)
        notes_parts.append("no rows matched; showing first 20 for orientation")
    chunks.append(_build_chunk(
        record=record,
        title="Cell-type enrichment (module × cell type)",
        df=sel,
        rows_returned=len(sel),
        rows_total=total,
        citations=[{"file_path": record.rel_path, "run_id": index.run_id,
                    "row_ids": [int(i) for i in sel.index]}],
        notes="; ".join(notes_parts),
    ))
    return chunks


def retrieve_manifest(index: ArtifactIndex, intent: QueryIntent) -> list[RetrievedChunk]:
    record = index.first("report.manifest")
    if record is None:
        return []
    try:
        data = json.loads(Path(record.abs_path).read_text())
    except Exception as exc:
        log.debug("Could not load manifest: %s", exc)
        return []
    pretty = json.dumps(data, indent=2)
    if len(pretty) > CHUNK_MAX_CHARS:
        pretty = pretty[:CHUNK_MAX_CHARS] + "\n…(truncated)"
    return [RetrievedChunk(
        family=record.family,
        rel_path=record.rel_path,
        title="Run manifest",
        body=f"```json\n{pretty}\n```",
        citations=[{"file_path": record.rel_path, "run_id": index.run_id, "row_ids": []}],
        notes="full run manifest",
    )]


# ---------------------------------------------------------------------------
# Cross-modal joiner
# ---------------------------------------------------------------------------

def retrieve_cross_modal(
    index: ArtifactIndex,
    intent: QueryIntent,
    *,
    limit: int = 40,
) -> list[RetrievedChunk]:
    """The flagship cross-modal retriever — e.g., "GO terms enriched in
    modules over-represented in microglia". Identifies the modules from one
    file, then filters the other file by those modules."""
    cells = [c.lower() for c in intent.entities.get("cell_types", [])]
    chunks: list[RetrievedChunk] = []

    # If the question mentions cell types AND we have a cells matrix → find
    # modules significantly associated with those cell types, then fetch GO
    # rows restricted to those modules.
    if cells:
        cell_rec = index.first("cells.matrix")
        if cell_rec is not None:
            df = _load_tabular(cell_rec)
            if df is not None and not df.empty:
                cell_col = _pick_column(df, ["cell_type", "celltype"])
                module_col = _pick_column(df, ["module"])
                fdr_col = _pick_column(df, ["fdr", "adj_pvalue", "padj"]) or _pick_column(df, ["pvalue"])
                if cell_col and module_col and fdr_col:
                    mask = df[cell_col].astype(str).str.lower().str.contains(
                        "|".join(re.escape(c) for c in cells), regex=True, na=False
                    )
                    matched = df[mask & (df[fdr_col].astype(float) < 0.05)]
                    enriched_modules = sorted(set(matched[module_col].astype(str).str.lower()))
                    if enriched_modules:
                        # Step 1 chunk: which modules
                        sel = matched.sort_values(by=fdr_col, ascending=True).head(limit)
                        chunks.append(_build_chunk(
                            record=cell_rec,
                            title=f"Modules significantly enriched in {', '.join(cells)} (FDR<0.05)",
                            df=sel,
                            rows_returned=len(sel),
                            rows_total=len(matched),
                            citations=[{"file_path": cell_rec.rel_path, "run_id": index.run_id,
                                        "row_ids": [int(i) for i in sel.index]}],
                            notes="step 1 of cross-modal join",
                        ))
                        # Step 2: GO enrichment restricted to those modules
                        go_rec = index.first("go.enrichment")
                        if go_rec is not None:
                            go_df = _load_tabular(go_rec)
                            if go_df is not None and not go_df.empty:
                                go_mod_col = _pick_column(go_df, ["module"])
                                go_sig = _pick_column(go_df, ["fdr", "adj_pvalue", "padj"]) or _pick_column(go_df, ["pvalue"])
                                if go_mod_col:
                                    g_mask = go_df[go_mod_col].astype(str).str.lower().isin(enriched_modules)
                                    g_sel = go_df[g_mask].copy()
                                    if go_sig:
                                        g_sel = g_sel.sort_values(by=go_sig, ascending=True)
                                    g_sel = g_sel.head(limit)
                                    chunks.append(_build_chunk(
                                        record=go_rec,
                                        title=f"GO enrichment for the {', '.join(cells)}-enriched modules",
                                        df=g_sel,
                                        rows_returned=len(g_sel),
                                        rows_total=int(g_mask.sum()),
                                        citations=[{"file_path": go_rec.rel_path, "run_id": index.run_id,
                                                    "row_ids": [int(i) for i in g_sel.index]}],
                                        notes=f"step 2 — restricted to modules: {', '.join(enriched_modules[:6])}",
                                    ))
    return chunks


# ---------------------------------------------------------------------------
# Top-level dispatcher
# ---------------------------------------------------------------------------

# Map intent → which family-retrievers to fire. Order matters: results are
# concatenated in order, so put the most-likely-relevant first.
_INTENT_DISPATCH = {
    "protein_lookup":         (retrieve_volcano, retrieve_modules),
    "significance_ranking":   (retrieve_volcano,),
    "module_query":           (retrieve_modules, retrieve_volcano),
    "module_list":            (retrieve_modules,),
    "go_enrichment":          (retrieve_go, retrieve_modules),
    "cell_type":              (retrieve_cell_type, retrieve_modules),
    "trait_correlation":      (retrieve_module_trait, retrieve_modules),
    "cross_modal":            (retrieve_cross_modal, retrieve_go, retrieve_cell_type, retrieve_modules),
    "summary":                (retrieve_manifest, retrieve_volcano),
    "comparison":             (retrieve_manifest, retrieve_volcano),
    "metadata":               (retrieve_manifest,),
    "open_ended":             (retrieve_manifest, retrieve_volcano),
}


def retrieve(
    index: ArtifactIndex,
    intent: QueryIntent,
    *,
    token_budget: int = 50_000,
    rerank_chunks: bool = True,
) -> list[RetrievedChunk]:
    """Run the retrievers for this intent and return chunks, budget-bounded.

    Token budget is enforced as an approximate character budget (~4 chars/token)
    so we don't blow up the prompt with mega-tables.

    Wave 3: all candidate chunks are gathered first, then reranked by relevance
    to the intent, and only then is the budget applied — so the budget cut keeps
    the *most relevant* chunks rather than whatever happened to come first in
    dispatch order. Set ``rerank_chunks=False`` to preserve raw dispatch order.
    """
    fns = _INTENT_DISPATCH.get(intent.intent_type, _INTENT_DISPATCH["open_ended"])

    # 1. Gather all candidate chunks (dedup by path), ignoring budget for now.
    candidates: list[RetrievedChunk] = []
    seen_paths: set[str] = set()
    for fn in fns:
        try:
            new_chunks = fn(index, intent)
        except Exception as exc:  # pragma: no cover — retrieval shouldn't crash chat
            log.exception("retriever %s failed: %s", fn.__name__, exc)
            continue
        for c in new_chunks:
            if c.rel_path in seen_paths:
                continue
            candidates.append(c)
            seen_paths.add(c.rel_path)

    # 2. Rerank by relevance so the budget cut keeps the best chunks.
    if rerank_chunks and len(candidates) > 1:
        from .reranker import rerank as _rerank
        candidates = _rerank(candidates, intent)

    # 3. Apply the character budget in (reranked) order.
    chunks: list[RetrievedChunk] = []
    char_budget = token_budget * 4
    used = 0
    for c in candidates:
        size = len(c.body) + len(c.title) + 100
        if used + size > char_budget and chunks:
            # Stop once budget is exhausted (but always return ≥1 chunk).
            break
        chunks.append(c)
        used += size
    return chunks
