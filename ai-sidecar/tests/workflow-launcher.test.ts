import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FilesystemRunCatalog } from "../src/run-catalog.js";
import { composeLauncher, workflowCatalog } from "../src/research/workflows.js";

// Same shape as workflow-preview's fixture: a small complete run with a DE
// table, modules, kME, module-trait correlations, and GO over-representation,
// so inspectCandidates() derives a top/borderline feature, a trait module, a
// module member, and a GO term.
function fixture() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "sf-workflow-launcher-"));
  const run = path.join(data, "runs", "RUN-LAUNCH");
  fs.mkdirSync(path.join(run, "stage1"), { recursive: true });
  fs.mkdirSync(path.join(run, "stage2"), { recursive: true });
  fs.writeFileSync(path.join(run, "artifact_index.json"), "{}");
  fs.writeFileSync(path.join(run, "config_stage1.json"), JSON.stringify({ adjusted_p_cutoff: 0.05 }));
  fs.writeFileSync(path.join(run, "stage1", "volcano_results.tsv"), ["gene\tlog2fc\tadj_pvalue", "APOE\t2.1\t0.003", "CLU\t1.4\t0.047", "APP\t0.3\t0.4"].join("\n"));
  fs.writeFileSync(path.join(run, "stage1", "module_assignments.csv"), "gene,module\nAPOE,turquoise\nCLU,turquoise\n");
  fs.writeFileSync(path.join(run, "stage1", "kme_matrix.csv"), "gene,kMEturquoise\nAPOE,0.92\nCLU,0.81\n");
  fs.writeFileSync(path.join(run, "stage1", "module_trait_cor.csv"), "module,cor_disease,p_disease\nturquoise,0.77,0.001\nblue,-0.3,0.2\n");
  fs.writeFileSync(path.join(run, "stage1", "network_edges.csv"), "source,target,correlation\nMEturquoise,MEblue,0.6\n");
  fs.writeFileSync(path.join(run, "stage2", "go_enrichment_all.csv"), "module,term,fdr\nturquoise,lipid transport,0.002\nblue,immune response,0.04\n");
  return new FilesystemRunCatalog(data);
}

// The shared science contract must ride on every composed objective.
const UNIVERSAL_GUARDS = ["Welch t-test on continuous protein intensities", "Fisher/ORA), not GSEA", "not a protein PPI", "not cell-abundance deconvolution"];

test("catalog exposes a short launcher form per card with candidate-backed picks", () => {
  const catalog = workflowCatalog(fixture(), "RUN-LAUNCH");
  assert.equal(catalog.length, 6);
  assert.ok(catalog.every((workflow) => Array.isArray(workflow.launcher?.fields) && workflow.launcher.fields.length >= 1));
  // The candidate-derived target is filled from real run rows, not free text.
  const finding = catalog.find((workflow) => workflow.id === "finding-stress-test")!;
  const target = finding.launcher.fields.find((field) => field.id === "target")!;
  assert.equal(target.from, "candidates");
  const optionValues = (target.options || []).map((opt) => (typeof opt === "string" ? opt : opt.value));
  assert.ok(optionValues.includes("APOE") && optionValues.includes("CLU"));
  // Static fields keep their authored defaults.
  assert.deepEqual(finding.launcher.fields.find((field) => field.id === "perturbations")!.default, ["threshold sweep"]);
  // A multiselect candidate field seeds up to three run-derived picks.
  const external = catalog.find((workflow) => workflow.id === "external-protein-evidence")!;
  const proteins = external.launcher.fields.find((field) => field.id === "proteins")!;
  assert.ok(Array.isArray(proteins.default) && proteins.default.length >= 1 && proteins.default.length <= 3);
});

