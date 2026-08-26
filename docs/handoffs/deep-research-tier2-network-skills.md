# Deep Research — Tier 2: vendored NETWORK skills behind a brokered egress sandbox

> **SUPERSEDED/UNIFIED (2026-06-26):** the user chose a single uniform model — ALL skills
> (offline and network) run INSIDE one per-job container; the boundary is the container
> (`--network none`) plus an external egress proxy for network mode. Build per
> `deep-research-unified-container-handoff.md`; the egress-proxy design below still applies
> as the *network mode* of that single container (not a separate sandbox + host gateway).

**Status: BUILT + live-verified on `ssb1` (2026-06-26).** The unified-container model
shipped: offline skills run inside the sealed `--network none` jail (Stage 1), and the
network mode below was built as a per-job egress-proxied container with the user's
chosen `(a)+(c)` boundary (run_python always sealed; only reviewed network skills +
curated adapters egress, through a TLS-intercepting proxy). `pathway-enrichment` is the
first live network skill. What shipped, by file:
- `ai-sidecar/src/research/egress-policy.ts` (+ `tests/egress-policy.test.ts`) — pure
  allowlist derivation + exact-host match (IP-literal/subdomain/rebind refused) + outbound
  exfil scan. `ai-sidecar/src/security.ts:hostsForExternalSources` is the curated half.
- `ai-sidecar/docker/egress-proxy/proxy.mjs` + `egress-proxy.Dockerfile` + `gen-certs.sh`
  — the dependency-free Node TLS-intercept forward proxy (HTTPS CONNECT **and** plain-HTTP
  upgraded to HTTPS upstream — gseapy defaults Enrichr to `http://`), pre-minted per-host
  leaf certs, full audit log, byte/rate/time caps.
- `ai-sidecar/src/research/network-skill-runner.ts` — the per-job `--internal` bridge +
  proxy sidecar + net container (`docker/freeform-net.Dockerfile`), fail-closed bring-up/
  teardown, egress log + image digests folded into the `ExecutionReceipt`.
- Catalog `egressDomains` per network skill; `networkSkills` approval threaded plan→scope
  →executor (`research-scope.ts`, `service.ts`); `use_skill` routes by `networkPolicy`
  (`freeform-executor.ts`); config flag `AI_RESEARCH_NETWORK_SKILLS_ENABLED` (default off);
  `server.ts` wiring; `run.sh` `egress-build`/`net-build`/`net-clean`.
Verified with real containers: bypass-resistant topology (allowlisted reachable,
non-allowlisted + direct-bypass blocked), real `gseapy.enrichr` through the proxy, and a
paid model-driven Deep Research smoke (`scripts/live-network-skill-smoke.ts`) where the
agent chose `pathway-enrichment`, it ran approved-external with 3 audited egress requests.
The sections below are the original design (still accurate in spirit) — read them as the
rationale; the file list above is the as-built map.

**One-line:** Tier 1 lets the free-form agent corroborate against our **six curated
adapters** (UniProt / PubMed / PMC / Reactome / STRING / QuickGO) brokered out-of-band.
Tier 2 lets the agent run the **vendored network skills** themselves — `gget` (20+
genomic DBs), `bioservices` (40+ web services), `database-lookup` (78 REST DBs),
`pathway-enrichment` (Enrichr/g:Profiler/MSigDB), `citation-management` (CrossRef/
PubMed/arXiv) — inside a **domain-allowlisted egress sandbox**.

---

## 1. Why Tier 2 is separate (read first)

Three execution surfaces exist, in increasing risk. Keep them distinct:

| Surface | What runs there | Network | Where | Status |
|---|---|---|---|---|
| **Jail** (`--network none`) | the agent's **arbitrary** `run_python` | none | per-job Docker container | shipped |
| **Host gateway** (`SkillExecutionGateway`) | **reviewed OFFLINE** vendored skill scripts | proxy-blocked | host subprocess (uv/venv) | shipped (Tier 1) |
| **Egress sandbox** (this doc) | **reviewed NETWORK** vendored skill scripts | allowlisted | per-job Docker container + egress proxy | **TODO (Tier 2)** |

The danger Tier 2 introduces is the combination the brainstorm warned about — *reviewed-
but-arbitrary code + outbound network + private run context in one place*. The Tier 1
curated adapters are **bypass-resistant by construction**: we build every URL
(`external.ts:buildUrl`), sanitise every term (`security.ts:sanitizeExternalQuery`),
and assert the host (`assertExternalUrlAllowed`). A vendored skill builds **its own**
URLs, so we lose per-query inspection and must fall back to **network-layer domain
allowlisting**. That is a weaker guarantee, traded deliberately for breadth. Do not
ship Tier 2 by simply flipping the gateway's offline check — it has no egress control.

The gateway's current refusal is the seam to extend:
`ai-sidecar/src/research/execution-gateway.ts:29`
```ts
if (policy.networkPolicy !== "offline") throw new Error("Networked scientific scripts require a brokered egress boundary and are disabled");
```

---

## 2. Target architecture

