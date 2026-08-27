from __future__ import annotations

import json
import logging
import re
import tempfile
import uuid
from io import BytesIO
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from config import ALLOWED_EXTENSIONS, MAX_UPLOAD_SIZE, UPLOADS_DIR
from database import UploadKind, UploadedDataset, User, get_db
from deps import get_current_user, require_workspace_access
from services.audit_service import record_audit
from services.ingestion import (
    SUPPORTED_FORMATS,
    ColumnMappingRequired,
    catalog_entry,
    is_supported_family,
    normalizer_for,
)
from services.input_detector import detect_input_format
from services.profile_defaults import recommended_defaults_for_profile
from utils import file_sha256

router = APIRouter()


def _apply_format_override(
    sniff: dict,
    format_family: Optional[str],
    assay_level: Optional[str],
) -> dict:
    """Overlay a user-selected format/assay onto a sniff dict.

    The manual picker is authoritative: the user's selection always wins, while
    the auto-sniffer's other findings (columns, counts, evidence) are preserved
    as context. Supported families are marked ``run_ready`` because they have a
    real routing path (normalizer, PEAKS R-ETL, Olink native, or generic).
    """
    family = (format_family or "").strip()
    if not family:
        return sniff
    level = (assay_level or "").strip().lower() or sniff.get("assay_level") or "unknown"
    entry = catalog_entry(family)
    canonical_family = entry["family"] if entry else family
    updated = dict(sniff)
    updated["format_family"] = canonical_family
    updated["assay_level"] = level
    updated["format_detected"] = f"{canonical_family} ({level})"
    updated["run_ready"] = bool(is_supported_family(canonical_family))
    updated["user_override"] = True
    updated["auto_detected_family"] = sniff.get("format_family")
    updated["manual_override_recommended"] = False
    if not updated["run_ready"]:
        warnings = list(updated.get("warnings") or [])
        warnings.append(
            f"Format '{canonical_family}' is not yet supported for analysis; "
            "choose a supported format or use Generic."
        )
        updated["warnings"] = warnings
    return updated


def _load_frame(file_path: Path) -> pd.DataFrame:
    ext = file_path.suffix.lower()
    if ext == ".xlsx":
        return pd.read_excel(file_path, nrows=50000)
    if ext == ".parquet":
        return pd.read_parquet(file_path).head(50000)
    if ext in {".tsv", ".txt"}:
        return pd.read_csv(file_path, sep="\t", nrows=50000, low_memory=False)
    return pd.read_csv(file_path, nrows=50000, low_memory=False)


def _load_frame_from_bytes(content: bytes, filename: str) -> pd.DataFrame:
    ext = Path(filename or "").suffix.lower()
    stream = BytesIO(content)
    if ext == ".xlsx":
        return pd.read_excel(stream, nrows=50000)
    if ext == ".parquet":
        return pd.read_parquet(stream).head(50000)
    if ext in {".tsv", ".txt"}:
        return pd.read_csv(stream, sep="\t", nrows=50000, low_memory=False)
    return pd.read_csv(stream, nrows=50000, low_memory=False)


def _first_present(columns: list[str], candidates: list[str]) -> Optional[str]:
    lowered = {str(column).lower(): str(column) for column in columns}
    for candidate in candidates:
        if candidate.lower() in lowered:
            return lowered[candidate.lower()]
    return None


def _sniff_format(file_path: Path, file_kind: UploadKind) -> dict:
    try:
        df = _load_frame(file_path)
    except Exception as error:
        return {
            "format_detected": "Unknown",
            "format_family": "Unknown",
            "assay_level": "unknown",
            "sample_count": 0,
            "peptide_count": 0,
            "confidence": 0.0,
            "confidence_label": "unknown",
            "evidence": [],
            "detected_columns": {},
            "warnings": [f"Could not read file for detection: {error}"],
            "value_scale_hint": "unknown",
            "run_ready": False,
            "manual_override_recommended": True,
        }
    return detect_input_format(df, filename=file_path.name, file_kind=file_kind)


