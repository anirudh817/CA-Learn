"""
Pure-Python proteomics analysis pipeline — 3 stages.

Stage 1: Normalization + Differential Expression + WGCNA-equivalent (correlation clustering)
Stage 2: GO Enrichment (FET against GMT gene set database)
Stage 3: Cell Type Enrichment (FET against cell type marker gene lists)

All biological reference data (GO terms, cell type markers) is loaded from
external files — nothing is hardcoded to a specific dataset or organism.
Users can supply their own GMT / marker files, or the bundled defaults are used.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import threading
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import numpy as np
import pandas as pd
from scipy import stats as _scipy_stats

from services.artifact_manifest import write_artifact_manifest
from services.artifacts import write_artifact_index
from services.deliverables import (
    emit_legacy_bundle,
    emit_pipeline_html_bundle,
    resolve_pipeline_profile,
    write_pipeline_profile,
)
from services.pipeline_stage2 import _load_gmt, run_stage2
from services.pipeline_stage3 import run_stage3
from services.pipeline_support import (
    append_log as _append_log,
    index_files as _index_files,
    set_stage_status as _set_stage_status,
    ts as _ts,
)

STAGE1_R_TIMEOUT_SECONDS = 7200  # 2 hours — RPIP-08
_OUTLIER_EVENTS: dict = {}  # run_id → threading.Event; held while pipeline awaits user review


def _read_json_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def _write_stats_control_audit(run_id: str, run_dir: Path, params: dict) -> dict[str, Any]:
    """Write requested-vs-effective statistical control metadata for a run."""
    stage1 = _read_json_file(run_dir / "stage1" / "analysis_summary.json")
    stage2 = _read_json_file(run_dir / "stage2" / "go_summary.json")
    stage3 = _read_json_file(run_dir / "stage3" / "celltype_summary.json")

    controls: list[dict[str, Any]] = []

    def add_control(
        key: str,
        requested: Any,
        effective: Any,
        stage: str,
        outputs: list[str],
        *,
        warnings: list[str] | None = None,
        status: str | None = None,
    ) -> None:
        if status is None:
            status = "applied" if requested == effective else "overridden"
        controls.append(
            {
                "key": key,
                "requested": requested,
                "effective": effective,
                "stage": stage,
                "status": status,
                "outputs_affected": outputs,
                "warnings": warnings or [],
            }
        )

    add_control(
        "normalization_method",
        params.get("normalization_method", "median"),
        stage1.get("normalization_method", params.get("normalization_method", "median")),
        "stage1",
        ["stage1/normalized_matrix.csv", "stage1/analysis_summary.json"],
    )
    add_control(
        "statistical_test",
        params.get("statistical_test", "t-test"),
        stage1.get("statistical_test", params.get("statistical_test", "t-test")),
        "stage1",
        ["stage1/volcano_results.tsv", "stage1/analysis_summary.json"],
    )
    add_control(
        "multiple_testing_method",
        params.get("multiple_testing_method", "fdr_bh"),
        stage1.get("multiple_testing_method", params.get("multiple_testing_method", "fdr_bh")),
        "stage1",
        ["stage1/volcano_results.tsv", "stage1/top_proteins.json", "stage1/analysis_summary.json"],
    )
    add_control(
        "wgcna_power",
        params.get("wgcna_power", 8),
        stage1.get("selected_wgcna_power", params.get("wgcna_power", 8)),
        "stage1",
        ["stage1/wgcna_power_diagnostics.csv", "stage1/module_assignments.csv", "stage1/analysis_summary.json"],
    )
    add_control(
        "wgcna_power_mode",
        params.get("wgcna_power_mode", "fixed"),
        stage1.get("wgcna_power_mode", params.get("wgcna_power_mode", "fixed")),
        "stage1",
        ["stage1/wgcna_power_diagnostics.csv", "stage1/analysis_summary.json"],
    )
    add_control(
        "tom_type",
        params.get("tom_type", "signed"),
        stage1.get("wgcna_tom_type", params.get("tom_type", "signed")),
        "stage1",
        ["stage1/module_assignments.csv", "stage1/analysis_summary.json"],
    )
    add_control(
        "pam_stage",
        params.get("pam_stage", True),
        stage1.get("wgcna_pam_stage", params.get("pam_stage", True)),
        "stage1",
        ["stage1/module_assignments.csv", "stage1/analysis_summary.json"],
    )
    add_control(
        "gmt_background_behavior",
        params.get("gmt_background_behavior", "measured_features"),
        stage2.get("background_mode", params.get("gmt_background_behavior", "measured_features")),
        "stage2",
        ["stage2/go_enrichment_all.csv", "stage2/go_summary.json"],
    )
    add_control(
        "remove_redundant_go",
        params.get("remove_redundant_go", "kappa"),
        stage2.get("redundancy_mode", params.get("remove_redundant_go", "kappa")),
        "stage2",
        ["stage2/go_enrichment_all.csv", "stage2/go_enrichment_redundancy_removed.csv", "stage2/go_summary.json"],
    )
    add_control(
        "celltype_reference",
        params.get("celltype_reference", "human_sharma_zhang_union"),
        stage3.get("reference", params.get("celltype_reference", "human_sharma_zhang_union")),
        "stage3",
        ["stage3/celltype_heatmap_data.csv", "stage3/celltype_summary.json"],
    )
    add_control(
        "celltype_duplicate_handling",
        params.get("celltype_duplicate_handling", "allow"),
        stage3.get("duplicate_handling", params.get("celltype_duplicate_handling", "allow")),
        "stage3",
        ["stage3/celltype_heatmap_data.csv", "stage3/celltype_summary.json"],
    )
    adjust_requested = bool(params.get("adjust_fet_lookup", False))
    adjust_effective = bool(stage3.get("adjust_fet_lookup_effective", False))
    add_control(
        "adjust_fet_lookup",
        adjust_requested,
        adjust_effective,
        "stage3",
        ["stage3/celltype_heatmap_data.csv", "stage3/celltype_summary.json"],
        warnings=stage3.get("warnings", []),
        status="applied" if adjust_requested == adjust_effective else "not_applicable",
    )
    add_control(
        "outlier_mode",
        params.get("outlier_mode", "low_connectivity"),
        "low_connectivity",
        "input",
        ["input/outlier_candidates.json"],
    )
    add_control(
        "variance_correction_enabled",
        bool(params.get("variance_correction_enabled", False)),
        False,
        "stage1",
        ["stage1/analysis_summary.json"],
        status="disabled" if params.get("variance_correction_enabled") else "not_applicable",
        warnings=[] if not params.get("variance_correction_enabled") else ["Variance correction is gated until covariate selection and model-rank checks are implemented."],
    )

    payload = {
        "version": "p3-stats-control-contract-v1",
        "run_id": run_id,
        "controls": controls,
    }
    (run_dir / "stats_control_audit.json").write_text(json.dumps(payload, indent=2))
    return payload


# ──────────────────────────────────────────────────────────────────────────────
# WGCNA MODULE COLOR NAMES  (standard WGCNA palette, ordered)
# ──────────────────────────────────────────────────────────────────────────────
WGCNA_COLORS = [
    "turquoise", "blue", "brown", "yellow", "green", "red", "black", "pink",
    "magenta", "purple", "greenyellow", "tan", "salmon", "cyan", "midnightblue",
    "lightcyan", "grey60", "lightgreen", "lightyellow", "royalblue",
    "darkred", "darkgreen", "darkturquoise", "darkgrey", "orange", "darkorange",
    "white", "skyblue", "saddlebrown", "steelblue", "paleturquoise", "violet",
    "darkolivegreen", "darkmagenta", "plum1", "plum2", "bisque4", "coral1",
    "coral2", "honeydew1", "lavenderblush3", "sienna3",
]


# ──────────────────────────────────────────────────────────────────────────────
# COHORT DETECTION PATTERN  (configurable via COHORT_LABEL_PATTERN env var)
# Generic group label prefixes only — no disease-specific terminology.
# ──────────────────────────────────────────────────────────────────────────────
_DEFAULT_COHORT_PATTERN = r"(?:control|case|treated|untreated|healthy|reference|baseline|experimental|group[_\s]?[a-z0-9]*)"


def _get_cohort_pattern() -> str:
    import os
    return os.environ.get("COHORT_LABEL_PATTERN", _DEFAULT_COHORT_PATTERN)


# ──────────────────────────────────────────────────────────────────────────────
# REFERENCE DATA LOADERS
# GO terms and cell type markers are loaded from external files at runtime.
# Users can upload their own or the bundled defaults are used.
# ──────────────────────────────────────────────────────────────────────────────


def _extract_gene_name(raw: str) -> str:
    if "|" in raw:
        return raw.split("|")[0]
    return raw


LONG_SAMPLE_COLUMNS = [
    "Sample Names",
    "Sample Name",
    "R.FileName",
    "R.Label",
    "R.Raw File Name",
    "Raw file",
    "Raw File",
    "File.Name",
    "File Name",
    "Filename",
    "Run",
]
LONG_VALUE_COLUMNS = [
    "PEP.Quantity",
    "PEP.MS2Quantity",
    "PEP.MS1Quantity",
    "PG.Quantity",
    "PG.MaxLFQ",
    "Genes.MaxLFQ",
    "Precursor.Normalised",
    "Precursor.Normalized",
    "Precursor.Quantity",
    "FG.Quantity",
    "Quantity",
    "Intensity",
    "Area",
    "Abundance",
]
LONG_PEPTIDE_COLUMNS = [
    "PEP.GroupingKey",
    "PepGroupingKey",
    "PEP.StrippedSequence",
    "Stripped Sequence",
    "Stripped.Sequence",
    "Modified.Sequence",
    "EG.PrecursorId",
    "EG.ModifiedPeptide",
    "Precursor.Id",
    "Sequence",
    "Modified sequence",
    "Peptide",
]
LONG_GENE_COLUMNS = ["Gene Name", "Gene names", "Gene names (primary)", "PG.Genes", "Genes", "Gene", "gene"]
LONG_ACCESSION_COLUMNS = [
    "PEP.AllOccurringProteinAccessions",
    "ProteinAccessions",
    "PG.ProteinAccessions",
    "PG.ProteinGroups",
    "Protein.Group",
    "Protein.Ids",
    "Accession",
    "ProteinGroups",
    "Proteins",
    "Protein IDs",
    "Majority protein IDs",
    "Protein group IDs",
]
GROUP_COLUMNS = [
    "group",
    "Group",
    "GROUP",
    "Condition",
    "condition",
    "primary biochemical AD classification",
]
TRAITS_SAMPLE_COLUMNS = [
    "SAMPLE_ID",
    "sample name",
    "Sample Names",
    "Sample Name",
    "sample_name",
    "Sample",
    "sample",
    "R.Label",
    "R.FileName",
]
TRAITS_GROUP_COLUMNS = ["GROUP", "group", "Group", "Condition", "condition", "primary biochemical AD classification"]


def _read_input_frame(file_path: Path) -> pd.DataFrame:
    if file_path.suffix.lower() == ".xlsx":
        return pd.read_excel(file_path)
    if file_path.suffix.lower() == ".parquet":
        return pd.read_parquet(file_path)
    if file_path.suffix.lower() in {".tsv", ".txt"}:
        return pd.read_csv(file_path, sep="\t", low_memory=False)
    return pd.read_csv(file_path, low_memory=False)


def _first_present(columns: List[str], candidates: List[str]) -> Optional[str]:
    lowered = {str(column).lower(): str(column) for column in columns}
    for candidate in candidates:
        match = lowered.get(candidate.lower())
        if match:
            return match
    return None


def _sample_match_key(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    token_match = re.search(r"(sample[a-z]\d+(?:r\d+)?)", text, flags=re.IGNORECASE)
    if token_match:
        return "sample" + token_match.group(1)[6:].upper()
    cohort_pattern = _get_cohort_pattern()
    cohort_match = re.search(cohort_pattern + r"[\s._-]*([a-z]\d+(?:r\d+)?)", text, flags=re.IGNORECASE)
    if cohort_match:
        return "sample" + cohort_match.group(1).upper()
    text = re.sub(r"\.raw(\.pg\.quantity)?$", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\.pg\.quantity$", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\.pep\.quantity$", "", text, flags=re.IGNORECASE)
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def _sample_suffix(value: object) -> Optional[str]:
    key = _sample_match_key(value)
    if key.startswith("sample") and len(key) > 6:
        return key[6:]
    return None


def _display_sample_name(raw_sample: object, group: str) -> str:
    suffix = _sample_suffix(raw_sample)
    if suffix:
        return f"{group} {suffix}" if group and group != "Unknown" else suffix
    cleaned = re.sub(r"\.raw(\.pg\.quantity)?$", "", str(raw_sample or "").strip(), flags=re.IGNORECASE)
    if group and group != "Unknown":
        return f"{group} | {cleaned}"
    return cleaned or "Sample"


def _normalize_group_label(raw_value: object, cohort1: str, cohort2: str) -> Optional[str]:
    text = str(raw_value or "").strip().lower()
    if not text:
        return None
    cohort1_lower = cohort1.lower()
    cohort2_lower = cohort2.lower()
    if cohort1_lower in text or text in cohort1_lower:
        return cohort1
    if cohort2_lower in text or text in cohort2_lower:
        return cohort2
    if any(token in text for token in ("control", "ctrl", "healthy", "normal", "reference", "wt")):
        return cohort1
    if any(token in text for token in ("ad", "disease", "case", "patient", "treated", "positive")):
        return cohort2
    return None


def _clean_gene_symbol(value: object) -> Optional[str]:
    text = str(value or "").strip()
    if not text or text.lower() == "nan":
        return None
    text = re.split(r"[;,]", text)[0].strip()
    if "|" in text:
        text = text.split("|")[0].strip()
    if not text:
        return None
    # Reject purely numeric "gene names" (bad UniProt lookup entries like "0")
    if text.isdigit():
        return None
    return text


@lru_cache(maxsize=1)
def _load_uniprot_lookup() -> Dict[str, str]:
    from config import DEFAULT_UNIPROT_GENE_LOOKUP

    path = Path(DEFAULT_UNIPROT_GENE_LOOKUP)
    if not path.exists():
        return {}
    df = pd.read_csv(path, low_memory=False)
    entry_col = _first_present(list(df.columns), ["Entry"])
    gene_col = _first_present(list(df.columns), ["Gene names  (primary )", "Gene names (primary)", "Gene"])
    if not entry_col or not gene_col:
        return {}
    lookup = {}
    for _, row in df[[entry_col, gene_col]].dropna().iterrows():
        entry = str(row[entry_col]).strip().split("-")[0]
        gene = _clean_gene_symbol(row[gene_col])
        if entry and gene:
            lookup[entry] = gene
    return lookup


def _gene_from_accessions(value: object) -> Optional[str]:
    accessions = [part.strip() for part in str(value or "").split(";") if part and str(part).strip()]
    if not accessions:
        return None
    lookup = _load_uniprot_lookup()
    for accession in accessions:
        gene = lookup.get(accession.split("-")[0])
        # _clean_gene_symbol rejects numeric-only values like "0" from bad lookup entries
        gene = _clean_gene_symbol(gene)
        if gene:
            return gene
    return accessions[0].split("-")[0]


def _read_traits_frame(path: Path) -> pd.DataFrame:
    if path.suffix.lower() == ".xlsx":
        return pd.read_excel(path)
    if path.suffix.lower() in {".tsv", ".txt"}:
        return pd.read_csv(path, sep="\t")
    return pd.read_csv(path)


def _align_traits_frame(traits_df: pd.DataFrame, raw_samples: List[str], cohort1: str, cohort2: str) -> Optional[dict]:
    sample_col = _first_present(list(traits_df.columns), TRAITS_SAMPLE_COLUMNS)
    if not sample_col:
        return None

    group_col = _first_present(list(traits_df.columns), TRAITS_GROUP_COLUMNS)
    numeric_cols = [
        column
        for column in traits_df.columns
        if column not in {sample_col, group_col}
        and pd.api.types.is_numeric_dtype(traits_df[column])
        and not pd.api.types.is_bool_dtype(traits_df[column])
    ]

    rows_by_key: Dict[str, pd.Series] = {}
    for _, row in traits_df.iterrows():
        key = _sample_match_key(row.get(sample_col))
        if key and key not in rows_by_key:
            rows_by_key[key] = row

    aligned_rows = []
    group_map: Dict[str, str] = {}
    matched = 0
    for raw_sample in raw_samples:
        key = _sample_match_key(raw_sample)
        matched_row = rows_by_key.get(key)
        aligned = {"raw_sample_name": raw_sample}
        group_value = None
        if matched_row is not None:
            matched += 1
            if group_col:
                group_value = _normalize_group_label(matched_row.get(group_col), cohort1, cohort2)
            for column in numeric_cols:
                aligned[column] = matched_row.get(column)
        else:
            for column in numeric_cols:
                aligned[column] = np.nan
        if group_value:
            group_map[str(raw_sample)] = group_value
        aligned["GROUP"] = group_value
        aligned_rows.append(aligned)

    return {"aligned": pd.DataFrame(aligned_rows), "group_map": group_map, "matched": matched}


# _load_reference_traits was removed (DATA-01): Sweden cohort metadata injection eliminated.
# Traits are only sourced from user-uploaded traits files. If none provided,
# traits_alignment stays None and trait correlation outputs are skipped.


def _make_sample_metadata(raw_samples: List[str], group_map: Dict[str, str], source_map: Dict[str, str]) -> tuple[pd.DataFrame, Dict[str, str]]:
    counts: Dict[str, int] = {}
    sample_name_map: Dict[str, str] = {}
    rows = []
    for raw_sample in raw_samples:
        group = group_map.get(raw_sample, "Unknown")
        display_name = _display_sample_name(raw_sample, group)
        counts[display_name] = counts.get(display_name, 0) + 1
        if counts[display_name] > 1:
            display_name = f"{display_name} [{counts[display_name]}]"
        sample_name_map[raw_sample] = display_name
        rows.append(
            {
                "sample_name": display_name,
                "raw_sample_name": raw_sample,
                "sample_key": _sample_match_key(raw_sample),
                "group": group,
                "group_source": source_map.get(raw_sample, "unknown"),
            }
        )
    return pd.DataFrame(rows), sample_name_map


def _value_scale_hint(values: pd.DataFrame | np.ndarray, format_family: str) -> str:
    family = str(format_family or "").lower()
    if family == "olink":
        return "log2"
    array = np.asarray(values, dtype=float)
    finite = array[np.isfinite(array)]
    if finite.size == 0:
        return "unknown"
    q95 = float(np.nanpercentile(finite, 95))
    median = float(np.nanmedian(finite))
    q05 = float(np.nanpercentile(finite, 5))
    if q95 < 50 and median < 25 and q05 > -20:
        return "log2"
    return "linear"


def _compose_feature_identifier(
    feature_value: object,
    gene_value: object,
    accession_value: object,
    *,
    assay_level: str,
) -> str:
    feature = str(feature_value or "").strip()
    # If the original feature value is already a structured ID (contains |),
    # preserve it as-is to avoid mangling PEAKS-style IDs like Gene|Accession|Peptide(+PTM)
    if "|" in feature:
        return feature
    gene = _clean_gene_symbol(gene_value) or _gene_from_accessions(accession_value) or ""
    accession = str(accession_value or "").strip().split(";")[0]
    parts = [part for part in (gene, accession) if part]
    if assay_level == "peptide" and feature:
        parts.append(feature)
    elif feature and feature not in parts:
        parts.append(feature)
    if parts:
        return "|".join(parts)
    return feature or accession or gene or "feature"


def _canonicalize_input(input_file: str, params: dict, log_fn: Callable) -> dict:
    fp = Path(input_file)
    df_raw = _read_input_frame(fp)
    columns = [str(column) for column in df_raw.columns]
    cohort1 = params.get("cohort1", "Control")
    cohort2 = params.get("cohort2", "Disease")
    traits_file_path = params.get("traits_file_path")
    format_family = params.get("format_family") or "Generic"
    assay_level = params.get("input_level") or "unknown"

    is_olink_long = {"SampleID", "Assay", "NPX"}.issubset(set(columns))

    long_sample_col = _first_present(columns, LONG_SAMPLE_COLUMNS)
    long_value_col = _first_present(columns, LONG_VALUE_COLUMNS)
    long_feature_col = _first_present(columns, LONG_PEPTIDE_COLUMNS)
    long_gene_col = _first_present(columns, LONG_GENE_COLUMNS)
    long_accession_col = _first_present(columns, LONG_ACCESSION_COLUMNS)
    long_group_col = _first_present(columns, GROUP_COLUMNS)

    is_long = bool(long_sample_col and long_value_col and (long_feature_col or long_accession_col))
    traits_payload = None

    if is_olink_long:
        log_fn(f"[{_ts()}] Parsing Olink NPX long-format matrix")
        work = df_raw.copy()
        if "SampleType" in work.columns:
            work = work[work["SampleType"].astype(str).str.upper() == "SAMPLE"]
        if "AssayType" in work.columns:
            work = work[work["AssayType"].astype(str).str.lower() == "assay"]
        if "SampleQC" in work.columns:
            work = work[work["SampleQC"].astype(str).str.upper().isin({"PASS", "OK", "TRUE"})]

        work = work.rename(columns={"SampleID": "raw_sample_name", "Assay": "feature_id", "NPX": "value"})
        work["raw_sample_name"] = work["raw_sample_name"].astype(str)
        work["feature_id"] = work["feature_id"].astype(str)
        work["value"] = pd.to_numeric(work["value"], errors="coerce")
        work = work.dropna(subset=["raw_sample_name", "feature_id", "value"])

        raw_samples = list(dict.fromkeys(work["raw_sample_name"].tolist()))
        group_map: Dict[str, str] = {}
        source_map: Dict[str, str] = {}

        if "Disease" in work.columns:
            direct_groups = work[["raw_sample_name", "Disease"]].dropna().drop_duplicates()
            for _, row in direct_groups.iterrows():
                normalized = _normalize_group_label(row["Disease"], cohort1, cohort2)
                if normalized:
                    group_map[row["raw_sample_name"]] = normalized
                    source_map[row["raw_sample_name"]] = "column:Disease"

        traits_alignment = None
        traits_sample_order = raw_samples
        if traits_file_path and Path(traits_file_path).exists():
            try:
                traits_alignment = _align_traits_frame(_read_traits_frame(Path(traits_file_path)), raw_samples, cohort1, cohort2)
                if traits_alignment and traits_alignment["matched"]:
                    log_fn(f"[{_ts()}] Matched {traits_alignment['matched']} samples to uploaded traits metadata")
            except Exception as error:
                log_fn(f"[{_ts()}] WARNING: Could not use traits file ({error})")

        if traits_alignment:
            traits_payload = traits_alignment["aligned"].copy()
            for raw_sample, normalized in traits_alignment["group_map"].items():
                if normalized and raw_sample not in group_map:
                    group_map[raw_sample] = normalized
                    source_map[raw_sample] = "traits"
        else:
            numeric_trait_columns = [
                column
                for column in work.columns
                if column not in {"raw_sample_name", "feature_id", "value", "Disease"}
                and pd.api.types.is_numeric_dtype(work[column])
            ]
            metadata_columns = [column for column in ("Disease", *numeric_trait_columns) if column in work.columns]
            if metadata_columns:
                metadata_df = work[["raw_sample_name", *metadata_columns]].drop_duplicates("raw_sample_name")
                traits_payload = metadata_df.rename(columns={"raw_sample_name": "SAMPLE_ID"})
                traits_payload["GROUP"] = traits_payload["Disease"].map(lambda value: _normalize_group_label(value, cohort1, cohort2))
                ordered_samples = [sample for sample in raw_samples if sample in set(traits_payload["SAMPLE_ID"].astype(str))]
                traits_sample_order = ordered_samples
                traits_payload = traits_payload.set_index("SAMPLE_ID").reindex(ordered_samples).reset_index()
                for _, row in traits_payload.iterrows():
                    if row.get("GROUP"):
                        group_map[str(row["SAMPLE_ID"])] = str(row["GROUP"])
                        source_map[str(row["SAMPLE_ID"])] = "column:Disease"

        sample_metadata, sample_name_map = _make_sample_metadata(raw_samples, group_map, source_map)
        work["sample_name"] = work["raw_sample_name"].map(sample_name_map)
        work["gene"] = work["feature_id"].astype(str)

        agg = work.groupby(["feature_id", "gene", "sample_name"], as_index=False)["value"].mean()
        pivot = agg.pivot_table(index=["feature_id", "gene"], columns="sample_name", values="value", aggfunc="mean")
        matrix = pivot.reset_index()

        if traits_payload is not None and not traits_payload.empty:
            if "raw_sample_name" in traits_payload.columns:
                traits_payload["SAMPLE_ID"] = [sample_name_map[sample] for sample in traits_sample_order]
            else:
                traits_payload["SAMPLE_ID"] = [sample_name_map[str(sample)] for sample in traits_sample_order]
            traits_payload["GROUP"] = [group_map.get(str(sample), "Unknown") for sample in traits_sample_order]
            trait_columns = [column for column in traits_payload.columns if column not in {"raw_sample_name", "GROUP", "SAMPLE_ID", "Disease"}]
            traits_payload = traits_payload[["SAMPLE_ID", "GROUP", *trait_columns]]

        return {
            "matrix": matrix,
            "sample_metadata": sample_metadata,
            "traits": traits_payload,
            "manifest": {
                "input_file": input_file,
                "format_family": "Olink",
                "assay_level": "protein",
                "feature_count": int(len(matrix)),
                "sample_count": int(len(sample_metadata)),
                "cohort1": cohort1,
                "cohort2": cohort2,
                "value_scale": "log2",
            },
        }

    if is_long:
        feature_col = long_feature_col or long_accession_col
        log_fn(
            f"[{_ts()}] Parsing long-format matrix: sample='{long_sample_col}' feature='{feature_col}' value='{long_value_col}'"
        )
        selected_columns = list(dict.fromkeys([long_sample_col, feature_col, long_value_col, long_gene_col, long_accession_col, long_group_col]))
        work = df_raw[[column for column in selected_columns if column]].copy()
        work = work.rename(columns={long_sample_col: "raw_sample_name", feature_col: "feature_key", long_value_col: "value"})
        work["raw_sample_name"] = work["raw_sample_name"].astype(str)
        work["feature_key"] = work["feature_key"].astype(str)
        work["value"] = pd.to_numeric(work["value"], errors="coerce")
        work = work.dropna(subset=["raw_sample_name", "feature_key", "value"])

        raw_samples = list(dict.fromkeys(work["raw_sample_name"].tolist()))
        group_map: Dict[str, str] = {}
        source_map: Dict[str, str] = {}

        if long_group_col:
            direct_groups = work[["raw_sample_name", long_group_col]].dropna().drop_duplicates()
            for _, row in direct_groups.iterrows():
                normalized = _normalize_group_label(row[long_group_col], cohort1, cohort2)
                if normalized:
                    group_map[row["raw_sample_name"]] = normalized
                    source_map[row["raw_sample_name"]] = f"column:{long_group_col}"

        traits_alignment = None
        if traits_file_path and Path(traits_file_path).exists():
            try:
                traits_alignment = _align_traits_frame(_read_traits_frame(Path(traits_file_path)), raw_samples, cohort1, cohort2)
                if traits_alignment and traits_alignment["matched"]:
                    log_fn(f"[{_ts()}] Matched {traits_alignment['matched']} samples to uploaded traits metadata")
            except Exception as error:
                log_fn(f"[{_ts()}] WARNING: Could not use traits file ({error})")
        if not traits_alignment:
            log_fn(f"[{_ts()}] No traits file provided — module-trait correlations will be skipped")

        if traits_alignment:
            traits_payload = traits_alignment["aligned"].copy()
            for raw_sample, normalized in traits_alignment["group_map"].items():
                if raw_sample not in group_map and normalized:
                    group_map[raw_sample] = normalized
                    source_map[raw_sample] = "traits"

        for raw_sample in raw_samples:
            if raw_sample in group_map:
                continue
            inferred = _normalize_group_label(raw_sample, cohort1, cohort2)
            if inferred:
                group_map[raw_sample] = inferred
                source_map[raw_sample] = "filename"

        sample_metadata, sample_name_map = _make_sample_metadata(raw_samples, group_map, source_map)
        work["sample_name"] = work["raw_sample_name"].map(sample_name_map)

        if long_gene_col and long_gene_col in work.columns:
            work["gene"] = work[long_gene_col].map(_clean_gene_symbol)
        else:
            if long_accession_col and long_accession_col in work.columns:
                accession_values = work[long_accession_col].astype(str)
            elif long_accession_col == feature_col:
                accession_values = work["feature_key"].astype(str)
            else:
                accession_values = pd.Series([""] * len(work))
            accession_map = {value: _gene_from_accessions(value) for value in accession_values.unique()}
            work["gene"] = accession_values.map(accession_map)
        work["gene"] = work["gene"].fillna(work["feature_key"].map(_extract_gene_name))
        if long_accession_col and long_accession_col in work.columns:
            accession_series = work[long_accession_col]
        elif long_accession_col == feature_col:
            accession_series = work["feature_key"]
        else:
            accession_series = pd.Series([""] * len(work))
        work["feature_id"] = [
            _compose_feature_identifier(
                feature_value,
                gene_value,
                accession_value,
                assay_level=str(assay_level or params.get("input_level") or "peptide"),
            )
            for feature_value, gene_value, accession_value in zip(work["feature_key"], work["gene"], accession_series)
        ]

        agg = work.groupby(["feature_id", "gene", "sample_name"], as_index=False)["value"].mean()
        pivot = agg.pivot_table(index=["feature_id", "gene"], columns="sample_name", values="value", aggfunc="mean")
        matrix = pivot.reset_index()

        if traits_payload is not None:
            traits_payload["SAMPLE_ID"] = [sample_name_map[sample] for sample in raw_samples]
            traits_payload["GROUP"] = [group_map.get(sample, "Unknown") for sample in raw_samples]
            trait_columns = [column for column in traits_payload.columns if column not in {"raw_sample_name", "GROUP", "SAMPLE_ID"}]
            traits_payload = traits_payload[["SAMPLE_ID", "GROUP", *trait_columns]]

        return {
            "matrix": matrix,
            "sample_metadata": sample_metadata,
            "traits": traits_payload,
            "manifest": {
                "input_file": input_file,
                "format_family": params.get("format_family") or "Spectronaut",
                "assay_level": params.get("input_level") or "peptide",
                "feature_count": int(len(matrix)),
                "sample_count": int(len(sample_metadata)),
                "cohort1": cohort1,
                "cohort2": cohort2,
                "value_scale": _value_scale_hint(matrix.iloc[:, 2:], format_family),
            },
        }

    log_fn(f"[{_ts()}] Parsing wide-format matrix")
    area_cols = [column for column in df_raw.columns if str(column).startswith("Area")]
    intensity_cols = [
        column
        for column in df_raw.columns
        if str(column).startswith("Intensity ") or str(column).startswith("LFQ intensity ")
    ]
    sample_columns = area_cols or intensity_cols or [
        column
        for column in df_raw.columns
        if pd.api.types.is_numeric_dtype(df_raw[column]) and not pd.api.types.is_bool_dtype(df_raw[column])
    ]
    gene_col = _first_present(columns, LONG_GENE_COLUMNS)
    accession_col = _first_present(columns, LONG_ACCESSION_COLUMNS)

    # PEAKS DB layout: first column is "Accession" but the row identifier
    # we want as the feature is "Peptide" (preserves PTMs and per-peptide
    # granularity). Without this, every peptide of the same protein
    # collapses to one row keyed by accession — destroys 80% of features.
    peptide_col = _first_present(columns, ["Peptide", "Sequence"])
    is_peaks_layout = bool(area_cols and peptide_col and (gene_col or accession_col))
    if is_peaks_layout:
        id_col = peptide_col
        # Apply Excel gene-name fix at this entry point so the Python fallback
        # also benefits (R-ETL path applies it in _read_canonical_from_r_etl).
        from services.gene_name_fix import fix_excel_corrupted_gene
        if gene_col:
            df_raw[gene_col] = df_raw[gene_col].astype(str).map(fix_excel_corrupted_gene)
    else:
        id_col = str(df_raw.columns[0])

    group_map: Dict[str, str] = {}
    source_map: Dict[str, str] = {}
    for sample in sample_columns:
        inferred = _normalize_group_label(sample, cohort1, cohort2)
        if inferred:
            group_map[str(sample)] = inferred
            source_map[str(sample)] = "filename"

    traits_alignment = None
    if traits_file_path and Path(traits_file_path).exists():
        try:
            traits_alignment = _align_traits_frame(_read_traits_frame(Path(traits_file_path)), [str(sample) for sample in sample_columns], cohort1, cohort2)
        except Exception as error:
            log_fn(f"[{_ts()}] WARNING: Could not use traits file ({error})")
    if traits_alignment:
        traits_payload = traits_alignment["aligned"].copy()
        for raw_sample, normalized in traits_alignment["group_map"].items():
            group_map[raw_sample] = normalized
            source_map[raw_sample] = "traits"

    sample_metadata, sample_name_map = _make_sample_metadata([str(sample) for sample in sample_columns], group_map, source_map)
    rename_map = {sample: sample_name_map[str(sample)] for sample in sample_columns}
    matrix = df_raw[[id_col, *sample_columns]].copy().rename(columns={id_col: "feature_id", **rename_map})
    if gene_col:
        gene_values = df_raw[gene_col].map(_clean_gene_symbol)
    elif accession_col:
        accession_values = df_raw[accession_col].astype(str)
        accession_map = {value: _gene_from_accessions(value) for value in accession_values.unique()}
        gene_values = accession_values.map(accession_map)
    else:
        gene_values = df_raw[id_col].astype(str).map(_extract_gene_name)
    feature_source = df_raw[id_col].astype(str)
    accession_source = df_raw[accession_col] if accession_col else pd.Series([""] * len(df_raw))
    gene_filled = gene_values.fillna(df_raw[id_col].astype(str).map(_extract_gene_name))
    matrix.insert(1, "gene", gene_filled)
    matrix["feature_id"] = [
        _compose_feature_identifier(
            feature_value,
            gene_value,
            accession_value,
            assay_level=str(assay_level or params.get("input_level") or "unknown"),
        )
        for feature_value, gene_value, accession_value in zip(feature_source, gene_filled, accession_source)
    ]

    if traits_payload is not None:
        traits_payload["SAMPLE_ID"] = [sample_name_map[str(sample)] for sample in sample_columns]
        traits_payload["GROUP"] = [group_map.get(str(sample), "Unknown") for sample in sample_columns]
        trait_columns = [column for column in traits_payload.columns if column not in {"raw_sample_name", "GROUP", "SAMPLE_ID"}]
        traits_payload = traits_payload[["SAMPLE_ID", "GROUP", *trait_columns]]

    return {
        "matrix": matrix,
        "sample_metadata": sample_metadata,
        "traits": traits_payload,
        "manifest": {
            "input_file": input_file,
            "format_family": params.get("format_family") or "Generic",
            "assay_level": params.get("input_level") or "unknown",
            "feature_count": int(len(matrix)),
            "sample_count": int(len(sample_metadata)),
            "cohort1": cohort1,
            "cohort2": cohort2,
            "value_scale": _value_scale_hint(matrix.iloc[:, 2:], format_family),
        },
    }


def _load_canonical_bundle_for_stage1(run_dir: Path, cohort1: str, cohort2: str, log_fn: Callable) -> Optional[dict]:
    matrix_path = run_dir / "input" / "cleaned_matrix.csv"
    sample_meta_path = run_dir / "input" / "sample_metadata.csv"
    if not matrix_path.exists() or not sample_meta_path.exists():
        return None

    matrix_df = pd.read_csv(matrix_path)
    sample_meta = pd.read_csv(sample_meta_path)
    if "sample_name" not in sample_meta.columns or "group" not in sample_meta.columns:
        return None

    sample_meta["sample_name"] = sample_meta["sample_name"].astype(str)
    sample_meta["group"] = sample_meta["group"].astype(str)
    available_samples = [column for column in matrix_df.columns if column not in {"feature_id", "gene"}]
    sample_meta = sample_meta[sample_meta["sample_name"].isin(available_samples)]
    c1_cols = sample_meta.loc[sample_meta["group"] == cohort1, "sample_name"].tolist()
    c2_cols = sample_meta.loc[sample_meta["group"] == cohort2, "sample_name"].tolist()
    all_sample_cols = c1_cols + c2_cols
    if not all_sample_cols:
        return None

    log_fn(
        f"[{_ts()}] Loading canonical bundle: {len(matrix_df)} features × {len(all_sample_cols)} grouped samples"
    )
    return {
        "matrix": matrix_df[all_sample_cols].apply(pd.to_numeric, errors="coerce"),
        "sample_columns": all_sample_cols,
        "c1_cols": c1_cols,
        "c2_cols": c2_cols,
        "feature_ids": matrix_df["feature_id"].astype(str).tolist(),
        "gene_names": (
            matrix_df["gene"].fillna(matrix_df["feature_id"]).astype(str).tolist()
            if "gene" in matrix_df.columns
            else matrix_df["feature_id"].astype(str).tolist()
        ),
    }


def _normalize_peaks_feature_ids_in_place(csv_path: Path, log_fn: Callable) -> int:
    """Rewrite a PEAKS abundance/log2 CSV in place with HGNC-canonicalized
    gene names in the 'Gene|Accession|Peptide' index.

    Returns the count of rows whose gene name was changed. Uses
    fix_excel_corrupted_gene + _gene_from_accessions (UniProt lookup).
    Best-effort: any error is logged and the file is left unchanged.
    """
    if not csv_path.exists():
        return 0
    from services.gene_name_fix import fix_excel_corrupted_gene
    try:
        df = pd.read_csv(csv_path, index_col=0)
        old_index = list(df.index.astype(str))
        new_index: list[str] = []
        n_changed = 0
        for fid in old_index:
            parts = fid.split("|", 2)
            gene_source = parts[0] if parts else ""
            accession_source = parts[1] if len(parts) >= 2 else ""
            gene_fixed = fix_excel_corrupted_gene(gene_source)
            canonical = _gene_from_accessions(accession_source) if accession_source else None
            if canonical and canonical != gene_fixed:
                gene_fixed = canonical
            if len(parts) == 3:
                new_fid = f"{gene_fixed}|{parts[1]}|{parts[2]}"
            elif len(parts) == 2:
                new_fid = f"{gene_fixed}|{parts[1]}"
            else:
                new_fid = fid
            new_index.append(new_fid)
            if new_fid != fid:
                n_changed += 1
        if n_changed:
            df.index = new_index
            df.to_csv(csv_path)
            log_fn(f"[{_ts()}] Canonicalized {n_changed} gene names in {csv_path.name}")
        return n_changed
    except Exception as exc:  # noqa: BLE001
        log_fn(f"[{_ts()}] WARNING: Could not canonicalize gene names in {csv_path.name} ({exc})")
        return 0


def _read_canonical_from_r_etl(
    abundance_path: Path,
    traits_path: Optional[Path],
    cohort1: str,
    cohort2: str,
    log_fn: Callable,
) -> dict:
    """Translate R PEAKS ETL output to canonical bundle structure.

    R writes peptide×sample with row index = "Gene|Accession|Peptide(+PTM)".
    Canonical bundle expects: matrix with feature_id+gene+sample columns,
    sample_metadata, traits, manifest. Also applies the Excel gene-name fix.
    """
    from services.gene_name_fix import fix_excel_corrupted_gene

    abundance_df = pd.read_csv(abundance_path, index_col=0)
    feature_ids = list(abundance_df.index.astype(str))
    sample_columns = list(abundance_df.columns)

    genes: list[str] = []
    fixed_feature_ids: list[str] = []
    n_excel_fixed = 0
    n_uniprot_normalized = 0
    for fid in feature_ids:
        parts = fid.split("|", 2)
        gene_source = parts[0] if parts else ""
        accession_source = parts[1] if len(parts) >= 2 else ""

        # 1. Repair Excel corruption ("7-Sep" → "SEPTIN7")
        gene_fixed = fix_excel_corrupted_gene(gene_source)
        if gene_fixed != gene_source:
            n_excel_fixed += 1

        # 2. Normalize to canonical HGNC symbol via UniProt accession lookup
        # (reference uses current HGNC names; PEAKS source often has old names
        # like "1433B" where current is "YWHAB"). Only override when lookup
        # finds a result; otherwise keep the source gene name as-is.
        canonical = _gene_from_accessions(accession_source) if accession_source else None
        if canonical and canonical != gene_fixed:
            gene_fixed = canonical
            n_uniprot_normalized += 1

        # Rebuild the feature_id with the corrected gene
        if len(parts) == 3:
            fixed_fid = f"{gene_fixed}|{parts[1]}|{parts[2]}"
        elif len(parts) == 2:
            fixed_fid = f"{gene_fixed}|{parts[1]}"
        else:
            fixed_fid = fid
        genes.append(gene_fixed)
        fixed_feature_ids.append(fixed_fid)

    if n_excel_fixed:
        log_fn(f"[{_ts()}] Repaired {n_excel_fixed} Excel-corrupted gene names")
    if n_uniprot_normalized:
        log_fn(f"[{_ts()}] Normalized {n_uniprot_normalized} gene names via UniProt → HGNC lookup")

    matrix = abundance_df.copy()
    matrix.index = fixed_feature_ids
    matrix = matrix.reset_index().rename(columns={"index": "feature_id"})
    matrix.insert(1, "gene", genes)

    # Build sample metadata from group inference + traits
    raw_samples = sample_columns
    group_map: Dict[str, str] = {}
    source_map: Dict[str, str] = {}
    for sample in raw_samples:
        inferred = _normalize_group_label(sample, cohort1, cohort2)
        if inferred:
            group_map[sample] = inferred
            source_map[sample] = "filename"

    traits_payload = None
    if traits_path and traits_path.exists():
        try:
            t = pd.read_csv(traits_path)
            # The R-emitted traits CSV has SAMPLE_ID and GROUP columns
            if "SAMPLE_ID" in t.columns:
                t = t.rename(columns={"SAMPLE_ID": "raw_sample_name"})
            if "raw_sample_name" in t.columns:
                t["raw_sample_name"] = t["raw_sample_name"].astype(str)
                # Ingest GROUP if present for group_map
                if "GROUP" in t.columns:
                    for _, row in t.iterrows():
                        g = _normalize_group_label(row.get("GROUP"), cohort1, cohort2)
                        if g:
                            group_map[str(row["raw_sample_name"])] = g
                            source_map[str(row["raw_sample_name"])] = "traits"
                traits_payload = t.copy()
        except Exception as exc:  # noqa: BLE001 — non-fatal
            log_fn(f"[{_ts()}] WARNING: Could not parse R-emitted traits CSV ({exc})")

    sample_metadata, sample_name_map = _make_sample_metadata(raw_samples, group_map, source_map)
    rename_map = {raw: sample_name_map[raw] for raw in raw_samples}
    matrix = matrix.rename(columns=rename_map)

    if traits_payload is not None and "raw_sample_name" in traits_payload.columns:
        traits_payload["SAMPLE_ID"] = traits_payload["raw_sample_name"].map(sample_name_map)
        traits_payload["GROUP"] = traits_payload["raw_sample_name"].map(lambda s: group_map.get(str(s), "Unknown"))
        keep = ["SAMPLE_ID", "GROUP"] + [c for c in traits_payload.columns if c not in {"SAMPLE_ID", "GROUP", "raw_sample_name"}]
        traits_payload = traits_payload[keep]

    manifest = {
        "input_file": str(abundance_path),
        "feature_count": int(len(matrix)),
        "sample_count": int(len(sample_metadata)),
        "cohort1": cohort1,
        "cohort2": cohort2,
        "value_scale": "linear",
        "format_family": "PEAKS",
        "etl_path": "r-native",
    }
    return {
        "matrix": matrix,
        "sample_metadata": sample_metadata,
        "traits": traits_payload,
        "manifest": manifest,
    }


def _merge_user_clinical_traits(bundle: dict, params: dict, log_fn: Callable) -> None:
    """Merge user-uploaded clinical traits CSV into the canonical bundle in-place.

    After the PEAKS R ETL produces bundle["traits"] (SAMPLE_ID, GROUP, BATCH),
    reads params["traits_file_path"] (if set), normalizes synonym column names,
    and left-joins the clinical biomarker columns onto bundle["traits"] by SAMPLE_ID.
    No-op when path is absent, file missing, or bundle["traits"] is None.
    """
    traits_file_path = params.get("traits_file_path")
    if not traits_file_path:
        return
    clinical_path = Path(traits_file_path)
    if not clinical_path.exists():
        log_fn(f"[{_ts()}] WARNING: traits_file_path set but file not found ({clinical_path}); clinical traits not merged")
        return
    if bundle.get("traits") is None:
        log_fn(f"[{_ts()}] WARNING: no R-generated traits frame to merge into; clinical traits not merged")
        return
    try:
        clinical_df = pd.read_csv(clinical_path)
    except Exception as exc:  # noqa: BLE001
        log_fn(f"[{_ts()}] WARNING: could not read clinical traits CSV ({exc}); clinical traits not merged")
        return
    clinical_df = _normalize_biomarker_synonyms(clinical_df)
    join_key_candidates = ("SAMPLE_ID", "sample_id", "SampleID", "Sample_ID", "sample", "Sample")
    clinical_join_key = next((c for c in join_key_candidates if c in clinical_df.columns), None)
    if clinical_join_key is None:
        log_fn(f"[{_ts()}] WARNING: clinical traits CSV has no SAMPLE_ID column (found: {list(clinical_df.columns)}); clinical traits not merged")
        return
    reserved_cols = {"SAMPLE_ID", "GROUP", "BATCH", "raw_sample_name"}
    biomarker_cols = [c for c in clinical_df.columns if c not in reserved_cols and c != clinical_join_key]
    if not biomarker_cols:
        log_fn(f"[{_ts()}] No new biomarker columns found in clinical traits CSV after synonym normalization")
        return
    clinical_merge = clinical_df[[clinical_join_key] + biomarker_cols].rename(columns={clinical_join_key: "SAMPLE_ID"})
    clinical_merge["SAMPLE_ID"] = clinical_merge["SAMPLE_ID"].astype(str)
    r_traits = bundle["traits"].copy()
    r_traits["SAMPLE_ID"] = r_traits["SAMPLE_ID"].astype(str)
    merged = r_traits.merge(clinical_merge, on="SAMPLE_ID", how="left")
    bundle["traits"] = merged
    log_fn(f"[{_ts()}] Merged {len(biomarker_cols)} clinical trait column(s) from {clinical_path.name} into traits bundle: {biomarker_cols}")


def _run_r_outlier_detection(matrix_path, z_threshold, output_json_path, log_fn):
    """Run outlier_removal.R. Returns True on success, False if R/script unavailable."""
    script_path = Path(__file__).resolve().parent.parent / "r_scripts" / "outlier_removal.R"
    if not script_path.exists():
        log_fn(f"[{_ts()}] outlier_removal.R not found — skipping outlier detection")
        return False
    import shutil
    if not shutil.which("Rscript"):
        log_fn(f"[{_ts()}] Rscript not available — skipping outlier detection")
        return False
    cmd = ["Rscript", "--vanilla", str(script_path), str(matrix_path), str(z_threshold), str(output_json_path)]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        for line in result.stdout.splitlines():
            if line.strip():
                log_fn(f"[{_ts()}] [outlier] {line}")
        if result.returncode != 0:
            log_fn(f"[{_ts()}] outlier_removal.R exited {result.returncode}: {result.stderr[:500]}")
            return False
        return output_json_path.exists()
    except subprocess.TimeoutExpired:
        log_fn(f"[{_ts()}] outlier_removal.R timed out after 120s — skipping")
        return False
    except Exception as e:
        log_fn(f"[{_ts()}] outlier_removal.R error: {e}")
        return False


def _detect_outliers(run_id, run_dir, params, log_fn, step_callback, db):
    """
    Run bicor network-connectivity outlier detection.
    Returns list of sample names to exclude (empty if none / skipped / user chose skip).
    Blocks the calling thread until the user approves via POST /api/runs/{id}/review-outliers
    when candidates are found.
    """
    step_callback("outlier_removal", "running", 10, "Checking sample network connectivity")

    matrix_path = run_dir / "input" / "cleaned_matrix.csv"
    if not matrix_path.exists():
        log_fn(f"[{_ts()}] cleaned_matrix.csv not found — skipping outlier detection")
        step_callback("outlier_removal", "complete", 100, "Skipped — matrix not available")
        return []

    z_threshold = float(params.get("outlier_z_threshold", 2.0))
    output_json = run_dir / "input" / "outlier_candidates.json"

    ok = _run_r_outlier_detection(matrix_path, z_threshold, output_json, log_fn)
    if not ok:
        step_callback("outlier_removal", "complete", 100, "Skipped — R unavailable")
        return []

    result = json.loads(output_json.read_text())
    candidates = result.get("outlier_candidates", [])
    n_samples = len(result.get("all_z_scores", {}))

    if not candidates:
        log_fn(f"[{_ts()}] No outliers detected across {n_samples} samples (Z threshold = {z_threshold})")
        step_callback("outlier_removal", "complete", 100, f"No outliers detected ({n_samples} samples)")
        return []

    n = len(candidates)
    log_fn(f"[{_ts()}] {n} outlier candidate(s) detected — awaiting user review")
    step_callback("outlier_removal", "awaiting_review", 50, f"{n} outlier candidate(s) — awaiting review")

    if db is not None:
        from database import Run, RunStatus
        run = db.query(Run).filter(Run.id == run_id).first()
        if run:
            existing = json.loads(run.metrics_json or "{}")
            existing["outlier_candidates"] = candidates
            run.metrics_json = json.dumps(existing)
            run.status = RunStatus.AWAITING_REVIEW
            db.commit()

    event = threading.Event()
    _OUTLIER_EVENTS[run_id] = event

    timed_out = not event.wait(timeout=86400)
    _OUTLIER_EVENTS.pop(run_id, None)

    if timed_out:
        log_fn(f"[{_ts()}] Outlier review timed out — proceeding without removal")
        step_callback("outlier_removal", "complete", 100, "Review timed out — no samples removed")
        return []

    if db is not None:
        from database import Run
        run = db.query(Run).filter(Run.id == run_id).first()
        if run:
            updated_params = json.loads(run.params or "{}")
            action = updated_params.get("outlier_action", "skip")
            if action == "cancel":
                raise RuntimeError("Run cancelled by user at outlier review")
            excluded = updated_params.get("excluded_samples", [])
            if excluded:
                log_fn(f"[{_ts()}] User excluded {len(excluded)} sample(s): {', '.join(excluded)}")
                step_callback("outlier_removal", "complete", 100, f"{len(excluded)} sample(s) excluded by user")
            else:
                log_fn(f"[{_ts()}] User chose to keep all samples")
                step_callback("outlier_removal", "complete", 100, "All samples retained (user override)")
            return excluded

    return []


def _build_canonical_bundle(input_file: str, params: dict, run_dir: Path, log_fn: Callable) -> dict:
    input_dir = run_dir / "input"
    input_dir.mkdir(parents=True, exist_ok=True)

    format_family = (params.get("format_family") or "Generic").strip()
    cohort1 = params.get("cohort1", "Control")
    cohort2 = params.get("cohort2", "Disease")
    bundle: Optional[dict] = None

    # Format-aware routing: PEAKS → R loader (matches reference deliverable
    # byte-for-byte). Falls back to Python ETL if R is unavailable or fails.
    if format_family == "PEAKS":
        try:
            r_input_dir = run_dir / "01_input"
            r_output = _run_peaks_etl_via_r(
                Path(input_file),
                r_input_dir,
                missing_threshold=float(params.get("missing_value_threshold", 0.5)),
                cohort1=cohort1,
                cohort2=cohort2,
                log_fn=log_fn,
            )
            # Canonicalize gene names in the R-emitted deliverable files so the
            # client-facing 01_input/PEAKS_*.csv files use HGNC-canonical symbols.
            _normalize_peaks_feature_ids_in_place(r_output["abundance_path"], log_fn)
            if r_output.get("log2_path"):
                _normalize_peaks_feature_ids_in_place(r_output["log2_path"], log_fn)
            bundle = _read_canonical_from_r_etl(
                r_output["abundance_path"],
                r_output.get("traits_path"),
                cohort1, cohort2, log_fn,
            )
            log_fn(f"[{_ts()}] PEAKS R ETL produced canonical bundle ({bundle['manifest']['feature_count']} features)")
            _merge_user_clinical_traits(bundle, params, log_fn)

            # Chain R normalization: produces reference-shaped deliverables
            # at 02_normalized_<norm_tag>/. Best-effort; failure logs but
            # doesn't block the canonical bundle from being usable for
            # downstream stage1.
            norm_method = params.get("normalization_method", "median")
            norm_tag = params.get("normalization_tag", f"CBN_{norm_method}")
            norm_dir = run_dir / f"02_normalized_{norm_tag}"
            try:
                if r_output.get("log2_path") and r_output.get("traits_path"):
                    norm_result = _run_peaks_norm_via_r(
                        r_output["log2_path"],
                        r_output["traits_path"],
                        norm_dir,
                        method=norm_method,
                        log_fn=log_fn,
                    )
                    # Canonicalize gene names in the normalization deliverables too
                    _normalize_peaks_feature_ids_in_place(norm_result["log2_normalized"], log_fn)
                    _normalize_peaks_feature_ids_in_place(norm_result["abundance_normalized"], log_fn)
                    log_fn(f"[{_ts()}] PEAKS R normalization produced {norm_dir.name}/ deliverables")
            except RuntimeError as norm_exc:  # noqa: BLE001
                log_fn(f"[{_ts()}] WARNING: R PEAKS normalization failed ({norm_exc}); deliverable bundle will use Python normalization fallback")
        except RuntimeError as exc:  # noqa: BLE001 — fail-soft fallback
            log_fn(f"[{_ts()}] WARNING: R PEAKS ETL failed ({exc}); falling back to Python ETL")
            bundle = None

    if bundle is None:
        bundle = _canonicalize_input(input_file, params, log_fn)

    bundle["sample_metadata"].to_csv(input_dir / "sample_metadata.csv", index=False)
    bundle["matrix"].to_csv(input_dir / "cleaned_matrix.csv", index=False)
    if bundle.get("traits") is not None:
        bundle["traits"].to_csv(input_dir / "traits.csv", index=False)
    manifest = bundle["manifest"]
    (input_dir / "dataset_manifest.json").write_text(json.dumps(manifest, indent=2))
    log_fn(f"[{_ts()}] Canonical bundle written: {manifest['feature_count']} features × {manifest['sample_count']} samples")
    return manifest


# ──────────────────────────────────────────────────────────────────────────────
# STAGE 1: NORMALIZATION + DE + CO-EXPRESSION NETWORK
# ──────────────────────────────────────────────────────────────────────────────


def _stage1_rscript_path() -> Optional[Path]:
    from config import BASE_DIR

    script_path = BASE_DIR / "r_scripts" / "stage1_parity.R"
    if not script_path.exists():
        return None
    if not shutil.which("Rscript"):
        return None
    return script_path


PEAKS_ETL_R_TIMEOUT_SECONDS = 600  # 10 min — large PEAKS files (39K+ peptides) take a few minutes


def _r_quote(s: str) -> str:
    """Quote a string safely for embedding in an R script literal."""
    escaped = str(s).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _peaks_etl_rscript_path() -> Optional[Path]:
    """Path to peaks_DataLoader_Flexible.R; None if Rscript or script missing."""
    from config import BASE_DIR

    script_path = BASE_DIR / "r_scripts" / "peaks_analysis" / "peaks_DataLoader_Flexible.R"
    if not script_path.exists():
        return None
    if not shutil.which("Rscript"):
        return None
    return script_path


def _run_peaks_etl_via_r(
    input_file: Path,
    output_dir: Path,
    *,
    missing_threshold: float,
    cohort1: str,
    cohort2: str,
    log_fn: Callable,
) -> dict:
    """Invoke peaks_DataLoader_Flexible.R as a subprocess.

    Writes PEAKS_Abundance_Matrix.csv, PEAKS_Log2_Normalized_Data.csv, and
    PEAKS_Sample_Traits_Data.csv to <output_dir>. Returns a manifest dict.
    Raises RuntimeError on Rscript missing, timeout, or non-zero exit so
    callers can fall back to the Python ETL path.
    """
    script = _peaks_etl_rscript_path()
    if script is None:
        raise RuntimeError(
            "R-native PEAKS ETL unavailable (Rscript or peaks_DataLoader_Flexible.R missing)."
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    wrapper_path = output_dir / "_peaks_etl_invoke.R"
    wrapper_path.write_text(
        f"""# Auto-generated by _run_peaks_etl_via_r — do not edit.
