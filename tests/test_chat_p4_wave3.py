"""P4 Wave 3 tests — relevance reranker + conversation-history summarizer.

These cover the two pieces that turn "retrieval works" into "retrieval stays
useful on big runs and long chats":
  - reranker: the most relevant chunk survives a tight budget cut.
  - summarizer: long histories compress to a summary + recent turns; short
    histories pass through untouched.
"""
from __future__ import annotations

import sys
import tempfile
import unittest
import warnings

from tests.test_app import BACKEND_DIR, build_app

warnings.simplefilter("ignore", DeprecationWarning)
warnings.simplefilter("ignore", ResourceWarning)


def _ensure_backend_on_path() -> None:
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))


with tempfile.TemporaryDirectory() as _td:
    build_app(_td)
_ensure_backend_on_path()


from services.ai.query_rewriter import QueryIntent  # noqa: E402
from services.ai.reranker import rerank, score_chunk  # noqa: E402
from services.ai.retrievers import RetrievedChunk  # noqa: E402
from services.ai.summarizer import estimate_tokens, summarize_history  # noqa: E402


class _FakeMsg:
    """Minimal stand-in for the ORM Message (role + content)."""

    def __init__(self, role: str, content: str) -> None:
        self.role = role
        self.content = content


# ---------------------------------------------------------------------------
# Reranker
# ---------------------------------------------------------------------------

class RerankerTests(unittest.TestCase):
    def _chunk(self, **kw):
        base = dict(family="volcano.results", rel_path="x", title="t", body="b", rows_returned=0)
        base.update(kw)
        return RetrievedChunk(**base)

    def test_entity_match_outranks_fallback(self):
        intent = QueryIntent(intent_type="protein_lookup", entities={"proteins": ["APOE"]})
        relevant = self._chunk(rel_path="de.tsv", title="Differential expression",
                               body="| gene | log2fc |\n| APOE | 1.2 |", rows_returned=5)
        fallback = self._chunk(rel_path="man.json", family="report.manifest",
                               title="Differential expression — no exact match",
                               notes="no rows matched the query; showing first 10 for orientation")
        ranked = rerank([fallback, relevant], intent)
        self.assertEqual(ranked[0].rel_path, "de.tsv")
        self.assertGreater(score_chunk(relevant, intent), score_chunk(fallback, intent))

    def test_family_affinity_breaks_ties(self):
        intent = QueryIntent(intent_type="go_enrichment", entities={})
        go = self._chunk(rel_path="go.csv", family="go.enrichment", rows_returned=3)
        other = self._chunk(rel_path="cells.csv", family="cells.matrix", rows_returned=3)
        ranked = rerank([other, go], intent)
        self.assertEqual(ranked[0].family, "go.enrichment")

    def test_stable_for_equal_scores(self):
        intent = QueryIntent(intent_type="open_ended", entities={})
        a = self._chunk(rel_path="a", family="zzz.unaligned", rows_returned=0)
        b = self._chunk(rel_path="b", family="zzz.unaligned", rows_returned=0)
        ranked = rerank([a, b], intent)
        self.assertEqual([c.rel_path for c in ranked], ["a", "b"])

    def test_word_boundary_avoids_spurious_substring_match(self):
        intent = QueryIntent(intent_type="protein_lookup", entities={"proteins": ["AP"]})
        # "APOE" must NOT count as a hit for the short query token "AP".
        chunk = self._chunk(body="APOE appears here only")
        # An exact "AP" token present:
        chunk_hit = self._chunk(rel_path="y", body="the AP value is high")
        self.assertGreater(score_chunk(chunk_hit, intent), score_chunk(chunk, intent))


# ---------------------------------------------------------------------------
# Summarizer
# ---------------------------------------------------------------------------

class SummarizerTests(unittest.TestCase):
    def test_estimate_tokens(self):
        self.assertEqual(estimate_tokens(""), 0)
        self.assertEqual(estimate_tokens("abcd"), 1)
        self.assertGreaterEqual(estimate_tokens("a" * 400), 100)

    def test_short_history_untouched(self):
        msgs = [_FakeMsg("user", "hi"), _FakeMsg("assistant", "hello")]
        summary, recent = summarize_history(
            msgs, input_budget_tokens=100_000, summarize_at=0.70, keep_recent_turns=4
        )
        self.assertIsNone(summary)
        self.assertEqual(len(recent), 2)

    def test_long_history_compresses_and_keeps_recent(self):
        msgs = [
            _FakeMsg("user" if i % 2 == 0 else "assistant", f"message {i} " + "x" * 5000)
            for i in range(40)
        ]
        summary, recent = summarize_history(
            msgs, input_budget_tokens=10_000, summarize_at=0.70, keep_recent_turns=4
        )
        self.assertIsNotNone(summary)
        self.assertEqual(len(recent), 8)  # 4 turns * 2
        # The most recent verbatim message must be the last input message.
        self.assertIs(recent[-1], msgs[-1])
        # The summary must reference the condensed older messages.
        self.assertIn("earlier", summary.lower())

    def test_summary_respects_char_ceiling(self):
        msgs = [_FakeMsg("user", "y" * 9000) for _ in range(60)]
        summary, recent = summarize_history(
            msgs, input_budget_tokens=8_000, summarize_at=0.70, keep_recent_turns=3
        )
        self.assertIsNotNone(summary)
        self.assertLessEqual(len(summary), 7_000)  # _SUMMARY_MAX_CHARS + header slack

    def test_disabled_when_budget_zero(self):
        msgs = [_FakeMsg("user", "x" * 9000) for _ in range(40)]
        summary, recent = summarize_history(
            msgs, input_budget_tokens=0, summarize_at=0.70, keep_recent_turns=4
        )
        self.assertIsNone(summary)
        self.assertEqual(len(recent), len(msgs))


if __name__ == "__main__":
    unittest.main()
