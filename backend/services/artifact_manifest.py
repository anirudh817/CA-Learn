from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def _register_entry(entries: dict[str, dict[str, Any]], run_dir: Path, rel_path: str, **payload: Any) -> None:
    target = run_dir / rel_path
    if not target.exists() or not target.is_file():
        return
    entry = {"rel_path": rel_path}
    entry.update(payload)
    entries[rel_path] = entry


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", ".", str(value or "").lower()).strip(".") or "item"


def _human_title(value: str) -> str:
    text = re.sub(r"[_-]+", " ", value or "").strip()
    return text[:1].upper() + text[1:] if text else "Artifact"


def _register_runtime_table(entries: dict[str, dict[str, Any]], run_dir: Path, rel_path: str, *, title: str, family: str) -> None:
    _register_entry(
        entries,
        run_dir,
        rel_path,
        title=title,
        tab="tables",
        artifact_family=family,
        canonical=False,
        legacy_class="runtime.table",
    )


def _register_remaining_tree(
    entries: dict[str, dict[str, Any]],
    run_dir: Path,
    root_rel: str,
    *,
    visual_tab: str,
    family_prefix: str,
    legacy_class: str,
) -> None:
    root_dir = run_dir / root_rel
    if not root_dir.exists():
        return

    # Collect basenames at the root of this tree so per-trait subfolder copies
    # of shared QC files (01_Sample_Clustering_QC.pdf, 02_Power_Selection.pdf,
    # 03_Network_Dendrograms.pdf, Module_Eigengenes.csv, etc.) are not
    # registered as separate artifacts. Without this, the network tab shows
    # 5-7x duplicates of every shared PDF — once per trait subfolder.
    root_level_basenames = {
        p.name.lower() for p in root_dir.iterdir() if p.is_file()
    }

    for path in sorted(root_dir.rglob("*")):
        if not path.is_file():
            continue
        rel_path = str(path.relative_to(run_dir))
        if rel_path in entries:
            continue

        parent_rel = path.parent.relative_to(root_dir)
        is_subfolder = str(parent_rel) not in {"", "."}
        if is_subfolder and path.name.lower() in root_level_basenames:
            # Subfolder copy of a top-level shared file — skip to prevent
            # duplicate cards on the network/go/cells tab.
            continue

        suffix = path.suffix.lower()
        stem_slug = _slug(path.stem)
        parent_slug = _slug(str(parent_rel)) if is_subfolder else "root"
        visual = suffix in {".html", ".pdf"}
        tab = visual_tab if visual else "tables"
        family = f"{family_prefix}.{parent_slug}.{stem_slug}"
        title_bits = []
        if is_subfolder:
            title_bits.append(_human_title(str(parent_rel).replace("/", " / ")))
        title_bits.append(_human_title(path.stem))
        _register_entry(
            entries,
            run_dir,
            rel_path,
            title=" - ".join(title_bits),
            tab=tab,
            artifact_family=family,
            canonical=visual,
            inline_preference="html" if suffix == ".html" else "pdf" if suffix == ".pdf" else None,
            legacy_class=legacy_class,
        )


