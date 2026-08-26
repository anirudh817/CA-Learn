import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FilesystemRunCatalog } from "../src/run-catalog.js";
import { previewWorkflow, workflowCatalog } from "../src/research/workflows.js";

function fixture() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "sf-workflow-preview-"));
  const run = path.join(data, "runs", "RUN-PREVIEW");
  fs.mkdirSync(path.join(run, "stage1"), { recursive: true });
  fs.mkdirSync(path.join(run, "stage2"), { recursive: true });
  fs.writeFileSync(path.join(run, "artifact_index.json"), "{}");
  fs.writeFileSync(path.join(run, "config_stage1.json"), JSON.stringify({ adjusted_p_cutoff: 0.05 }));
  fs.writeFileSync(path.join(run, "stage1", "volcano_results.tsv"), [
    "gene\tlog2fc\tadj_pvalue", "APOE\t2.1\t0.003", "CLU\t1.4\t0.047", "APP\t0.3\t0.4",
  ].join("\n"));
  fs.writeFileSync(path.join(run, "stage1", "module_assignments.csv"), "gene,module\nAPOE,turquoise\nCLU,turquoise\n");
  fs.writeFileSync(path.join(run, "stage1", "kme_matrix.csv"), "gene,kMEturquoise\nAPOE,0.92\nCLU,0.81\n");
  fs.writeFileSync(path.join(run, "stage1", "module_trait_cor.csv"), "module,cor_disease,p_disease\nturquoise,0.77,0.001\nblue,-0.3,0.2\n");
  // This file is deliberately present to guard the semantic correction: it is
  // a module-eigengene edge table, never a protein PPI candidate source.
  fs.writeFileSync(path.join(run, "stage1", "network_edges.csv"), "source,target,correlation\nMEturquoise,MEblue,0.6\n");
  fs.writeFileSync(path.join(run, "stage2", "go_enrichment_all.csv"), "module,term,fdr\nturquoise,lipid transport,0.002\nblue,immune response,0.04\n");
  return new FilesystemRunCatalog(data);
}

test("Phase A catalog exposes six versioned, run-aware workflows with honest readiness", () => {
  const catalog = workflowCatalog(fixture(), "RUN-PREVIEW");
  assert.equal(catalog.length, 6);
  assert.equal(catalog.every((workflow) => workflow.version === "1.0"), true);
  assert.deepEqual(catalog.map((workflow) => workflow.capabilities.executionStatus), ["executable", "executable", "executable", "executable", "executable", "executable"]);
  assert.ok(catalog.every((workflow) => workflow.decisionPrompt && workflow.controls.length >= 3 && workflow.outputContract.length >= 4));
  assert.ok(catalog.every((workflow) => ["executable", "limited", "preview", "missing-context"].includes(workflow.capabilities.readiness)));
});

test("candidate selection is deterministic, row-addressable, and scientifically labeled", () => {
  const runs = fixture();
  const first = workflowCatalog(runs, "RUN-PREVIEW");
  const second = workflowCatalog(runs, "RUN-PREVIEW");
  assert.deepEqual(first, second);
  const finding = first.find((workflow) => workflow.id === "finding-stress-test")!;
  assert.equal(finding.targetCandidates.some((item) => item.kind === "top-feature" && item.id === "APOE"), true);
  assert.equal(finding.targetCandidates.some((item) => item.kind === "borderline-feature" && item.id === "CLU"), true);
  assert.ok(finding.targetCandidates.every((item) => item.evidenceRefs.every((ref) => /#row:\d+$/.test(ref))));
  const module = first.find((workflow) => workflow.id === "module-hub-investigation")!;
  assert.ok(module.targetCandidates.some((item) => item.kind === "module-member" && /membership is evidence, not a protein-network centrality claim/i.test(item.whySuggested)));
  assert.doesNotMatch(JSON.stringify(module.targetCandidates), /network_edges/);
  assert.match(module.fullFileRules[0].reason, /not a protein PPI/i);
  const ranked = first.find((workflow) => workflow.id === "ranked-pathway-investigation")!;
  assert.ok(ranked.targetCandidates.some((item) => item.kind === "go-term" && /ORA, not GSEA/i.test(item.whySuggested)));
});

test("preview removes analyses whose required full files were declined and exposes cost context", () => {
  const runs = fixture();
  const declined = previewWorkflow(runs, "RUN-PREVIEW", "finding-stress-test", { lenses: ["threshold sweep", "leave-one-out"], includeRecommendedFullFiles: false, targetId: "CLU" });
  assert.deepEqual(declined.planPreview.lenses, ["threshold sweep"]);
  assert.deepEqual(declined.contextPolicy.declinedAnalyses, ["leave-one-out"]);
  assert.match(declined.promptPreview, /stage1\/volcano_results\.tsv#row:3/);
  const accepted = previewWorkflow(runs, "RUN-PREVIEW", "finding-stress-test", { lenses: ["threshold sweep", "leave-one-out"], includeRecommendedFullFiles: true, targetId: "CLU" });
  assert.deepEqual(accepted.planPreview.lenses, ["threshold sweep", "leave-one-out"]);
  assert.equal(accepted.contextPolicy.includedFullFiles[0].mode, "full-sample-context");
  assert.ok(Number(accepted.contextPolicy.estimatedTokens) > 0);
});
