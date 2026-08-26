from __future__ import annotations

import importlib.util
import sys
from functools import lru_cache
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
BACKEND_DIR = PROJECT_ROOT / "backend"
BACKEND_MAIN = BACKEND_DIR / "main.py"


@lru_cache(maxsize=1)
def load_backend_module():
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))

    spec = importlib.util.spec_from_file_location("proteomicsai_backend_main", BACKEND_MAIN)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load backend application from {BACKEND_MAIN}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def create_app():
    module = load_backend_module()
    if hasattr(module, "create_app"):
        return module.create_app()
    return module.app
