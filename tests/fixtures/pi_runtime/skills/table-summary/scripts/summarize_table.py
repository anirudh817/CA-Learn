from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_csv", type=Path)
    parser.add_argument("output_json", type=Path)
    args = parser.parse_args()

    with args.input_csv.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
        columns = list(reader.fieldnames or [])

    numeric: dict[str, dict[str, float | int]] = {}
    for column in columns:
        values: list[float] = []
        for row in rows:
            try:
                values.append(float(row[column]))
            except (TypeError, ValueError):
                continue
        if values:
            numeric[column] = {
                "count": len(values),
                "min": min(values),
                "max": max(values),
                "mean": sum(values) / len(values),
            }

    payload = {"columns": columns, "row_count": len(rows), "numeric": numeric}
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
