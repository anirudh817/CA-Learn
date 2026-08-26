from __future__ import annotations

import hashlib
import json
import mimetypes
import re
import secrets
from pathlib import Path

BLOCKED_CLIENT_FILE_EXTENSIONS = {".rdata", ".rds", ".rda"}
MANIFEST_VIEWABLE_EXTENSIONS = {".html", ".htm", ".pdf", ".csv", ".tsv", ".txt", ".json", ".xlsx", ".md"}
SUPPORTING_ASSET_EXTENSIONS = {".js", ".css", ".map", ".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp"}


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or f"item-{secrets.token_hex(2)}"


def fingerprint_json(value: dict) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_hidden_path(value: str | Path) -> bool:
    path = Path(str(value))
    return any(part.startswith(".") for part in path.parts)


def is_blocked_client_file(value: str | Path) -> bool:
    path = Path(str(value))
    return path.suffix.lower() in BLOCKED_CLIENT_FILE_EXTENSIONS


def should_index_run_file(value: str | Path) -> bool:
    return not is_hidden_path(value) and not is_blocked_client_file(value)


def should_list_client_file(value: str | Path) -> bool:
    return should_index_run_file(value)


def is_manifest_viewable_file(value: str | Path) -> bool:
    path = Path(str(value))
    return should_list_client_file(path) and path.suffix.lower() in MANIFEST_VIEWABLE_EXTENSIONS


def is_supporting_asset_file(value: str | Path) -> bool:
    path = Path(str(value))
    return not is_hidden_path(path) and path.suffix.lower() in SUPPORTING_ASSET_EXTENSIONS


def guess_media_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".html", ".htm"}:
        return "text/html; charset=utf-8"
    if suffix == ".css":
        return "text/css; charset=utf-8"
    if suffix == ".js":
        return "application/javascript; charset=utf-8"
    if suffix == ".json":
        return "application/json"
    if suffix in {".txt", ".log", ".md"}:
        return "text/plain; charset=utf-8"
    if suffix == ".csv":
        return "text/csv; charset=utf-8"
    if suffix == ".tsv":
        return "text/tab-separated-values; charset=utf-8"
    if suffix == ".pdf":
        return "application/pdf"
    if suffix == ".xlsx":
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    media_type, _ = mimetypes.guess_type(str(path))
    return media_type or "application/octet-stream"


def resolve_relative_path(base_dir: Path, relative_path: str) -> Path:
    root = base_dir.resolve()
    candidate = (root / relative_path).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError("Unsafe path")
    return candidate
