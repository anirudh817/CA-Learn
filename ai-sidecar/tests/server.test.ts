import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import type { RuntimeFrame, TurnRequest } from "../src/runtime.js";

class FakeRuntime {
  aborted = false;
  async *turn(request: TurnRequest): AsyncGenerator<RuntimeFrame> {
    yield { type: "message_start", role: "assistant" };
    yield { type: "thinking_delta", delta: "Checked the run evidence." };
    yield { type: "text_delta", delta: `Grounded on ${request.runId}` };
    yield { type: "usage", provider: "openrouter", model: request.model, inputTokens: 3, outputTokens: 4, costUsd: 0.0001 };
    yield { type: "done" };
  }
  async abort(): Promise<void> { this.aborted = true; }
  async reset(): Promise<void> { this.aborted = false; }
}

class ErrorRuntime extends FakeRuntime {
  async *turn(): AsyncGenerator<RuntimeFrame> {
    yield { type: "message_start", role: "assistant" };
    yield { type: "error", message: "Provider rejected the request", kind: "provider" };
    yield { type: "done" };
  }
}

class HangingRuntime extends FakeRuntime {
  async *turn(): AsyncGenerator<RuntimeFrame> {
    yield { type: "message_start", role: "assistant" };
    await new Promise(() => undefined);
  }
}

class ControlledHangingRuntime extends FakeRuntime {
  started: Promise<void>;
  private markStarted!: () => void;
  constructor() {
    super();
    this.started = new Promise((resolve) => { this.markStarted = resolve; });
  }
  async *turn(): AsyncGenerator<RuntimeFrame> {
    this.markStarted();
    yield { type: "message_start", role: "assistant" };
    await new Promise(() => undefined);
  }
}

class EmptyRuntime extends FakeRuntime {
  async *turn(): AsyncGenerator<RuntimeFrame> {
    yield { type: "message_start", role: "assistant" };
    yield { type: "done" };
  }
}

class OperationalRuntime extends FakeRuntime {
  async *turn(request: TurnRequest): AsyncGenerator<RuntimeFrame> {
    yield { type: "operation", event: { category: "runtime", name: "session_created", status: "complete", payload: { registeredTools: ["python_exec"] } } };
    yield { type: "operation", event: { category: "grounding", name: "grounding_selected", status: "complete", payload: {
      includedBytes: 19, files: [{ path: "stage1/result.csv", includedBytes: 19, availableBytes: 19, truncated: false }],
    } } };
    yield { type: "operation", event: { category: "prompt", name: "prompt_composed", status: "complete", payload: {
      prompt: `Grounded prompt for ${request.runId}`, characters: 27, sha256: "test-hash", providerToken: "must-not-survive",
    } } };
    yield { type: "skill_start", skillName: "table-summary" };
    yield { type: "python_start", script: "scripts/summarize_table.py", command: "OPENROUTER_API_KEY=sk-or-secret-value python3 summarize_table.py" };
    yield { type: "python_end", script: "scripts/summarize_table.py", exitCode: 0, output: "ok" };
    yield { type: "skill_end", skillName: "table-summary" };
    yield { type: "text_delta", delta: `Grounded on ${request.runId}` };
    yield { type: "usage", provider: "openrouter", model: request.model, inputTokens: 3, outputTokens: 4, costUsd: 0.0001 };
    yield { type: "done" };
  }
  diagnostics() {
    return { implementation: "OperationalRuntime", activeSessions: 1, sessions: [], registeredTools: ["python_exec"] };
  }
}

