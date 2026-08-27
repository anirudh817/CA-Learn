"""Registry of vendor normalizers, keyed by canonical format family."""

from __future__ import annotations

from typing import Callable, Optional

import pandas as pd

from .diann import normalize as _diann
from .fragpipe import normalize as _fragpipe
from .maxquant import normalize as _maxquant
from .proteome_discoverer import normalize as _proteome_discoverer
from .skyline import normalize as _skyline
from .spectronaut import normalize as _spectronaut

# Callable signature: (df, *, assay_level: str, params: dict) -> pd.DataFrame
Normalizer = Callable[..., pd.DataFrame]

_REGISTRY: dict[str, Normalizer] = {
    "spectronaut": _spectronaut,
    "dia-nn": _diann,
    "diann": _diann,
    "maxquant": _maxquant,
    "fragpipe": _fragpipe,
    "proteome discoverer": _proteome_discoverer,
    "proteomediscoverer": _proteome_discoverer,
    "skyline": _skyline,
}


def normalizer_for(format_family: str | None) -> Optional[Normalizer]:
    key = str(format_family or "").strip().lower()
    if key in _REGISTRY:
        return _REGISTRY[key]
    collapsed = key.replace("-", "").replace(" ", "")
    return _REGISTRY.get(collapsed)


__all__ = ["normalizer_for", "Normalizer"]
