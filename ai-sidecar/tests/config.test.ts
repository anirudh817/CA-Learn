import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, loadLocalEnvFile, publicConfig } from "../src/config.js";

test("configuration keeps provider keys server-side", () => {
  const config = loadConfig({
    SIGNALFOLD_DATA_DIR: "/tmp/signalfold",
    OPENROUTER_API_KEY: "sk-or-secret",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    AI_DEV_ALLOWED_MODELS: "openrouter/a/b, anthropic/c",
  });
  const visible = publicConfig(config);
  assert.equal(JSON.stringify(visible).includes("sk-or-secret"), false);
  assert.equal(JSON.stringify(visible).includes("sk-ant-secret"), false);
  assert.deepEqual(visible.allowedModels, ["openrouter/a/b", "anthropic/c"]);
  assert.equal(visible.keyStatus.openrouter, "environment");
});

test("standard policy and developer-local execution are safe defaults", () => {
  const config = loadConfig({ SIGNALFOLD_DATA_DIR: "/tmp/signalfold" });
  assert.equal(config.defaultPolicy, "standard");
  assert.equal(config.defaultModel, "openrouter/minimax/minimax-m3");
  assert.equal(config.pythonExecution, "developer-local");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.turnTimeoutSeconds, 180);
  assert.equal(config.operationsCenter, true);
  assert.equal(config.operationsRetentionTurns, 100);
});

test("operations center can be independently disabled and is hidden when developer mode is off", () => {
  const explicitlyOff = loadConfig({ SIGNALFOLD_DATA_DIR: "/tmp/signalfold", AI_OPERATIONS_CENTER: "0" });
  assert.equal(publicConfig(explicitlyOff).operationsCenter, false);
  const developerOff = loadConfig({ SIGNALFOLD_DATA_DIR: "/tmp/signalfold", AI_DEVELOPER_MODE: "0", AI_OPERATIONS_CENTER: "1" });
  assert.equal(publicConfig(developerOff).operationsCenter, false);
  assert.equal(loadConfig({ SIGNALFOLD_DATA_DIR: "/tmp/signalfold", AI_OPERATIONS_RETENTION_TURNS: "invalid" }).operationsRetentionTurns, 100);
});

test("local env values replace inherited blanks but not explicit non-empty values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signalfold-env-"));
  const filename = path.join(root, ".env");
  fs.writeFileSync(filename, "OPENROUTER_API_KEY=from-local-file\nANTHROPIC_API_KEY=from-local-file\n");
  const env = { OPENROUTER_API_KEY: "", ANTHROPIC_API_KEY: "from-shell" };
  loadLocalEnvFile(filename, env);
  assert.equal(env.OPENROUTER_API_KEY, "from-local-file");
  assert.equal(env.ANTHROPIC_API_KEY, "from-shell");
});
