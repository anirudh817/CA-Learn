# SignalFold AI Insights sidecar

This package is the canonical AI Insights runtime and standalone UI. Standard
and Deep Research are policy profiles on the same persistent Pi session
architecture.

## Local start

From the repo root, the `run.sh` launcher manages this sidecar alongside the
main app (it auto-runs `npm install` and seeds `.env` on first run):

```bash
./run.sh ai        # foreground (:4317)
./run.sh ai bg     # background -> ai-sidecar/ai-sidecar.log
./run.sh status    # show what is up on :8000 and :4317
```

Or run it directly:

```bash
cd ai-sidecar
npm install
cp .env.example .env
npm start
```

Open `http://127.0.0.1:4317`. The page selects the newest completed run, or use
`http://127.0.0.1:4317/?run=RUN-ID`.

## Deep Research jobs

Switch a run-scoped conversation to **Deep Research** to open the durable
research workspace. The first release includes **Finding Stress Test** and
**Ranked Pathway Investigation**. A job is inert until its editable plan is
approved; approval freezes question-adaptive run evidence, exact stage configs,
row identifiers, exclusions, file hashes, skill versions, and the cost/runtime
ceiling. The worker then runs only repository-owned offline skill manifests and
persists checkpoints independently of the browser connection.

Completed jobs register eight durable outputs in the Artifacts rail: decision
summary, HTML report, evidence record, generated artifacts, computation
manifest, re-run action, open questions, and recommended next step. This local
v1 deliberately reports external consistency as **not assessed**; it does not
perform arbitrary web research or claim causal mechanism, novelty, validation,
or measured cell abundance.

## Provider credentials

The preferred local setup is the Configuration drawer in the UI. Set a strong,
stable `SESSION_SECRET` in `ai-sidecar/.env`, start the sidecar, then paste an
OpenRouter or Anthropic key into the drawer. The key is encrypted before it is
stored, is never returned by the API, and is excluded from Pi session files,
traces, artifacts, and child-process environments.

For a short-lived local smoke test, put these values directly in
`ai-sidecar/.env`:

```dotenv
SESSION_SECRET=generate-a-long-random-value
OPENROUTER_API_KEY=
AI_DEV_OPENROUTER_MODEL=openrouter/minimax/minimax-m3
```

`ai-sidecar/.env` is Git-ignored. Do not put real values in `.env.example`, a
shell script, source code, test fixture, chat message, or commit. Generate a
secret with `openssl rand -hex 32` and keep the same value if you want saved
BYOK credentials to remain decryptable across restarts.

The OpenRouter model must be tool-capable and should use the canonical picker
ID form `openrouter/vendor/model`. The runtime refuses unavailable models and
does not silently substitute another paid model.

MiniMax M3 (`openrouter/minimax/minimax-m3`) is the committed default. The
conversation-header picker can still switch to any allowed tool-capable model
per turn. It is a strict dropdown: use **Configuration & summary → Visible
models** to choose which catalog entries appear in it. This local preference
and its intelligence/cost sort mode are stored in the sidecar database, while
`AI_DEV_ALLOWED_MODELS` remains the server-side outer allowlist. The picker and
configuration list show OpenRouter input/output pricing plus the Artificial
Analysis Intelligence Index when that model has a published score. Value sort
uses Artificial Analysis' 7:2:1 cache-input-output blended price.

Turns are stopped after `AI_PI_TURN_TIMEOUT_SECONDS` (180 seconds by default),
so a stalled provider cannot leave the conversation in a permanent loading
state.

## Developer operational control center

With `AI_DEVELOPER_MODE=1` and `AI_OPERATIONS_CENTER=1`, open
`http://127.0.0.1:4317/operations` (or use the link in the AI Insights left
rail). The read-only view shows each turn's scrubbed Pi prompt capture and hash
(with an explicit trace-limit flag),
grounding file/byte/truncation manifest, session and message events,
tool/skill/Python execution frames, usage, persistence, errors, and duration.
It retains the newest 100 turns by default; change this with
`AI_OPERATIONS_RETENTION_TURNS`.

The center deliberately distinguishes configured Python, advertised skills,
Pi-discovered skills, registered tools, and observed executions. With developer
mode on and `AI_PYTHON_EXECUTION` not `disabled`, the Pi session registers
`read`, `bash`, `write`, `edit`, and a `save_artifact` custom tool, and injects
the committed skills — so those columns converge and the two execution warnings
clear. Set `AI_PYTHON_EXECUTION=disabled` (or `AI_DEVELOPER_MODE=0`) to fall
back to `tools: []`, and set either enablement flag to `0` and restart to remove
the route/API and stop recording new operational turns.

## Skills & code execution

When execution is enabled (developer mode + Python not disabled), the runtime
registers a small tool allowlist and injects the committed skills under
`skills/` via Pi's `skillsOverride`, so the model can load a `SKILL.md`
(`read`), run bundled scripts and `python3` (`bash`), generate code
(`write`/`edit`), and persist an output as a registered run artifact
(`save_artifact`). Production stays locked at `tools: []`.

Four deterministic validation skills ship in `skills/` (sentinels in
`skills/README.md`): `sf-runtime-probe`, `sf-echo-script`, `sf-python-compute`,
and `sf-artifact-report`. Execution is developer-local — gated to
`AI_DEVELOPER_MODE`, confined to the conversation work dir as the bash `cwd`,
with output scrubbing intact, but not OS-sandboxed.

## Verification

```bash
npm test
npm run typecheck
```

Live calls are intentionally opt-in: configure the key/model, start the
sidecar, then run:

```bash
LIVE_OPENROUTER_SMOKE=1 npm run test:live
```

The smoke uses one short grounded turn, enforces `AI_LIVE_SMOKE_MAX_USD`, and
scans the run AI directory plus sidecar database for the exact key bytes.

To exercise the validation skills end-to-end (skill load, bundled script,
generated Python, and artifact persistence) against a running sidecar:

```bash
LIVE_SKILLS_SMOKE=1 npm run test:live-skills
```

It runs each skill as a real turn, asserts each sentinel, confirms the
`sf-artifact-report` artifact lands on disk and in `GET /api/artifacts`, checks
the operations center reports `toolRuns`/`skillRuns`/`pythonRuns > 0` with the
warnings cleared, and reuses the key-leak scan. Cost is bounded by
`AI_LIVE_SKILLS_SMOKE_MAX_USD` (default: six times `AI_LIVE_SMOKE_MAX_USD`).
