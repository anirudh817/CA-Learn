import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FilesystemRunCatalog } from "../src/run-catalog.js";
import { describeArtifact, isCanonicalPath, isLegacyPath, renderCatalogForAgent, renderCatalogForRunCard, annotateCatalogUsage, normalizeCatalogPath } from "../src/grounding/artifact-catalog.js";
import { buildRunCatalog, buildResearchScopeManifest } from "../src/grounding/research-scope.js";
import { buildStandardGrounding } from "../src/standard-grounding.js";
import { renderResearchCatalogHtml } from "../src/research/catalog-html.js";

// A run that mirrors the real pipeline: a canonical stageN/ tree PLUS a legacy
// client-deliverable copy (the place run-cell citations actually point at).
function fixture() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "sf-catalog-"));
  const run = path.join(data, "runs", "RUN-CAT");
  const write = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(run, rel)), { recursive: true }); fs.writeFileSync(path.join(run, rel), body); };
  write("artifact_index.json", "{}");
  write("run_manifest.json", JSON.stringify({ format_family: "proteomics", assay_level: "peptide", sample_count: 60, feature_count: 18122 }));
  write("config_stage1.json", JSON.stringify({ adjusted_p_cutoff: 0.05, soft_power: 6 }));
  const volcano = ["peptide_id\tfeature_id\tgene\tlog2fc\tpvalue\tadj_pvalue\tsignificant\tdirection\tmodule", "p1\tf1\tCLSTN3\t-1.8\t0.0001\t0.004\tTRUE\tdown\tturquoise"].join("\n");
  write("stage1/volcano_results.tsv", volcano);
  write("stage1/volcano_downregulated.csv", "peptide_id,feature_id,gene,log2fc,pvalue,adj_pvalue,significant,direction,module\np1,f1,CLSTN3,-1.8,0.0001,0.004,TRUE,down,turquoise\n");
  write("stage1/module_assignments.csv", "peptide_id,feature_id,gene,module_color,kME,alternative_module\np1,f1,CLSTN3,turquoise,0.91,blue\n");
  write("stage1/kme_matrix.csv", "feature_id,kMEturquoise,kMEblue,kMEbrown\nf1,0.91,0.10,0.05\n");
  write("stage1/module_eigengenes.csv", "sample_name,group,MEturquoise,MEblue,MEbrown\nS1,Disease,0.2,-0.1,0.0\n");
  write("stage1/module_trait_cor.csv", "module_color,cor_Disease,p_Disease\nturquoise,0.77,0.001\n");
  write("stage1/network_edges.csv", "source,target,weight\nMEturquoise,MEblue,0.6\n");
  write("stage1/normalized_matrix.csv", "feature_id,gene,S1,S2\nf1,CLSTN3,12.1,11.8\n");
  write("stage2/go_enrichment_all.csv", "module,term,category,pvalue,zscore,hits,term_size,hit_genes\nturquoise,synaptic signaling,BP,0.0003,4.1,12,210,CLSTN3\n");
  write("stage2/go_fdr_matrix.csv", "term,turquoise,blue,brown\nsynaptic signaling,0.002,0.4,0.9\n");
  write("stage3/celltype_FDR_matrix.csv", "module,Astrocytes,Microglia,Neuron,Oligodendrocytes,Endothelia\nturquoise,0.9,0.4,0.001,0.7,0.8\n");
  write("stage3/celltype_heatmap_data.csv", "module,cell_type,pvalue,fdr,minus_log10_fdr\nturquoise,Neuron,0.0001,0.001,3.0\n");
  write("input/sample_metadata.csv", "sample_name,raw_sample_name,sample_key,group,group_source\nS1,S1.raw,k1,Disease,manual\n");
  // Legacy deliverable copy — same downregulated volcano under the name a
  // citation uses. The whole point of the catalog is that this stays reachable.
  write("03_analysis_CBN_median/PROTEOMICS_Volcano_Downregulated_Disease.csv", "peptide_id,feature_id,gene,log2fc,pvalue,adj_pvalue,significant,direction,module\np1,f1,CLSTN3,-1.8,0.0001,0.004,TRUE,down,turquoise\n");
  return { catalog: new FilesystemRunCatalog(data), run };
}