def _preview_payload(frame: pd.DataFrame, sniff: dict, filename: str, size_bytes: int, file_kind: UploadKind) -> dict:
    preview = frame.head(8).replace({pd.NA: None}).where(pd.notnull(frame.head(8)), None)
    columns = [str(column) for column in frame.columns]
    recommendations = recommended_defaults_for_profile(
        sniff.get("format_family"),
        sniff.get("assay_level"),
        sniff.get("format_detected"),
    )
    return {
        "filename": filename,
        "file_kind": file_kind.value,
        "size_bytes": size_bytes,
        "rows_total": int(len(frame)),
        "columns_total": int(len(columns)),
        "columns": columns,
        "preview_rows": preview.to_dict(orient="records"),
        "sniff": sniff,
        "pipeline_profile": recommendations["pipeline_profile"],
        "recommended_defaults": recommendations,
    }


async def _preview_file(file: UploadFile, file_kind: UploadKind) -> dict:
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"File type '{ext}' not allowed")
    content = await file.read()
    if len(content) > MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=413, detail="File too large")

    try:
        frame = _load_frame_from_bytes(content, file.filename or "")
    except Exception as error:
        raise HTTPException(status_code=400, detail=f"Could not preview file: {error}") from error

    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    try:
        sniff = _sniff_format(temp_path, file_kind)
    finally:
        temp_path.unlink(missing_ok=True)
    return _preview_payload(frame, sniff, file.filename or "upload", len(content), file_kind)


@router.post("/uploads")
async def upload_dataset(
    workspace_id: str = Form(...),
    project_id: Optional[str] = Form(default=None),
    file_kind: str = Form(default="primary"),
    format_family: Optional[str] = Form(default=None),
    assay_level: Optional[str] = Form(default=None),
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_workspace_access(db, current_user.id, workspace_id)
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"File type '{ext}' not allowed")
    content = await file.read()
    if len(content) > MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=413, detail="File too large")

    dataset_id = uuid.uuid4().hex[:16]
    stored_path = UPLOADS_DIR / f"{dataset_id}{ext}"
    stored_path.write_bytes(content)
    kind = UploadKind(file_kind)
    sniff = _sniff_format(stored_path, kind)
    # Manual picker (authoritative) — the user-selected format/assay overrides the
    # auto-sniffer while keeping its other findings as context.
    if kind == UploadKind.PRIMARY and (format_family or assay_level):
        sniff = _apply_format_override(sniff, format_family, assay_level)
    dataset_hash = file_sha256(stored_path)

    dataset = UploadedDataset(
        id=dataset_id,
        workspace_id=workspace_id,
        project_id=project_id,
        user_id=current_user.id,
        file_kind=kind,
        original_name=file.filename or stored_path.name,
        stored_path=str(stored_path),
        size_bytes=len(content),
        format_detected=sniff["format_detected"],
        format_family=sniff["format_family"],
        assay_level=sniff["assay_level"],
        peptide_count=sniff["peptide_count"],
        sample_count=sniff["sample_count"],
        dataset_hash=dataset_hash,
        sniff_metadata_json=json.dumps(sniff, sort_keys=True),
    )
    db.add(dataset)
    db.commit()
    record_audit(
        db,
        "upload.created",
        user_id=current_user.id,
        workspace_id=workspace_id,
        project_id=project_id,
        details={"dataset_id": dataset_id, "format": dataset.format_family, "file_kind": kind.value},
    )
    recommendations = recommended_defaults_for_profile(
        dataset.format_family,
        dataset.assay_level,
        dataset.format_detected,
    )

    return {
        "dataset_id": dataset.id,
        "original_name": dataset.original_name,
        "size_bytes": dataset.size_bytes,
        "format_detected": dataset.format_detected,
        "format_family": dataset.format_family,
        "assay_level": dataset.assay_level,
        "peptide_count": dataset.peptide_count,
        "sample_count": dataset.sample_count,
        "dataset_hash": dataset.dataset_hash,
        "file_kind": dataset.file_kind.value,
        "run_ready": bool(sniff.get("run_ready", True)),
        "pipeline_profile": recommendations["pipeline_profile"],
        "recommended_defaults": recommendations,
    }


@router.get("/formats")
def list_supported_formats(current_user: User = Depends(get_current_user)):
    """Catalog for the manual format/assay picker."""
    return {"formats": SUPPORTED_FORMATS}


class FormatOverrideRequest(BaseModel):
    format_family: str
    assay_level: Optional[str] = None
    column_map: Optional[dict] = None


