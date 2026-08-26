import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FilesystemRunCatalog } from "../src/run-catalog.js";
import {
  buildStandardGrounding,
  classifyStandardQuery,
  compactConversationHistory,
} from "../src/standard-grounding.js";
import { accumulateUsage, capabilitiesForPolicy, type UsageBreakdown } from "../src/runtime.js";

function fixture() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "sf-standard-"));
  const run = path.join(data, "runs", "RUN-ADAPTIVE");
  fs.mkdirSync(path.join(run, "odd", "names"), { recursive: true });
  fs.writeFileSync(path.join(run, "artifact_index.json"), JSON.stringify({ artifacts: [
    { rel_path: "odd/names/alpha.csv", artifact_family: "tables.variant", stage: "stage1", size_bytes: 200 },
    { rel_path: "odd/names/beta.csv", artifact_family: "tables.variant", stage: "stage1", size_bytes: 200 },
    { rel_path: "odd/names/gamma.csv", artifact_family: "tables.variant", stage: "stage2", size_bytes: 200 },
    { rel_path: "odd/names/delta.csv", artifact_family: "tables.variant", stage: "stage3", size_bytes: 200 },
  ] }));
  fs.writeFileSync(path.join(run, "run_manifest.json"), JSON.stringify({
    format_family: "Generic", assay_level: "protein", input_level: "protein", sample_count: 24, feature_count: 900,
  }));
  fs.writeFileSync(path.join(run, "odd", "names", "alpha.csv"), [
    "gene,log2fc,pvalue,adj_pvalue,direction",
    "CLU,-0.2,0.2,0.3,down",
    "APOE,1.4,0.0001,0.002,up",
    "APP,0.8,0.003,0.02,up",
  ].join("\n"));
  fs.writeFileSync(path.join(run, "odd", "names", "beta.csv"), [
    "gene,module_color,kME,module_quality",
    "APOE,turquoise,0.91,High",
    "CLU,blue,0.82,High",
    "APP,turquoise,0.73,Medium",
  ].join("\n"));
  fs.writeFileSync(path.join(run, "odd", "names", "gamma.csv"), [
    "module,term,category,pvalue,fdr,hit_genes",
    "blue,immune response,BP,0.001,0.01,CLU",
    "turquoise,lipid transport,BP,0.0001,0.002,APOE;APP",
  ].join("\n"));
  fs.writeFileSync(path.join(run, "odd", "names", "delta.csv"), [
    "module,cell_type,pvalue,fdr",
    "blue,Neuron,0.2,0.3",
    "turquoise,Microglia,0.00001,0.0002",
  ].join("\n"));
  return { data, catalog: new FilesystemRunCatalog(data) };
}

test("general scientific definitions receive a run card but no raw run-file rows", () => {
  const { catalog } = fixture();
  const result = buildStandardGrounding(catalog, "RUN-ADAPTIVE", "What does FDR mean?");
  assert.equal(result.route, "general");
  assert.equal(result.evidence, "");
  assert.equal(result.evidenceTokens, 0);
  assert.match(result.runCard, /RUN-ADAPTIVE/);
  assert.doesNotMatch(result.text, /APOE,1\.4/);
  assert.deepEqual(result.selectedArtifacts, []);
});

test("schema-aware retrieval handles variant filenames for protein, module, GO, cell, and cross-modal questions", () => {
  const { catalog } = fixture();
  const cases = [
    ["What is APOE's log2FC?", ["odd/names/alpha.csv", "odd/names/beta.csv"], /APOE/],
    ["Which proteins are hubs in the turquoise module?", ["odd/names/beta.csv"], /turquoise/],
    ["What GO pathways are enriched in turquoise?", ["odd/names/gamma.csv"], /lipid transport/],
    ["What are the microglia cell-type results?", ["odd/names/delta.csv"], /Microglia/],
    ["Which GO pathways are enriched in microglia-associated modules?", ["odd/names/delta.csv", "odd/names/gamma.csv"], /lipid transport/],
  ] as const;
  for (const [question, expectedPaths, evidence] of cases) {
    const result = buildStandardGrounding(catalog, "RUN-ADAPTIVE", question);
    for (const expected of expectedPaths) assert.ok(result.selectedArtifacts.some((item) => item.path === expected), `${question}: ${expected}`);
    assert.match(result.evidence, evidence, question);
    assert.ok(result.citations.every((citation) => citation.filePath && Array.isArray(citation.rowIds)));
  }
});

test("co-expression / co-movement phrasing routes to module grounding without literal module words", () => {
  const { catalog } = fixture();
  for (const question of [
    "Which proteins rise and fall in lockstep across samples",
    "Which proteins are co-expressed across samples?",
    "Show me proteins that co-vary",
    "Which features are correlated with each other?",
    "Which proteins move together in tandem?",
  ]) {
    const intent = classifyStandardQuery(question);
    assert.equal(intent.kind, "module", question);
    assert.notEqual(intent.route, "general", question);
    const result = buildStandardGrounding(catalog, "RUN-ADAPTIVE", question);
    assert.ok(result.selectedArtifacts.some((item) => item.path === "odd/names/beta.csv"), `${question}: expected module-assignments grounding`);
  }
  // A definitional question about the same concept stays general (no run rows).
  assert.equal(classifyStandardQuery("What does co-expression mean?").route, "general");
});

