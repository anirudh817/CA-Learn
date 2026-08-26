import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Opt-in live smoke that exercises the committed validation skills end-to-end
// against a running sidecar and a real completed run. Mirrors
// live-openrouter-smoke.ts: it talks to an already-running sidecar
// (start it with `./run.sh bg`) and never starts the server itself.

const root = path.join(import.meta.dirname, "..");
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
  }
}

assert.equal(process.env.LIVE_SKILLS_SMOKE, "1", "Set LIVE_SKILLS_SMOKE=1 to authorize the paid skills smoke");
const key = process.env.OPENROUTER_API_KEY || "";
const model = process.env.AI_DEV_OPENROUTER_MODEL || "openrouter/minimax/minimax-m3";
assert.ok(key.length >= 12, "OPENROUTER_API_KEY is missing");
assert.match(model, /^openrouter\/.+\/.+/, "AI_DEV_OPENROUTER_MODEL must use openrouter/vendor/model form");
const base = process.env.PI_RUNTIME_URL || `http://${process.env.PI_RUNTIME_HOST || "127.0.0.1"}:${process.env.PI_RUNTIME_PORT || "4317"}`;
const perTurnMax = Number(process.env.AI_LIVE_SMOKE_MAX_USD || 0.25);
const totalMax = Number(process.env.AI_LIVE_SKILLS_SMOKE_MAX_USD || perTurnMax * 6);

