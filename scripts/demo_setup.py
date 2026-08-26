#!/usr/bin/env python3
"""Stamp this checkout's location into the demo bundle.

The demo branch ships its databases and run files with every absolute host
path replaced by the ``__SIGNALFOLD_ROOT__`` placeholder, so the bundle is
portable. This script rewrites that placeholder to wherever the repository
actually lives on this machine.

Run it once after cloning::

    python3 scripts/demo_setup.py

It is safe to re-run, and re-running is the correct fix if you move or rename
the checkout directory: the previously stamped root is recorded in
``data/.demo_root`` and is rewritten to the new location.

Databases are edited through SQL only -- never by patching bytes in the file,
which would corrupt the SQLite page structure.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

TOKEN = "__SIGNALFOLD_ROOT__"
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
MARKER = DATA / ".demo_root"

DATABASES = ("proteomics.db", "ai_insights.sqlite")
SKIP_SUFFIXES = {".db", ".sqlite", ".sqlite3", ".bak"}
SKIP_FRAGMENTS = ("-wal", "-shm")

EXPECTED = [
    "data/proteomics.db",
    "data/ai_insights.sqlite",
    "data/runs/RUN-20260518-3E7F",
    "data/uploads/6d13d41761f047cd.csv",
    "demo/SPEC-PEP-Sweden.csv",
]


def sources() -> list[str]:
    """Path prefixes to rewrite: the placeholder, plus any stale stamped root."""
    out = [TOKEN]
    if MARKER.exists():
        previous = MARKER.read_text().strip()
        if previous and previous != str(ROOT):
            out.append(previous)
    return out


def rewrite_db(path: Path, olds: list[str]) -> int:
    con = sqlite3.connect(path)
    changed = 0
    try:
        names = [r[0] for r in con.execute(
            "select name from sqlite_master where type='table'")
            if not r[0].startswith("sqlite_")]
        for table in names:
            for col in [r[1] for r in con.execute(f"PRAGMA table_info({table})")]:
                for old in olds:
                    cur = con.execute(
                        f'update "{table}" set "{col}" = replace("{col}", ?, ?) '
                        f'where "{col}" like ?', (old, str(ROOT), f"%{old}%"))
                    changed += cur.rowcount if cur.rowcount > 0 else 0
        con.commit()
    finally:
        con.close()
    return changed


def rewrite_files(olds: list[str]) -> int:
    changed = 0
    for f in DATA.rglob("*"):
        if not f.is_file():
            continue
        if f.suffix.lower() in SKIP_SUFFIXES or any(s in f.name for s in SKIP_FRAGMENTS):
            continue
        try:
            raw = f.read_text()
        except (OSError, UnicodeDecodeError):
            continue
        if not any(old in raw for old in olds):
            continue
        for old in olds:
            raw = raw.replace(old, str(ROOT))
        f.write_text(raw)
        changed += 1
    return changed


def main() -> int:
    print(f"SignalFold demo setup\n  repository root: {ROOT}")

    missing = [p for p in EXPECTED if not (ROOT / p).exists()]
    if missing:
        print("\nERROR: the demo bundle is incomplete. Missing:")
        for m in missing:
            print(f"  - {m}")
        print("\nYou are probably on the wrong branch. Expected 'demo-branch':")
        print("  git checkout demo-branch")
        return 1

    olds = sources()
    if len(olds) > 1:
        print(f"  previous root:   {olds[1]} (will be updated)")

    rows = sum(rewrite_db(DATA / name, olds) for name in DATABASES)
    files = rewrite_files(olds)

    MARKER.write_text(str(ROOT))

    print(f"\n  database values rewritten: {rows}")
    print(f"  files rewritten:           {files}")

    con = sqlite3.connect(DATA / "proteomics.db")
    run = con.execute("select id, name, status from runs").fetchone()
    dataset = con.execute("select original_name, stored_path from uploaded_datasets").fetchone()
    con.close()

    ok = Path(dataset[1]).exists()
    print(f"\n  run:     {run[0]}  ({run[2]})")
    print(f"  dataset: {dataset[0]}  -> {'found' if ok else 'MISSING'}")
    if not ok:
        print(f"\nERROR: dataset file not found at {dataset[1]}")
        return 1

    print("\nSetup complete. Start the app with:")
    print("  ./run.sh start all")
    print("\nSign in at http://127.0.0.1:8000 with:")
    print("  admin@local.signalfold / local-bootstrap-only")
    return 0


if __name__ == "__main__":
    sys.exit(main())