source({_r_quote(str(script))})
result <- peaks_DataLoader_Flexible(
  peaksFile = {_r_quote(str(input_file))},
  outputDir = {_r_quote(str(output_dir))},
  missingValueThreshold = {missing_threshold},
  group1_name = {_r_quote(cohort1)},
  group2_name = {_r_quote(cohort2)}
)
cat(sprintf("[peaks_etl] features=%d samples=%d\\n",
            nrow(result$abundanceData), ncol(result$abundanceData)))
"""
    )

    log_fn(f"[{_ts()}] Invoking R PEAKS ETL on {input_file.name}")
    try:
        result = subprocess.run(
            ["Rscript", "--vanilla", str(wrapper_path)],
            capture_output=True,
            text=True,
            timeout=PEAKS_ETL_R_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"R PEAKS ETL timed out after {PEAKS_ETL_R_TIMEOUT_SECONDS}s"
        ) from exc

    for line in (result.stdout or "").splitlines():
        if line.strip():
            log_fn(line.rstrip())
    if result.returncode != 0:
        for line in (result.stderr or "").splitlines():
            if line.strip():
                log_fn(f"[r-stderr] {line.rstrip()}")
        raise RuntimeError(f"R PEAKS ETL exited with code {result.returncode}")

    abundance_path = output_dir / "PEAKS_Abundance_Matrix.csv"
    if not abundance_path.exists():
        raise RuntimeError(f"R PEAKS ETL did not produce {abundance_path}")
    log2_path = output_dir / "PEAKS_Log2_Normalized_Data.csv"
    traits_path = output_dir / "PEAKS_Sample_Traits_Data.csv"

    # Canonicalize gene names in the R-emitted CSVs (Excel-corruption fix +
    # UniProt → HGNC mapping). The R loader uses whatever the source CSV had;
    # downstream stages and reference comparisons need canonical HGNC.
    _normalize_peaks_feature_ids_in_place(abundance_path, log_fn)
    if log2_path.exists():
        _normalize_peaks_feature_ids_in_place(log2_path, log_fn)

    return {
        "abundance_path": abundance_path,
        "log2_path": log2_path if log2_path.exists() else None,
        "traits_path": traits_path if traits_path.exists() else None,
    }


PEAKS_NORM_R_TIMEOUT_SECONDS = 600


def _peaks_norm_rscript_path() -> Optional[Path]:
    """Path to peaks_DataNormalization_ColumnBased.R; None if Rscript or script missing."""
    from config import BASE_DIR

    script_path = BASE_DIR / "r_scripts" / "peaks_analysis" / "peaks_DataNormalization_ColumnBased.R"
    if not script_path.exists():
        return None
    if not shutil.which("Rscript"):
        return None
    return script_path


def _run_peaks_norm_via_r(
    log2_input_path: Path,
    traits_path: Path,
    output_dir: Path,
    *,
    method: str = "median",
    log_fn: Callable,
) -> dict:
    """Invoke peaks_DataNormalization_ColumnBased.R as a subprocess.

    Reads the log2 ETL output and traits CSV; writes
    PEAKS_Normalized_Log2_Data.csv, PEAKS_Normalized_Abundance_Data.csv,
    PEAKS_Sample_Traits_Data.csv (copy), PEAKS_CBN_Normalization_QC_Plots.pdf,
    PEAKS_MDS_Before_After_Normalization.pdf, PEAKS_Normalization_Summary.txt
    to <output_dir>. Raises RuntimeError on any failure so callers can fall
    back to the Python normalization path.
    """
    script = _peaks_norm_rscript_path()
    if script is None:
        raise RuntimeError(
            "R-native PEAKS normalization unavailable (Rscript or peaks_DataNormalization_ColumnBased.R missing)."
        )
    if not log2_input_path.exists():
        raise RuntimeError(f"Log2 input not found at {log2_input_path}")

    output_dir.mkdir(parents=True, exist_ok=True)
    wrapper_path = output_dir / "_peaks_norm_invoke.R"
    wrapper_path.write_text(
        f"""# Auto-generated by _run_peaks_norm_via_r — do not edit.
