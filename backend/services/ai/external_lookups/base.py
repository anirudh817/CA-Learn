"""Adapter base + result shapes for external biology lookups (P7).

Each adapter wraps one public database. It is responsible for:
  - declaring a tool schema the model can call,
  - normalizing the model's args into a canonical dict (so the cache key is
    stable regardless of casing / whitespace),
  - performing the HTTP request and parsing it into a ``LookupResult``.

A ``LookupResult`` carries two distinct things:
  - ``content`` — markdown the model reasons over,
  - ``references`` — the *resolved records* (accession IDs, pathway IDs,
    papers) with verifiable deep links. These become the UI breadcrumbs so a
    user can independently open every external source an answer rests on.

Adapters never raise for an empty result or an HTTP error — they return a
``LookupResult`` with ``status`` set, and the dispatcher / model fall back.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# status values a lookup can carry
OK = "ok"
NOT_FOUND = "not_found"
UNAVAILABLE = "unavailable"
TIMEOUT = "timeout"
QUOTA_EXCEEDED = "quota_exceeded"


@dataclass
class Reference:
    """One verifiable external source — exactly what a breadcrumb shows.

    A reference is a *resolved record*, never just the query the model sent:
    a UniProt accession, a Reactome stable ID, a PubMed PMID — each with a
    deep link the user can open.
    """

    label: str          # human label, e.g. "APOE — Apolipoprotein E"
    source: str         # adapter id: "uniprot" | "reactome" | ...
    ref_id: str         # accession / stable id / PMID
    url: str            # deep link

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "source": self.source,
            "ref_id": self.ref_id,
            "url": self.url,
        }


@dataclass
class LookupResult:
    status: str = OK
    content: str = ""
    references: list[Reference] = field(default_factory=list)
    reason: str = ""        # human-readable reason when status != ok

    @property
    def is_error(self) -> bool:
        # not_found is a valid answer ("no record"), not an error.
        return self.status not in (OK, NOT_FOUND)

    def references_as_dicts(self) -> list[dict]:
        return [r.to_dict() for r in self.references]


class Adapter:
    """Base adapter. Subclasses set ``id`` / ``tool_name`` and implement
    ``tool_schema`` / ``normalize_args`` / ``fetch``."""

    id: str = ""
    tool_name: str = ""

    def tool_schema(self) -> dict:  # pragma: no cover - overridden
        raise NotImplementedError

    def normalize_args(self, args: dict) -> dict:  # pragma: no cover - overridden
        raise NotImplementedError

    async def fetch(self, args: dict, client: Any) -> LookupResult:  # pragma: no cover - overridden
        raise NotImplementedError
