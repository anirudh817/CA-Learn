# Tier 3 — retire the `freeform` wire identifier (→ `open-investigation`)

**Status:** PLANNED, not started. Pick up from here.
**Prereq:** Tier 1+2 are DONE on `ssb1` (all user-visible "free-form"/"unconstrained + audited"/"jailed agent" text and UI-local CSS/JS identifiers renamed to **Open investigation** / **sandboxed**). This doc covers only the **wire/infra layer** that Tier 1+2 deliberately left untouched.
**Owner decision locked:** term = **Open investigation**, agent term = **sandboxed**, branch = `ssb1`, migration = read-time normalizer (no destructive DB migration).

---

## Why this is its own tier

`"freeform"` is not just a label — it is a **persisted wire value** and an **infra identifier**:

- It is written to SQLite (`research_jobs.workflow_id`) on every Open-investigation job (`service.ts:230` INSERT) and branched on as a string literal in five places.
- It names two **skill entrypoints** (`freeform-agent`, `freeform-synthesis`) used by the synthesis/executor dispatch and stored in `computations.skillId`.
- It is baked into **Docker infra**: image tag `signalfold-freeform-jail:1.0`, env `FREEFORM_JAIL_IMAGE`, container label `signalfold.freeform=1`, the `freeform-jail.Dockerfile`, and `run.sh`.
- It appears in **provenance strings** persisted in `computations` (`implementationKind: "pi-freeform-agent"`, `upstreamCommit: "signalfold-freeform-v1"`).

So a blind find/replace breaks existing jobs and orphans the Docker image. This plan renames everything **and** adds a back-compat normalizer so jobs created before the rename keep resolving.

## Target naming

| Concept | Old | New |
|---|---|---|
| Workflow wire id | `freeform` | `open-investigation` |
| Agent skill entrypoint | `freeform-agent` | `investigation-agent` |
| Synthesis skill entrypoint | `freeform-synthesis` | `investigation-synthesis` |
| Workflow const | `FREEFORM_WORKFLOW` | `OPEN_INVESTIGATION_WORKFLOW` |
| Executor class | `FreeformResearchExecutor` | `InvestigationResearchExecutor` |
| Jail config type | `FreeformJailConfig` | `InvestigationJailConfig` |
| Executor file | `src/research/freeform-executor.ts` | `src/research/investigation-executor.ts` |
| Dockerfile | `docker/freeform-jail.Dockerfile` | `docker/investigation-jail.Dockerfile` |
| Docker image | `signalfold-freeform-jail:1.0` | `signalfold-investigation-jail:1.0` |
| Env var | `FREEFORM_JAIL_IMAGE` | `INVESTIGATION_JAIL_IMAGE` |
| Container label | `signalfold.freeform=1` | `signalfold.investigation=1` |
| Config key | `research.freeformJail` | `research.investigationJail` |
| Server plane option | `researchFreeformPlane` / `freeformPlane` | `researchInvestigationPlane` / `investigationPlane` |
| Provenance `implementationKind` | `pi-freeform-agent` | `pi-investigation-agent` |
| Provenance `upstreamCommit` | `signalfold-freeform-v1` | `signalfold-investigation-v1` |

## Complete site inventory (file:line at time of writing — re-grep before editing)

**A. Wire id `"freeform"` literal + branches**
- `src/research/workflows.ts:136` — `id: "freeform"` (the registry id — the source of truth)
- `src/research/workflows.ts:156` — `findWorkflow` resolves via `FREEFORM_WORKFLOW.id`
- `src/research/workflows.ts:289` — `workflowId === "freeform"` throw guard (compose rejects the open id)
- `src/research/service.ts:526` — `job.workflowId === "freeform"` (synthesis step selection)
- `src/research/service.ts:560` — `input.workflow.id === "freeform"` (`freeformPaths`)
- `src/research/service.ts:853` — `job.workflowId === "freeform"` (plane dispatch)
- `src/research/synthesis/generic.ts:101` — `workflowId: "freeform"` (synthesis registry key)
- `public/app.js:643, 1229, 1487` — `workflowId !== "freeform"` / `=== "freeform"` (kept as-is in Tier 1+2)
- `public/app.js:1207, 1232` — `data-research-start="freeform"`, `data-research-workflow="freeform"` (DOM wire values)

