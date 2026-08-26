"""Drive the chat pipeline against an eval dataset and score every case.

Two modes:

1. **In-process** (default) — call ``context_builder.build_provider_messages``
   directly + ``provider.complete``. Faster, deterministic, no HTTP layer in
   the loop. This is what the eval is measuring anyway (prompt + retrieval
   quality), so HTTP overhead would be noise.

2. **Via HTTP** (future) — hits the real ``/api/conversations/.../messages``
   endpoint. Useful for testing the full transport but slower; not implemented
   yet (P5+).

The runner is decoupled from where the provider comes from: pass any object
implementing the ``Provider`` Protocol. Tests inject a mocked provider so the
suite runs in CI without API credentials; the CLI uses the real Anthropic
client.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from ..context_builder import (
    build_citations,
    build_provider_messages,
    system_prompt,
)
from ..providers.base import Provider

from .dataset import EvalCase, EvalDataset
from .judges import (
    FaithfulnessResult,
    citation_correctness,
    forbidden_hits,
    keyword_recall,
    llm_faithfulness_judge,
)

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Result dataclasses
# ---------------------------------------------------------------------------

@dataclass
class CaseResult:
    case_id: str
    category: str
    question: str
    run_id: str
    answer: str
    cited_files: list[str]
    keyword_recall_score: float
    keyword_hits: list[str]
    keyword_misses: list[str]
    forbidden_hit_count: int
    forbidden_hits_found: list[str]
    citation_score: float
    citations_missing: list[str]
    faithfulness_score: Optional[float] = None
    faithfulness_supported: Optional[int] = None
    faithfulness_unsupported: Optional[int] = None
    faithfulness_background: Optional[int] = None
    faithfulness_error: Optional[str] = None
    passed: bool = False
    elapsed_s: float = 0.0
    error: Optional[str] = None
    input_tokens: int = 0
    output_tokens: int = 0

    def to_jsonable(self) -> dict:
        return asdict(self)


@dataclass
class SuiteResult:
    dataset_name: str
    run_count: int
    pass_count: int
    fail_count: int
    error_count: int
    avg_keyword_recall: float
    avg_citation_score: float
    avg_faithfulness_score: Optional[float]
    total_forbidden_hits: int
    total_input_tokens: int
    total_output_tokens: int
    elapsed_s: float
    cases: list[CaseResult] = field(default_factory=list)

    @property
    def pass_rate(self) -> float:
        return self.pass_count / self.run_count if self.run_count else 0.0

    def to_jsonable(self) -> dict:
        d = asdict(self)
        d["pass_rate"] = self.pass_rate
        return d


# ---------------------------------------------------------------------------
# In-process runner
# ---------------------------------------------------------------------------

# A loader callback the caller provides to materialise a Conversation-shaped
# record + attachments for one case. We don't go through the DB — eval cases
# only need run_id + we synthesise the rest in memory.
@dataclass
class _PseudoConversation:
    id: str
    run_id: str
    workspace_id: str = "eval-ws"
    user_id: str = "eval-user"
    title: str = "eval"
    provider: str = "anthropic"
    model: str = "claude-sonnet-4-6"
    external_lookups_enabled: bool = False
    archived: bool = False
    pinned_message_id: Optional[str] = None
    created_at: Any = None
    updated_at: Any = None


def _pseudo_conv_for(case: EvalCase) -> _PseudoConversation:
    return _PseudoConversation(id=f"eval-{case.id}", run_id=case.run_id)


class _NullSession:
    """Stand-in DB session for context_builder.build_provider_messages.

    The builder queries history; eval cases are always single-turn, so
    history is empty. The Null object simulates that.
    """

    def query(self, *args, **kwargs):
        return self

    def filter(self, *args, **kwargs):
        return self

    def order_by(self, *args, **kwargs):
        return self

    def all(self):
        return []


async def run_case(
    case: EvalCase,
    *,
    provider: Provider,
    model: str = "claude-sonnet-4-6",
    judge_provider: Optional[Provider] = None,
    judge_model: str = "claude-haiku-4-5",
    max_output_tokens: int = 2000,
) -> CaseResult:
    """Score one eval case end-to-end."""
    start = time.monotonic()
    conv = _pseudo_conv_for(case)
    messages = build_provider_messages(
        _NullSession(),  # type: ignore[arg-type]
        conv,            # type: ignore[arg-type]
        case.question,
        attachments=[],
    )

    answer = ""
    in_tokens = 0
    out_tokens = 0
    error: Optional[str] = None
    try:
        result = await provider.complete(
            model=model,
            system=system_prompt(),
            messages=messages,
            tools=None,
            max_output_tokens=max_output_tokens,
        )
        answer = (result.get("text") or "").strip()
        usage = result.get("usage", {}) or {}
        in_tokens = int(usage.get("input_tokens", 0) or 0)
        out_tokens = int(usage.get("output_tokens", 0) or 0)
    except Exception as exc:
        error = str(exc)

    cited_files = [c.get("file_path", "") for c in build_citations(conv, [])]  # type: ignore[arg-type]

    kw = keyword_recall(answer, case.expected_keywords)
    fb = forbidden_hits(answer, case.forbidden_substrings)
    cit = citation_correctness(cited_files, case.must_cite_files)

    faith: Optional[FaithfulnessResult] = None
    if judge_provider is not None and answer and not error:
        # Reconstruct what the model saw as context (the prompt's user-side
        # text parts) so the judge can verify claim-by-claim.
        context_text = "\n\n".join(
            p.get("text", "")
            for m in messages
            for p in m.get("content", [])
            if p.get("type") == "text"
        )
        faith = await llm_faithfulness_judge(
            question=case.question,
            answer=answer,
            context=context_text,
            judge_provider=judge_provider,
            judge_model=judge_model,
        )

    passed = (
        error is None
        and kw["score"] >= case.min_keyword_recall
        and fb["count"] == 0
        and cit["score"] >= 0.5
        and (faith is None or faith.score >= 0.7 or faith.error is not None)
    )

    return CaseResult(
        case_id=case.id,
        category=case.category,
        question=case.question,
        run_id=case.run_id,
        answer=answer,
        cited_files=cited_files,
        keyword_recall_score=kw["score"],
        keyword_hits=kw["hits"],
        keyword_misses=kw["misses"],
        forbidden_hit_count=fb["count"],
        forbidden_hits_found=fb["hits"],
        citation_score=cit["score"],
        citations_missing=cit["missing"],
        faithfulness_score=faith.score if faith else None,
        faithfulness_supported=faith.supported if faith else None,
        faithfulness_unsupported=faith.unsupported if faith else None,
        faithfulness_background=faith.background if faith else None,
        faithfulness_error=faith.error if faith else None,
        passed=passed,
        elapsed_s=time.monotonic() - start,
        error=error,
        input_tokens=in_tokens,
        output_tokens=out_tokens,
    )


async def run_suite(
    dataset: EvalDataset,
    *,
    provider: Provider,
    model: str = "claude-sonnet-4-6",
    judge_provider: Optional[Provider] = None,
    judge_model: str = "claude-haiku-4-5",
    on_case_done: Optional[Callable[[CaseResult], None]] = None,
) -> SuiteResult:
    """Run every case in dataset sequentially. Sequential keeps per-case logs
    legible and respects provider rate limits; parallel mode can be added
    later if needed."""
    start = time.monotonic()
    results: list[CaseResult] = []
    for case in dataset.cases:
        r = await run_case(
            case,
            provider=provider,
            model=model,
            judge_provider=judge_provider,
            judge_model=judge_model,
        )
        results.append(r)
        if on_case_done:
            try:
                on_case_done(r)
            except Exception:  # pragma: no cover - logging callback shouldn't kill the suite
                pass

    pass_count = sum(1 for r in results if r.passed)
    error_count = sum(1 for r in results if r.error is not None)
    return SuiteResult(
        dataset_name=dataset.name,
        run_count=len(results),
        pass_count=pass_count,
        fail_count=len(results) - pass_count - error_count,
        error_count=error_count,
        avg_keyword_recall=_avg(r.keyword_recall_score for r in results),
        avg_citation_score=_avg(r.citation_score for r in results),
        avg_faithfulness_score=_avg(
            (r.faithfulness_score for r in results if r.faithfulness_score is not None),
            default=None,
        ),
        total_forbidden_hits=sum(r.forbidden_hit_count for r in results),
        total_input_tokens=sum(r.input_tokens for r in results),
        total_output_tokens=sum(r.output_tokens for r in results),
        elapsed_s=time.monotonic() - start,
        cases=results,
    )


def _avg(values, default=0.0):
    vals = list(values)
    if not vals:
        return default
    return sum(vals) / len(vals)


# ---------------------------------------------------------------------------
# Baseline comparison (regression gate)
# ---------------------------------------------------------------------------

def regression_check(current: SuiteResult, baseline_path: Path, tolerance: float = 0.05) -> dict:
    """Compare current scorecard to a saved baseline JSON. Returns a dict
    describing the comparison; the caller decides whether to fail CI."""
    baseline_raw = json.loads(Path(baseline_path).read_text())
    base_kw = float(baseline_raw.get("avg_keyword_recall", 0.0) or 0.0)
    base_cit = float(baseline_raw.get("avg_citation_score", 0.0) or 0.0)
    base_pass = float(baseline_raw.get("pass_rate", 0.0) or 0.0)

    deltas = {
        "keyword_recall": current.avg_keyword_recall - base_kw,
        "citation_score": current.avg_citation_score - base_cit,
        "pass_rate": current.pass_rate - base_pass,
    }
    regressed = [k for k, dv in deltas.items() if dv < -tolerance]
    return {
        "baseline_path": str(baseline_path),
        "tolerance": tolerance,
        "current": {
            "keyword_recall": current.avg_keyword_recall,
            "citation_score": current.avg_citation_score,
            "pass_rate": current.pass_rate,
        },
        "baseline": {
            "keyword_recall": base_kw,
            "citation_score": base_cit,
            "pass_rate": base_pass,
        },
        "deltas": deltas,
        "regressed_metrics": regressed,
        "ok": len(regressed) == 0,
    }
