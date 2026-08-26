import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DefaultResourceLoader, getAgentDir, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";
import { ModelCatalog } from "../src/models.js";
import { FilesystemRunCatalog } from "../src/run-catalog.js";
import { PiRuntime, executionCategory, persistArtifact, type RuntimeFrame, type TurnRequest } from "../src/runtime.js";
import { buildServer } from "../src/server.js";
import { AIStore } from "../src/store.js";

const SKILLS_DIR = path.resolve(import.meta.dirname, "..", "skills");
const SKILL_NAMES = ["sf-artifact-report", "sf-echo-script", "sf-python-compute", "sf-runtime-probe"];

function devRuntime(extra: Record<string, string> = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "sf-exec-"));
  const config = loadConfig({ SIGNALFOLD_DATA_DIR: data, AI_INSIGHTS_DATABASE: path.join(data, "ai.sqlite"), ...extra });
  const runs = new FilesystemRunCatalog(config.dataDir);
  const models = new ModelCatalog(config);
  const sink = (input: { relPath: string }) => ({ id: "art_test", relPath: input.relPath });
  return { runtime: new PiRuntime(config, runs, models, () => "test-key", sink), data };
}

test("interactive runtime can isolate exactly the four committed sf-* skills from the vendored catalog", () => {
  const result = loadSkillsFromDir({ dir: SKILLS_DIR, source: "test" });
  const interactive = result.skills.filter((skill) => skill.name.startsWith("sf-"));
  assert.deepEqual(interactive.map((skill) => skill.name).sort(), SKILL_NAMES);
  assert.ok(result.skills.some((skill) => skill.name === "exploratory-data-analysis"));
  for (const skill of interactive) {
    assert.ok(skill.description.length > 0, `${skill.name} has a description`);
    assert.ok(skill.filePath.endsWith("SKILL.md"), `${skill.name} points at SKILL.md`);
  }
});

test("getSkills() surfaces the injected skills the way sessionFor wires them", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sf-cwd-"));
  const catalog = loadSkillsFromDir({ dir: SKILLS_DIR, source: "signalfold-sidecar" });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    skillsOverride: (base) => ({ skills: [...base.skills, ...catalog.skills], diagnostics: base.diagnostics }),
  });
  await loader.reload();
  const discovered = loader.getSkills().skills.map((skill) => skill.name);
  for (const name of SKILL_NAMES) assert.ok(discovered.includes(name), `getSkills() includes ${name}`);
});

test("with execution enabled, diagnostics report real tools and discovered skills", () => {
  const { runtime } = devRuntime();
  const diagnostics = runtime.diagnostics();
  assert.deepEqual(diagnostics.registeredTools, ["read", "bash", "write", "edit", "save_artifact"]);
  assert.ok(diagnostics.registeredTools.some((name) => /python|bash|exec|skill/i.test(name)), "an execution tool is registered");
  assert.deepEqual((diagnostics.skills || []).slice().sort(), SKILL_NAMES);
});

test("production stays locked: dev mode off OR python disabled yields no tools and no skills", () => {
  const cases: Record<string, string>[] = [{ AI_DEVELOPER_MODE: "0" }, { AI_PYTHON_EXECUTION: "disabled" }];
  for (const extra of cases) {
    const { runtime } = devRuntime(extra);
    const diagnostics = runtime.diagnostics();
    assert.deepEqual(diagnostics.registeredTools, [], `registeredTools empty for ${JSON.stringify(extra)}`);
    assert.deepEqual(diagnostics.skills, [], `skills empty for ${JSON.stringify(extra)}`);
  }
});

test("executionCategory classifies python, skill, and tool calls deterministically", () => {
  assert.equal(executionCategory("bash", { command: "python3 compute.py" }), "python");
  assert.equal(executionCategory("bash", { command: "python --version" }), "python");
  assert.equal(executionCategory("read", { path: "/repo/ai-sidecar/skills/sf-echo-script/SKILL.md" }), "skill");
  assert.equal(executionCategory("bash", { command: "bash /repo/ai-sidecar/skills/sf-echo-script/scripts/echo.sh" }), "skill");
  assert.equal(executionCategory("write", { path: "compute.py", content: "print('SF_SKILL_PY_RESULT=5050')" }), "tool");
  assert.equal(executionCategory("edit", { path: "report.py" }), "tool");
  assert.equal(executionCategory("save_artifact", { sourcePath: "sf_report.csv", kind: "skill-report" }), "tool");
  assert.equal(executionCategory("bash", { command: "ls -la" }), "tool");
});

