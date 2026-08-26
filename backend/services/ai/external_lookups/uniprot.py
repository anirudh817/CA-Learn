"""UniProt adapter — protein function, subcellular location, identifiers.

UniProt REST: https://rest.uniprot.org/uniprotkb/search

Parsing is deliberately defensive — UniProt's JSON is deeply nested and the
exact shape varies by entry. Any missing field is skipped, never fatal.
"""
from __future__ import annotations

from typing import Any

from .base import NOT_FOUND, OK, UNAVAILABLE, Adapter, LookupResult, Reference

_SEARCH_URL = "https://rest.uniprot.org/uniprotkb/search"
_FIELDS = "accession,id,gene_names,protein_name,organism_name,cc_function,cc_subcellular_location"


class UniProtAdapter(Adapter):
    id = "uniprot"
    tool_name = "lookup_uniprot"

    def tool_schema(self) -> dict:
        return {
            "name": self.tool_name,
            "description": (
                "Look up a protein or gene in UniProt — the curated public "
                "protein database. Returns function, subcellular location, "
                "organism, and the UniProt accession. Use this for questions "
                "about what a protein DOES or WHERE it localises that the "
                "pipeline run does not answer. Public-database knowledge — "
                "always external to the user's run."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Gene/protein symbol or name, e.g. 'APOE', 'Apolipoprotein E'.",
                    },
                    "organism": {
                        "type": "string",
                        "description": "Optional organism name. Defaults to human.",
                    },
                },
                "required": ["query"],
            },
        }

    def normalize_args(self, args: dict) -> dict:
        # Gene/protein symbols are upper-cased by scientific convention;
        # canonicalising here makes the cache case-insensitive (APOE == apoe).
        query = str((args or {}).get("query") or "").strip().upper()
        organism = str((args or {}).get("organism") or "human").strip().lower()
        return {"query": query, "organism": organism}

    async def fetch(self, args: dict, client: Any) -> LookupResult:
        query = args.get("query") or ""
        organism = args.get("organism") or "human"
        if not query:
            return LookupResult(status=NOT_FOUND, reason="No query symbol supplied.")

        uq = f'(gene:{query} OR protein_name:{query})'
        if organism in ("human", "homo sapiens", "9606", ""):
            uq += " AND organism_id:9606"
        else:
            uq += f' AND organism_name:"{organism}"'
        uq += " AND reviewed:true"

        try:
            resp = await client.get(
                _SEARCH_URL,
                params={"query": uq, "fields": _FIELDS, "format": "json", "size": "3"},
            )
        except Exception as exc:  # network error → dispatcher records a failure
            return LookupResult(status=UNAVAILABLE, reason=f"UniProt request failed: {exc}")

        if resp.status_code != 200:
            return LookupResult(
                status=UNAVAILABLE,
                reason=f"UniProt returned HTTP {resp.status_code}.",
            )
        try:
            data = resp.json()
        except Exception as exc:
            return LookupResult(status=UNAVAILABLE, reason=f"UniProt response not JSON: {exc}")

        results = data.get("results") or []
        if not results:
            return LookupResult(
                status=NOT_FOUND,
                reason=f"No reviewed UniProt entry for '{query}'.",
                content=f"UniProt has no reviewed entry matching **{query}** ({organism}).",
            )

        blocks: list[str] = [f"### UniProt — `{query}`"]
        refs: list[Reference] = []
        for entry in results[:3]:
            acc = str(entry.get("primaryAccession") or "").strip()
            genes = entry.get("genes") or []
            gene = ""
            if genes:
                gene = (((genes[0] or {}).get("geneName") or {}).get("value")) or ""
            desc = (
                ((entry.get("proteinDescription") or {}).get("recommendedName") or {})
                .get("fullName") or {}
            ).get("value") or ""
            organism_name = (entry.get("organism") or {}).get("scientificName") or ""

            function = ""
            locations: list[str] = []
            for c in entry.get("comments") or []:
                ctype = c.get("commentType")
                if ctype == "FUNCTION":
                    texts = c.get("texts") or []
                    if texts:
                        function = (texts[0] or {}).get("value") or ""
                elif ctype == "SUBCELLULAR LOCATION":
                    for sl in c.get("subcellularLocations") or []:
                        loc = ((sl or {}).get("location") or {}).get("value")
                        if loc:
                            locations.append(loc)

            label = f"{gene or query} — {desc}" if desc else (gene or query)
            url = f"https://www.uniprot.org/uniprotkb/{acc}/entry" if acc else "https://www.uniprot.org"
            if acc:
                refs.append(Reference(label=f"{label} (UniProt {acc})", source=self.id, ref_id=acc, url=url))

            lines = [f"**{gene or query}** — {desc or '(no recommended name)'}  ·  `{acc}`  ·  {organism_name}"]
            if locations:
                lines.append(f"- Subcellular location: {', '.join(dict.fromkeys(locations))}")
            if function:
                fn = function if len(function) <= 600 else function[:600].rstrip() + "…"
                lines.append(f"- Function: {fn}")
            blocks.append("\n".join(lines))

        return LookupResult(status=OK, content="\n\n".join(blocks), references=refs)
