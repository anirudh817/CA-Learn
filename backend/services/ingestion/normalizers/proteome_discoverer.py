"""Proteome Discoverer normalizer: wide Abundance columns export."""

from __future__ import annotations

import pandas as pd

from ..base import ColumnMappingRequired, assemble_wide, columns_with_prefix, first_present

# Abundance columns; exclude ratio/count derivatives.
_ABUNDANCE_PREFIXES = ["Abundances (Normalized):", "Abundances (Grouped):", "Abundances:", "Abundance:"]
_EXCLUDE_PREFIXES = ["Abundance Ratio", "Abundances Count", "Abundances (Count)"]
_PROT_ID = ["Accession", "Master Protein Accessions", "Protein Accessions", "Accessions"]
_GENE = ["Gene Symbol", "Gene Symbols", "Gene", "Gene Name"]
_PEP_ID = ["Annotated Sequence", "Sequence", "Peptide"]


def _abundance_columns(columns: list[str]) -> list[str]:
    excluded = set(columns_with_prefix(columns, _EXCLUDE_PREFIXES))
    for prefix in _ABUNDANCE_PREFIXES:
        found = [c for c in columns_with_prefix(columns, [prefix]) if c not in excluded]
        if found:
            return found
    return []


def normalize(df: pd.DataFrame, *, assay_level: str, params: dict) -> pd.DataFrame:
    columns = [str(c) for c in df.columns]
    column_map = params.get("column_map") or {}
    level = str(assay_level or "protein").strip().lower()

    sample_cols = column_map.get("sample_columns") or _abundance_columns(columns)
    if not sample_cols:
        raise ColumnMappingRequired("Proteome Discoverer", missing_roles=["abundance_columns"], available_columns=columns)

    if level == "peptide":
        id_col = column_map.get("feature") or first_present(columns, _PEP_ID) or first_present(columns, _PROT_ID)
        accession_col = column_map.get("accession") or first_present(columns, ["Master Protein Accessions", *_PROT_ID])
    else:
        id_col = column_map.get("feature") or first_present(columns, _PROT_ID)
        accession_col = column_map.get("accession") or first_present(columns, _PROT_ID)
    if not id_col:
        raise ColumnMappingRequired("Proteome Discoverer", missing_roles=["feature"], available_columns=columns)

    gene_col = column_map.get("gene") or first_present(columns, _GENE)

    def _clean_sample(name: str) -> str:
        text = str(name)
        for prefix in _ABUNDANCE_PREFIXES:
            if text.lower().startswith(prefix.lower()):
                return text[len(prefix):].strip()
        return text.strip()

    wide = assemble_wide(
        feature=df[id_col],
        gene=df[gene_col] if gene_col else None,
        accession=df[accession_col] if accession_col else None,
        samples=df[sample_cols],
        assay_level=level,
    )
    return wide.rename(columns={col: _clean_sample(col) for col in sample_cols})
