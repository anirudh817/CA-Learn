"""Attachment text/preview extractors and MIME helpers.

For each supported file type we produce a short-ish text block to inject into
the provider context. Tables get rendered as markdown so the model can quote
specific rows. Images are passed through to the provider as vision-input
parts elsewhere (see context_builder.render_attachments).

All extractors are tolerant: on parse failure they return a short marker
string explaining what went wrong. Never raise — a bad PDF should NOT take
down a chat turn.
"""
from __future__ import annotations

import csv
import io
import logging
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# MIME catalog
# ---------------------------------------------------------------------------

IMAGE_MIMES = {"image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

TEXTLIKE_EXTS = {".csv", ".tsv", ".txt", ".md", ".json"}
PDF_EXTS = {".pdf"}
XLSX_EXTS = {".xlsx"}

ALLOWED_EXTS = TEXTLIKE_EXTS | PDF_EXTS | XLSX_EXTS | IMAGE_EXTS

EXT_TO_MIME = {
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}


def guess_mime(filename: str, fallback: str = "application/octet-stream") -> str:
    suffix = Path(filename or "").suffix.lower()
    return EXT_TO_MIME.get(suffix, fallback)


def is_image(mime_or_filename: str) -> bool:
    s = (mime_or_filename or "").lower()
    if s in IMAGE_MIMES:
        return True
    return Path(s).suffix in IMAGE_EXTS


def is_textlike(mime_or_filename: str) -> bool:
    s = (mime_or_filename or "").lower()
    ext = Path(s).suffix
    return ext in TEXTLIKE_EXTS or s.startswith("text/")


def is_pdf(filename_or_mime: str) -> bool:
    s = (filename_or_mime or "").lower()
    return s.endswith(".pdf") or s == "application/pdf"


def is_xlsx(filename_or_mime: str) -> bool:
    s = (filename_or_mime or "").lower()
    return s.endswith(".xlsx") or "openxmlformats" in s


# ---------------------------------------------------------------------------
# Extractors
# ---------------------------------------------------------------------------

MAX_PREVIEW_CHARS = 20_000
MAX_TABULAR_ROWS = 200


def extract_pdf_text(path: Path, max_chars: int = MAX_PREVIEW_CHARS) -> str:
    """Best-effort PDF → text via pypdf. Truncates to `max_chars`."""
    try:
        from pypdf import PdfReader
    except ImportError:
        return "[pypdf not installed; PDF extraction unavailable]"

    try:
        reader = PdfReader(str(path))
        pieces: list[str] = []
        used = 0
        for page in reader.pages:
            chunk = page.extract_text() or ""
            if not chunk:
                continue
            pieces.append(chunk)
            used += len(chunk)
            if used >= max_chars:
                break
        text = "\n\n".join(pieces).strip()
        if not text:
            return "[PDF contained no extractable text (likely a scanned image; OCR not run)]"
        if len(text) > max_chars:
            text = text[:max_chars].rstrip() + "\n\n[…truncated]"
        text += (
            "\n\n[PDF extraction is best-effort; tables in multi-column "
            "scientific layouts may be garbled.]"
        )
        return text
    except Exception as exc:  # pragma: no cover
        log.warning("PDF extract failed for %s: %s", path, exc)
        return f"[PDF extraction failed: {exc}]"


def extract_xlsx_text(path: Path, max_rows: int = 2000, max_cols: int = 30) -> str:
    """Best-effort XLSX → TSV-formatted text via openpyxl."""
    try:
        from openpyxl import load_workbook
    except ImportError:
        return "[openpyxl not installed; XLSX extraction unavailable]"

    try:
        wb = load_workbook(filename=str(path), read_only=True, data_only=True)
    except Exception as exc:  # pragma: no cover
        return f"[XLSX could not be opened: {exc}]"

    pieces: list[str] = []
    try:
        for sheet_name in wb.sheetnames[:5]:  # cap at 5 sheets
            ws = wb[sheet_name]
            pieces.append(f"## Sheet: {sheet_name}")
            row_lines: list[str] = []
            for r_idx, row in enumerate(ws.iter_rows(values_only=True)):
                if r_idx >= max_rows:
                    row_lines.append(f"[…truncated at {max_rows} rows]")
                    break
                cells = ["" if v is None else str(v) for v in row[:max_cols]]
                row_lines.append("\t".join(cells))
            pieces.append("\n".join(row_lines))
        text = "\n\n".join(pieces).strip()
        if not text:
            return "[XLSX appears empty]"
        return text
    finally:
        try:
            wb.close()
        except Exception:
            pass


def extract_tabular_preview(path: Path, max_rows: int = MAX_TABULAR_ROWS) -> str:
    """Read first N rows of CSV/TSV and format as a compact markdown table.

    Uses an in-package markdown renderer (no `tabulate` dep). If pandas
    can't parse the file at all we fall back to a raw text head so the
    user at least sees the content.
    """
    from .context_builder import dataframe_to_markdown  # local import: avoid cycle

    ext = path.suffix.lower()
    sep = "\t" if ext == ".tsv" else ","
    try:
        import pandas as pd

        df = pd.read_csv(path, sep=sep, nrows=max_rows, low_memory=False)
    except Exception as exc:
        try:
            with path.open("r", errors="replace") as fh:
                head = "".join(fh.readlines()[:max_rows])
            return f"[Tabular parse failed: {exc}]\n\n```\n{head}\n```"
        except Exception:
            return f"[Could not read tabular file: {exc}]"
    md = dataframe_to_markdown(df)
    return md if md else "[empty]"


def extract_text_file(path: Path, max_chars: int = MAX_PREVIEW_CHARS) -> str:
    try:
        text = path.read_text(errors="replace")
    except Exception as exc:
        return f"[Could not read text file: {exc}]"
    if len(text) > max_chars:
        text = text[:max_chars].rstrip() + "\n\n[…truncated]"
    return text


def extract_preview(path: Path, filename: Optional[str] = None) -> str:
    """Single entry point — pick the right extractor by file extension."""
    name = filename or path.name
    suffix = Path(name).suffix.lower()
    if suffix in PDF_EXTS:
        return extract_pdf_text(path)
    if suffix in XLSX_EXTS:
        return extract_xlsx_text(path)
    if suffix in {".csv", ".tsv"}:
        return extract_tabular_preview(path)
    if suffix in {".txt", ".md", ".json"}:
        return extract_text_file(path)
    if suffix in IMAGE_EXTS:
        return ""  # Images don't get text previews; they're passed as vision input.
    return f"[Unsupported file type {suffix!r} — extension not in extractor whitelist]"
