#!/usr/bin/env bash
#
# run.sh — launch & manage the SignalFold (ProteomicsAI) services locally.
#
# Local SignalFold is TWO independent processes:
#   • Main app    — FastAPI monolith (REST /api/* + vanilla-JS SPA) on :8000
#   • AI Insights — standalone Node "Pi sidecar" on :4317
#
# They are separate servers. The main app's "Open AI Insights" button just
# points a browser at :4317 — it does NOT start the sidecar. So AI Insights
# only works when the sidecar is ALSO running. This script manages both, plus a
# `status` view so you can see at a glance what is up.
#
# The main dev server binds :8000 and FAILS LOUDLY if it is already in use
# (e.g. the Docker stack) rather than drifting. Override with PORT=<n>.
#
# Usage — consistent "verb [scope]" grammar (scope = all | app | ai; default all):
#   ./run.sh start [all|app|ai] [fg]    # start (background; add fg for one service)
#   ./run.sh stop  [all|app|ai]         # stop
#   ./run.sh restart [all|app|ai] [fg]  # stop then start (the helper)
#   ./run.sh status                     # show what is up on :8000 and :4317
#
# Shorthands (unchanged, kept for muscle memory and existing docs):
#   ./run.sh             # main app, foreground (Ctrl-C to stop)
#   ./run.sh bg          # main app, background  -> server.log
#   ./run.sh ai [bg|stop]# AI Insights sidecar (foreground by default)
#   ./run.sh all         # both, background  (same as: start all)
#   PORT=8002 ./run.sh   # main app on an explicit port
#
set -euo pipefail

cd "$(dirname "$0")"

VENV_PY=".venv/bin/python"
MAIN_PID_FILE=".server.pid"
MAIN_LOG_FILE="server.log"
MAIN_PORT="${PORT:-8000}"

SIDECAR_DIR="ai-sidecar"
SIDECAR_PID_FILE="ai-sidecar/.ai-sidecar.pid"
SIDECAR_LOG_FILE="ai-sidecar/ai-sidecar.log"
SIDECAR_PORT="${PI_RUNTIME_PORT:-4317}"

# Verbose, timestamped progress line so each step is visible (and labeled, since
# this script delegates the free-form jail steps to the sidecar's own run.sh).
say() { printf '[run %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

usage() {
  cat >&2 <<'EOF'
Usage — verb [scope]   (scope = all | app | ai; default: all)
  ./run.sh start [all|app|ai] [fg]    start (background; add fg for a single service)
  ./run.sh stop  [all|app|ai]         stop
  ./run.sh restart [all|app|ai] [fg]  stop then start
  ./run.sh status                     show what is up on :8000 and :4317

Shorthands (kept for muscle memory):
  ./run.sh             main app, foreground (:8000)
  ./run.sh bg          main app, background  -> server.log
  ./run.sh ai [bg|stop] AI Insights sidecar  (foreground by default, :4317)
  ./run.sh all         both, background  (= start all)

Starting the sidecar (start ai / start all) auto-builds the free-form research
Docker jail image if it is missing; stopping it also removes leftover jail
containers. Manage the image directly with: ai-sidecar/run.sh jail-build.
EOF
}

# ---- helpers ---------------------------------------------------------------

is_listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# Wait briefly for a port's socket to free after a stop, so restart's start step
# does not trip the "port already held" guard on the process it just killed.
wait_port_free() { local p="$1" _; for _ in $(seq 1 20); do is_listening "$p" || return 0; sleep 0.25; done; }

# After a stop, a still-held port belongs to a process run.sh did not start (a
# manual/preview launch, the Docker stack, …). Say so rather than kill something
# we do not own.
warn_if_held() { if is_listening "$2"; then say "note: :$2 still held by $(listener_desc "$2") — not managed by run.sh; leaving it."; fi; }

# one-line "command (PID n)" for whoever holds the port, or empty
listener_desc() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" (PID "$2")"; exit}' || true
}

# echo the PID stored in $1 only if that process is still alive
live_pid() {
  local f="$1" pid
  [[ -f "$f" ]] || return 0
  pid="$(cat "$f" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && echo "$pid" || true
}

stop_pidfile() {
  local label="$1" f="$2" pid
  pid="$(live_pid "$f")"
  if [[ -n "$pid" ]]; then
    kill "$pid" && echo "Stopped $label (PID $pid)."
  else
    echo "No backgrounded $label to stop."
  fi
  rm -f "$f"
}

# ---- main app --------------------------------------------------------------

