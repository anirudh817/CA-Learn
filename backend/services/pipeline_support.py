from __future__ import annotations

from datetime import datetime
from pathlib import Path

from utils import should_index_run_file


def ts() -> str:
    return datetime.now().strftime("%H:%M:%S")


def append_log(db, run_id: str, line: str) -> None:
    """Atomic log append using SQL concatenation to avoid read/modify/write races."""
    from sqlalchemy import text

    try:
        db.execute(
            text("UPDATE runs SET log = COALESCE(log, '') || :new_line WHERE id = :run_id"),
            {"new_line": line + "\n", "run_id": run_id},
        )
        db.commit()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass


def index_files(db, run_id: str, stage: str, directory: Path) -> None:
    """Walk an output directory and register visible files in the DB."""
    from config import RUNS_DIR
    from database import RunFile

    if not directory.exists():
        return
    for file_path in directory.rglob("*"):
        if not file_path.is_file():
            continue
        rel_path = str(file_path.relative_to(RUNS_DIR / run_id))
        if not should_index_run_file(rel_path):
            continue
        existing = db.query(RunFile).filter(
            RunFile.run_id == run_id,
            RunFile.rel_path == rel_path,
        ).first()
        if existing:
            continue
        db.add(
            RunFile(
                run_id=run_id,
                stage=stage,
                filename=file_path.name,
                rel_path=rel_path,
                size_bytes=file_path.stat().st_size,
            )
        )
    db.commit()


def set_stage_status(db, run_id: str, stage_key: str, status: str, progress: int, message: str | None = None) -> None:
    from database import RunStageStatus

    stage = db.query(RunStageStatus).filter(
        RunStageStatus.run_id == run_id,
        RunStageStatus.stage_key == stage_key,
    ).first()
    if not stage:
        return
    stage.status = status
    stage.progress = progress
    if message is not None:
        stage.message = message
    if status == "running" and not stage.started_at:
        stage.started_at = datetime.utcnow()
    if status in {"complete", "failed", "skipped"}:
        stage.completed_at = datetime.utcnow()
    db.commit()