source({_r_quote(str(script))})
cleanDat <- as.matrix(read.csv({_r_quote(str(log2_input_path))}, row.names = 1, check.names = FALSE))
traitsMetaData <- if (file.exists({_r_quote(str(traits_path))})) {{
  read.csv({_r_quote(str(traits_path))}, row.names = 1, check.names = FALSE, stringsAsFactors = FALSE)
}} else {{
  data.frame(SAMPLE_ID = colnames(cleanDat), GROUP = rep("Unknown", ncol(cleanDat)), row.names = colnames(cleanDat))
}}
result <- peaks_ColumnNormalization(
  cleanDat = cleanDat,
  traitsMetaData = traitsMetaData,
  method = {_r_quote(method)},
  outputDir = {_r_quote(str(output_dir))},
  generatePlots = TRUE
)
cat(sprintf("[peaks_norm] features=%d samples=%d\\n",
            nrow(result$normalizedData), ncol(result$normalizedData)))
"""
    )

    log_fn(f"[{_ts()}] Invoking R PEAKS CBN normalization ({method})")
    try:
        result = subprocess.run(
            ["Rscript", "--vanilla", str(wrapper_path)],
            capture_output=True,
            text=True,
            timeout=PEAKS_NORM_R_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"R PEAKS normalization timed out after {PEAKS_NORM_R_TIMEOUT_SECONDS}s"
        ) from exc

    for line in (result.stdout or "").splitlines():
        if line.strip():
            log_fn(line.rstrip())
    if result.returncode != 0:
        for line in (result.stderr or "").splitlines():
            if line.strip():
                log_fn(f"[r-stderr] {line.rstrip()}")
        raise RuntimeError(f"R PEAKS normalization exited with code {result.returncode}")

    norm_path = output_dir / "PEAKS_Normalized_Log2_Data.csv"
    abundance_norm_path = output_dir / "PEAKS_Normalized_Abundance_Data.csv"
    if not norm_path.exists():
        raise RuntimeError(f"R PEAKS normalization did not produce {norm_path}")

    # Canonicalize gene names in the R-emitted normalization outputs.
    _normalize_peaks_feature_ids_in_place(norm_path, log_fn)
    if abundance_norm_path.exists():
        _normalize_peaks_feature_ids_in_place(abundance_norm_path, log_fn)

    return {
        "log2_normalized": norm_path,
        "abundance_normalized": abundance_norm_path,
        "traits": output_dir / "PEAKS_Sample_Traits_Data.csv",
        "summary": output_dir / "PEAKS_Normalization_Summary.txt",
        "qc_plots": output_dir / "PEAKS_CBN_Normalization_QC_Plots.pdf",
        "mds_plots": output_dir / "PEAKS_MDS_Before_After_Normalization.pdf",
    }


def _qnorm_rank(series: pd.Series) -> pd.Series:
    """Quantile-normal rank transform: x_std_i = qnorm((rank_i - 0.5) / n_valid).

    Average-rank for ties (consistent with R's rank() default), preserves NaN,
    returns all-NaN when fewer than 2 non-null values are present.
    """
    valid_mask = series.notna()
    n_valid = int(valid_mask.sum())
    if n_valid < 2:
        return pd.Series([float("nan")] * len(series), index=series.index, dtype=float)
    valid = series[valid_mask].astype(float)
    ranks = valid.rank(method="average")
    qnorm_values = _scipy_stats.norm.ppf((ranks - 0.5) / n_valid)
    out = pd.Series([float("nan")] * len(series), index=series.index, dtype=float)
    out.loc[valid.index] = qnorm_values
    return out


def _expand_traits(traits_df: pd.DataFrame) -> pd.DataFrame:
    """Derive _raw/_std variants for canonical AD-bucket trait names.

    For each canonical column (T_TAU, P_TAU, ABETA42), if the column exists in
    traits_df, emit <name>_raw (= original) and <name>_std (= qnorm rank), and
    drop the original. Other columns are passed through unchanged.
    """
    expanded = traits_df.copy()
    canonicals = ("T_TAU", "P_TAU", "ABETA42")
    for canonical in canonicals:
        if canonical not in expanded.columns:
            continue
        raw_col = f"{canonical}_raw"
        std_col = f"{canonical}_std"
        if raw_col not in expanded.columns:
            expanded[raw_col] = expanded[canonical]
        if std_col not in expanded.columns:
            expanded[std_col] = _qnorm_rank(expanded[canonical])
        expanded = expanded.drop(columns=[canonical])
    return expanded


# Maps case-insensitive input column names to canonical biomarker names.
# Canonical names must match what _expand_traits() recognizes (T_TAU, P_TAU, ABETA42).
_BIOMARKER_SYNONYMS: dict[str, str] = {
    # T_TAU synonyms
    "tau": "T_TAU",
    "total_tau": "T_TAU",
    "tau_total": "T_TAU",
    "ttau": "T_TAU",
    "t_tau": "T_TAU",
    # P_TAU synonyms
    "ptau": "P_TAU",
    "phospho_tau": "P_TAU",
    "p_tau": "P_TAU",
    "ptau181": "P_TAU",
    "phosphotau": "P_TAU",
    # ABETA42 synonyms
    "abeta42": "ABETA42",
    "ab42": "ABETA42",
    "amyloid_beta": "ABETA42",
    "amyloid42": "ABETA42",
}


def _normalize_biomarker_synonyms(df: pd.DataFrame) -> pd.DataFrame:
    """Rename synonym biomarker columns to canonical names (T_TAU, P_TAU, ABETA42).

    Matching is case-insensitive. Canonical names already present in the
    DataFrame are left untouched. Only the first synonym match wins (no
    double-rename). Returns a copy — does not mutate the input.
    """
    rename_map: dict[str, str] = {}
    canonical_already_present = {c for c in df.columns if c in ("T_TAU", "P_TAU", "ABETA42")}
    for col in df.columns:
        normalized = re.sub(r"[^a-z0-9]+", "_", str(col).lower()).strip("_")
        canonical = _BIOMARKER_SYNONYMS.get(normalized)
        if canonical and canonical not in canonical_already_present and col not in rename_map.values():
            rename_map[col] = canonical
    return df.rename(columns=rename_map)


def _run_stage1_via_r(config: dict, run_dir: Path, log_fn: Callable, step_callback: Optional[Callable[[str, str, int, str], None]] = None):
    script_path = _stage1_rscript_path()
    if not script_path:
        raise RuntimeError("R-backed Stage 1 is unavailable on this system.")

    stage_dir = run_dir / "stage1"
    stage_dir.mkdir(parents=True, exist_ok=True)

    r_config = dict(config)
    # Pin filesystem paths to expected locations within run_dir to prevent
    # path-traversal attacks from user-controlled config values (CR-01).
    r_config["input_dir"] = str((run_dir / "input").resolve())
    r_config["output_directory"] = str((run_dir / "stage1").resolve())
    r_config["run_dir"] = str(run_dir.resolve())
    r_config.setdefault("wgcna_hub_percentile", 0.2)

    # Expand canonical AD-bucket traits into _raw/_std pairs so downstream
    # deliverables match the reference shape. The expanded frame is written to
    # stage1/expanded_traits.csv and the R script is pointed at this file via
    # the traits_path config key (stage1_parity.R falls back to
    # input/traits.csv when traits_path is missing).
    traits_input_path = run_dir / "input" / "traits.csv"
    if traits_input_path.exists():
        try:
            raw_traits_df = pd.read_csv(traits_input_path)
            expanded_df = _expand_traits(raw_traits_df)
            expanded_traits_path = stage_dir / "expanded_traits.csv"
            expanded_df.to_csv(expanded_traits_path, index=False)
            r_config["traits_path"] = str(expanded_traits_path.resolve())
            log_fn(
                f"[{_ts()}] Expanded {max(len(raw_traits_df.columns) - 1, 0)} input trait column(s) "
                f"into {max(len(expanded_df.columns) - 1, 0)} (raw/std variants where applicable)"
            )
        except Exception as exc:  # noqa: BLE001 — non-fatal, R script falls back to input/traits.csv
            log_fn(f"[{_ts()}] WARNING: trait expansion failed ({exc}); using raw traits.csv")

    import random as _random
    if "wgcna_seed" not in r_config or r_config["wgcna_seed"] is None:
        r_config["wgcna_seed"] = _random.randint(1, 1_000_000)
    else:
        r_config["wgcna_seed"] = int(r_config["wgcna_seed"])

    config_path = run_dir / "config_stage1_r.json"
    config_path.write_text(json.dumps(r_config, indent=2))

    log_fn(f"[{_ts()}] Launching R Stage 1 parity runner")
    process = subprocess.Popen(
        ["Rscript", "--vanilla", str(script_path), str(config_path)],
        cwd=str(run_dir),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,
    )
    assert process.stdout is not None

    timed_out = threading.Event()

    def _kill_on_timeout():
        timed_out.set()
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass  # process already finished

    watchdog = threading.Timer(STAGE1_R_TIMEOUT_SECONDS, _kill_on_timeout)
    watchdog.daemon = True
    watchdog.start()

    try:
        try:
            for line in process.stdout:
                line = line.rstrip()
                if line:
                    log_fn(line)
                    if step_callback:
                        lowered = line.lower()
                        if "loading canonical matrix bundle" in lowered:
                            step_callback("processing_sample_alignment", "running", 25, "Loading and aligning samples")
                        elif "retained" in lowered and "features after missingness" in lowered:
                            step_callback("outlier_removal", "complete", 100, "Missingness and sample-present filters applied")
                            step_callback("variance_batch_correction", "skipped", 100, "No dedicated variance-correction pass configured")
                        elif ("applying total intensity normalization" in lowered
                              or "applying log2 transform" in lowered
                              or ("applying " in lowered and "normalization" in lowered)):
                            step_callback("normalization", "running", 60, "Normalizing abundance matrix")
                        elif "running differential expression" in lowered:
                            step_callback("normalization", "complete", 100, "Normalization outputs written")
                            step_callback("differential_expression", "running", 65, "Running differential expression")
                        elif "running wgcna" in lowered:
                            step_callback("differential_expression", "complete", 100, "Differential expression complete")
                            step_callback("wgcna_network", "running", 75, "Running WGCNA network analysis")
                        elif "skipping wgcna" in lowered:
                            step_callback("wgcna_network", "skipped", 100, "Filtered matrix too small for stable module detection")
                        elif "stage 1 complete" in lowered:
                            step_callback("processing_sample_alignment", "complete", 100, "Input bundle aligned")
                            if not config.get("_outlier_marked"):
                                step_callback("outlier_removal", "complete", 100, "Feature filtering complete")
                            step_callback("normalization", "complete", 100, "Normalization complete")
                            step_callback("differential_expression", "complete", 100, "Differential expression complete")
                            step_callback("wgcna_network", "complete", 100, "WGCNA outputs ready")
        except ValueError:
            pass  # stdout pipe closed by watchdog kill — handled below via timed_out check
        return_code = process.wait()
    finally:
        watchdog.cancel()
        if hasattr(process.stdout, "close"):
            process.stdout.close()
    if timed_out.is_set():
        raise RuntimeError(
            "R Stage 1 exceeded 2-hour time limit and was terminated"
        )
    if return_code != 0:
        raise RuntimeError(f"R Stage 1 failed with exit code {return_code}")

    required_outputs = [
        stage_dir / "normalized_matrix.csv",
        stage_dir / "volcano_results.tsv",
        stage_dir / "module_assignments.csv",
        stage_dir / "analysis_summary.json",
    ]
    missing = [path.name for path in required_outputs if not path.exists()]
    if missing:
        raise RuntimeError(f"R Stage 1 completed without required outputs: {', '.join(missing)}")

    # Warn if WGCNA produced no modules (partial failure the R script masked) (WR-04).
    summary_path = stage_dir / "analysis_summary.json"
    if summary_path.exists():
        summary = json.loads(summary_path.read_text())
        if summary.get("wgcna_modules", 0) == 0:
            log_fn(f"[{_ts()}] WARNING: WGCNA produced no modules -- check input data quality")


def run_stage1(
    config: dict,
    run_dir: Path,
    log_fn: Callable,
    step_callback: Optional[Callable[[str, str, int, str], None]] = None,
):
    """
    Inputs: PEAKS CSV file path (config["input_file"])
    Outputs: run_dir/stage1/ with normalized_matrix.csv, volcano_results.tsv,
             module_assignments.csv, module_trait_cor.csv, analysis_summary.json
    """
    rscript_path = _stage1_rscript_path()
    if rscript_path is None:
        rscript_missing = not shutil.which("Rscript")
        script_missing = not (Path(__file__).resolve().parent.parent / "r_scripts" / "stage1_parity.R").exists()
        detail = []
        if rscript_missing:
            detail.append(
                "Rscript not found in PATH -- install R (https://cran.r-project.org/)"
            )
        if script_missing:
            detail.append(
                "stage1_parity.R not found in backend/r_scripts/"
            )
        raise RuntimeError(
            "R Stage 1 is required but unavailable. " + "; ".join(detail)
        )
    excluded = config.get("excluded_samples", [])
    if excluded:
        import pandas as _pd
        import shutil as _sh
        matrix_path = run_dir / "input" / "cleaned_matrix.csv"
        if matrix_path.exists():
            _m = _pd.read_csv(matrix_path)
            to_drop = [c for c in excluded if c in _m.columns]
            if to_drop:
                _sh.copy2(matrix_path, run_dir / "input" / "cleaned_matrix_pre_outlier.csv")
                _m = _m.drop(columns=to_drop)
                _m.to_csv(matrix_path, index=False)
    _run_stage1_via_r(config, run_dir, log_fn, step_callback=step_callback)


def write_trait_associated_modules(run_dir: Path, log_fn: Callable):
    """Generate per-trait Associated_Modules.csv from module_trait_cor.csv.

    The R reference produces sub-directories per trait (disease_status/,
    amyloid_beta/, etc.) each containing *_Associated_Modules.csv with
    significantly correlated modules.  This derives the same output from
    the module-trait correlation table already written by stage1_parity.R.
    """
    trait_cor_path = run_dir / "stage1" / "module_trait_cor.csv"
    if not trait_cor_path.exists():
        log_fn(f"[{_ts()}] No module_trait_cor.csv — skipping per-trait module outputs")
        return

    cor_df = pd.read_csv(trait_cor_path)
    if "module_color" not in cor_df.columns:
        return

    # Extract trait names from column pairs cor_X / p_X
    trait_names = [
        col[4:]  # strip "cor_" prefix
        for col in cor_df.columns
        if col.startswith("cor_")
    ]
    if not trait_names:
        return

    trait_dir = run_dir / "stage1" / "trait_associations"
    trait_dir.mkdir(parents=True, exist_ok=True)
    p_threshold = 0.05
    correlation_cutoff = 0.3

    for trait in trait_names:
        cor_col = f"cor_{trait}"
        p_col = f"p_{trait}"
        if cor_col not in cor_df.columns or p_col not in cor_df.columns:
            continue

        rows = []
        for _, row in cor_df.iterrows():
            p_val = row[p_col]
            cor_val = row[cor_col]
            if pd.notna(p_val) and pd.notna(cor_val) and abs(float(cor_val)) >= correlation_cutoff and p_val < p_threshold:
                direction = f"Upregulated_in_{trait}" if cor_val > 0 else f"Downregulated_in_{trait}"
                rows.append({
                    "Module": row["module_color"],
                    "Correlation": round(cor_val, 6),
                    "P_Value": p_val,
                    "Direction": direction,
                })

        if rows:
            out_df = pd.DataFrame(rows).sort_values("P_Value")
            safe_name = re.sub(r"[^\w\-]", "_", trait)
            out_df.to_csv(trait_dir / f"{safe_name}_Associated_Modules.csv", index=False)

    written = list(trait_dir.glob("*_Associated_Modules.csv"))
    if written:
        log_fn(f"[{_ts()}] Written {len(written)} per-trait Associated_Modules files to stage1/trait_associations/")


# ──────────────────────────────────────────────────────────────────────────────
# FULL PIPELINE RUNNER
# ──────────────────────────────────────────────────────────────────────────────

def run_full_pipeline(run_id: str):
    """
    Entry point called as a background thread.
    Runs Stage 1 → Stage 2 → Stage 3 sequentially.
    Updates run status in DB at each milestone.
    """
    import json as _json
    from database import Run, RunStatus, SessionLocal
    from config import RUNS_DIR, UPLOADS_DIR

    db = SessionLocal()
    run_dir = RUNS_DIR / run_id

    def log_fn(line: str):
        _append_log(db, run_id, line)

    def mark_step(stage_key: str, status: str, progress: int, message: str):
        _set_stage_status(db, run_id, stage_key, status, progress=progress, message=message)

    try:
        run = db.query(Run).filter(Run.id == run_id).first()
        if not run:
            return

        run.status = RunStatus.RUNNING
        run.started_at = datetime.utcnow()
        db.commit()
        mark_step("etl", "running", 10, "Preparing canonical input bundle")

        params = _json.loads(run.params)

        # Resolve input file path
        file_id = run.file_id
        # Find uploaded file
        from database import UploadedFile
        ufile = db.query(UploadedFile).filter(UploadedFile.id == file_id).first()
        if ufile:
            input_file = ufile.stored_path
        else:
            # Try to find it in uploads dir
            candidates = list(UPLOADS_DIR.glob(f"{file_id}*"))
            input_file = str(candidates[0]) if candidates else str(UPLOADS_DIR / file_id)

        run_dir.mkdir(parents=True, exist_ok=True)
        canonical_manifest = _build_canonical_bundle(input_file, params, run_dir, log_fn)
        pipeline_profile = resolve_pipeline_profile(canonical_manifest, params)
        write_pipeline_profile(run_dir, pipeline_profile)
        _index_files(db, run_id, "input", run_dir / "input")
        mark_step("etl", "complete", 100, "Canonical input bundle ready")

        # P2-A: detect outliers before stage1 (blocks if candidates found)
        excluded_samples = _detect_outliers(run_id, run_dir, params, log_fn, mark_step, db)

        # ── STAGE 1 ───────────────────────────────────────────────────────────
        log_fn("[ProteomicsAI] ═══ STAGE 1: Normalization + DE + WGCNA ═══")
        config1 = {
            "input_file": input_file,
            "output_directory": str(run_dir / "stage1"),
            "format_family": canonical_manifest.get("format_family", "Unknown"),
            "input_level": canonical_manifest.get("assay_level", "unknown"),
            "value_scale": canonical_manifest.get("value_scale", "unknown"),
            "group1_name": params.get("cohort1", "Control"),
            "group2_name": params.get("cohort2", "Disease"),
            "normalization_method": params.get("normalization_method", "median"),
            "missing_value_threshold": params.get("missing_value_threshold", 0.5),
            "log_transform": params.get("log_transform", True),
            "min_samples_present": params.get("min_samples_present", 3),
            "pvalue_threshold": params.get("pvalue_threshold", 0.05),
            "fold_change_threshold": params.get("fold_change_threshold", 1.5),
            "use_adjusted_pvalue": params.get("use_adjusted_pvalue", True),
            "statistical_test": params.get("statistical_test", "t-test"),
            "wgcna_soft_threshold": params.get("wgcna_power", 8),
            "wgcna_min_module_size": params.get("min_module_size", 20),
            "wgcna_deep_split": params.get("deep_split", 3),
            "wgcna_merge_cut_height": params.get("merge_cut_height", 0.30),
            "wgcna_network_type": params.get("network_type", "signed"),
            "wgcna_correlation_type": params.get("correlation_type", "bicor"),
            "wgcna_hub_percentile": params.get("hub_percentile", 0.2),
            "outlier_z_threshold": params.get("outlier_z_threshold", 3.0),
            "outlier_mode": params.get("outlier_mode", "low_connectivity"),
            "variance_correction_enabled": params.get("variance_correction_enabled", False),
            "variance_correction_method": params.get("variance_correction_method", "linear_regression"),
            "batch_covariates": params.get("batch_covariates", []),
            "preserve_biological_variables": params.get("preserve_biological_variables", []),
            "multiple_testing_method": params.get("multiple_testing_method", "fdr_bh"),
            "wgcna_power_mode": params.get("wgcna_power_mode", "fixed"),
            "wgcna_auto_power_cutoff": params.get("wgcna_auto_power_cutoff", 0.8),
            "wgcna_tom_type": params.get("tom_type", "signed"),
            "wgcna_pam_stage": params.get("pam_stage", True),
        }
        (run_dir / "config_stage1.json").write_text(_json.dumps(config1, indent=2))
        config1["excluded_samples"] = excluded_samples
        config1["_outlier_marked"] = True

        run_stage1(config1, run_dir, log_fn, step_callback=mark_step)

        _index_files(db, run_id, "stage1", run_dir / "stage1")
        log_fn("[ProteomicsAI] ✓ Stage 1 complete")

        # Parse stage1 summary into DB
        summary_path = run_dir / "stage1" / "analysis_summary.json"
        if summary_path.exists():
            summary = _json.loads(summary_path.read_text())
            run = db.query(Run).filter(Run.id == run_id).first()
            run.sig_peptides = summary.get("peptides_significant")
            run.up_peptides = summary.get("peptides_upregulated")
            run.down_peptides = summary.get("peptides_downregulated")
            run.modules_count = summary.get("wgcna_modules")
            run.metrics_json = _json.dumps(summary)
            db.commit()

        # Per-trait associated module outputs (matches R reference sub-analyses)
        write_trait_associated_modules(run_dir, log_fn)

        # ── STAGE 2 ───────────────────────────────────────────────────────────
        log_fn("[ProteomicsAI] ═══ STAGE 2: GO Enrichment ═══")
        config2 = {
            "output_directory": str(run_dir / "stage2"),
            "go_categories": params.get("go_categories", ["BP", "MF", "CC"]),
            "fdr_threshold": params.get("fdr_threshold", 0.05),
            "min_hits_per_ontology": params.get("min_hits_per_ontology", 3),
            "go_min_hits": params.get("go_min_hits", params.get("min_hits_per_ontology", 3)),
            "remove_redundant_go": params.get("remove_redundant_go", "kappa"),
            "gmt_background_behavior": params.get("gmt_background_behavior", "measured_features"),
            "gmt_file": params.get("gmt_file"),
        }
        (run_dir / "config_stage2.json").write_text(_json.dumps(config2, indent=2))

        run_stage2(config2, run_dir, log_fn, step_callback=mark_step)

        _index_files(db, run_id, "stage2", run_dir / "stage2")
        log_fn("[ProteomicsAI] ✓ Stage 2 complete")

        go_summary_path = run_dir / "stage2" / "go_summary.json"
        if go_summary_path.exists():
            gs = _json.loads(go_summary_path.read_text())
            run = db.query(Run).filter(Run.id == run_id).first()
            run.go_terms = gs.get("significant_terms", 0)
            db.commit()

        # ── STAGE 3 ───────────────────────────────────────────────────────────
        log_fn("[ProteomicsAI] ═══ STAGE 3: Cell Type Enrichment ═══")
        config3 = {
            "output_directory": str(run_dir / "stage3"),
            "heatmap_scale": params.get("heatmap_scale", "minusLogFDR"),
            "adjust_fet_lookup": params.get("adjust_fet_lookup", False),
            "celltype_reference": params.get("celltype_reference", "human_sharma_zhang_union"),
            "celltype_species_mode": params.get("celltype_species_mode", "human"),
            "celltype_duplicate_handling": params.get("celltype_duplicate_handling", "allow"),
            "celltype_markers_file": params.get("celltype_markers_file"),
        }
        (run_dir / "config_stage3.json").write_text(_json.dumps(config3, indent=2))

        run_stage3(config3, run_dir, log_fn, step_callback=mark_step)

        _index_files(db, run_id, "stage3", run_dir / "stage3")
        log_fn("[ProteomicsAI] ✓ Stage 3 complete")

        # ── DELIVERABLES / ARTIFACT INDEX ───────────────────────────────────
        mark_step("deliverable_packaging", "running", 20, "Preparing deliverables and artifact index")
        emit_pipeline_html_bundle(run_dir, pipeline_profile, log_fn)
        emit_legacy_bundle(run_dir, pipeline_profile, params, log_fn)
        stats_control_audit = _write_stats_control_audit(run_id, run_dir, params)

        # ── FINISH ────────────────────────────────────────────────────────────
        manifest = {
            "run_id": run_id,
            "name": run.name,
            "completed_at": datetime.utcnow().isoformat(),
            "params": params,
            "dataset_hash": run.dataset_hash,
            "param_fingerprint": run.param_fingerprint,
            "analysis_format": run.analysis_format,
            "input_level": run.input_level,
            "canonical_bundle": canonical_manifest,
            "pipeline_profile": pipeline_profile["pipeline_profile"],
            "deliverable_variant": pipeline_profile["deliverable_variant"],
            "supported_steps": pipeline_profile["supported_steps"],
            "supported_tabs": pipeline_profile["supported_tabs"],
        }
        (run_dir / "run_manifest.json").write_text(_json.dumps(manifest, indent=2))
        (run_dir / "params.json").write_text(_json.dumps(params, indent=2))
        artifact_manifest = write_artifact_manifest(
            run_dir,
            {
                **pipeline_profile,
                "generated_at": datetime.utcnow().isoformat(),
            },
        )
        # Write artifact index once, after all files (including manifest copy)
        # are in place so the scan is complete and authoritative (CR-02).
        artifact_index = write_artifact_index(
            run_id,
            run_dir,
            metadata={
                "generated_at": datetime.utcnow().isoformat(),
                "pipeline_profile": pipeline_profile["pipeline_profile"],
                "deliverable_variant": pipeline_profile["deliverable_variant"],
                "supported_steps": pipeline_profile["supported_steps"],
                "supported_tabs": pipeline_profile["supported_tabs"],
                "input_level": pipeline_profile["input_level"],
            },
        )
        _index_files(db, run_id, "meta", run_dir)

        run = db.query(Run).filter(Run.id == run_id).first()
        run.status = RunStatus.COMPLETE
        run.completed_at = datetime.utcnow()
        run.manifest_path = str(run_dir / "run_manifest.json")
        run.metrics_json = _json.dumps(
            {
                **(_json.loads(run.metrics_json or "{}") if run.metrics_json else {}),
                "pipeline_profile": pipeline_profile["pipeline_profile"],
                "deliverable_variant": pipeline_profile["deliverable_variant"],
                "supported_steps": pipeline_profile["supported_steps"],
                "supported_tabs": pipeline_profile["supported_tabs"],
                "artifact_manifest_path": str(run_dir / "artifact_manifest.json"),
                "artifact_index_path": str(run_dir / "artifact_index.json"),
                "stats_control_audit_path": str(run_dir / "stats_control_audit.json"),
                "stats_control_count": len(stats_control_audit.get("controls", [])),
                "artifact_manifest_count": len(artifact_manifest.get("entries", {})),
                "artifact_count": len(artifact_index.get("artifacts", [])),
            }
        )
        log_fn("[ProteomicsAI] ══════════════════════════════════")
        log_fn("[ProteomicsAI] PIPELINE COMPLETE — all outputs saved")
        log_fn("[ProteomicsAI] ══════════════════════════════════")
        mark_step("deliverable_packaging", "complete", 100, "Run files ready for download and review")
        db.commit()

    except Exception as e:
        import traceback
        try:
            db.rollback()
        except Exception:
            # Connection may be broken after long-running pipeline; reconnect
            # so the error-status update below has a healthy session (WR-03).
            db.close()
            db = SessionLocal()
        try:
            run = db.query(Run).filter(Run.id == run_id).first()
            if run:
                run.status = RunStatus.FAILED
                run.error_message = str(e)
                run.completed_at = datetime.utcnow()
                log_fn(f"[ProteomicsAI] ERROR: {e}")
                log_fn(f"[ProteomicsAI] {traceback.format_exc()}")
                for stage_key in (
                    "etl",
                    "processing_sample_alignment",
                    "outlier_removal",
                    "normalization",
                    "variance_batch_correction",
                    "differential_expression",
                    "wgcna_network",
                    "goparallel",
                    "celltypefet",
                    "deliverable_packaging",
                ):
                    _set_stage_status(db, run_id, stage_key, "failed", message=str(e))
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


def start_pipeline_thread(run_id: str):
    """Launch pipeline in a background thread (fire and forget)."""
    t = threading.Thread(target=run_full_pipeline, args=(run_id,), daemon=True)
    t.start()