require_venv() {
  if [[ ! -x "$VENV_PY" ]]; then
    echo "error: $VENV_PY not found. Create the env first:" >&2
    echo "  uv venv --python 3.12 && uv pip install -r backend/requirements.txt" >&2
    exit 1
  fi
}

start_main_fg() {
  require_venv
  exec "$VENV_PY" -m proteomics_ai.devserver
}

start_main_bg() {
  require_venv
  if is_listening "$MAIN_PORT"; then
    echo "Main app: port :$MAIN_PORT already held by $(listener_desc "$MAIN_PORT") — not starting another." >&2
    return 1
  fi
  nohup "$VENV_PY" -m proteomics_ai.devserver >"$MAIN_LOG_FILE" 2>&1 &
  local pid=$! _
  echo "$pid" >"$MAIN_PID_FILE"
  echo "Starting main app in background (PID $pid). Logs -> $MAIN_LOG_FILE"
  for _ in $(seq 1 30); do
    if grep -qE "Uvicorn running on|ProteomicsAI starting on" "$MAIN_LOG_FILE" 2>/dev/null; then
      grep -E "Uvicorn running on|ProteomicsAI starting on" "$MAIN_LOG_FILE" | tail -1
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "error: main app exited during startup:" >&2
      tail -n 8 "$MAIN_LOG_FILE" >&2
      rm -f "$MAIN_PID_FILE"
      return 1
    fi
    sleep 0.5
  done
  echo "warning: main app did not report startup within 15s; check $MAIN_LOG_FILE" >&2
}

# ---- AI Insights sidecar ---------------------------------------------------

# node present? deps installed? .env present? Auto-heal the last two so a fresh
# clone runs with a single command.
prepare_sidecar() {
  if ! command -v node >/dev/null 2>&1; then
    echo "error: 'node' not found on PATH. Install Node.js (>=20) to run the AI Insights sidecar." >&2
    exit 1
  fi
  if [[ ! -d "$SIDECAR_DIR/node_modules" ]]; then
    echo "AI Insights sidecar: installing dependencies (first run)…"
    ( cd "$SIDECAR_DIR" && npm install )
  fi
  if [[ ! -f "$SIDECAR_DIR/.env" ]]; then
    cp "$SIDECAR_DIR/.env.example" "$SIDECAR_DIR/.env"
    echo "AI Insights sidecar: created $SIDECAR_DIR/.env from the template." >&2
    echo "  -> set SESSION_SECRET (openssl rand -hex 32) + a provider key before live use." >&2
  fi
}

# The free-form research agent runs its generated code inside a per-job Docker
# jail. The sidecar's own run.sh owns that image (+ Dockerfile), so provision it
# (build-if-missing) and tidy leftover containers by delegating there. Both only
# WARN on Docker problems, so they never block the main app.
ensure_jail() { say "provisioning free-form research jail (build-if-missing)…"; bash "$SIDECAR_DIR/run.sh" jail-ensure; }
clean_jail()  { bash "$SIDECAR_DIR/run.sh" jail-clean; }

# Mirrors ai-sidecar package.json "start" (node --import tsx src/index.ts).
# We invoke node directly (not via npm) so a backgrounded PID is the real
# server, and we cd into the sidecar so SIGNALFOLD_DATA_DIR=../data resolves to
# the same ./data the main app uses.
start_sidecar_fg() {
  prepare_sidecar
  ensure_jail
  say "starting AI Insights sidecar in foreground on :$SIDECAR_PORT (Ctrl-C to stop)…"
  cd "$SIDECAR_DIR"
  exec node --import tsx src/index.ts
}

start_sidecar_bg() {
  prepare_sidecar
  ensure_jail
  if is_listening "$SIDECAR_PORT"; then
    echo "Sidecar: port :$SIDECAR_PORT already held by $(listener_desc "$SIDECAR_PORT") — not starting another." >&2
    return 1
  fi
  ( cd "$SIDECAR_DIR" && exec node --import tsx src/index.ts ) >"$SIDECAR_LOG_FILE" 2>&1 &
  local pid=$! _
  echo "$pid" >"$SIDECAR_PID_FILE"
  echo "Starting AI Insights sidecar in background (PID $pid). Logs -> $SIDECAR_LOG_FILE"
  for _ in $(seq 1 40); do
    if grep -q "AI Insights sidecar" "$SIDECAR_LOG_FILE" 2>/dev/null; then
      echo "  AI Insights:  http://127.0.0.1:$SIDECAR_PORT/"
      echo "  Operations:   http://127.0.0.1:$SIDECAR_PORT/operations"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "error: sidecar exited during startup:" >&2
      tail -n 12 "$SIDECAR_LOG_FILE" >&2
      rm -f "$SIDECAR_PID_FILE"
      return 1
    fi
    sleep 0.5
  done
  echo "warning: sidecar did not report startup within 20s; check $SIDECAR_LOG_FILE" >&2
}

