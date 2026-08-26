import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FilesystemRunCatalog } from "../src/run-catalog.js";
import {
  buildStandardGrounding,
  classifyStandardQuery,
  type ArtifactFamily,
} from "../src/standard-grounding.js";

// -------------------------------------------------------------------------
// Selection-only evaluation harness for Standard-mode grounding.
//
// This measures the SELECTION PROCESS in isolation — no provider call. Every
// case runs the deterministic router + retrieval and is scored against a gold
// label. It doubles as a regression guard for the lexical relevance fallback
// (deferred layer #3) and as a baseline-vs-after A/B: the "baseline" column is
// the pure keyword router (route === "general" ⇒ zero run files), which is
// exactly the failure mode the fallback removes.
//
// Filenames are deliberately uninformative ("odd/names/*.csv") so a passing
// score reflects schema + lexical relevance, never a filename hint.
// -------------------------------------------------------------------------

function fixture() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "sf-standard-eval-"));
  const run = path.join(data, "runs", "RUN-EVAL");
  fs.mkdirSync(path.join(run, "odd", "names"), { recursive: true });
  fs.writeFileSync(path.join(run, "artifact_index.json"), JSON.stringify({ artifacts: [
    { rel_path: "odd/names/alpha.csv", artifact_family: "tables.variant", stage: "stage1", size_bytes: 200 },
    { rel_path: "odd/names/beta.csv", artifact_family: "tables.variant", stage: "stage1", size_bytes: 200 },
    { rel_path: "odd/names/gamma.csv", artifact_family: "tables.variant", stage: "stage2", size_bytes: 200 },
    { rel_path: "odd/names/delta.csv", artifact_family: "tables.variant", stage: "stage3", size_bytes: 200 },
    { rel_path: "odd/names/epsilon.csv", artifact_family: "tables.variant", stage: "input", size_bytes: 200 },
  ] }));
  fs.writeFileSync(path.join(run, "run_manifest.json"), JSON.stringify({
    format_family: "Generic", assay_level: "protein", input_level: "protein", sample_count: 24, feature_count: 900,
  }));
  // differential expression
  fs.writeFileSync(path.join(run, "odd", "names", "alpha.csv"), [
    "gene,log2fc,pvalue,adj_pvalue,direction",
    "CLU,-0.2,0.2,0.3,down",
    "APOE,1.4,0.0001,0.002,up",
    "APP,0.8,0.003,0.02,up",
  ].join("\n"));
  // module assignments / hubs
  fs.writeFileSync(path.join(run, "odd", "names", "beta.csv"), [
    "gene,module_color,kME,module_quality",
    "APOE,turquoise,0.91,High",
    "CLU,blue,0.82,High",
    "APP,turquoise,0.73,Medium",
  ].join("\n"));
  // GO enrichment
  fs.writeFileSync(path.join(run, "odd", "names", "gamma.csv"), [
    "module,term,category,pvalue,fdr,hit_genes",
    "blue,immune response,BP,0.001,0.01,CLU",
    "turquoise,lipid transport,BP,0.0001,0.002,APOE;APP",
  ].join("\n"));
  // cell-type enrichment
  fs.writeFileSync(path.join(run, "odd", "names", "delta.csv"), [
    "module,cell_type,pvalue,fdr",
    "blue,Neuron,0.2,0.3",
    "turquoise,Microglia,0.00001,0.0002",
  ].join("\n"));
  // sample metadata
  fs.writeFileSync(path.join(run, "odd", "names", "epsilon.csv"), [
    "sample_name,group,batch",
    "S1,control,1",
    "S2,treatment,1",
  ].join("\n"));
  return { data, catalog: new FilesystemRunCatalog(data) };
}

type GoldClass = "paraphrase" | "keyword" | "definitional" | "product-help" | "missing";

interface GoldCase {
  q: string;
  cls: GoldClass;
  grounded: boolean;             // should this turn ground run-file rows at all?
  family?: ArtifactFamily;       // expected top family when grounded
}

// 18 cases: paraphrases + adversarial rewrites of the same intents the keyword
// router misses, plus definitional / product-help / missing / keyword-covered.
const GOLD: GoldCase[] = [
  // Paraphrases the keyword router routes to `general` today (the failure mode).
  { q: "What are the biggest abundance changes between conditions?", cls: "paraphrase", grounded: true, family: "differential-expression" },
  { q: "Which proteins show the largest fold changes between sample groups?", cls: "paraphrase", grounded: true, family: "differential-expression" },
  { q: "Which features are strongly upregulated or downregulated?", cls: "paraphrase", grounded: true, family: "differential-expression" },
  { q: "Which genes have the strongest expression level shifts?", cls: "paraphrase", grounded: true, family: "differential-expression" },
  { q: "Which proteins belong to the same network cluster?", cls: "paraphrase", grounded: true, family: "module-assignments" },
  { q: "Which biological functions are over-represented here?", cls: "paraphrase", grounded: true, family: "go-enrichment" },
  // Definitional — must stay general (zero run rows). FDR-style invariant.
  { q: "What does FDR mean?", cls: "definitional", grounded: false },
  { q: "What does an adjusted p-value mean?", cls: "definitional", grounded: false },
  { q: "Define statistical significance.", cls: "definitional", grounded: false },
  // Product/help — must stay general.
  { q: "How do I export this chat?", cls: "product-help", grounded: false },
  { q: "What can you do?", cls: "product-help", grounded: false },
  // Off-topic / no lexical anchor — must stay general (floor protects us).
  { q: "Tell me about the weather today.", cls: "missing", grounded: false },
  { q: "Can you book me a flight to Boston?", cls: "missing", grounded: false },
  // Keyword fast-path (sanity: still grounded after the change).
  { q: "What is APOE's log2FC?", cls: "keyword", grounded: true, family: "differential-expression" },
  { q: "Which proteins are hubs in the turquoise module?", cls: "keyword", grounded: true, family: "module-assignments" },
  { q: "What GO pathways are enriched in turquoise?", cls: "keyword", grounded: true, family: "go-enrichment" },
  { q: "What are the microglia cell-type results?", cls: "keyword", grounded: true, family: "cell-type" },
  { q: "How many samples are in this run?", cls: "keyword", grounded: true, family: "sample-metadata" },
];

