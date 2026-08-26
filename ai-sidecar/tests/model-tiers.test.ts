import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildServer } from "../src/server.js";
import { createNarrator } from "../src/research/synthesis/narrator.js";
import type { ModelCatalog } from "../src/models.js";

// A deterministic, offline catalog: written to the cache file so ModelCatalog
// never reaches the network during the test (model-tier validation is
// catalog-gated, so this keeps the suite hermetic).
const CATALOG = [
  { id: "openrouter/minimax/minimax-m3", name: "MiniMax M3", provider: "openrouter", contextWindow: 128000, inputModalities: ["text"], toolCapable: true, promptCost: 0.3, completionCost: 1.2, cacheReadCost: null, intelligenceIndex: 44 },
  { id: "openrouter/openai/gpt-5.5", name: "GPT-5.5", provider: "openrouter", contextWindow: 200000, inputModalities: ["text"], toolCapable: true, promptCost: 5, completionCost: 30, cacheReadCost: null, intelligenceIndex: 55 },
  { id: "openrouter/z-ai/glm-5.2", name: "GLM 5.2", provider: "openrouter", contextWindow: 128000, inputModalities: ["text"], toolCapable: true, promptCost: 0.95, completionCost: 3, cacheReadCost: null, intelligenceIndex: 51 },
];

async function freshServer() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "sf-tiers-"));
  fs.mkdirSync(path.join(data, "runs", "RUN-1"), { recursive: true });
  fs.writeFileSync(path.join(data, "runs", "RUN-1", "artifact_index.json"), "{}");
  fs.writeFileSync(path.join(data, "ai_openrouter_models.json"), JSON.stringify({ fetchedAt: Date.now(), models: CATALOG }));
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite") });
  return app;
}

const enableAll = (app: Awaited<ReturnType<typeof buildServer>>) =>
  app.inject({ method: "PUT", url: "/api/settings/models", payload: { modelIds: CATALOG.map((model) => model.id) } });

test("model tiers: configure, then /api/config derives the default model from the default tier", async () => {
  const app = await freshServer();
  assert.equal((await enableAll(app)).statusCode, 200);

  const saved = await app.inject({ method: "PUT", url: "/api/settings/model-tiers", payload: {
    tiers: { high: "openrouter/openai/gpt-5.5", medium: "openrouter/minimax/minimax-m3", low: "openrouter/z-ai/glm-5.2" }, defaultTier: "high",
  } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().defaultModel, "openrouter/openai/gpt-5.5");

  const config = (await app.inject({ method: "GET", url: "/api/config" })).json();
  assert.equal(config.defaultTier, "high");
  assert.deepEqual(config.modelTiers, { high: "openrouter/openai/gpt-5.5", medium: "openrouter/minimax/minimax-m3", low: "openrouter/z-ai/glm-5.2" });
  // The default tier's model — NOT the first enabled model or the static env default.
  assert.equal(config.defaultModel, "openrouter/openai/gpt-5.5");

  // Re-pointing the default tier changes the default model.
  await app.inject({ method: "PUT", url: "/api/settings/model-tiers", payload: {
    tiers: { high: "openrouter/openai/gpt-5.5", medium: "openrouter/minimax/minimax-m3", low: "openrouter/z-ai/glm-5.2" }, defaultTier: "low",
  } });
  assert.equal((await app.inject({ method: "GET", url: "/api/config" })).json().defaultModel, "openrouter/z-ai/glm-5.2");
  await app.close();
});

test("model tiers: validation rejects unknown models, a missing default tier, and an unassigned default tier", async () => {
  const app = await freshServer();
  await enableAll(app);
  const unknown = await app.inject({ method: "PUT", url: "/api/settings/model-tiers", payload: { tiers: { high: "openrouter/nope/nope" }, defaultTier: "high" } });
  assert.equal(unknown.statusCode, 400);
  const missingDefault = await app.inject({ method: "PUT", url: "/api/settings/model-tiers", payload: { tiers: { high: "openrouter/minimax/minimax-m3" } } });
  assert.equal(missingDefault.statusCode, 400);
  const unassignedDefault = await app.inject({ method: "PUT", url: "/api/settings/model-tiers", payload: { tiers: { high: "openrouter/minimax/minimax-m3" }, defaultTier: "low" } });
  assert.equal(unassignedDefault.statusCode, 400);
  await app.close();
});

test("research job defaults to the MEDIUM tier when none is requested, an explicit model still wins, and it falls back to the default tier when medium is unset", async () => {
  const app = await freshServer();
  await enableAll(app);
  await app.inject({ method: "PUT", url: "/api/settings/model-tiers", payload: {
    tiers: { high: "openrouter/openai/gpt-5.5", medium: "openrouter/minimax/minimax-m3", low: "" }, defaultTier: "high",
  } });

  // Deep Research seeds from the MEDIUM tier — a balanced default for a long
  // agentic run — NOT the global default tier (here "high"), so the default
  // tier can't silently capture every research job.
  const fromMedium = await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId: "RUN-1", workflowId: "freeform", objective: "Probe the run", budgetUsd: 0 } });
  assert.equal(fromMedium.statusCode, 201);
  assert.equal(fromMedium.json().job.model, "openrouter/minimax/minimax-m3");

  // The OCC activity tab surfaces the model: the operations-view job carries it.
  const occ = (await app.inject({ method: "GET", url: "/api/operations/research?runId=RUN-1" })).json();
  const occJob = occ.jobs.find((job: { id: string }) => job.id === fromMedium.json().job.id);
  assert.equal(occJob.model, "openrouter/minimax/minimax-m3");

  // An explicit per-job model still wins over the medium default.
  const explicit = await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId: "RUN-1", workflowId: "freeform", objective: "Probe again", model: "openrouter/openai/gpt-5.5", budgetUsd: 0 } });
  assert.equal(explicit.json().job.model, "openrouter/openai/gpt-5.5");

  // When no medium tier is assigned, the default falls back to the default tier.
  await app.inject({ method: "PUT", url: "/api/settings/model-tiers", payload: {
    tiers: { high: "openrouter/openai/gpt-5.5", medium: "", low: "" }, defaultTier: "high",
  } });
  const fallback = await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId: "RUN-1", workflowId: "freeform", objective: "Probe fallback", budgetUsd: 0 } });
  assert.equal(fallback.json().job.model, "openrouter/openai/gpt-5.5");
  await app.close();
});

test("synthesis narrator honors the job's selected model (no forced Claude) and falls back to the default", () => {
  // keyResolver returns a key for every provider — the old behavior forced
  // anthropic/claude-sonnet-4-5 here; honoring the selection must not.
  const narrator = createNarrator({} as unknown as ModelCatalog, () => "present", "openrouter/minimax/minimax-m3");
  assert.equal(narrator.pickModel("local", "openrouter/openai/gpt-5.5"), "openrouter/openai/gpt-5.5");
  assert.equal(narrator.pickModel("local", "anthropic/claude-opus-4.8"), "anthropic/claude-opus-4.8");
  assert.equal(narrator.pickModel("local", ""), "openrouter/minimax/minimax-m3");
});
