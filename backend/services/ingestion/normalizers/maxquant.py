"""MaxQuant normalizer: wide proteinGroups.txt matrix or long evidence.txt."""

from __future__ import annotations

import pandas as pd

from ..base import (
    ColumnMappingRequired,
    assemble_wide,
    columns_with_prefix,
    first_present,
    pivot_long_to_wide,
)

# Wide intensity column prefixes, most specific (already-normalized) first.
_WIDE_PREFIXES = ["LFQ intensity ", "iBAQ ", "Intensity "]
_PROT_ID = ["Majority protein IDs", "Protein IDs", "Proteins"]
_GENE = ["Gene names", "Gene names (primary)", "Gene Name", "Genes"]
_PEP_ID = ["Sequence", "Modified sequence"]


def _strip_prefix(name: str, prefix: str) -> str:
    return name[len(prefix):].strip() if name.lower().startswith(prefix.lower()) else name.strip()


def normalize(df: pd.DataFrame, *, assay_level: str, params: dict) -> pd.DataFrame:
    columns = [str(c) for c in df.columns]
    column_map = params.get("column_map") or {}
    level = str(assay_level or "protein").strip().lower()

    # --- Wide proteinGroups/peptides matrix ---
    for prefix in _WIDE_PREFIXES:
        sample_cols = columns_with_prefix(columns, [prefix])
        if sample_cols:
            if level == "peptide":
                id_col = column_map.get("feature") or first_present(columns, _PEP_ID) or first_present(columns, _PROT_ID)
            else:
                id_col = column_map.get("feature") or first_present(columns, _PROT_ID) or first_present(columns, _PEP_ID)
            if not id_col:
                raise ColumnMappingRequired("MaxQuant", missing_roles=["feature"], available_columns=columns)
            gene_col = column_map.get("gene") or first_present(columns, _GENE)
            accession_col = column_map.get("accession") or first_present(columns, _PROT_ID)
            wide = assemble_wide(
                feature=df[id_col],
                gene=df[gene_col] if gene_col else None,
                accession=df[accession_col] if accession_col else None,
                samples=df[sample_cols],
                assay_level=level,
            )
            rename = {col: _strip_prefix(col, prefix) for col in sample_cols}
            return wide.rename(columns=rename)

    # --- Long evidence.txt ---
    sample_col = column_map.get("sample") or first_present(columns, ["Raw file", "Experiment"])
    value_col = column_map.get("value") or first_present(columns, ["Intensity"])
    feature_col = column_map.get("feature") or (
        first_present(columns, _PEP_ID) if level == "peptide" else first_present(columns, _PROT_ID) or first_present(columns, _PEP_ID)
    )
    if sample_col and value_col and feature_col:
        gene_col = column_map.get("gene") or first_present(columns, _GENE)
        accession_col = column_map.get("accession") or first_present(columns, ["Proteins", "Leading proteins", "Protein group IDs"])
        return pivot_long_to_wide(
            df,
            sample_col=sample_col,
            feature_col=feature_col,
            value_col=value_col,
            gene_col=gene_col,
            accession_col=accession_col,
            assay_level=level,
        )

    missing = [role for role, col in (("sample", sample_col), ("value", value_col), ("feature", feature_col)) if not col]
    raise ColumnMappingRequired("MaxQuant", missing_roles=missing or ["intensity_columns"], available_columns=columns)
