from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pandas as pd

from database import UploadKind


def _norm(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def _column_lookup(columns: list[str]) -> dict[str, str]:
    return {_norm(column): str(column) for column in columns}


def _first_present(columns: list[str], candidates: list[str]) -> str | None:
    lookup = _column_lookup(columns)
    for candidate in candidates:
        match = lookup.get(_norm(candidate))
        if match:
            return match
    return None


def _present(columns: list[str], candidates: list[str]) -> list[str]:
    lookup = _column_lookup(columns)
    return [lookup[_norm(candidate)] for candidate in candidates if _norm(candidate) in lookup]


def _numeric_like_columns(df: pd.DataFrame, columns: list[str] | None = None) -> list[str]:
    result: list[str] = []
    for column in columns or [str(c) for c in df.columns]:
        if column not in df.columns or pd.api.types.is_bool_dtype(df[column]):
            continue
        if pd.api.types.is_numeric_dtype(df[column]):
            result.append(column)
            continue
        coerced = pd.to_numeric(df[column], errors="coerce")
        if len(coerced) and float(coerced.notna().mean()) >= 0.70:
            result.append(column)
    return result


def _confidence_label(confidence: float) -> str:
    if confidence >= 0.90:
        return "high"
    if confidence >= 0.70:
        return "medium"
    if confidence >= 0.45:
        return "low"
    return "unknown"


def _make_detection(
    *,
    format_detected: str,
    format_family: str,
    assay_level: str,
    sample_count: int,
    peptide_count: int,
    confidence: float,
    evidence: list[str],
    detected_columns: dict[str, Any] | None = None,
    warnings: list[str] | None = None,
    value_scale_hint: str = "linear",
    run_ready: bool = True,
) -> dict[str, Any]:
    confidence = max(0.0, min(1.0, float(confidence)))
    return {
        "format_detected": format_detected,
        "format_family": format_family,
        "assay_level": assay_level,
        "sample_count": int(sample_count or 0),
        "peptide_count": int(peptide_count or 0),
        "confidence": round(confidence, 3),
        "confidence_label": _confidence_label(confidence),
        "evidence": evidence,
        "detected_columns": detected_columns or {},
        "warnings": warnings or [],
        "value_scale_hint": value_scale_hint,
        "run_ready": bool(run_ready),
        "manual_override_recommended": confidence < 0.90,
    }


def _count_unique(df: pd.DataFrame, column: str | None) -> int:
    if not column or column not in df.columns:
        return 0
    return int(df[column].dropna().astype(str).nunique())


def _filter_olink_samples(df: pd.DataFrame) -> pd.DataFrame:
    sample_frame = df
    sample_type_col = _first_present([str(c) for c in df.columns], ["SampleType", "Sample_Type"])
    assay_type_col = _first_present([str(c) for c in df.columns], ["AssayType"])
    sample_qc_col = _first_present([str(c) for c in df.columns], ["SampleQC", "QC_Warning"])
    if sample_type_col:
        sample_frame = sample_frame[sample_frame[sample_type_col].astype(str).str.upper().isin({"SAMPLE", "SAMPLES"})]
    if assay_type_col:
        sample_frame = sample_frame[sample_frame[assay_type_col].astype(str).str.lower().isin({"assay", "assays"})]
    if sample_qc_col:
        sample_frame = sample_frame[~sample_frame[sample_qc_col].astype(str).str.upper().isin({"FAIL", "FAILED"})]
    return sample_frame


def _detect_olink(df: pd.DataFrame, columns: list[str]) -> dict[str, Any] | None:
    sample_col = _first_present(columns, ["SampleID"])
    assay_col = _first_present(columns, ["Assay"])
    value_col = _first_present(columns, ["NPX", "PCNormalizedNPX", "ExtNPX"])
    quant_value_col = _first_present(columns, ["QuantifiedValue", "Quantified_value", "Count"])
    olink_id_col = _first_present(columns, ["OlinkID"])
    uniprot_col = _first_present(columns, ["UniProt"])
    marker_cols = _present(columns, ["Panel", "PlateID", "QC_Warning", "SampleQC", "LOD", "MissingFreq", "AssayQC"])
    if not (sample_col and assay_col and (value_col or quant_value_col)):
        return None

    filtered = _filter_olink_samples(df)
    if not value_col:
        return _make_detection(
            format_detected="Olink Quant Long Table",
            format_family="Olink",
            assay_level="protein",
            sample_count=_count_unique(filtered, sample_col),
            peptide_count=_count_unique(filtered, assay_col),
            confidence=0.86,
            evidence=[f"found Olink columns: {sample_col}, {assay_col}, {quant_value_col}", *[f"found {col}" for col in marker_cols[:4]]],
            detected_columns={
                "sample": sample_col,
                "feature": assay_col,
                "value": quant_value_col,
                "olink_id": olink_id_col,
                "uniprot": uniprot_col,
            },
            value_scale_hint="linear",
            run_ready=False,
            warnings=["Olink QuantifiedValue exports are detected, but only NPX-valued Olink files are fully supported for downstream analysis today."],
        )

    confidence = 0.92
    if olink_id_col:
        confidence += 0.03
    if uniprot_col:
        confidence += 0.02
    if marker_cols:
        confidence += 0.02
    if value_col != "NPX":
        confidence -= 0.10
    return _make_detection(
        format_detected="Olink NPX Long Matrix" if value_col == "NPX" else "Olink Explore Long Matrix",
        format_family="Olink",
        assay_level="protein",
        sample_count=_count_unique(filtered, sample_col),
        peptide_count=_count_unique(filtered, assay_col),
        confidence=confidence,
        evidence=[f"found Olink columns: {sample_col}, {assay_col}, {value_col}", *[f"found {col}" for col in marker_cols[:4]]],
        detected_columns={
            "sample": sample_col,
            "feature": assay_col,
            "value": value_col,
            "olink_id": olink_id_col,
            "uniprot": uniprot_col,
        },
        value_scale_hint="log2" if value_col == "NPX" else "linear",
        run_ready=value_col == "NPX",
        warnings=[] if value_col == "NPX" else ["Only NPX-valued Olink exports are fully supported by the current pipeline."],
    )


def _detect_spectronaut(df: pd.DataFrame, columns: list[str]) -> dict[str, Any] | None:
    sample_col = _first_present(columns, ["R.FileName", "R.Label", "R.Raw File Name"])
    peptide_value_col = _first_present(columns, ["PEP.Quantity", "PEP.MS2Quantity", "PEP.MS1Quantity", "FG.Quantity"])
    protein_value_col = _first_present(columns, ["PG.Quantity"])
    peptide_col = _first_present(columns, ["PEP.GroupingKey", "PEP.StrippedSequence", "EG.PrecursorId", "EG.ModifiedPeptide"])
    protein_col = _first_present(columns, ["PG.ProteinGroups", "PG.ProteinAccessions", "ProteinAccessions"])
    gene_col = _first_present(columns, ["PG.Genes", "Genes", "Gene Name"])

    value_col = peptide_value_col or protein_value_col
    feature_col = peptide_col if peptide_value_col else protein_col or gene_col
    if not (sample_col and value_col and feature_col):
        return None

    assay_level = "peptide" if peptide_value_col else "protein"
    evidence = [f"found Spectronaut sample column: {sample_col}", f"found quantity column: {value_col}", f"found feature column: {feature_col}"]
    if protein_col:
        evidence.append(f"found protein column: {protein_col}")
    return _make_detection(
        format_detected=f"Spectronaut Long {assay_level.title()}",
        format_family="Spectronaut",
        assay_level=assay_level,
        sample_count=_count_unique(df, sample_col),
        peptide_count=_count_unique(df, feature_col),
        confidence=0.95 if assay_level == "peptide" else 0.92,
        evidence=evidence,
        detected_columns={"sample": sample_col, "feature": feature_col, "value": value_col, "protein": protein_col, "gene": gene_col},
        value_scale_hint="linear",
    )


def _detect_diann(df: pd.DataFrame, columns: list[str], filename: str) -> dict[str, Any] | None:
    filename_key = Path(filename or "").name.lower()
    sample_col = _first_present(columns, ["Run", "File.Name", "File Name"])
    protein_value_col = _first_present(columns, ["PG.MaxLFQ", "Genes.MaxLFQ"])
    precursor_value_col = _first_present(columns, ["Precursor.Normalised", "Precursor.Normalized", "Precursor.Quantity"])
    protein_col = _first_present(columns, ["Protein.Group", "Protein.Ids", "Genes"])
    precursor_col = _first_present(columns, ["Precursor.Id", "Modified.Sequence", "Stripped.Sequence"])
    matrix_signal = any(token in filename_key for token in ("pg_matrix", "pr_matrix", "unique_genes_matrix", "gene_matrix"))

    if sample_col and (protein_value_col or precursor_value_col) and (protein_col or precursor_col):
        value_col = protein_value_col or precursor_value_col
        feature_col = protein_col if protein_value_col else precursor_col or protein_col
        assay_level = "protein" if protein_value_col else "peptide"
        return _make_detection(
            format_detected=f"DIA-NN Long {assay_level.title()} Report",
            format_family="DIA-NN",
            assay_level=assay_level,
            sample_count=_count_unique(df, sample_col),
            peptide_count=_count_unique(df, feature_col),
            confidence=0.94,
            evidence=[f"found DIA-NN run column: {sample_col}", f"found quantity column: {value_col}", f"found feature column: {feature_col}"],
            detected_columns={"sample": sample_col, "feature": feature_col, "value": value_col, "protein": protein_col},
            value_scale_hint="linear",
        )

    if matrix_signal and (protein_col or precursor_col):
        id_columns = {col for col in [protein_col, precursor_col, _first_present(columns, ["Genes"])] if col}
        sample_columns = [col for col in columns if col not in id_columns]
        numeric_samples = _numeric_like_columns(df, sample_columns)
        if numeric_samples:
            assay_level = "peptide" if "pr_matrix" in filename_key or precursor_col else "protein"
            return _make_detection(
                format_detected=f"DIA-NN {'Precursor' if assay_level == 'peptide' else 'Protein'} Matrix",
                format_family="DIA-NN",
                assay_level=assay_level,
                sample_count=len(numeric_samples),
                peptide_count=len(df),
                confidence=0.90,
                evidence=[f"filename suggests DIA-NN matrix: {Path(filename or '').name}", f"found identifier column: {protein_col or precursor_col}"],
                detected_columns={"sample_columns": numeric_samples[:50], "feature": protein_col or precursor_col},
                value_scale_hint="linear",
            )
    return None


def _detect_maxquant(df: pd.DataFrame, columns: list[str], filename: str) -> dict[str, Any] | None:
    filename_key = Path(filename or "").name.lower()
    intensity_cols = [
        column
        for column in columns
        if column.startswith("Intensity ") or column.startswith("LFQ intensity ") or column.startswith("iBAQ ")
    ]
    mq_markers = _present(
        columns,
        ["Protein IDs", "Majority protein IDs", "Gene names", "Sequence", "Proteins", "Protein group IDs", "Evidence IDs", "Potential contaminant", "Reverse"],
    )
    if intensity_cols and mq_markers:
        assay_level = "peptide" if "peptide" in filename_key or _first_present(columns, ["Sequence", "Evidence IDs"]) else "protein"
        return _make_detection(
            format_detected=f"MaxQuant Wide {assay_level.title()} Matrix",
            format_family="MaxQuant",
            assay_level=assay_level,
            sample_count=len(intensity_cols),
            peptide_count=len(df),
            confidence=0.93,
            evidence=[f"found {len(intensity_cols)} MaxQuant intensity columns", *[f"found {col}" for col in mq_markers[:4]]],
            detected_columns={"sample_columns": intensity_cols[:50], "feature": _first_present(columns, ["Sequence", "Protein IDs", "Majority protein IDs"]), "value_prefix": "LFQ intensity/Intensity"},
            value_scale_hint="linear",
        )

    raw_file_col = _first_present(columns, ["Raw file"])
    value_col = _first_present(columns, ["Intensity"])
    sequence_col = _first_present(columns, ["Sequence", "Modified sequence"])
    protein_col = _first_present(columns, ["Proteins", "Protein group IDs", "Leading proteins"])
    if raw_file_col and value_col and sequence_col and protein_col:
        return _make_detection(
            format_detected="MaxQuant Evidence Long Peptide",
            format_family="MaxQuant",
            assay_level="peptide",
            sample_count=_count_unique(df, raw_file_col),
            peptide_count=_count_unique(df, sequence_col),
            confidence=0.92,
            evidence=[f"found MaxQuant evidence columns: {raw_file_col}, {sequence_col}, {value_col}", f"found protein column: {protein_col}"],
            detected_columns={"sample": raw_file_col, "feature": sequence_col, "value": value_col, "protein": protein_col},
            value_scale_hint="linear",
        )
    return None


def _detect_peaks(df: pd.DataFrame, columns: list[str], filename: str) -> dict[str, Any] | None:
    area_cols = [column for column in columns if column.startswith("Area") or column.startswith("Total Area")]
    peaks_markers = _present(columns, ["Accession", "Accession No.", "Peptide", "Sequence", "-10lgP", "ALC (%)", "Feature Area", "Feature Areas", "ppm"])
    if not area_cols:
        return None
    if not peaks_markers and "peaks" not in Path(filename or "").name.lower():
        return None
    assay_level = "peptide" if _first_present(columns, ["Peptide", "Sequence", "Feature Area", "Feature Areas"]) else "protein"
    return _make_detection(
        format_detected=f"PEAKS Wide {assay_level.title()} Matrix",
        format_family="PEAKS",
        assay_level=assay_level,
        sample_count=len(area_cols),
        peptide_count=len(df),
        confidence=0.90 if peaks_markers else 0.78,
        evidence=[f"found {len(area_cols)} PEAKS area columns", *[f"found {col}" for col in peaks_markers[:4]]],
        detected_columns={"sample_columns": area_cols[:50], "feature": _first_present(columns, ["Peptide", "Sequence", "Accession", "Protein"]), "value_prefix": "Area"},
        value_scale_hint="linear",
    )


def detect_input_format(df: pd.DataFrame, *, filename: str = "", file_kind: UploadKind | str = UploadKind.PRIMARY) -> dict[str, Any]:
    kind = UploadKind(file_kind) if not isinstance(file_kind, UploadKind) else file_kind
    if kind == UploadKind.TRAITS:
        columns = [str(column) for column in df.columns]
        sample_col = _first_present(columns, ["SampleID", "sample name", "sample_name", "sample", "SAMPLE_ID"])
        return _make_detection(
            format_detected="Traits Table",
            format_family="Traits",
            assay_level="metadata",
            sample_count=len(df),
            peptide_count=0,
            confidence=0.95 if sample_col else 0.65,
            evidence=[f"found sample column: {sample_col}"] if sample_col else ["traits upload treated as sample metadata"],
            detected_columns={"sample": sample_col},
            value_scale_hint="metadata",
            run_ready=True,
        )

    columns = [str(column) for column in df.columns]
    for detector in (
        _detect_olink,
        _detect_spectronaut,
        lambda frame, cols: _detect_diann(frame, cols, filename),
        lambda frame, cols: _detect_maxquant(frame, cols, filename),
        lambda frame, cols: _detect_peaks(frame, cols, filename),
    ):
        detection = detector(df, columns)
        if detection:
            return detection

    numeric_cols = _numeric_like_columns(df, columns)
    if numeric_cols:
        confidence = 0.82 if len(numeric_cols) >= 3 else 0.58
        return _make_detection(
            format_detected="Generic Wide Matrix",
            format_family="Generic",
            assay_level="unknown",
            sample_count=len(numeric_cols),
            peptide_count=len(df),
            confidence=confidence,
            evidence=[f"found {len(numeric_cols)} numeric sample-like columns"],
            detected_columns={"sample_columns": numeric_cols[:50], "feature": columns[0] if columns else None},
            warnings=[] if confidence >= 0.70 else ["Generic matrix detection is low confidence; choose a profile manually before production analysis."],
            value_scale_hint="unknown",
        )

    return _make_detection(
        format_detected="Unknown",
        format_family="Unknown",
        assay_level="unknown",
        sample_count=0,
        peptide_count=len(df),
        confidence=0.0,
        evidence=[],
        warnings=["No supported proteomics layout was detected."],
        value_scale_hint="unknown",
        run_ready=False,
    )