async function json(url: string, options: RequestInit = {}) {
  const response = await fetch(`${base}${url}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`Sidecar request failed ${url} (${response.status})`);
  return response.json() as Promise<any>;
}

async function runTurn(conversationId: string, message: string) {
  const response = await fetch(`${base}/api/conversations/${conversationId}/turns`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, model, policy: "standard", sources: [] }),
  });
  assert.equal(response.ok, true, `Turn failed (${response.status})`);
  const frames = (await response.text()).split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data:\s*/, "")));
  const answer = frames.filter((frame) => frame.type === "text_delta").map((frame) => frame.delta).join("");
  const usage = frames.find((frame) => frame.type === "usage");
  return { frames, answer, costUsd: Number(usage?.costUsd || 0) };
}

const health = await json("/api/health");
assert.equal(health.runtime, "single_pi_sidecar");
assert.equal(health.operationsCenter, true, "operations center must be enabled for this smoke");

// Capability preflight: tools registered, Python executable, no warnings.
const pre = await json("/api/operations/summary");
assert.ok(pre.capabilities.registeredTools.includes("bash"), "bash must be registered");
assert.ok(pre.capabilities.registeredTools.includes("save_artifact"), "save_artifact must be registered");
assert.equal(pre.capabilities.pythonExecutable, true, "pythonExecutable must be true");
assert.deepEqual(pre.warnings, [], `operations warnings must be cleared, saw: ${JSON.stringify(pre.warnings)}`);
assert.ok((pre.capabilities.discoveredSkills || []).length >= 4, "at least four skills must be discovered");

const runs = (await json("/api/runs")).runs;
assert.ok(runs.length, "No completed SignalFold run is available");
const runId = runs[0].id;

const skills = [
  { name: "sf-runtime-probe", sentinel: /SF_SKILL_PROBE_OK/, message: "Use the sf-runtime-probe skill. Read its SKILL.md and follow its steps exactly: run the listed shell commands, then finish with the required sentinel line." },
  { name: "sf-echo-script", sentinel: /SF_SKILL_ECHO_OK/, message: "Use the sf-echo-script skill. Read its SKILL.md, then run its bundled script with the bash tool and report the exact line the script printed." },
  { name: "sf-python-compute", sentinel: /SF_SKILL_PY_RESULT=5050/, message: "Use the sf-python-compute skill. Read its SKILL.md, write the Python file it describes with the write tool, run it with python3, and report the printed line." },
  { name: "sf-artifact-report", sentinel: /SF_SKILL_ARTIFACT=artifacts\//, artifact: true, message: "Use the sf-artifact-report skill. Read its SKILL.md and complete every step including running the bundled script, generating and running the Python, and calling the save_artifact tool. Finish with the SF_SKILL_ARTIFACT line." },
];

let totalCost = 0;
const results: Record<string, unknown>[] = [];
for (const skill of skills) {
  const created = await json("/api/conversations", { method: "POST", body: JSON.stringify({ runId, title: `skills smoke: ${skill.name}`, policy: "standard", model }) });
  const conversationId = created.conversation.id;
  const { answer, costUsd } = await runTurn(conversationId, skill.message);
  totalCost += costUsd;
  assert.match(answer, skill.sentinel, `${skill.name} did not emit its sentinel. Answer:\n${answer.slice(0, 600)}`);

  const turns = (await json(`/api/operations/turns?conversationId=${conversationId}`)).turns;
  assert.ok(turns.length, `${skill.name} produced no operational turn`);
  const detail = await json(`/api/operations/turns/${turns[0].id}`);
  const categories = new Set<string>(detail.events.map((event: { category: string }) => event.category));
  const executions = detail.events.filter((event: { category: string }) => ["tool", "skill", "python"].includes(event.category));
  assert.ok(executions.length > 0, `${skill.name} recorded no tool/skill/python execution frames`);
  if (skill.name === "sf-python-compute" || skill.name === "sf-artifact-report") assert.ok(categories.has("python"), `${skill.name} must record a python execution`);
  results.push({ skill: skill.name, costUsd, categories: [...categories], executions: executions.length });
}

// Artifact persistence (skill C): on disk AND in the artifact index.
const artifacts = (await json(`/api/artifacts?runId=${runId}`)).artifacts;
const report = artifacts.find((artifact: { kind: string }) => artifact.kind === "skill-report");
assert.ok(report, "sf-artifact-report did not register a skill-report artifact");
const dataDir = path.resolve(root, process.env.SIGNALFOLD_DATA_DIR || "../data");
const artifactAbs = path.join(dataDir, "runs", runId, "ai_insights", report.relPath);
assert.ok(fs.existsSync(artifactAbs), `registered artifact missing on disk: ${report.relPath}`);
const content = await fetch(`${base}/api/artifacts/${report.id}/content`);
assert.equal(content.ok, true, "artifact content endpoint must serve the file");

// Operations center reflects the runs.
const post = await json(`/api/operations/summary?runId=${runId}`);
assert.ok(post.stats.toolRuns > 0, "toolRuns must be > 0");
assert.ok(post.stats.skillRuns > 0, "skillRuns must be > 0");
assert.ok(post.stats.pythonRuns > 0, "pythonRuns must be > 0");
assert.deepEqual(post.warnings, [], "operations warnings must remain cleared after the runs");
assert.ok(totalCost <= totalMax, `Skills smoke cost $${totalCost.toFixed(4)} exceeded $${totalMax}`);

// Key-leak scan over the sidecar DB and the run AI directory.
const scanRoots = [path.join(dataDir, "ai_insights.sqlite"), path.join(dataDir, "runs", runId, "ai_insights")];
const files: string[] = [];
for (const target of scanRoots) {
  if (!fs.existsSync(target)) continue;
  if (fs.statSync(target).isFile()) files.push(target);
  else {
    const walk = (directory: string) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const absolute = path.join(directory, entry.name); entry.isDirectory() ? walk(absolute) : files.push(absolute); } };
    walk(target);
  }
}
for (const filename of files) assert.equal(fs.readFileSync(filename).includes(Buffer.from(key)), false, `Provider key leaked into ${path.relative(dataDir, filename)}`);

console.log(JSON.stringify({ ok: true, runId, model, totalCostUsd: Number(totalCost.toFixed(6)), stats: post.stats, registeredTools: post.capabilities.registeredTools, artifact: report.relPath, scannedFiles: files.length, results }, null, 2));