test("describeArtifact respects the pipeline biologics for every analytical role", () => {
  const de = describeArtifact("stage1/volcano_results.tsv", "differential-expression", ["gene", "log2fc", "adj_pvalue"], 18000, 2_000_000);
  assert.equal(de.role, "differential-expression");
  assert.match(de.derivation, /Welch/);
  assert.match(de.derivation, /NOT limma/i);
  assert.match(de.description, /log2fc/);

  const down = describeArtifact("stage1/volcano_downregulated.csv", "differential-expression", ["gene", "log2fc", "adj_pvalue"], 60, 20000);
  assert.equal(down.role, "differential-expression-down");

  const kme = describeArtifact("stage1/kme_matrix.csv", "other", ["feature_id", "kMEturquoise", "kMEblue"], 18000, 2_000_000);
  assert.equal(kme.role, "kme-matrix");
  assert.match(kme.derivation, /NOT a network-centrality|module membership/i);

  const eig = describeArtifact("stage1/module_eigengenes.csv", "other", ["sample_name", "group", "MEturquoise", "MEblue"], 60, 28000);
  assert.equal(eig.role, "module-eigengenes");

  const edges = describeArtifact("stage1/network_edges.csv", "other", ["source", "target", "weight"], 100, 1600);
  assert.equal(edges.role, "eigengene-network-edges");
  assert.match(edges.description, /NOT a protein.protein interaction|PPI/i);

  const go = describeArtifact("stage2/go_enrichment_all.csv", "go-enrichment", ["module", "term", "pvalue", "zscore", "hits"], 5000, 12_000_000);
  assert.equal(go.role, "go-ora-long");
  assert.match(go.derivation, /over-representation|ORA/i);
  assert.match(go.derivation, /NOT GSEA/i);

  const goMatrix = describeArtifact("stage2/go_fdr_matrix.csv", "other", ["term", "turquoise", "blue", "brown"], 800, 850000);
  assert.equal(goMatrix.role, "go-ora-matrix");

  const cellMatrix = describeArtifact("stage3/celltype_FDR_matrix.csv", "cell-type", ["module", "Astrocytes", "Microglia", "Neuron"], 20, 975);
  assert.equal(cellMatrix.role, "celltype-fet-matrix");
  assert.match(cellMatrix.derivation, /Fisher exact test|FET/i);
  assert.match(cellMatrix.derivation, /NOT.*deconvolution|NOT abundance/i);

  const cellLong = describeArtifact("stage3/celltype_heatmap_data.csv", "cell-type", ["module", "cell_type", "pvalue", "fdr"], 50, 7000);
  assert.equal(cellLong.role, "celltype-fet-long");
});

test("buildRunCatalog freezes the whole run with hashes, descriptions, and canonical/legacy flags", () => {
  const { catalog } = fixture();
  const entries = buildRunCatalog(catalog, "RUN-CAT");
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));

  // Both the canonical and the legacy-citation copy are present and fetchable.
  assert.ok(byPath.has("stage1/volcano_results.tsv"));
  assert.ok(byPath.has("03_analysis_CBN_median/PROTEOMICS_Volcano_Downregulated_Disease.csv"));

  const canonicalVolcano = byPath.get("stage1/volcano_results.tsv")!;
  assert.equal(canonicalVolcano.canonical, true);
  assert.equal(canonicalVolcano.legacy, false);
  assert.equal(canonicalVolcano.role, "differential-expression");
  assert.match(canonicalVolcano.sha256, /^[0-9a-f]{64}$/);
  assert.ok((canonicalVolcano.rowCount ?? 0) >= 1);

  const legacyVolcano = byPath.get("03_analysis_CBN_median/PROTEOMICS_Volcano_Downregulated_Disease.csv")!;
  assert.equal(legacyVolcano.legacy, true);
  assert.equal(legacyVolcano.canonical, false);
  assert.equal(legacyVolcano.role, "differential-expression-down");

  // Hash actually matches the file on disk (audit-to-the-byte).
  const onDisk = fs.readFileSync(path.join(catalog.get("RUN-CAT")!.path, "stage1/volcano_results.tsv"));
  assert.equal(canonicalVolcano.sha256, crypto.createHash("sha256").update(onDisk).digest("hex"));
});

test("renderers: agent view shows canonical + collapses legacy; run-card view names the methods", () => {
  const { catalog } = fixture();
  const entries = buildRunCatalog(catalog, "RUN-CAT");
  const staged = new Set(["stage1/volcano_results.tsv"]);
  const agentView = renderCatalogForAgent(entries, staged);
  assert.match(agentView, /\[staged\] stage1\/volcano_results\.tsv/);
  assert.match(agentView, /\[fetch\]\s+stage1\/kme_matrix\.csv/);
  assert.match(agentView, /Legacy client-deliverable tree/);
  assert.match(agentView, /PROTEOMICS_Volcano_Downregulated_Disease\.csv/);

  const cardLines = renderCatalogForRunCard(entries);
  assert.ok(cardLines.length > 0);
  assert.ok(cardLines.some((line) => /volcano_results\.tsv/.test(line) && /Welch/.test(line)));
  // Legacy copies are NOT dumped into the always-on Standard card.
  assert.ok(!cardLines.some((line) => /03_analysis_CBN_median/.test(line)));
});

