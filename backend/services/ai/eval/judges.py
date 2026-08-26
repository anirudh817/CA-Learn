"""Scoring judges for eval cases.

Two layers:

1. **Programmatic** (cheap, deterministic, no API call):
   - ``keyword_recall``         — fraction of expected_keywords present
   - ``forbidden_hits``         — count of forbidden_substrings present
   - ``citation_correctness``   — fraction of must_cite_files actually cited
   - ``answer_length_chars``    — simple sanity metric

2. **LLM-based** (slower, needs Anthropic, signals semantic faithfulness):
   - ``llm_faithfulness_judge`` — extracts every factual claim from the answer,
                                  marks each supported / unsupported by context.
                                  Returns ``{score: 0..1, claims: [...]}``.

The runner always computes (1); (2) is opt-in via ``--llm-judge`` to keep CI
fast and free. Both layers contribute to the case's final pass/fail decision.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Optional

from ..providers.base import Message as ProviderMessage, Provider, ProviderError

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Programmatic scorers (no API calls)
# ---------------------------------------------------------------------------

def keyword_recall(answer: str, expected_keywords: list[str]) -> dict:
    """Fraction of expected keywords (case-insensitive substrings) present in
    the answer. Returns score, hit list, miss list."""
    if not expected_keywords:
        return {"score": 1.0, "hits": [], "misses": []}
    ans = (answer or "").lower()
    hits = [k for k in expected_keywords if k.lower() in ans]
    misses = [k for k in expected_keywords if k.lower() not in ans]
    return {
        "score": len(hits) / len(expected_keywords),
        "hits": hits,
        "misses": misses,
    }


def forbidden_hits(answer: str, forbidden_substrings: list[str]) -> dict:
    """Count of forbidden substrings present. Any hit lowers trust."""
    if not forbidden_substrings:
        return {"count": 0, "hits": []}
    ans = (answer or "").lower()
    hits = [s for s in forbidden_substrings if s.lower() in ans]
    return {"count": len(hits), "hits": hits}


def citation_correctness(cited_files: list[str], must_cite_files: list[str]) -> dict:
    """Fraction of required files that appear in the citations list."""
    if not must_cite_files:
        return {"score": 1.0, "missing": [], "extra": []}
    cited = [c.lower() for c in cited_files]
    missing = [f for f in must_cite_files if not any(f.lower() in c for c in cited)]
    score = (len(must_cite_files) - len(missing)) / len(must_cite_files)
    extra = [c for c in cited_files if not any(m.lower() in c.lower() for m in must_cite_files)]
    return {"score": score, "missing": missing, "extra": extra}


# ---------------------------------------------------------------------------
# LLM faithfulness judge
# ---------------------------------------------------------------------------

JUDGE_SYSTEM = (
    "You are a strict faithfulness judge for a scientific chat assistant. You "
    "will be given (a) the user's question, (b) the answer the assistant gave, "
    "and (c) the context the assistant was given to ground that answer.\n\n"
    "Your job: extract every factual claim from the answer. For each claim, "
    "mark it as SUPPORTED if a span in the context entails it, UNSUPPORTED if "
    "the context does not entail it (even if the claim is plausibly true), or "
    "BACKGROUND if the answer explicitly marked it as background knowledge "
    "(e.g., wrapped in `> **Background:**` and `(Not derived from your run.)`).\n\n"
    "Return strictly valid JSON of the form:\n"
    "{\n"
    "  \"claims\": [{\"text\": str, \"verdict\": \"SUPPORTED|UNSUPPORTED|BACKGROUND\", \"evidence\": str}],\n"
    "  \"unsupported_count\": int,\n"
    "  \"supported_count\": int,\n"
    "  \"background_count\": int\n"
    "}\n"
    "Be strict — a claim like 'APOE has 26 peptides' is only SUPPORTED if you "
    "can see those peptides (or a count) in the context. Speculation is "
    "UNSUPPORTED. Do not be charitable."
)


@dataclass
class FaithfulnessResult:
    score: float                        # supported / (supported + unsupported); ignores background
    supported: int
    unsupported: int
    background: int
    claims: list[dict] = field(default_factory=list)
    error: Optional[str] = None


def _strip_code_fence(text: str) -> str:
    """LLM judges often wrap JSON in ```json ... ``` — strip that."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text


async def llm_faithfulness_judge(
    *,
    question: str,
    answer: str,
    context: str,
    judge_provider: Provider,
    judge_model: str = "claude-haiku-4-5",
) -> FaithfulnessResult:
    """Call the judge model. Returns a FaithfulnessResult even on failure
    (with ``error`` populated) so the runner never crashes on a flaky judge."""
    if not answer or not answer.strip():
        return FaithfulnessResult(
            score=0.0, supported=0, unsupported=0, background=0, error="empty answer"
        )

    user_text = (
        f"QUESTION:\n{question}\n\n"
        f"ANSWER:\n{answer}\n\n"
        f"CONTEXT (truncated to 30K chars):\n{context[:30_000]}"
    )
    messages = [
        ProviderMessage(role="user", content=[{"type": "text", "text": user_text}])
    ]
    try:
        result = await judge_provider.complete(
            model=judge_model,
            system=JUDGE_SYSTEM,
            messages=messages,
            tools=None,
            max_output_tokens=2000,
        )
        raw = _strip_code_fence(result.get("text") or "")
        data = json.loads(raw)
    except (ProviderError, json.JSONDecodeError, Exception) as exc:  # pragma: no cover
        log.warning("LLM judge failed: %s", exc)
        return FaithfulnessResult(
            score=0.0, supported=0, unsupported=0, background=0, error=str(exc)
        )

    supported = int(data.get("supported_count", 0) or 0)
    unsupported = int(data.get("unsupported_count", 0) or 0)
    background = int(data.get("background_count", 0) or 0)
    denom = supported + unsupported
    score = (supported / denom) if denom > 0 else 1.0
    return FaithfulnessResult(
        score=score,
        supported=supported,
        unsupported=unsupported,
        background=background,
        claims=list(data.get("claims") or []),
    )
