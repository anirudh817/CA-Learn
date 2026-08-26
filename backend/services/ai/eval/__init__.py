"""SignalFold AI chat — evaluation harness.

Why this exists
---------------
Retrieval and prompting changes break **silently** — the model still answers,
the answer just becomes less accurate, less faithful to the run data, or starts
fabricating. Without an automated gate, regressions surface as user complaints
weeks later.

This package gives every retrieval/prompt change a measurable score so we can
say "this PR moved faithfulness from 0.82 → 0.91" instead of "we shipped P4 and
hope it's better."

Components
----------
- :mod:`dataset`  — typed schema for an eval case + JSON load/save.
- :mod:`judges`   — programmatic scorers (keyword recall, citation correctness,
                    forbidden-substring hits) and an LLM-based faithfulness judge.
- :mod:`runner`   — drives the chat pipeline against a dataset, computes scores,
                    aggregates a suite scorecard, optionally compares against a
                    saved baseline scorecard for regression detection.
- :mod:`cli`      — ``python3 -m services.ai.eval.cli --dataset bootstrap.json``.
- ``datasets/``   — JSON datasets, starting with ``bootstrap.json``.

Phasing
-------
P3 (this) ships the harness + bootstrap dataset (~10 cases) + framework tests.
P4 grows the dataset to 50+ as retrieval gets richer, and turns the CI smoke
into a regression gate that blocks PRs which lower the faithfulness score by
more than 5%.
"""
