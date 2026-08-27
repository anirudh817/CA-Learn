"""Shared helpers for vendor normalizers.

A normalizer maps a vendor-specific raw frame into a canonical *wide* matrix:

- Column 0 is the row identifier: ``Peptide`` for peptide-level assays, else
  ``Accession``.
- ``Gene`` (always present) and, for peptide-level, ``Accession`` follow.
- Every remaining column is one sample with numeric abundances.

That shape is exactly what ``pipeline._canonicalize_input`` consumes via its
generic wide branch, so downstream normalization/DE/WGCNA are untouched.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable, Optional

import pandas as pd


class ColumnMappingRequired(Exception):
    """Raised when a chosen format's required columns are absent.

    Carries enough context for the UI to render a manual column-mapping fallback.
    """

    def __init__(
        self,
        format_family: str,
        *,
        missing_roles: list[str],
        available_columns: list[str],
        suggestions: Optional[dict[str, list[str]]] = None,
    ) -> None:
        self.format_family = format_family
        self.missing_roles = missing_roles
        self.available_columns = available_columns
        self.suggestions = suggestions or {}
        super().__init__(
            f"{format_family}: could not locate required column(s) {missing_roles}. "
            "Manual column mapping required."
        )

    def to_payload(self) -> dict:
        return {
            "needs_mapping": True,
            "format_family": self.format_family,
            "missing_roles": self.missing_roles,
            "available_columns": self.available_columns,
            "suggestions": self.suggestions,
        }


def norm(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def read_frame(path: Path) -> pd.DataFrame:
    suffix = path.suffix.lower()
    if suffix in {".tsv", ".txt"}:
        return pd.read_csv(path, sep="\t")
    if suffix == ".parquet":
        return pd.read_parquet(path)
    if suffix in {".xlsx", ".xls"}:
        return pd.read_excel(path)
    # Default: sniff delimiter (handles comma or tab .csv exports).
    try:
        return pd.read_csv(path, sep=None, engine="python")
    except Exception:
        return pd.read_csv(path)


def first_present(columns: Iterable[str], candidates: Iterable[str]) -> Optional[str]:
    lookup = {norm(column): str(column) for column in columns}
    for candidate in candidates:
        hit = lookup.get(norm(candidate))
        if hit:
            return hit
    return None


def columns_with_suffix(columns: Iterable[str], suffixes: Iterable[str]) -> list[str]:
    out: list[str] = []
    for column in columns:
        text = str(column)
        if any(text.lower().strip().endswith(suffix.lower()) for suffix in suffixes):
            out.append(text)
    return out


def columns_with_prefix(columns: Iterable[str], prefixes: Iterable[str]) -> list[str]:
    out: list[str] = []
    for column in columns:
        text = str(column)
        if any(text.lower().strip().startswith(prefix.lower()) for prefix in prefixes):
            out.append(text)
    return out


def numeric_like_columns(df: pd.DataFrame, columns: Optional[list[str]] = None) -> list[str]:
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


def _clean_sample_name(name: str, strip_suffixes: Iterable[str]) -> str:
    text = str(name).strip()
    for suffix in strip_suffixes:
        if text.lower().endswith(suffix.lower()):
            text = text[: -len(suffix)].strip()
    return text


def assemble_wide(
    *,
    feature: pd.Series,
    gene: Optional[pd.Series],
    accession: Optional[pd.Series],
    samples: pd.DataFrame,
    assay_level: str,
) -> pd.DataFrame:
    """Build the canonical wide matrix from aligned component series/frame.

    ``feature`` is the row identifier; ``samples`` is a numeric-coercible frame
    whose columns are the sample names.
    """
    level = str(assay_level or "unknown").strip().lower()
    feature = feature.astype(str).reset_index(drop=True)
    gene_series = (gene if gene is not None else feature).astype(str).reset_index(drop=True)
    numeric = samples.reset_index(drop=True).apply(pd.to_numeric, errors="coerce")

    if level == "peptide":
        accession_series = (accession if accession is not None else feature).astype(str).reset_index(drop=True)
        out = pd.DataFrame({"Peptide": feature, "Gene": gene_series, "Accession": accession_series})
    else:
        accession_series = (accession if accession is not None else feature).astype(str).reset_index(drop=True)
        out = pd.DataFrame({"Accession": accession_series, "Gene": gene_series})

    for column in numeric.columns:
        out[str(column)] = numeric[column].to_numpy()

    # Drop all-empty rows and duplicate feature ids (keep first occurrence).
    id_col = out.columns[0]
    out = out[out[id_col].astype(str).str.len() > 0]
    out = out.drop_duplicates(subset=[id_col], keep="first").reset_index(drop=True)
    return out


def pivot_long_to_wide(
    df: pd.DataFrame,
    *,
    sample_col: str,
    feature_col: str,
    value_col: str,
    gene_col: Optional[str],
    accession_col: Optional[str],
    assay_level: str,
) -> pd.DataFrame:
    work = df.copy()
    work[sample_col] = work[sample_col].astype(str)
    work[feature_col] = work[feature_col].astype(str)
    work[value_col] = pd.to_numeric(work[value_col], errors="coerce")
    work = work.dropna(subset=[sample_col, feature_col, value_col])

    # Feature-level gene/accession: take the first non-null per feature.
    # Exclude any meta column that IS the feature column (e.g. DIA-NN where the
    # protein group doubles as accession) to avoid duplicate-column selection.
    meta_cols = [c for c in dict.fromkeys([gene_col, accession_col]) if c and c != feature_col]
    feature_meta = (
        work[[feature_col, *meta_cols]].drop_duplicates(feature_col).set_index(feature_col)
        if meta_cols
        else None
    )

    pivot = work.pivot_table(index=feature_col, columns=sample_col, values=value_col, aggfunc="mean")
    pivot = pivot.reset_index()
    feature = pivot[feature_col]
    sample_frame = pivot.drop(columns=[feature_col])

    gene = None
    accession = None
    if feature_meta is not None:
        if gene_col:
            gene = feature.map(feature_meta[gene_col]) if gene_col in feature_meta.columns else None
        if accession_col:
            accession = feature.map(feature_meta[accession_col]) if accession_col in feature_meta.columns else None

    return assemble_wide(
        feature=feature,
        gene=gene,
        accession=accession,
        samples=sample_frame,
        assay_level=assay_level,
    )


def apply_column_map(df: pd.DataFrame, column_map: dict) -> tuple[Optional[str], Optional[str], Optional[str], Optional[str]]:
    """Resolve a user-supplied role->column map to concrete column names.

    Roles: ``sample`` (long only), ``feature``, ``value`` (long only),
    ``gene``, ``accession``. Returns (feature, gene, accession, value/sample-ish)
    is intentionally not used directly; callers read individual roles.
    """
    columns = [str(c) for c in df.columns]

    def resolve(role: str) -> Optional[str]:
        wanted = column_map.get(role)
        if not wanted:
            return None
        return first_present(columns, [wanted])

    return resolve("feature"), resolve("gene"), resolve("accession"), resolve("value")
