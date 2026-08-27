"""Skyline normalizer: long export (Replicate + Area/Total Area) or wide report."""

from __future__ import annotations

import pandas as pd

from ..base import (
    ColumnMappingRequired,
    assemble_wide,
    first_present,
    numeric_like_columns,
    pivot_long_to_wide,
)

_SAMPLE = ["Replicate Name", "Replicate", "File Name", "Sample Name"]
_VALUE = ["Total Area", "Total Area Fragment", "Total Area MS1", "Normalized Area", "Area", "Total Area Ratio"]
_PROT = ["Protein Name", "Protein", "Protein Accession", "Protein Gene"]
_PEP = ["Peptide Modified Sequence", "Peptide Sequence", "Peptide", "Modified Sequence"]
_GENE = ["Protein Gene", "Gene", "Gene Name"]


def normalize(df: pd.DataFrame, *, assay_level: str, params: dict) -> pd.DataFrame:
    columns = [str(c) for c in df.columns]
    column_map = params.get("column_map") or {}
    level = str(assay_level or "protein").strip().lower()

    sample_col = column_map.get("sample") or first_present(columns, _SAMPLE)
    value_col = column_map.get("value") or first_present(columns, _VALUE)
    if level == "peptide":
        feature_col = column_map.get("feature") or first_present(columns, _PEP) or first_present(columns, _PROT)
    else:
        feature_col = column_map.get("feature") or first_present(columns, _PROT) or first_present(columns, _PEP)

    # Long path.
    if sample_col and value_col and feature_col:
        gene_col = column_map.get("gene") or first_present(columns, _GENE)
        accession_col = column_map.get("accession") or first_present(columns, ["Protein Accession", "Protein Name"])
        return pivot_long_to_wide(
            df,
            sample_col=sample_col,
            feature_col=feature_col,
            value_col=value_col,
            gene_col=gene_col,
            accession_col=accession_col,
            assay_level=level,
        )

    # Wide pivot report: id column + numeric replicate columns.
    if feature_col:
        id_like = {c for c in [feature_col, first_present(columns, _GENE), *_PROT, *_PEP] if c}
        sample_cols = numeric_like_columns(df, [c for c in columns if c not in id_like])
        if sample_cols:
            gene_col = column_map.get("gene") or first_present(columns, _GENE)
            return assemble_wide(
                feature=df[feature_col],
                gene=df[gene_col] if gene_col else None,
                accession=None,
                samples=df[sample_cols],
                assay_level=level,
            )

    missing = [role for role, col in (("sample", sample_col), ("value", value_col), ("feature", feature_col)) if not col]
    raise ColumnMappingRequired("Skyline", missing_roles=missing or ["sample_columns"], available_columns=columns)