test("finding stress test composes a guard-correct, row-cited free-form objective", () => {
  const objective = composeLauncher(fixture(), "RUN-LAUNCH", "finding-stress-test", { target: "CLU", perturbations: ["threshold sweep", "leave-one-sample-out"], decisionAdjP: 0.01 });
  assert.match(objective, /CLU/);
  assert.match(objective, /#row:3/); // CLU is the third data row of volcano_results.tsv
  assert.match(objective, /leave-one-sample-out/);
  assert.match(objective, /adjusted-p threshold of 0\.01/);
  assert.match(objective, /Welch t-test on continuous intensities/);
  assert.match(objective, /do not substitute a count or negative-binomial model/);
});

test("ranked pathway keeps ranked-method and ORA distinct, honoring the toggles", () => {
  const withBoth = composeLauncher(fixture(), "RUN-LAUNCH", "ranked-pathway-investigation", { geneSetSource: "Reactome", compareToORA: true, leadingEdge: true });
  assert.match(withBoth, /COMPLETE Stage 1 ranking/);
  assert.match(withBoth, /Reactome/);
  assert.match(withBoth, /do NOT call it permutation GSEA/);
  assert.match(withBoth, /ORA≠ranked/);
  assert.match(withBoth, /leading-edge proteins/);
  // Turning a toggle off drops its clause.
  const noLeadingNoOra = composeLauncher(fixture(), "RUN-LAUNCH", "ranked-pathway-investigation", { compareToORA: false, leadingEdge: false });
  assert.doesNotMatch(noLeadingNoOra, /leading-edge proteins/);
  assert.doesNotMatch(noLeadingNoOra, /Stage 2 GO over-representation \(ORA\) output/);
});

test("module hub forbids the eigengene graph and separates kME from centrality", () => {
  const objective = composeLauncher(fixture(), "RUN-LAUNCH", "module-hub-investigation", { module: "turquoise", axes: ["kME membership", "within-module connectivity", "STRING"] });
  assert.match(objective, /turquoise/);
  assert.match(objective, /do NOT use stage1\/network_edges\.csv/);
  assert.match(objective, /not a protein PPI/);
  assert.match(objective, /kME as membership evidence, explicitly NOT network centrality/);
  assert.match(objective, /KEEP EACH AXIS SEPARATE/);
  assert.match(objective, /STRING/);
});

test("external protein evidence binds each chosen protein to its run row", () => {
  const objective = composeLauncher(fixture(), "RUN-LAUNCH", "external-protein-evidence", { proteins: ["APOE"], context: "Alzheimer's disease", sources: ["UniProt", "PubMed/PMC"] });
  assert.match(objective, /APOE \(stage1\/volcano_results\.tsv#row:2\)/);
  assert.match(objective, /in the context of Alzheimer's disease/);
  assert.match(objective, /SUPPORTING, CHALLENGING, or CONTEXTUALIZING/);
  assert.match(objective, /UniProt, PubMed\/PMC/);
});

test("contradiction check classifies genuine vs context-explained disagreement", () => {
  const objective = composeLauncher(fixture(), "RUN-LAUNCH", "run-literature-contradiction", { target: "APOE", context: "human brain", sources: ["PubMed/PMC"] });
  assert.match(objective, /APOE/);
  assert.match(objective, /in human brain/);
  assert.match(objective, /GENUINE contradiction/);
  assert.match(objective, /discriminating experiment/);
});

test("power and next experiment uses a continuous power model and emits assumptions", () => {
  const objective = composeLauncher(fixture(), "RUN-LAUNCH", "power-next-experiment", { target: "CLU", maxSamples: 24, design: "blocked" });
  assert.match(objective, /CLU/);
  assert.match(objective, /Cap feasible samples at 24/);
  assert.match(objective, /blocked design/);
  assert.match(objective, /continuous two-sample \/ t-test power model — NOT a negative-binomial or count model/);
  assert.match(objective, /EMIT every assumption/);
});

test("every composed objective carries the universal pipeline-science guards and is deterministic", () => {
  const ids = ["finding-stress-test", "ranked-pathway-investigation", "module-hub-investigation", "external-protein-evidence", "run-literature-contradiction", "power-next-experiment"];
  const runs = fixture();
  for (const id of ids) {
    const once = composeLauncher(runs, "RUN-LAUNCH", id, {});
    const twice = composeLauncher(runs, "RUN-LAUNCH", id, {});
    assert.equal(once, twice, `${id} must be deterministic`);
    for (const guard of UNIVERSAL_GUARDS) assert.ok(once.includes(guard), `${id} objective is missing guard: ${guard}`);
  }
});

test("free-form and unknown ids are not launchable presets", () => {
  const runs = fixture();
  assert.throws(() => composeLauncher(runs, "RUN-LAUNCH", "freeform", {}), /Unknown research workflow/);
  assert.throws(() => composeLauncher(runs, "RUN-LAUNCH", "not-a-card", {}), /Unknown research workflow/);
});
