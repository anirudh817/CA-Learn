#!/usr/bin/env bash
#
# Cloud Agent install script for SignalFold.
#
# Idempotent dependency refresh run after the repository is checked out. With
# environment builds this runs once to bake the baseline snapshot; without a
# build it may run again, so every step must be safe to repeat.
#
# It prepares three things the app needs to run end to end:
#   1. The R runtime + proteomics R packages (Stage 1 WGCNA/limma/etc.). These
#      are installed from the Ubuntu apt repos (r-cran-*/r-bioc-* binaries) so
#      no CRAN/Bioconductor egress is required.
#   2. The Python venv + FastAPI backend dependencies (main app on :8000).
#   3. The Node AI Insights sidecar dependencies + a local .env (sidecar :4317).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '[install %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# ---------------------------------------------------------------------------
# 1. System packages: Python venv support, R runtime, and the proteomics R
#    packages. All come from apt (allowlisted Ubuntu mirrors); the pipeline's
#    Stage 1 hard-fails without Rscript + WGCNA/limma, so these are required.
# ---------------------------------------------------------------------------
log "installing system packages (python3-venv + R stack) via apt…"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
  python3-venv \
  r-base-core \
  r-cran-wgcna \
  r-bioc-limma \
  r-bioc-preprocesscore \
  r-bioc-impute \
  r-cran-dynamictreecut \
  r-cran-jsonlite \
  r-cran-matrixstats \
  r-cran-foreach \
  r-cran-doparallel \
  r-cran-fastcluster \
  r-cran-pheatmap \
  r-cran-plotly \
  r-cran-htmlwidgets \
  r-cran-rcolorbrewer \
  r-cran-gplots

# ---------------------------------------------------------------------------
# 2. Python virtual environment + backend requirements (FastAPI main app).
# ---------------------------------------------------------------------------
log "creating Python venv and installing backend requirements…"
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r backend/requirements.txt

# ---------------------------------------------------------------------------
# 3. AI Insights sidecar: Node dependencies + local .env with a real
#    SESSION_SECRET (required to encrypt BYOK credentials). Provider API keys
#    stay blank — the sidecar serves without them; live AI calls need a key.
# ---------------------------------------------------------------------------
log "installing AI Insights sidecar Node dependencies…"
( cd ai-sidecar && npm install )
if [ ! -f ai-sidecar/.env ]; then
  log "creating ai-sidecar/.env from template…"
  cp ai-sidecar/.env.example ai-sidecar/.env
  secret="$(openssl rand -hex 32)"
  sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=${secret}/" ai-sidecar/.env
fi

# ---------------------------------------------------------------------------
# 4. Runtime data directories (uploads, runs, exports, scratch).
# ---------------------------------------------------------------------------
log "ensuring runtime data directories exist…"
mkdir -p data/uploads data/runs data/exports data/scratch

log "install complete."
