# Handoff — bringing the remaining network skills online (per-skill readiness + bounded egress smoke)

> Self-contained. Branch **`ssb1`**. Pipeline-owned files are OFF-LIMITS
> (`backend/services/pipeline*.py`, stage runners, `backend/r_scripts/`). Don't commit unless asked.

## The point

The unified-container network mode is **built and live** (see
`deep-research-unified-container-handoff.md` + memory `deep-research-unified-container.md`).
`pathway-enrichment` is the **first and only** live network skill. The other four —
**`gget`, `bioservices`, `database-lookup`, `citation-management`** — are vendored, have
`egressDomains` declared in the catalog, and are wired to run through the exact same egress
proxy, but are deliberately kept `readiness: "unavailable"`.

**They are not simple on/off switches, and must not become them.** Each network skill is a
distinct outbound attack surface — a *wholesale vendor of a third-party repo*
(`github.com/K-Dense-AI/scientific-agent-skills`), only partially reviewed, building its own
URLs, running over private run data, with the internet on the other side of the proxy.
Enabling one (gseapy → Enrichr) validates *nothing* about the others: different hosts,
different request shapes, different libraries (one is GPL). So each is brought online
individually, only **after it passes a bounded egress smoke** — and "enabled" means a
deliberate code change (flip `readiness`), not a user toggle.

## Two gates, on purpose

| Gate | What it controls | Who flips it |
|---|---|---|
| **Master toggle** `networkSkillsEnabled` | the whole network *machinery* (egress proxy + per-job `--internal` bridge + net container) | the operator, via the settings panel (`PUT /api/settings/research`) or `AI_RESEARCH_NETWORK_SKILLS_ENABLED` |
| **Per-skill `readiness`** | whether *this specific* network skill may be approved + run | an engineer, in `scientific-catalog.ts`, **only after a bounded egress smoke** |

Both must hold. The toggle turns the machinery on; `readiness` is the safety gate that says
"this skill's egress has actually been proven." A user enabling network mode does **not**
silently enable an unproven skill.

### Where `readiness` is enforced (don't weaken these)
- `src/research/service.ts:sanitizeNetworkSkills` — a plan/scope may only approve a network
  skill whose `networkPolicy === "approved-external"` **and** `readiness !== "unavailable"`
  (and only when the master toggle resolves true). An unavailable skill is dropped from the
  frozen `scope.networkSkills`.
- `src/research/network-skill-runner.ts:run` — refuses (`throw`) any skill with
  `readiness === "unavailable"`, even if it somehow reached the runner. Defense in depth.
- The job egress allowlist (`src/research/egress-policy.ts:deriveJobEgressAllowlist`) is the
  union of approved curated sources' hosts + **approved** network skills' `egressDomains`. An
  unavailable skill is never approved, so it contributes no hosts — the proxy would refuse
  them anyway.

## Per-skill onboarding checklist (repeat for each of the four)

1. **Read the skill.** Open `ai-sidecar/skills/scientific/<id>/SKILL.md` + the reviewed
   script(s). Confirm exactly which hosts it contacts and which scripts are the sanctioned
   entry points. Note any phone-home / secondary-LLM scripts (already `prohibitedScripts` +
   stripped from the images via `find … -name '*_ai.py' -delete`).
2. **Trim `egressDomains` to the minimum** in `src/skills/scientific-catalog.ts`. Fewer hosts
   = smaller surface. For `database-lookup` keep the **reviewed subset only** — never the
   full 78-DB registry.
3. **Regenerate the proxy cert superset.** The proxy pre-mints a leaf cert per allowlisted
   host. After changing `egressDomains`, regenerate the host list + certs:
   ```
   cd ai-sidecar
   npx tsx -e 'import{deriveJobEgressAllowlist}from"./src/research/egress-policy.ts";import fs from"node:fs";\
   fs.writeFileSync("docker/egress-proxy/egress-hosts.txt",\
   deriveJobEgressAllowlist({sources:["uniprot","pubmed","pmc","reactome","string","quickgo"],\
   networkSkills:["pathway-enrichment","gget","bioservices","database-lookup","citation-management"]}).join("\n")+"\n")'
   rm -rf docker/.egress-certs && ./run.sh egress-build   # re-mint CA + leaves, rebuild proxy image
   ```
4. **Add deps to the net image** (`ai-sidecar/docker/freeform-net.Dockerfile`), pinned, then
   `./run.sh net-build`. **`bioservices` is GPL-3.0** — keep it isolated to this image, never
   import it into the Node/host process, and never relabel it MIT (`scientific-catalog.ts`
   already inventories it separately).
5. **Set `allowedScripts`** to the reviewed script(s); leave anything unreviewed in
   `restrictedScripts`.
