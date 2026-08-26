from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
import textwrap
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import numpy as np
import pandas as pd

from services.profile_defaults import resolve_profile_identity


TRAIT_VIZ_R_TIMEOUT_SECONDS = 300


def _trait_viz_rscript_path() -> Path | None:
    """Path to bundled trait_viz_runner.R, or None if Rscript or the script is missing."""
    from config import BASE_DIR

    script = BASE_DIR / "r_scripts" / "trait_viz_runner.R"
    if not script.exists():
        return None
    if not shutil.which("Rscript"):
        return None
    return script


def _run_trait_viz_via_r(
    run_dir: Path,
    profile: dict[str, Any],
    trait_buckets: dict[str, list[str]],
    all_traits: list[str],
    log_fn: Callable[[str], None],
) -> None:
    """Invoke trait_viz_runner.R for native per-trait WGCNA visualization.

    Raises RuntimeError on any failure (Rscript missing, R packages missing,
    timeout, non-zero exit) so the caller can fall back to the existing
    matplotlib helpers without breaking the pipeline.
    """
    script = _trait_viz_rscript_path()
    if script is None:
        raise RuntimeError("R-native trait visualization unavailable (Rscript or trait_viz_runner.R missing).")

    norm_tag = profile.get("normalization_tag", "CBN_median")
    network_dir = run_dir / f"05_network_{norm_tag}"
    stage1_dir = run_dir / "stage1"
    config_path = stage1_dir / "trait_viz_config.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)

    config = {
        "stage1_dir": str(stage1_dir.resolve()),
        "network_dir": str(network_dir.resolve()),
        "prefix": profile.get("deliverable_prefix") or "PROTEOMICS",
        "display_prefix": profile.get("display_prefix") or profile.get("deliverable_prefix") or "Proteomics",
        "trait_buckets": trait_buckets,
        "all_traits": all_traits,
    }
    config_path.write_text(json.dumps(config, indent=2))
    log_fn(f"[{datetime.now().strftime('%H:%M:%S')}] Launching native R trait visualization")

    try:
        result = subprocess.run(
            ["Rscript", "--vanilla", str(script), str(config_path)],
            cwd=str(run_dir),
            capture_output=True,
            text=True,
            timeout=TRAIT_VIZ_R_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"R trait visualization timed out after {TRAIT_VIZ_R_TIMEOUT_SECONDS}s") from exc

    for line in (result.stdout or "").splitlines():
        if line.strip():
            log_fn(line.rstrip())
    if result.returncode != 0:
        for line in (result.stderr or "").splitlines():
            if line.strip():
                log_fn(f"[r-stderr] {line.rstrip()}")
        raise RuntimeError(f"R trait visualization exited with code {result.returncode}")


MODULE_COLOR_MAP = {
    "turquoise":      "#40e0d0",
    "blue":           "#0000ff",
    "brown":          "#a52a2a",
    "yellow":         "#ffff00",
    "green":          "#008000",
    "red":            "#ff0000",
    "black":          "#000000",
    "pink":           "#ffc0cb",
    "magenta":        "#ff00ff",
    "purple":         "#800080",
    "greenyellow":    "#adff2f",
    "tan":            "#d2b48c",
    "salmon":         "#fa8072",
    "cyan":           "#00ffff",
    "midnightblue":   "#191970",
    "lightcyan":      "#e0ffff",
    "grey60":         "#999999",
    "lightgreen":     "#90ee90",
    "lightyellow":    "#ffffe0",
    "royalblue":      "#4169e1",
    "darkred":        "#8b0000",
    "darkgreen":      "#006400",
    "darkturquoise":  "#00ced1",
    "darkgrey":       "#a9a9a9",
    "orange":         "#ffa500",
    "darkorange":     "#ff8c00",
    "white":          "#ffffff",
    "skyblue":        "#87ceeb",
    "saddlebrown":    "#8b4513",
    "steelblue":      "#4682b4",
    "paleturquoise":  "#afeeee",
    "violet":         "#ee82ee",
    "darkolivegreen": "#556b2f",
    "darkmagenta":    "#8b008b",
    "plum":           "#dda0dd",
    "sienna":         "#a0522d",
    "lightsteelblue": "#b0c4de",
    "firebrick":      "#b22222",
    "mediumpurple":   "#9370db",
    "lightblue":      "#add8e6",
    "floralwhite":    "#fffaf0",
    "navajowhite":    "#ffdead",
    "darkslateblue":  "#483d8b",
    "peru":           "#cd853f",
    "bisque":         "#ffe4c4",
}


