"""CLI for the eval harness.

Usage:
    python3 -m services.ai.eval.cli --dataset bootstrap
    python3 -m services.ai.eval.cli --dataset bootstrap --llm-judge
    python3 -m services.ai.eval.cli --dataset bootstrap --baseline baseline.json
    python3 -m services.ai.eval.cli --list

Exit codes:
    0  — suite ran (and matched baseline if --baseline was provided)
    1  — runtime error (no key, dataset not found, etc.)
    2  — regression detected vs --baseline beyond --tolerance

The CLI needs a working Anthropic key to actually run, since it calls the
real provider. To set one up: either ``export ANTHROPIC_API_KEY=sk-ant-…``
or paste a key in the in-app settings drawer (the CLI reads from the same
env var as the app's platform-key fallback).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

# Make backend/ importable when run as a script.
ROOT = Path(__file__).resolve().parents[4]   # repo root
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from services.ai.eval.dataset import (
    datasets_dir,
    list_dataset_files,
    load_dataset,
)
from services.ai.eval.runner import (
    CaseResult,
    SuiteResult,
    regression_check,
    run_suite,
)
from services.ai.providers.anthropic_provider import AnthropicProvider


def _resolve_dataset_path(name_or_path: str) -> Path:
    p = Path(name_or_path)
    if p.exists():
        return p
    # Bare name → look in services/ai/eval/datasets/
    candidate = datasets_dir() / (
        name_or_path if name_or_path.endswith(".json") else f"{name_or_path}.json"
    )
    if candidate.exists():
        return candidate
    raise FileNotFoundError(
        f"Dataset {name_or_path!r} not found. Try one of: "
        + ", ".join(p.stem for p in list_dataset_files())
    )


def _print_case(r: CaseResult) -> None:
    badge = "✓" if r.passed else ("⚠ " if r.error else "✗")
    print(
        f"  {badge} [{r.category:18}] {r.case_id:34}  "
        f"kw={r.keyword_recall_score:.2f}  "
        f"cite={r.citation_score:.2f}  "
        f"forb={r.forbidden_hit_count}  "
        f"faith={('—' if r.faithfulness_score is None else f'{r.faithfulness_score:.2f}')}"
        + (f"  ERR: {r.error[:60]}" if r.error else "")
    )


def _print_summary(s: SuiteResult) -> None:
    print()
    print("=" * 78)
    print(f"Dataset: {s.dataset_name}")
    print(f"Cases: {s.run_count}  |  Pass: {s.pass_count}  |  Fail: {s.fail_count}  |  Error: {s.error_count}")
    print(f"Pass rate:           {s.pass_rate:.1%}")
    print(f"Avg keyword recall:  {s.avg_keyword_recall:.3f}")
    print(f"Avg citation score:  {s.avg_citation_score:.3f}")
    if s.avg_faithfulness_score is not None:
        print(f"Avg LLM faithfulness:{s.avg_faithfulness_score:.3f}")
    else:
        print("Avg LLM faithfulness: — (run with --llm-judge to enable)")
    print(f"Forbidden-substring hits across all cases: {s.total_forbidden_hits}")
    print(f"Token usage: {s.total_input_tokens} input / {s.total_output_tokens} output")
    print(f"Elapsed: {s.elapsed_s:.1f}s")
    print("=" * 78)


def _write_report(s: SuiteResult, out_path: Path) -> None:
    payload = s.to_jsonable()
    payload["written_at"] = datetime.utcnow().isoformat() + "Z"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False, default=str))
    print(f"\nFull scorecard written to: {out_path}")


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="SignalFold AI chat eval harness.")
    parser.add_argument("--dataset", help="Dataset name (e.g. bootstrap) or path to a .json file.")
    parser.add_argument("--list", action="store_true", help="List available datasets and exit.")
    parser.add_argument("--filter-ids", nargs="*", help="Only run cases with these IDs.")
    parser.add_argument("--filter-tags", nargs="*", help="Only run cases with at least one of these tags.")
    parser.add_argument("--model", default="claude-sonnet-4-6", help="Model under test.")
    parser.add_argument("--llm-judge", action="store_true", help="Enable LLM faithfulness judge (extra cost).")
    parser.add_argument("--judge-model", default="claude-haiku-4-5")
    parser.add_argument("--baseline", help="Path to a baseline scorecard JSON to compare against.")
    parser.add_argument("--tolerance", type=float, default=0.05, help="Allowed regression on each metric.")
    parser.add_argument("--output", help="Where to write the full scorecard JSON (default: ./eval-report-<ts>.json).")
    args = parser.parse_args(argv)

    if args.list:
        files = list_dataset_files()
        if not files:
            print("(no datasets found)")
        for p in files:
            print(f"  {p.stem}    [{p}]")
        return 0

    if not args.dataset:
        parser.error("--dataset is required (or use --list).")

    try:
        ds_path = _resolve_dataset_path(args.dataset)
        ds = load_dataset(ds_path)
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.filter_ids or args.filter_tags:
        ds = ds.filter(ids=args.filter_ids, tags=args.filter_tags)
    if not ds.cases:
        print("error: no cases match the requested filter.", file=sys.stderr)
        return 1

    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        print(
            "error: ANTHROPIC_API_KEY not set in the environment. The eval CLI "
            "calls Anthropic directly; export your key first.",
            file=sys.stderr,
        )
        return 1

    provider = AnthropicProvider(api_key=api_key)
    judge_provider = provider if args.llm_judge else None

    print(f"Running suite '{ds.name}' ({len(ds)} cases) with model={args.model}…")
    if args.llm_judge:
        print(f"  + LLM faithfulness judge enabled (judge={args.judge_model})")
    print()

    result = asyncio.run(run_suite(
        ds,
        provider=provider,
        model=args.model,
        judge_provider=judge_provider,
        judge_model=args.judge_model,
        on_case_done=_print_case,
    ))

    _print_summary(result)

    out_path = Path(args.output) if args.output else Path(
        f"./eval-report-{ds.name}-{datetime.utcnow().strftime('%Y%m%dT%H%M%S')}.json"
    )
    _write_report(result, out_path)

    if args.baseline:
        check = regression_check(result, Path(args.baseline), tolerance=args.tolerance)
        print()
        print("Baseline comparison:")
        print(json.dumps(check, indent=2))
        if not check["ok"]:
            print(f"\n✗ REGRESSION: {', '.join(check['regressed_metrics'])} dropped beyond --tolerance ({args.tolerance})")
            return 2
        print("\n✓ No regression beyond tolerance.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
