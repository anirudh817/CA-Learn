"""FragPipe normalizer: combined_protein.tsv / combined_peptide.tsv (wide)."""

from __future__ import annotations

import pandas as pd

from ..base import ColumnMappingRequired, assemble_wide, columns_with_suffix, first_present

# Per-sample intensity column suffixes, most-preferred (normalized) first.
_SUFFIXES = [" MaxLFQ Intensity", " Intensity", " Total Intensity", " Razor Intensity", " Unique Intensity"]
_PROT_ID = ["Protein", "Protein ID", "Protein Group", "Protein IDs"]
_GENE = ["Gene", "Gene Names", "Genes", "Gene Symbol"]
_PEP_ID = ["Peptide Sequence", "Peptide", "Modified Sequence"]


def _preferred_suffix(columns: list[str]) -> str | None:
    for suffix in _SUFFIXES:
        if columns_with_suffix(columns, [suffix]):
            return suffix
    return None


def normalize(df: pd.DataFrame, *, assay_level: str, params: dict) -> pd.DataFrame:
    columns = [str(c) for c in df.columns]
    column_map = params.get("column_map") or {}
    level = str(assay_level or "protein").strip().lower()

    suffix = column_map.get("value_suffix") or _preferred_suffix(columns)
    if not suffix:
        raise ColumnMappingRequired("FragPipe", missing_roles=["intensity_columns"], available_columns=columns)
    sample_cols = columns_with_suffix(columns, [suffix])

    if level == "peptide":
        id_col = column_map.get("feature") or first_present(columns, _PEP_ID) or first_present(columns, _PROT_ID)
    else:
        id_col = column_map.get("feature") or first_present(columns, _PROT_ID) or first_present(columns, _PEP_ID)
    if not id_col:
        raise ColumnMappingRequired("FragPipe", missing_roles=["feature"], available_columns=columns)

    gene_col = column_map.get("gene") or first_present(columns, _GENE)
    accession_col = column_map.get("accession") or first_present(columns, _PROT_ID)
    wide = assemble_wide(
        feature=df[id_col],
        gene=df[gene_col] if gene_col else None,
        accession=df[accession_col] if accession_col else None,
        samples=df[sample_cols],
        assay_level=level,
    )
    rename = {col: col[: -len(suffix)].strip() for col in sample_cols}
    return wide.rename(columns=rename)
