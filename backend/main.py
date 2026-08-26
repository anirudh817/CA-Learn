from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from config import APP_NAME, APP_VERSION, FRONTEND_DIR
from database import init_db
from routes.ai import router as ai_router
from routes.attachments import router as attachments_router
from routes.audit import router as audit_router
from routes.auth import router as auth_router
from routes.compare import router as compare_router
from routes.conversations import router as conversations_router
from routes.projects import router as projects_router
from routes.results import router as results_router
from routes.runs import router as runs_router
from routes.settings_ai import router as settings_ai_router
from routes.share_links import router as share_links_router
from routes.upload import router as upload_router
from routes.workspaces import router as workspaces_router


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        title=APP_NAME,
        version=APP_VERSION,
        description="Commercial proteomics analysis platform",
        lifespan=lifespan,
    )

    allowed_origins_str = os.environ.get("ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:8000")
    ALLOWED_ORIGINS = [origin.strip() for origin in allowed_origins_str.split(",") if origin.strip()]

    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health():
        return {"status": "ok", "version": APP_VERSION}

    app.include_router(auth_router, prefix="/api")
    app.include_router(workspaces_router, prefix="/api")
    app.include_router(projects_router, prefix="/api")
    app.include_router(upload_router, prefix="/api")
    app.include_router(runs_router, prefix="/api")
    app.include_router(results_router, prefix="/api")
    app.include_router(compare_router, prefix="/api")
    app.include_router(share_links_router, prefix="/api")
    app.include_router(audit_router, prefix="/api")
    app.include_router(ai_router, prefix="/api")
    app.include_router(conversations_router, prefix="/api")
    app.include_router(attachments_router, prefix="/api")
    app.include_router(settings_ai_router, prefix="/api")

    static_dir = FRONTEND_DIR / "static"
    if static_dir.exists():
        app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    @app.get("/")
    def serve_index():
        index = FRONTEND_DIR / "index.html"
        if index.exists():
            return FileResponse(str(index))
        return JSONResponse({"message": "ProteomicsAI API running. Frontend not found."})

    @app.get("/{full_path:path}")
    def spa_fallback(full_path: str):
        if full_path.startswith("api/"):
            return JSONResponse({"detail": "Not found"}, status_code=404)
        root = FRONTEND_DIR.resolve()
        target = (root / full_path).resolve()
        # Reject any path that escapes FRONTEND_DIR
        if root not in target.parents and target != root:
            return JSONResponse({"message": "ProteomicsAI API running. Frontend not found."})
        if target.exists() and target.is_file():
            return FileResponse(str(target))
        index = root / "index.html"
        if index.exists():
            return FileResponse(str(index))
        return JSONResponse({"message": "ProteomicsAI API running. Frontend not found."})

    return app


app = create_app()
