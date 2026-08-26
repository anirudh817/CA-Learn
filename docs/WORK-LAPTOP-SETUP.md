# Work-laptop demo setup (`demo-branch`)

**Audience:** an agent or developer setting SignalFold up on a second machine
for a client demo. Read this file top to bottom before running anything.

**This branch is a demo bundle, not the product branch.** It is `main` plus a
small, sanitised slice of runtime data that is normally excluded from git. Do
not merge it into `main`, and do not treat it as the source of truth for
features — `main` is.

---

## 1. What this branch contains

Everything on `main`, plus these normally-gitignored files:

| Path | What it is | Size |
|---|---|---|
| `data/runs/RUN-20260518-3E7F/` | One completed pipeline run: all stage outputs and deliverables, plus an approved Deep Research plan and its frozen scope manifest | 141 MB |
| `data/uploads/6d13d41761f047cd.csv` | The raw input that produced that run | 5.7 MB |
| `data/proteomics.db` | Pipeline database, pruned to that one run | 1 MB |
| `data/ai_insights.sqlite` | AI sidecar database, pruned to that one run | 1.9 MB |
| `demo/SPEC-PEP-Sweden.csv` | A human-named copy of the raw input, for demonstrating upload | 5.7 MB |
| `scripts/demo_setup.py` | Stamps this checkout's path into the bundle (step 3 below) | — |

