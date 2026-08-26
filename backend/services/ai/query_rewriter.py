"""Query rewriter: free-text question → structured intent.

The structured intent drives which retrievers fire and what they pull. The
heart of P4's "ask any question and it just works" feel.

Two implementations:

1. **Heuristic** (default fallback) — regex + keyword extraction. Always
   available, no API call, no cost. Catches the common cases reliably
   (protein symbols, module names, GO/pathway keywords, cell types).

2. **LLM (Haiku)** — wraps the heuristic with one Claude Haiku call that
   refines the intent. Adds ~$0.001 and ~500ms per turn. Catches phrasing
   the heuristic misses ("which proteins drive the disease signature?" →
   significance ranking intent).

The runner prefers the LLM path when an Anthropic provider is available; if
the call fails (rate limit, key missing) it transparently falls back to
heuristic. So this layer NEVER blocks the chat.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict, dataclass, field
from typing import Optional

from .providers.base import Message as ProviderMessage, Provider

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Intent schema
# ---------------------------------------------------------------------------

INTENT_TYPES = (
    "protein_lookup",           # "what is APOE's log2FC"
    "significance_ranking",     # "top differentially expressed proteins"
    "module_query",             # "hubs in turquoise module"
    "module_list",              # "how many modules are there"
    "go_enrichment",            # "what pathways are enriched"
    "cell_type",                # "which modules are over-represented in microglia"
    "trait_correlation",        # "modules correlated with disease severity"
    "cross_modal",              # combines two or more of the above
    "summary",                  # "summarize this run"
    "comparison",               # "compare run X to run Y" (cross-run)
    "metadata",                 # "how many samples", "what's the design"
    "open_ended",               # catch-all when nothing else matches
)


@dataclass
class QueryIntent:
    intent_type: str
    entities: dict[str, list[str]] = field(default_factory=dict)
    # E.g., {"proteins": ["APOE", "CLU"], "modules": ["turquoise"], "cell_types": ["microglia"], "go_terms": []}
    target_families: list[str] = field(default_factory=list)
    requires_cross_modal: bool = False
    confidence: float = 0.5         # heuristic = 0.5, LLM-refined = 0.85
    raw_text: str = ""
    notes: str = ""

    def to_jsonable(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Heuristic extractor
# ---------------------------------------------------------------------------

# Standard cell type names (case-insensitive). Extend when we see more in datasets.
CELL_TYPE_TERMS = {
    "neuron", "neurons", "neuronal",
    "astrocyte", "astrocytes", "astrocytic",
    "microglia", "microglial",
    "oligodendrocyte", "oligodendrocytes", "oligodendrocytic",
    "endothelia", "endothelial", "endothelium",
    "pericyte", "pericytes",
    "opc",
}

GO_KEYWORDS = (
    "go term", "go terms", "pathway", "pathways", "enrich", "enrichment",
    "gsea", "ora", "biological process", "molecular function", "cellular component",
)
MODULE_KEYWORDS = ("module", "modules", "wgcna", "co-expression", "co expression", "network module")
HUB_KEYWORDS = ("hub", "hubs", "hub protein", "kme", "hub gene")
SIGNIFICANCE_KEYWORDS = (
    "significant", "top differential", "most differential", "top hits", "biggest hits",
    "most upregulated", "most downregulated", "ranked by", "rank by", "leading edge",
    "highest log2fc", "lowest pvalue", "lowest p-value", "top de", "top dep",
)
TRAIT_KEYWORDS = ("trait", "correlation", "phenotype", "clinical", "severity", "disease score")
SUMMARY_KEYWORDS = ("summarize", "summary", "overview", "high level", "high-level", "executive", "what happened")
COMPARE_KEYWORDS = ("compare", "comparison", "versus", " vs ", " vs.", "across runs", "between runs", "vs another")
METADATA_KEYWORDS = ("how many sample", "how many proteins", "sample count", "feature count", "study design", "what was analyzed", "what was studied")

# Gene/protein symbol pattern: 2–10 chars, must start with an uppercase letter,
# remainder uppercase letters and digits. Excludes common English words by
# requiring all-caps plus optional digit suffix.
SYMBOL_REGEX = re.compile(r"\b([A-Z][A-Z0-9]{1,9})\b")
# Common all-caps acronyms that aren't gene symbols — filter out.
SYMBOL_BLOCKLIST = {
    "GO", "WGCNA", "MDS", "PCA", "QC", "TSV", "CSV", "PDF", "JSON", "HTML", "XML",
    "API", "URL", "HTTP", "HTTPS", "AI", "LLM", "CPU", "GPU", "RAM", "OK", "ID",
    "IDS", "FYI", "TLDR", "AKA", "RE", "PS", "MR", "DR", "RUN", "DE", "FC",
    "ML", "RNA", "DNA", "FDR", "ANOVA", "BH", "BP", "MF", "CC", "GMT",
    "AD",  # users often write "AD vs control" — Alzheimer's disease, not a gene
    "USA", "UK", "EU", "US",
}

MODULE_NAME_REGEX = re.compile(
    r"\b(?:module\s+)?(turquoise|blue|brown|yellow|green|red|black|pink|magenta|"
    r"purple|greenyellow|tan|salmon|cyan|midnightblue|lightcyan|lightgreen|"
    r"lightyellow|grey60|grey|M\d+|module\s+\d+)\b",
    re.IGNORECASE,
)


def _extract_symbols(text: str) -> list[str]:
    seen: list[str] = []
    for m in SYMBOL_REGEX.finditer(text):
        sym = m.group(1)
        if sym in SYMBOL_BLOCKLIST or len(sym) < 2:
            continue
        if sym not in seen:
            seen.append(sym)
    return seen


def _extract_modules(text: str) -> list[str]:
    seen: list[str] = []
    for m in MODULE_NAME_REGEX.finditer(text):
        name = m.group(1).lower().replace("module ", "").strip()
        if name and name not in seen:
            seen.append(name)
    return seen


def _extract_cell_types(text: str) -> list[str]:
    seen: list[str] = []
    low = text.lower()
    for term in CELL_TYPE_TERMS:
        if re.search(rf"\b{re.escape(term)}\b", low) and term not in seen:
            seen.append(term)
    return seen


def heuristic_intent(text: str) -> QueryIntent:
    """Always-available, deterministic intent extraction. Conservative —
    when in doubt, return ``open_ended`` and let the retrievers fall back
    to sensible defaults."""
    if not (text or "").strip():
        return QueryIntent(intent_type="open_ended", raw_text="", notes="empty text")

    low = text.lower()
    symbols = _extract_symbols(text)
    modules = _extract_modules(text)
    cells = _extract_cell_types(text)
    entities: dict[str, list[str]] = {}
    if symbols:
        entities["proteins"] = symbols
    if modules:
        entities["modules"] = modules
    if cells:
        entities["cell_types"] = cells

    # "compare" only means cross-RUN comparison when ≥2 RUN-IDs are referenced.
    # Otherwise "compare turquoise vs blue modules" is an intra-run module query.
    explicit_runs = re.findall(r"RUN-\w+", text)
    is_compare = (any(k in low for k in COMPARE_KEYWORDS) and len(explicit_runs) >= 2) or len(explicit_runs) >= 2
    is_summary = any(k in low for k in SUMMARY_KEYWORDS)
    is_metadata = any(k in low for k in METADATA_KEYWORDS)
    is_go = any(k in low for k in GO_KEYWORDS)
    is_module = any(k in low for k in MODULE_KEYWORDS)
    is_hub = any(k in low for k in HUB_KEYWORDS)
    is_cell = bool(cells)
    is_trait = any(k in low for k in TRAIT_KEYWORDS)
    is_significance = any(k in low for k in SIGNIFICANCE_KEYWORDS) or "p-value" in low or "pvalue" in low

    targets: list[str] = []
    intent_type = "open_ended"

    # Order matters — most specific intents win.
    if is_compare:
        intent_type = "comparison"
        targets = ["volcano.results", "network.assignments", "report.manifest"]
    elif is_go and (is_cell or is_module):
        intent_type = "cross_modal"
        targets = ["go.enrichment", "cells.matrix" if is_cell else "network.assignments"]
    elif is_go:
        intent_type = "go_enrichment"
        targets = ["go.enrichment"]
        if symbols or modules:
            targets.append("network.assignments")
    elif is_cell:
        intent_type = "cell_type"
        targets = ["cells.matrix", "cells.hit_list"]
        if modules:
            targets.append("network.assignments")
    elif is_trait:
        intent_type = "trait_correlation"
        targets = ["network.module_trait", "network.eigengenes"]
    elif is_hub or (is_module and modules):
        intent_type = "module_query"
        targets = ["network.assignments", "network.kme", "report.top_proteins"]
    elif is_module:
        intent_type = "module_list"
        targets = ["network.assignments"]
    elif is_significance and not symbols:
        intent_type = "significance_ranking"
        targets = ["volcano.results"]
    elif symbols:
        intent_type = "protein_lookup"
        targets = ["volcano.results", "network.assignments"]
    elif is_metadata:
        intent_type = "metadata"
        targets = ["report.manifest", "report.params", "input.samples"]
    elif is_summary:
        intent_type = "summary"
        targets = ["report.manifest", "report.summary", "volcano.results"]

    requires_cross_modal = intent_type == "cross_modal" or (
        intent_type in ("go_enrichment", "cell_type") and (symbols or modules)
    )

    return QueryIntent(
        intent_type=intent_type,
        entities=entities,
        target_families=targets,
        requires_cross_modal=requires_cross_modal,
        confidence=0.5,
        raw_text=text,
        notes="heuristic",
    )


# ---------------------------------------------------------------------------
# LLM-refined extractor (Haiku)
# ---------------------------------------------------------------------------

REWRITER_SYSTEM = (
    "You are a query router for a proteomics chat assistant. Given a user "
    "question, classify the intent and extract referenced entities. "
    "Return STRICT JSON only — no prose, no code fence. Schema:\n\n"
    "{\n"
    "  \"intent_type\": one of [protein_lookup, significance_ranking, module_query, "
    "module_list, go_enrichment, cell_type, trait_correlation, cross_modal, summary, "
    "comparison, metadata, open_ended],\n"
    "  \"entities\": {\n"
    "    \"proteins\":   [gene symbols like APOE, CLU],\n"
    "    \"modules\":    [WGCNA module names like turquoise, blue, M3],\n"
    "    \"cell_types\": [cell type names like neuron, microglia],\n"
    "    \"go_terms\":   [GO term keywords]\n"
    "  },\n"
    "  \"target_families\": [artifact families to pull from — pick from: volcano.results, "
    "network.assignments, network.kme, network.module_trait, network.eigengenes, "
    "go.enrichment, cells.matrix, cells.hit_list, report.manifest, report.params, "
    "report.top_proteins, report.summary, input.matrix, input.samples],\n"
    "  \"requires_cross_modal\": true if the question references data from 2+ artifact "
    "families that must be joined,\n"
    "  \"notes\": brief explanation\n"
    "}\n\n"
    "Examples:\n"
    "Q: \"what is APOE's log2FC?\"  →  {\"intent_type\":\"protein_lookup\",\"entities\":{\"proteins\":[\"APOE\"]},\"target_families\":[\"volcano.results\",\"network.assignments\"],\"requires_cross_modal\":false,\"notes\":\"single protein DE lookup\"}\n"
    "Q: \"GO pathways enriched in microglia-associated modules\"  →  {\"intent_type\":\"cross_modal\",\"entities\":{\"cell_types\":[\"microglia\"]},\"target_families\":[\"cells.matrix\",\"go.enrichment\"],\"requires_cross_modal\":true,\"notes\":\"join cell-type modules with GO\"}\n"
)


def _strip_fence(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text


async def llm_intent(
    text: str,
    *,
    provider: Provider,
    model: str = "claude-haiku-4-5",
) -> QueryIntent:
    """LLM-refined intent. Always returns something — falls back to heuristic
    on any failure."""
    fallback = heuristic_intent(text)
    if not text.strip():
        return fallback
    try:
        result = await provider.complete(
            model=model,
            system=REWRITER_SYSTEM,
            messages=[
                ProviderMessage(role="user", content=[{"type": "text", "text": text}])
            ],
            tools=None,
            max_output_tokens=400,
        )
        raw = _strip_fence(result.get("text") or "")
        data = json.loads(raw)
    except Exception as exc:  # provider error, JSON error — fall back silently
        log.warning("LLM rewriter failed (%s); using heuristic", exc)
        return fallback

    # Sanity-check the LLM output before trusting it.
    intent_type = data.get("intent_type", "open_ended")
    if intent_type not in INTENT_TYPES:
        intent_type = fallback.intent_type
    raw_entities = data.get("entities") or {}
    entities: dict[str, list[str]] = {}
    for k in ("proteins", "modules", "cell_types", "go_terms"):
        vals = raw_entities.get(k) or []
        if isinstance(vals, list):
            entities[k] = [str(v) for v in vals if v]
    # If the LLM missed obvious entities the heuristic caught, merge them in.
    for k, vals in fallback.entities.items():
        for v in vals:
            entities.setdefault(k, [])
            if v not in entities[k]:
                entities[k].append(v)
    target_families = data.get("target_families") or fallback.target_families
    if not isinstance(target_families, list):
        target_families = fallback.target_families
    requires_cross_modal = bool(data.get("requires_cross_modal", fallback.requires_cross_modal))

    return QueryIntent(
        intent_type=intent_type,
        entities=entities,
        target_families=list(target_families),
        requires_cross_modal=requires_cross_modal,
        confidence=0.85,
        raw_text=text,
        notes=str(data.get("notes") or "llm-refined"),
    )
