import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Opt-in PAID live smoke for the Tier-1 brokered free-form plane. Drives the full
// Deep Research free-form lifecycle against an already-running sidecar and a real
// completed run, and proves end-to-end that the jailed agent brokers a curated
// external lookup (request_external → real UniProt) bound to the run's identifiers.
// Talks to an already-running sidecar (start one on a THROWAWAY port — never 4317).
//   LIVE_FREEFORM_SMOKE=1 PI_RUNTIME_PORT=4319 \
//   AI_FREEFORM_SMOKE_MODEL=openrouter/anthropic/claude-haiku-4.5 \
//   npx tsx scripts/live-freeform-broker-smoke.ts

const root = path.join(import.meta.dirname, "..");
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
}

assert.equal(process.env.LIVE_FREEFORM_SMOKE, "1", "Set LIVE_FREEFORM_SMOKE=1 to authorize the paid smoke");
const model = process.env.AI_FREEFORM_SMOKE_MODEL || process.env.AI_DEV_OPENROUTER_MODEL || "openrouter/anthropic/claude-haiku-4.5";
const base = process.env.PI_RUNTIME_URL || `http://${process.env.PI_RUNTIME_HOST || "127.0.0.1"}:${process.env.PI_RUNTIME_PORT || "4319"}`;
const budgetUsd = Number(process.env.AI_FREEFORM_SMOKE_BUDGET_USD || 0.6);
const maxUsd = Number(process.env.AI_FREEFORM_SMOKE_MAX_USD || 1.0);
const timeoutMs = Number(process.env.AI_FREEFORM_SMOKE_TIMEOUT_MS || 10 * 60_000);

const json = async (url: string, options: RequestInit = {}) => {
  const response = await fetch(`${base}${url}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`${options.method || "GET"} ${url} → ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json() as Promise<any>;
};

const health = await json("/api/health");
assert.equal(health.runtime, "single_pi_sidecar", "sidecar not reachable on this port");
const runId = process.env.RUN_ID || (await json("/api/runs")).runs?.[0]?.id;
assert.ok(runId, "no completed run available");
console.log(`[smoke] base=${base} run=${runId} model=${model} budget=$${budgetUsd}`);

const objective = [
  "From the differential-expression table, identify the single protein with the smallest adjusted p-value.",
  "(1) First profile that table with the exploratory-data-analysis skill via use_skill.",
  "(2) Then corroborate the top protein's identity by calling request_external against UniProt with its gene/protein identifier.",
  "Report the protein, its run statistics (cite the inputs/ row), and the UniProt corroboration.",
  "You MUST attempt at least one request_external call.",
].join(" ");

const { job } = await json("/api/research/jobs", { method: "POST", body: JSON.stringify({ runId, workflowId: "freeform", objective, model, budgetUsd }) });
const jobId = job.id;
console.log(`[smoke] created job ${jobId}`);
await json(`/api/research/jobs/${jobId}/plan`, { method: "POST", body: "{}" });
await json(`/api/research/jobs/${jobId}/plan`, { method: "PATCH", body: JSON.stringify({ sources: ["uniprot", "pubmed"], maxCostUsd: budgetUsd }) });
await json(`/api/research/jobs/${jobId}/approve`, { method: "POST", body: "{}" });
await fetch(`${base}/api/research/jobs/${jobId}/run`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json", "idempotency-key": `smoke-${jobId}` } });
console.log(`[smoke] approved + queued; polling events…`);

const seen = { code_run: 0, skill_run: 0, external_lookup: 0, external_blocked: 0, findings_emitted: 0 };
const externalDetails: any[] = [];
let after = 0, state = "running", deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  const text = await (await fetch(`${base}/api/research/jobs/${jobId}/events?after=${after}`)).text();
  for (const block of text.split("\n\n")) {
    const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) continue;
    let event: any; try { event = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
    if (typeof event.id === "number") after = Math.max(after, event.id);
    const name = String(event.name || "");
    if (name === "agent_code_run") seen.code_run++;
    else if (name === "agent_skill_run") seen.skill_run++;
    else if (name === "agent_external_lookup") { seen.external_lookup++; externalDetails.push(event.payload || event); }
    else if (name === "agent_external_blocked") seen.external_blocked++;
    else if (name === "agent_findings_emitted") seen.findings_emitted++;
    else if (name === "job_completed") state = "completed";
    else if (name === "job_failed") state = "failed";
  }
  if (state !== "running") break;
  await new Promise((resolve) => setTimeout(resolve, 2500));
}

const final = await json(`/api/research/jobs/${jobId}`);
const spend = Number(final.spendUsd ?? final.job?.spendUsd ?? 0);
console.log(`[smoke] state=${state} spend=$${spend.toFixed(4)} activity=${JSON.stringify(seen)}`);
for (const detail of externalDetails) console.log(`   external_lookup → ${JSON.stringify({ source: detail.source, term: detail.term, status: detail.status, ok: detail.ok, seenInRun: detail.seenInRun, privateValuesSent: detail.privateValuesSent })}`);

assert.equal(state, "completed", `job did not complete (state=${state})`);
assert.ok(seen.skill_run >= 1, "agent never ran a vendored skill IN the jail — Stage 1 (use_skill via docker exec) not exercised");
assert.ok(seen.external_lookup >= 1, "agent never brokered a request_external lookup — Tier 1 corroboration not exercised");
assert.ok(externalDetails.every((detail) => detail.privateValuesSent === false), "a lookup did not assert privateValuesSent:false");
assert.ok(spend <= maxUsd, `spend $${spend} exceeded cap $${maxUsd}`);
console.log(`[smoke] PASS — ran ${seen.skill_run} in-jail skill(s), brokered ${seen.external_lookup} external lookup(s), ${seen.code_run} code cell(s); job completed within budget.`);