6. **Run the bounded egress smoke (below).** It must prove: the skill reaches **only** its
   allowlisted hosts (200 + sane output), a non-allowlisted host is **blocked**, the egress
   audit shows only allowlisted hosts with no exfil, and (model-driven) the agent can pick it.
7. **Only then flip `readiness`** `"unavailable"` → `"smoke-tested"` and update `diagnostic`
   with the date + what passed (mirror the pathway-enrichment entry). Regenerate the lock if
   folder hashes changed (`npm run skills:lock`).
8. **Roll out one at a time.** Land each behind the same discipline; never batch-enable.

## The bounded egress smoke (concrete)

Two stages, both already have a template:

**A. Topology smoke (no model, fast)** — mirror the manual check used for `pathway-enrichment`:
stand up the proxy on a normal bridge + a `--internal` bridge, attach the net container to the
internal bridge with `HTTPS_PROXY=http://<proxy>:8080` and the baked CA, then:
- run the reviewed skill script (or a minimal call of its library) → expect success + sane output;
- `requests.get` a **non-allowlisted** host → expect a proxy block (`ProxyError`);
- attempt a **direct** request with the proxy disabled → expect failure (no off-box route);
- read the mounted egress audit (`audit-*.jsonl`) → only allowlisted hosts, statuses, per-request `durationMs`, no `blocked: outbound-exfil`.

**B. Model-driven smoke (paid, throwaway port — never :4317)** — adapt
`ai-sidecar/scripts/live-network-skill-smoke.ts`: set `networkSkills: ["<id>"]`, write an
objective that needs that skill, and assert a `skill_run` with `networkPolicy:
"approved-external"` + an egress audit entry. Run on a throwaway sidecar
(`PI_RUNTIME_PORT=4319 AI_RESEARCH_NETWORK_SKILLS_ENABLED=1`, isolated `AI_INSIGHTS_DATABASE`).
Use **haiku-4.5+**.

The OCC then shows the run's latency attribution + per-host egress (the observability added in
this milestone), so you can confirm the skill behaved.

## Per-skill notes / risks

- **`gget`** (`rest.ensembl.org`, `rest.uniprot.org`, `eutils.ncbi.nlm.nih.gov`,
  `www.ebi.ac.uk`, `rest.kegg.jp`, `alphafold.ebi.ac.uk`, `api.platform.opentargets.org`) —
  broadest host set; bring up the specific `gget` modules you trust, not the whole CLI.
- **`bioservices`** (GPL-3.0; `www.uniprot.org`, `rest.kegg.jp`, `www.ebi.ac.uk`,
  `reactome.org`, `string-db.org`, `www.ncbi.nlm.nih.gov`) — license + breadth risk; isolate
  to the net image, gate to a few reviewed services.
- **`database-lookup`** (reviewed subset only: `eutils.ncbi.nlm.nih.gov`, `rest.uniprot.org`,
  `www.ebi.ac.uk`) — its 78-DB registry stays gated to a reviewed subset **indefinitely**.
- **`citation-management`** (`api.crossref.org`, `eutils.ncbi.nlm.nih.gov`,
  `export.arxiv.org`) — `generate_schematic_ai.py` is a secondary-LLM phone-home, already
  `prohibitedScripts` + stripped; allow only `doi_to_bibtex` / `search_pubmed` /
  `format_bibtex` / `validate_citations`. No Google Scholar (scraping).

## If you ever want per-skill controls in the config panel

Do **not** expose raw on/off switches that flip `readiness`. The panel should at most *show*
each skill's readiness (read-only: "available" / "tested" / "unavailable") so an operator can
see what's live. Enablement stays a code + bounded-smoke act, because a UI on/off would let
someone enable an unproven egress path with one click — exactly what the per-skill gate exists
to prevent. (The master `networkSkillsEnabled` toggle is the only network control that
belongs in the panel, and it's already there.)

## Anchors
- Catalog + `readiness` + `egressDomains` + licences: `ai-sidecar/src/skills/scientific-catalog.ts`
  (the five `approved-external` entries; `pathway-enrichment` is the worked example).
- Net image: `ai-sidecar/docker/freeform-net.Dockerfile`. Proxy image + certs:
  `ai-sidecar/docker/egress-proxy.Dockerfile`, `docker/egress-proxy/gen-certs.sh`,
  `docker/egress-proxy/egress-hosts.txt`.
- Runner + gates: `ai-sidecar/src/research/network-skill-runner.ts`,
  `ai-sidecar/src/research/egress-policy.ts`, `ai-sidecar/src/research/service.ts`
  (`sanitizeNetworkSkills`).
- Smokes: `ai-sidecar/scripts/live-network-skill-smoke.ts` (model-driven), and the manual
  topology check pattern in memory `deep-research-unified-container.md`.
- `run.sh` targets: `egress-build`, `net-build`, `net-clean`, `egress-certs`.
