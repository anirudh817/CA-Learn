from __future__ import annotations

"""
Results route — read actual CSV outputs and return structured data for Plotly charts.
"""
import json
import math
import posixpath
import re
from datetime import datetime
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Any, Optional
from urllib.parse import quote, urlsplit, urlunsplit

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from sqlalchemy.orm import Session

from config import RUNS_DIR
from database import Run, User, get_db
from deps import get_current_user, require_workspace_access
from services.artifacts import ARTIFACT_TABS, decode_artifact_id, load_artifact_index
from utils import (
    guess_media_type,
    is_manifest_viewable_file,
    is_supporting_asset_file,
    resolve_relative_path,
)

router = APIRouter()
HTML_URL_RE = re.compile(r'(?P<prefix>\b(?:src|href)=["\'])(?P<url>[^"\']+)(?P<suffix>["\'])', flags=re.IGNORECASE)
CSS_URL_RE = re.compile(r'url\((?P<quote>["\']?)(?P<url>[^)"\']+)(?P=quote)\)', flags=re.IGNORECASE)


@lru_cache(maxsize=1)
def _pd():
    import pandas as pd

    return pd


def _safe_json(obj: Any) -> Any:
    """Recursively convert numpy types and non-finite floats to JSON-safe Python types."""
    if isinstance(obj, dict):
        return {k: _safe_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_safe_json(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        f = float(obj)
        return None if (math.isnan(f) or math.isinf(f)) else f
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    return obj


def _check_run(run_id: str, db: Session, current_user: User) -> Run:
    run = db.query(Run).filter(Run.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    require_workspace_access(db, current_user.id, run.workspace_id)
    return run


def _status_value(value: Any) -> Any:
    return value.value if hasattr(value, "value") else value


def _scan_native_artifacts(run_id: str) -> dict[str, Any]:
    run_dir = RUNS_DIR / run_id
    return load_artifact_index(run_id, run_dir)


def _find_artifact(run_id: str, artifact_id: str) -> tuple[dict[str, Any], str]:
    index = _scan_native_artifacts(run_id)
    for item in index.get("artifacts", []):
        if item.get("artifact_id") == artifact_id:
            return item, item["rel_path"]
    rel_path = decode_artifact_id(artifact_id)
    for item in index.get("artifacts", []):
        if item.get("rel_path") == rel_path:
            return item, rel_path
    raise HTTPException(status_code=404, detail="Artifact not found")


def _rewrite_asset_url(raw_url: str, run_id: str, html_rel_path: str, session_token: Optional[str]) -> str:
    parts = urlsplit(raw_url)
    if parts.scheme or parts.netloc or raw_url.startswith("/") or raw_url.startswith("#") or raw_url.startswith("data:"):
        return raw_url
    parent = posixpath.dirname(html_rel_path)
    normalized_path = posixpath.normpath(posixpath.join(parent, parts.path))
    # Reject paths that escape the run directory after normalization
    if ".." in PurePosixPath(normalized_path).parts:
        return raw_url
    candidate_path = RUNS_DIR / run_id / normalized_path
    if not candidate_path.exists():
        root_fallback = posixpath.basename(parts.path)
        root_path = RUNS_DIR / run_id / root_fallback
        if root_fallback and root_path.exists():
            normalized_path = root_fallback
    rewritten_path = f"/api/results/{quote(run_id)}/artifacts/file/{quote(normalized_path, safe='/')}"
    query_parts = []
    if parts.query:
        query_parts.append(parts.query)
    if session_token:
        query_parts.append(f"session_token={quote(session_token)}")
    return urlunsplit(("", "", rewritten_path, "&".join(query_parts), parts.fragment))


def _rewrite_html_assets(html: str, run_id: str, html_rel_path: str, session_token: Optional[str]) -> str:
    def replace_link(match) -> str:
        url = match.group("url")
        rewritten = _rewrite_asset_url(url, run_id, html_rel_path, session_token)
        return f'{match.group("prefix")}{rewritten}{match.group("suffix")}'

    def replace_css(match) -> str:
        url = match.group("url")
        return f'url("{_rewrite_asset_url(url, run_id, html_rel_path, session_token)}")'

    html = HTML_URL_RE.sub(replace_link, html)
    return CSS_URL_RE.sub(replace_css, html)


def _serve_artifact_path(run_id: str, file_path: str, download: bool, session_token: Optional[str]):
    if not (is_manifest_viewable_file(file_path) or is_supporting_asset_file(file_path)):
        raise HTTPException(status_code=404, detail="Artifact not available")
    try:
        full_path = resolve_relative_path(RUNS_DIR / run_id, file_path)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    if not full_path.exists() or not full_path.is_file():
        raise HTTPException(status_code=404, detail="Artifact not found")

    media_type = guess_media_type(full_path)
    if full_path.suffix.lower() in {".html", ".htm"} and not download:
        html = full_path.read_text(encoding="utf-8", errors="ignore")
        return HTMLResponse(_rewrite_html_assets(html, run_id, file_path, session_token))

    if download:
        return FileResponse(str(full_path), media_type=media_type, filename=full_path.name)
    return FileResponse(str(full_path), media_type=media_type)


def _json_table_rows(value: Any) -> pd.DataFrame:
    pd = _pd()
    if isinstance(value, list):
        if value and all(isinstance(item, dict) for item in value):
            return pd.DataFrame(value)
        return pd.DataFrame({"value": value})
    if isinstance(value, dict):
        rows = []
        for key, raw in value.items():
            if isinstance(raw, (dict, list)):
                rows.append({"key": key, "value": json.dumps(raw)})
            else:
                rows.append({"key": key, "value": raw})
        return pd.DataFrame(rows)
    return pd.DataFrame({"value": [value]})


def _read_table_artifact(path: Path) -> pd.DataFrame:
    pd = _pd()
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(path, low_memory=False)
    if suffix == ".tsv":
        return pd.read_csv(path, sep="\t", low_memory=False)
    if suffix == ".json":
        return _json_table_rows(json.loads(path.read_text()))
    if suffix in {".txt", ".md"}:
        raw = path.read_text(encoding="utf-8", errors="ignore").splitlines()
        if not raw:
            return pd.DataFrame(columns=["line_number", "text"])
        candidate = raw[: min(12, len(raw))]
        if sum("\t" in line for line in candidate) >= max(1, len(candidate) // 2):
            return pd.read_csv(path, sep="\t", low_memory=False)
        if sum("," in line for line in candidate) >= max(1, len(candidate) // 2):
            return pd.read_csv(path, low_memory=False)
        return pd.DataFrame({"line_number": list(range(1, len(raw) + 1)), "text": raw})
    raise HTTPException(status_code=400, detail="Artifact is not table-viewable")


def _table_query(df: pd.DataFrame, search: Optional[str], filters: Optional[str], sort_column: Optional[str], sort_direction: str, page: int, page_size: int) -> dict[str, Any]:
    pd = _pd()
    working = df.copy()
    working.columns = [str(column) for column in working.columns]

    if search:
        needle = str(search).lower()
        mask = working.astype(str).apply(lambda column: column.str.lower().str.contains(needle, na=False, regex=False))
        working = working[mask.any(axis=1)]

    parsed_filters: dict[str, str] = {}
    if filters:
        try:
            parsed_filters = json.loads(filters)
        except Exception as error:
            raise HTTPException(status_code=400, detail=f"Invalid filters JSON: {error}") from error
        for column, value in parsed_filters.items():
            if column in working.columns and str(value).strip():
                value_str = str(value).strip()
                numeric_match = re.match(r"^(<=|>=|=|<|>)(-?\d+(?:\.\d+)?)$", value_str)
                if numeric_match and pd.api.types.is_numeric_dtype(working[column]):
                    operator, raw_value = numeric_match.groups()
                    threshold = float(raw_value)
                    if operator == "<":
                        working = working[working[column] < threshold]
                    elif operator == "<=":
                        working = working[working[column] <= threshold]
                    elif operator == ">":
                        working = working[working[column] > threshold]
                    elif operator == ">=":
                        working = working[working[column] >= threshold]
                    else:
                        working = working[working[column] == threshold]
                else:
                    working = working[working[column].astype(str).str.contains(value_str, case=False, na=False, regex=False)]

    valid_sort_directions = {"asc", "desc"}
    sort_direction_safe = str(sort_direction or "asc").lower()
    if sort_direction_safe not in valid_sort_directions:
        sort_direction_safe = "asc"
    if sort_column and sort_column in working.columns:
        ascending = sort_direction_safe != "desc"
        working = working.sort_values(sort_column, ascending=ascending, na_position="last")

    total_rows = int(len(working))
    page_size = max(1, min(int(page_size or 50), 250))
    page = max(1, int(page or 1))
    start = (page - 1) * page_size
    end = start + page_size
    paged = working.iloc[start:end].replace({np.nan: None})
    columns = [
        {
            "name": column,
            "type": "number" if pd.api.types.is_numeric_dtype(working[column]) else "text",
        }
        for column in working.columns
    ]
    return {
        "columns": columns,
        "rows": _safe_json(paged.to_dict(orient="records")),
        "page": page,
        "page_size": page_size,
        "total_rows": total_rows,
        "total_pages": max(1, math.ceil(total_rows / page_size)) if total_rows else 1,
        "filters": parsed_filters,
    }


@router.get("/results/{run_id}/artifacts")
def get_native_artifacts(run_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _check_run(run_id, db, current_user)
    return JSONResponse(_safe_json(_scan_native_artifacts(run_id)))


@router.get("/results/{run_id}/artifacts/{artifact_id}/viewer")
def artifact_viewer_descriptor(run_id: str, artifact_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _check_run(run_id, db, current_user)
    item, _ = _find_artifact(run_id, artifact_id)
    return JSONResponse(
        _safe_json(
            {
                "artifact": item,
                "viewer": {
                    "type": item.get("viewer_type"),
                    "title": item.get("title"),
                    "content_url": item.get("content_url"),
                    "download_url": item.get("download_url"),
                    "table_url": item.get("table_url"),
                    "generated_at": datetime.utcnow().isoformat(),
                },
            }
        )
    )


@router.get("/results/{run_id}/artifacts/{artifact_id}/content")
def serve_artifact_content(
    run_id: str,
    artifact_id: str,
    download: bool = Query(default=False),
    session_token: Optional[str] = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _check_run(run_id, db, current_user)
    _, rel_path = _find_artifact(run_id, artifact_id)
    return _serve_artifact_path(run_id, rel_path, download, session_token)


@router.get("/results/{run_id}/artifacts/file/{file_path:path}")
def serve_native_artifact(
    run_id: str,
    file_path: str,
    download: bool = Query(default=False),
    session_token: Optional[str] = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _check_run(run_id, db, current_user)
    return _serve_artifact_path(run_id, file_path, download, session_token)


@router.get("/results/{run_id}/tables/{artifact_id}")
def query_table_artifact(
    run_id: str,
    artifact_id: str,
    search: Optional[str] = Query(default=None),
    filters: Optional[str] = Query(default=None),
    sort_column: Optional[str] = Query(default=None),
    sort_direction: str = Query(default="asc"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=250),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _check_run(run_id, db, current_user)
    item, rel_path = _find_artifact(run_id, artifact_id)
    path = resolve_relative_path(RUNS_DIR / run_id, rel_path)
    table_df = _read_table_artifact(path)
    payload = _table_query(table_df, search, filters, sort_column, sort_direction, page, page_size)
    payload["artifact"] = item
    return JSONResponse(_safe_json(payload))


@router.get("/results/{run_id}/volcano")
def get_volcano(run_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    pd = _pd()
    run = _check_run(run_id, db, current_user)
    path = RUNS_DIR / run_id / "stage1" / "volcano_results.tsv"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Volcano results not yet available")

    df = pd.read_csv(path, sep="\t")
    params = json.loads(run.params or "{}")
    use_adjusted = bool(params.get("use_adjusted_pvalue", True))
    metric_column = "adj_pvalue" if use_adjusted else "pvalue"
    metric_label = "adjusted p-value" if use_adjusted else "p-value"

    x = df["log2fc"].tolist()
    # Cap -log10(p) at 50 to avoid extreme outliers dominating the plot
    y_raw = -np.log10(df[metric_column].clip(lower=1e-300))
    y = np.clip(y_raw, 0, 50).tolist()
    sig = df.get("significant", pd.Series([0] * len(df))).tolist()
    log2fc = df["log2fc"].values

    colors = []
    for i in range(len(df)):
        is_sig = bool(sig[i])
        if is_sig and log2fc[i] > 0:
            colors.append("rgba(192,57,43,0.65)")
        elif is_sig and log2fc[i] < 0:
            colors.append("rgba(26,86,219,0.65)")
        else:
            colors.append("rgba(120,110,100,0.18)")

    text = df["gene"].tolist()

    sig_count = int(sum(1 for c in colors if c != "rgba(120,110,100,0.18)"))
    up_count = int(sum(1 for i, c in enumerate(colors) if "192,57" in c))
    dn_count = int(sum(1 for i, c in enumerate(colors) if "26,86" in c))

    return JSONResponse(_safe_json({
        "x": x,
        "y": y,
        "color": colors,
        "text": text,
        "sig_count": sig_count,
        "up_count": up_count,
        "down_count": dn_count,
        "metric_label": metric_label,
        "use_adjusted_pvalue": use_adjusted,
    }))


@router.get("/results/{run_id}/top_proteins")
def get_top_proteins(run_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    pd = _pd()
    run = _check_run(run_id, db, current_user)
    path = RUNS_DIR / run_id / "stage1" / "volcano_results.tsv"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Volcano results not yet available")

    df = pd.read_csv(path, sep="\t")
    params = json.loads(run.params or "{}")
    use_adjusted = bool(params.get("use_adjusted_pvalue", True))
    metric_column = "adj_pvalue" if use_adjusted else "pvalue"
    sig_df = df[df.get("significant", pd.Series([0] * len(df))) == 1]
    if sig_df.empty:
        # fallback: take top by abs fold change
        sig_df = df.sort_values(metric_column).head(20)
    else:
        sig_df = sig_df.sort_values(metric_column).head(20)

    result = []
    for _, row in sig_df.iterrows():
        fc = float(row["log2fc"])
        result.append({
            "name": str(row["gene"]),
            "gene": str(row["gene"]),
            "peptide_id": str(row.get("peptide_id", row["gene"])),
            "log2fc": round(fc, 3),
            "significance_metric": f'{float(row[metric_column]):.2e}',
            "significance_metric_label": "adjusted p-value" if use_adjusted else "p-value",
            "module": str(row.get("module", "grey")),
            "direction": "up" if fc > 0 else "down",
        })
    return JSONResponse(_safe_json(result))


@router.get("/results/{run_id}/network")
def get_network(run_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    pd = _pd()
    _check_run(run_id, db, current_user)
    mod_path = RUNS_DIR / run_id / "stage1" / "module_assignments.csv"
    trait_path = RUNS_DIR / run_id / "stage1" / "module_trait_cor.csv"
    edges_path = RUNS_DIR / run_id / "stage1" / "network_edges.csv"
    eigengene_path = RUNS_DIR / run_id / "stage1" / "module_eigengenes.csv"

    if not mod_path.exists():
        raise HTTPException(status_code=404, detail="Module assignments not yet available")

    mod_df = pd.read_csv(mod_path)
    module_sizes = mod_df[mod_df["module_color"] != "grey"].groupby("module_color").size()

    # Load trait correlations for edge weighting
    trait_df = None
    if trait_path.exists():
        trait_df = pd.read_csv(trait_path)

    modules = module_sizes.index.tolist()
    n = len(modules)

    # Circular layout
    import math
    nodes = []
    for i, mod in enumerate(modules):
        angle = 2 * math.pi * i / n
        r = 0.38
        x = math.cos(angle) * r
        y = math.sin(angle) * r
        size = float(math.sqrt(module_sizes[mod]) * 0.9)
        color = mod if mod != "white" else "#e8e8e8"
        nodes.append({
            "id": mod,
            "color": color,
            "size": size,
            "x": round(x, 4),
            "y": round(y, 4),
            "member_count": int(module_sizes[mod]),
        })

    # Prefer explicit eigengene-derived network edges from Stage 1.
    edges = []
    if edges_path.exists():
        edge_df = pd.read_csv(edges_path)
        for _, row in edge_df.iterrows():
            source = str(row.get("source", "")).strip()
            target = str(row.get("target", "")).strip()
            weight = float(row.get("weight", 0))
            if source in modules and target in modules:
                edges.append({"source": source, "target": target, "weight": round(weight, 4)})
    elif eigengene_path.exists():
        eigengene_df = pd.read_csv(eigengene_path)
        me_columns = [column for column in eigengene_df.columns if str(column).startswith("ME") and str(column) != "MEgrey"]
        if len(me_columns) >= 2:
            corr = eigengene_df[me_columns].corr()
            for i, source in enumerate(me_columns):
                for j, target in enumerate(me_columns):
                    if j <= i:
                        continue
                    weight = float(corr.loc[source, target])
                    if math.isfinite(weight) and abs(weight) >= 0.35:
                        edges.append({
                            "source": source.replace("ME", "", 1),
                            "target": target.replace("ME", "", 1),
                            "weight": round(weight, 4),
                        })
    elif trait_df is not None:
        # Find the first cor_ column dynamically instead of hardcoding cor_Disease
        cor_columns = [c for c in trait_df.columns if c.startswith("cor_")]
        if cor_columns:
            cor_col = cor_columns[0]  # use the first trait correlation column
            cor_map = dict(zip(trait_df["module_color"], trait_df[cor_col]))
            for i, m1 in enumerate(modules):
                for j, m2 in enumerate(modules):
                    if j <= i:
                        continue
                    r1 = float(cor_map.get(m1, 0) or 0)
                    r2 = float(cor_map.get(m2, 0) or 0)
                    if abs(r1) > 0.2 and abs(r2) > 0.2 and r1 * r2 > 0:
                        edges.append({"source": m1, "target": m2, "weight": round(min(abs(r1), abs(r2)), 4)})

    return JSONResponse(_safe_json({"nodes": nodes, "edges": edges}))


@router.get("/results/{run_id}/trait_heatmap")
def get_trait_heatmap(run_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    pd = _pd()
    _check_run(run_id, db, current_user)
    path = RUNS_DIR / run_id / "stage1" / "module_trait_cor.csv"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Trait correlation data not yet available")

    df = pd.read_csv(path)

    # Extract correlation columns
    cor_cols = [c for c in df.columns if c.startswith("cor_")]
    traits = [c.replace("cor_", "") for c in cor_cols]

    modules = df["module_color"].tolist()

    # z matrix: modules × traits
    z = df[cor_cols].values.tolist()

    return JSONResponse(_safe_json({
        "modules": modules,
        "traits": traits,
        "z": [[round(v, 4) for v in row] for row in z],
    }))


@router.get("/results/{run_id}/go_heatmap")
def get_go_heatmap(run_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    pd = _pd()
    _check_run(run_id, db, current_user)
    run_dir = RUNS_DIR / run_id

    # Prefer z-score matrix, fall back to enrichment table
    zscore_path = run_dir / "stage2" / "go_zscore_matrix.csv"
    enrich_path = run_dir / "stage2" / "go_enrichment_all.csv"

    if zscore_path.exists():
        try:
            df = pd.read_csv(zscore_path, index_col=0)
            if df.empty or df.shape[1] == 0:
                raise ValueError("Empty z-score matrix")
            terms = df.index.tolist()
            modules = df.columns.tolist()
            z = df.values.tolist()
            return JSONResponse(_safe_json({
                "terms": terms,
                "modules": modules,
                "z": [[round(v, 4) if not (isinstance(v, float) and math.isnan(v)) else 0 for v in row] for row in z],
            }))
        except Exception:
            pass

    if not enrich_path.exists():
        raise HTTPException(status_code=404, detail="GO enrichment data not yet available")

    go_df = pd.read_csv(enrich_path)
    if go_df.empty:
        raise HTTPException(status_code=404, detail="GO enrichment data is empty")

    # Build top-terms × modules -log10(FDR) matrix
    sig = go_df[go_df["fdr"] < 0.1].copy() if (go_df["fdr"] < 0.1).any() else go_df.copy()
    top_terms = sig.groupby("term")["fdr"].min().nsmallest(25).index.tolist()

    pivot = go_df[go_df["term"].isin(top_terms)].pivot_table(
        index="term", columns="module", values="fdr", aggfunc="min"
    ).fillna(1.0)

    ml_vals = -np.log10(pivot.values + 1e-10)
    z = ml_vals.tolist()

    return JSONResponse(_safe_json({
        "terms": pivot.index.tolist(),
        "modules": pivot.columns.tolist(),
        "z": [[round(v, 4) for v in row] for row in z],
    }))


@router.get("/results/{run_id}/celltype_heatmap")
def get_celltype_heatmap(run_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    pd = _pd()
    _check_run(run_id, db, current_user)
    path = RUNS_DIR / run_id / "stage3" / "celltype_FDR_matrix.csv"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Cell type enrichment data not yet available")

    df = pd.read_csv(path, index_col=0)
    if df.empty:
        raise HTTPException(status_code=404, detail="Cell type data is empty")

    modules = df.index.tolist()
    cell_types = df.columns.tolist()
    z = df.values.tolist()

    return JSONResponse(_safe_json({
        "modules": modules,
        "types": cell_types,
        "z": [[round(v, 4) if not (isinstance(v, float) and math.isnan(v)) else 0 for v in row] for row in z],
    }))


@router.get("/results/{run_id}/summary")
def get_summary(run_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    run = _check_run(run_id, db, current_user)
    try:
        metrics = json.loads(run.metrics_json or "{}")
    except Exception:
        metrics = {}

    run_dir = RUNS_DIR / run_id
    summary = {
        "run_id": run_id,
        "run_name": run.name,
        "status": _status_value(run.status),
        "modules_count": run.modules_count,
        "sig_peptides": run.sig_peptides,
        "up_peptides": run.up_peptides,
        "down_peptides": run.down_peptides,
        "go_terms": run.go_terms,
        "params": json.loads(run.params or "{}"),
        "pipeline_profile": metrics.get("pipeline_profile"),
        "deliverable_variant": metrics.get("deliverable_variant"),
        "supported_steps": metrics.get("supported_steps", []),
        "supported_tabs": metrics.get("supported_tabs", []),
    }

    # Augment from stage1 analysis_summary.json
    s1_path = run_dir / "stage1" / "analysis_summary.json"
    if s1_path.exists():
        try:
            s1 = json.loads(s1_path.read_text())
            summary.update(s1)
        except Exception:
            pass

    return JSONResponse(_safe_json(summary))
