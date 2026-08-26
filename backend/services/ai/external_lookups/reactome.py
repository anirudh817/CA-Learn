"""Reactome adapter — biological pathways a protein/gene participates in.

Reactome ContentService search:
    https://reactome.org/ContentService/search/query

Returns pathway entries with stable IDs (``R-HSA-…``); each becomes a
verifiable reference linking to the Reactome pathway browser.
"""
from __future__ import annotations

from typing import Any

from .base import NOT_FOUND, OK, UNAVAILABLE, Adapter, LookupResult, Reference

_SEARCH_URL = "https://reactome.org/ContentService/search/query"


class ReactomeAdapter(Adapter):
    id = "reactome"
    tool_name = "lookup_reactome"

    def tool_schema(self) -> dict:
        return {
            "name": self.tool_name,
            "description": (
                "Look up the biological pathways a protein or gene takes part "
                "in, using Reactome — the curated public pathway database. "
                "Use this to answer 'what pathways is X in?' when the run's GO "
                "enrichment does not cover it. Public-database knowledge — "
                "always external to the user's run."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Gene/protein symbol or pathway name, e.g. 'APOE', 'cholesterol'.",
                    },
                },
                "required": ["query"],
            },
        }

    def normalize_args(self, args: dict) -> dict:
        return {"query": str((args or {}).get("query") or "").strip()}

    async def fetch(self, args: dict, client: Any) -> LookupResult:
        query = args.get("query") or ""
        if not query:
            return LookupResult(status=NOT_FOUND, reason="No query symbol supplied.")

        try:
            resp = await client.get(
                _SEARCH_URL,
                params={
                    "query": query,
                    "species": "Homo sapiens",
                    "types": "Pathway",
                    "cluster": "true",
                },
            )
        except Exception as exc:
            return LookupResult(status=UNAVAILABLE, reason=f"Reactome request failed: {exc}")

        # Reactome returns 404 with a JSON body when nothing matches.
        if resp.status_code == 404:
            return LookupResult(
                status=NOT_FOUND,
                reason=f"No Reactome pathway for '{query}'.",
                content=f"Reactome has no human pathway matching **{query}**.",
            )
        if resp.status_code != 200:
            return LookupResult(
                status=UNAVAILABLE,
                reason=f"Reactome returned HTTP {resp.status_code}.",
            )
        try:
            data = resp.json()
        except Exception as exc:
            return LookupResult(status=UNAVAILABLE, reason=f"Reactome response not JSON: {exc}")

        pathways: list[dict] = []
        for group in data.get("results") or []:
            if (group.get("typeName") or "").lower() != "pathway":
                continue
            for entry in group.get("entries") or []:
                pathways.append(entry)

        if not pathways:
            return LookupResult(
                status=NOT_FOUND,
                reason=f"No Reactome pathway for '{query}'.",
                content=f"Reactome has no human pathway matching **{query}**.",
            )

        blocks: list[str] = [f"### Reactome pathways — `{query}`"]
        refs: list[Reference] = []
        for entry in pathways[:6]:
            st_id = str(entry.get("stId") or entry.get("id") or "").strip()
            name = str(entry.get("name") or "").strip()
            if not (st_id and name):
                continue
            url = f"https://reactome.org/content/detail/{st_id}"
            blocks.append(f"- **{name}** · `{st_id}`")
            refs.append(
                Reference(label=f"{name} (Reactome)", source=self.id, ref_id=st_id, url=url)
            )

        if not refs:
            return LookupResult(
                status=NOT_FOUND,
                reason=f"No Reactome pathway for '{query}'.",
                content=f"Reactome has no human pathway matching **{query}**.",
            )
        return LookupResult(status=OK, content="\n".join(blocks), references=refs)