**B. Skill entrypoints**
- `src/research/workflows.ts:149-150` — `freeform-agent` / `freeform-synthesis` skill defs
- `src/research/synthesis/generic.ts:7` — `const AGENT_SKILL = "freeform-agent"`
- `src/research/synthesis/generic.ts:100` — `id: "freeform-synthesis"`
- `src/research/freeform-executor.ts:174,177,178,179` — `freeform-agent` skill hash/identity/SKILL.md path
- `src/research/service.ts:931` — `implementationKind: "pi-freeform-agent"`

**C. Const / class / type**
- `src/research/workflows.ts:135` — `export const FREEFORM_WORKFLOW`
- `src/server.ts:110` — `FreeformResearchExecutor`, `researchFreeformPlane`, `freeformPlane`, `config.research.freeformJail`
- `src/research/freeform-executor.ts` — `FreeformResearchExecutor` class, `FreeformJailConfig` type, `DEFAULT_FREEFORM_JAIL` (line 26)

**D. Docker / jail infra**
- `src/config.ts:47,117-118` — `freeformJail` key, `FREEFORM_JAIL_IMAGE`, `signalfold-freeform-jail:1.0`
- `run.sh:8` — `JAIL_IMAGE="${FREEFORM_JAIL_IMAGE:-signalfold-freeform-jail:1.0}"`
- `run.sh:55` — `--filter label=signalfold.freeform=1`
- `run.sh:119` — comment "free-form jail containers"
- `src/research/freeform-executor.ts:180` — provenance `environment.id: "signalfold-freeform-jail"`
- `src/research/freeform-executor.ts:202` — `--label signalfold.freeform=1`
- `docker/freeform-jail.Dockerfile` — file rename + any in-file refs

**E. Provenance string**
- `src/research/freeform-executor.ts:178` — `upstreamCommit: "signalfold-freeform-v1"`

**F. Tests (update payloads + assertions)**
- `tests/research.test.ts:544-545,556,563,567,570,581,583` — `workflowId: "freeform"`, `freeform-agent`, `pi-freeform-agent`
- `tests/model-tiers.test.ts:74,83` — `workflowId: "freeform"`
- `tests/workflow-launcher.test.ts:121` — `composeLauncher(... "freeform" ...)` throw assertion

**G. Comments referencing the concept (sweep for consistency)**
- `src/research/service.ts:83`, `src/research/workflows.ts:131,229,232`, `public/app.js` comments at 643/1193/1229/1481-1487 (Tier 1+2 left the quoted `"freeform"` literal in comments where it documents the wire value).

## The migration (the critical part)

`research_jobs.workflow_id` already holds `"freeform"` for every existing Open-investigation job. After the rename, **new** jobs are created as `"open-investigation"`, but **old** rows still say `"freeform"`. Two layers fix this with zero data loss:

1. **`findWorkflow()` alias** (`workflows.ts`): resolve both ids to the one definition.
   ```ts
   const LEGACY_WORKFLOW_IDS: Record<string,string> = { freeform: "open-investigation" };
   export function findWorkflow(workflowId: string) {
     const id = LEGACY_WORKFLOW_IDS[workflowId] ?? workflowId;
     return id === OPEN_INVESTIGATION_WORKFLOW.id ? OPEN_INVESTIGATION_WORKFLOW
       : RESEARCH_WORKFLOWS.find((w) => w.id === id);
   }
   ```
2. **Read-time normalizer** in the job row hydrator (`service.ts`, wherever a DB row becomes a job object — the `SELECT … FROM research_jobs` mapper): set `workflowId = LEGACY_WORKFLOW_IDS[row.workflow_id] ?? row.workflow_id`. After this, **every** `=== "freeform"` branch becomes `=== "open-investigation"` and old jobs flow through transparently.

   → Then change the five branch literals (A above) to `"open-investigation"`. Do NOT leave any `=== "freeform"`; the normalizer guarantees the in-memory value is always the new id.

