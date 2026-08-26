"""Robust tabular file reading for the chat retrieval/tool layer.

Pipeline runs contain heterogeneous text tables — clean CSV/TSV, but also
tool-exported files whose delimiter doesn't match their extension (e.g. a
``.txt`` GO-FET export that's actually tab-delimited). The naive
``pd.read_csv(path, sep="," if not .tsv else "\\t")`` blows up on those with
``Expected 1 fields in line N, saw 2`` and the chat then answers from zero rows.

``read_table`` DETECTS the delimiter from the file's own content (choosing the
candidate that appears consistently across lines), then reads with it, skipping
the occasional irregular row instead of failing the whole read. It deliberately
does NOT fall back to a whitespace ``\\s+`` split — that would shred prose and
space-containing single-column files into garbage tables. A file with no
consistent delimiter is read as a single column (which callers can then treat
as prose). Returns ``None`` only when every strategy fails.
"""
from __future__ import annotations

import logging
from collections import Counter
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

# Real, intentional column delimiters only — never whitespace, so prose and
# single-column files with spaces are not mistaken for tables.
_CANDIDATE_DELIMS = ("\t", ",", ";", "|")


def _detect_delimiter(sample_lines: list[str]) -> Optional[str]:
    """Pick the delimiter that appears consistently across the sampled lines.

    A candidate qualifies only if it occurs (>0) on a strong majority of
    non-empty lines AND has a stable per-line count. Returns None when no
    candidate looks like a real column separator (i.e. single-column / prose).
    """
    lines = [ln for ln in sample_lines if ln.strip()]
    if len(lines) < 2:
        return None
    best, best_score = None, 0
    for delim in _CANDIDATE_DELIMS:
        counts = [ln.count(delim) for ln in lines]
        nonzero = [c for c in counts if c > 0]
        # must appear on most lines to be a real separator
        if len(nonzero) < max(2, int(len(lines) * 0.6)):
            continue
        modal_count, modal_freq = Counter(nonzero).most_common(1)[0]
        consistent = sum(1 for c in counts if c == modal_count)
        # reward both column count and consistency
        score = modal_count * consistent
        if score > best_score:
            best, best_score = delim, score
    return best


def read_table(path, *, nrows: Optional[int] = None):
    """Best-effort read of a delimited text table into a DataFrame.

    Returns a pandas DataFrame, or None if the file cannot be parsed. Never
    raises for a malformed file.
    """
    import pandas as pd

    p = Path(path)
    suffix = p.suffix.lower()
    try:
        sample = p.read_text(errors="replace").splitlines()[:80]
    except Exception as exc:  # noqa: BLE001
        log.warning("read_table: could not read %s: %s", p, exc)
        return None

    detected = _detect_delimiter(sample)
    ext_sep = "\t" if suffix in (".tsv", ".tab") else ","
    # Try the content-detected delimiter first, then the extension default.
    seps = list(dict.fromkeys([s for s in (detected, ext_sep) if s]))

    last_exc = None
    for sep in seps:
        # C engine (fast) first; fall back to the python engine which tolerates
        # more, both skipping irregular rows rather than aborting.
        for kw in ({"engine": "c", "low_memory": False}, {"engine": "python"}):
            try:
                return pd.read_csv(p, sep=sep, nrows=nrows, on_bad_lines="skip", **kw)
            except Exception as exc:  # noqa: BLE001 — try the next strategy
                last_exc = exc
                continue

    log.warning("read_table: all parse strategies failed for %s: %s", p, last_exc)
    return None