def resolve_pipeline_profile(manifest: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    family = str(manifest.get("format_family") or params.get("format_family") or "Generic").strip()
    level = str(manifest.get("assay_level") or params.get("input_level") or "unknown").strip().lower()
    normalization_method = str(params.get("normalization_method") or "median").strip().lower()
    identity = resolve_profile_identity(family, level)
    pipeline_profile = identity["pipeline_profile"]
    code_prefix = identity["deliverable_prefix"]
    display_prefix = identity["display_prefix"]
    go_label = identity["go_label"]

    deliverable_variant = "spec_pep" if pipeline_profile == "spectronaut_specpep" else "legacy_native"
    norm_tag = f"CBN_{normalization_method}" if normalization_method and normalization_method != "none" else "raw"

    return {
        "pipeline_profile": pipeline_profile,
        "deliverable_variant": deliverable_variant,
        "format_family": family,
        "input_level": level,
        "deliverable_prefix": code_prefix,
        "display_prefix": display_prefix,
        "go_label": go_label,
        "normalization_tag": norm_tag,
        "supported_steps": [
            {"key": "etl", "enabled": True},
            {"key": "processing_sample_alignment", "enabled": True},
            {"key": "outlier_removal", "enabled": True},
            {"key": "normalization", "enabled": True},
            {"key": "variance_batch_correction", "enabled": bool(params.get("variance_correction_enabled", False))},
            {"key": "differential_expression", "enabled": True},
            {"key": "wgcna_network", "enabled": True},
            {"key": "goparallel", "enabled": True},
            {"key": "celltypefet", "enabled": True},
            {"key": "deliverable_packaging", "enabled": True},
            {"key": "ml_classification", "enabled": False},
            {"key": "module_preservation", "enabled": False},
        ],
        "supported_tabs": ["overview", "qc", "volcano", "network", "go", "cells", "tables", "files", "ai"],
        "advanced_modules": {
            "ml_classification": {"enabled": False, "reason": "Not yet ported from analytics_core into this runtime"},
            "module_preservation": {"enabled": False, "reason": "Not yet ported from analytics_core into this runtime"},
        },
    }


def write_pipeline_profile(run_dir: Path, profile: dict[str, Any]) -> None:
    (run_dir / "pipeline_profile.json").write_text(json.dumps(profile, indent=2))


CURATED_PARAM_LABELS = {
    "normalization_method": "Normalization Method",
    "wgcna_power": "WGCNA Soft Threshold (Power)",
    "merge_cut_height": "Module Merge Cut Height",
    "fdr_threshold": "FDR Threshold",
    "gmt_file": "GO GMT Database",
}


def _safe_html(text: str) -> str:
    """Minimal HTML escaping for deliverable bundle content."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _safe_param_value(key: str, raw_value: Any) -> str:
    """Return a safe, human-readable display value for a curated parameter.

    For gmt_file, show only the basename (filename), not the full path.
    """
    val = str(raw_value) if raw_value is not None else "\u2014"
    if key == "gmt_file" and "/" in val:
        val = val.rsplit("/", 1)[-1]  # basename only
    if key == "gmt_file" and "\\" in val:
        val = val.rsplit("\\", 1)[-1]  # Windows path basename
    return _safe_html(val)


def _render_parameter_page(params: dict[str, Any], app_version: str) -> str:
    """Render curated pipeline parameter HTML section for deliverable bundle.

    Source of truth: params dict is read from run_dir/params.json, which is the
    frozen snapshot written at pipeline start. app_version is read from the same
    file or from the run record.
    """
    rows = "".join(
        f"<tr><td style='padding:8px 10px;border-bottom:1px solid #ede9e3;font-weight:500'>{label}</td>"
        f"<td style='padding:8px 10px;border-bottom:1px solid #ede9e3'>{_safe_param_value(key, params.get(key))}</td></tr>"
        for key, label in CURATED_PARAM_LABELS.items()
    )
    version_line = (
        f"<p style='color:#7a6e65;font-size:13px;margin-top:16px'>Pipeline version: {_safe_html(app_version)}</p>"
        if app_version
        else ""
    )
    return f"""<div class="panel" style="margin-top:20px">
      <div class="eyebrow">Pipeline configuration</div>
      <h2 style="margin:0 0 12px;font-size:22px">Pipeline Parameters</h2>
      <p style="color:#7a6e65;margin-bottom:16px">Run configuration recorded at submission time</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px"><tbody>{rows}</tbody></table>
      {version_line}
    </div>"""


def _safe_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", str(value or "").strip())
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    return cleaned or "Value"


def _copy_if_exists(source: Path, target: Path) -> None:
    if not source.exists() or not source.is_file():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def _write_text_table(source: Path, target: Path, *, sep: str = ",") -> None:
    if not source.exists():
        return
    df = pd.read_csv(source, sep=sep)
    target.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(target, sep="\t", index=False)


def _classical_mds(matrix: np.ndarray, n_components: int = 2) -> np.ndarray:
    if matrix.shape[0] < 2:
        return np.zeros((matrix.shape[0], n_components))
    distances = np.sqrt(np.maximum(0.0, ((matrix[:, None, :] - matrix[None, :, :]) ** 2).sum(axis=2)))
    squared = distances ** 2
    n = squared.shape[0]
    centering = np.eye(n) - np.ones((n, n)) / n
    gram = -0.5 * centering @ squared @ centering
    eigenvalues, eigenvectors = np.linalg.eigh(gram)
    order = np.argsort(eigenvalues)[::-1]
    eigenvalues = eigenvalues[order]
    eigenvectors = eigenvectors[:, order]
    coords = []
    for index in range(n_components):
        if index < len(eigenvalues) and eigenvalues[index] > 0:
            coords.append(eigenvectors[:, index] * math.sqrt(eigenvalues[index]))
        else:
            coords.append(np.zeros(n))
    return np.vstack(coords).T


def _plot_normalization_qc(raw_df: pd.DataFrame, normalized_df: pd.DataFrame, sample_meta: pd.DataFrame, output_pdf: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    sample_columns = [column for column in sample_meta["sample_name"].astype(str).tolist() if column in normalized_df.columns]
    if not sample_columns:
        return

    raw_values = raw_df[sample_columns].apply(pd.to_numeric, errors="coerce").replace(0, np.nan)
    normalized_values = normalized_df[sample_columns].apply(pd.to_numeric, errors="coerce")
    raw_log = np.log2(raw_values.clip(lower=1e-9))

    fig, axes = plt.subplots(2, 2, figsize=(13, 9))
    axes[0, 0].boxplot([raw_log[column].dropna().values for column in sample_columns], tick_labels=sample_columns, showfliers=False)
    axes[0, 0].set_title("Raw / log2-like abundance by sample")
    axes[0, 0].tick_params(axis="x", labelrotation=90, labelsize=7)

    axes[0, 1].boxplot([normalized_values[column].dropna().values for column in sample_columns], tick_labels=sample_columns, showfliers=False)
    axes[0, 1].set_title("Normalized abundance by sample")
    axes[0, 1].tick_params(axis="x", labelrotation=90, labelsize=7)

    missing_raw = raw_values.isna().mean(axis=0).values
    missing_norm = normalized_values.isna().mean(axis=0).values
    axes[1, 0].bar(range(len(sample_columns)), missing_raw, color="#c0392b", alpha=0.75, label="Raw")
    axes[1, 0].bar(range(len(sample_columns)), missing_norm, color="#4a7c6f", alpha=0.65, label="Normalized")
    axes[1, 0].set_title("Missingness by sample")
    axes[1, 0].set_xticks(range(len(sample_columns)))
    axes[1, 0].set_xticklabels(sample_columns, rotation=90, fontsize=7)
    axes[1, 0].legend(frameon=False)

    group_counts = sample_meta["group"].fillna("Unknown").value_counts()
    axes[1, 1].bar(group_counts.index.tolist(), group_counts.values.tolist(), color="#7c5c3e")
    axes[1, 1].set_title("Sample counts by group")
    axes[1, 1].tick_params(axis="x", rotation=30)

    fig.tight_layout()
    output_pdf.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_pdf)
    plt.close(fig)


def _plot_mds_before_after(raw_df: pd.DataFrame, normalized_df: pd.DataFrame, sample_meta: pd.DataFrame, output_pdf: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    sample_columns = [column for column in sample_meta["sample_name"].astype(str).tolist() if column in normalized_df.columns]
    if len(sample_columns) < 2:
        return

    raw_values = raw_df[sample_columns].apply(pd.to_numeric, errors="coerce").replace(0, np.nan)
    raw_values = np.log2(raw_values.clip(lower=1e-9))
    raw_values = raw_values.fillna(raw_values.median(axis=1), axis=0).fillna(0.0)

    normalized_values = normalized_df[sample_columns].apply(pd.to_numeric, errors="coerce")
    normalized_values = normalized_values.fillna(normalized_values.median(axis=1), axis=0).fillna(0.0)

    raw_coords = _classical_mds(raw_values.T.values)
    norm_coords = _classical_mds(normalized_values.T.values)

    groups = sample_meta.set_index("sample_name").reindex(sample_columns)["group"].fillna("Unknown").tolist()
    unique_groups = list(dict.fromkeys(groups))
    colors = ["#7c5c3e", "#4a7c6f", "#1a56db", "#c0392b", "#8b5cf6", "#0f766e"]
    color_map = {group: colors[index % len(colors)] for index, group in enumerate(unique_groups)}

    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    for ax, coords, title in (
        (axes[0], raw_coords, "Before normalization"),
        (axes[1], norm_coords, "After normalization"),
    ):
        for index, sample_name in enumerate(sample_columns):
            ax.scatter(coords[index, 0], coords[index, 1], color=color_map[groups[index]], s=55)
            ax.text(coords[index, 0], coords[index, 1], sample_name, fontsize=7)
        ax.set_title(title)
        ax.set_xlabel("MDS1")
        ax.set_ylabel("MDS2")
    fig.tight_layout()
    output_pdf.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_pdf)
    plt.close(fig)


def _plot_power_selection_csv(power_csv: Path, output_pdf: Path) -> None:
    if not power_csv.exists():
        return
    power_df = pd.read_csv(power_csv)
    if power_df.empty or "Power" not in power_df.columns or "SFT.R.sq" not in power_df.columns:
        return

    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(8.5, 5))
    ax.plot(power_df["Power"], power_df["SFT.R.sq"], marker="o", color="#7c5c3e")
    ax.axhline(0.8, linestyle="--", color="#c0392b", linewidth=1)
    ax.set_title("WGCNA Power Selection")
    ax.set_xlabel("Soft threshold power")
    ax.set_ylabel("Scale-free topology fit (R^2)")
    ax.grid(alpha=0.2)
    fig.tight_layout()
    output_pdf.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_pdf)
    plt.close(fig)


def _plot_sample_clustering(normalized_df: pd.DataFrame, sample_meta: pd.DataFrame, output_pdf: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from scipy.cluster.hierarchy import dendrogram, linkage
    from scipy.spatial.distance import pdist

    sample_columns = [column for column in sample_meta["sample_name"].astype(str).tolist() if column in normalized_df.columns]
    if len(sample_columns) < 2:
        return
    values = normalized_df[sample_columns].apply(pd.to_numeric, errors="coerce")
    values = values.fillna(values.median(axis=1), axis=0).fillna(0.0)
    link = linkage(pdist(values.T.values, metric="euclidean"), method="average")

    fig, ax = plt.subplots(figsize=(10.5, 5.5))
    dendrogram(link, labels=sample_columns, leaf_rotation=90, ax=ax, color_threshold=None)
    ax.set_title("Sample clustering QC")
    fig.tight_layout()
    output_pdf.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_pdf)
    plt.close(fig)


def _plot_module_response(module_trait_cor: pd.DataFrame, output_pdf: Path) -> None:
    if module_trait_cor.empty:
        return
    correlation_columns = [column for column in module_trait_cor.columns if str(column).startswith("cor_")]
    if not correlation_columns:
        return

    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(len(correlation_columns), 1, figsize=(14, max(5, 3.4 * len(correlation_columns))), squeeze=False)
    for row_index, column in enumerate(correlation_columns):
        ordered = module_trait_cor[["module_color", column]].sort_values(column)
        colors = [MODULE_COLOR_MAP.get(str(name).lower(), str(name)) for name in ordered["module_color"].tolist()]
        axes[row_index, 0].barh(ordered["module_color"], ordered[column], color=colors)
        axes[row_index, 0].set_title(column.replace("cor_", "").replace("_", " "))
        axes[row_index, 0].axvline(0.0, color="#2a2420", linewidth=1)
        axes[row_index, 0].tick_params(axis="y", labelsize=8)
    fig.tight_layout(pad=2.0)
    output_pdf.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_pdf, bbox_inches="tight")
    plt.close(fig)


def _plot_matrix_heatmap(matrix_df: pd.DataFrame, output_pdf: Path, title: str) -> None:
    if matrix_df.empty:
        return
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    values = matrix_df.apply(pd.to_numeric, errors="coerce").fillna(0.0).values
    y_labels = [str(label) for label in matrix_df.index.tolist()]
    x_labels = [str(label) for label in matrix_df.columns.tolist()]
    longest_y_label = max([len(label) for label in y_labels] or [0])
    longest_x_label = max([len(label) for label in x_labels] or [0])
    wrapped_y_labels = [
        "\n".join(textwrap.wrap(label, width=58, break_long_words=False)) if len(label) > 58 else label
        for label in y_labels
    ]
    fig_width = max(11, matrix_df.shape[1] * 0.65 + min(longest_y_label * 0.11, 18))
    fig_height = max(7.5, matrix_df.shape[0] * 0.38 + min(longest_x_label * 0.03, 3))
    fig, ax = plt.subplots(figsize=(fig_width, fig_height))
    image = ax.imshow(values, aspect="auto", cmap="coolwarm")
    ax.set_title(title)
    ax.set_xticks(range(matrix_df.shape[1]))
    ax.set_xticklabels(x_labels, rotation=40, ha="right", fontsize=9)
    ax.set_yticks(range(matrix_df.shape[0]))
    ax.set_yticklabels(wrapped_y_labels, fontsize=8)
    fig.colorbar(image, ax=ax, fraction=0.028, pad=0.02)
    left_margin = min(0.56, max(0.18, longest_y_label * 0.0048))
    bottom_margin = min(0.32, max(0.14, longest_x_label * 0.0045))
    fig.subplots_adjust(left=left_margin, right=0.94, bottom=bottom_margin, top=0.92)
    output_pdf.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_pdf, bbox_inches="tight")
    plt.close(fig)


def _strip_me_prefix(value: str) -> str:
    text = str(value or "").strip()
    return text[2:] if text.lower().startswith("me") else text


def _normalize_trait_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").lower()).strip("_")


_AD_BUCKET_FOLDERS = frozenset({"disease_status", "total_tau", "phospho_tau", "amyloid_beta"})


def _is_ad_bucket_folder(folder: str) -> bool:
    return folder in _AD_BUCKET_FOLDERS


def _trait_folder_for_name(trait_name: str) -> str | None:
    """Map a trait name to a deliverable subfolder.

    AD-pattern traits go into shared named buckets (multiple traits per folder).
    Any other trait gets its own slugified folder so the deliverable structure
    is complete for any cohort, not only AD studies.
    """
    key = _normalize_trait_key(trait_name)
    if not key:
        return None
    if any(token in key for token in ("p_tau", "ptau", "phospho_tau", "phosphotau", "phospho")):
        return "phospho_tau"
    if any(token in key for token in ("abeta", "a_beta", "amyloid", "beta_amyloid")):
        return "amyloid_beta"
    if any(token in key for token in ("t_tau", "ttau", "total_tau", "totaltau")):
        return "total_tau"
    if re.search(r"(^|_)tau($|_)", key) and "p_tau" not in key and "ptau" not in key:
        return "total_tau"
    if any(token in key for token in ("disease", "diagnosis", "adstatus", "classification", "case_control", "casecontrol")) or key in {"group", "status", "ad"}:
        return "disease_status"
    return key


def _trait_output_stem(trait_name: str, folder: str) -> str:
    key = _normalize_trait_key(trait_name)
    if folder == "disease_status":
        if "ad" in key and "age" not in key:
            return "AD"
        if "disease" in key:
            return "Disease"
    elif folder == "total_tau":
        stem = "T_TAU"
        if "raw" in key:
            stem += "_raw"
        elif any(token in key for token in ("std", "standard", "zscore", "z_score")):
            stem += "_std"
        return stem
    elif folder == "phospho_tau":
        stem = "P_TAU"
        if "raw" in key:
            stem += "_raw"
        elif any(token in key for token in ("std", "standard", "zscore", "z_score")):
            stem += "_std"
        return stem
    elif folder == "amyloid_beta":
        stem = "ABETA42" if "42" in key else "AMYLOID_BETA"
        if "raw" in key:
            stem += "_raw"
        elif any(token in key for token in ("std", "standard", "zscore", "z_score")):
            stem += "_std"
        elif "ratio" in key:
            stem += "_ratio"
        return stem
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", str(trait_name or "Trait")).strip("_")
    return cleaned or "Trait"


def _unique_trait_stem(trait_name: str, folder: str, used_stems: set[str]) -> str:
    base = _trait_output_stem(trait_name, folder)
    stem = base
    if stem in used_stems:
        suffix = re.sub(r"[^A-Za-z0-9]+", "_", trait_name).strip("_") or "Trait"
        stem = f"{base}_{suffix}"
    counter = 2
    original = stem
    while stem in used_stems:
        stem = f"{original}_{counter}"
        counter += 1
    used_stems.add(stem)
    return stem


def _trait_folder_title(folder: str) -> str:
    return {
        "disease_status": "Disease Status",
        "total_tau": "Total Tau",
        "phospho_tau": "Phospho-Tau",
        "amyloid_beta": "Amyloid Beta",
        "all_traits_comprehensive": "All Traits",
        "ad_pathology_composite": "AD Pathology Composite",
    }.get(folder, folder.replace("_", " ").title())


def _generic_trait_label(folder: str) -> str:
    """PascalCase-ish label suitable for embedding in deliverable PDF filenames."""
    parts = re.split(r"[^A-Za-z0-9]+", folder.replace("_", " "))
    cleaned = [p for p in parts if p]
    return "_".join(p[:1].upper() + p[1:] for p in cleaned) or "Trait"


def _trait_correlation_pdf_name(prefix: str, folder: str) -> str | None:
    named = {
        "disease_status": f"{prefix}_WGCNA_04_Disease_Trait_Correlations.pdf",
        "total_tau": f"{prefix}_WGCNA_04_Total_Tau_Correlations.pdf",
        "phospho_tau": f"{prefix}_WGCNA_04_Phospho_Tau_Correlations.pdf",
        "amyloid_beta": f"{prefix}_WGCNA_04_Amyloid_Trait_Correlations.pdf",
    }
    if folder in named:
        return named[folder]
    if folder in {"all_traits_comprehensive", "ad_pathology_composite"}:
        return None
    return f"{prefix}_WGCNA_04_{_generic_trait_label(folder)}_Correlations.pdf"


def _trait_response_pdf_name(prefix: str, folder: str) -> str | None:
    named = {
        "total_tau": f"{prefix}_WGCNA_05_Total_Tau_Response_Plots.pdf",
        "phospho_tau": f"{prefix}_WGCNA_05_Phospho_Tau_Response_Plots.pdf",
        "amyloid_beta": f"{prefix}_WGCNA_05_Amyloid_Response_Plots.pdf",
    }
    if folder in named:
        return named[folder]
    if folder in {"disease_status", "all_traits_comprehensive", "ad_pathology_composite"}:
        return None
    return f"{prefix}_WGCNA_05_{_generic_trait_label(folder)}_Response_Plots.pdf"


def _copy_wgcna_shared_files(network_dir: Path, prefix: str, trait_dir: Path) -> None:
    shared = [
        (f"{prefix}_WGCNA_01_Sample_Clustering_QC.pdf", f"{prefix}_WGCNA_01_Sample_Clustering_QC.pdf"),
        (f"{prefix}_WGCNA_02_Power_Selection.pdf", f"{prefix}_WGCNA_02_Power_Selection.pdf"),
        (f"{prefix}_WGCNA_03_Network_Dendrograms.pdf", f"{prefix}_WGCNA_03_Network_Dendrograms.pdf"),
        (f"{prefix}_WGCNA_Module_Eigengenes.csv", f"{prefix}_WGCNA_Module_Eigengenes.csv"),
    ]
    for source_name, target_name in shared:
        _copy_if_exists(network_dir / source_name, trait_dir / target_name)
    assignment_source = network_dir / f"{prefix}_WGCNA_Module_Assignments_with_kME.csv"
    if not assignment_source.exists():
        candidates = sorted(network_dir.glob(f"{prefix}_WGCNA_Module_Assignments-*M.csv"))
        assignment_source = candidates[0] if candidates else assignment_source
    _copy_if_exists(assignment_source, trait_dir / f"{prefix}_WGCNA_Module_Assignments.csv")


def _plot_trait_correlation_heatmap(module_trait_df: pd.DataFrame, trait_names: list[str], title: str, output_pdf: Path) -> None:
    if module_trait_df.empty or not trait_names:
        return
    rows: list[dict[str, float]] = []
    p_rows: list[dict[str, float]] = []
    modules: list[str] = []
    for _, row in module_trait_df.iterrows():
        module = str(row.get("module_color", "")).strip()
        if not module:
            continue
        modules.append(module)
        rows.append({trait: pd.to_numeric(pd.Series([row.get(f"cor_{trait}")]), errors="coerce").iloc[0] for trait in trait_names})
        p_rows.append({trait: pd.to_numeric(pd.Series([row.get(f"p_{trait}")]), errors="coerce").iloc[0] for trait in trait_names})
    if not rows:
        return

    corr = pd.DataFrame(rows, index=modules).apply(pd.to_numeric, errors="coerce").fillna(0.0)
    pvals = pd.DataFrame(p_rows, index=modules).apply(pd.to_numeric, errors="coerce")

    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig_width = max(7.5, 2.2 * len(trait_names) + 4.5)
    fig_height = max(8.0, 0.34 * len(modules) + 2.5)
    fig, ax = plt.subplots(figsize=(fig_width, fig_height))
    image = ax.imshow(corr.values, aspect="auto", cmap="RdBu_r", vmin=-1, vmax=1)
    ax.set_title(title)
    ax.set_xticks(range(len(trait_names)))
    ax.set_xticklabels([str(name).replace("_", " ") for name in trait_names], rotation=42, ha="right", fontsize=9)
    display_modules = [_strip_me_prefix(module) for module in modules]
    ax.set_yticks(range(len(modules)))
    ax.set_yticklabels(display_modules, fontsize=8)
    for label, module in zip(ax.get_yticklabels(), display_modules):
        css_color = MODULE_COLOR_MAP.get(module.lower())
        if css_color and module.lower() not in {"white", "lightyellow", "floralwhite"}:
            label.set_color(css_color)

    if len(modules) * len(trait_names) <= 260:
        for row_idx, module in enumerate(modules):
            for col_idx, trait in enumerate(trait_names):
                p_val = pvals.loc[module, trait]
                p_text = "" if pd.isna(p_val) else f"\n({p_val:.1g})"
                ax.text(col_idx, row_idx, f"{corr.loc[module, trait]:.2g}{p_text}", ha="center", va="center", fontsize=6.5, color="#1e1a17")
    fig.colorbar(image, ax=ax, fraction=0.028, pad=0.02)
    fig.subplots_adjust(left=0.24, right=0.94, bottom=0.18, top=0.92)
    output_pdf.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_pdf, bbox_inches="tight")
    plt.close(fig)


def _write_trait_associated_module_csv(
    module_trait_df: pd.DataFrame,
    trait_name: str,
    folder: str,
    output_csv: Path,
    *,
    correlation_cutoff: float = 0.3,
    p_threshold: float = 0.05,
) -> None:
    cor_col = f"cor_{trait_name}"
    p_col = f"p_{trait_name}"
    rows: list[dict[str, Any]] = []
    if cor_col in module_trait_df.columns and p_col in module_trait_df.columns:
        for _, row in module_trait_df.iterrows():
            cor_val = pd.to_numeric(pd.Series([row.get(cor_col)]), errors="coerce").iloc[0]
            p_val = pd.to_numeric(pd.Series([row.get(p_col)]), errors="coerce").iloc[0]
            if pd.isna(cor_val) or pd.isna(p_val) or abs(float(cor_val)) < correlation_cutoff or float(p_val) >= p_threshold:
                continue
            module = str(row.get("module_color", ""))
            payload: dict[str, Any] = {
                "Module": module,
                "Correlation": round(float(cor_val), 6),
                "P_Value": float(p_val),
            }
            if folder == "total_tau":
                payload["Biological_Process"] = "Neurodegeneration"
            elif folder == "phospho_tau":
                payload["Biological_Process"] = "AD_Tangle_Pathology"
            elif folder == "amyloid_beta":
                payload["Effect"] = "Higher_with_Higher_Amyloid" if float(cor_val) > 0 else "Lower_with_Higher_Amyloid"
            else:
                label = "AD" if "ad" in _normalize_trait_key(trait_name) and "age" not in _normalize_trait_key(trait_name) else trait_name.replace(" ", "_")
                payload["Direction"] = f"Upregulated_in_{label}" if float(cor_val) > 0 else f"Downregulated_in_{label}"
            rows.append(payload)

    output_csv.parent.mkdir(parents=True, exist_ok=True)
    if rows:
        pd.DataFrame(rows).sort_values("P_Value", ascending=True).to_csv(output_csv, index=False)
        return
    columns = ["Module", "Correlation", "P_Value"]
    if folder == "total_tau":
        columns.append("Biological_Process")
    elif folder == "phospho_tau":
        columns.append("Biological_Process")
    elif folder == "amyloid_beta":
        columns.append("Effect")
    else:
        columns.append("Direction")
    pd.DataFrame(columns=columns).to_csv(output_csv, index=False)


def _load_trait_values_for_response(run_dir: Path, trait_names: list[str]) -> pd.DataFrame:
    eigengenes_path = run_dir / "stage1" / "module_eigengenes.csv"
    traits_path = run_dir / "input" / "traits.csv"
    if not eigengenes_path.exists() or not traits_path.exists() or not trait_names:
        return pd.DataFrame()
    eigengenes = pd.read_csv(eigengenes_path)
    traits = pd.read_csv(traits_path)
    sample_col = next((column for column in ["SAMPLE_ID", "sample_name", "sample name", "Sample", "sample"] if column in traits.columns), None)
    if sample_col is None or "sample_name" not in eigengenes.columns:
        return pd.DataFrame()
    traits = traits.copy()
    traits["_sample_key"] = traits[sample_col].astype(str).str.strip()
    eigengenes = eigengenes.copy()
    eigengenes["_sample_key"] = eigengenes["sample_name"].astype(str).str.strip()
    wanted = ["_sample_key"] + [trait for trait in trait_names if trait in traits.columns]
    merged = eigengenes.merge(traits[wanted], on="_sample_key", how="inner", suffixes=("", "_trait"))
    return merged


def _plot_continuous_trait_response(run_dir: Path, trait_names: list[str], title: str, output_pdf: Path) -> None:
    merged = _load_trait_values_for_response(run_dir, trait_names)
    if merged.empty:
        return
    module_cols = [column for column in merged.columns if str(column).startswith("ME") and str(column).lower() != "megrey"]
    if not module_cols:
        return

    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.backends.backend_pdf import PdfPages
    from scipy import stats

    output_pdf.parent.mkdir(parents=True, exist_ok=True)
    plotted = False
    with PdfPages(output_pdf) as pdf:
        for trait_name in trait_names:
            if trait_name not in merged.columns:
                continue
            trait_values = pd.to_numeric(merged[trait_name], errors="coerce")
            valid_modules = []
            for module_col in module_cols:
                module_values = pd.to_numeric(merged[module_col], errors="coerce")
                valid_mask = trait_values.notna() & module_values.notna()
                if int(valid_mask.sum()) >= 4:
                    valid_modules.append(module_col)
            for start in range(0, len(valid_modules), 12):
                chunk = valid_modules[start : start + 12]
                if not chunk:
                    continue
                fig, axes = plt.subplots(4, 3, figsize=(13, 15), squeeze=False)
                fig.suptitle(f"{title}: {trait_name}", fontsize=14, fontweight="bold")
                for ax, module_col in zip(axes.ravel(), chunk):
                    module_values = pd.to_numeric(merged[module_col], errors="coerce")
                    valid_mask = trait_values.notna() & module_values.notna()
                    x = trait_values[valid_mask].astype(float)
                    y = module_values[valid_mask].astype(float)
                    groups = merged.loc[valid_mask, "group"].astype(str) if "group" in merged.columns else pd.Series(["sample"] * len(x))
                    colors = groups.map(lambda value: "#c0392b" if value.lower() not in {"control", "ctrl", "reference"} else "#1a56db").tolist()
                    ax.scatter(x, y, c=colors, s=28, alpha=0.82, edgecolors="white", linewidths=0.4)
                    if len(x) >= 2 and x.nunique() > 1:
                        slope, intercept = np.polyfit(x, y, 1)
                        xs = np.linspace(float(x.min()), float(x.max()), 50)
                        ax.plot(xs, slope * xs + intercept, color="#1e1a17", linewidth=1.2)
                    try:
                        corr = stats.pearsonr(x, y)
                        stat_text = f"r={corr.statistic:.2f}, p={corr.pvalue:.2g}"
                    except Exception:
                        stat_text = "r/p unavailable"
                    ax.set_title(f"{module_col}\n{stat_text}", fontsize=9)
                    ax.set_xlabel(trait_name, fontsize=8)
                    ax.set_ylabel("Module Eigengene", fontsize=8)
                    ax.grid(alpha=0.18)
                for ax in axes.ravel()[len(chunk):]:
                    ax.axis("off")
                fig.tight_layout(rect=(0, 0, 1, 0.96))
                pdf.savefig(fig, bbox_inches="tight")
                plt.close(fig)
                plotted = True
    if not plotted:
        try:
            output_pdf.unlink()
        except FileNotFoundError:
            pass


def _has_usable_traits(traits_df: pd.DataFrame, min_non_null: int = 4) -> bool:
    """Return True iff at least one non-Sample column has >= min_non_null non-null values.

    Used to gate per-trait WGCNA deliverables: when False, the pipeline still emits
    all top-level WGCNA outputs but does not create per-trait subfolders or
    Associated_Modules.csv files.
    """
    candidate_cols = [c for c in traits_df.columns if str(c).lower() != "sample"]
    if not candidate_cols:
        return False
    for col in candidate_cols:
        try:
            if int(traits_df[col].notna().sum()) >= min_non_null:
                return True
        except Exception:
            continue
    return False


def emit_trait_specific_wgcna_bundle(run_dir: Path, profile: dict[str, Any], log_fn: Callable[[str], None]) -> None:
    prefix = profile["deliverable_prefix"]
    norm_tag = profile["normalization_tag"]
    network_dir = run_dir / f"05_network_{norm_tag}"
    module_trait_path = run_dir / "stage1" / "module_trait_cor.csv"
    if not network_dir.exists() or not module_trait_path.exists():
        return

    # Conditional gate: per-trait deliverables only emitted when usable trait
    # metadata is present. Top-level WGCNA outputs (01-05 PDFs, kME matrix,
    # hubs) are unaffected by this gate.
    expanded_traits_path = run_dir / "stage1" / "expanded_traits.csv"
    fallback_traits_path = run_dir / "input" / "traits.csv"
    traits_check_path = expanded_traits_path if expanded_traits_path.exists() else fallback_traits_path
    if traits_check_path.exists():
        try:
            check_df = pd.read_csv(traits_check_path)
            if not _has_usable_traits(check_df):
                log_fn(f"[{datetime.now().strftime('%H:%M:%S')}] No usable trait metadata; per-trait WGCNA deliverables skipped")
                return
        except Exception as exc:  # noqa: BLE001
            log_fn(f"[{datetime.now().strftime('%H:%M:%S')}] WARNING: could not read traits for gate ({exc}); proceeding")
    try:
        module_trait_df = pd.read_csv(module_trait_path)
    except Exception as error:
        log_fn(f"[{datetime.now().strftime('%H:%M:%S')}] WARNING: Could not read module-trait correlations for trait deliverables ({error})")
        return
    if "module_color" not in module_trait_df.columns:
        return

    trait_names = [column[4:] for column in module_trait_df.columns if str(column).startswith("cor_") and f"p_{column[4:]}" in module_trait_df.columns]
    if not trait_names:
        return

    bucketed: dict[str, list[str]] = {}
    for trait_name in trait_names:
        folder = _trait_folder_for_name(trait_name)
        if folder:
            bucketed.setdefault(folder, []).append(trait_name)

    folders_to_create = dict(bucketed)
    folders_to_create["all_traits_comprehensive"] = trait_names
    pathology_traits = [
        trait
        for folder, traits in bucketed.items()
        for trait in traits
        if _is_ad_bucket_folder(folder)
    ]
    if len(pathology_traits) >= 2:
        folders_to_create["ad_pathology_composite"] = pathology_traits

    # Single R invocation renders every per-trait PDF in one session. When R
    # is unavailable or fails, each folder's matplotlib helper produces the
    # missing PDFs as fallback below.
    r_succeeded = False
    try:
        _run_trait_viz_via_r(run_dir, profile, dict(folders_to_create), list(trait_names), log_fn)
        r_succeeded = True
    except RuntimeError as exc:
        log_fn(f"[{datetime.now().strftime('%H:%M:%S')}] WARNING: native R trait viz skipped ({exc}); using matplotlib fallback")

    for folder, traits in folders_to_create.items():
        trait_dir = network_dir / folder
        trait_dir.mkdir(parents=True, exist_ok=True)
        _copy_wgcna_shared_files(network_dir, prefix, trait_dir)

        if folder == "all_traits_comprehensive":
            _copy_if_exists(
                network_dir / f"{prefix}_WGCNA_04_Module_Trait_Correlations.pdf",
                trait_dir / f"{prefix}_WGCNA_04_All_Traits_Heatmap.pdf",
            )
            _copy_if_exists(
                network_dir / f"{prefix}_WGCNA_Complete_Results.xlsx",
                trait_dir / f"{prefix}_WGCNA_Complete_Results.xlsx",
            )
            continue
        if folder == "ad_pathology_composite":
            continue

        corr_pdf = _trait_correlation_pdf_name(prefix, folder)
        if corr_pdf:
            corr_target = trait_dir / corr_pdf
            # If R wrote the PDF, keep it; else generate via matplotlib fallback.
            if not corr_target.exists():
                _plot_trait_correlation_heatmap(
                    module_trait_df,
                    traits,
                    f"Module-{_trait_folder_title(folder)} Correlations",
                    corr_target,
                )
        response_pdf = _trait_response_pdf_name(prefix, folder)
        if response_pdf:
            response_target = trait_dir / response_pdf
            if not response_target.exists():
                _plot_continuous_trait_response(
                    run_dir,
                    traits,
                    f"Module {_trait_folder_title(folder)} Response Plots",
                    response_target,
                )

        used_stems: set[str] = set()
        for trait_name in traits:
            stem = _unique_trait_stem(trait_name, folder, used_stems)
            _write_trait_associated_module_csv(
                module_trait_df,
                trait_name,
                folder,
                trait_dir / f"{stem}_Associated_Modules.csv",
            )

    log_fn(f"[{datetime.now().strftime('%H:%M:%S')}] WGCNA trait-specific deliverables emitted (R viz: {'ok' if r_succeeded else 'fallback to matplotlib'}, {len(folders_to_create)} folders)")


def _compute_kme_matrix_python(normalized_matrix: pd.DataFrame, module_eigengenes: pd.DataFrame) -> pd.DataFrame:
    """Pearson correlate every peptide row with every module eigengene column.

    normalized_matrix: peptide x sample
    module_eigengenes: sample x ME (ME columns named MEcolor)

    Returns: peptide x kMEcolor DataFrame. Used as fallback when stage1/kme_matrix.csv
    is absent (R didn't run); produces the same peptide-row schema as the R signedKME write.
    """
    if normalized_matrix.empty or module_eigengenes.empty:
        return pd.DataFrame()
    common = [s for s in module_eigengenes.index if s in normalized_matrix.columns]
    if not common:
        return pd.DataFrame()
    X = normalized_matrix[common]
    Y = module_eigengenes.loc[common]

    X_centered = X.sub(X.mean(axis=1), axis=0)
    Y_centered = Y.sub(Y.mean(axis=0), axis=1)
    X_std = X_centered.std(axis=1, ddof=0).replace(0, np.nan)
    Y_std = Y_centered.std(axis=0, ddof=0).replace(0, np.nan)
    X_norm = X_centered.div(X_std, axis=0).fillna(0.0)
    Y_norm = Y_centered.div(Y_std, axis=1).fillna(0.0)

    n = len(common)
    kme = X_norm.values @ Y_norm.values / n
    columns = [str(c).replace("ME", "kME", 1) if str(c).startswith("ME") else f"kME{c}" for c in Y.columns]
    return pd.DataFrame(kme, index=X.index, columns=columns)


def _build_hub_tables(module_assignments: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    if module_assignments.empty:
        empty = pd.DataFrame(columns=["module_color", "gene", "peptide_id", "kME", "hub_rank"])
        return empty, empty
    ordered = module_assignments.copy()
    ordered["abs_kME"] = ordered["kME"].abs()
    ordered = ordered[ordered["module_color"].astype(str).str.lower() != "grey"]
    ordered = ordered.sort_values(["module_color", "abs_kME"], ascending=[True, False])
    ordered["hub_rank"] = ordered.groupby("module_color").cumcount() + 1
    stats = (
        ordered.groupby("module_color")
        .agg(
            n_members=("peptide_id", "count"),
            top_kME=("abs_kME", "max"),
            median_kME=("abs_kME", "median"),
        )
        .reset_index()
    )
    hub_counts = ordered.groupby("module_color").size().clip(upper=10).astype(int).reset_index(name="n_hubs_top10")
    stats = stats.merge(hub_counts, on="module_color", how="left")
    return stats, ordered.drop(columns=["abs_kME"])


def emit_pipeline_html_bundle(run_dir: Path, profile: dict[str, Any], log_fn: Callable[[str], None]) -> None:
    stage1_dir = run_dir / "stage1"
    stage2_dir = run_dir / "stage2"
    stage3_dir = run_dir / "stage3"

    summary_path = stage1_dir / "analysis_summary.json"
    volcano_path = stage1_dir / "volcano_results.tsv"
    go_path = stage2_dir / "go_zscore_matrix.csv"
    cell_path = stage3_dir / "celltype_FDR_matrix.csv"
    network_path = stage1_dir / "network_edges.csv"
    modules_path = stage1_dir / "module_assignments.csv"

    summary = json.loads(summary_path.read_text()) if summary_path.exists() else {}

    volcano_df = pd.read_csv(volcano_path, sep="\t") if volcano_path.exists() else pd.DataFrame()
    go_df = pd.read_csv(go_path, index_col=0) if go_path.exists() else pd.DataFrame()
    cell_df = pd.read_csv(cell_path, index_col=0) if cell_path.exists() else pd.DataFrame()
    network_df = pd.read_csv(network_path) if network_path.exists() else pd.DataFrame(columns=["source", "target", "weight"])
    module_df = pd.read_csv(modules_path) if modules_path.exists() else pd.DataFrame(columns=["module_color"])

    module_counts = (
        module_df[module_df["module_color"].astype(str).str.lower() != "grey"]["module_color"]
        .value_counts()
        .sort_index()
    )
    feature_label = "Number of proteins" if str(profile.get("input_level") or "").lower() == "protein" else "Number of peptides"
    module_css_colors = {
        str(module): MODULE_COLOR_MAP.get(str(module).lower(), str(module))
        for module in module_counts.index.tolist()
    }
    module_needs_border = {
        str(module): str(module).lower() in {"white", "floralwhite"}
        for module in module_counts.index.tolist()
    }

    dashboard_payload = {
        "generated_at": datetime.utcnow().isoformat(),
        "summary": summary,
        "volcano": {
            "x": volcano_df.get("log2fc", pd.Series(dtype=float)).fillna(0.0).round(4).tolist(),
            "y": (-np.log10(volcano_df.get("adj_pvalue", pd.Series(dtype=float)).clip(lower=1e-300))).replace([np.inf, -np.inf], 0).fillna(0.0).round(4).tolist()
            if not volcano_df.empty
            else [],
            "text": volcano_df.get("gene", pd.Series(dtype=str)).fillna(volcano_df.get("peptide_id", pd.Series(dtype=str))).astype(str).tolist()
            if not volcano_df.empty
            else [],
            "significant": volcano_df.get("significant", pd.Series(dtype=int)).fillna(0).astype(int).tolist()
            if not volcano_df.empty
            else [],
        },
        "network": {
            "module_counts": module_counts.to_dict(),
            "module_css_colors": module_css_colors,
            "module_needs_border": module_needs_border,
            "feature_label": feature_label,
            "edges": network_df.fillna("").to_dict(orient="records"),
        },
        "go": {
            "terms": go_df.index.tolist()[:50],
            "modules": go_df.columns.tolist()[:30],
            "z": go_df.iloc[:50, :30].fillna(0.0).round(4).values.tolist() if not go_df.empty else [],
        },
        "cells": {
            "modules": cell_df.index.tolist()[:40],
            "types": cell_df.columns.tolist()[:20],
            "z": cell_df.iloc[:40, :20].fillna(0.0).round(4).values.tolist() if not cell_df.empty else [],
        },
    }

    (run_dir / "dashboard_data.js").write_text(
        "window.PROTEOMICS_DASHBOARD = " + json.dumps(dashboard_payload, indent=2) + ";",
        encoding="utf-8",
    )

    title_prefix = profile["deliverable_prefix"]

    _inline_data_js = "window.PROTEOMICS_DASHBOARD = " + json.dumps(dashboard_payload) + ";"

    def html_shell(title: str, _unused_data_path: str, chart_blocks: str, script_body: str) -> str:
        return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title}</title>
  <script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
  <script>{_inline_data_js}</script>
  <style>
    html, body {{
      height: 100%;
      margin: 0;
    }}
    body {{
      font-family: Inter, system-ui, sans-serif;
      background: #f5f2ee;
      color: #2a2420;
      padding: 24px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
    }}
    .header {{
      margin-bottom: 22px;
      flex-shrink: 0;
    }}
    .eyebrow {{
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 12px;
      color: #7c5c3e;
      margin-bottom: 8px;
      font-weight: 700;
    }}
    .cards {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }}
    .card {{
      background: white;
      border: 1px solid #ddd8d0;
      border-radius: 12px;
      padding: 16px;
    }}
    .card .num {{
      font-size: 28px;
      font-weight: 800;
      color: #7c5c3e;
    }}
    .card .label {{
      color: #7a6e65;
      font-size: 13px;
      margin-top: 4px;
    }}
    .grid {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
      gap: 16px;
      flex: 1;
    }}
    .panel {{
      background: white;
      border: 1px solid #ddd8d0;
      border-radius: 14px;
      padding: 16px;
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: auto;
    }}
    .plot {{
      flex: 1;
      min-height: 380px;
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }}
    th, td {{
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid #ede9e3;
    }}
    th {{
      color: #7a6e65;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }}
  </style>
</head>
<body>
  {chart_blocks}
  <script>
    const DATA = window.PROTEOMICS_DASHBOARD || {{}};
    {script_body}
  </script>
</body>
</html>
"""

    dashboard_html = html_shell(
        f"{title_prefix} Interactive Dashboard",
        "dashboard_data.js",
        """
        <div class="header">
          <div class="eyebrow">Pipeline-native dashboard</div>
          <h1 style="margin:0;font-size:34px">ProteomicsAI Deliverables</h1>
          <p style="color:#7a6e65;max-width:860px">This dashboard is generated from the run artifacts themselves and travels with the deliverable bundle.</p>
        </div>
        <div class="cards" id="summaryCards"></div>
        <div class="grid">
          <div class="panel"><h3>Interactive volcano</h3><div class="plot" id="volcanoPlot"></div></div>
          <div class="panel"><h3>Module sizes</h3><div class="plot" id="networkBars"></div></div>
          <div class="panel"><h3>GO heatmap</h3><div class="plot" id="goHeatmap"></div></div>
          <div class="panel"><h3>Cell-type heatmap</h3><div class="plot" id="cellHeatmap"></div></div>
        </div>
        """,
        """
        const summary = DATA.summary || {};
        const summaryCards = document.getElementById('summaryCards');
        const cardData = [
          ['Significant', summary.peptides_significant || 0],
          ['Upregulated', summary.peptides_upregulated || 0],
          ['Downregulated', summary.peptides_downregulated || 0],
          ['Modules', summary.wgcna_modules || 0],
        ];
        summaryCards.innerHTML = cardData.map(([label, value]) => `<div class="card"><div class="num">${value}</div><div class="label">${label}</div></div>`).join('');

        const sigColors = (DATA.volcano?.significant || []).map((flag, index) => {
          if (!flag) return 'rgba(120,110,100,0.20)';
          return (DATA.volcano?.x || [])[index] >= 0 ? 'rgba(192,57,43,0.65)' : 'rgba(26,86,219,0.65)';
        });
        Plotly.newPlot('volcanoPlot', [{
          x: DATA.volcano?.x || [],
          y: DATA.volcano?.y || [],
          text: DATA.volcano?.text || [],
          mode: 'markers',
          type: 'scatter',
          marker: { size: 6, color: sigColors },
          hovertemplate: '<b>%{text}</b><br>log2FC=%{x:.3f}<br>-log10(FDR)=%{y:.3f}<extra></extra>'
        }], { paper_bgcolor: 'white', plot_bgcolor: 'white', margin: { t: 20, r: 20, b: 50, l: 55 }, xaxis: { title: 'Log2 fold change' }, yaxis: { title: '-log10(FDR)' } }, { responsive: true });

        const modules = Object.keys(DATA.network?.module_counts || {});
        const counts = modules.map((key) => DATA.network.module_counts[key]);
        const moduleColors = DATA.network?.module_css_colors || {};
        Plotly.newPlot('networkBars', [{
          x: modules,
          y: counts,
          type: 'bar',
          marker: { color: modules.map((key) => moduleColors[key] || '#7c5c3e') },
          hovertemplate: '%{x}<br>%{y} members<extra></extra>'
        }], { paper_bgcolor: 'white', plot_bgcolor: 'white', margin: { t: 20, r: 10, b: 120, l: 75 }, xaxis: { tickangle: -35 }, yaxis: { title: DATA.network?.feature_label || 'Number of peptides' } }, { responsive: true });

        const goTerms = DATA.go?.terms || [];
        const goModules = DATA.go?.modules || [];
        const goLeftMargin = Math.min(920, Math.max(240, goTerms.reduce((max, term) => Math.max(max, String(term).length), 0) * 6.8));
        const goWidth = Math.max(1040, goLeftMargin + (goModules.length * 36) + 220);
        const goHeight = Math.max(620, (goTerms.length * 22) + 170);
        Plotly.newPlot('goHeatmap', [{
          z: DATA.go?.z || [],
          x: goModules,
          y: goTerms,
          type: 'heatmap',
          colorscale: 'RdBu'
        }], {
          paper_bgcolor: 'white',
          plot_bgcolor: 'white',
          autosize: false,
          width: goWidth,
          height: goHeight,
          margin: { t: 28, r: 40, b: 120, l: goLeftMargin },
          xaxis: { automargin: true, tickangle: -35 },
          yaxis: { automargin: true }
        }, { responsive: false });

        Plotly.newPlot('cellHeatmap', [{
          z: DATA.cells?.z || [],
          x: DATA.cells?.types || [],
          y: DATA.cells?.modules || [],
          type: 'heatmap',
          colorscale: 'Tealrose'
        }], { paper_bgcolor: 'white', plot_bgcolor: 'white', margin: { t: 20, r: 10, b: 80, l: 120 } }, { responsive: true });
        """,
    )
    (run_dir / f"{title_prefix}_Interactive_Dashboard.html").write_text(dashboard_html, encoding="utf-8")

    volcano_html = html_shell(
        f"{title_prefix} Interactive Volcano Plot",
        "../dashboard_data.js",
        '<div class="panel"><div class="eyebrow">Pipeline-native volcano</div><h1 style="margin:0 0 14px">Interactive Volcano Plot</h1><div class="plot" id="volcanoPlot"></div></div>',
        """
        const sigColors = (DATA.volcano?.significant || []).map((flag, index) => {
          if (!flag) return 'rgba(120,110,100,0.20)';
          return (DATA.volcano?.x || [])[index] >= 0 ? 'rgba(192,57,43,0.65)' : 'rgba(26,86,219,0.65)';
        });
        Plotly.newPlot('volcanoPlot', [{
          x: DATA.volcano?.x || [],
          y: DATA.volcano?.y || [],
          text: DATA.volcano?.text || [],
          mode: 'markers',
          type: 'scatter',
          marker: { size: 6, color: sigColors },
          hovertemplate: '<b>%{text}</b><br>log2FC=%{x:.3f}<br>-log10(FDR)=%{y:.3f}<extra></extra>'
        }], { paper_bgcolor: 'white', plot_bgcolor: 'white', margin: { t: 20, r: 20, b: 50, l: 55 }, xaxis: { title: 'Log2 fold change' }, yaxis: { title: '-log10(FDR)' } }, { responsive: true });
        """,
    )
    (stage1_dir / f"{title_prefix}_Interactive_Volcano_Plot.html").write_text(volcano_html, encoding="utf-8")

    network_html = html_shell(
        f"{title_prefix} WGCNA Interactive Network",
        "../dashboard_data.js",
        '<div class="panel"><div class="eyebrow">Pipeline-native WGCNA</div><h1 style="margin:0 0 14px">Module Network Overview</h1><div class="plot" id="networkBars"></div></div>',
        """
        const modules = Object.keys(DATA.network?.module_counts || {});
        const counts = modules.map((key) => DATA.network.module_counts[key]);
        const moduleColors = DATA.network?.module_css_colors || {};
        Plotly.newPlot('networkBars', [{
          x: modules,
          y: counts,
          type: 'bar',
          marker: { color: modules.map((key) => moduleColors[key] || '#7c5c3e') }
        }], { paper_bgcolor: 'white', plot_bgcolor: 'white', margin: { t: 20, r: 10, b: 90, l: 75 }, xaxis: { tickangle: -35 }, yaxis: { title: DATA.network?.feature_label || 'Number of peptides' } }, { responsive: true });
        """,
    )
    (stage1_dir / f"{title_prefix}_WGCNA_Interactive_Network.html").write_text(network_html, encoding="utf-8")

    go_html = html_shell(
        f"{title_prefix} GO Interactive Heatmap",
        "../dashboard_data.js",
        '<div class="panel"><div class="eyebrow">Pipeline-native GO</div><h1 style="margin:0 0 14px">GO Heatmap</h1><div class="plot" id="goHeatmap"></div></div>',
        """
        const goTerms = DATA.go?.terms || [];
        const goModules = DATA.go?.modules || [];
        const goLeftMargin = Math.min(920, Math.max(240, goTerms.reduce((max, term) => Math.max(max, String(term).length), 0) * 6.8));
        const goWidth = Math.max(1040, goLeftMargin + (goModules.length * 36) + 220);
        const goHeight = Math.max(620, (goTerms.length * 22) + 170);
        Plotly.newPlot('goHeatmap', [{
          z: DATA.go?.z || [],
          x: goModules,
          y: goTerms,
          type: 'heatmap',
          colorscale: 'RdBu'
        }], {
          paper_bgcolor: 'white',
          plot_bgcolor: 'white',
          autosize: false,
          width: goWidth,
          height: goHeight,
          margin: { t: 28, r: 40, b: 120, l: goLeftMargin },
          xaxis: { automargin: true, tickangle: -35 },
          yaxis: { automargin: true }
        }, { responsive: false });
        """,
    )
    (stage2_dir / f"{title_prefix}_GO_Interactive_Heatmap.html").write_text(go_html, encoding="utf-8")

    cell_html = html_shell(
        f"{title_prefix} CellTypeFET Interactive Heatmap",
        "../dashboard_data.js",
        '<div class="panel"><div class="eyebrow">Pipeline-native CellTypeFET</div><h1 style="margin:0 0 14px">Cell-type Heatmap</h1><div class="plot" id="cellHeatmap"></div></div>',
        """
        Plotly.newPlot('cellHeatmap', [{
          z: DATA.cells?.z || [],
          x: DATA.cells?.types || [],
          y: DATA.cells?.modules || [],
          type: 'heatmap',
          colorscale: 'Tealrose'
        }], { paper_bgcolor: 'white', plot_bgcolor: 'white', margin: { t: 20, r: 10, b: 90, l: 130 } }, { responsive: true });
        """,
    )
    (stage3_dir / f"{title_prefix}_CellTypeFET_Interactive_Heatmap.html").write_text(cell_html, encoding="utf-8")

    # Generate parameter audit page for deliverable bundle
    # Source of truth: params.json is the frozen snapshot written at pipeline start
    params_file = run_dir / "params.json"
    bundle_params = json.loads(params_file.read_text()) if params_file.exists() else {}
    # app_version comes from params or from analysis_summary
    bundle_version = bundle_params.get("app_version", "")
    if not bundle_version:
        summary_file = run_dir / "analysis_summary.json"
        if summary_file.exists():
            try:
                bundle_version = json.loads(summary_file.read_text()).get("app_version", "")
            except Exception:
                pass
    param_section_html = _render_parameter_page(bundle_params, bundle_version)
    params_html = html_shell(
        f"{title_prefix} Pipeline Parameters",
        "dashboard_data.js",
        param_section_html,
        "",  # no JS needed for static parameter table
    )
    (run_dir / f"{title_prefix}_Pipeline_Parameters.html").write_text(params_html, encoding="utf-8")

    log_fn(f"[{datetime.now().strftime('%H:%M:%S')}] Pipeline-native interactive HTML artifacts generated")


_TOP_HUB_N = 10  # hub proteins per module per trait sheet


def _safe_sheet_name(trait_name: str, used: set) -> str:
    """Return a valid Excel worksheet name <= 31 chars for a trait hub sheet."""
    suffix = "_Hub_Proteins"  # 13 chars
    cleaned = re.sub(r'[\[\]:*?/\\]', '_', trait_name)
    max_trait_len = 31 - len(suffix)  # 18
    truncated = cleaned[:max_trait_len]
    sheet = truncated + suffix
    if sheet in used:
        for i in range(2, 100):
            tag = str(i)
            candidate = cleaned[:max_trait_len - len(tag)] + tag + suffix
            if candidate not in used:
                sheet = candidate
                break
    used.add(sheet)
    return sheet


def _build_hub_sheet(trait_df: pd.DataFrame, ma_df: pd.DataFrame, top_n: int = _TOP_HUB_N) -> pd.DataFrame:
    """Join trait associations with module assignments to produce hub protein rows.

    CRITICAL: trait_df 'Module' column carries ME prefix (e.g. MEblue).
    ma_df 'module_color' column uses bare names (e.g. blue).
    Strip prefix BEFORE join or the result is silently empty.
    """
    rows: list = []
    for _, t_row in trait_df.iterrows():
        module_color = str(t_row["Module"]).removeprefix("ME")
        mod_peps = (
            ma_df[ma_df["module_color"] == module_color]
            .sort_values("kME", ascending=False)
            .head(top_n)
        )
        for rank, (_, p_row) in enumerate(mod_peps.iterrows(), start=1):
            rows.append({
                "module": module_color,
                "direction": t_row["Direction"],
                "module_correlation": round(float(t_row["Correlation"]), 6),
                "gene": p_row["gene"],
                "peptide_id": p_row["peptide_id"],
                "kME": round(float(p_row["kME"]), 6),
                "hub_rank": rank,
            })
    return pd.DataFrame(rows)


def generate_complete_results_xlsx(run_dir: Path, profile: dict[str, Any], params: dict[str, Any]) -> None:
    """DEL-02: Single-file Excel export with 4 sheets from pipeline stages."""
    prefix = profile["deliverable_prefix"]
    norm_tag = profile["normalization_tag"]
    network_dir = run_dir / f"05_network_{norm_tag}"
    network_dir.mkdir(parents=True, exist_ok=True)
    out_path = network_dir / f"{prefix}_WGCNA_Complete_Results.xlsx"

    module_assignments_path = run_dir / "stage1" / "module_assignments.csv"
    go_zscore_path = run_dir / "stage2" / "go_zscore_matrix.csv"
    celltype_path = run_dir / "stage3" / "celltype_FDR_matrix.csv"
    trait_dir = run_dir / "stage1" / "trait_associations"

    sheets: dict[str, pd.DataFrame] = {}

    ma_df: pd.DataFrame | None = None
    if module_assignments_path.exists():
        ma_df = pd.read_csv(module_assignments_path)
        sheets["Module_Assignments"] = ma_df

    if go_zscore_path.exists():
        sheets["GO_Enrichment_ZScores"] = pd.read_csv(go_zscore_path, index_col=0).reset_index().rename(columns={"index": "term"})

    if celltype_path.exists():
        sheets["CellType_FET"] = pd.read_csv(celltype_path, index_col=0).reset_index().rename(columns={"index": "module"})

    if trait_dir.exists():
        trait_frames = []
        for trait_file in sorted(trait_dir.glob("*_Associated_Modules.csv")):
            trait_name = trait_file.stem.replace("_Associated_Modules", "")
            df = pd.read_csv(trait_file)
            df.insert(0, "trait", trait_name)
            trait_frames.append(df)
        if trait_frames:
            sheets["Trait_Associated_Modules"] = pd.concat(trait_frames, ignore_index=True)

    # HUB-01: Per-trait hub protein sheets
    if trait_dir.exists() and ma_df is not None:
        used_names: set = set(sheets.keys())
        for trait_file in sorted(trait_dir.glob("*_Associated_Modules.csv")):
            trait_name = trait_file.stem.replace("_Associated_Modules", "")
            t_df = pd.read_csv(trait_file)
            hub_df = _build_hub_sheet(t_df, ma_df)
            if not hub_df.empty:
                sheet_name = _safe_sheet_name(trait_name, used_names)
                sheets[sheet_name] = hub_df

    if not sheets:
        return  # Nothing to write -- graceful skip when all stages failed

    with pd.ExcelWriter(out_path, engine="openpyxl") as writer:
        for sheet_name, df in sheets.items():
            df.to_excel(writer, sheet_name=sheet_name, index=False)


def generate_volcano_summary(run_dir: Path, profile: dict[str, Any], params: dict[str, Any]) -> None:
    """DEL-03: Plain-text volcano summary with peptide counts."""
    summary_path = run_dir / "stage1" / "analysis_summary.json"
    if not summary_path.exists():
        return
    summary = json.loads(summary_path.read_text())
    prefix = profile["deliverable_prefix"]
    cohort2 = params.get("cohort2") or summary.get("cohort2") or "Disease"
    total = summary.get("peptides_total", 0)
    up = summary.get("peptides_upregulated", 0)
    down = summary.get("peptides_downregulated", 0)
    sig = summary.get("peptides_significant", 0)
    pct = round(100 * sig / total, 1) if total > 0 else 0.0
    use_adj = summary.get("use_adjusted_pvalue", True)
    pval_thresh = summary.get("pvalue_threshold", 0.05)
    fc_thresh = summary.get("fold_change_threshold", 1.5)
    log2fc_thresh = round(math.log2(fc_thresh), 2) if fc_thresh > 0 else 0.58
    adj_label = "FDR-adjusted p-value" if use_adj else "p-value"

    lines = [
        f"{prefix} VOLCANO PLOT ANALYSIS SUMMARY",
        "===================================",
        f"Total peptides analyzed: {total}",
        f"Significance criteria: {adj_label} < {pval_thresh} AND |Log2FC| > {log2fc_thresh}",
        f"Upregulated in {cohort2}: {up}",
        f"Downregulated in {cohort2}: {down}",
        f"Total significant: {sig}",
        f"Percentage significant: {pct}%",
        "===================================",
    ]
    out_path = run_dir / "stage1" / "volcano_summary.txt"
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def emit_legacy_bundle(run_dir: Path, profile: dict[str, Any], params: dict[str, Any], log_fn: Callable[[str], None]) -> None:
    prefix = profile["deliverable_prefix"]
    display_prefix = profile["display_prefix"]
    go_label = profile["go_label"]
    norm_tag = profile["normalization_tag"]
    cohort2 = _safe_name(params.get("cohort2") or "Disease")

    input_dir = run_dir / "01_input"
    normalized_dir = run_dir / f"02_normalized_{norm_tag}"
    analysis_dir = run_dir / f"03_analysis_{norm_tag}"
    network_dir = run_dir / f"05_network_{norm_tag}"
    go_dir = run_dir / f"{display_prefix} Go"
    cell_dir = run_dir / f"{display_prefix} CellTypeFET"

    for directory in (input_dir, normalized_dir, analysis_dir, network_dir, go_dir, cell_dir):
        directory.mkdir(parents=True, exist_ok=True)

    _copy_if_exists(run_dir / "input" / "cleaned_matrix.csv", input_dir / f"{prefix}_Abundance_Matrix.csv")
    _copy_if_exists(run_dir / "input" / "traits.csv", input_dir / f"{prefix}_Sample_Traits_Data.csv")
    _copy_if_exists(run_dir / "input" / "sample_metadata.csv", normalized_dir / f"{prefix}_Sample_Metadata.csv")
    _copy_if_exists(run_dir / "input" / "traits.csv", normalized_dir / f"{prefix}_Sample_Traits_Data.csv")
    _copy_if_exists(run_dir / "stage1" / "normalized_matrix.csv", normalized_dir / f"{prefix}_Normalized_Log2_Data.csv")
    _copy_if_exists(run_dir / "stage1" / "normalized_linear_matrix.csv", normalized_dir / f"{prefix}_Normalized_Abundance_Data.csv")

    raw_input = run_dir / "input" / "cleaned_matrix.csv"
    normalized_input = run_dir / "stage1" / "normalized_matrix.csv"
    sample_metadata = run_dir / "input" / "sample_metadata.csv"
    if raw_input.exists() and normalized_input.exists() and sample_metadata.exists():
        raw_df = pd.read_csv(raw_input)
        normalized_df = pd.read_csv(normalized_input)
        sample_meta_df = pd.read_csv(sample_metadata)
        _plot_normalization_qc(raw_df, normalized_df, sample_meta_df, normalized_dir / f"{prefix}_CBN_Normalization_QC_Plots.pdf")
        _plot_mds_before_after(raw_df, normalized_df, sample_meta_df, normalized_dir / f"{prefix}_MDS_Before_After_Normalization.pdf")
        summary_text = (
            f"Normalization Summary\n"
            f"Profile: {profile['pipeline_profile']}\n"
            f"Normalization method: {params.get('normalization_method', 'median')}\n"
            f"Log handling: {'enabled' if params.get('log_transform', True) else 'disabled'}\n"
            f"Generated at: {datetime.utcnow().isoformat()}\n"
        )
        (normalized_dir / f"{prefix}_Normalization_Summary.txt").write_text(summary_text, encoding="utf-8")

    _copy_if_exists(run_dir / "stage1" / f"{prefix}_Interactive_Volcano_Plot.html", analysis_dir / f"{prefix}_Interactive_Volcano_Plot.html")
    _copy_if_exists(run_dir / "stage1" / "volcano_plot.pdf", analysis_dir / f"{prefix}_Volcano_Plot.pdf")
    if (run_dir / "stage1" / "volcano_results.tsv").exists():
        volcano_df = pd.read_csv(run_dir / "stage1" / "volcano_results.tsv", sep="\t")
        volcano_df.to_csv(analysis_dir / f"{prefix}_Volcano_Results_All.csv", index=False)
    _copy_if_exists(run_dir / "stage1" / "volcano_upregulated.csv", analysis_dir / f"{prefix}_Volcano_Upregulated_{cohort2}.csv")
    _copy_if_exists(run_dir / "stage1" / "volcano_downregulated.csv", analysis_dir / f"{prefix}_Volcano_Downregulated_{cohort2}.csv")
    # DEL-03: Generate summary text before the copy
    generate_volcano_summary(run_dir, profile, params)
    _copy_if_exists(run_dir / "stage1" / "volcano_summary.txt", analysis_dir / f"{prefix}_Volcano_Summary.txt")
    _copy_if_exists(run_dir / "input" / "traits.csv", analysis_dir / f"{prefix}_Sample_Traits_Data.csv")

    _copy_if_exists(run_dir / "stage1" / "module_assignments.csv", network_dir / f"{prefix}_WGCNA_Module_Assignments_with_kME.csv")
    _copy_if_exists(run_dir / "stage1" / "module_eigengenes.csv", network_dir / f"{prefix}_WGCNA_Module_Eigengenes.csv")
    _copy_if_exists(run_dir / "stage1" / "wgcna_dendrogram.pdf", network_dir / f"{prefix}_WGCNA_03_Network_Dendrograms.pdf")
    _copy_if_exists(run_dir / "stage1" / "module_trait_heatmap.pdf", network_dir / f"{prefix}_WGCNA_04_Module_Trait_Correlations.pdf")
    _copy_if_exists(run_dir / "stage1" / f"{prefix}_WGCNA_Interactive_Network.html", network_dir / f"{prefix}_WGCNA_Interactive_Network.html")

    # 01_Sample_Clustering_QC: prefer native R version from stage1_parity.R; fall back to matplotlib.
    stage1_qc_pdf = run_dir / "stage1" / "sample_clustering_qc.pdf"
    network_qc_pdf = network_dir / f"{prefix}_WGCNA_01_Sample_Clustering_QC.pdf"
    if stage1_qc_pdf.exists():
        shutil.copy2(stage1_qc_pdf, network_qc_pdf)
    elif normalized_input.exists() and sample_metadata.exists():
        _plot_sample_clustering(pd.read_csv(normalized_input), pd.read_csv(sample_metadata), network_qc_pdf)

    # 02_Power_Selection: prefer native R two-panel version; fall back to matplotlib single-panel.
    stage1_power_pdf = run_dir / "stage1" / "power_selection.pdf"
    network_power_pdf = network_dir / f"{prefix}_WGCNA_02_Power_Selection.pdf"
    if stage1_power_pdf.exists():
        shutil.copy2(stage1_power_pdf, network_power_pdf)
    else:
        _plot_power_selection_csv(run_dir / "stage1" / "wgcna_power_diagnostics.csv", network_power_pdf)

    if (run_dir / "stage1" / "module_assignments.csv").exists():
        module_assignments = pd.read_csv(run_dir / "stage1" / "module_assignments.csv")
        stats_df, hubs_df = _build_hub_tables(module_assignments)
        stats_df.to_csv(network_dir / f"{prefix}_WGCNA_Hub_Protein_Statistics.csv", index=False)
        hubs_df.to_csv(network_dir / f"{prefix}_WGCNA_All_Hub_Proteins.csv", index=False)

        # kME_Matrix.csv: prefer stage1/kme_matrix.csv (full peptide x module from
        # R signedKME); fall back to Python pearson computation if R didn't run.
        # Bug fix: previously this wrote hubs_df (same as All_Hub_Proteins.csv) — wrong content.
        kme_target = network_dir / f"{prefix}_WGCNA_kME_Matrix.csv"
        stage1_kme_src = run_dir / "stage1" / "kme_matrix.csv"
        if stage1_kme_src.exists():
            shutil.copy2(stage1_kme_src, kme_target)
        else:
            try:
                normalized_path = run_dir / "stage1" / "normalized_matrix.csv"
                me_path = run_dir / "stage1" / "module_eigengenes.csv"
                if normalized_path.exists() and me_path.exists():
                    norm_df = pd.read_csv(normalized_path, index_col=0)
                    me_df = pd.read_csv(me_path)
                    if "sample_name" in me_df.columns:
                        me_df = me_df.set_index("sample_name")
                    me_only = me_df.drop(columns=[c for c in me_df.columns if str(c).lower() == "group"], errors="ignore")
                    me_numeric = me_only.select_dtypes(include="number")
                    kme = _compute_kme_matrix_python(norm_df, me_numeric)
                    if not kme.empty:
                        kme.index.name = "feature_id"
                        kme.to_csv(kme_target)
            except Exception as exc:  # noqa: BLE001 — fallback is best-effort
                pass  # silently skip; primary R path already failed if we got here

        module_count = max(1, module_assignments.loc[module_assignments["module_color"].astype(str).str.lower() != "grey", "module_color"].nunique())
        module_assignments.to_csv(network_dir / f"{prefix}_WGCNA_Module_Assignments-{module_count}M.csv", index=False)
        summary_path = run_dir / "stage1" / "analysis_summary.json"
        if summary_path.exists():
            summary_json = json.loads(summary_path.read_text())
            (network_dir / f"{prefix}_WGCNA_Analysis_Summary.txt").write_text(
                "\n".join(f"{key}: {value}" for key, value in summary_json.items()),
                encoding="utf-8",
            )

    # DEL-02: Single-file Excel export
    generate_complete_results_xlsx(run_dir, profile, params)

    module_response_pdf = run_dir / "stage1" / "module_response_plots.pdf"
    if module_response_pdf.exists():
        _copy_if_exists(module_response_pdf, network_dir / f"{prefix}_WGCNA_05_Module_Response_Plots.pdf")
    elif (run_dir / "stage1" / "module_trait_cor.csv").exists():
        trait_df = pd.read_csv(run_dir / "stage1" / "module_trait_cor.csv")
        _plot_module_response(trait_df, network_dir / f"{prefix}_WGCNA_05_Module_Response_Plots.pdf")

    emit_trait_specific_wgcna_bundle(run_dir, profile, log_fn)

    go_results = run_dir / "stage2" / "go_enrichment_all.csv"
    if go_results.exists():
        go_df = pd.read_csv(go_results)
        go_df.to_csv(go_dir / f"GSA-GO-FET_{go_label}_Proteomics_GO-Enr.FDR.BH.txt", sep="\t", index=False)
        _write_text_table(run_dir / "stage2" / "go_pvalues_matrix.csv", go_dir / f"GSA-GO-FET_{go_label}_Proteomics_GO-Enr.Pvalues.txt")
        _write_text_table(run_dir / "stage2" / "go_zscore_matrix_full.csv", go_dir / f"GSA-GO-FET_{go_label}_Proteomics_GO-Zscores.txt")
        for module_name, module_frame in go_df.groupby("module"):
            module_frame.to_csv(go_dir / f"{module_name}_Module.txt", sep="\t", index=False)
        if (run_dir / "stage2" / "go_zscore_matrix.csv").exists():
            zscore_df = pd.read_csv(run_dir / "stage2" / "go_zscore_matrix.csv", index_col=0)
            _plot_matrix_heatmap(
                zscore_df,
                go_dir / f"GSA-GO-FET_{go_label}_Proteomics_GO-redundancyRemoved.Kbest.pdf",
                "GO enrichment z-scores",
            )
            _plot_matrix_heatmap(
                zscore_df,
                go_dir / f"GO_cc_clustering_from_GSA_FET_Z-{go_label}_Proteomics_GO-redundancyRemoved.Kbest.pdf",
                "GO clustering heatmap",
            )
        _copy_if_exists(run_dir / "stage2" / f"{prefix}_GO_Interactive_Heatmap.html", go_dir / f"{prefix}_GO_Interactive_Heatmap.html")

    # Derive data type label and marker source from actual run config (DATA-05)
    data_type_label = "Proteins" if str(profile.get("input_level", "")).lower() == "protein" else "Peptides"
    marker_source = "CellTypeMarkers"  # default generic label
    config3_path = run_dir / "config_stage3.json"
    if config3_path.exists():
        try:
            config3 = json.loads(config3_path.read_text())
            markers_file = config3.get("celltype_markers_file", "")
            if markers_file:
                marker_source = Path(markers_file).stem
        except Exception:
            pass

    cell_matrix = run_dir / "stage3" / "celltype_FDR_matrix.csv"
    detail_path = run_dir / "stage3" / "celltype_heatmap_data.csv"
    if cell_matrix.exists():
        cell_df = pd.read_csv(cell_matrix, index_col=0)
        _plot_matrix_heatmap(cell_df, cell_dir / f"{prefix}_{data_type_label}_CellTypeFET.Overlap.pdf", "Cell-type enrichment")
        _plot_matrix_heatmap(cell_df.T, cell_dir / f"{prefix}_{data_type_label}_CellTypeFET_barChart.Overlap.pdf", "Cell-type enrichment overview")
        if detail_path.exists():
            detail_df = pd.read_csv(detail_path)
            detail_df.to_csv(
                cell_dir / f"{prefix}_{data_type_label}_CellTypeFET.Overlap.in.{marker_source}-hitListStats.csv",
                index=False,
            )
            detail_df.to_csv(
                cell_dir / f"{prefix}_{data_type_label}_CellTypeFET_barChart.Overlap.in.{marker_source}-hitListStats.csv",
                index=False,
            )
        for path in sorted((run_dir / "stage3").glob("celltype_hitListStats_*.csv")):
            suffix = path.stem.replace("celltype_hitListStats_", "")
            _copy_if_exists(
                path,
                cell_dir / f"{prefix}_{data_type_label}_CellTypeFET_{suffix}_hitListStats.csv",
            )
        _copy_if_exists(run_dir / "stage3" / f"{prefix}_CellTypeFET_Interactive_Heatmap.html", cell_dir / f"{prefix}_CellTypeFET_Interactive_Heatmap.html")

    log_fn(f"[{datetime.now().strftime('%H:%M:%S')}] Legacy-style deliverable bundle emitted")
