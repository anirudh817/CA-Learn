from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path


SENSITIVE_NAMES = ("ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "SESSION_SECRET")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("success", "fail", "sleep", "environment"))
    parser.add_argument("output_json", type=Path)
    args = parser.parse_args()

    if args.mode == "fail":
        return 23
    if args.mode == "sleep":
        time.sleep(30)
    payload = {"mode": args.mode, "ok": True}
    if args.mode == "environment":
        payload["sensitive_names_present"] = [
            name for name in SENSITIVE_NAMES if os.environ.get(name)
        ]
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
