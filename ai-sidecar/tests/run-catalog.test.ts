import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FilesystemRunCatalog } from "../src/run-catalog.js";

test("filesystem catalog exposes completed runs and immutable context only", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "signalfold-runs-"));
  fs.mkdirSync(path.join(data, "runs", "RUN-COMPLETE", "stage1"), { recursive: true });
  fs.writeFileSync(path.join(data, "runs", "RUN-COMPLETE", "artifact_index.json"), "{}");
  fs.writeFileSync(path.join(data, "runs", "RUN-COMPLETE", "stage1", "result.csv"), "gene,p\nAPOE,0.01\n");
  // A web-asset file from an interactive HTML dashboard's "_files/" bundle —
  // NOT a pipeline artifact; must never enter AI context.
  fs.mkdirSync(path.join(data, "runs", "RUN-COMPLETE", "GO_Interactive_Heatmap_files", "jquery-3.5.1"), { recursive: true });
  fs.writeFileSync(path.join(data, "runs", "RUN-COMPLETE", "GO_Interactive_Heatmap_files", "jquery-3.5.1", "jquery-AUTHORS.txt"), "Authors\n");
  fs.mkdirSync(path.join(data, "runs", "RUN-PARTIAL"), { recursive: true });
  const catalog = new FilesystemRunCatalog(data);
  assert.deepEqual(catalog.list().map((run) => run.id), ["RUN-COMPLETE"]);
  const context = catalog.context("RUN-COMPLETE");
  assert.equal(context.some((item) => item.path === "stage1/result.csv"), true);
  assert.equal(context.some((item) => item.path.startsWith("ai_insights/")), false);
  assert.equal(context.some((item) => item.path.includes("_files/")), false);
  const grounding = catalog.groundingSnapshot("RUN-COMPLETE", 8);
  assert.equal(grounding.files.length, 2);
  const selectedResult = grounding.files.find((item) => item.path === "stage1/result.csv");
  assert.equal(selectedResult?.includedBytes, 6);
  assert.equal(selectedResult?.truncated, true);
  assert.match(grounding.text, /stage1\/result\.csv/);
});
