from __future__ import annotations

import base64
import json
import re
from html import escape
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote

from utils import is_manifest_viewable_file

ARTIFACT_TABS = ("overview", "qc", "volcano", "network", "go", "cells", "tables", "reports", "parameters", "files", "ai")

ARTIFACT_FAMILY_DESCRIPTIONS = {
    "tables.cleaned_matrix": "Cleaned and filtered abundance matrix after QC processing.",
    "tables.sample_metadata": "Sample metadata including quality flags and run annotations.",
    "tables.normalized_linear_matrix": "Normalized abundance matrix in linear scale.",
    "tables.normalized_matrix": "Normalized abundance matrix in log2 scale.",
    "tables.artifact_index": "Index of all pipeline artifacts generated for this run.",
    "tables.config_stage1": "Configuration parameters used for normalization and network analysis.",
    "tables.config_stage1_r": "R WGCNA configuration parameters used for Stage 1.",
    "tables.config_stage2": "Configuration parameters used for GO enrichment analysis.",
    "tables.config_stage3": "Configuration parameters used for cell type analysis.",
    "tables.params": "Full parameter set submitted at run time.",
    "tables.run_manifest": "Run provenance, dataset, pipeline version, and submission metadata.",
    "tables.pipeline_profile": "Pipeline profile settings determining analysis variant and output naming.",
    "volcano.results": "Differential expression results with fold changes, p-values, and significance flags.",
    "volcano.upregulated": "Features significantly upregulated in the case group.",
    "volcano.downregulated": "Features significantly downregulated in the case group.",
    "volcano.summary": "Summary of differential expression results.",
    "network.assignments": "WGCNA module assignment for each protein or peptide with kME score.",
    "network.hub_proteins": "Top hub proteins per module ranked by module membership.",
    "network.eigengenes": "Module eigengene expression profiles across samples.",
    "network.kme": "Module membership scores for all features across modules.",
    "network.module_trait": "Module-trait correlation coefficients and p-values.",
    "go.enrichment": "GO enrichment results with FDR-corrected p-values across modules.",
    "go.pvalues": "GO enrichment nominal p-value matrix by module.",
    "go.zscores": "GO enrichment signed z-score matrix.",
    "cells.matrix": "Cell type Fisher Exact Test FDR matrix.",
    "cells.hit_list": "Per-cell-type hit list statistics.",
}


def _path_segments(rel_path: str) -> list[str]:
    return [part.lower() for part in Path(rel_path).parts]


def _has_segment(rel_path: str, *values: str) -> bool:
    segments = set(_path_segments(rel_path))
    return any(str(value).lower() in segments for value in values)


def encode_artifact_id(rel_path: str) -> str:
    return base64.urlsafe_b64encode(rel_path.encode("utf-8")).decode("ascii").rstrip("=")


def decode_artifact_id(artifact_id: str) -> str:
    padding = "=" * ((4 - (len(artifact_id) % 4)) % 4)
    return base64.urlsafe_b64decode((artifact_id + padding).encode("ascii")).decode("utf-8")


def artifact_kind(path: Path | str) -> str:
    suffix = Path(str(path)).suffix.lower()
    return {
        ".html": "html",
        ".htm": "html",
        ".pdf": "pdf",
        ".csv": "csv",
        ".tsv": "tsv",
        ".xlsx": "xlsx",
        ".json": "json",
        ".txt": "txt",
        ".md": "txt",
        ".pptx": "pptx",
    }.get(suffix, suffix.lstrip(".") or "file")


def artifact_viewer_type(path: Path | str) -> str:
    kind = artifact_kind(path)
    if kind == "html":
        return "html"
    if kind == "pdf":
        return "pdf"
    if kind in {"csv", "tsv"}:
        return "table"
    if kind == "json":
        return "json"
    if kind == "txt":
        return "text"
    return "download"


def artifact_stage(rel_path: str) -> str:
    if "/" not in rel_path:
        return "meta"
    return rel_path.split("/", 1)[0]


