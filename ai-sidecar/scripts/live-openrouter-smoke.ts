import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
  }
}
assert.equal(process.env.LIVE_OPENROUTER_SMOKE, "1", "Set LIVE_OPENROUTER_SMOKE=1 to authorize the paid smoke turn");
const key = process.env.OPENROUTER_API_KEY || "";
const model = process.env.AI_DEV_OPENROUTER_MODEL || "openrouter/minimax/minimax-m3";
assert.ok(key.length >= 12, "OPENROUTER_API_KEY is missing");
assert.match(model, /^openrouter\/.+\/.+/, "AI_DEV_OPENROUTER_MODEL must use openrouter/vendor/model form");
const base = process.env.PI_RUNTIME_URL || `http://${process.env.PI_RUNTIME_HOST || "127.0.0.1"}:${process.env.PI_RUNTIME_PORT || "4317"}`;
const maximum = Number(process.env.AI_LIVE_SMOKE_MAX_USD || 0.25);

async function json(url: string, options: RequestInit = {}) {
  const response = await fetch(`${base}${url}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`Sidecar request failed (${response.status})`);
  return response.json() as Promise<any>;
}

const health = await json("/api/health");
assert.equal(health.runtime, "single_pi_sidecar");
const runs = (await json("/api/runs")).runs;
assert.ok(runs.length, "No completed SignalFold run is available");
const selected = runs[0].id;
const created = await json("/api/conversations", { method: "POST", body: JSON.stringify({ runId: selected, title: "OpenRouter live smoke", policy: "standard", model }) });
const response = await fetch(`${base}/api/conversations/${created.conversation.id}/turns`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "In one short sentence, state the selected run ID and cite one evidence file path. Do not call external sources.", model, policy: "standard", sources: [] }),
});
assert.equal(response.ok, true, `Turn failed (${response.status})`);
const body = await response.text();
const frames = body.split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data:\s*/, "")));
const answer = frames.filter((frame) => frame.type === "text_delta").map((frame) => frame.delta).join("");
const usage = frames.find((frame) => frame.type === "usage");
assert.ok(answer.trim(), "Live provider returned no answer text");
assert.equal(usage?.provider, "openrouter");
assert.equal(usage?.model, model);
assert.ok(Number(usage.costUsd) <= maximum, `Smoke cost exceeded $${maximum}`);

const dataDir = path.resolve(root, process.env.SIGNALFOLD_DATA_DIR || "../data");
const scanRoots = [path.join(dataDir, "ai_insights.sqlite"), path.join(dataDir, "runs", selected, "ai_insights")];
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
console.log(JSON.stringify({ ok: true, runId: selected, model, answerChars: answer.length, costUsd: Number(usage.costUsd), scannedFiles: files.length }));
