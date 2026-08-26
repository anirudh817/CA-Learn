import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ResearchScopeManifest } from "../src/grounding/research-scope.js";
import { runWorkflowRecipe, type WorkflowRecipe } from "../src/research/workflow-recipes.js";

test("all five Phase E recipes emit deterministic, workflow-specific artifacts from frozen inputs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sf-recipes-")); const workspace = path.join(root, "workspace");
  const files: Record<string, string> = {
    "stage1/volcano_results.tsv": "gene\tlog2fc\tadj_pvalue\nAPOE\t1.4\t0.002\nAPP\t0.5\t0.04\nCLU\t-0.7\t0.03\n",
    "stage1/module_assignments.csv": "gene,module,kME\nAPOE,turquoise,0.91\nAPP,turquoise,0.82\nCLU,blue,0.88\n",
    "stage1/kme_matrix.csv": "gene,module,kME_turquoise,kME_blue\nAPOE,turquoise,0.91,0.1\nAPP,turquoise,0.82,0.2\nCLU,blue,0.1,0.88\n",
    "stage1/normalized_matrix.csv": "gene,S1,S2,S3,S4\nAPOE,2,3,5,6\nAPP,1,2,2,4\nCLU,5,4,3,2\n",
    "stage2/go_enrichment_all.csv": "module,term,pvalue,fdr,hit_genes\nturquoise,lipid transport,0.001,0.01,APOE;APP\n",
  };
  for (const [relative, content] of Object.entries(files)) { const absolute = path.join(root, relative); fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, content); }
  const scope = { schemaVersion: "1.1", runId: "R", createdAt: "2026-06-24T00:00:00Z", query: "test", plan: {}, budget: { maxCostUsd: 0, maxRuntimeSeconds: 60 }, artifacts: Object.entries(files).map(([relative, content]) => ({ path: relative, family: relative.includes("volcano") ? "differential-expression" : relative.includes("go_") ? "go-enrichment" : "module-assignments", sha256: crypto.createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content), rowIds: [], rowRefs: [], reason: "test" })), stageConfigs: [], exclusions: [], retrieval: { route: "analytical", intent: "test", budgetTokens: 1, truncated: false }, sources: [], sha256: "a".repeat(64) } as ResearchScopeManifest;
  const recipes: WorkflowRecipe[] = ["ranked-pathway", "module-hub", "external-protein-evidence", "literature-contradiction", "power-next-experiment"];
  for (const recipe of recipes) {
    const first = runWorkflowRecipe({ recipe, runPath: root, workspace, scope }); const firstHash = crypto.createHash("sha256").update(first.content).digest("hex");
    const second = runWorkflowRecipe({ recipe, runPath: root, workspace, scope });
    assert.equal(crypto.createHash("sha256").update(second.content).digest("hex"), firstHash);
    assert.ok(fs.existsSync(first.output)); assert.ok(first.content.split("\n").length >= 3, recipe);
  }
  const hub = fs.readFileSync(path.join(workspace, "outputs", "module-hub.csv"), "utf8");
  assert.match(hub, /within_module_degree_r07/); assert.match(hub, /mean_absolute_within_module_correlation/);
  const pathway = fs.readFileSync(path.join(workspace, "outputs", "ranked-pathway.csv"), "utf8");
  assert.match(pathway, /full_rank_score/); assert.match(pathway, /complete Stage 1 signed ranking/);
});

test("reviewed recipe boundary rejects a changed frozen input before computation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sf-recipe-hash-")); const relative = "stage1/volcano_results.tsv"; const absolute = path.join(root, relative); fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, "gene\tlog2fc\nAPOE\t1\n");
  const scope = { artifacts: [{ path: relative, family: "differential-expression", sha256: "0".repeat(64), bytes: 1, rowIds: [], rowRefs: [], reason: "test" }] } as unknown as ResearchScopeManifest;
  assert.throws(() => runWorkflowRecipe({ recipe: "power-next-experiment", runPath: root, workspace: path.join(root, "workspace"), scope }), /hash changed/);
});
