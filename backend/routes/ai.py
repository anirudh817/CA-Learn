"""Deprecated single-shot AI endpoint.

Returns HTTP 410 Gone with a migration hint pointing to the new
conversation-shaped APIs introduced in P0.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

router = APIRouter()


@router.post("/ai/query")
def ai_query_deprecated():
    raise HTTPException(
        status_code=410,
        detail={
            "message": "POST /api/ai/query has been replaced by the AI chat API.",
            "migrate_to": [
                "POST /api/runs/{run_id}/conversations",
                "POST /api/conversations/{conversation_id}/messages",
                "GET  /api/conversations/{conversation_id}",
            ],
            "settings": "PUT /api/settings/ai (paste your provider key here)",
        },
    )