**No destructive UPDATE is required.** Optional one-time cleanup once verified:
`UPDATE research_jobs SET workflow_id='open-investigation' WHERE workflow_id='freeform';` — only if you want the DB itself clean. Keep the alias regardless (cheap, future-proofs old backups/bundles).

**Persisted skillId / implementationKind / event names need NO migration** — they are historical display records on completed computations, never re-dispatched. Rename them in the *dispatch* chain (B) so new jobs emit the new strings; old records keep their old strings (acceptable as history). If you want OCC to show a clean label for old records too, add a display alias in `operations.js` only.

## Sub-decisions

- **Jail event names (`jail_started`, `jail_stopped`, `agent_jail_started`).** RECOMMEND **keep** them — "jail" is accurate infra vocabulary, they are persisted in `ai_research_events`, and the user-facing wording was already fixed in Tier 1. Renaming them (e.g. `sandbox_started`) forces an OCC dual-read for old events for no user benefit. If renamed anyway: add `const LEGACY_EVENTS = { jail_started: "sandbox_started", … }` in `operations.js` shortname mapping and emit new names in `investigation-executor.ts`.
- **OCC raw `workflowId` display** (`operations.js:146,160`): after the id rename + alias, OCC shows `open-investigation` for new jobs; old jobs show `open-investigation` too *iff* the OCC job feed runs through `findWorkflow`/normalizer (verify the OCC API path hydrates via the same mapper). If OCC reads rows raw, add the same one-line normalize there.

## Execution order (resumable)

1. `workflows.ts`: rename const → `OPEN_INVESTIGATION_WORKFLOW`, `id: "open-investigation"`, skill ids → `investigation-agent`/`investigation-synthesis`; add `LEGACY_WORKFLOW_IDS` + alias in `findWorkflow`; fix the `:289` guard.
2. `synthesis/generic.ts`: `AGENT_SKILL`, synthesis `id`, `workflowId` → new values.
3. `service.ts`: read-time normalizer in the row hydrator; flip the three `=== "freeform"` branches; `implementationKind` → `pi-investigation-agent`; rename `freeformPaths`/`freeformPlane` locals; comment at :83.
4. `git mv freeform-executor.ts investigation-executor.ts`; rename class `InvestigationResearchExecutor`, type `InvestigationJailConfig`, `DEFAULT_*`, the skill identity strings, `environment.id`, `upstreamCommit`, label `signalfold.investigation=1`.
5. `git mv docker/freeform-jail.Dockerfile docker/investigation-jail.Dockerfile`; update in-file refs.
6. `config.ts`: `investigationJail` key, `INVESTIGATION_JAIL_IMAGE`, image tag.
7. `server.ts`: import path, class name, plane option/field names, config key.
8. `run.sh`: `JAIL_IMAGE`/env, label filter, Dockerfile path, comment, image tag.
9. `public/app.js` + `operations.js`: flip the kept `"freeform"` DOM/wire literals to `"open-investigation"`; OCC display normalizer if needed.
10. Tests (F): update payloads + assertions; add a regression test that a row with `workflow_id='freeform'` still resolves to Open investigation (proves the normalizer).

## Verification

- `cd ai-sidecar && npx tsc --noEmit` clean.
- `node --test` (full sidecar suite) green — especially the new legacy-id regression test.
- `./run.sh jail-build` rebuilds the renamed image; `./run.sh start ai` boots; `docker images | grep investigation-jail` present, no `freeform-jail` left.
- Live smoke: create an Open-investigation job end-to-end (use haiku-4.5+ or deepseek per current default), confirm it runs in the renamed jail, and confirm an OLD `freeform` job (from before the rename) still opens, shows its plan, and its OCC record renders.
- `rg -i "freeform" ai-sidecar` returns only the `LEGACY_WORKFLOW_IDS` alias entries (and, if kept, the jail event names) — nothing else.

## Rollback

All changes are on `ssb1`; revert the Tier 3 commit. The alias makes the rename forward-only-safe, so even a partial revert leaves old jobs resolvable. The Docker image rename is the only non-git artifact — `./run.sh jail-build` rebuilds whichever tag the reverted `config.ts` points to.
