#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
PID_FILE=".ai-sidecar.pid"
LOG_FILE="ai-sidecar.log"
PORT="${PI_RUNTIME_PORT:-4317}"
JAIL_IMAGE="${FREEFORM_JAIL_IMAGE:-signalfold-freeform-jail:1.1}"
JAIL_DOCKERFILE="docker/freeform-jail.Dockerfile"
# When the Docker Hub base (python:3.12-slim) can't be pulled, the jail build
# falls back to reusing this already-built local image as its base.
JAIL_FALLBACK_BASE="${FREEFORM_JAIL_FALLBACK_BASE:-signalfold-freeform-jail:1.0}"

# ---- logging ---------------------------------------------------------------
# Verbose, timestamped, prefixed so it is obvious which script is talking when
# the root run.sh delegates here.
log()  { printf '[sidecar %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '[sidecar %s] WARNING: %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

# ---- free-form research Docker jail ----------------------------------------
# The free-form research agent runs its generated Python inside a per-job
# container built from $JAIL_IMAGE (inputs/ read-only + outputs/ read-write,
# --network none). Without the image, free-form jobs fail closed at run time;
# the rest of the sidecar is unaffected, so any jail problem WARNs but never
# blocks startup.
have_docker() { command -v docker >/dev/null 2>&1; }
jail_id()     { docker image inspect "$JAIL_IMAGE" --format '{{.Id}}' 2>/dev/null; }

jail_build() {
  log "building free-form jail image: $JAIL_IMAGE (from $JAIL_DOCKERFILE) — the baked omics venvs make the first build slow (several minutes)…"
  if docker build -f "$JAIL_DOCKERFILE" -t "$JAIL_IMAGE" . ; then
    log "free-form jail image built: $JAIL_IMAGE ($(jail_id))"
  elif docker image inspect "$JAIL_FALLBACK_BASE" >/dev/null 2>&1; then
    warn "canonical build failed (Docker Hub base unreachable?); retrying with local base $JAIL_FALLBACK_BASE"
    if docker build --build-arg "BASE_IMAGE=$JAIL_FALLBACK_BASE" -f "$JAIL_DOCKERFILE" -t "$JAIL_IMAGE" . ; then
      log "free-form jail image built from local base: $JAIL_IMAGE ($(jail_id))"
    else
      warn "free-form jail image build failed — free-form research stays unavailable until it builds (./run.sh jail-build)"
      return 1
    fi
  else
    warn "free-form jail image build failed — free-form research stays unavailable until it builds (./run.sh jail-build)"
    return 1
  fi
}

# Build the jail image only when it is missing. Safe to call on every start.
jail_ensure() {
  if ! have_docker; then
    warn "docker CLI not found — free-form research will be unavailable (install Docker, then ./run.sh jail-build)"
    return 0
  fi
  if docker image inspect "$JAIL_IMAGE" >/dev/null 2>&1; then
    log "free-form jail image present: $JAIL_IMAGE ($(jail_id | cut -c1-19)…)"
  else
    log "free-form jail image '$JAIL_IMAGE' is missing — building it once now…"
    jail_build || true
  fi
}

# Remove any leftover per-job jail containers (labeled on creation). They are
# torn down at end-of-job, so this only matters after a hard crash/kill.
jail_clean() {
  have_docker || return 0
  local ids
  ids="$(docker ps -aq --filter label=signalfold.freeform=1 2>/dev/null || true)"
  if [[ -n "$ids" ]]; then
    log "removing $(printf '%s\n' "$ids" | grep -c .) leftover free-form jail container(s)…"
    docker rm -f $ids >/dev/null 2>&1 || warn "could not remove some jail containers"
  else
    log "no leftover free-form jail containers to clean up."
  fi
}

# ---- network-skill egress sandbox (network mode, default off) --------------
# A reviewed network skill runs in a per-job container behind a TLS-intercepting
# egress proxy on an --internal bridge. Two images: the proxy (bakes the egress
# CA + per-host leaf certs) and the network-skill image (bio deps + CA trust).
NET_IMAGE="${FREEFORM_NET_IMAGE:-signalfold-freeform-net:1.0}"
PROXY_IMAGE="${EGRESS_PROXY_IMAGE:-signalfold-egress-proxy:1.0}"
EGRESS_CERTS_DIR="docker/.egress-certs"
EGRESS_HOSTS="docker/egress-proxy/egress-hosts.txt"

egress_certs() { bash docker/egress-proxy/gen-certs.sh "$EGRESS_HOSTS" "$EGRESS_CERTS_DIR"; }
egress_build() {
  have_docker || { warn "docker CLI not found — cannot build the egress proxy image"; return 1; }
  egress_certs
  log "building egress proxy image: $PROXY_IMAGE…"
  if docker build -f docker/egress-proxy.Dockerfile -t "$PROXY_IMAGE" . ; then log "egress proxy image built: $PROXY_IMAGE"; else warn "egress proxy image build failed"; return 1; fi
}
net_build() {
  have_docker || { warn "docker CLI not found — cannot build the network-skill image"; return 1; }
  egress_certs
  log "building network-skill image: $NET_IMAGE (bio deps — slow first build)…"
  if docker build -f docker/freeform-net.Dockerfile -t "$NET_IMAGE" . ; then log "network-skill image built: $NET_IMAGE"; else warn "network-skill image build failed"; return 1; fi
}
# Remove leftover per-job network-skill containers + bridges (labeled on creation).
net_clean() {
  have_docker || return 0
  local cids; cids="$(docker ps -aq --filter label=signalfold.netskill=1 2>/dev/null || true)"
  [[ -n "$cids" ]] && docker rm -f $cids >/dev/null 2>&1 || true
  docker network ls --filter name=sf-egn- -q 2>/dev/null | xargs -r docker network rm >/dev/null 2>&1 || true
  docker network ls --filter name=sf-int- -q 2>/dev/null | xargs -r docker network rm >/dev/null 2>&1 || true
}

# ---- dispatch --------------------------------------------------------------
case "${1:-fg}" in
  stop)
    if [[ -f "$PID_FILE" ]] && kill -0 "$(<"$PID_FILE")" 2>/dev/null; then
      pid="$(<"$PID_FILE")"
      log "stopping sidecar (PID $pid)…"
      kill "$pid"
      rm -f "$PID_FILE"
      log "sidecar stopped."
    else
      log "no running sidecar found (no live PID in $PID_FILE)."
      rm -f "$PID_FILE"
    fi
    jail_clean
    net_clean
    ;;
  bg)
    jail_ensure
    log "starting sidecar in background on :$PORT (logs → $LOG_FILE)…"
    nohup node --import tsx src/index.ts >"$LOG_FILE" 2>&1 &
    pid=$!
    echo "$pid" >"$PID_FILE"
    log "sidecar process PID $pid; waiting up to 15s for it to report ready…"
    for _ in $(seq 1 30); do
      if grep -q "SignalFold AI Insights sidecar:" "$LOG_FILE" 2>/dev/null; then
        log "ready → $(grep "SignalFold AI Insights sidecar:" "$LOG_FILE" | tail -1)"
        log "operations console: http://127.0.0.1:$PORT/operations"
        exit 0
      fi
      if ! kill -0 "$pid" 2>/dev/null; then
        warn "sidecar exited during startup; last log lines:"
        tail -20 "$LOG_FILE" >&2
        rm -f "$PID_FILE"
        exit 1
      fi
      sleep .5
    done
    warn "sidecar did not report ready within 15s; inspect $LOG_FILE"
    exit 1
    ;;
  fg)
    jail_ensure
    log "starting sidecar in foreground on :$PORT (Ctrl-C to stop)…"
    exec npm start
    ;;
  jail-build)
    # Force a (re)build of the pinned jail image.
    have_docker || { warn "docker CLI not found — cannot build the jail image"; exit 1; }
    jail_build
    ;;
  jail-ensure)
    # Build the jail image only if it is missing. Used by the start paths and by
    # the root run.sh so `all`/`ai` provision the sandbox before launch.
    jail_ensure
    ;;
  jail-clean)
    # Remove leftover free-form jail containers (labeled signalfold.freeform=1).
    jail_clean
    ;;
  egress-certs)
    # (Re)generate the per-deployment egress CA + per-host leaf certs.
    egress_certs
    ;;
  egress-build)
    # Build the egress proxy image (network mode).
    egress_build
    ;;
  net-build)
    # Build the network-skill image (network mode) — bio deps, slow first build.
    net_build
    ;;
  net-clean)
    # Remove leftover per-job network-skill containers + bridges.
    net_clean
    ;;
  *)
    cat >&2 <<EOF
Usage: ./run.sh [fg|bg|stop|jail-build|jail-ensure|jail-clean|egress-certs|egress-build|net-build|net-clean]
  fg / bg      start the sidecar (auto-builds the free-form jail image if missing)
  stop         stop the sidecar and remove leftover jail + network-skill containers
  jail-build   force a rebuild of the free-form jail image ($JAIL_IMAGE)
  jail-ensure  build the jail image only if it is missing
  jail-clean   remove leftover free-form jail containers
  egress-certs (re)generate the per-deployment egress CA + per-host leaf certs
  egress-build build the egress proxy image ($PROXY_IMAGE) — network mode
  net-build    build the network-skill image ($NET_IMAGE) — network mode, slow
  net-clean    remove leftover per-job network-skill containers + bridges
EOF
    exit 2
    ;;
esac
