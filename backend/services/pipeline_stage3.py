from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path
from typing import Callable, Optional

import pandas as pd
from scipy import stats
from statsmodels.stats.multitest import multipletests

from services.pipeline_support import ts


CELLTYPE_VIZ_R_TIMEOUT_SECONDS = 300


def _celltype_viz_rscript_path() -> Optional[Path]:
    """Return path to bundled celltype_viz_runner.R if both Rscript and the script are present."""
    from config import BASE_DIR

    script = BASE_DIR / "r_scripts" / "celltype_viz_runner.R"
    if not script.exists():
        return None
    if not shutil.which("Rscript"):
        return None
    return script


def _run_celltype_viz_via_r(run_dir: Path, profile: dict, log_fn: Callable[[str], None]) -> None:
    """Invoke the R-native CellTypeFET heatmap renderer.

    Writes <run_dir>/<DisplayPrefix> CellTypeFET/ outputs at the canonical
    paths the artifact_manifest routes for `cells.heatmap`. Raises
    RuntimeError when R is unavailable; callers MUST wrap in try/except so
    the matplotlib output emit_legacy_bundle generates remains the
    guaranteed fallback."""
    script = _celltype_viz_rscript_path()
    if script is None:
        raise RuntimeError("R-native CellType visualization is unavailable (Rscript or celltype_viz_runner.R missing).")

    display_prefix = profile.get("display_prefix") or profile.get("deliverable_prefix") or "Proteomics"
    prefix = profile.get("deliverable_prefix") or "PROTEOMICS"
    input_level = (profile.get("input_level") or "peptide").lower()
    cell_dir = run_dir / f"{display_prefix} CellTypeFET"
    stage3_dir = run_dir / "stage3"

    config_path = run_dir / "stage3" / "celltype_viz_config.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps({
        "stage3_dir": str(stage3_dir.resolve()),
        "cell_dir": str(cell_dir.resolve()),
        "prefix": prefix,
        "display_prefix": display_prefix,
        "input_level": input_level,
    }, indent=2))

    log_fn(f"[{ts()}] Launching native R CellType visualization")
    try:
        result = subprocess.run(
            ["Rscript", "--vanilla", str(script), str(config_path)],
            cwd=str(run_dir),
            capture_output=True,
            text=True,
            timeout=CELLTYPE_VIZ_R_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"R CellType visualization timed out after {CELLTYPE_VIZ_R_TIMEOUT_SECONDS}s") from exc

    for line in (result.stdout or "").splitlines():
        if line.strip():
            log_fn(line.rstrip())
    if result.returncode != 0:
        for line in (result.stderr or "").splitlines():
            if line.strip():
                log_fn(f"[r-stderr] {line.rstrip()}")
        raise RuntimeError(f"R CellType visualization exited with code {result.returncode}")


def _load_pipeline_profile(run_dir: Path) -> Optional[dict]:
    """Read pipeline_profile.json written by write_pipeline_profile(); None if missing."""
    profile_path = run_dir / "pipeline_profile.json"
    if not profile_path.exists():
        return None
    try:
        return json.loads(profile_path.read_text())
    except Exception:
        return None


def _load_celltype_markers(csv_path: str, log_fn: Callable[[str], None]) -> dict[str, set]:
    """Load cell type markers from a wide CSV (columns=cell types, rows=genes)."""
    frame = pd.read_csv(csv_path)
    markers: dict[str, set] = {}
    for column in frame.columns:
        genes = set(frame[column].dropna().astype(str).tolist()) - {"", "nan"}
        if genes:
            markers[column] = genes
            log_fn(f"[{ts()}]   {column}: {len(genes)} marker genes")
    return markers