**Deliberately excluded:** the other 30 runs, the other 70 uploads (1.8 GB
including one 424 MB file that exceeds GitHub's 100 MB per-file limit), all API
keys, all session tokens, and every credential row. Nothing secret is in this
branch and nothing secret may be added to it.

### The path placeholder

Absolute host paths are baked into the databases and into 16 JSON/R files
inside the run (`stored_path`, `manifest_path`, stage configs, the research
scope manifest). They are shipped as the literal string `__SIGNALFOLD_ROOT__`
so the bundle works from any directory. `scripts/demo_setup.py` replaces that
placeholder with the real checkout path. **The app will not resolve files
correctly until that script has been run.**

---

## 2. How the system is put together

Two independent processes. Neither starts the other.

```
:8000  main app       FastAPI + vanilla-JS SPA + SQLite      python3
:4317  AI Insights    Node "sidecar", separate service       node >= 22.19
```

The main app's **AI Insights** tab is only a launcher — it opens `:4317` in a
browser. If the sidecar is not running, that tab shows an error toast and
nothing else breaks.

Data lives on the filesystem under `data/`, with `data/runs/<RUN-ID>/` holding
every artifact for a run. The database stores metadata and pointers; the
artifacts themselves are plain files.

`./run.sh` manages both processes using `verb [scope]` grammar, where scope is
`all`, `app`, or `ai`:

```bash
./run.sh start all      # start both in the background
./run.sh status         # what is up on :8000 and :4317
./run.sh stop all       # stop both
./run.sh restart app    # restart just the main app
```

### What needs what

| Capability | Requires | Available on a plain laptop? |
|---|---|---|
| Browse the completed run: results, plots, tables, deliverables | Python only | **Yes** |
| Upload a file and see format auto-detection | Python only | **Yes** |
| AI Insights — Standard chat history, Operations Center, Deep Research plan and scope manifest | Node + an OpenRouter key | **Yes**, after §5 |
| **Executing a new pipeline run** | **R** — supplied only by Docker | **No, without Docker** |
| AI "Open investigation" (agent-written Python) | Docker jail image | **No, without Docker** |

This is the single most important fact for demo planning: **R is a hard
dependency for *producing* a run, not for *viewing* one.** `run_stage1()`
raises `RuntimeError("R Stage 1 is required but unavailable…")` when `Rscript`
is missing — there is no Python fallback. The bundled run exists precisely so
the demo does not depend on this.

---

## 3. Setup

**The repository is private.** The HTTPS clone below will prompt for
credentials: use a GitHub personal access token with `repo` scope as the
password (not your account password), or run `gh auth login` first and let the
CLI configure the credential helper. Sort this out before demo day — it is the
single most likely thing to block you on a locked-down machine.

The clone is ~154 MB and takes a few minutes on a slow connection.

```bash
# 1. Clone only this branch (HTTPS — corporate networks usually block SSH)
git clone --single-branch -b demo-branch \
  https://github.com/ani-suri/signalfold.git
cd signalfold

# 2. Python dependencies
pip install -r backend/requirements.txt

# 3. Stamp this checkout's path into the bundle  <-- REQUIRED
python3 scripts/demo_setup.py

# 4. Start
./run.sh start all
```

Then open **http://127.0.0.1:8000** and sign in:

```
admin@local.signalfold
local-bootstrap-only
```

`scripts/demo_setup.py` is idempotent. **Re-run it if you move or rename the
checkout directory** — it records the stamped root in `data/.demo_root` and
rewrites the old path to the new one.

---

## 4. Verifying the setup

In order. Stop at the first failure and see §7.

1. `./run.sh status` shows the main app **UP** on `:8000`.
2. `http://127.0.0.1:8000` loads and the login above works.
3. Run history lists exactly one run, `RUN-20260518-3E7F`, status **COMPLETE**.
4. Opening it shows results across all three stages — normalization, modules,
   GO enrichment, cell-type — with plots rendering, not broken images.
5. The deliverables/download panel lists files and a download succeeds.
6. The upload page lists exactly one dataset, `SPEC-PEP-Sweden.csv`, and the
   dataset card shows `PEAKS Wide Peptide Matrix`, 59 samples.

Expected content of that run: 11,679 peptides, 59 samples, ~6 minutes of
original runtime.

---

## 5. AI Insights (optional but recommended)

The sidecar runs without Docker. It needs Node ≥ 22.19 and a provider key.

```bash
cd ai-sidecar
cp .env.example .env
```

Edit `ai-sidecar/.env` and set two values:

```dotenv
SESSION_SECRET=<generate with: openssl rand -hex 32>
OPENROUTER_API_KEY=<your key>
```

Then `cd .. && ./run.sh restart ai` and open **http://127.0.0.1:4317**.

- `ai-sidecar/.env` is gitignored. **Never commit a key to this branch.** No
  credential rows were shipped, by design.
- Alternatively, paste the key into the Configuration drawer in the UI instead
  of the `.env` file; it is encrypted at rest with `SESSION_SECRET`.
- **What the bundled Deep Research job does and does not show.** The job on
  this run is in state **`failed`** — it was approved and scoped, then died at
  its first execution step because the free-form Docker jail image was not
  built on the machine that produced the bundle. It has **no result
  deliverables and no claims**. What *is* viewable, and is the part worth
  showing, is everything up to execution: the proposed plan, the approval, and
  the frozen **scope manifest** (selected rows, stage configs, exclusions,
  SHA-256 hashes, skill versions, cost ceiling). Demo it as *"this is the
  contract the job is locked to before it is allowed to run"* — not as a
  finished investigation. Do not open its results tab in front of a client.
- **Standard chat history** on this run — one saved conversation — is viewable,
  and new chat turns work once a key is set.
- Launching a *new* free-form "Open investigation" needs the Docker jail image
  and will fail without it — avoid that path in a demo.
- Developer mode is on in `.env.example`, so `http://127.0.0.1:4317/operations`
  is available. It shows, per turn, exactly which files grounded the answer,
  byte counts, token cost, and execution frames. This is the strongest thing to
  show a client who asks "how do I know it isn't making this up?"

---

## 6. Optional: enabling live pipeline runs

Only if Docker is installed and permitted on the machine.

```bash
docker-compose up --build
```

The image installs R plus WGCNA/limma and friends; the **first build is slow**
(tens of minutes). Once up, the stack serves on `:8000` in place of the native
app, and a live run becomes possible.

Reference timings measured on real inputs — check before choosing a file to run
live:

| Input | Size | Samples | Runtime |
|---|---|---|---|
| `SPEC-PEP-Sweden.csv` (bundled) | 5.9 MB | 59 | **~6 min** |
| `Peptide List Sweden Cohort_Converted.csv` | 26.6 MB | 60 | **53 min** |

If Docker is unavailable or blocked, skip this section entirely. The demo works
without it.

---

## 7. Troubleshooting

**Results pages are blank, downloads 404, or artifacts are "missing".**
`scripts/demo_setup.py` was not run, or the folder moved after it ran. Run it
again.

**`demo_setup.py` reports the bundle is incomplete.**
Wrong branch. `git checkout demo-branch`.

**Run history is empty.**
`DATA_DIR` is pointing somewhere other than this checkout's `data/`. Unset it
and restart; it defaults to `./data`.

**`pip install` fails on a corporate network.**
Usually TLS inspection, not permissions. Try
`pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org -r backend/requirements.txt`,
or configure the proxy.

**Port 8000 or 4317 already in use.**
`./run.sh status` reports the holder. `run.sh` will not kill a process it did
not start. Use `PORT=8010 python3 -m proteomics_ai.devserver` to move the app.

**A pipeline run fails immediately after ETL with an R error.**
Expected without Docker. See §2 — use the bundled run instead.

**AI Insights tab says the server isn't running.**
The sidecar is a separate process: `./run.sh start ai`. If it exits at startup,
check `ai-sidecar/ai-sidecar.log` — usually a missing `SESSION_SECRET` or key.

---

## 8. Rules for anyone working on this branch

- **Do not merge `demo-branch` into `main`.** It carries ~150 MB of data that
  does not belong in the product history.
- **Do not commit additional runs, uploads, or databases** without pruning and
  re-running the path-placeholder step — and never anything above 100 MB, which
  GitHub rejects outright.
- **Do not commit `.env`, API keys, or credential rows.**
- Product fixes belong on `main` (or a branch off it), not here. The underlying
  portability problems this bundle works around are tracked as **Epic 3 —
  Portability & deployability** in `TRACKER.md`.