test("selection eval: lexical fallback grounds paraphrased data questions the keyword router drops", () => {
  const { catalog } = fixture();
  const rows: Array<Record<string, string>> = [];
  let groundedWhenShould = 0, groundedTotal = 0;
  let generalWhenShould = 0, generalTotal = 0;
  let familyHits = 0, familyTotal = 0;
  let baselineDroppedDataQuestions = 0;

  for (const c of GOLD) {
    const baselineRoute = classifyStandardQuery(c.q).route;             // pure keyword router (the "before")
    const baselineGrounded = baselineRoute !== "general";
    const result = buildStandardGrounding(catalog, "RUN-EVAL", c.q);     // router + lexical fallback (the "after")
    const grounded = result.selectedArtifacts.length > 0;
    const topFamily = grounded ? result.selectedArtifacts[0].family : "—";

    if (c.grounded && !baselineGrounded) baselineDroppedDataQuestions += 1;
    if (c.grounded) { groundedTotal += 1; if (grounded) groundedWhenShould += 1; }
    else { generalTotal += 1; if (!grounded) generalWhenShould += 1; }
    if (c.grounded && c.family) {
      familyTotal += 1;
      if (result.selectedArtifacts.some((a) => a.family === c.family)) familyHits += 1;
    }

    rows.push({
      class: c.cls,
      question: c.q.length > 52 ? `${c.q.slice(0, 49)}...` : c.q,
      baseline: baselineRoute,
      after: result.route,
      grounded: grounded ? `yes (${topFamily})` : "no",
      expect: c.grounded ? `yes (${c.family || "any"})` : "no",
    });

    // Per-case correctness.
    assert.equal(grounded, c.grounded, `${c.q}: grounded=${grounded}, expected ${c.grounded}`);
    if (c.grounded && c.family) {
      assert.ok(result.selectedArtifacts.some((a) => a.family === c.family), `${c.q}: expected family ${c.family}, got ${result.selectedArtifacts.map((a) => a.family).join(",")}`);
    }
  }

  // Determinism: identical inputs → identical selection (no provider, no clock).
  const a = buildStandardGrounding(catalog, "RUN-EVAL", GOLD[0].q).selectedArtifacts;
  const b = buildStandardGrounding(catalog, "RUN-EVAL", GOLD[0].q).selectedArtifacts;
  assert.deepEqual(a, b);

  // eslint-disable-next-line no-console
  console.table(rows);
  const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
  // eslint-disable-next-line no-console
  console.log([
    "",
    "Selection metrics (deterministic, no provider call):",
    `  grounded-when-should-be : ${groundedWhenShould}/${groundedTotal} (${pct(groundedWhenShould, groundedTotal)})`,
    `  general-when-should-be  : ${generalWhenShould}/${generalTotal} (${pct(generalWhenShould, generalTotal)})`,
    `  family top-1 precision  : ${familyHits}/${familyTotal} (${pct(familyHits, familyTotal)})`,
    `  baseline keyword router DROPPED ${baselineDroppedDataQuestions} real data questions to zero grounding`,
    `  → the fallback recovers all ${baselineDroppedDataQuestions} without regressing the ${generalTotal} must-stay-general cases.`,
    "",
  ].join("\n"));

  // Headline assertions.
  assert.equal(groundedWhenShould, groundedTotal, "every data question must ground");
  assert.equal(generalWhenShould, generalTotal, "every general/definitional question must stay zero-grounded");
  assert.equal(familyHits, familyTotal, "selected family must match the gold family");
  assert.ok(baselineDroppedDataQuestions >= 6, "eval must exercise the keyword-routing failure mode it fixes");
});

test("selection eval: fallback turns are lexical, explainable, and bounded", () => {
  const { catalog } = fixture();
  const result = buildStandardGrounding(catalog, "RUN-EVAL", "What are the biggest abundance changes between conditions?");
  assert.equal(result.route, "lexical");
  assert.equal(result.intent, "lexical");
  // Explainability: every selected artifact records why (BM25 + matched terms).
  assert.ok(result.selectedArtifacts.every((a) => /lexical relevance \(BM25/.test(a.reason)), "missing lexical 'why selected'");
  // Citations are still emitted for the lexical route.
  assert.ok(result.citations.length > 0 && result.citations.every((c) => c.filePath && Array.isArray(c.rowIds)));
  // Token-budget aware: lexical evidence stays within the lexical route budget.
  assert.ok(result.evidenceTokens <= result.budgetTokens, `${result.evidenceTokens} > ${result.budgetTokens}`);
});