test("public API supports run selection, conversations, SSE turns, notes, and artifacts", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "signalfold-sidecar-"));
  fs.mkdirSync(path.join(data, "runs", "RUN-1"), { recursive: true });
  fs.writeFileSync(path.join(data, "runs", "RUN-1", "artifact_index.json"), "{}");
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), runtime: new FakeRuntime() });
  const runs = await app.inject({ method: "GET", url: "/api/runs" });
  assert.deepEqual(runs.json().runs.map((run: { id: string }) => run.id), ["RUN-1"]);
  const created = await app.inject({ method: "POST", url: "/api/conversations", payload: { runId: "RUN-1", title: "Test" } });
  assert.equal(created.statusCode, 201);
  const id = created.json().conversation.id;
  const switched = await app.inject({ method: "PATCH", url: `/api/conversations/${id}`, payload: { model: "openrouter/test/model" } });
  assert.equal(switched.statusCode, 200);
  assert.equal(switched.json().conversation.model, "openrouter/test/model");
  assert.equal(switched.json().conversation.policy, "standard");
  const turn = await app.inject({ method: "POST", url: `/api/conversations/${id}/turns`, payload: { message: "Summarize", model: "openrouter/test/model", sources: ["pubmed"] } });
  assert.equal(turn.statusCode, 200);
  assert.match(turn.body, /text_delta/);
  assert.match(turn.body, /Grounded on RUN-1/);
  const thread = await app.inject({ method: "GET", url: `/api/conversations/${id}` });
  assert.equal(thread.json().messages.length, 2);
  assert.equal(thread.json().messages[1].provider, "openrouter");
  assert.deepEqual(thread.json().messages[1].trace, [{ label: "Reasoning", text: "Checked the run evidence." }]);
  const assistantId = thread.json().messages[1].id;
  const pin = await app.inject({ method: "POST", url: `/api/messages/${assistantId}/pin`, payload: { pinned: true } });
  assert.equal(pin.statusCode, 200);
  const feedback = await app.inject({ method: "POST", url: `/api/messages/${assistantId}/feedback`, payload: { rating: 1, note: "Keep this finding" } });
  assert.equal(feedback.statusCode, 201);
  const artifacts = await app.inject({ method: "GET", url: "/api/artifacts?runId=RUN-1" });
  assert.equal(artifacts.json().artifacts.some((artifact: { kind: string }) => artifact.kind === "notes"), true);
  await app.close();
});