test("buildResearchScopeManifest attaches the catalog only when asked, covering files outside the staged subset", () => {
  const { catalog } = fixture();
  const plan = { objective: "x" };
  const preview = buildResearchScopeManifest(catalog, "RUN-CAT", "summarize this run", plan, { maxCostUsd: 1 });
  assert.equal(preview.catalog, undefined, "previews must stay cheap — no catalog");

  const frozen = buildResearchScopeManifest(catalog, "RUN-CAT", "summarize this run", plan, { maxCostUsd: 1, withCatalog: true });
  assert.ok(Array.isArray(frozen.catalog) && frozen.catalog.length >= 12);
  const catalogPaths = new Set(frozen.catalog!.map((entry) => entry.path));
  assert.ok(catalogPaths.has("03_analysis_CBN_median/PROTEOMICS_Volcano_Downregulated_Disease.csv"));
  // The catalog is a strict superset of the staged subset — i.e. it unlocks
  // files the question-adaptive retrieval did NOT pre-stage.
  const stagedPaths = new Set(frozen.artifacts.map((entry) => entry.path));
  assert.ok([...catalogPaths].some((p) => !stagedPaths.has(p)), "catalog must expose files beyond the staged subset");

  // Deterministic: same inputs → identical frozen manifest hash.
  const again = buildResearchScopeManifest(catalog, "RUN-CAT", "summarize this run", plan, { maxCostUsd: 1, withCatalog: true, createdAt: frozen.createdAt });
  assert.equal(again.sha256, frozen.sha256);
});

test("Standard run card carries the descriptive data inventory", () => {
  const { catalog } = fixture();
  const grounding = buildStandardGrounding(catalog, "RUN-CAT", "what does this run show?");
  assert.match(grounding.runCard, /dataInventory/);
  assert.match(grounding.runCard, /Welch/);
  assert.match(grounding.runCard, /volcano_results\.tsv/);
});

test("normalizeCatalogPath strips one jail prefix but leaves run-relative paths intact", () => {
  assert.equal(normalizeCatalogPath("inputs/stage1/volcano_results.tsv"), "stage1/volcano_results.tsv");
  assert.equal(normalizeCatalogPath("outputs/result.csv"), "result.csv");
  assert.equal(normalizeCatalogPath("./inputs/stage1/x.csv"), "stage1/x.csv");
  assert.equal(normalizeCatalogPath("inputs\\stage1\\x.csv"), "stage1/x.csv");
  // The catalog's own singular `input/` stage and legacy folders are NOT prefixes.
  assert.equal(normalizeCatalogPath("input/sample_metadata.csv"), "input/sample_metadata.csv");
  assert.equal(normalizeCatalogPath("inputs/input/sample_metadata.csv"), "input/sample_metadata.csv");
  assert.equal(normalizeCatalogPath("03_analysis_CBN_median/x.csv"), "03_analysis_CBN_median/x.csv");
});

