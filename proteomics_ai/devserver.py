from __future__ import annotations

import os
import shutil
import socket

import uvicorn

from app_loader import create_app

DEFAULT_PORT = 8000


def port_is_available(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return sock.connect_ex((host, port)) != 0


def resolve_port(host: str = "127.0.0.1", default_port: int = DEFAULT_PORT) -> int:
    """Resolve the port to bind: ``$PORT`` if set, otherwise ``default_port`` (8000).

    Strict by design. We previously scanned upward for the next free port, which
    silently drifted to 8001+ whenever 8000 was busy (e.g. the Docker stack).
    That produced two indistinguishable app instances and confusing
    "works on one, fails on the other" bugs. Now we bind one predictable port and
    fail loudly if it is taken. To run a second instance, pick a port explicitly:
    ``PORT=8002 ./run.sh``.
    """
    raw = os.environ.get("PORT", str(default_port))
    try:
        port = int(raw)
    except ValueError:
        raise SystemExit(f"ERROR: PORT must be an integer, got {raw!r}.")

    if not port_is_available(host, port):
        raise SystemExit(
            f"ERROR: port {port} on {host} is already in use.\n"
            f"  Something is already serving there — likely a previous dev server or\n"
            f"  the Docker stack (check: docker compose ps / lsof -iTCP:{port} -sTCP:LISTEN).\n"
            f"  Stop it first, or run on a different port explicitly:  PORT={port + 1} ./run.sh"
        )
    return port


def main() -> None:
    host = "127.0.0.1"
    port = resolve_port(host=host)
    if shutil.which("Rscript") is None:
        print(
            "WARNING: Rscript not found on PATH — this native server cannot run the\n"
            "         analysis pipeline (Stage 1 requires R and will fail). For full\n"
            "         functionality run via Docker:  docker compose up  (serves\n"
            "         http://localhost:8000 with R + all packages installed)."
        )
    app = create_app()
    print(f"ProteomicsAI starting on http://{host}:{port}")
    uvicorn.run(app, host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