```
free-form agent (in --network none jail)
      │  use_skill(skillId=gget, script=…, args=…)     ← ONE uniform tool (unchanged surface)
      ▼
ResearchService / FreeformResearchExecutor  ── routes by policy.networkPolicy ──┐
      │ offline  → SkillExecutionGateway (host, proxy-blocked)   [Tier 1]       │
      │ approved-external → NetworkSkillSandbox  [Tier 2, THIS DOC]             │
      ▼                                                                         │
 ┌───────────────────────────────┐        ┌──────────────────────────────┐     │
 │ skill container               │  HTTP  │ egress proxy (sidecar)        │     │
 │ vendored skill Python         │ ─────► │ - domain allowlist per skill  │ ──► internet
 │ frozen inputs RO, /tmp RW     │        │ - DNS-pin, no rebind          │  (only allowlisted hosts)
 │ --network = egress-net only   │        │ - rate/byte caps + audit log  │
 │ no host FS, no other egress   │        │ - response size cap           │
 └───────────────────────────────┘        └──────────────────────────────┘
      ▼
 receipt (externalActivity:"brokered", egress log, determinism:"live-external-state")
```

**Key invariant:** the skill container has **no direct route to the internet** — its
only network path is the proxy, and the proxy enforces the allowlist. Achieve this with
a dedicated Docker network whose only other member is the proxy, plus `--dns` pointed at
the proxy (or no DNS in the skill container and proxy-side name resolution). The
existing jail (`--network none`) and host gateway are untouched.

---

## 3. Components to build

### 3.1 Per-skill network policy (data)
Extend `ScientificSkillPolicy` in `ai-sidecar/src/skills/scientific-catalog.ts` with an
`egressDomains: string[]` per network skill, and a runnable `allowedScripts` list (today
the five network skills have `allowedScripts: []` and `readiness: "unavailable"`). Source
the domains from each skill's SKILL.md. Examples to confirm against the vendored packages:

- `gget` → `rest.ensembl.org`, `rest.uniprot.org`, `eutils.ncbi.nlm.nih.gov`, `www.ebi.ac.uk`, `rest.kegg.jp`, `alphafold.ebi.ac.uk`, `api.platform.opentargets.org`
- `bioservices` → `www.uniprot.org`, `rest.kegg.jp`, `www.ebi.ac.uk`, `reactome.org`, `string-db.org`, `www.ncbi.nlm.nih.gov`
- `database-lookup` → its 78-DB registry (gate to a reviewed subset first; do **not** allow the full registry on day one)
- `pathway-enrichment` → `maayanlab.cloud` (Enrichr), `biit.cs.ut.ee` (g:Profiler), `data.broadinstitute.org` (MSigDB)
- `citation-management` → `api.crossref.org`, `eutils.ncbi.nlm.nih.gov`, `export.arxiv.org` (NOT Google Scholar — scraping; keep prohibited)

Reuse `security.ts:EXTERNAL_HOST_ALLOWLIST` as the precedent and keep the proxy allowlist
in **one** place the receipt can cite.

### 3.2 `NetworkSkillSandbox` (new, mirror the jail)
New module `ai-sidecar/src/research/network-skill-sandbox.ts`, modelled on
`FreeformResearchExecutor.startJail` (`freeform-executor.ts:251`) but:
- `--network <egress-net>` (a dedicated user-defined bridge), **not** `--network none`.
- bring up the **egress proxy** as a sidecar container on that net (one per job, or a
  shared long-lived proxy keyed by allowlist — prefer per-job for clean teardown).
