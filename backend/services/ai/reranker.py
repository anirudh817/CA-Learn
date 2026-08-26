"""Relevance reranking for retrieved chunks — P4 Wave 3.

The base retrievers (``retrievers.py``) fire in a fixed intent→retriever
dispatch order and the budget cut in ``retrieve()`` historically dropped
whatever came *last in dispatch order* once the character budget filled.
That meant a highly relevant chunk could be discarded purely for being later
in the list, while a low-signal orientation fallback survived.

This module scores each chunk against the query intent so the budget cut
keeps the *most relevant* chunks. The scorer is deterministic and
dependency-free (no embedding model, no extra LLM call) — appropriate for an
Anthropic-only, low-latency, easily-tested build. Scoring signals:

  - entity overlap   — queried proteins / modules / cell types / GO terms
                       that actually appear in the chunk's title or body.
  - family alignment — does the chunk's family match what the intent wants?
  - signal density   — chunks that returned real rows beat empty ones.
  - fallback penalty — "no exact match / showing first N for orientation"
                       chunks are low-value and sink to the bottom.

The sort is *stable*, so the original dispatch order breaks ties — preserving
the retrievers' own "most-likely-relevant first" ordering.
"""
from __future__ import annotations

import re
from typing import TYPE_CHECKING

from .query_rewriter import QueryIntent

if TYPE_CHECKING:  # avoid a runtime import cycle (retrievers imports this)
    from .retrievers import RetrievedChunk


# Intent → family-prefixes the intent most wants. A chunk whose family starts
# with one of these gets an alignment bonus.
_INTENT_FAMILY_AFFINITY: dict[str, tuple[str, ...]] = {
    "protein_lookup":       ("volcano", "network"),
    "significance_ranking": ("volcano",),
    "module_query":         ("network",),
    "module_list":          ("network",),
    "go_enrichment":        ("go", "network"),
    "cell_type":            ("cells", "network"),
    "trait_correlation":    ("network.module_trait", "network"),
    "cross_modal":          ("cells", "go", "network"),
    "summary":              ("report", "volcano"),
    "comparison":           ("report", "volcano"),
    "metadata":             ("report",),
    "open_ended":           ("report", "volcano"),
}

# Markers a retriever leaves on a low-confidence orientation fallback.
_FALLBACK_MARKERS = (
    "no exact match",
    "no rows matched",
    "for orientation",
    "no matching rows",
)

# Scoring weights (tuned for clear separation, not calibrated probabilities).
_W_ENTITY = 5.0          # per distinct queried entity present in the chunk
_W_FAMILY = 3.0          # chunk family matches the intent's affinity
_W_TARGET_FAMILY = 2.0   # chunk family is in intent.target_families (LLM-refined)
_W_ROWS = 1.0            # scaled 0..1 by rows_returned
_W_FALLBACK = -4.0       # orientation fallback penalty


def _flatten_entities(intent: QueryIntent) -> list[str]:
    out: list[str] = []
    for values in (intent.entities or {}).values():
        for v in values or []:
            v = str(v).strip()
            if v:
                out.append(v)
    return out


def score_chunk(chunk: "RetrievedChunk", intent: QueryIntent) -> float:
    """Relevance score for one chunk against the query intent. Higher = better."""
    score = 0.0
    haystack = f"{chunk.title}\n{chunk.body}".lower()

    # 1. Entity overlap — distinct queried entities that appear in the chunk.
    entities = _flatten_entities(intent)
    if entities:
        hits = 0
        for ent in {e.lower() for e in entities}:
            # word-ish boundary match so "AP" doesn't match "APOE" spuriously
            if re.search(rf"(?<![a-z0-9]){re.escape(ent)}(?![a-z0-9])", haystack):
                hits += 1
        score += _W_ENTITY * hits

    # 2. Family alignment with the intent.
    affinity = _INTENT_FAMILY_AFFINITY.get(intent.intent_type, ())
    fam = (chunk.family or "").lower()
    if any(fam.startswith(prefix) for prefix in affinity):
        score += _W_FAMILY
    if intent.target_families and any(
        fam.startswith(str(t).lower()) for t in intent.target_families
    ):
        score += _W_TARGET_FAMILY

    # 3. Signal density — reward chunks that returned real rows.
    if chunk.rows_returned:
        score += _W_ROWS * min(chunk.rows_returned, 50) / 50.0

    # 4. Orientation-fallback penalty.
    note_blob = f"{chunk.title} {chunk.notes}".lower()
    if any(marker in note_blob for marker in _FALLBACK_MARKERS):
        score += _W_FALLBACK

    return score


def rerank(chunks: list["RetrievedChunk"], intent: QueryIntent) -> list["RetrievedChunk"]:
    """Return chunks ordered most- to least-relevant for the intent.

    Stable: chunks with equal score keep their original (dispatch) order.
    """
    if len(chunks) <= 1:
        return list(chunks)
    scored = list(enumerate(chunks))
    scored.sort(key=lambda pair: (-score_chunk(pair[1], intent), pair[0]))
    return [c for _, c in scored]
