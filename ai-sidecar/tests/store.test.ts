import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AIStore } from "../src/store.js";

test("conversation, turn snapshots, feedback revisions, and run costs persist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signalfold-ai-store-"));
  const store = new AIStore(path.join(root, "ai.sqlite"));
  const conversation = store.createConversation({ runId: "RUN-1", userId: "local", title: "APOE", policy: "standard" });
  const user = store.addMessage(conversation.id, "user", "Compare APOE", {
    requestedSources: ["pubmed"], effectiveSources: ["pubmed"], model: "openrouter/test/model",
  });
  const answer = store.addMessage(conversation.id, "assistant", "Grounded answer", {
    model: "openrouter/test/model", provider: "openrouter", status: "complete", inputTokens: 10,
    outputTokens: 20, costUsd: 0.001,
  });
  store.addFeedback(answer.id, "local", 1, "Useful");
  store.addFeedback(answer.id, "local", 1, "Useful, add the cohort name");
  assert.equal(store.listMessages(conversation.id).length, 2);
  assert.deepEqual(store.listMessages(conversation.id)[0].effectiveSources, ["pubmed"]);
  assert.equal(store.listFeedback(answer.id).length, 2);
  assert.equal(store.runCost("RUN-1"), 0.001);
  assert.equal(user.role, "user");
  store.close();
});

test("artifact paths cannot escape the run AI root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signalfold-ai-path-"));
  const store = new AIStore(path.join(root, "ai.sqlite"));
  assert.throws(() => store.addArtifact({ runId: "RUN-1", relPath: "../stage1/private.csv", kind: "table" }), /safe relative path/);
  store.close();
});

test("user model-menu preferences round-trip as JSON", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signalfold-ai-preferences-"));
  const store = new AIStore(path.join(root, "ai.sqlite"));
  assert.deepEqual(store.getPreference("local", "enabled_models", ["fallback"]), ["fallback"]);
  store.setPreference("local", "enabled_models", ["openrouter/vendor/model"]);
  assert.deepEqual(store.getPreference("local", "enabled_models", []), ["openrouter/vendor/model"]);
  store.close();
});
