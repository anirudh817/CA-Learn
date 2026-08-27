from __future__ import annotations

import io
import json
import shutil
import zipfile
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from openpyxl import Workbook
from sqlalchemy.orm import Session

from config import APP_VERSION, EXPORTS_DIR, INLINE_RUNS, RUNS_DIR
from database import Run, RunFile, RunStageStatus, RunStatus, UploadedDataset, User, get_db
from deps import get_current_user, require_workspace_access
from schemas import CreateRunRequest
from services.audit_service import record_audit
from services.pipeline import run_full_pipeline, start_pipeline_thread
from utils import fingerprint_json, is_manifest_viewable_file, resolve_relative_path, should_list_client_file

router = APIRouter()


def _make_run_id() -> str:
    import random
    import string

    date = datetime.utcnow().strftime("%Y%m%d")
    suffix = "".join(random.choices(string.hexdigits[:16].upper(), k=4))
    return f"RUN-{date}-{suffix}"


def _status_value(value):
    return value.value if hasattr(value, "value") else value


def _metrics_payload(run: Run) -> dict:
    try:
        return json.loads(run.metrics_json or "{}")
    except Exception:
        return {}


def _scan_visible_run_files(run_id: str) -> list[dict]:
    run_dir = RUNS_DIR / run_id
    if not run_dir.exists():
        return []

    visible = []
    for path in sorted(run_dir.rglob("*")):
        if not path.is_file():
            continue
        rel_path = str(path.relative_to(run_dir))
        if not is_manifest_viewable_file(rel_path):
            continue
        rel_parts = rel_path.split("/", 1)
        stage = rel_parts[0] if len(rel_parts) > 1 else "meta"
        visible.append(
            {
                "stage": stage,
                "filename": path.name,
                "rel_path": rel_path,
                "size_bytes": path.stat().st_size,
            }
        )
    return visible


def _create_stage_rows(db: Session, run_id: str) -> None:
    for stage_key in (
        "etl",
        "processing_sample_alignment",
        "outlier_removal",
        "normalization",
        "variance_batch_correction",
        "differential_expression",
        "wgcna_network",
        "goparallel",
        "celltypefet",
        "deliverable_packaging",
    ):
        db.add(RunStageStatus(run_id=run_id, stage_key=stage_key))
    db.commit()