def artifact_tab(rel_path: str, *, kind: str | None = None, strict: bool = False) -> str:
    lower = rel_path.lower()
    resolved_kind = kind or artifact_kind(rel_path)

    if lower in {"artifact_index.html", "artifact_index.json"}:
        return "tables"
    if "dashboard" in lower and resolved_kind == "html":
        return "overview"
    if any(token in lower for token in ("rmarkdown", "summary_report", "executive_summary", ".pptx")) or _has_segment(rel_path, "reports", "proteomics reports", "spec pep reports"):
        return "reports"
    if any(token in lower for token in ("pipeline_params", "pipeline_parameters", "parameters_audit", "param_audit", "stats_control_audit")):
        return "parameters"
    if strict:
        if resolved_kind in {"csv", "tsv", "json", "txt"}:
            return "tables"
        return "files"
    if any(token in lower for token in ("01_input", "overview", "manifest", "dataset_manifest")):
        return "overview"
    if any(token in lower for token in ("02_normalized", "normalization", "qc", "mds", "sample_clustering")):
        return "qc"
    if "volcano" in lower or "03_analysis" in lower:
        return "volcano"
    if any(
        token in lower
        for token in (
            "wgcna",
            "module",
            "eigengene",
            "network",
            "trait",
            "hub_protein",
            "hub_proteins",
            "power_selection",
            "05_network",
            "module preservation",
            "module_preservation",
        )
    ):
        return "network"
    if any(token in lower for token in ("goparallel", "go_", "go-", "pathway", "enrichment")) or _has_segment(rel_path, "spec pep go"):
        return "go"
    if any(token in lower for token in ("celltype", "cell_type", "celltypefet")) or _has_segment(rel_path, "spec pep celltypefet"):
        return "cells"
    if resolved_kind in {"csv", "tsv", "json", "txt"}:
        return "tables"
    return "files"


def artifact_legacy_class(rel_path: str) -> str:
    lower = rel_path.lower()
    if lower.startswith("01_input/"):
        return "legacy.input"
    if lower.startswith("02_normalized_"):
        return "legacy.qc"
    if lower.startswith("03_analysis_"):
        return "legacy.analysis"
    if lower.startswith("05_network_"):
        return "legacy.network"
    if _has_segment(rel_path, "spec pep go"):
        return "legacy.go"
    if _has_segment(rel_path, "spec pep celltypefet") or "celltypefet/" in lower:
        return "legacy.celltype"
    return "product.native"


def artifact_title(rel_path: str) -> str:
    leaf = Path(rel_path).stem
    leaf = re.sub(r"^[A-Z0-9]+_", "", leaf)
    leaf = leaf.replace("_", " ").replace("-", " ").strip()
    leaf = re.sub(r"\s+", " ", leaf)
    return leaf or rel_path


def _is_legacy_surface(rel_path: str) -> bool:
    lower = rel_path.lower()
    return (
        lower.startswith("01_input/")
        or lower.startswith("02_normalized_")
        or lower.startswith("03_analysis_")
        or lower.startswith("05_network_")
        or _has_segment(rel_path, "spec pep go")
        or _has_segment(rel_path, "spec pep celltypefet")
    )


def _is_derived_helper(rel_path: str, family: str) -> bool:
    lower = rel_path.lower()
    if "interactive_dashboard" in lower:
        return True
    if family in {"network.interactive_overview", "go.heatmap", "cells.heatmap"} and "interactive" in lower:
        return True
    return False