def _resolve_celltype_controls(config: dict) -> dict[str, object]:
    duplicate_handling = str(config.get("celltype_duplicate_handling", "allow") or "allow")
    if duplicate_handling not in {"allow", "collapse"}:
        duplicate_handling = "allow"

    from config import DEFAULT_CELLTYPE_MARKERS, DEFAULT_CELLTYPE_MARKERS_MOUSE

    reference = str(config.get("celltype_reference", "human_sharma_zhang_union") or "human_sharma_zhang_union")
    custom_markers = config.get("celltype_markers_file", None)
    if custom_markers:
        reference = "custom"
        marker_source = str(custom_markers)
    elif reference == "mouse_reference":
        marker_source = str(DEFAULT_CELLTYPE_MARKERS_MOUSE)
    else:
        reference = "human_sharma_zhang_union"
        marker_source = str(DEFAULT_CELLTYPE_MARKERS)

    adjust_requested = bool(config.get("adjust_fet_lookup", False))
    warnings: list[str] = []
    if adjust_requested:
        warnings.append("No cross-species lookup was applied; adjust_fet_lookup was recorded as not applicable.")

    return {
        "reference": reference,
        "marker_source": marker_source,
        "duplicate_handling": duplicate_handling,
        "adjust_fet_lookup_requested": adjust_requested,
        "adjust_fet_lookup_effective": False,
        "warnings": warnings,
    }


def _write_empty_celltype(stage_dir: Path, log_fn: Callable[[str], None], summary: dict | None = None) -> None:
    """Write empty cell type outputs with neutral headers and no fake biology."""
    (stage_dir / "celltype_FDR_matrix.csv").write_text("module\n")
    (stage_dir / "celltype_heatmap_data.csv").write_text("module,cell_type,pvalue,fdr,minus_log10_fdr\n")
    payload = {"modules_analyzed": 0, "note": "Cell type deconvolution was not performed"}
    if summary:
        payload.update(summary)
    (stage_dir / "celltype_summary.json").write_text(json.dumps(payload, indent=2))
    log_fn(f"[{ts()}] Written empty cell type output files (no deconvolution performed)")


