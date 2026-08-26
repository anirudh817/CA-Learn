"""Conversation-history compression — P4 Wave 3.

``build_provider_messages`` historically replayed *every* completed turn of a
conversation verbatim into each new request. On a long chat that grows without
bound and eventually crowds out retrieval context (or blows the model's input
window).

This module compresses the OLD part of the history into a compact extractive
summary once the history's estimated token size crosses
``AI_INPUT_TOKEN_BUDGET * AI_HISTORY_SUMMARIZE_AT`` (default 70%), while always
keeping the most recent turns verbatim. The compression is deterministic and
dependency-free (char/4 token estimate, extractive snippets) so it is fast,
testable, and adds no API call or third-party tokenizer dependency — a good fit
for the Anthropic-only build.

Public surface:
    estimate_tokens(text) -> int
    summarize_history(messages, *, input_budget_tokens, summarize_at,
                      keep_recent_turns) -> (summary_text | None, recent_messages)
"""
from __future__ import annotations

import math
from typing import Optional, Sequence, Tuple


# Rough chars-per-token; the same heuristic the retriever budget uses. Good
# enough for a "are we over budget?" gate — we never bill from this number.
_CHARS_PER_TOKEN = 4

# How much of each older message to keep in the extractive summary, and the
# overall ceiling on the summary block so it can't itself blow the budget.
_PER_MESSAGE_SNIPPET_CHARS = 240
_SUMMARY_MAX_CHARS = 6_000


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, math.ceil(len(text) / _CHARS_PER_TOKEN))


def _role_of(message) -> str:
    role = getattr(message, "role", "")
    return role.value if hasattr(role, "value") else str(role)


def _content_of(message) -> str:
    return (getattr(message, "content", "") or "").strip()


def _snippet(text: str, limit: int = _PER_MESSAGE_SNIPPET_CHARS) -> str:
    text = " ".join(text.split())  # collapse whitespace/newlines
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "…"


def summarize_history(
    messages: Sequence,
    *,
    input_budget_tokens: int,
    summarize_at: float = 0.70,
    keep_recent_turns: int = 4,
) -> Tuple[Optional[str], list]:
    """Compress old turns when history is large; keep recent turns verbatim.

    Parameters
    ----------
    messages
        Conversational messages (user/assistant), oldest first, already
        filtered to non-empty content.
    input_budget_tokens
        The model's input budget; the summarize threshold is a fraction of it.
    summarize_at
        Fraction of the budget at which compression kicks in (0..1).
    keep_recent_turns
        Number of recent *turns* (a turn ≈ 2 messages) always kept verbatim.

    Returns
    -------
    (summary_text, recent_messages)
        ``summary_text`` is ``None`` when no compression was needed (and
        ``recent_messages`` is then the full input list unchanged).
    """
    msgs = list(messages)
    keep_recent_msgs = max(2, keep_recent_turns * 2)

    # Not enough history to bother, or compression disabled.
    if len(msgs) <= keep_recent_msgs or summarize_at <= 0 or input_budget_tokens <= 0:
        return None, msgs

    total_tokens = sum(estimate_tokens(_content_of(m)) for m in msgs)
    threshold = input_budget_tokens * summarize_at
    if total_tokens <= threshold:
        return None, msgs

    recent = msgs[-keep_recent_msgs:]
    older = msgs[:-keep_recent_msgs]
    if not older:
        return None, msgs

    # Extractive summary, newest-of-the-old first so that if we hit the char
    # ceiling we drop the least-recent context (the least likely to matter).
    lines: list[str] = []
    used = 0
    for m in reversed(older):
        content = _content_of(m)
        if not content:
            continue
        role = _role_of(m)
        label = "You" if role == "user" else "Assistant"
        line = f"- **{label}:** {_snippet(content)}"
        if used + len(line) > _SUMMARY_MAX_CHARS:
            lines.append(f"- _(…{len(older) - len(lines)} earlier message(s) omitted to fit context.)_")
            break
        lines.append(line)
        used += len(line)

    if not lines:
        return None, msgs

    lines.reverse()  # restore chronological order for readability
    summary = (
        f"Summary of the earlier part of this conversation "
        f"({len(older)} message(s) condensed; the {len(recent)} most recent "
        f"message(s) are shown verbatim below):\n" + "\n".join(lines)
    )
    return summary, recent