// Mirrors the real CLSTN3 free-form run: a legacy file fetched+cited+read, staged
// files read via code, staged files left unread, and an available-only tail.
test("annotateCatalogUsage joins staged/fetched/read/cited into per-file tiers", () => {
  const entries = [
    { path: "03_analysis_CBN_median/PROTEOMICS_Volcano_Downregulated_Disease.csv" }, // fetched + cited + read
    { path: "stage1/module_assignments.csv" }, // staged + cited + read
    { path: "stage1/normalized_matrix.csv" },  // staged + read
    { path: "stage1/kme_matrix.csv" },         // staged + read
    { path: "input/sample_metadata.csv" },     // staged + read (via inputs/input/…)
    { path: "stage1/volcano_results.tsv" },    // staged + read
    { path: "stage2/go_enrichment_all.csv" },  // staged, untouched -> staged-unused
    { path: "stage3/celltype_FDR_matrix.csv" },// staged, untouched -> staged-unused
    { path: "stage2/go_enrichment_redundancy_removed.csv" }, // available only
  ];
  const staged = ["input/sample_metadata.csv", "stage1/module_assignments.csv", "stage1/normalized_matrix.csv", "stage1/kme_matrix.csv", "stage1/volcano_results.tsv", "stage2/go_enrichment_all.csv", "stage3/celltype_FDR_matrix.csv"];
  const fetched = ["03_analysis_CBN_median/PROTEOMICS_Volcano_Downregulated_Disease.csv"]; // event payload form (no prefix)
  const cited = ["inputs/03_analysis_CBN_median/PROTEOMICS_Volcano_Downregulated_Disease.csv", "inputs/stage1/module_assignments.csv"]; // answer form (inputs/ prefix)
  const codeText = [
    "df = pd.read_csv('inputs/input/sample_metadata.csv')",
    "k = pd.read_csv('inputs/stage1/kme_matrix.csv')",
    "n = pd.read_csv('inputs/stage1/normalized_matrix.csv')",
    "v = pd.read_csv('inputs/stage1/volcano_results.tsv')",
    "m = pd.read_csv('inputs/stage1/module_assignments.csv')",
    "down = pd.read_csv('inputs/03_analysis_CBN_median/PROTEOMICS_Volcano_Downregulated_Disease.csv')",
  ].join("\n");

  const annotated = annotateCatalogUsage(entries, { staged, fetched, cited, codeText });
  const by = (p: string) => annotated.find((e) => e.path === p)!.usage;

  const down = by("03_analysis_CBN_median/PROTEOMICS_Volcano_Downregulated_Disease.csv");
  assert.deepEqual({ fetched: down.fetched, cited: down.cited, read: down.read, used: down.used, tier: down.tier }, { fetched: true, cited: true, read: true, used: true, tier: "used" });

  const modules = by("stage1/module_assignments.csv");
  assert.deepEqual({ staged: modules.staged, cited: modules.cited, read: modules.read, used: modules.used, tier: modules.tier }, { staged: true, cited: true, read: true, used: true, tier: "used" });

  // Read via code but never cited/fetched — caught ONLY by the code scan.
  const norm = by("stage1/normalized_matrix.csv");
  assert.deepEqual({ read: norm.read, cited: norm.cited, fetched: norm.fetched, used: norm.used, tier: norm.tier }, { read: true, cited: false, fetched: false, used: true, tier: "used" });

  // The inputs/input/ double-prefix path resolves correctly.
  assert.equal(by("input/sample_metadata.csv").read, true);

  // Staged but never touched -> the waste signal.
  const goAll = by("stage2/go_enrichment_all.csv");
  assert.deepEqual({ staged: goAll.staged, used: goAll.used, stagedUnused: goAll.stagedUnused, tier: goAll.tier }, { staged: true, used: false, stagedUnused: true, tier: "staged" });

  // Neither staged nor used -> available only.
  const avail = by("stage2/go_enrichment_redundancy_removed.csv");
  assert.deepEqual({ staged: avail.staged, used: avail.used, stagedUnused: avail.stagedUnused, tier: avail.tier }, { staged: false, used: false, stagedUnused: false, tier: "available" });

  assert.equal(annotated.filter((e) => e.usage.used).length, 6);
  assert.equal(annotated.filter((e) => e.usage.stagedUnused).length, 2);
});

test("annotateCatalogUsage does not mark a catalog input used when only an agent OUTPUT is cited", () => {
  const entries = [{ path: "stage1/volcano_results.tsv" }];
  const annotated = annotateCatalogUsage(entries, { staged: [], fetched: [], cited: ["outputs/my_result.csv"], codeText: "open('outputs/my_result.csv','w')" });
  assert.equal(annotated[0].usage.used, false);
  assert.equal(annotated[0].usage.tier, "available");
});

test("renderResearchCatalogHtml lists frozen catalog entries with descriptions and usage", () => {
  const html = renderResearchCatalogHtml({
    runId: "RUN-CAT",
    usedCount: 1,
    stagedUnusedCount: 1,
    catalog: [
      {
        path: "stage1/volcano_results.tsv",
        family: "differential-expression",
        stage: "stage1",
        bytes: 2048,
        rowCount: 1,
        description: "Differential expression table",
        derivation: "Welch t-test over normalized abundance.",
        usage: { read: true, used: true, staged: true },
      },
      {
        path: "stage2/go_enrichment_all.csv",
        family: "go-enrichment",
        description: "GO enrichment table",
        usage: { stagedUnused: true, staged: true },
      },
    ],
  });
  assert.match(html, /Artifact Catalog/);
  assert.match(html, /RUN-CAT/);
  assert.match(html, /stage1\/volcano_results\.tsv/);
  assert.match(html, /Differential expression table/);
  assert.match(html, /read/);
  assert.match(html, /staged unused/);
});