def _validate_format_columns(stored_path: Path, format_family: str, assay_level: str, column_map: Optional[dict]) -> dict:
    """Dry-run the chosen format's normalizer against the file header.

    Returns a ``needs_mapping`` payload when required columns are missing (so the
    UI can render a manual column-mapping fallback), else ``{"needs_mapping": False}``.
    Families without a dedicated normalizer (PEAKS/Olink/Generic) never need mapping.
    """
    if normalizer_for(format_family) is None:
        return {"needs_mapping": False}
    try:
        frame = _load_frame(stored_path)
    except Exception as error:  # noqa: BLE001
        return {"needs_mapping": False, "warning": f"Could not read file for validation: {error}"}
    try:
        normalizer_for(format_family)(frame.head(200), assay_level=assay_level, params={"column_map": column_map or {}})
        return {"needs_mapping": False}
    except ColumnMappingRequired as exc:
        return exc.to_payload()
    except Exception:  # noqa: BLE001 — validation is best-effort; real ETL will surface hard errors
        return {"needs_mapping": False}


def _persist_format_override(dataset: UploadedDataset, req: FormatOverrideRequest) -> dict:
    sniff = json.loads(dataset.sniff_metadata_json or "{}")
    sniff = _apply_format_override(sniff, req.format_family, req.assay_level)
    if req.column_map:
        sniff["column_map"] = req.column_map
    validation = _validate_format_columns(
        Path(dataset.stored_path), sniff["format_family"], sniff["assay_level"], req.column_map
    )
    if validation.get("needs_mapping"):
        sniff["run_ready"] = False
        sniff["needs_mapping"] = True
    else:
        sniff.pop("needs_mapping", None)
    dataset.format_family = sniff["format_family"]
    dataset.assay_level = sniff["assay_level"]
    dataset.format_detected = sniff["format_detected"]
    dataset.sniff_metadata_json = json.dumps(sniff, sort_keys=True)
    return validation