test("mountable UI contract is served by the same sidecar", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "signalfold-sidecar-ui-"));
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), runtime: new FakeRuntime() });
  const index = await app.inject({ method: "GET", url: "/" });
  const component = await app.inject({ method: "GET", url: "/app.js" });
  const bootstrap = await app.inject({ method: "GET", url: "/bootstrap.js" });
  assert.match(index.body, /id="ai-insights-root"/);
  assert.match(index.body, /src="\/bootstrap\.js\?v=deep-research-v2"/);
  assert.doesNotMatch(index.body, /<script type="module">/);
  assert.match(component.body, /AIInsightsApp/);
  assert.match(component.body, /mount\(/);
  assert.match(component.body, /<select id="modelPicker"/);
  assert.doesNotMatch(component.body, /list="modelOptions"/);
  assert.match(component.body, /data-model-enabled/);
  // Every structured card is a launcher for the open-investigation path: it composes a
  // prompt and hands off to open investigation, never starting a fixed pipeline.
  assert.match(component.body, /data-research-compose/);
  assert.match(component.body, /Open in investigation/);
  assert.match(component.body, /Approve &amp; run/);
  assert.match(component.body, /data-research-action/);
  // Conversation cleanup: checkboxes are gated behind an opt-in select mode, not always shown.
  assert.match(component.body, /convSelectToggle/);
  assert.match(component.body, /toggleSelectMode/);
  assert.match(component.body, /state\.selectMode/);
  assert.match(component.body, /bulk-delete/);
  assert.match(component.body, /new AbortController\(\)/);
  assert.match(component.body, /signal: controller\.signal/);
  assert.match(component.body, /state\.turnController\?\.abort\(\)/);
  assert.match(component.body, /Artificial Analysis Intelligence Index/);
  assert.match(component.body, /Intelligence per dollar/);
  assert.match(component.body, /trace\.open = details\.open/);
  assert.match(bootstrap.body, /AIInsightsApp\.mount/);
  const operations = await app.inject({ method: "GET", url: "/operations" });
  assert.equal(operations.statusCode, 200);
  assert.match(operations.body, /Operational Control Center/);
  const operationsJs = await app.inject({ method: "GET", url: "/operations.js" });
  assert.match(operationsJs.body, /class="transcript"/);
  assert.match(operationsJs.body, /renderTrace\(/);
  assert.match(operationsJs.body, /triagePointer\(/);
  assert.match(operationsJs.body, /data-copy="pointer"/);
  assert.match(operationsJs.body, /navigator\.clipboard\.writeText/);
  await app.close();
});

test("developer operations center captures prompt, grounding, message flow, skill, and Python execution telemetry", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "signalfold-sidecar-operations-"));
  fs.mkdirSync(path.join(data, "runs", "RUN-OPS", "stage1"), { recursive: true });
  fs.writeFileSync(path.join(data, "runs", "RUN-OPS", "artifact_index.json"), "{}");
  fs.writeFileSync(path.join(data, "runs", "RUN-OPS", "stage1", "result.csv"), "gene,p\nAPOE,0.01\n");
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), runtime: new OperationalRuntime() });
  const created = await app.inject({ method: "POST", url: "/api/conversations", payload: { runId: "RUN-OPS" } });
  const conversationId = created.json().conversation.id;
  await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/turns`, payload: { message: "Ground this" } });

  const turns = await app.inject({ method: "GET", url: "/api/operations/turns?runId=RUN-OPS" });
  assert.equal(turns.statusCode, 200);
  assert.equal(turns.json().turns.length, 1);
  assert.equal(turns.json().turns[0].groundingFiles, 1);
  assert.equal(turns.json().turns[0].status, "complete");
  const detail = await app.inject({ method: "GET", url: `/api/operations/turns/${turns.json().turns[0].id}` });
  const events = detail.json().events;
  // Read-only transcript enrichment: full request, response, and reasoning/tooling trace.
  assert.equal(detail.json().request.role, "user");
  assert.equal(detail.json().request.content, "Ground this");
  assert.equal(detail.json().response.role, "assistant");
  assert.equal(detail.json().response.content.includes("Grounded on RUN-OPS"), true);
  assert.equal(Array.isArray(detail.json().response.trace), true);
  assert.equal(detail.json().response.trace.length > 0, true);
  assert.equal(events.some((event: any) => event.name === "prompt_composed" && event.payload.prompt.includes("Grounded prompt")), true);
  assert.equal(events.find((event: any) => event.name === "prompt_composed").payload.captureTruncated, false);
  assert.equal(events.some((event: any) => event.category === "grounding" && event.payload.files[0].path === "stage1/result.csv"), true);
  assert.equal(events.some((event: any) => event.category === "skill"), true);
  assert.equal(events.some((event: any) => event.category === "python"), true);
  assert.equal(detail.body.includes("must-not-survive"), false);
  assert.equal(detail.body.includes("sk-or-secret-value"), false);

  const summary = await app.inject({ method: "GET", url: "/api/operations/summary?runId=RUN-OPS" });
  assert.equal(summary.json().stats.pythonRuns, 1);
  assert.equal(summary.json().stats.skillRuns, 1);
  assert.equal(summary.json().capabilities.pythonExecutable, true);
  await app.close();
});

test("operations routes and recording disappear when developer mode is disabled", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "signalfold-sidecar-operations-off-"));
  fs.mkdirSync(path.join(data, "runs", "RUN-OFF"), { recursive: true });
  fs.writeFileSync(path.join(data, "runs", "RUN-OFF", "artifact_index.json"), "{}");
  const config = loadConfig({ SIGNALFOLD_DATA_DIR: data, AI_INSIGHTS_DATABASE: path.join(data, "ai.sqlite"), AI_DEVELOPER_MODE: "0", AI_OPERATIONS_CENTER: "1" });
  const app = await buildServer({ config, runtime: new OperationalRuntime() });
  assert.equal((await app.inject({ method: "GET", url: "/operations" })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/operations/turns" })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/config" })).json().operationsCenter, false);
  await app.close();
});

test("failed turns persist an explicit error instead of an empty Thinking message", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "signalfold-sidecar-error-"));
  fs.mkdirSync(path.join(data, "runs", "RUN-ERR"), { recursive: true });
  fs.writeFileSync(path.join(data, "runs", "RUN-ERR", "artifact_index.json"), "{}");
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), runtime: new ErrorRuntime() });
  const created = await app.inject({ method: "POST", url: "/api/conversations", payload: { runId: "RUN-ERR" } });
  const id = created.json().conversation.id;
  await app.inject({ method: "POST", url: `/api/conversations/${id}/turns`, payload: { message: "Summarize" } });
  const thread = await app.inject({ method: "GET", url: `/api/conversations/${id}` });
  const answer = thread.json().messages[1];
  assert.equal(answer.status, "failed");
  assert.match(answer.content, /Response failed: Provider rejected/);
  await app.close();
});

test("a stalled runtime is aborted at the configured turn deadline", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "signalfold-sidecar-timeout-"));
  fs.mkdirSync(path.join(data, "runs", "RUN-SLOW"), { recursive: true });
  fs.writeFileSync(path.join(data, "runs", "RUN-SLOW", "artifact_index.json"), "{}");
  const runtime = new HangingRuntime();
  const config = loadConfig({ SIGNALFOLD_DATA_DIR: data, AI_INSIGHTS_DATABASE: path.join(data, "ai.sqlite"), AI_PI_TURN_TIMEOUT_SECONDS: "0.05" });
  const app = await buildServer({ config, runtime });
  const created = await app.inject({ method: "POST", url: "/api/conversations", payload: { runId: "RUN-SLOW" } });
  const id = created.json().conversation.id;
  const turn = await app.inject({ method: "POST", url: `/api/conversations/${id}/turns`, payload: { message: "Summarize" } });
  assert.match(turn.body, /did not respond within 0.05 seconds/);
  assert.equal(runtime.aborted, true);
  const thread = await app.inject({ method: "GET", url: `/api/conversations/${id}` });
  assert.match(thread.json().messages[1].content, /turn was stopped/);
  await app.close();
});

test("manual stop ends a stalled turn without waiting for the provider", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "signalfold-sidecar-stop-"));
  fs.mkdirSync(path.join(data, "runs", "RUN-STOP"), { recursive: true });
  fs.writeFileSync(path.join(data, "runs", "RUN-STOP", "artifact_index.json"), "{}");
  const runtime = new ControlledHangingRuntime();
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), runtime });
  const created = await app.inject({ method: "POST", url: "/api/conversations", payload: { runId: "RUN-STOP" } });
  const id = created.json().conversation.id;
  const turnPromise = app.inject({ method: "POST", url: `/api/conversations/${id}/turns`, payload: { message: "Summarize" } });
  await runtime.started;
  const stopped = await app.inject({ method: "POST", url: `/api/conversations/${id}/abort`, payload: {} });
  assert.equal(stopped.statusCode, 200);
  const turn = await turnPromise;
  assert.match(turn.body, /Response stopped by the user/);
  const thread = await app.inject({ method: "GET", url: `/api/conversations/${id}` });
  assert.equal(thread.json().messages[1].status, "failed");
  await app.close();
});

test("empty provider completions are persisted as explicit failures", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "signalfold-sidecar-empty-"));
  fs.mkdirSync(path.join(data, "runs", "RUN-EMPTY"), { recursive: true });
  fs.writeFileSync(path.join(data, "runs", "RUN-EMPTY", "artifact_index.json"), "{}");
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), runtime: new EmptyRuntime() });
  const created = await app.inject({ method: "POST", url: "/api/conversations", payload: { runId: "RUN-EMPTY" } });
  const id = created.json().conversation.id;
  await app.inject({ method: "POST", url: `/api/conversations/${id}/turns`, payload: { message: "Summarize" } });
  const thread = await app.inject({ method: "GET", url: `/api/conversations/${id}` });
  assert.equal(thread.json().messages[1].status, "failed");
  assert.match(thread.json().messages[1].content, /returned no answer text/);
  await app.close();
});

test("configuration persists the models shown in the conversation dropdown", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "signalfold-sidecar-models-"));
  fs.mkdirSync(path.join(data, "runs", "RUN-MODELS"), { recursive: true });
  fs.writeFileSync(path.join(data, "runs", "RUN-MODELS", "artifact_index.json"), "{}");
  fs.writeFileSync(path.join(data, "ai_openrouter_models.json"), JSON.stringify({ fetchedAt: Date.now(), models: [{ id: "openrouter/test/model", name: "Test Model", provider: "openrouter", contextWindow: 100000, inputModalities: ["text"], toolCapable: true, promptCost: 1, completionCost: 3 }] }));
  fs.writeFileSync(path.join(data, "ai_openrouter_benchmarks.json"), JSON.stringify({ fetchedAt: Date.now(), scores: { "name:testmodel": 88.4 } }));
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), runtime: new FakeRuntime() });
  const models = await app.inject({ method: "GET", url: "/api/models" });
  assert.equal(models.json().models.find((model: { id: string }) => model.id === "openrouter/test/model").intelligenceIndex, 88.4);
  assert.equal(models.json().benchmark.label, "Artificial Analysis Intelligence Index");
  const saved = await app.inject({ method: "PUT", url: "/api/settings/models", payload: { modelIds: ["openrouter/test/model"], sortMode: "value" } });
  assert.equal(saved.statusCode, 200);
  const config = await app.inject({ method: "GET", url: "/api/config" });
  assert.deepEqual(config.json().enabledModels, ["openrouter/test/model"]);
  assert.equal(config.json().modelSort, "value");
  await app.close();

  const restarted = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), runtime: new FakeRuntime() });
  const afterRestart = await restarted.inject({ method: "GET", url: "/api/config" });
  assert.deepEqual(afterRestart.json().enabledModels, ["openrouter/test/model"]);
  assert.equal(afterRestart.json().modelSort, "value");
  await restarted.close();
});

test("configuration heals a stale display-name model preference", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "signalfold-sidecar-model-heal-"));
  fs.mkdirSync(path.join(data, "runs", "RUN-MODEL-HEAL"), { recursive: true });
  fs.writeFileSync(path.join(data, "runs", "RUN-MODEL-HEAL", "artifact_index.json"), "{}");
  fs.writeFileSync(path.join(data, "ai_openrouter_models.json"), JSON.stringify({ fetchedAt: Date.now(), models: [
    { id: "openrouter/test/model", name: "Test Model", provider: "openrouter", contextWindow: 100000, inputModalities: ["text"], toolCapable: true, promptCost: 0, completionCost: 0 },
    { id: "openrouter/minimax/minimax-m3", name: "MiniMax: MiniMax M3", provider: "openrouter", contextWindow: 100000, inputModalities: ["text"], toolCapable: true, promptCost: 0, completionCost: 0 },
  ] }));
  const config = loadConfig({ SIGNALFOLD_DATA_DIR: data, AI_INSIGHTS_DATABASE: path.join(data, "ai.sqlite"), AI_DEV_OPENROUTER_MODEL: "MiniMax M3" });
  const app = await buildServer({ config, runtime: new FakeRuntime() });
  const payload = await app.inject({ method: "GET", url: "/api/config" });
  assert.deepEqual(payload.json().enabledModels, ["openrouter/minimax/minimax-m3"]);
  assert.equal(payload.json().defaultModel, "openrouter/minimax/minimax-m3");
  const saved = await app.inject({ method: "PUT", url: "/api/settings/models", payload: { modelIds: ["openrouter/test/model"] } });
  assert.equal(saved.statusCode, 200);
  await app.close();
});