def run_stage3(
    config: dict,
    run_dir: Path,
    log_fn: Callable[[str], None],
    step_callback: Optional[Callable[[str, str, int, str], None]] = None,
) -> None:
    """FET enrichment of WGCNA modules against cell type marker gene sets."""
    stage_dir = run_dir / "stage3"
    stage_dir.mkdir(parents=True, exist_ok=True)
    if step_callback:
        step_callback("celltypefet", "running", 20, "Running CellTypeFET enrichment")
    control_summary = _resolve_celltype_controls(config)

    module_file = run_dir / "stage1" / "module_assignments.csv"
    if not module_file.exists():
        log_fn(f"[{ts()}] WARNING: module_assignments.csv not found — writing empty cell type outputs")
        _write_empty_celltype(stage_dir, log_fn, {**control_summary, "note": "Module assignments missing"})
        if step_callback:
            step_callback("celltypefet", "skipped", 100, "Module assignments missing")
        return

    log_fn(f"[{ts()}] Loading module assignments for cell type enrichment...")
    mod_df = pd.read_csv(module_file)

    duplicate_handling = str(control_summary["duplicate_handling"])

    # Exact mirror of analytics_core/enrichment/celltypefet/geneListFET.R lines
    # 86-87 (build moduleList) and 211 (build allGenes for totProteomeLength):
    #   moduleList[[m]] <- unique gene names of features in module m  (line 234-236)
    #   greyToAddToTotProteome <- gene names of grey-module features (line 87)
    #   allGenes <- c(unlist(moduleList), greyToAddToTotProteome)     (line 211)
    #   totProteomeLength <- length(allGenes)                         (line 246)
    # Mixed semantics: non-grey contributes unique-gene names; grey contributes
    # peptide-row gene names (with duplicates). This is what produces ref's
    # extreme p-values (e.g. turquoise×Astrocytes = 1.4e-73).
    raw_genes = mod_df["gene"].astype(str)
    valid_mask = ~raw_genes.isin({"nan", "NaN", "", "None"})
    modules = [module for module in mod_df["module_color"].unique() if module != "grey"]

    module_unique_genes: dict[str, set[str]] = {}
    for m in modules:
        module_unique_genes[m] = set(raw_genes[valid_mask & (mod_df["module_color"] == m)].tolist())

    valid_gene_rows = raw_genes[valid_mask].tolist()
    grey_peptide_genes = raw_genes[valid_mask & (mod_df["module_color"] == "grey")].tolist()

    # geneListFET.R builds allGenes before module lists are uniqued, so
    # allow-duplicate mode uses peptide-row universe length. Module sizes stay
    # unique gene counts below, matching the reference contingency table.
    allow_mode_universe_size = len(valid_gene_rows)
    if duplicate_handling == "collapse":
        all_genes_concat = sorted(set(valid_gene_rows))
        dropped_duplicate_count = max(0, allow_mode_universe_size - len(all_genes_concat))
    else:
        all_genes_concat = list(valid_gene_rows)
        dropped_duplicate_count = 0
    universe_size = len(all_genes_concat)
    all_genes = set(all_genes_concat)
    log_fn(f"[{ts()}] CellTypeFET universe: {universe_size} entries ({len(all_genes)} unique genes; {len(grey_peptide_genes)} grey peptide rows)")
    if not modules:
        log_fn(f"[{ts()}] No non-grey modules detected — writing empty cell type outputs")
        _write_empty_celltype(
            stage_dir,
            log_fn,
            {
                **control_summary,
                "modules_analyzed": 0,
                "universe_size": int(universe_size),
                "unique_gene_count": int(len(all_genes)),
                "dropped_duplicate_count": int(dropped_duplicate_count),
                "note": "No non-grey modules detected",
            },
        )
        if step_callback:
            step_callback("celltypefet", "complete", 100, "No non-grey modules detected")
        return

    reference = str(control_summary["reference"])
    celltype_csv = str(control_summary["marker_source"])
    celltype_path = Path(celltype_csv)
    if not celltype_path.exists():
        log_fn(f"[{ts()}] ERROR: Cell type markers file not found: {celltype_csv}")
        log_fn(f"[{ts()}] Please upload a markers CSV or ensure the default marker file is installed")
        _write_empty_celltype(stage_dir, log_fn, {**control_summary, "note": "Cell type markers file not found"})
        if step_callback:
            step_callback("celltypefet", "failed", 100, "Cell type markers file not found")
        return

    log_fn(f"[{ts()}] Loading cell type markers: {celltype_csv}")
    try:
        celltype_markers = _load_celltype_markers(celltype_csv, log_fn)
    except Exception as error:
        log_fn(f"[{ts()}] ERROR: Could not load cell type markers ({error})")
        _write_empty_celltype(stage_dir, log_fn, {**control_summary, "note": "Cell type markers could not be loaded"})
        if step_callback:
            step_callback("celltypefet", "failed", 100, "Cell type markers could not be loaded")
        return

    cell_types = list(celltype_markers.keys())
    log_fn(f"[{ts()}] FET: {len(modules)} modules × {len(cell_types)} cell types...")

    fdr_matrix: dict[str, dict] = {}
    all_results: list[dict] = []
    for module_color in modules:
        mod_genes = module_unique_genes[module_color]
        module_size = len(mod_genes)
        raw_pvalues: list[float] = []
        ct_names: list[str] = []

        for cell_type_name, ct_genes in celltype_markers.items():
            # Mirror geneListFET.R lines 280-289 contingency assembly.
            # Note: numCategoryHitsInProteome counts UNIQUE category genes
            # appearing anywhere in allGenes (intersect returns unique in R).
            ct_genes_in_universe = ct_genes & all_genes
            overlap = mod_genes & ct_genes_in_universe
            a = len(overlap)                                    # numOverlap
            b = module_size - a                                 # otherCategories
            c = len(ct_genes_in_universe) - a                   # notInModule
            d = universe_size - len(ct_genes_in_universe) - b   # notInMod_otherCategories
            if d < 0:
                d = 0
            _, pvalue = stats.fisher_exact([[a, b], [c, d]], alternative="greater")
            raw_pvalues.append(pvalue)
            ct_names.append(cell_type_name)

        if raw_pvalues:
            _, adj_pvalues, _, _ = multipletests(raw_pvalues, method="fdr_bh")
        else:
            adj_pvalues = raw_pvalues

        row = {"module": module_color}
        for cell_type_name, raw_pvalue, fdr_pvalue in zip(ct_names, raw_pvalues, adj_pvalues):
            minus_log10_fdr = float(-math.log10(max(float(fdr_pvalue), 1e-300)))
            row[cell_type_name] = round(minus_log10_fdr, 4)
            all_results.append(
                {
                    "module": module_color,
                    "cell_type": cell_type_name,
                    "pvalue": float(raw_pvalue),
                    "fdr": float(fdr_pvalue),
                    "minus_log10_fdr": round(minus_log10_fdr, 4),
                }
            )
        fdr_matrix[module_color] = row

    if not fdr_matrix:
        log_fn(f"[{ts()}] No cell type enrichment rows generated — writing empty outputs")
        _write_empty_celltype(stage_dir, log_fn, {**control_summary, "note": "No CellTypeFET enrichments were produced"})
        if step_callback:
            step_callback("celltypefet", "complete", 100, "No CellTypeFET enrichments were produced")
        return

    fdr_df = pd.DataFrame(list(fdr_matrix.values())).set_index("module")
    fdr_df.to_csv(stage_dir / "celltype_FDR_matrix.csv")
    log_fn(f"[{ts()}] Written: celltype_FDR_matrix.csv")

    detail_df = pd.DataFrame(all_results)
    detail_df.to_csv(stage_dir / "celltype_heatmap_data.csv", index=False)
    for cell_type_name in cell_types:
        ct_df = detail_df[detail_df["cell_type"] == cell_type_name].sort_values("fdr")
        ct_df.to_csv(stage_dir / f"celltype_hitListStats_{cell_type_name}.csv", index=False)

    summary = {
        "modules_analyzed": len(modules),
        "cell_types": cell_types,
        "significant_enrichments": int((detail_df["fdr"] < 0.05).sum()),
        "reference": reference,
        "marker_source": str(celltype_csv),
        "duplicate_handling": duplicate_handling,
        "universe_size": int(universe_size),
        "unique_gene_count": int(len(all_genes)),
        "dropped_duplicate_count": int(dropped_duplicate_count),
        "adjust_fet_lookup_requested": control_summary["adjust_fet_lookup_requested"],
        "adjust_fet_lookup_effective": control_summary["adjust_fet_lookup_effective"],
        "warnings": control_summary["warnings"],
        "top_enrichments": detail_df.sort_values("minus_log10_fdr", ascending=False).head(5).to_dict(orient="records"),
    }
    (stage_dir / "celltype_summary.json").write_text(json.dumps(summary, indent=2))
    log_fn(f"[{ts()}] Stage 3 complete: {summary['significant_enrichments']} significant cell-type enrichments")

    if step_callback:
        step_callback("celltypefet", "complete", 100, "CellTypeFET outputs ready")

    # Native R viz layer — opportunistic, same pattern as Stage 2.
    fdr_path = stage_dir / "celltype_FDR_matrix.csv"
    if fdr_path.exists() and fdr_path.stat().st_size > len("module\n"):
        try:
            profile = _load_pipeline_profile(run_dir)
            if profile is not None:
                _run_celltype_viz_via_r(run_dir, profile, log_fn)
        except Exception as exc:  # noqa: BLE001 — viz is best-effort
            log_fn(f"[{ts()}] WARNING: native R CellType visualization skipped ({exc})")