@router.patch("/datasets/{dataset_id}/format")
def override_dataset_format(
    dataset_id: str,
    req: FormatOverrideRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    dataset = db.query(UploadedDataset).filter(UploadedDataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_workspace_access(db, current_user.id, dataset.workspace_id)

    validation = _persist_format_override(dataset, req)
    db.commit()
    record_audit(
        db,
        "upload.format_override",
        user_id=current_user.id,
        workspace_id=dataset.workspace_id,
        project_id=dataset.project_id,
        details={"dataset_id": dataset.id, "format_family": dataset.format_family, "assay_level": dataset.assay_level},
    )
    recommendations = recommended_defaults_for_profile(
        dataset.format_family, dataset.assay_level, dataset.format_detected
    )
    return {
        "dataset_id": dataset.id,
        "format_family": dataset.format_family,
        "assay_level": dataset.assay_level,
        "format_detected": dataset.format_detected,
        "run_ready": json.loads(dataset.sniff_metadata_json).get("run_ready", True),
        "pipeline_profile": recommendations["pipeline_profile"],
        "recommended_defaults": recommendations,
        "validation": validation,
    }


@router.post("/uploads/preview/raw")
async def preview_primary_upload(
    workspace_id: str = Form(...),
    project_id: Optional[str] = Form(default=None),
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_workspace_access(db, current_user.id, workspace_id)
    return await _preview_file(file, UploadKind.PRIMARY)


@router.post("/uploads/preview/traits")
async def preview_traits_upload(
    workspace_id: str = Form(...),
    project_id: Optional[str] = Form(default=None),
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_workspace_access(db, current_user.id, workspace_id)
    return await _preview_file(file, UploadKind.TRAITS)


# ---------------------------------------------------------------------------
# QC and trait-alignment helpers / endpoints (QOL-01, QOL-02)
# ---------------------------------------------------------------------------

_log = logging.getLogger(__name__)


def _sample_match_key(name: str) -> str:
    """Normalize a sample identifier for matching.

    Uses the same logic as pipeline.py: extract canonical 'sampleXNN' token,
    strip .raw.PG.Quantity suffixes, and collapse to alphanumeric lowercase.
    """
    text = str(name or "").strip()
    if not text:
        return ""
    token_match = re.search(r"(sample[a-z]\d+(?:r\d+)?)", text, flags=re.IGNORECASE)
    if token_match:
        return "sample" + token_match.group(1)[6:].upper()
    text = re.sub(r"\.raw(\.pg\.quantity)?$", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\.pg\.quantity$", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\.pep\.quantity$", "", text, flags=re.IGNORECASE)
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def _compute_qc_stats(df: pd.DataFrame) -> dict:
    """Compute CV histogram, per-sample missing %, and PCA from an uploaded dataset."""
    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    if not numeric_cols:
        return {
            "cv_histogram": {"bins": [], "counts": []},
            "missing_pct": {},
            "pca": {"available": False},
        }

    # Cap columns for SVD safety
    if len(numeric_cols) > 5000:
        numeric_cols = numeric_cols[:5000]

    matrix = df[numeric_cols].apply(pd.to_numeric, errors="coerce").values  # n_features x n_samples

    # Missing % per sample
    missing_pct = {
        col: round(float(np.isnan(matrix[:, i]).mean()), 4)
        for i, col in enumerate(numeric_cols)
    }

    # CV per feature with zero-mean guard
    col_means = np.nanmean(matrix, axis=1)
    col_stds = np.nanstd(matrix, axis=1, ddof=0)
    with np.errstate(divide="ignore", invalid="ignore"):
        cv_raw = np.where(np.abs(col_means) > 1e-12, col_stds / np.abs(col_means), np.nan)
    cv_finite = cv_raw[np.isfinite(cv_raw)]
    if len(cv_finite) == 0:
        cv_histogram = {"bins": [], "counts": []}
    else:
        counts, bin_edges = np.histogram(cv_finite, bins=30)
        cv_histogram = {"bins": bin_edges.tolist(), "counts": counts.tolist()}

    # PCA via SVD with degenerate-matrix guard
    if matrix.shape[1] < 3:
        pca = {"available": False}
    else:
        m = matrix.T  # n_samples x n_features
        valid_cols = ~np.isnan(m).any(axis=0)
        m_clean = m[:, valid_cols]
        if m_clean.shape[1] < 2:
            pca = {"available": False}
        else:
            m_clean = m_clean - m_clean.mean(axis=0)
            if np.allclose(m_clean, 0):
                pca = {"available": False}
            else:
                U, S, _ = np.linalg.svd(m_clean, full_matrices=False)
                scores = U * S
                var_explained = (S ** 2) / max((S ** 2).sum(), 1e-12)
                pc1 = scores[:, 0].tolist() if scores.shape[1] >= 1 else []
                pc2 = scores[:, 1].tolist() if scores.shape[1] >= 2 else [0.0] * len(pc1)
                pca = {
                    "available": True,
                    "pc1": pc1,
                    "pc2": pc2,
                    "labels": numeric_cols[: matrix.shape[1]],
                    "var_pct": [
                        round(float(var_explained[0]) * 100, 1),
                        round(float(var_explained[1]) * 100, 1) if len(var_explained) > 1 else 0.0,
                    ],
                }

    return {"cv_histogram": cv_histogram, "missing_pct": missing_pct, "pca": pca}


@router.get("/datasets/{dataset_id}/qc")
def dataset_qc(
    dataset_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    dataset = db.query(UploadedDataset).filter(UploadedDataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_workspace_access(db, current_user.id, dataset.workspace_id)
    try:
        df = _load_frame(Path(dataset.stored_path))
    except Exception as error:
        raise HTTPException(status_code=400, detail=f"Could not read dataset: {error}") from error
    return _compute_qc_stats(df)


def _compute_trait_alignment(dataset_path: Path, traits_path: Path) -> dict:
    """Compute sample-to-trait match statistics."""
    dataset_df = _load_frame(dataset_path)
    traits_df = _load_frame(traits_path)

    # Identify the sample column in traits: first check for "sample" (case-insensitive)
    sample_col = None
    for col in traits_df.columns:
        if str(col).strip().lower() == "sample":
            sample_col = col
            break
    # Fallback: also check common variants
    if sample_col is None:
        for col in traits_df.columns:
            if str(col).strip().lower() in ("sample name", "sample_name", "sampleid", "sample_id"):
                sample_col = col
                break
    # Final fallback: use the first column
    if sample_col is None:
        sample_col = traits_df.columns[0]

    # Build traits_keys with duplicate and empty-ID handling
    traits_keys: dict[str, str] = {}
    for value in traits_df[sample_col]:
        key = _sample_match_key(value)
        if key == "":
            continue
        if key in traits_keys:
            _log.warning("Duplicate trait sample key after normalization: %r", key)
            continue
        traits_keys[key] = str(value)

    # Detect long-format datasets (samples as row values, not column headers)
    dataset_columns = [str(c) for c in dataset_df.columns]
    long_sample_col = _first_present(
        dataset_columns,
        ["Sample Names", "Sample Name", "R.FileName", "R.Label", "Run", "Filename", "File.Name"],
    )
    long_value_col = _first_present(
        dataset_columns,
        ["PEP.Quantity", "PEP.MS2Quantity", "PEP.MS1Quantity", "PG.Quantity", "Precursor.Quantity", "Quantity"],
    )

    if long_sample_col and long_value_col:
        # Long-format: sample names are values in the sample column
        sample_names = dataset_df[long_sample_col].dropna().unique().tolist()
    else:
        # Wide-format: sample names are numeric column headers
        sample_names = [
            col for col in dataset_columns
            if pd.api.types.is_numeric_dtype(dataset_df[col])
            and not pd.api.types.is_bool_dtype(dataset_df[col])
        ]

    matched = 0
    unmatched = []
    for name in sample_names:
        key = _sample_match_key(str(name))
        if key in traits_keys:
            matched += 1
        else:
            unmatched.append(str(name))

    return {"matched": matched, "total": len(sample_names), "unmatched": unmatched}


@router.get("/datasets/trait-alignment-preview")
def trait_alignment_preview(
    dataset_id: str,
    traits_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    dataset = db.query(UploadedDataset).filter(UploadedDataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_workspace_access(db, current_user.id, dataset.workspace_id)
    traits = db.query(UploadedDataset).filter(UploadedDataset.id == traits_id).first()
    if not traits:
        raise HTTPException(status_code=404, detail="Traits dataset not found")
    try:
        return _compute_trait_alignment(Path(dataset.stored_path), Path(traits.stored_path))
    except Exception as error:
        raise HTTPException(status_code=400, detail=f"Could not compute alignment: {error}") from error


def _compute_traits_qc(df: pd.DataFrame) -> dict:
    """Compute summary statistics, missing values, and outlier flags for a clinical traits CSV."""
    all_columns = [str(c) for c in df.columns]
    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    sample_count = len(df)

    column_summaries: dict[str, dict] = {}
    for col in numeric_cols:
        series = pd.to_numeric(df[col], errors="coerce")
        valid = series.dropna()
        missing_count = int(series.isna().sum())
        count = int(len(valid))

        if count == 0:
            column_summaries[col] = {
                "count": 0,
                "mean": None,
                "std": None,
                "min": None,
                "max": None,
                "missing_count": missing_count,
                "missing_pct": round(missing_count / max(sample_count, 1), 4),
                "outlier_count": 0,
                "outlier_indices": [],
            }
            continue

        mean_val = float(valid.mean())
        std_val = float(valid.std(ddof=1)) if count > 1 else 0.0
        min_val = float(valid.min())
        max_val = float(valid.max())

        # IQR outlier detection
        q1 = float(valid.quantile(0.25))
        q3 = float(valid.quantile(0.75))
        iqr = q3 - q1
        lower_bound = q1 - 1.5 * iqr
        upper_bound = q3 + 1.5 * iqr
        outlier_mask = (series < lower_bound) | (series > upper_bound)
        # Only flag non-NaN values as outliers
        outlier_mask = outlier_mask & series.notna()
        outlier_indices = [int(i) for i in series.index[outlier_mask]]

        column_summaries[col] = {
            "count": count,
            "mean": round(mean_val, 4),
            "std": round(std_val, 4),
            "min": round(min_val, 4),
            "max": round(max_val, 4),
            "missing_count": missing_count,
            "missing_pct": round(missing_count / max(sample_count, 1), 4),
            "outlier_count": len(outlier_indices),
            "outlier_indices": outlier_indices,
        }

    return {
        "column_summaries": column_summaries,
        "trait_names": all_columns,
        "sample_count": sample_count,
    }


@router.get("/datasets/{dataset_id}/traits-qc")
def traits_qc(
    dataset_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    dataset = db.query(UploadedDataset).filter(UploadedDataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_workspace_access(db, current_user.id, dataset.workspace_id)
    try:
        df = _load_frame(Path(dataset.stored_path))
    except Exception as error:
        raise HTTPException(status_code=400, detail=f"Could not read traits file: {error}") from error
    return _compute_traits_qc(df)
