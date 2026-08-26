"""Eval dataset schema + JSON load/save.

A *case* is one user question paired with what a good answer looks like.
A *dataset* is a named collection of cases run as a single suite.

Design choices:
- Plain JSON on disk so non-engineers can extend datasets by editing a file.
- ``expected_keywords`` are *case-insensitive substrings* — generous on phrasing
  but strict on the facts that must appear (gene symbols, numeric values).
- ``forbidden_substrings`` catches obvious fabrications ("not present",
  "unavailable") when we expect the chat to actually answer.
- ``must_cite_files`` is a relative-path list checked against the assistant's
  citations.
- ``min_keyword_recall`` etc. let individual cases tighten or loosen thresholds
  beyond the dataset default — useful for hard questions that we don't expect
  to ace until P4 retrieval lands.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional


CATEGORY = (
    "single_protein",
    "module",
    "go_enrichment",
    "cell_type",
    "cross_modal",
    "summary",
    "anti_hallucination",
    "security",
)


@dataclass
class EvalCase:
    id: str
    question: str
    run_id: str
    category: str                                  # one of CATEGORY
    expected_keywords: list[str] = field(default_factory=list)
    forbidden_substrings: list[str] = field(default_factory=list)
    must_cite_files: list[str] = field(default_factory=list)
    min_keyword_recall: float = 0.5                # how many keywords must hit (fraction)
    notes: str = ""
    tags: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.category not in CATEGORY:
            raise ValueError(
                f"Unknown category {self.category!r} — must be one of {CATEGORY}"
            )
        if not 0.0 <= self.min_keyword_recall <= 1.0:
            raise ValueError("min_keyword_recall must be in [0.0, 1.0]")


@dataclass
class EvalDataset:
    name: str
    description: str
    cases: list[EvalCase]

    def __len__(self) -> int:
        return len(self.cases)

    def by_category(self, category: str) -> list[EvalCase]:
        return [c for c in self.cases if c.category == category]

    def filter(self, *, tags: Optional[list[str]] = None, ids: Optional[list[str]] = None) -> "EvalDataset":
        cases = self.cases
        if ids:
            ids_set = set(ids)
            cases = [c for c in cases if c.id in ids_set]
        if tags:
            tags_set = set(tags)
            cases = [c for c in cases if tags_set.intersection(c.tags)]
        return EvalDataset(name=self.name, description=self.description, cases=cases)


# ---------------------------------------------------------------------------
# JSON load / save
# ---------------------------------------------------------------------------

def load_dataset(path: str | Path) -> EvalDataset:
    path = Path(path)
    raw = json.loads(path.read_text())
    if "cases" not in raw:
        raise ValueError(f"{path} missing 'cases' field")
    cases = [EvalCase(**c) for c in raw["cases"]]
    return EvalDataset(
        name=raw.get("name", path.stem),
        description=raw.get("description", ""),
        cases=cases,
    )


def save_dataset(dataset: EvalDataset, path: str | Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "name": dataset.name,
        "description": dataset.description,
        "cases": [asdict(c) for c in dataset.cases],
    }
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

def datasets_dir() -> Path:
    return Path(__file__).parent / "datasets"


def list_dataset_files() -> list[Path]:
    d = datasets_dir()
    if not d.exists():
        return []
    return sorted(p for p in d.iterdir() if p.suffix == ".json")
