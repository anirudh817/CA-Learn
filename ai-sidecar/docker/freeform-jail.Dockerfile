# SignalFold free-form research jail image (v1.1 — unified execution surface).
#
# The unconstrained free-form agent writes and runs arbitrary Python. Before the
# jail it ran as a host subprocess and a cell could os.walk out and read any host
# file by absolute path. v1.0 sealed run_python: every cell executes here, in a
# per-job container with ONLY inputs/ (read-only) and outputs/ (read-write)
# bind-mounted and --network none — no host filesystem to escape to.
#
# v1.1 unifies SKILL execution into the SAME box. The vendored OFFLINE scientific
# skills are baked read-only at /opt/skills/scientific (the phone-home
# secondary-LLM *_ai.py scripts are stripped at build, so they are never present
# in the sealed box — construction, not a runtime blocklist), and their heavier
# environments are pre-installed as isolated uv venvs under /opt/venvs so
# `use_skill` runs offline with NO host subprocess and NO per-script allowlist.
# run_python and use_skill now share ONE container; the box is the boundary.
#
# Pins match the SignalFold host venv (numpy/pandas/scipy/statsmodels/matplotlib)
# plus the catalog's environments.json uv specs for the omics skills. cp312
# manylinux wheels (incl. aarch64) exist for every pin, so no compiler is needed.
#
# Build (records a content-addressable image id the ExecutionReceipt pins):
#   ai-sidecar/run.sh jail-build
#   # or: docker build -f docker/freeform-jail.Dockerfile -t signalfold-freeform-jail:1.1 .
# When the Docker Hub base cannot be pulled, reuse a locally-present base image:
#   docker build --build-arg BASE_IMAGE=signalfold-freeform-jail:1.0 \
#     -f docker/freeform-jail.Dockerfile -t signalfold-freeform-jail:1.1 .
ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}

# Base scientific stack. Idempotent when BASE_IMAGE already ships these pins.
RUN pip install --no-cache-dir \
      numpy==1.26.3 \
      pandas==2.2.0 \
      scipy==1.16.3 \
      statsmodels==0.14.6 \
      matplotlib==3.11.0

# uv, for the pre-baked per-environment omics venvs below.
RUN pip install --no-cache-dir uv==0.5.11

# Pre-bake the heavier OFFLINE omics environments as isolated venvs so the
# matching skills (pyopenms / pydeseq2 / scanpy) run with NO network at job time.
# Pinned to the catalog's environments.json uv specs. Each is its own layer so a
# single resolver failure is isolated.
RUN uv venv /opt/venvs/omics-pyopenms && uv pip install --python /opt/venvs/omics-pyopenms/bin/python "pyopenms==3.5.0"
RUN uv venv /opt/venvs/omics-pydeseq2 && uv pip install --python /opt/venvs/omics-pydeseq2/bin/python "pydeseq2==0.5.4"
RUN uv venv /opt/venvs/omics-scanpy && uv pip install --python /opt/venvs/omics-scanpy/bin/python "scanpy>=1.12,<1.13"

# System shared libraries the compiled omics wheels load at runtime. pyOpenMS's
# binary extension needs libglib-2.0, which the slim base omits; without it the
# wheel installs but fails to import. (Placed after the venv layers so they stay
# cached; the lib is resolved at runtime, not at wheel-install time.)
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

# Vendored OFFLINE scientific skills, baked read-only. The phone-home
# secondary-LLM scripts are removed at build so they are never present in the
# sealed box (construction-level exclusion, not a runtime blocklist).
COPY skills/scientific /opt/skills/scientific
RUN find /opt/skills/scientific -name '*_ai.py' -delete \
 && find /opt/skills/scientific -name '.DS_Store' -delete

# Pre-create the bind-mount points so they exist under a --read-only rootfs, and
# warm matplotlib's font cache at build time into a baked, version-matched
# location so the first figure in a job does not pay the rebuild. At runtime
# MPLCONFIGDIR points back here; matplotlib finds a valid cache and only reads it.
RUN mkdir -p /work/inputs /work/outputs /work/code /opt/mpl \
 && MPLCONFIGDIR=/opt/mpl MPLBACKEND=Agg python -c "import matplotlib.pyplot as plt; f=plt.figure(); plt.plot([0,1],[1,0]); plt.title('warm'); f.savefig('/tmp/warm.png'); print('matplotlib font cache warmed')" \
 && rm -f /tmp/warm.png
ENV MPLCONFIGDIR=/opt/mpl

WORKDIR /work
# The container is launched as `sleep infinity` and driven one cell/script at a
# time via `docker exec`; there is no long-running app process.
CMD ["sleep", "infinity"]