def artifact_family(rel_path: str, *, tab: str, kind: str) -> str:
    lower = rel_path.lower()
    if lower in {"artifact_index.html", "artifact_index.json"}:
        return "tables.artifact_index"
    if tab == "overview":
        if "dashboard" in lower and kind == "html":
            return "overview.dashboard"
        if "dataset_manifest" in lower:
            return "overview.dataset_manifest"
        if "run_manifest" in lower:
            return "overview.run_manifest"
        if "sample_traits" in lower or "traits.csv" in lower:
            return "overview.sample_traits"
        if "sample_metadata" in lower:
            return "overview.sample_metadata"
        return "overview.support"

    if tab == "qc":
        if "normalization_qc" in lower or "qc_plots" in lower:
            return "qc.normalization_qc"
        if "mds" in lower:
            return "qc.mds"
        if "normalization_summary" in lower:
            return "qc.summary"
        return "qc.support"

    if tab == "volcano":
        if "interactive_volcano" in lower or "volcano_plot" in lower:
            return "volcano.main"
        if "volcano_results" in lower:
            return "volcano.results"
        if "upregulated" in lower:
            return "volcano.upregulated"
        if "downregulated" in lower:
            return "volcano.downregulated"
        if "summary" in lower:
            return "volcano.summary"
        return "volcano.support"

    if tab == "network":
        if "sample_clustering" in lower:
            return "network.sample_clustering"
        if "power_selection" in lower or "power_diagnostics" in lower:
            return "network.power_selection"
        if "dendrogram" in lower:
            return "network.dendrogram"
        if "response_plot" in lower:
            return "network.response_plots"
        if "trait_cor" in lower or "trait_heatmap" in lower or "trait_relationship" in lower or "module_trait" in lower:
            return "network.module_trait"
        if "interactive_network" in lower:
            return "network.interactive_overview"
        if "hub_protein" in lower:
            return "network.hub_proteins"
        if "kme" in lower:
            return "network.kme"
        if "eigengene" in lower:
            return "network.eigengenes"
        if "module_assignments" in lower:
            return "network.assignments"
        return "network.support"

    if tab == "go":
        if "interactive" in lower and "heatmap" in lower:
            return "go.heatmap"
        if kind == "pdf" and "clustering" in lower:
            return "go.cluster_heatmap"
        if kind == "pdf":
            return "go.heatmap"
        if "go-enr.fdr" in lower or "go_enrichment_all" in lower:
            return "go.enrichment"
        if "pvalues" in lower:
            return "go.pvalues"
        if "zscores" in lower or "zscore" in lower:
            return "go.zscores"
        return "go.support"

    if tab == "cells":
        if "interactive" in lower and "heatmap" in lower:
            return "cells.heatmap"
        if kind == "pdf" and "barchart" in lower:
            return "cells.bar"
        if kind == "pdf":
            return "cells.heatmap"
        if "hitliststats" in lower:
            return "cells.hit_list"
        if "fdr_matrix" in lower or "heatmap_data" in lower:
            return "cells.matrix"
        return "cells.support"

    if tab == "parameters":
        return "parameters.audit"
    if tab == "reports":
        return "reports.dashboard"
    if tab == "tables":
        return f"tables.{Path(rel_path).stem.lower()}"
    return f"{tab}.support"


def _is_canonical(rel_path: str, tab: str, family: str) -> bool:
    if tab == "reports":
        return False
    if tab in {"overview", "tables", "files"}:
        return True
    if family == "volcano.main" and "interactive_volcano" in rel_path.lower():
        return True
    if _is_derived_helper(rel_path, family):
        return False
    return _is_legacy_surface(rel_path)


def artifact_priority(rel_path: str, kind: str, viewer_type: str, *, tab: str, family: str, canonical: bool) -> int:
    lower = rel_path.lower()
    priority = 300
    if canonical:
        priority -= 120
    if viewer_type in {"html", "pdf"}:
        priority -= 80
    if viewer_type == "table":
        priority -= 25
    if family.endswith(".main"):
        priority -= 60
    if family in {
        "qc.normalization_qc",
        "qc.mds",
        "network.sample_clustering",
        "network.power_selection",
        "network.dendrogram",
        "network.module_trait",
        "network.response_plots",
        "go.heatmap",
        "go.cluster_heatmap",
        "cells.heatmap",
        "cells.bar",
    }:
        priority -= 40
    if family in {"go.heatmap", "cells.heatmap"} and viewer_type == "pdf":
        priority -= 50
    if "summary" in lower:
        priority += 15
    if kind == "xlsx":
        priority += 20
    return priority


