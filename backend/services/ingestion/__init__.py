"""Pre-ETL vendor ingestion layer.

This package maps raw proteomics exports from many tools (Spectronaut, DIA-NN,
MaxQuant, FragPipe, Proteome Discoverer, Skyline) into the canonical *wide*
matrix that the parity-validated pipeline ETL (`_canonicalize_input`) already
understands. Keeping this logic outside ``pipeline.py`` means the pipeline gains
multi-format support through a single, additive dispatch seam without entangling
the byte-for-byte PEAKS/Olink paths.

Public API:

- ``SUPPORTED_FORMATS`` — the catalog surfaced to the manual picker UI.
- ``supported_format_families()`` / ``is_supported_family()`` — membership.
- ``normalizer_for(format_family)`` — the registered normalizer, or ``None``.
- ``normalize_to_file(...)`` — run a normalizer and emit a canonical wide CSV.
- ``ColumnMappingRequired`` — raised when a chosen format's required columns are
  absent and no manual column map was supplied.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Optional

import pandas as pd

from .base import ColumnMappingRequired, read_frame
from .normalizers import normalizer_for

# ---------------------------------------------------------------------------
# Picker catalog — single source of truth for the UI dropdown + run gating.
# ``routing`` explains how each family reaches a canonical bundle:
#   - "normalizer": dedicated vendor normalizer in this package
#   - "r_etl":      PEAKS R loader in pipeline.py
#   - "native":     existing dedicated path inside _canonicalize_input (Olink)
#   - "generic":    generic wide/long heuristic fallback
# Every listed family is ``run_ready`` because it has a real routing path.
# ---------------------------------------------------------------------------
SUPPORTED_FORMATS: list[dict] = [
    {"family": "PEAKS", "label": "PEAKS", "assay_levels": ["protein", "peptide"], "routing": "r_etl"},
    {"family": "Spectronaut", "label": "Spectronaut", "assay_levels": ["protein", "peptide"], "routing": "normalizer"},
    {"family": "DIA-NN", "label": "DIA-NN", "assay_levels": ["protein", "peptide"], "routing": "normalizer"},
    {"family": "MaxQuant", "label": "MaxQuant", "assay_levels": ["protein", "peptide"], "routing": "normalizer"},
    {"family": "FragPipe", "label": "FragPipe", "assay_levels": ["protein", "peptide"], "routing": "normalizer"},
    {"family": "Proteome Discoverer", "label": "Proteome Discoverer", "assay_levels": ["protein", "peptide"], "routing": "normalizer"},
    {"family": "Skyline", "label": "Skyline", "assay_levels": ["protein", "peptide"], "routing": "normalizer"},
    {"family": "Olink", "label": "Olink (NPX)", "assay_levels": ["protein"], "routing": "native"},
    {"family": "Generic", "label": "Generic matrix", "assay_levels": ["protein", "peptide", "unknown"], "routing": "generic"},
]

_SUPPORTED_LOOKUP = {fmt["family"].strip().lower(): fmt for fmt in SUPPORTED_FORMATS}
# Common aliases the picker / API may send.
_ALIASES = {
    "diann": "dia-nn",
    "proteomediscoverer": "proteome discoverer",
    "pd": "proteome discoverer",
}


def _canonical_key(format_family: str | None) -> str:
    key = str(format_family or "").strip().lower()
    return _ALIASES.get(key.replace("-", "").replace(" ", ""), key)


def supported_format_families() -> list[str]:
    return [fmt["family"] for fmt in SUPPORTED_FORMATS]


def is_supported_family(format_family: str | None) -> bool:
    return _canonical_key(format_family) in _SUPPORTED_LOOKUP


def catalog_entry(format_family: str | None) -> Optional[dict]:
    return _SUPPORTED_LOOKUP.get(_canonical_key(format_family))


def normalize_to_file(
    input_file: str | Path,
    *,
    format_family: str,
    assay_level: str,
    params: Optional[dict] = None,
    out_dir: str | Path,
    log_fn: Optional[Callable[[str], None]] = None,
) -> Optional[Path]:
    """Run the registered normalizer for ``format_family`` and write a canonical
    wide CSV to ``out_dir``. Returns the written path, or ``None`` when there is
    no dedicated normalizer for the family (caller should use the generic path).

    Raises ``ColumnMappingRequired`` when required columns are missing and no
    ``column_map`` override is present in ``params``.
    """
    normalizer = normalizer_for(format_family)
    if normalizer is None:
        return None
    frame = read_frame(Path(input_file))
    wide = normalizer(frame, assay_level=assay_level, params=params or {})
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "vendor_normalized_matrix.csv"
    wide.to_csv(out_path, index=False)
    if log_fn:
        log_fn(
            f"vendor normalizer[{format_family}] produced {wide.shape[0]} features "
            f"x {max(wide.shape[1] - _leading_id_columns(wide), 0)} samples"
        )
    return out_path


def _leading_id_columns(wide: pd.DataFrame) -> int:
    id_like = {"Peptide", "Gene", "Accession"}
    return sum(1 for col in wide.columns if str(col) in id_like)


__all__ = [
    "SUPPORTED_FORMATS",
    "ColumnMappingRequired",
    "supported_format_families",
    "is_supported_family",
    "catalog_entry",
    "normalizer_for",
    "normalize_to_file",
]
