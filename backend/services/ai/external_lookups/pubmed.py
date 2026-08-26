"""PubMed adapter — recent literature via NCBI E-utilities.

Two calls: esearch (query → PMIDs) then esummary (PMIDs → metadata).

Results are normalized into *paper-citation objects* — title, first author,
year, journal, PMID, link — so the model can cite a paper inline
("Smith et al., 2024, PMID 38xxxxxx") and the UI can render the paper as a
verifiable reference.

An optional ``NCBI_API_KEY`` only raises the request rate; it is never
required for access.
"""
from __future__ import annotations

from typing import Any

from config import NCBI_API_KEY

from .base import NOT_FOUND, OK, UNAVAILABLE, Adapter, LookupResult, Reference

_ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
_ESUMMARY_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"


def _year_of(pubdate: str) -> str:
    """Extract a 4-digit year from a PubMed pubdate string."""
    for token in str(pubdate or "").split():
        if len(token) == 4 and token.isdigit():
            return token
    return str(pubdate or "").strip()[:4]


def _doi_of(entry: dict) -> str:
    for aid in entry.get("articleids") or []:
        if (aid.get("idtype") or "").lower() == "doi":
            return str(aid.get("value") or "").strip()
    return ""


class PubMedAdapter(Adapter):
    id = "pubmed"
    tool_name = "lookup_pubmed"

    def tool_schema(self) -> dict:
        return {
            "name": self.tool_name,
            "description": (
                "Search PubMed — the public biomedical literature database — "
                "for recent papers on a protein, pathway, or disease. Use "
                "this to ground an interpretation in published research. "
                "Returns citable papers (title, authors, year, journal, "
                "PMID). Public-database knowledge — always external to the "
                "user's run."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search terms, e.g. 'APOE Alzheimer microglia'.",
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Max papers to return (default 5).",
                    },
                },
                "required": ["query"],
            },
        }

    def normalize_args(self, args: dict) -> dict:
        query = str((args or {}).get("query") or "").strip()
        try:
            max_results = int((args or {}).get("max_results") or 5)
        except (TypeError, ValueError):
            max_results = 5
        return {"query": query, "max_results": max(1, min(max_results, 10))}

    def _key_params(self) -> dict:
        return {"api_key": NCBI_API_KEY} if NCBI_API_KEY else {}

    async def fetch(self, args: dict, client: Any) -> LookupResult:
        query = args.get("query") or ""
        max_results = args.get("max_results") or 5
        if not query:
            return LookupResult(status=NOT_FOUND, reason="No search query supplied.")

        # 1. esearch — query → PMIDs.
        try:
            search = await client.get(_ESEARCH_URL, params={
                "db": "pubmed",
                "term": query,
                "retmax": str(max_results),
                "retmode": "json",
                "sort": "relevance",
                **self._key_params(),
            })
        except Exception as exc:
            return LookupResult(status=UNAVAILABLE, reason=f"PubMed search failed: {exc}")
        if search.status_code != 200:
            return LookupResult(status=UNAVAILABLE, reason=f"PubMed esearch HTTP {search.status_code}.")
        try:
            pmids = (search.json().get("esearchresult") or {}).get("idlist") or []
        except Exception as exc:
            return LookupResult(status=UNAVAILABLE, reason=f"PubMed esearch not JSON: {exc}")

        if not pmids:
            return LookupResult(
                status=NOT_FOUND,
                reason=f"No PubMed papers for '{query}'.",
                content=f"PubMed returned no papers for **{query}**.",
            )

        # 2. esummary — PMIDs → metadata.
        try:
            summary = await client.get(_ESUMMARY_URL, params={
                "db": "pubmed",
                "id": ",".join(pmids),
                "retmode": "json",
                **self._key_params(),
            })
        except Exception as exc:
            return LookupResult(status=UNAVAILABLE, reason=f"PubMed summary failed: {exc}")
        if summary.status_code != 200:
            return LookupResult(status=UNAVAILABLE, reason=f"PubMed esummary HTTP {summary.status_code}.")
        try:
            result = summary.json().get("result") or {}
        except Exception as exc:
            return LookupResult(status=UNAVAILABLE, reason=f"PubMed esummary not JSON: {exc}")

        blocks: list[str] = [f"### PubMed — `{query}`"]
        refs: list[Reference] = []
        for pmid in pmids:
            entry = result.get(pmid)
            if not isinstance(entry, dict):
                continue
            title = str(entry.get("title") or "").strip().rstrip(".")
            journal = str(entry.get("source") or "").strip()
            year = _year_of(entry.get("pubdate"))
            authors = entry.get("authors") or []
            first_author = ""
            if authors:
                first_author = str((authors[0] or {}).get("name") or "").strip()
            cite_author = f"{first_author} et al." if first_author else "Anon"
            doi = _doi_of(entry)

            citation = f"{cite_author}, {year}" if year else cite_author
            line = f"- **{title}** — {cite_author}, {journal} {year}. PMID {pmid}"
            if doi:
                line += f" · doi:{doi}"
            blocks.append(line)
            refs.append(Reference(
                label=f"{title} ({citation}, PMID {pmid})",
                source=self.id,
                ref_id=pmid,
                url=f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
            ))

        if len(blocks) == 1:
            return LookupResult(
                status=NOT_FOUND,
                reason=f"No PubMed papers for '{query}'.",
                content=f"PubMed returned no usable records for **{query}**.",
            )
        blocks.append(
            "\n_When you use a finding from one of these papers, cite it "
            "inline (e.g. \"(Smith et al., 2024, PMID 38xxxxxx)\")._"
        )
        return LookupResult(status=OK, content="\n".join(blocks), references=refs)