def _load_artifact_manifest(run_dir: Path) -> dict[str, dict[str, Any]]:
    manifest_path = run_dir / "artifact_manifest.json"
    if not manifest_path.exists():
        return {}
    try:
        payload = json.loads(manifest_path.read_text())
    except Exception:
        return {}
    entries = payload.get("entries", {})
    if isinstance(entries, dict):
        return {str(key): value for key, value in entries.items() if isinstance(value, dict)}
    return {}


def build_artifact_descriptor(
    run_id: str,
    run_dir: Path,
    path: Path,
    input_level: str | None = None,
    semantics: dict[str, Any] | None = None,
    manifest_present: bool = False,
) -> dict[str, Any]:
    rel_path = str(path.relative_to(run_dir))
    artifact_id = encode_artifact_id(rel_path)
    kind = artifact_kind(path)
    viewer_type = artifact_viewer_type(path)
    semantics = semantics or {}
    tab = str(semantics.get("tab") or artifact_tab(rel_path, kind=kind, strict=manifest_present))
    family = str(semantics.get("artifact_family") or artifact_family(rel_path, tab=tab, kind=kind))
    if "canonical" in semantics:
        canonical = bool(semantics.get("canonical"))
    elif manifest_present and not semantics:
        canonical = False
    else:
        canonical = _is_canonical(rel_path, tab, family)
    inline_preference = semantics.get("inline_preference")
    derived_fallback = bool(semantics.get("derived_fallback")) if "derived_fallback" in semantics else not canonical and tab in {"volcano", "network", "go", "cells"}
    title = str(semantics.get("title") or artifact_title(rel_path))
    legacy_class = str(semantics.get("legacy_class") or artifact_legacy_class(rel_path))
    return {
        "artifact_id": artifact_id,
        "title": title,
        "rel_path": rel_path,
        "stage": artifact_stage(rel_path),
        "tab": tab,
        "artifact_family": family,
        "kind": kind,
        "viewer_type": viewer_type,
        "size_bytes": path.stat().st_size,
        "previewable": viewer_type in {"html", "pdf"},
        "canonical": canonical,
        "inline_preference": inline_preference or ("html" if kind == "html" else "pdf" if kind == "pdf" else None),
        "derived_fallback": derived_fallback,
        "input_level": input_level or "unknown",
        "priority": artifact_priority(rel_path, kind, viewer_type, tab=tab, family=family, canonical=canonical),
        "legacy_class": legacy_class,
        "viewer_url": f"/api/results/{run_id}/artifacts/{artifact_id}/viewer",
        "content_url": f"/api/results/{run_id}/artifacts/{artifact_id}/content",
        "download_url": f"/api/results/{run_id}/artifacts/{artifact_id}/content?download=1",
        "table_url": f"/api/results/{run_id}/tables/{artifact_id}" if viewer_type == "table" else None,
        "inline_url": f"/api/results/{run_id}/artifacts/{artifact_id}/content",
        "download_companions": [],
    }


def _select_primary(group_items: list[dict[str, Any]], tab: str) -> dict[str, Any] | None:
    previewable = [item for item in group_items if item["previewable"]]
    if not previewable:
        return None

    canonical = [item for item in previewable if item["canonical"]]
    if tab in {"qc", "volcano", "network", "go", "cells"} and not canonical:
        return None
    candidates = canonical or previewable

    if tab in {"volcano", "network", "go", "cells"}:
        html = [item for item in candidates if item["kind"] == "html"]
        if html:
            return sorted(html, key=lambda item: (item["priority"], item["rel_path"].lower()))[0]
    if tab == "qc":
        pdf = [item for item in candidates if item["kind"] == "pdf"]
        if pdf:
            return sorted(pdf, key=lambda item: (item["priority"], item["rel_path"].lower()))[0]
    if tab == "overview":
        html = [item for item in candidates if item["kind"] == "html"]
        if html:
            return sorted(html, key=lambda item: (item["priority"], item["rel_path"].lower()))[0]

    html = [item for item in candidates if item["kind"] == "html"]
    if html:
        return sorted(html, key=lambda item: (item["priority"], item["rel_path"].lower()))[0]
    pdf = [item for item in candidates if item["kind"] == "pdf"]
    if pdf:
        return sorted(pdf, key=lambda item: (item["priority"], item["rel_path"].lower()))[0]
    return sorted(candidates, key=lambda item: (item["priority"], item["rel_path"].lower()))[0]