@router.post("/runs")
def create_run(
    req: CreateRunRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_workspace_access(db, current_user.id, req.workspace_id)
    dataset = db.query(UploadedDataset).filter(UploadedDataset.id == req.dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    traits_dataset = None
    if req.traits_dataset_id:
        traits_dataset = db.query(UploadedDataset).filter(UploadedDataset.id == req.traits_dataset_id).first()
        if not traits_dataset:
            raise HTTPException(status_code=404, detail="Traits dataset not found")

    # Block run creation for datasets the format detector flagged as not ready to analyse.
    try:
        _sniff = json.loads(dataset.sniff_metadata_json or "{}")
    except Exception:
        _sniff = {}
    if _sniff.get("run_ready") is False:
        _fmt = _sniff.get("format_detected", dataset.format_family or "Unknown")
        _warn = (_sniff.get("warnings") or ["This format is not supported for analysis."])[0]
        raise HTTPException(
            status_code=422,
            detail=f"Dataset format '{_fmt}' cannot be used for analysis. {_warn}",
        )

    params_dict = req.params.model_dump() if hasattr(req.params, "model_dump") else req.params.dict()
    params_dict["cohort1"] = req.cohort1
    params_dict["cohort2"] = req.cohort2
    params_dict["file_path"] = dataset.stored_path
    params_dict["format_family"] = dataset.format_family
    params_dict["input_level"] = dataset.assay_level
    # Carry a user-supplied manual column mapping (from the picker/mapping UI)
    # into pipeline params so the vendor normalizer can honor it during ETL.
    if _sniff.get("column_map"):
        params_dict["column_map"] = _sniff["column_map"]
    if traits_dataset:
        params_dict["traits_file_path"] = traits_dataset.stored_path
    params_dict["app_version"] = APP_VERSION
    param_fingerprint = fingerprint_json(params_dict)

    duplicate = db.query(Run).filter(
        Run.workspace_id == req.workspace_id,
        Run.dataset_hash == dataset.dataset_hash,
        Run.param_fingerprint == param_fingerprint,
    ).order_by(Run.created_at.desc()).first()
    if duplicate:
        return {
            "run_id": duplicate.id,
            "name": duplicate.name,
            "status": _status_value(duplicate.status),
            "duplicate": True,
            "message": "Matching run already exists",
        }

    run_id = _make_run_id()
    run = Run(
        id=run_id,
        workspace_id=req.workspace_id,
        project_id=req.project_id,
        created_by=current_user.id,
        name=req.name,
        file_id=dataset.id,
        file_name=dataset.original_name,
        traits_file_id=traits_dataset.id if traits_dataset else None,
        source_run_id=req.source_run_id,
        status=RunStatus.QUEUED,
        params=json.dumps(params_dict),
        dataset_hash=dataset.dataset_hash,
        param_fingerprint=param_fingerprint,
        analysis_format=dataset.format_family,
        input_level=dataset.assay_level,
        metrics_json=json.dumps({}),
        app_version=APP_VERSION,
    )
    db.add(run)
    db.commit()
    _create_stage_rows(db, run_id)
    record_audit(
        db,
        "run.created",
        user_id=current_user.id,
        workspace_id=req.workspace_id,
        project_id=req.project_id,
        run_id=run_id,
        details={"dataset_id": dataset.id, "format": dataset.format_family},
    )

    if INLINE_RUNS:
        run_full_pipeline(run_id)
        db.expire_all()
        run = db.query(Run).filter(Run.id == run_id).first()
    else:
        start_pipeline_thread(run_id)

    return {
        "run_id": run_id,
        "name": run.name,
        "status": _status_value(run.status),
        "file_name": run.file_name,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "duplicate": False,
    }


@router.get("/runs")
def list_runs(
    workspace_id: str,
    project_id: Optional[str] = None,
    include_trashed: bool = False,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_workspace_access(db, current_user.id, workspace_id)
    query = db.query(Run).filter(Run.workspace_id == workspace_id)
    if project_id:
        query = query.filter(Run.project_id == project_id)
    if not include_trashed:
        query = query.filter(Run.status != RunStatus.TRASHED)
    else:
        query = query.filter(Run.status == RunStatus.TRASHED)
    runs = query.order_by(Run.created_at.desc()).all()
    result = []
    for run in runs:
        try:
            params = json.loads(run.params or "{}")
        except Exception:
            params = {}
        result.append(
            {
                "id": run.id,
                "name": run.name,
                "file_name": run.file_name,
                "status": _status_value(run.status),
                "created_at": run.created_at.isoformat() if run.created_at else None,
                "completed_at": run.completed_at.isoformat() if run.completed_at else None,
                "modules_count": run.modules_count,
                "sig_peptides": run.sig_peptides,
                "up_peptides": run.up_peptides,
                "down_peptides": run.down_peptides,
                "go_terms": run.go_terms,
                "params": params,
                "error_message": run.error_message,
                "analysis_format": run.analysis_format,
                "input_level": run.input_level,
                "trashed_at": run.trashed_at.isoformat() if run.trashed_at else None,
                "pipeline_profile": _metrics_payload(run).get("pipeline_profile"),
                "deliverable_variant": _metrics_payload(run).get("deliverable_variant"),
                "app_version": run.app_version or "",
            }
        )
    return result


@router.get("/runs/{run_id}")
def get_run(run_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    run = db.query(Run).filter(Run.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    require_workspace_access(db, current_user.id, run.workspace_id)
    files = db.query(RunFile).filter(RunFile.run_id == run_id).order_by(RunFile.stage, RunFile.rel_path).all()
    stages = db.query(RunStageStatus).filter(RunStageStatus.run_id == run_id).order_by(RunStageStatus.id).all()
    return {
        "id": run.id,
        "workspace_id": run.workspace_id,
        "project_id": run.project_id,
        "name": run.name,
        "file_name": run.file_name,
        "status": _status_value(run.status),
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "completed_at": run.completed_at.isoformat() if run.completed_at else None,
        "modules_count": run.modules_count,
        "sig_peptides": run.sig_peptides,
        "up_peptides": run.up_peptides,
        "down_peptides": run.down_peptides,
        "go_terms": run.go_terms,
        "params": json.loads(run.params or "{}"),
        "error_message": run.error_message,
        "analysis_format": run.analysis_format,
        "input_level": run.input_level,
        "trashed_at": run.trashed_at.isoformat() if run.trashed_at else None,
        "pipeline_profile": _metrics_payload(run).get("pipeline_profile"),
        "deliverable_variant": _metrics_payload(run).get("deliverable_variant"),
        "app_version": run.app_version or "",
        "supported_steps": _metrics_payload(run).get("supported_steps", []),
        "supported_tabs": _metrics_payload(run).get("supported_tabs", []),
        "files": [
            {"stage": file.stage, "filename": file.filename, "rel_path": file.rel_path, "size_bytes": file.size_bytes}
            for file in files
            if should_list_client_file(file.rel_path)
        ],
        "stages": [
            {
                "stage_key": stage.stage_key,
                "status": _status_value(stage.status),
                "progress": stage.progress,
                "message": stage.message,
                "started_at": stage.started_at.isoformat() if stage.started_at else None,
                "completed_at": stage.completed_at.isoformat() if stage.completed_at else None,
            }
            for stage in stages
        ],
    }


@router.get("/runs/{run_id}/events")
async def stream_run_events(run_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    run = db.query(Run).filter(Run.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    require_workspace_access(db, current_user.id, run.workspace_id)

    from database import SessionLocal

    async def event_generator():
        import asyncio

        last_pos = 0
        last_stage_snapshot = ""
        sent_outlier_review = False
        while True:
            poll_db = SessionLocal()
            try:
                current = poll_db.query(Run).filter(Run.id == run_id).first()
                if not current:
                    yield "data: {\"type\":\"error\",\"message\":\"Run not found\"}\n\n"
                    break
                log = current.log or ""
                if len(log) > last_pos:
                    new_text = log[last_pos:]
                    for line in new_text.splitlines():
                        if line.strip():
                            payload = json.dumps({"type": "log", "line": line, "status": _status_value(current.status)})
                            yield f"data: {payload}\n\n"
                    last_pos = len(log)
                stages = (
                    poll_db.query(RunStageStatus)
                    .filter(RunStageStatus.run_id == run_id)
                    .order_by(RunStageStatus.id)
                    .all()
                )
                stage_payload = [
                    {
                        "stage_key": stage.stage_key,
                        "status": _status_value(stage.status),
                        "progress": stage.progress,
                        "message": stage.message,
                        "started_at": stage.started_at.isoformat() if stage.started_at else None,
                        "completed_at": stage.completed_at.isoformat() if stage.completed_at else None,
                    }
                    for stage in stages
                ]
                snapshot = json.dumps(stage_payload, sort_keys=True)
                if snapshot != last_stage_snapshot:
                    payload = json.dumps({"type": "stage", "status": _status_value(current.status), "stages": stage_payload})
                    yield f"data: {payload}\n\n"
                    last_stage_snapshot = snapshot
                if current.status == RunStatus.AWAITING_REVIEW and not sent_outlier_review:
                    metrics = json.loads(current.metrics_json or "{}")
                    candidates = metrics.get("outlier_candidates", [])
                    payload = json.dumps({"type": "outlier_review", "candidates": candidates})
                    yield f"data: {payload}\n\n"
                    sent_outlier_review = True
                if current.status in (RunStatus.COMPLETE, RunStatus.FAILED):
                    payload = json.dumps({"type": "done", "status": _status_value(current.status)})
                    yield f"data: {payload}\n\n"
                    break
            finally:
                poll_db.close()
            await asyncio.sleep(0.5)

    return StreamingResponse(event_generator(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/runs/{run_id}/logs")
async def stream_logs_alias(run_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return await stream_run_events(run_id, current_user=current_user, db=db)


@router.get("/runs/{run_id}/files")
def list_run_files(run_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    run = db.query(Run).filter(Run.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    require_workspace_access(db, current_user.id, run.workspace_id)
    return _scan_visible_run_files(run_id)


@router.post("/runs/{run_id}/trash")
def trash_run(run_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    run = db.query(Run).filter(Run.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    require_workspace_access(db, current_user.id, run.workspace_id)
    run.status = RunStatus.TRASHED
    run.trashed_at = datetime.utcnow()
    db.commit()
    record_audit(
        db,
        "run.trashed",
        user_id=current_user.id,
        workspace_id=run.workspace_id,
        project_id=run.project_id,
        run_id=run.id,
        details={"run_id": run.id},
    )
    return {"id": run.id, "status": _status_value(run.status), "trashed_at": run.trashed_at.isoformat()}


@router.post("/runs/{run_id}/restore")
def restore_run(run_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    run = db.query(Run).filter(Run.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    require_workspace_access(db, current_user.id, run.workspace_id)
    if run.status != RunStatus.TRASHED:
        raise HTTPException(status_code=400, detail="Run is not in trash")
    if run.error_message:
        run.status = RunStatus.FAILED
    elif run.completed_at:
        run.status = RunStatus.COMPLETE
    else:
        run.status = RunStatus.ARCHIVED
    run.trashed_at = None
    db.commit()
    record_audit(
        db,
        "run.restored",
        user_id=current_user.id,
        workspace_id=run.workspace_id,
        project_id=run.project_id,
        run_id=run.id,
        details={"run_id": run.id},
    )
    return {"id": run.id, "status": _status_value(run.status)}


@router.post("/runs/{run_id}/purge")
def purge_run(run_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    run = db.query(Run).filter(Run.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    require_workspace_access(db, current_user.id, run.workspace_id)
    if run.status != RunStatus.TRASHED:
        raise HTTPException(status_code=400, detail="Move the run to trash before permanent deletion")

    record_audit(
        db,
        "run.purged",
        user_id=current_user.id,
        workspace_id=run.workspace_id,
        project_id=run.project_id,
        run_id=run.id,
        details={"run_id": run.id},
    )
    db.query(RunFile).filter(RunFile.run_id == run_id).delete()
    db.query(RunStageStatus).filter(RunStageStatus.run_id == run_id).delete()
    db.delete(run)
    db.commit()

    run_dir = RUNS_DIR / run_id
    if run_dir.exists():
        shutil.rmtree(run_dir, ignore_errors=True)
    export_dir = EXPORTS_DIR / run_id
    if export_dir.exists():
        shutil.rmtree(export_dir, ignore_errors=True)
    return {"id": run_id, "purged": True}


@router.get("/runs/{run_id}/files/{file_path:path}")
def download_run_file(run_id: str, file_path: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    run = db.query(Run).filter(Run.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    require_workspace_access(db, current_user.id, run.workspace_id)
    if not is_manifest_viewable_file(file_path):
        raise HTTPException(status_code=404, detail="File not available")
    try:
        full_path = resolve_relative_path(RUNS_DIR / run_id, file_path)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    if not full_path.exists() or not full_path.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    return FileResponse(path=str(full_path), filename=full_path.name, media_type="application/octet-stream")


@router.get("/runs/{run_id}/export/zip")
def export_run_zip(run_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    run = db.query(Run).filter(Run.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    require_workspace_access(db, current_user.id, run.workspace_id)
    archive_path = EXPORTS_DIR / f"{run_id}.zip"
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted((RUNS_DIR / run_id).rglob("*")):
            if path.is_file():
                rel_path = str(path.relative_to(RUNS_DIR / run_id))
                if not should_list_client_file(rel_path):
                    continue
                archive.write(path, arcname=str(path.relative_to(RUNS_DIR / run_id)))
    return FileResponse(str(archive_path), filename=archive_path.name, media_type="application/zip")


@router.get("/runs/{run_id}/export/xlsx")
def export_run_workbook(run_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    import pandas as pd

    run = db.query(Run).filter(Run.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    require_workspace_access(db, current_user.id, run.workspace_id)
    workbook = Workbook()
    workbook.remove(workbook.active)
    sheets = [
        ("DEP", RUNS_DIR / run_id / "stage1" / "volcano_results.tsv", "\t"),
        ("Modules", RUNS_DIR / run_id / "stage1" / "module_assignments.csv", ","),
        ("GO", RUNS_DIR / run_id / "stage2" / "go_enrichment_all.csv", ","),
        ("CellTypes", RUNS_DIR / run_id / "stage3" / "celltype_heatmap_data.csv", ","),
    ]
    for name, path, sep in sheets:
        if not path.exists():
            continue
        sheet = workbook.create_sheet(name)
        frame = pd.read_csv(path, sep=sep)
        sheet.append(list(frame.columns))
        for row in frame.itertuples(index=False):
            sheet.append(list(row))
    export_path = EXPORTS_DIR / f"{run_id}.xlsx"
    workbook.save(export_path)
    return FileResponse(str(export_path), filename=export_path.name, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@router.get("/runs/{run_id}/export/summary.md")
def export_run_summary_markdown(run_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    run = db.query(Run).filter(Run.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    require_workspace_access(db, current_user.id, run.workspace_id)
    summary_path = RUNS_DIR / run_id / "run_manifest.json"
    if not summary_path.exists():
        raise HTTPException(status_code=404, detail="Run manifest not available")
    payload = json.loads(summary_path.read_text())
    markdown = "\n".join(
        [
            f"# {payload.get('name', run.name)}",
            "",
            f"- Run ID: `{run_id}`",
            f"- Status: `{_status_value(run.status)}`",
            f"- Completed: `{run.completed_at.isoformat() if run.completed_at else 'pending'}`",
            f"- Format: `{run.analysis_format}`",
            "",
            "## Parameters",
            "",
            "```json",
            json.dumps(json.loads(run.params or "{}"), indent=2, sort_keys=True),
            "```",
            "",
        ]
    )
    return Response(markdown, media_type="text/markdown")


@router.post("/runs/{run_id}/review-outliers")
def review_outliers(
    run_id: str,
    body: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    run = db.query(Run).filter(Run.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    require_workspace_access(db, current_user.id, run.workspace_id)
    if run.status != RunStatus.AWAITING_REVIEW:
        raise HTTPException(status_code=400, detail="Run is not awaiting outlier review")

    action = body.get("action", "skip")
    excluded_samples = body.get("excluded_samples", [])

    existing_params = json.loads(run.params or "{}")
    existing_params["outlier_action"] = action
    existing_params["excluded_samples"] = excluded_samples if action == "proceed" else []
    run.params = json.dumps(existing_params)

    if action == "cancel":
        run.status = RunStatus.FAILED
        run.error_message = "Cancelled by user at outlier review"
        run.completed_at = datetime.utcnow()
    else:
        run.status = RunStatus.RUNNING

    db.commit()

    from services.pipeline import _OUTLIER_EVENTS
    event = _OUTLIER_EVENTS.pop(run_id, None)
    if event:
        event.set()

    return {"status": "ok", "action": action, "excluded_samples": existing_params["excluded_samples"]}
