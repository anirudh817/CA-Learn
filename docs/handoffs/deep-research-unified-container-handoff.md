# Handoff prompt — unify SignalFold Deep Research skill execution INSIDE the container

> Paste everything below into a fresh conversation. It is self-contained.

---

You are continuing work on **SignalFold** (FastAPI + vanilla-JS pipeline; the AI lives in the
Node `ai-sidecar/` on :4317). Work on branch **`ssb1`**. Pipeline-owned files are OFF-LIMITS
(`backend/services/pipeline*.py`, stage runners, `backend/r_scripts/`). Don't commit unless asked.

## The goal

Make **one per-job Docker container the single execution environment** for the free-form Deep
Research agent. The agent's `run_python` AND every skill script (offline *and* network) run
**inside that container**. The container's boundary is the only security control:
- **`--network none`** when the job approved no external sources/skills (offline work, fully sealed).
- An **external egress proxy** (domain allowlist + audit + caps) when network skills/sources are
  approved — the container's only route out.

This replaces today's split and removes the per-script allowlist friction. Principle: **trust the
sealed box, not a script enumeration; for network, control the egress at a proxy outside the box.**

## Why (decision already made with the user)

Today there are TWO execution surfaces and that's the problem:
- The agent's `run_python` runs **inside** a `--network none` Docker jail (`ai-sidecar/src/research/freeform-executor.ts`, `startJail`/`execInJail`).
- But `use_skill` scripts run **on the HOST** as a subprocess (`ai-sidecar/src/research/execution-gateway.ts` → `spawn(.venv/bin/python …)`), network "blocked" only by `HTTP_PROXY`/`NO_PROXY` env (soft), with a per-script **allowlist** compensating for that weak host containment.

A live smoke proved the cost: the model *chose* the `exploratory-data-analysis` skill, read it,
called `use_skill` with `script:"eda_analyzer.py"`, and our allowlist rejected it (it wanted the
exact string `scripts/eda_analyzer.py`) with a dead-end error — so the model fell back to
`run_python` and never used a skill again. The allowlist isn't distrust of our code; the
`scientific/` skills are a **wholesale vendor of a third-party repo**
(`github.com/K-Dense-AI/scientific-agent-skills`), only partially reviewed, run over private data,
on the host. The fix is to make execution match the user's (correct) mental model: **everything
runs in the container; the container + proxy are the boundary.**

## Target architecture (precise)

1. **One per-job container = the execution surface.** Both `run_python` and `use_skill` run via
   `docker exec` into it. Mount the vendored skill folder **read-only** into the container; run
   scripts natively. **Drop the per-script allowlist for offline skills** — the sealed container is
   the boundary. **Delete/exclude the phone-home `*_ai.py` scripts** from the vendored set
   (`convert_with_ai.py`, `generate_schematic_ai.py`) so they're never present, rather than a
   runtime blocklist.
2. **Container image** with the scientific stack. Today's `ai-sidecar/docker/freeform-jail.Dockerfile`
   ships only numpy/pandas/scipy/statsmodels/matplotlib. Decide the build strategy (see Decisions):
   one fat image vs per-`environmentId` images vs pre-baked `uv` venvs per the catalog's
   `environmentId`/uv specs. scanpy/pyopenms/pydeseq2/bioservices/gget are heavy → slow builds; plan
   for it (multi-stage, layer caching, or pre-baked venvs mounted read-only).