# ---- status ----------------------------------------------------------------

show_status() {
  echo "SignalFold services:"
  if is_listening "$MAIN_PORT"; then
    printf '  %-12s UP    :%s  %-24s http://127.0.0.1:%s/\n' "main app" "$MAIN_PORT" "$(listener_desc "$MAIN_PORT")" "$MAIN_PORT"
  else
    printf '  %-12s down  :%s  start: ./run.sh   (or docker-compose up)\n' "main app" "$MAIN_PORT"
  fi
  if is_listening "$SIDECAR_PORT"; then
    printf '  %-12s UP    :%s  %-24s http://127.0.0.1:%s/  (/operations)\n' "AI Insights" "$SIDECAR_PORT" "$(listener_desc "$SIDECAR_PORT")" "$SIDECAR_PORT"
  else
    printf '  %-12s down  :%s  start: ./run.sh ai\n' "AI Insights" "$SIDECAR_PORT"
  fi
}

# ---- lifecycle (consistent start/stop/restart across scopes) ---------------

start_all() {
  say "starting both SignalFold services in the background…"
  start_sidecar_bg || true
  start_main_bg || true
  echo
  show_status
}

stop_app() { say "stopping main app…"; stop_pidfile "main app" "$MAIN_PID_FILE"; warn_if_held "main app" "$MAIN_PORT"; }
stop_ai()  { say "stopping AI Insights sidecar…"; stop_pidfile "AI Insights sidecar" "$SIDECAR_PID_FILE"; clean_jail; warn_if_held "AI Insights" "$SIDECAR_PORT"; }
stop_all() {
  say "stopping all SignalFold services…"
  stop_pidfile "main app" "$MAIN_PID_FILE"
  stop_pidfile "AI Insights sidecar" "$SIDECAR_PID_FILE"
  clean_jail
  warn_if_held "main app" "$MAIN_PORT"; warn_if_held "AI Insights" "$SIDECAR_PORT"
  say "stop complete."
}

# restart = stop then start; background unless a single service asks for fg.
restart_app() { stop_app; wait_port_free "$MAIN_PORT"; [[ "${1:-bg}" == fg ]] && start_main_fg || start_main_bg; }
restart_ai()  { stop_ai;  wait_port_free "$SIDECAR_PORT"; [[ "${1:-bg}" == fg ]] && start_sidecar_fg || start_sidecar_bg; }
restart_all() {
  say "restarting both SignalFold services…"
  stop_all
  wait_port_free "$MAIN_PORT"; wait_port_free "$SIDECAR_PORT"
  start_sidecar_bg || true
  start_main_bg || true
  echo
  show_status
}

# ---- dispatch --------------------------------------------------------------

case "${1:-fg}" in
  # consistent verb [scope] grammar (scope = all | app | ai; default all)
  start)
    case "${2:-all}" in
      all) start_all ;;
      app) [[ "${3:-bg}" == fg ]] && start_main_fg || start_main_bg ;;
      ai)  [[ "${3:-bg}" == fg ]] && start_sidecar_fg || start_sidecar_bg ;;
      *)   echo "error: unknown start scope: ${2:-} (use all|app|ai)" >&2; usage; exit 2 ;;
    esac ;;
  stop)
    case "${2:-all}" in
      all) stop_all ;;
      app) stop_app ;;
      ai)  stop_ai ;;
      *)   echo "error: unknown stop scope: ${2:-} (use all|app|ai)" >&2; usage; exit 2 ;;
    esac ;;
  restart)
    case "${2:-all}" in
      all) restart_all ;;
      app) restart_app "${3:-bg}" ;;
      ai)  restart_ai  "${3:-bg}" ;;
      *)   echo "error: unknown restart scope: ${2:-} (use all|app|ai)" >&2; usage; exit 2 ;;
    esac ;;
  status) show_status ;;

  # shorthands (kept for muscle memory / existing docs)
  fg) start_main_fg ;;
  bg) start_main_bg ;;
  ai)
    case "${2:-fg}" in
      fg)   start_sidecar_fg ;;
      bg)   start_sidecar_bg ;;
      stop) stop_ai ;;
      *)    echo "error: unknown 'ai' subcommand: ${2:-}" >&2; usage; exit 2 ;;
    esac ;;
  all) start_all ;;
  -h|--help|help) usage ;;
  *) echo "error: unknown command: ${1:-}" >&2; usage; exit 2 ;;
esac