test("lexical relevance fallback grounds data questions the keyword router would drop", () => {
  const { catalog } = fixture();
  // Phrased entirely outside the keyword/entity lists, so the deterministic
  // keyword router alone routes it to `general` (the confirmed failure mode:
  // zero grounding on a real data question).
  const question = "What are the biggest abundance changes between conditions?";
  const classified = classifyStandardQuery(question);
  assert.equal(classified.route, "general");
  assert.equal(classified.generalReason, "unmatched");

  // The BM25 relevance fallback recovers the right artifact deterministically.
  const result = buildStandardGrounding(catalog, "RUN-ADAPTIVE", question);
  assert.equal(result.route, "lexical");
  assert.equal(result.intent, "lexical");
  assert.ok(result.selectedArtifacts.some((item) => item.family === "differential-expression"), "expected DE grounding");
  assert.match(result.evidence, /APOE/);
  assert.ok(result.selectedArtifacts.every((item) => /lexical relevance \(BM25/.test(item.reason)), "missing lexical 'why selected'");
  assert.ok(result.citations.length > 0 && result.citations.every((citation) => citation.filePath && Array.isArray(citation.rowIds)));
  // Determinism: identical inputs select identically (no provider, no clock).
  assert.deepEqual(result.selectedArtifacts, buildStandardGrounding(catalog, "RUN-ADAPTIVE", question).selectedArtifacts);

  // The relevance floor still protects genuinely general questions even when
  // keyword definitional detection does not catch them: a question with no
  // discriminative lexical anchor in the run grounds zero rows, not "any data".
  const offTopic = buildStandardGrounding(catalog, "RUN-ADAPTIVE", "Can you book me a flight to Boston?");
  assert.equal(offTopic.route, "general");
  assert.equal(offTopic.evidence, "");
  assert.deepEqual(offTopic.selectedArtifacts, []);
});

test("retrieval reranks before enforcing its hard budget", () => {
  const { catalog } = fixture();
  const result = buildStandardGrounding(catalog, "RUN-ADAPTIVE", "What is APOE's log2FC?", { evidenceTokenBudget: 90 });
  assert.ok(result.evidenceTokens <= 90);
  assert.match(result.evidence, /APOE/);
  assert.equal(result.truncated, true);
  assert.ok(result.selectedArtifacts[0].score >= result.selectedArtifacts.at(-1)!.score);
});

test("query routing is deterministic and explicit attachments override the no-body route", () => {
  assert.equal(classifyStandardQuery("How do I export this chat?").route, "general");
  assert.equal(classifyStandardQuery("What is APOE's adjusted p-value?").route, "lookup");
  assert.equal(classifyStandardQuery("Summarize the pathways and modules in this run").route, "analytical");
  assert.equal(classifyStandardQuery("Explain this\n<untrusted_attachment name=\"notes.csv\">x</untrusted_attachment>").route, "explicit");
});

test("history compaction preserves pins, research decisions, and recent turns", () => {
  const history = Array.from({ length: 16 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: index === 3 ? "Decision: focus on APOE and the turquoise module [stage1/volcano.tsv]" : `message ${index} ${"x".repeat(180)}`,
    pinned: index === 3,
  }));
  const compacted = compactConversationHistory(history, { maxTokens: 500, recentTurns: 2 });
  assert.equal(compacted.compacted, true);
  assert.match(compacted.text, /PINNED/);
  assert.match(compacted.text, /focus on APOE/);
  assert.match(compacted.text, /message 15/);
  assert.doesNotMatch(compacted.text, new RegExp(`message 0 ${"x".repeat(180)}`));
});

test("Standard policy exposes no Pi execution capability while Deep Research retains the future seam", () => {
  const available = ["read", "bash", "write", "edit", "save_artifact"];
  assert.deepEqual(capabilitiesForPolicy("standard", true, available), { tools: [], skills: false });
  assert.deepEqual(capabilitiesForPolicy("deep-research", true, available), { tools: available, skills: true });
  assert.deepEqual(capabilitiesForPolicy("deep-research", false, available), { tools: [], skills: false });
});

test("usage telemetry separates uncached, cache-write, cache-read, and cumulative context", () => {
  let totals: UsageBreakdown = { uncachedInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0, modelCalls: 0, totalContextTokens: 0 };
  totals = accumulateUsage(totals, { input: 100, cacheWrite: 60, cacheRead: 0, output: 8, cost: { total: 0.01 } });
  totals = accumulateUsage(totals, { input: 20, cacheWrite: 0, cacheRead: 140, output: 5, cost: { total: 0.004 } });
  assert.deepEqual(totals, {
    uncachedInputTokens: 120, cacheWriteTokens: 60, cacheReadTokens: 140,
    outputTokens: 13, costUsd: 0.014, modelCalls: 2, totalContextTokens: 320,
  });
});
