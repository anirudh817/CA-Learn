from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_root", type=Path)
    parser.add_argument("output_json", type=Path)
    args = parser.parse_args()

    root = args.run_root.resolve()
    output = args.output_json.resolve()
    files = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.resolve() == output:
            continue
        rel = path.relative_to(root)
        if "ai_insights" in rel.parts:
            continue
        content = path.read_bytes()
        files.append(
            {
                "path": rel.as_posix(),
                "size_bytes": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        )
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(
        json.dumps({"files": files}, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
