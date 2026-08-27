"""Spectronaut long-report normalizer (peptide PEP.Quantity / protein PG.Quantity)."""

from __future__ import annotations

import pandas as pd

from ..base import ColumnMappingRequired, first_present, pivot_long_to_wide

_SAMPLE = ["R.FileName", "R.Label", "R.Raw File Name", "Run", "R.Condition"]
_PEP_VALUE = ["PEP.Quantity", "PEP.MS2Quantity", "PEP.MS1Quantity", "FG.Quantity"]
_PROT_VALUE = ["PG.Quantity", "PG.MaxLFQ"]
_PEP_FEATURE = ["PEP.GroupingKey", "EG.ModifiedPeptide", "PEP.StrippedSequence", "EG.PrecursorId"]
_PROT_FEATURE = ["PG.ProteinGroups", "PG.ProteinAccessions", "ProteinAccessions"]
_GENE = ["PG.Genes", "Genes", "Gene Name"]
_ACCESSION = ["PG.ProteinGroups", "PG.ProteinAccessions", "ProteinAccessions"]


def normalize(df: pd.DataFrame, *, assay_level: str, params: dict) -> pd.DataFrame:
    columns = [str(c) for c in df.columns]
    column_map = params.get("column_map") or {}
    level = str(assay_level or "protein").strip().lower()

    sample_col = column_map.get("sample") or first_present(columns, _SAMPLE)
    if level == "peptide":
        value_col = column_map.get("value") or first_present(columns, _PEP_VALUE)
        feature_col = column_map.get("feature") or first_present(columns, _PEP_FEATURE) or first_present(columns, _PROT_FEATURE)
    else:
        value_col = column_map.get("value") or first_present(columns, _PROT_VALUE)
        feature_col = column_map.get("feature") or first_present(columns, _PROT_FEATURE) or first_present(columns, _GENE)

    missing = [role for role, col in (("sample", sample_col), ("value", value_col), ("feature", feature_col)) if not col]
    if missing:
        raise ColumnMappingRequired("Spectronaut", missing_roles=missing, available_columns=columns)

    gene_col = column_map.get("gene") or first_present(columns, _GENE)
    accession_col = column_map.get("accession") or first_present(columns, _ACCESSION)
    return pivot_long_to_wide(
        df,
        sample_col=sample_col,
        feature_col=feature_col,
        value_col=value_col,
        gene_col=gene_col,
        accession_col=accession_col,
        assay_level=level,
    )
