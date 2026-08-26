from __future__ import annotations

import argparse
import csv
import html
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_csv", type=Path)
    parser.add_argument("output_svg", type=Path)
    parser.add_argument("--x", required=True)
    parser.add_argument("--y", required=True)
    args = parser.parse_args()

    points: list[tuple[float, float]] = []
    with args.input_csv.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            try:
                points.append((float(row[args.x]), float(row[args.y])))
            except (KeyError, TypeError, ValueError):
                continue
    if not points:
        raise SystemExit("no valid numeric points")

    xs, ys = zip(*points)
    xmin, xmax, ymin, ymax = min(xs), max(xs), min(ys), max(ys)
    xspan, yspan = xmax - xmin or 1.0, ymax - ymin or 1.0
    circles = []
    for x, y in points:
        cx = 40 + ((x - xmin) / xspan) * 520
        cy = 360 - ((y - ymin) / yspan) * 320
        circles.append(f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="4"/>')
    x_label, y_label = html.escape(args.x), html.escape(args.y)
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" '
        'viewBox="0 0 600 400">\n'
        '<rect width="600" height="400" fill="white"/>\n'
        '<g fill="#2563eb">' + "".join(circles) + '</g>\n'
        f'<text x="300" y="392" text-anchor="middle">{x_label}</text>\n'
        f'<text x="14" y="200" text-anchor="middle" transform="rotate(-90 14 200)">{y_label}</text>\n'
        '</svg>\n'
    )
    args.output_svg.parent.mkdir(parents=True, exist_ok=True)
    args.output_svg.write_text(svg, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
