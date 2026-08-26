from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import Run, User, get_db
from deps import get_current_user, require_workspace_access
from schemas import CompareRunsRequest

router = APIRouter()


@router.post("/compare/runs")
def compare_runs(req: CompareRunsRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    left = db.query(Run).filter(Run.id == req.left_run_id).first()
    right = db.query(Run).filter(Run.id == req.right_run_id).first()
    if not left or not right:
        raise HTTPException(status_code=404, detail="Run not found")
    if left.workspace_id != right.workspace_id:
        raise HTTPException(status_code=400, detail="Runs must be in the same workspace")
    require_workspace_access(db, current_user.id, left.workspace_id)

    left_params = json.loads(left.params or "{}")
    right_params = json.loads(right.params or "{}")
    keys = sorted(set(left_params) | set(right_params))
    param_diff = []
    for key in keys:
        left_value = left_params.get(key)
        right_value = right_params.get(key)
        if left_value == right_value:
            continue
        param_diff.append({"parameter": key, "left": left_value, "right": right_value})

    return {
        "left": {
            "id": left.id,
            "name": left.name,
            "status": left.status.value if hasattr(left.status, "value") else left.status,
            "modules_count": left.modules_count,
            "sig_peptides": left.sig_peptides,
            "go_terms": left.go_terms,
        },
        "right": {
            "id": right.id,
            "name": right.name,
            "status": right.status.value if hasattr(right.status, "value") else right.status,
            "modules_count": right.modules_count,
            "sig_peptides": right.sig_peptides,
            "go_terms": right.go_terms,
        },
        "param_diff": param_diff,
        "metrics_delta": {
            "modules_count": (right.modules_count or 0) - (left.modules_count or 0),
            "sig_peptides": (right.sig_peptides or 0) - (left.sig_peptides or 0),
            "go_terms": (right.go_terms or 0) - (left.go_terms or 0),
        },
    }
