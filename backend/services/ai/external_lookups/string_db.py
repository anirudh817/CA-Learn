"""STRING adapter — protein–protein interaction partners.

STRING REST: https://string-db.org/api/json/interaction_partners

Given a protein/gene symbol, returns its highest-confidence interaction
partners. Each partner becomes a verifiable reference into the STRING
network browser.
"""
from __future__ import annotations

from typing import Any

from .base import NOT_FOUND, OK, UNAVAILABLE, Adapter, LookupResult, Reference

_PARTNERS_URL = "https://string-db.org/api/json/interaction_partners"
_HUMAN_TAXON = "9606"


class StringAdapter(Adapter):
    id = "string"
    tool_name = "lookup_string"

    def tool_schema(self) -> dict:
        return {
            "name": self.tool_name,
            "description": (
                "Look up the protein–protein interaction partners of a gene "
                "or protein using STRING — the curated public interaction "
                "database. Use this for 'what does X interact with?' when the "
                "run's network/WGCNA data does not answer it. Public-database "
                "knowledge — always external to the user's run."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Gene/protein symbol, e.g. 'APOE'.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max interaction partners to return (default 10).",
                    },
                },
                "required": ["query"],
            },
        }

    def normalize_args(self, args: dict) -> dict:
        query = str((args or {}).get("query") or "").strip().upper()
        try:
            limit = int((args or {}).get("limit") or 10)
        except (TypeError, ValueError):
            limit = 10
        limit = max(1, min(limit, 25))
        return {"query": query, "limit": limit}

    async def fetch(self, args: dict, client: Any) -> LookupResult:
        query = args.get("query") or ""
        limit = args.get("limit") or 10
        if not query:
            return LookupResult(status=NOT_FOUND, reason="No query symbol supplied.")

        try:
            resp = await client.get(
                _PARTNERS_URL,
                params={
                    "identifiers": query,
                    "species": _HUMAN_TAXON,
                    "limit": str(limit),
                    "caller_identity": "signalfold",
                },
            )
        except Exception as exc:
            return LookupResult(status=UNAVAILABLE, reason=f"STRING request failed: {exc}")

        if resp.status_code != 200:
            return LookupResult(
                status=UNAVAILABLE, reason=f"STRING returned HTTP {resp.status_code}."
            )
        try:
            rows = resp.json()
        except Exception as exc:
            return LookupResult(status=UNAVAILABLE, reason=f"STRING response not JSON: {exc}")

        if not rows:
            return LookupResult(
                status=NOT_FOUND,
                reason=f"No STRING interaction partners for '{query}'.",
                content=f"STRING has no interaction partners on record for **{query}** (human).",
            )

        blocks: list[str] = [f"### STRING interaction partners — `{query}`"]
        refs: list[Reference] = []
        for row in rows[:limit]:
            partner = str(row.get("preferredName_B") or "").strip()
            string_id = str(row.get("stringId_B") or "").strip()
            score = row.get("score")
            if not partner:
                continue
            score_txt = f" (confidence {score})" if score is not None else ""
            blocks.append(f"- **{partner}**{score_txt}")
            if string_id:
                refs.append(Reference(
                    label=f"{query}–{partner} interaction (STRING)",
                    source=self.id,
                    ref_id=string_id,
                    url=f"https://string-db.org/network/{string_id}",
                ))

        if len(blocks) == 1:
            return LookupResult(
                status=NOT_FOUND,
                reason=f"No STRING interaction partners for '{query}'.",
                content=f"STRING has no interaction partners on record for **{query}** (human).",
            )
        return LookupResult(status=OK, content="\n".join(blocks), references=refs)
