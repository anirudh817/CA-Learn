"""Agentic tool registry for the chat — P4 wave 2.

The model can call these tools mid-answer to fetch run data that wasn't
pre-loaded by structured retrieval. The chat layer enforces every safety
invariant the model itself can't be trusted with:

  - **Path safety.** Every tool argument that references a file is resolved
    against the conversation's run directory and rejected if it escapes
    (``../`` traversal, absolute paths, symlink escapes).
  - **Size caps.** Read tools return at most ``MAX_ROWS`` rows and
    ``MAX_RESULT_CHARS`` characters. Bigger files are sampled, not dumped.
  - **Timeouts.** Each tool has ``DEFAULT_TIMEOUT_S``. A hung call cannot
    block the answer stream.
  - **Schema-aware.** Tools share the same column-pick logic the structured
    retrievers use so they behave consistently across pipeline variants.
  - **Iteration-capped at the caller.** Tools themselves don't loop;
    ``_stream_assistant_turn`` enforces ``MAX_TOOL_ITERATIONS`` per turn.

Tool schemas use JSON-Schema (Anthropic's preferred format). Each ``Tool``
dict is forwarded to ``provider.stream(tools=...)`` and the model decides
when to call.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from .artifact_index import ArtifactIndex, get_index
from .context_builder import dataframe_to_markdown

log = logging.getLogger(__name__)


MAX_ROWS = 200
MAX_RESULT_CHARS = 20_000
DEFAULT_TIMEOUT_S = 5.0


# ---------------------------------------------------------------------------
# Schemas — exact shape Anthropic expects in `tools=[...]`
# ---------------------------------------------------------------------------

TOOL_SCHEMAS = [
    {
        "name": "list_files",
        "description": (
            "List every file available for this run with its family classification, "
            "column names, and row count. Use this FIRST when you don't know which "
            "file holds the data you need. Cheap — call freely."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "read_file_slice",
        "description": (
            "Read up to N rows from a specific file in the current run. Use this "
            "when you know the file's relative path (from list_files) and want to "
            "see its contents. Supports an optional case-insensitive substring "
            "filter applied to ANY column. Returns a markdown table plus the row "
            "count. Files outside this run are blocked for safety."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "rel_path": {
                    "type": "string",
                    "description": "Relative path within the run, e.g. 'stage1/volcano_results.tsv'. Must be a file the run actually produced (see list_files).",
                },
                "filter": {
                    "type": "string",
                    "description": "Optional case-insensitive substring filter. A row is kept if ANY of its column values contains this substring. Example: 'APOE' returns all rows mentioning APOE.",
                },
                "max_rows": {
                    "type": "integer",
                    "description": f"Max rows to return (default 80, hard cap {MAX_ROWS}).",
                    "default": 80,
                },
                "sort_by": {
                    "type": "string",
                    "description": "Optional column name to sort by (ascending).",
                },
            },
            "required": ["rel_path"],
        },
    },
    {
        "name": "lookup_protein",
        "description": (
            "High-level shortcut: given a protein/gene symbol, return its rows from "
            "the differential expression file AND the module assignments file in "
            "one call. Use this for any 'tell me about <SYMBOL>' question instead "
            "of two separate read_file_slice calls."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "symbol": {
                    "type": "string",
                    "description": "Gene/protein symbol, e.g. 'APOE', 'CLU'. Case-insensitive.",
                },
            },
            "required": ["symbol"],
        },
    },
    {
        "name": "lookup_module",
        "description": (
            "High-level shortcut for module questions: given a WGCNA module name "
            "(e.g. 'turquoise', 'M3'), return its top members by kME, its trait "
            "correlations, and its enriched GO terms — all in one call. Use this "
            "for 'tell me about module X' questions."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "module": {
                    "type": "string",
                    "description": "WGCNA module name. Case-insensitive.",
                },
                "max_rows_per_section": {
                    "type": "integer",
                    "description": "Max rows per sub-section (members / corrs / GO). Default 40.",
                    "default": 40,
                },
            },
            "required": ["module"],
        },
    },
]


# ---------------------------------------------------------------------------
# Result shape
# ---------------------------------------------------------------------------

@dataclass
class ToolExecutionResult:
    name: str
    content: str
    is_error: bool = False
    latency_ms: int = 0
    rows_returned: int = 0
    cited_files: list[str] = field(default_factory=list)
    error_kind: Optional[str] = None     # "path_blocked" | "not_found" | "timeout" | "exec_error"

    def to_audit_dict(self) -> dict:
        return {
            "name": self.name,
            "is_error": self.is_error,
            "latency_ms": self.latency_ms,
            "rows_returned": self.rows_returned,
            "cited_files": self.cited_files,
            "error_kind": self.error_kind,
        }


# ---------------------------------------------------------------------------
# Safety: path resolution
# ---------------------------------------------------------------------------

def _safe_resolve(rel_path: str, run_dir: Path) -> Optional[Path]:
    """Resolve ``rel_path`` relative to ``run_dir`` and verify the result is
    still inside ``run_dir``. Returns None on any traversal/escape."""
    if not rel_path:
        return None
    # Normalize: strip leading slashes, reject absolute paths up front.
    if rel_path.startswith("/") or rel_path.startswith("\\"):
        return None
    if "\x00" in rel_path:
        return None
    try:
        candidate = (run_dir / rel_path).resolve()
        run_dir_resolved = run_dir.resolve()
    except (OSError, RuntimeError):
        return None
    try:
        candidate.relative_to(run_dir_resolved)
    except ValueError:
        return None
    return candidate


def _trim(text: str, limit: int = MAX_RESULT_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "\n\n[…truncated to fit tool result cap]"


# Internal-methodology files that live inside a run directory but encode HOW
# the pipeline works (stage parameters, R/Python source, run logs). These are
# inside the path-safe boundary yet must never be surfaced to the chat model —
# they are the exact IP the confidentiality layer exists to protect. Blocked
# regardless of how they're reached (read_file_slice OR a pinned @-mention).
_INTERNAL_SUFFIXES = {".r", ".py", ".sh", ".rds", ".pyc", ".log", ".ipynb", ".pkl"}


def _is_internal_artifact(path: Path) -> bool:
    name = path.name.lower()
    if path.suffix.lower() in _INTERNAL_SUFFIXES:
        return True
    if name == "config.json" or name.startswith("config_stage"):
        return True
    if name == "stats_control_audit.json":
        return True
    if "parity" in name:
        return True
    if name.startswith("."):
        return True
    return False


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

async def _tool_list_files(args: dict, *, index: ArtifactIndex, run_dir: Path) -> ToolExecutionResult:
    body = index.table_of_contents(max_files=80)
    if not index.records:
        body = "_(no files indexed for this run)_"
    return ToolExecutionResult(
        name="list_files",
        content=_trim(body),
        rows_returned=len(index.records),
        cited_files=[r.rel_path for r in index.records[:10]],
    )


def _filter_dataframe(df, substring: Optional[str]):
    if not substring:
        return df
    needle = substring.lower()
    cols = [c for c in df.columns]
    mask = None
    for c in cols:
        try:
            col_mask = df[c].astype(str).str.lower().str.contains(re.escape(needle), na=False, regex=True)
        except Exception:
            continue
        mask = col_mask if mask is None else (mask | col_mask)
    return df[mask] if mask is not None else df


async def _tool_read_file_slice(
    args: dict,
    *,
    index: ArtifactIndex,
    run_dir: Path,
) -> ToolExecutionResult:
    rel_path = str(args.get("rel_path") or "").strip()
    filt = args.get("filter")
    sort_by = args.get("sort_by")
    requested_max = int(args.get("max_rows") or 80)
    max_rows = max(1, min(requested_max, MAX_ROWS))

    safe_path = _safe_resolve(rel_path, run_dir)
    if safe_path is None:
        return ToolExecutionResult(
            name="read_file_slice",
            content=(
                f"[blocked] '{rel_path}' is not a valid path for this run. "
                "Use list_files to see available files."
            ),
            is_error=True,
            error_kind="path_blocked",
        )
    if not safe_path.exists():
        return ToolExecutionResult(
            name="read_file_slice",
            content=f"[not found] No file at '{rel_path}'. Use list_files for the actual file list.",
            is_error=True,
            error_kind="not_found",
        )
    if _is_internal_artifact(safe_path):
        return ToolExecutionResult(
            name="read_file_slice",
            content=(
                f"[blocked] '{rel_path}' is an internal pipeline file and is not "
                "available. Use list_files to see the run's result data files."
            ),
            is_error=True,
            error_kind="path_blocked",
        )

    suffix = safe_path.suffix.lower()
    from .tabular import read_table

    # .csv/.tsv/.tab are always tables. A .txt may be a table (e.g. a tab- or
    # whitespace-delimited GO-FET export) OR prose (a summary): parse it as a
    # table only when it's genuinely multi-column, otherwise fall through to
    # raw-text handling below.
    df = None
    if suffix in {".csv", ".tsv", ".tab"}:
        df = read_table(safe_path)
        if df is None:
            return ToolExecutionResult(
                name="read_file_slice",
                content=f"[parse error] Could not read '{rel_path}' as a table.",
                is_error=True,
                error_kind="exec_error",
            )
    elif suffix == ".txt":
        cand = read_table(safe_path)
        if cand is not None and cand.shape[1] >= 2:
            df = cand

    if df is not None:
        total_rows = len(df)
        if filt:
            df = _filter_dataframe(df, str(filt))
        if sort_by and sort_by in df.columns:
            try:
                df = df.sort_values(by=sort_by, ascending=True)
            except Exception:
                pass
        snippet = df.head(max_rows)
        body = (
            f"**{rel_path}** — showing {len(snippet)} of {total_rows} total rows"
            + (f" (filtered by '{filt}')" if filt else "")
            + (f", sorted by `{sort_by}`" if sort_by and sort_by in df.columns else "")
            + "\n\n"
            + dataframe_to_markdown(snippet)
        )
        return ToolExecutionResult(
            name="read_file_slice",
            content=_trim(body),
            rows_returned=len(snippet),
            cited_files=[rel_path],
        )

    if suffix == ".json":
        try:
            data = json.loads(safe_path.read_text())
        except Exception as exc:
            return ToolExecutionResult(
                name="read_file_slice",
                content=f"[parse error] {rel_path}: {exc}",
                is_error=True,
                error_kind="exec_error",
            )
        body = f"**{rel_path}** (JSON):\n\n```json\n{json.dumps(data, indent=2)}\n```"
        return ToolExecutionResult(
            name="read_file_slice",
            content=_trim(body),
            rows_returned=0,
            cited_files=[rel_path],
        )

    # Plain text / unknown: read first chunk as text.
    try:
        text = safe_path.read_text(errors="replace")
    except Exception as exc:
        return ToolExecutionResult(
            name="read_file_slice",
            content=f"[read error] {rel_path}: {exc}",
            is_error=True,
            error_kind="exec_error",
        )
    body = f"**{rel_path}** (raw text, first 20K chars):\n\n```\n{text[:MAX_RESULT_CHARS]}\n```"
    return ToolExecutionResult(
        name="read_file_slice",
        content=_trim(body),
        cited_files=[rel_path],
    )


async def _tool_lookup_protein(args: dict, *, index: ArtifactIndex, run_dir: Path) -> ToolExecutionResult:
    symbol = str(args.get("symbol") or "").strip()
    if not symbol:
        return ToolExecutionResult(
            name="lookup_protein",
            content="[error] symbol is required",
            is_error=True,
            error_kind="exec_error",
        )

    import pandas as pd
    from .tabular import read_table

    parts: list[str] = [f"# Lookup: **{symbol.upper()}**"]
    cited: list[str] = []
    rows_total = 0

    # DE rows
    de = index.first("volcano.results")
    if de is not None:
        suffix = Path(de.abs_path).suffix.lower()
        try:
            df = read_table(de.abs_path)
            gene_col = next(
                (c for c in df.columns if c.lower() in ("gene", "protein", "feature_id", "peptide_id")),
                None,
            )
            if gene_col:
                mask = df[gene_col].astype(str).str.upper().str.contains(re.escape(symbol.upper()), na=False, regex=True)
                sel = df[mask]
                pval_col = next((c for c in df.columns if c.lower() in ("adj_pvalue", "padj", "fdr", "qvalue", "pvalue")), None)
                if pval_col and not sel.empty:
                    sel = sel.sort_values(by=pval_col, ascending=True)
                sel = sel.head(50)
                if not sel.empty:
                    rows_total += len(sel)
                    parts.append(f"\n## Differential expression — `{de.rel_path}`\n")
                    parts.append(dataframe_to_markdown(sel))
                    cited.append(de.rel_path)
        except Exception as exc:
            log.debug("lookup_protein DE read failed: %s", exc)

    # Module assignments
    mod = index.first("network.assignments")
    if mod is not None:
        try:
            df = read_table(mod.abs_path)
            gene_col = next(
                (c for c in df.columns if c.lower() in ("gene", "feature_id", "peptide_id", "protein")),
                None,
            )
            if gene_col:
                mask = df[gene_col].astype(str).str.upper().str.contains(re.escape(symbol.upper()), na=False, regex=True)
                sel = df[mask].head(50)
                if not sel.empty:
                    rows_total += len(sel)
                    parts.append(f"\n## Module assignments — `{mod.rel_path}`\n")
                    parts.append(dataframe_to_markdown(sel))
                    cited.append(mod.rel_path)
        except Exception as exc:
            log.debug("lookup_protein module read failed: %s", exc)

    if rows_total == 0:
        parts.append(f"\n_(no rows found for {symbol!r} in this run's DE or module files)_")

    return ToolExecutionResult(
        name="lookup_protein",
        content=_trim("\n".join(parts)),
        rows_returned=rows_total,
        cited_files=cited,
    )


async def _tool_lookup_module(args: dict, *, index: ArtifactIndex, run_dir: Path) -> ToolExecutionResult:
    module = str(args.get("module") or "").strip().lower()
    if not module:
        return ToolExecutionResult(
            name="lookup_module",
            content="[error] module is required",
            is_error=True,
            error_kind="exec_error",
        )
    per_section = max(5, min(int(args.get("max_rows_per_section") or 40), MAX_ROWS))

    import pandas as pd
    from .tabular import read_table

    parts: list[str] = [f"# Lookup: module **{module}**"]
    cited: list[str] = []
    rows_total = 0

    # Top members (sorted by kME desc)
    mod = index.first("network.assignments")
    if mod is not None:
        try:
            df = read_table(mod.abs_path)
            mod_col = next((c for c in df.columns if c.lower() in ("module_color", "module")), None)
            kme_col = next((c for c in df.columns if c.lower() in ("kme", "kme_value")), None)
            if mod_col:
                sel = df[df[mod_col].astype(str).str.lower() == module]
                if kme_col and not sel.empty:
                    sel = sel.sort_values(by=kme_col, ascending=False)
                sel = sel.head(per_section)
                if not sel.empty:
                    rows_total += len(sel)
                    parts.append(f"\n## Top members of `{module}` — `{mod.rel_path}`\n")
                    parts.append(dataframe_to_markdown(sel))
                    cited.append(mod.rel_path)
        except Exception as exc:
            log.debug("lookup_module assignments read failed: %s", exc)

    # Module-trait correlations (if any)
    mt = index.first("network.module_trait")
    if mt is not None:
        try:
            df = read_table(mt.abs_path)
            mod_col = next((c for c in df.columns if c.lower() in ("module_color", "module")), None)
            if mod_col:
                sel = df[df[mod_col].astype(str).str.lower() == module]
                if not sel.empty:
                    rows_total += len(sel)
                    parts.append(f"\n## Module-trait correlations for `{module}` — `{mt.rel_path}`\n")
                    parts.append(dataframe_to_markdown(sel))
                    cited.append(mt.rel_path)
        except Exception as exc:
            log.debug("lookup_module module_trait read failed: %s", exc)

    # GO enrichment for this module
    go = index.first("go.enrichment")
    if go is not None:
        try:
            df = read_table(go.abs_path)
            mod_col = next((c for c in df.columns if c.lower() == "module"), None)
            sort_col = next((c for c in df.columns if c.lower() in ("fdr", "adj_pvalue", "padj", "pvalue")), None)
            if mod_col:
                sel = df[df[mod_col].astype(str).str.lower() == module]
                if sort_col and not sel.empty:
                    sel = sel.sort_values(by=sort_col, ascending=True)
                sel = sel.head(per_section)
                if not sel.empty:
                    rows_total += len(sel)
                    parts.append(f"\n## GO enrichment for `{module}` — `{go.rel_path}`\n")
                    parts.append(dataframe_to_markdown(sel))
                    cited.append(go.rel_path)
        except Exception as exc:
            log.debug("lookup_module GO read failed: %s", exc)

    if rows_total == 0:
        parts.append(f"\n_(no rows found for module {module!r} in this run's WGCNA / module-trait / GO files)_")

    return ToolExecutionResult(
        name="lookup_module",
        content=_trim("\n".join(parts)),
        rows_returned=rows_total,
        cited_files=cited,
    )


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

_TOOLS = {
    "list_files":       _tool_list_files,
    "read_file_slice":  _tool_read_file_slice,
    "lookup_protein":   _tool_lookup_protein,
    "lookup_module":    _tool_lookup_module,
}


async def dispatch(
    *,
    name: str,
    args: dict,
    run_id: str,
    runs_dir: Path,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> ToolExecutionResult:
    """Single entry point — picks the tool, builds the index, runs with timeout.

    Returns a ``ToolExecutionResult`` even on failure (timeout, missing tool,
    raised exception). Never raises — the streaming generator must keep
    flowing whatever happens.
    """
    import time

    start = time.monotonic()
    fn = _TOOLS.get(name)
    if fn is None:
        return ToolExecutionResult(
            name=name,
            content=f"[unknown tool] '{name}' is not a registered tool. Available: {', '.join(_TOOLS)}",
            is_error=True,
            error_kind="exec_error",
            latency_ms=int((time.monotonic() - start) * 1000),
        )
    run_dir = runs_dir / run_id
    if not run_dir.exists():
        return ToolExecutionResult(
            name=name,
            content=f"[no run] Run directory for '{run_id}' not found on disk.",
            is_error=True,
            error_kind="not_found",
            latency_ms=int((time.monotonic() - start) * 1000),
        )
    index = get_index(run_id, runs_dir)
    try:
        result = await asyncio.wait_for(
            fn(args or {}, index=index, run_dir=run_dir),
            timeout=timeout_s,
        )
    except asyncio.TimeoutError:
        return ToolExecutionResult(
            name=name,
            content=f"[timeout] Tool '{name}' exceeded {timeout_s}s. Try a smaller request.",
            is_error=True,
            error_kind="timeout",
            latency_ms=int((time.monotonic() - start) * 1000),
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("Tool dispatch failed: %s", name)
        return ToolExecutionResult(
            name=name,
            content=f"[tool error] {name} raised: {exc}",
            is_error=True,
            error_kind="exec_error",
            latency_ms=int((time.monotonic() - start) * 1000),
        )
    result.latency_ms = int((time.monotonic() - start) * 1000)
    return result