3. **Per-job network policy:**
   - No approved network → `--network none` (today's sealed jail).
   - Approved network → container joins a **per-job user-defined Docker bridge** whose only other
     member is a **per-job egress-proxy sidecar**. The container has NO other route out (no host
     network; DNS via the proxy or disabled). The proxy enforces the **domain allowlist** (union of
     approved curated sources' hosts + approved network skills' declared `egressDomains`), **logs
     every request** (host, status, bytes, sha256), and caps rate/bytes/time. Fail closed if the
     proxy/image is unavailable (mirror `freeform-executor.ts:254`).
4. **Control plane = outside the container:** the egress proxy (allowlist + audit + caps) plus
   `ResearchService` (approves which sources/skills/domains, freezes them into the job scope,
   charges budget). The agent's *power* is inside; the *boundary* is outside.
5. **Provenance unchanged in spirit:** receipts (`ExecutionReceipt`, already has
   `externalActivity:"none"|"brokered"` + `networkPolicy`) record image digest, network mode, and
   the proxy egress log. Determinism stays honest (`live-external-state` for network skills; never
   claim exact-rerun for a network result).

## DECISION TO CONFIRM WITH THE USER FIRST (don't skip)

A domain allowlist controls *where* traffic goes, not *what's in it*. Our curated `request_external`
adapters sanitize the query so only identifier tokens leave; arbitrary skill/`run_python` code
hitting an allowlisted host could encode a private value into the request. Resolve before building:
- **(a)** TLS-intercepting proxy (CA cert in the image) so it can cap/inspect **payloads**, not just
  destinations — strongest, more work; OR
- **(b)** keep the curated adapters as the preferred sanitized path and gate raw network egress to
  **reviewed skill scripts only** (not arbitrary `run_python`); OR
- **(c)** in a network-enabled job, keep `run_python` on the **sealed** side and grant egress only to
  reviewed skills + curated adapters.
Recommend defaulting to **(a)+(c)** for the strongest anti-exfiltration while preserving the uniform
"everything in the container" model. Get the user's call.

## What's already built (Tier 1 — build on it, don't redo)

On `ssb1` (uncommitted at handoff time): the free-form agent already brokers curated lookups
(`request_external`, 6 adapters, real run IDs, egress-filtered, capped, response-quarantined) and
runs offline skills (`use_skill` via the host gateway). Pure gate `evaluateExternalRequest` +
`buildRunTokenSet` are unit-tested (`ai-sidecar/tests/freeform-broker.test.ts`). Live-verified
(haiku-4.5): agent queried UniProt `P04075` → into the package. See memory
`deep-research-tier1-agent-broker.md` and the existing design doc
`docs/handoffs/deep-research-tier2-network-skills.md` (the egress-sandbox design — **this handoff
unifies it**: instead of a *separate* network sandbox + host gateway, make ONE container model with
two network modes; update that doc to match as you go).

## Work breakdown (suggested)

1. Confirm the DECISION above with the user.
2. Build the container image(s) with the scientific stack; settle the build strategy.
3. Add a container-side skill runner: `use_skill` → `docker exec` into the jail (replace the host
   `SkillExecutionGateway` path for the free-form plane; keep or migrate the structured plane).
   Mount skills read-only; drop the offline per-script allowlist; remove `*_ai.py`.
4. Parametrize `startJail` for two network modes (`none` vs proxy-bridge).
5. Build the egress proxy sidecar (start simple: a small Node CONNECT forward proxy enforcing the
   allowlist + audit log; upgrade to TLS-intercept if decision (a)). Per-job bring-up/teardown.
6. Add `egressDomains` per network skill in `ai-sidecar/src/skills/scientific-catalog.ts`; derive the
   job allowlist from approved sources + skills; flip network skills' `readiness` to runnable once
   each passes a bounded egress smoke.
7. Wire receipts/provenance (image digest, network mode, egress log). Update config
   (`ai-sidecar/src/config.ts`) + `FreeformBrokerConfig` + `server.ts` construction.
8. Tests + live smoke.

## Security checklist (all must hold before enabling network mode)
- Container reaches the internet ONLY through the proxy (verify: a non-allowlisted host from inside
  fails closed). No DNS rebind / no IP-literal egress.
- Only approved frozen inputs mounted (read-only); no host FS; no secrets in container env.
- Every outbound request logged to the receipt; responses scrubbed + quarantined (`security.ts`).
- Rate/byte/time caps enforced and charged to the job budget.
- `bioservices` (GPL-3.0) isolated to the network image; never relabeled MIT.
- Offline mode stays `--network none`; phone-home `*_ai.py` scripts absent.
- Fail closed if proxy/image unavailable.

## Verification bar
From `ai-sidecar/`: `npm run typecheck` + `npm test` (currently 108 green; keep it green). Live smoke
on a completed run over a **throwaway port** (`PI_RUNTIME_PORT=4319` + isolated
`AI_INSIGHTS_DATABASE=<tmp>`) — **never kill or use :4317** (the user runs jobs there). Use
**haiku-4.5+** for the free-form smoke. Adapt `ai-sidecar/scripts/live-freeform-broker-smoke.ts`
(drives the full create→plan→approve→run→poll lifecycle) to also assert a skill ran *inside the
container* and (in network mode) that a non-allowlisted host is blocked.

## Key file anchors
- `ai-sidecar/src/research/freeform-executor.ts` — the jail (`startJail`/`execInJail`), the tools
  (`run_python`, `use_skill`, `request_external`, `read_skill`, `emit_findings`), `FreeformBrokerConfig`.
- `ai-sidecar/src/research/execution-gateway.ts` — the host skill runner to move into the container.
- `ai-sidecar/src/skills/scientific-catalog.ts` — policies, `networkPolicy`, `allowedScripts`,
  licences; add `egressDomains`.
- `ai-sidecar/src/security.ts` — `EXTERNAL_HOST_ALLOWLIST`, `assertExternalUrlAllowed`,
  `sanitizeExternalQuery`, `inspectPrompt`, `scrubOutput`.
- `ai-sidecar/src/research/external.ts` — the 6 curated adapters (precedent for safe egress).
- `ai-sidecar/docker/freeform-jail.Dockerfile` — the image to extend.
- `ai-sidecar/src/server.ts` (~line 110) — free-form plane construction / wiring.
- `docs/handoffs/deep-research-tier2-network-skills.md` — prior egress-sandbox design (unify it).

Start by confirming the DECISION with the user, then propose a concrete build plan before writing code.