test("persistArtifact copies into ai_insights/artifacts/, registers via the sink, and refuses escapes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sf-artifact-"));
  const cwd = path.join(root, "work");
  const aiRoot = path.join(root, "ai_insights");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(aiRoot, { recursive: true });
  fs.writeFileSync(path.join(cwd, "sf_report.csv"), "metric,value\ngenes,3\n");
  const recorded: Array<{ relPath: string; kind: string }> = [];
  const sink = (input: { relPath: string; kind: string }) => { recorded.push(input); return { id: "art_1", relPath: input.relPath }; };

  const ok = persistArtifact({ cwd, aiRoot, sourcePath: "sf_report.csv", kind: "skill-report", mimeType: "text/csv", runId: "RUN-1", recordArtifact: sink });
  assert.equal(ok.error, undefined);
  assert.ok(ok.relPath && ok.relPath.startsWith("artifacts/"), "stored under artifacts/");
  assert.ok(fs.existsSync(path.join(aiRoot, ok.relPath!)), "artifact written to disk");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].kind, "skill-report");

  const escape = persistArtifact({ cwd, aiRoot, sourcePath: "../../etc/passwd", runId: "RUN-1", recordArtifact: sink });
  assert.equal(escape.error, "path-escape");
  const missing = persistArtifact({ cwd, aiRoot, sourcePath: "nope.csv", runId: "RUN-1", recordArtifact: sink });
  assert.equal(missing.error, "missing");
  assert.equal(recorded.length, 1, "refused saves do not register an artifact");
});

test("operationSummary increments tool/skill/python counts from seeded events", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "sf-summary-"));
  const store = new AIStore(path.join(data, "ai.sqlite"));
  const turn = store.startOperationTurn({ runId: "RUN-1", conversationId: "c1", userId: "local", model: "m", policy: "standard", questionPreview: "q" });
  store.appendOperationEvent(turn.id, { category: "skill", name: "skill_start", status: "running" });
  store.appendOperationEvent(turn.id, { category: "tool", name: "tool_start", status: "running" });
  store.appendOperationEvent(turn.id, { category: "python", name: "python_start", status: "running" });
  store.appendOperationEvent(turn.id, { category: "python", name: "python_end", status: "complete" });
  const summary = store.operationSummary("RUN-1");
  assert.equal(summary.skillRuns, 1);
  assert.equal(summary.toolRuns, 1);
  assert.equal(summary.pythonRuns, 1);
  store.close();
});

/** Mimics PiRuntime's real telemetry: categorized operation events (not frames). */
class ExecutionRuntime {
  async *turn(request: TurnRequest): AsyncGenerator<RuntimeFrame> {
    const op = (category: string, name: string, status: string, payload: Record<string, unknown> = {}): RuntimeFrame =>
      ({ type: "operation", event: { category, name, status, payload } });
    yield op("skill", "skill_start", "running", { toolName: "read", args: { path: "/repo/ai-sidecar/skills/sf-echo-script/SKILL.md" } });
    yield op("skill", "skill_end", "complete", { toolName: "read" });
    yield op("tool", "tool_start", "running", { toolName: "write", args: { path: "compute.py" } });
    yield op("tool", "tool_end", "complete", { toolName: "write" });
    yield op("python", "python_start", "running", { toolName: "bash", args: { command: "python3 compute.py" } });
    yield op("python", "python_end", "complete", { toolName: "bash" });
    yield { type: "text_delta", delta: `Grounded on ${request.runId}` };
    yield { type: "usage", provider: "openrouter", model: request.model, inputTokens: 5, outputTokens: 6, costUsd: 0.0002 };
    yield { type: "done" };
  }
  async abort(): Promise<void> {}
  async reset(): Promise<void> {}
  diagnostics() {
    return { implementation: "ExecutionRuntime", activeSessions: 1, sessions: [], registeredTools: ["read", "bash", "write", "edit", "save_artifact"], skills: SKILL_NAMES };
  }
}

test("operations center clears warnings and counts categories once execution tools are registered", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "sf-ops-exec-"));
  fs.mkdirSync(path.join(data, "runs", "RUN-EXEC"), { recursive: true });
  fs.writeFileSync(path.join(data, "runs", "RUN-EXEC", "artifact_index.json"), "{}");
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), runtime: new ExecutionRuntime() });
  const created = await app.inject({ method: "POST", url: "/api/conversations", payload: { runId: "RUN-EXEC" } });
  const conversationId = created.json().conversation.id;
  await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/turns`, payload: { message: "Run the validation skills" } });

  const summary = (await app.inject({ method: "GET", url: "/api/operations/summary?runId=RUN-EXEC" })).json();
  assert.deepEqual(summary.warnings, [], "no execution warnings remain");
  assert.equal(summary.capabilities.pythonExecutable, true);
  assert.ok(summary.capabilities.registeredTools.includes("bash"), "bash is registered");
  assert.ok(summary.capabilities.registeredTools.includes("save_artifact"), "save_artifact is registered");
  assert.deepEqual(summary.capabilities.discoveredSkills.slice().sort(), SKILL_NAMES);
  assert.equal(summary.stats.skillRuns, 1);
  assert.equal(summary.stats.toolRuns, 1);
  assert.equal(summary.stats.pythonRuns, 1);

  const turns = (await app.inject({ method: "GET", url: "/api/operations/turns?runId=RUN-EXEC" })).json();
  const detail = (await app.inject({ method: "GET", url: `/api/operations/turns/${turns.turns[0].id}` })).json();
  const categories = new Set(detail.events.map((event: { category: string }) => event.category));
  for (const category of ["skill", "tool", "python"]) assert.ok(categories.has(category), `trace has a ${category} event`);
  await app.close();
});
