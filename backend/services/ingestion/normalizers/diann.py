"""DIA-NN normalizer: long report (Run + PG.MaxLFQ/Precursor.*) or wide matrix."""

from __future__ import annotations

import pandas as pd

from ..base import (
    ColumnMappingRequired,
    assemble_wide,
    first_present,
    numeric_like_columns,
    pivot_long_to_wide,
)

_SAMPLE = ["Run", "File.Name", "File Name"]
_PROT_VALUE = ["PG.MaxLFQ", "Genes.MaxLFQ", "PG.Quantity"]
_PEP_VALUE = ["Precursor.Normalised", "Precursor.Normalized", "Precursor.Quantity"]
_PROT_FEATURE = ["Protein.Group", "Protein.Ids", "Protein.Names", "Genes"]
_PEP_FEATURE = ["Precursor.Id", "Modified.Sequence", "Stripped.Sequence"]
_GENE = ["Genes", "Gene"]
_ACCESSION = ["Protein.Group", "Protein.Ids"]


def normalize(df: pd.DataFrame, *, assay_level: str, params: dict) -> pd.DataFrame:
    columns = [str(c) for c in df.columns]
    column_map = params.get("column_map") or {}
    level = str(assay_level or "protein").strip().lower()

    sample_col = column_map.get("sample") or first_present(columns, _SAMPLE)
    value_candidates = _PEP_VALUE if level == "peptide" else _PROT_VALUE
    value_col = column_map.get("value") or first_present(columns, value_candidates)
    feature_candidates = _PEP_FEATURE if level == "peptide" else _PROT_FEATURE
    feature_col = column_map.get("feature") or first_present(columns, feature_candidates)

    # Long report path.
    if sample_col and value_col and feature_col:
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

    # Wide matrix path (report.pg_matrix / pr_matrix): id column + numeric samples.
    id_col = feature_col or first_present(columns, ["Protein.Group", "Protein.Ids", "Precursor.Id", "Genes"])
    if id_col:
        id_like = {c for c in [id_col, first_present(columns, _GENE), first_present(columns, _ACCESSION),
                               "Protein.Group", "Protein.Ids", "Protein.Names", "First.Protein.Description"] if c}
        sample_cols = [c for c in columns if c not in id_like]
        sample_cols = numeric_like_columns(df, sample_cols)
        if sample_cols:
            gene_col = column_map.get("gene") or first_present(columns, _GENE)
            accession_col = column_map.get("accession") or first_present(columns, _ACCESSION)
            return assemble_wide(
                feature=df[id_col],
                gene=df[gene_col] if gene_col else None,
                accession=df[accession_col] if accession_col else None,
                samples=df[sample_cols],
                assay_level=level,
            )

    missing = [role for role, col in (("sample", sample_col), ("value", value_col), ("feature", feature_col)) if not col]
    raise ColumnMappingRequired("DIA-NN", missing_roles=missing or ["sample_columns"], available_columns=columns)