- `--read-only` rootfs, `--tmpfs /tmp`, mem/cpu/pids caps, `--security-opt no-new-privileges` (same as the jail).
- mount **only** the approved frozen inputs read-only (same freeze+chmod 0444 as the jail);
  decide whether the skill needs more than identifiers (most don't — it queries IDs).
- env: `HTTP_PROXY`/`HTTPS_PROXY` → the proxy; `NO_PROXY` empty; pin `REQUESTS_CA_BUNDLE` if the proxy does TLS interception.
- a separate pinned image with the network skills' deps (gget/bioservices/etc.) — a
  **second** Dockerfile beside `ai-sidecar/docker/freeform-jail.Dockerfile`. Keep
  `bioservices` (GPL-3.0) in this image only and **process-isolated** — never import it
  into the Node/host process; never relabel it MIT (see `scientific-catalog.ts:43`).

### 3.3 Egress proxy (new)
A forward proxy enforcing the per-skill allowlist. Options, simplest first:
- a tiny Node `http`/`https` `CONNECT` forward proxy (~100 lines) that checks the host
  against the allowlist and 403s everything else — easiest to audit, no extra image.
- or `tinyproxy`/`squid` with a generated allowlist ACL.
Must: pin DNS / reject IP-literal hosts (no DNS-rebind), cap response bytes, cap
requests/min, and **log every outbound request** (host, path-prefix, status, bytes,
sha256 of response) to the receipt. No request body inspection is assumed (the skill
builds its own queries) — the allowlist + audit log are the controls.

### 3.4 Uniform tool surface (small change)
Keep the agent's interface uniform (the deliberate Tier 1 decision). In
`freeform-executor.ts:use_skill`, route by policy instead of hard-listing offline ids:
```ts
const policy = SCIENTIFIC_SKILL_POLICIES.find(p => p.id === params.skillId);
if (policy?.networkPolicy === "offline")            → this.gateway.run(...)        // Tier 1
else if (policy?.networkPolicy === "approved-external" && tier2Enabled) → this.networkSandbox.run(...)  // Tier 2
else → blocked
```
The agent still sees one `use_skill`; the executor dispatches. Update the tool
description + `OFFLINE_SKILL_PURPOSE` map to include the network skills when Tier 2 is on.

### 3.5 Receipts / provenance
Reuse `ExecutionReceipt` (`execution-gateway.ts:12`) — it already has
`externalActivity: "none" | "brokered"` and `networkPolicy`. For Tier 2 set
`networkPolicy: "approved-external"`, `externalActivity: "brokered"`,
`determinism: "live-external-state"`, and attach the proxy's egress audit log
(host/status/bytes/responseSha256 per request) so a reviewer can audit exactly what left
and what came back. Responses re-entering the agent context must pass the same scrub as
Tier 1 (`security.ts:scrubOutput` + `inspectPrompt` quarantine).

### 3.6 Config + flag
Add to `config.ts:research`: `tier2NetworkSkillsEnabled` (default **false**),
`networkSkillImage`, proxy caps (`egressMaxRequests`, `egressMaxBytes`, `egressTimeoutMs`).
Wire into `FreeformBrokerConfig` (`freeform-executor.ts`) and the `server.ts:110`
construction, same shape as the Tier 1 external caps.

---

## 4. Security checklist (must all hold before enabling)
- [ ] Skill container reaches the internet **only** through the proxy (verify: `curl` a
      non-allowlisted host from inside the container fails closed).
- [ ] Proxy allowlist is per-skill and sourced from the catalog, not hardcoded ad hoc.
- [ ] No DNS rebind / no IP-literal egress.
- [ ] Only approved frozen inputs are mounted; no host FS; no other run's data.
- [ ] Every outbound request is logged into the receipt; responses scrubbed + quarantined.
- [ ] Rate/byte/time caps enforced and charged against the job budget.
- [ ] `bioservices` GPL-3.0 isolated to the Tier 2 image, process-isolated, licensed honestly.
- [ ] Fail closed: if the proxy or image is unavailable, the skill is unavailable (no host fallback) — mirror `freeform-executor.ts:254-255`.
- [ ] Determinism stamped `live-external-state`; never claim exact-rerun for a network skill.

## 5. Test plan
- Unit: allowlist accept/deny (incl. IP-literal, rebind, subdomain tricks); receipt egress-log shape.
- Integration (offline): inject a fake proxy; assert a denied host fails closed and an allowed host round-trips with an audit entry. Mirror `tests/freeform-broker.test.ts`.
- Bounded live smoke per skill: one query to one allowlisted host; flip catalog `readiness` `unavailable → smoke-tested` only after it passes (mirror the Tier 1 lock discipline in `scientific-skills.lock.json`).
- Negative: a skill that tries a non-allowlisted host is blocked and the job still completes with an honest "external lookup blocked" note.

## 6. Rollout
1. Land the proxy + sandbox behind `tier2NetworkSkillsEnabled=false`.
2. Enable **one** low-risk skill first (suggest `pathway-enrichment` — few, stable hosts).
3. Expand per-skill as each passes its bounded smoke + security checklist.
4. `database-lookup`'s 78-DB registry stays gated to a reviewed subset indefinitely.

## 7. Open decisions for the implementer
- Per-job proxy (clean teardown, slower) vs shared proxy keyed by allowlist (faster, must isolate jobs).
- TLS interception (lets you cap/inspect bodies, needs a CA in the image) vs CONNECT-passthrough (host-only control, simpler, recommended first).
- Whether network skills may read more than identifiers from frozen inputs (default: identifiers only).
- Cost model: charge per outbound request (like Tier 1's per-lookup `externalCostUsd`) vs per skill invocation.

---

## Anchors (so this is actionable cold)
- Tier 1 (built): `ai-sidecar/src/research/freeform-executor.ts` — `use_skill`, `request_external`, `evaluateExternalRequest`, `FreeformBrokerConfig`, `OFFLINE_EXECUTABLE_SKILLS`.
- Host gateway to extend: `ai-sidecar/src/research/execution-gateway.ts` (offline-only refusal at line ~29).
- Curated adapters (precedent for safe egress): `ai-sidecar/src/research/external.ts` + `ai-sidecar/src/security.ts` (`EXTERNAL_HOST_ALLOWLIST`, `assertExternalUrlAllowed`, `sanitizeExternalQuery`).
- Skill policies/licences/readiness: `ai-sidecar/src/skills/scientific-catalog.ts` (the five `approved-external` skills).
- Jail to mirror: `ai-sidecar/src/research/freeform-executor.ts:startJail` + `ai-sidecar/docker/freeform-jail.Dockerfile`.
- Wiring point: `ai-sidecar/src/server.ts:110` (free-form plane construction).
