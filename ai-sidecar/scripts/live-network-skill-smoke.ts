import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Opt-in PAID live smoke for NETWORK MODE: a reviewed network skill
// (pathway-enrichment) running in a per-job container behind the TLS-intercepting
// egress proxy. Drives the full Deep Research lifecycle against an already-running
// sidecar (start one on a THROWAWAY port — never 4317) that has network mode on:
//   LIVE_NETWORK_SMOKE=1 PI_RUNTIME_PORT=4319 AI_RESEARCH_NETWORK_SKILLS_ENABLED=1 \
//   AI_NET_SMOKE_MODEL=openrouter/anthropic/claude-haiku-4.5 \
//   npx tsx scripts/live-network-skill-smoke.ts
// Asserts the agent ran pathway-enrichment via the NETWORK runner (networkPolicy
// approved-external) and that its egress went through the proxy (audited).

const root = path.join(import.meta.dirname, "..");
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
}

assert.equal(process.env.LIVE_NETWORK_SMOKE, "1", "Set LIVE_NETWORK_SMOKE=1 to authorize the paid smoke");
const model = process.env.AI_NET_SMOKE_MODEL || process.env.AI_DEV_OPENROUTER_MODEL || "openrouter/anthropic/claude-haiku-4.5";
const base = process.env.PI_RUNTIME_URL || `http://${process.env.PI_RUNTIME_HOST || "127.0.0.1"}:${process.env.PI_RUNTIME_PORT || "4319"}`;
const budgetUsd = Number(process.env.AI_NET_SMOKE_BUDGET_USD || 0.8);
const maxUsd = Number(process.env.AI_NET_SMOKE_MAX_USD || 1.5);
const timeoutMs = Number(process.env.AI_NET_SMOKE_TIMEOUT_MS || 12 * 60_000);

const json = async (url: string, options: RequestInit = {}) => {
  const response = await fetch(`${base}${url}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`${options.method || "GET"} ${url} → ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json() as Promise<any>;
};

const health = await json("/api/health");
assert.equal(health.runtime, "single_pi_sidecar", "sidecar not reachable on this port");
const config = await json("/api/config");
assert.equal(config.research?.networkSkillsEnabled, true, "sidecar does not have network skills enabled (AI_RESEARCH_NETWORK_SKILLS_ENABLED=1)");
const runId = process.env.RUN_ID || (await json("/api/runs")).runs?.[0]?.id;
assert.ok(runId, "no completed run available");
console.log(`[net-smoke] base=${base} run=${runId} model=${model} budget=$${budgetUsd}`);

const objective = [
  "Find the ~15 most differentially-expressed proteins in this run (smallest adjusted p-values in the DE table).",
  "(1) Use run_python to write their gene/protein symbols, one per line, to outputs/hits.txt.",
  "(2) Then run over-representation analysis with the pathway-enrichment skill: read_skill('pathway-enrichment') first, then",
  "use_skill('pathway-enrichment','scripts/run_enrichment.py',['ora','--genes','outputs/hits.txt','--libraries','KEGG_2021_Human','--outdir','outputs/enrichment']).",
  "(3) Report the top over-represented pathways with adjusted p-values, citing the inputs/ rows for the proteins.",
  "You MUST run the pathway-enrichment skill (network) at least once.",
].join(" ");

const { job } = await json("/api/research/jobs", { method: "POST", body: JSON.stringify({ runId, workflowId: "freeform", objective, model, budgetUsd }) });
const jobId = job.id;
console.log(`[net-smoke] created job ${jobId}`);
await json(`/api/research/jobs/${jobId}/plan`, { method: "POST", body: "{}" });
await json(`/api/research/jobs/${jobId}/plan`, { method: "PATCH", body: JSON.stringify({ sources: ["uniprot"], networkSkills: ["pathway-enrichment"], maxCostUsd: budgetUsd }) });
const approved = await json(`/api/research/jobs/${jobId}/approve`, { method: "POST", body: "{}" });
assert.ok((approved.job?.scope?.networkSkills || []).includes("pathway-enrichment"), "pathway-enrichment was not frozen into the approved scope.networkSkills");
await fetch(`${base}/api/research/jobs/${jobId}/run`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json", "idempotency-key": `net-smoke-${jobId}` } });
console.log(`[net-smoke] approved (scope.networkSkills=[pathway-enrichment]) + queued; polling…`);

const seen = { code_run: 0, skill_run: 0, network_skill_run: 0, egress_requests: 0, findings_emitted: 0 };
const skillDetails: any[] = [];
let after = 0, state = "running", deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  const text = await (await fetch(`${base}/api/research/jobs/${jobId}/events?after=${after}`)).text();
  for (const block of text.split("\n\n")) {
    const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) continue;
    let event: any; try { event = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
    if (typeof event.id === "number") after = Math.max(after, event.id);
    const name = String(event.name || "");
    const payload = event.payload || event;
    if (name === "agent_code_run") seen.code_run++;
    else if (name === "agent_skill_run") { seen.skill_run++; if (payload.networkPolicy === "approved-external") { seen.network_skill_run++; seen.egress_requests += Number(payload.egress || 0); skillDetails.push(payload); } }
    else if (name === "agent_findings_emitted") seen.findings_emitted++;
    else if (name === "job_completed") state = "completed";
    else if (name === "job_failed") state = "failed";
  }
  if (state !== "running") break;
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

const final = await json(`/api/research/jobs/${jobId}`);
const spend = Number(final.spendUsd ?? final.job?.spendUsd ?? 0);
console.log(`[net-smoke] state=${state} spend=$${spend.toFixed(4)} activity=${JSON.stringify(seen)}`);
for (const detail of skillDetails) console.log(`   network skill_run → ${JSON.stringify({ skillId: detail.skillId, exitCode: detail.exitCode, egress: detail.egress, networkPolicy: detail.networkPolicy })}`);

assert.equal(state, "completed", `job did not complete (state=${state})`);
assert.ok(seen.network_skill_run >= 1, "the agent never ran a NETWORK skill via the egress runner (networkPolicy approved-external) — network mode not exercised");
assert.ok(seen.egress_requests >= 1, "the network skill made no egress request through the proxy");
assert.ok(spend <= maxUsd, `spend $${spend} exceeded cap $${maxUsd}`);
console.log(`[net-smoke] PASS — ran ${seen.network_skill_run} network skill(s) with ${seen.egress_requests} proxied egress request(s); job completed within budget.`);