def _group_artifacts(items: Iterable[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = {tab: [] for tab in ARTIFACT_TABS}
    for item in items:
        grouped.setdefault(item["tab"], []).append(item)

    payload: dict[str, Any] = {}
    for tab in ARTIFACT_TABS:
        ordered = sorted(grouped.get(tab, []), key=lambda item: (item["priority"], item["rel_path"].lower()))

        featured: list[dict[str, Any]] = []
        secondary: list[dict[str, Any]] = []
        used_artifact_ids: set[str] = set()
        family_groups: dict[str, list[dict[str, Any]]] = {}

        for item in ordered:
            family_groups.setdefault(item["artifact_family"], []).append(item)

        if tab in {"overview", "qc", "volcano", "network", "go", "cells"}:
            for family, family_items in family_groups.items():
                primary = _select_primary(family_items, tab)
                if not primary:
                    continue
                companions: list[dict[str, Any]] = []
                _seen_basenames: set[str] = set()
                for _cand in sorted(family_items, key=lambda item: (item["priority"], item["rel_path"].lower())):
                    if _cand["artifact_id"] == primary["artifact_id"]:
                        continue
                    if _cand["kind"] not in {"html", "pdf"}:
                        continue
                    _basename = Path(_cand["rel_path"]).name.lower()
                    if _basename in _seen_basenames:
                        continue
                    _seen_basenames.add(_basename)
                    companions.append({
                        "artifact_id": _cand["artifact_id"],
                        "title": _cand["title"],
                        "kind": _cand["kind"],
                        "download_url": _cand["download_url"],
                        "viewer_url": _cand["viewer_url"],
                    })
                primary["download_companions"] = companions
                featured.append(primary)
                used_artifact_ids.add(primary["artifact_id"])
                used_artifact_ids.update(companion["artifact_id"] for companion in companions)
            featured = sorted(featured, key=lambda item: (item["priority"], item["rel_path"].lower()))
            secondary = [item for item in ordered if item["artifact_id"] not in used_artifact_ids]
        elif tab == "tables":
            featured = ordered[:8]
            secondary = [item for item in ordered if item["artifact_id"] not in {entry["artifact_id"] for entry in featured}]
        else:
            featured = ordered[:6]
            secondary = [item for item in ordered if item["artifact_id"] not in {entry["artifact_id"] for entry in featured}]

        payload[tab] = {"count": len(ordered), "featured": featured, "secondary": secondary}
    return payload


def _collect_legacy_root_basenames(run_dir: Path) -> dict[str, set[str]]:
    """For each legacy folder (e.g. 05_network_*/), collect basenames of files
    at its root level. Used to suppress duplicate registration of subfolder
    copies of those root-level files (e.g., per-trait subfolder copies of
    01_Sample_Clustering_QC.pdf, 03_Network_Dendrograms.pdf, etc.).

    Returns: { "05_network_CBN_median": {"foo.pdf", "bar.csv"}, ... }
    """
    legacy_roots: dict[str, set[str]] = {}
    if not run_dir.exists():
        return legacy_roots
    for entry in run_dir.iterdir():
        if not entry.is_dir():
            continue
        name = entry.name
        is_legacy = (
            name.startswith("01_input")
            or name.startswith("02_normalized_")
            or name.startswith("03_analysis_")
            or name.startswith("05_network_")
            or name.endswith(" Go")
            or name.endswith(" CellTypeFET")
        )
        if not is_legacy:
            continue
        try:
            legacy_roots[name] = {
                child.name.lower() for child in entry.iterdir() if child.is_file()
            }
        except OSError:
            continue
    return legacy_roots


def _is_subfolder_duplicate(rel_path: str, legacy_roots: dict[str, set[str]]) -> bool:
    """Return True if rel_path is a per-trait subfolder copy of a root-level file.

    e.g., "05_network_CBN_median/disease_status/PEAKS_WGCNA_03_Network_Dendrograms.pdf"
    is a duplicate of "05_network_CBN_median/PEAKS_WGCNA_03_Network_Dendrograms.pdf"
    because the root-level set contains the same basename.
    """
    parts = Path(rel_path).parts
    if len(parts) < 3:
        return False  # not in a subfolder
    legacy_root = parts[0]
    basename = parts[-1].lower()
    return basename in legacy_roots.get(legacy_root, set())


def build_artifact_index(run_id: str, run_dir: Path, *, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    descriptors: list[dict[str, Any]] = []
    input_level = str((metadata or {}).get("input_level") or "unknown")
    manifest_path = run_dir / "artifact_manifest.json"
    explicit_semantics = _load_artifact_manifest(run_dir)
    manifest_present = manifest_path.exists()
    legacy_roots = _collect_legacy_root_basenames(run_dir)
    for path in sorted(run_dir.rglob("*")):
        if not path.is_file():
            continue
        rel_path = str(path.relative_to(run_dir))
        if not is_manifest_viewable_file(rel_path):
            continue
        # Suppress subfolder duplicates of root-level files (per-trait copies
        # of 01/02/03 PDFs, Module_Eigengenes.csv, etc.) so they don't create
        # 5-7x duplicate cards on the network/go/cells tabs.
        if _is_subfolder_duplicate(rel_path, legacy_roots):
            continue
        descriptors.append(
            build_artifact_descriptor(
                run_id,
                run_dir,
                path,
                input_level=input_level,
                semantics=explicit_semantics.get(rel_path),
                manifest_present=manifest_present,
            )
        )

    payload = {
        "run_id": run_id,
        "generated_at": metadata.get("generated_at") if metadata else None,
        "metadata": metadata or {},
        "policy": {
            "native_first": True,
            "display_rule": {
                "interactive_html_inline": True,
                "pdf_inline_when_no_interactive": True,
                "duplicate_inline_rendering_blocked": True,
            },
            "download_blocked_extensions": [".RData", ".RDS", ".RDA"],
            "hidden_from_clients": ["R workspaces / session images"],
        },
        "artifacts": descriptors,
    }
    payload.update(_group_artifacts(descriptors))
    return payload


def _artifact_catalog_description(item: dict[str, Any]) -> str:
    family = str(item.get("artifact_family") or "")
    if family in ARTIFACT_FAMILY_DESCRIPTIONS:
        return ARTIFACT_FAMILY_DESCRIPTIONS[family]
    title = str(item.get("title") or "artifact")
    tab = str(item.get("tab") or "run")
    return f"{title} artifact from the {tab} output set."


def render_artifact_catalog_html(run_id: str, index: dict[str, Any]) -> str:
    artifacts = sorted(
        index.get("artifacts", []),
        key=lambda item: (
            str(item.get("stage") or ""),
            str(item.get("tab") or ""),
            str(item.get("title") or ""),
            str(item.get("rel_path") or ""),
        ),
    )
    rows = []
    for item in artifacts:
        title = escape(str(item.get("title") or item.get("rel_path") or "Artifact"))
        rel_path = escape(str(item.get("rel_path") or ""))
        stage = escape(str(item.get("stage") or "run"))
        tab = escape(str(item.get("tab") or "other"))
        kind = escape(str(item.get("kind") or "file").upper())
        description = escape(_artifact_catalog_description(item))
        rel_href = quote(str(item.get("rel_path") or ""), safe="/")
        content_url = escape(rel_href or "#", quote=True)
        download_url = escape(f"{rel_href}?download=1" if rel_href else "#", quote=True)
        open_link = (
            f'<a href="{content_url}" target="_blank" rel="noopener noreferrer">Open</a>'
            if item.get("content_url") or item.get("inline_url")
            else ""
        )
        download_link = (
            f'<a href="{download_url}" target="_blank" rel="noopener noreferrer">Download</a>'
            if item.get("download_url")
            else ""
        )
        rows.append(
            "<tr>"
            f"<td><strong>{title}</strong><div class=\"path\">{rel_path}</div></td>"
            f"<td>{description}</td>"
            f"<td><span>{stage}</span><span>{tab}</span><span>{kind}</span></td>"
            f"<td>{open_link}{download_link}</td>"
            "</tr>"
        )

    generated_at = escape(str(index.get("generated_at") or ""))
    generated_label = f" - generated {generated_at}" if generated_at else ""
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Artifact Catalog - {escape(run_id)}</title>
  <style>
    :root {{
      color-scheme: light;
      --text: #1f2933;
      --muted: #657381;
      --line: #d9e0e6;
      --accent: #2e7d5a;
      --soft: #f7f9f8;
    }}
    body {{
      margin: 0;
      padding: 32px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background: #fff;
    }}
    header {{
      margin-bottom: 24px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 16px;
    }}
    h1 {{
      margin: 0 0 8px;
      font-size: 28px;
      letter-spacing: 0;
    }}
    .sub {{
      color: var(--muted);
      font-size: 14px;
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }}
    th {{
      text-align: left;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: var(--soft);
      border-bottom: 1px solid var(--line);
      padding: 10px 12px;
    }}
    td {{
      vertical-align: top;
      border-bottom: 1px solid var(--line);
      padding: 12px;
      line-height: 1.45;
    }}
    .path {{
      margin-top: 3px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 12px;
      word-break: break-word;
    }}
    span {{
      display: inline-block;
      margin: 0 5px 5px 0;
      padding: 2px 7px;
      border-radius: 999px;
      background: var(--soft);
      color: var(--muted);
      border: 1px solid var(--line);
      font-size: 11px;
    }}
    a {{
      display: inline-block;
      margin: 0 8px 6px 0;
      color: var(--accent);
      font-weight: 650;
      text-decoration: none;
    }}
    a:hover {{ text-decoration: underline; }}
  </style>
</head>
<body>
  <header>
    <h1>Artifact Catalog</h1>
    <div class="sub">Run {escape(run_id)} - {len(artifacts)} artifacts available to the agent{generated_label}</div>
  </header>
  <table>
    <thead>
      <tr><th>Artifact</th><th>Description</th><th>Class</th><th>Links</th></tr>
    </thead>
    <tbody>
      {''.join(rows)}
    </tbody>
  </table>
</body>
</html>"""


def write_artifact_index(run_id: str, run_dir: Path, *, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = build_artifact_index(run_id, run_dir, metadata=metadata)
    json_path = run_dir / "artifact_index.json"
    html_path = run_dir / "artifact_index.html"
    json_path.write_text(json.dumps(payload, indent=2))
    html_path.write_text(render_artifact_catalog_html(run_id, payload), encoding="utf-8")
    payload = build_artifact_index(run_id, run_dir, metadata=metadata)
    json_path.write_text(json.dumps(payload, indent=2))
    html_path.write_text(render_artifact_catalog_html(run_id, payload), encoding="utf-8")
    return payload


def load_artifact_index(run_id: str, run_dir: Path) -> dict[str, Any]:
    path = run_dir / "artifact_index.json"
    persisted_metadata: dict[str, Any] = {}
    if path.exists():
        try:
            persisted_payload = json.loads(path.read_text())
            persisted_metadata = persisted_payload.get("metadata", {})
        except Exception:
            persisted_metadata = {}
    return build_artifact_index(run_id, run_dir, metadata=persisted_metadata)