def build_artifact_manifest(run_dir: Path, profile: dict[str, Any]) -> dict[str, Any]:
    prefix = profile["deliverable_prefix"]
    display_prefix = profile["display_prefix"]
    norm_tag = profile["normalization_tag"]
    go_dir = f"{display_prefix} Go"
    cell_dir = f"{display_prefix} CellTypeFET"
    analysis_dir = f"03_analysis_{norm_tag}"
    network_dir = f"05_network_{norm_tag}"
    normalized_dir = f"02_normalized_{norm_tag}"

    entries: dict[str, dict[str, Any]] = {}

    _register_entry(
        entries,
        run_dir,
        f"{prefix}_Interactive_Dashboard.html",
        title="Interactive Dashboard",
        tab="overview",
        artifact_family="overview.dashboard",
        canonical=True,
        inline_preference="html",
        legacy_class="product.native",
    )
    _register_entry(
        entries,
        run_dir,
        f"{prefix}_Pipeline_Parameters.html",
        title="Pipeline Parameters",
        tab="parameters",
        artifact_family="parameters.audit",
        canonical=True,
        inline_preference="html",
        legacy_class="product.native",
    )
    _register_entry(
        entries,
        run_dir,
        "run_manifest.json",
        title="Run Manifest",
        tab="tables",
        artifact_family="tables.run_manifest",
        canonical=True,
        legacy_class="product.native",
    )
    _register_entry(
        entries,
        run_dir,
        "pipeline_profile.json",
        title="Pipeline Profile",
        tab="tables",
        artifact_family="tables.pipeline_profile",
        canonical=True,
        legacy_class="product.native",
    )
    _register_entry(
        entries,
        run_dir,
        "artifact_index.json",
        title="Artifact Index",
        tab="tables",
        artifact_family="tables.artifact_index",
        canonical=True,
        legacy_class="product.native",
    )
    _register_entry(
        entries,
        run_dir,
        "artifact_index.html",
        title="Artifact Catalog",
        tab="tables",
        artifact_family="tables.artifact_index",
        canonical=True,
        inline_preference="html",
        legacy_class="product.native",
    )
    _register_entry(
        entries,
        run_dir,
        "artifact_manifest.json",
        title="Artifact Manifest",
        tab="tables",
        artifact_family="tables.artifact_manifest",
        canonical=True,
        legacy_class="product.native",
    )

    runtime_tables = [
        ("input/cleaned_matrix.csv", "Cleaned Matrix", "tables.cleaned_matrix"),
        ("input/sample_metadata.csv", "Sample Metadata", "tables.sample_metadata"),
        ("input/traits.csv", "Traits Metadata", "tables.traits"),
        ("input/dataset_manifest.json", "Dataset Manifest", "tables.dataset_manifest"),
        ("stage1/normalized_linear_matrix.csv", "Normalized Linear Matrix", "tables.normalized_linear_matrix"),
        ("stage1/normalized_matrix.csv", "Normalized Matrix", "tables.normalized_matrix"),
        ("stage1/volcano_results.tsv", "Differential Expression Results", "volcano.results"),
        ("stage1/volcano_upregulated.csv", "Upregulated Features", "volcano.upregulated"),
        ("stage1/volcano_downregulated.csv", "Downregulated Features", "volcano.downregulated"),
        ("stage1/module_assignments.csv", "Module Assignments", "network.assignments.runtime"),
        ("stage1/module_eigengenes.csv", "Module Eigengenes", "network.eigengenes.runtime"),
        ("stage1/module_trait_cor.csv", "Module Trait Correlations", "network.module_trait.runtime"),
        ("stage1/network_edges.csv", "Network Edges", "network.edges.runtime"),
        ("stage1/wgcna_power_diagnostics.csv", "WGCNA Power Diagnostics", "network.power.runtime"),
        ("stage1/top_proteins.json", "Top Proteins Summary", "tables.top_proteins"),
        ("stage1/analysis_summary.json", "Analysis Summary", "tables.analysis_summary"),
        ("stage2/go_enrichment_all.csv", "GO Enrichment Results", "go.enrichment.runtime"),
        ("stage2/go_pvalues_matrix.csv", "GO P-value Matrix", "go.pvalues.runtime"),
        ("stage2/go_fdr_matrix.csv", "GO FDR Matrix", "go.fdr.runtime"),
        ("stage2/go_zscore_matrix.csv", "GO Z-score Matrix", "go.zscores.runtime"),
        ("stage2/go_zscore_matrix_full.csv", "GO Z-score Matrix Full", "go.zscores.full"),
        ("stage2/go_summary.json", "GO Summary", "tables.go_summary"),
        ("stage3/celltype_FDR_matrix.csv", "Cell Type FDR Matrix", "cells.matrix"),
        ("stage3/celltype_heatmap_data.csv", "Cell Type Heatmap Data", "cells.heatmap_data"),
        ("stage3/celltype_summary.json", "Cell Type Summary", "tables.celltype_summary"),
        ("config_stage1.json", "Stage 1 Configuration", "tables.config_stage1"),
        ("config_stage1_r.json", "Stage 1 R Configuration", "tables.config_stage1_r"),
        ("config_stage2.json", "Stage 2 Configuration", "tables.config_stage2"),
        ("config_stage3.json", "Stage 3 Configuration", "tables.config_stage3"),
        ("params.json", "Run Parameters", "tables.params"),
    ]
    for rel_path, title, family in runtime_tables:
        _register_runtime_table(entries, run_dir, rel_path, title=title, family=family)

    stage3_dir = run_dir / "stage3"
    if stage3_dir.exists():
        for path in sorted(stage3_dir.glob("celltype_hitListStats_*.csv")):
            suffix = path.stem.replace("celltype_hitListStats_", "")
            _register_runtime_table(
                entries,
                run_dir,
                str(path.relative_to(run_dir)),
                title=f"Cell Type Hit List Stats - {_human_title(suffix)}",
                family=f"cells.hit_list.{_slug(suffix)}",
            )

    qc_specs = [
        (f"{normalized_dir}/{prefix}_CBN_Normalization_QC_Plots.pdf", "Normalization QC", "qc.normalization_qc"),
        (f"{normalized_dir}/{prefix}_MDS_Before_After_Normalization.pdf", "MDS Before / After Normalization", "qc.mds"),
        (f"{normalized_dir}/{prefix}_Normalization_Summary.txt", "Normalization Summary", "qc.summary"),
    ]
    for rel_path, title, family in qc_specs:
        _register_entry(
            entries,
            run_dir,
            rel_path,
            title=title,
            tab="qc",
            artifact_family=family,
            canonical=True,
            inline_preference="pdf" if rel_path.endswith(".pdf") else None,
            legacy_class="legacy.qc",
        )

    volcano_specs = [
        (f"{analysis_dir}/{prefix}_Interactive_Volcano_Plot.html", "Interactive Volcano Plot", "volcano.main", "html"),
        (f"{analysis_dir}/{prefix}_Volcano_Plot.pdf", "Volcano Plot", "volcano.main", "pdf"),
        (f"{analysis_dir}/{prefix}_Volcano_Results_All.csv", "Volcano Results", "volcano.results", None),
        (f"{analysis_dir}/{prefix}_Volcano_Summary.txt", "Volcano Summary", "volcano.summary", None),
    ]
    for rel_path, title, family, inline_preference in volcano_specs:
        _register_entry(
            entries,
            run_dir,
            rel_path,
            title=title,
            tab="volcano" if family == "volcano.main" else "tables",
            artifact_family=family,
            canonical=True,
            inline_preference=inline_preference,
            legacy_class="legacy.analysis",
        )
    analysis_dir_path = run_dir / analysis_dir
    if analysis_dir_path.exists():
        for path in sorted(analysis_dir_path.glob(f"{prefix}_Volcano_Upregulated_*.csv")):
            _register_entry(
                entries,
                run_dir,
                str(path.relative_to(run_dir)),
                title="Upregulated Features",
                tab="tables",
                artifact_family="volcano.upregulated",
                canonical=True,
                legacy_class="legacy.analysis",
            )
        for path in sorted(analysis_dir_path.glob(f"{prefix}_Volcano_Downregulated_*.csv")):
            _register_entry(
                entries,
                run_dir,
                str(path.relative_to(run_dir)),
                title="Downregulated Features",
                tab="tables",
                artifact_family="volcano.downregulated",
                canonical=True,
                legacy_class="legacy.analysis",
            )

    network_specs = [
        (f"{network_dir}/{prefix}_WGCNA_01_Sample_Clustering_QC.pdf", "Sample Clustering QC", "network.sample_clustering"),
        (f"{network_dir}/{prefix}_WGCNA_02_Power_Selection.pdf", "Power Selection", "network.power_selection"),
        (f"{network_dir}/{prefix}_WGCNA_03_Network_Dendrograms.pdf", "Network Dendrograms", "network.dendrogram"),
        (f"{network_dir}/{prefix}_WGCNA_04_Module_Trait_Correlations.pdf", "Module–Trait Relationships", "network.module_trait"),
        (f"{network_dir}/{prefix}_WGCNA_05_Module_Response_Plots.pdf", "Module Response Plots", "network.response_plots"),
        (f"{network_dir}/{prefix}_WGCNA_Interactive_Network.html", "Module Network Overview", "network.interactive_overview"),
        (f"{network_dir}/{prefix}_WGCNA_Module_Assignments_with_kME.csv", "Module Assignments with kME", "network.assignments"),
        (f"{network_dir}/{prefix}_WGCNA_Module_Eigengenes.csv", "Module Eigengenes", "network.eigengenes"),
        (f"{network_dir}/{prefix}_WGCNA_Hub_Protein_Statistics.csv", "Hub Protein Statistics", "network.hub_proteins"),
        (f"{network_dir}/{prefix}_WGCNA_All_Hub_Proteins.csv", "All Hub Proteins", "network.hub_proteins"),
        (f"{network_dir}/{prefix}_WGCNA_kME_Matrix.csv", "kME Matrix", "network.kme"),
    ]
    for rel_path, title, family in network_specs:
        _register_entry(
            entries,
            run_dir,
            rel_path,
            title=title,
            tab="network" if rel_path.endswith((".pdf", ".html")) else "tables",
            artifact_family=family,
            canonical=True,
            inline_preference="html" if rel_path.endswith(".html") else "pdf" if rel_path.endswith(".pdf") else None,
            legacy_class="legacy.network",
        )
    _register_remaining_tree(
        entries,
        run_dir,
        network_dir,
        visual_tab="network",
        family_prefix="network.extra",
        legacy_class="legacy.network",
    )

    go_specs = [
        (f"{go_dir}/{prefix}_GO_Interactive_Heatmap.html", "GO Heatmap", "go.heatmap", "html"),
        (f"{go_dir}/GSA-GO-FET_{profile['go_label']}_Proteomics_GO-redundancyRemoved.Kbest.pdf", "GO Heatmap", "go.heatmap", "pdf"),
        (f"{go_dir}/GO_cc_clustering_from_GSA_FET_Z-{profile['go_label']}_Proteomics_GO-redundancyRemoved.Kbest.pdf", "GO Clustering Heatmap", "go.cluster_heatmap", "pdf"),
        (f"{go_dir}/GSA-GO-FET_{profile['go_label']}_Proteomics_GO-Enr.FDR.BH.txt", "GO Enrichment FDR", "go.enrichment", None),
        (f"{go_dir}/GSA-GO-FET_{profile['go_label']}_Proteomics_GO-Enr.Pvalues.txt", "GO Enrichment P-values", "go.pvalues", None),
        (f"{go_dir}/GSA-GO-FET_{profile['go_label']}_Proteomics_GO-Zscores.txt", "GO Enrichment Z-scores", "go.zscores", None),
    ]
    for rel_path, title, family, inline_preference in go_specs:
        _register_entry(
            entries,
            run_dir,
            rel_path,
            title=title,
            tab="go" if inline_preference else "tables",
            artifact_family=family,
            canonical=True,
            inline_preference=inline_preference,
            legacy_class="legacy.go",
        )
    _register_remaining_tree(
        entries,
        run_dir,
        go_dir,
        visual_tab="go",
        family_prefix="go.extra",
        legacy_class="legacy.go",
    )

    input_level = str(profile.get("input_level") or "").lower()
    data_type_label = "Proteins" if input_level == "protein" else "Peptides"
    cell_specs = [
        (f"{cell_dir}/{prefix}_CellTypeFET_Interactive_Heatmap.html", "Cell-type Heatmap", "cells.heatmap", "html"),
        (f"{cell_dir}/{prefix}_{data_type_label}_CellTypeFET.Overlap.pdf", "Cell-type Overlap Heatmap", "cells.heatmap", "pdf"),
        (f"{cell_dir}/{prefix}_{data_type_label}_CellTypeFET_barChart.Overlap.pdf", "Cell-type Overlap Bar Chart", "cells.bar", "pdf"),
    ]
    for rel_path, title, family, inline_preference in cell_specs:
        _register_entry(
            entries,
            run_dir,
            rel_path,
            title=title,
            tab="cells",
            artifact_family=family,
            canonical=True,
            inline_preference=inline_preference,
            legacy_class="legacy.celltype",
        )
    _register_remaining_tree(
        entries,
        run_dir,
        cell_dir,
        visual_tab="cells",
        family_prefix="cells.extra",
        legacy_class="legacy.celltype",
    )

    return {
        "generated_at": profile.get("generated_at"),
        "entries": entries,
    }


def write_artifact_manifest(run_dir: Path, profile: dict[str, Any]) -> dict[str, Any]:
    payload = build_artifact_manifest(run_dir, profile)
    (run_dir / "artifact_manifest.json").write_text(json.dumps(payload, indent=2))
    return payload
