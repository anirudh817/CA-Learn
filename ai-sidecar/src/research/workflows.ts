import fs from "node:fs";
import path from "node:path";
import type { FilesystemRunCatalog } from "../run-catalog.js";

type Control = { id: string; label: string; type: "select" | "multiselect" | "number" | "text" | "toggle"; options?: string[]; default: unknown; requiredWhen?: string };
type Candidate = { kind: string; id: string; label: string; whySuggested: string; evidenceRefs: string[] };
type FullFileRule = { mode: "full-analytical-file" | "full-sample-context" | "full-source-text"; files: string[]; reason: string; requiredFor: string[] };

export interface WorkflowDefinition {
  id: string;
  version: "1.0";
  label: string;
  decisionPrompt: string;
  description: string;
  starterTemplates: string[];
  targetKinds: string[];
  controls: Control[];
  autoSlices: string[];
  fullFileRules: FullFileRule[];
  requiredFamilies: string[];
  requiredFilePatterns: string[];
  externalSources: string[];
  computeTier: "reviewed" | "reviewed-plus-external";
  executionStatus: "executable" | "limited" | "preview";
  executionNote: string;
  outputContract: string[];
  stopRuleTemplate: string;
  estimatedSeconds: number;
  defaultBudgetUsd: number;
  skills: ReadonlyArray<{ id: string; entrypoint: string; parameters: Record<string, unknown> }>;
}

const commonControls = (lenses: string[], defaults: string[]): Control[] => [
  { id: "target", label: "Suggested target", type: "select", options: [], default: "", requiredWhen: "a target candidate is available" },
  { id: "lenses", label: "Research lenses", type: "multiselect", options: lenses, default: defaults },
  { id: "includeRecommendedFullFiles", label: "Include recommended full files", type: "toggle", default: false },
];

export const RESEARCH_WORKFLOWS: readonly WorkflowDefinition[] = [
  {
    id: "finding-stress-test", version: "1.0", label: "Finding Stress Test",
    decisionPrompt: "Is this result stable enough to prioritize, or does it depend on thresholds, samples, missingness, or an analytical choice?",
    description: "Stress-test a feature, module, GO term, or cell-reference result before interpreting it.",
    starterTemplates: [
      "Stress-test [target] across adjusted-p and fold-change thresholds. Which conclusions remain unchanged?",
      "Is [target] driven by one or two samples? Run leave-one-sample-out influence and identify the samples that matter.",
      "Why did this run produce few or no significant findings: power, missingness, effect size, mapping, or strict controls?",
    ],
    targetKinds: ["borderline-feature", "top-feature", "trait-module", "go-term", "cell-result", "diagnosis"],
    controls: commonControls(["threshold sweep", "leave-one-out", "bootstrap stability", "missingness audit", "group-balance check"], ["threshold sweep"]),
    autoSlices: ["selected result rows", "analysis summaries", "stats control audit", "stage configuration"],
    fullFileRules: [{ mode: "full-sample-context", files: ["normalized_matrix.csv", "sample_metadata.csv", "traits.csv", "cleaned_matrix.csv"], reason: "Sample influence, resampling, missingness, and alternative-model checks require values for every approved sample.", requiredFor: ["leave-one-out", "bootstrap stability", "missingness audit", "group-balance check"] }],
    requiredFamilies: ["differential-expression"], requiredFilePatterns: ["volcano_results.tsv|differential.*\\.(csv|tsv)"],
    externalSources: [], computeTier: "reviewed", executionStatus: "executable", executionNote: "Reviewed offline threshold-sensitivity executor is available. Sample-level lenses require the recommended full context.",
    outputContract: ["stability verdict", "sensitivity table", "sensitivity plot", "influential-sample list when supported", "decision implication"],
    stopRuleTemplate: "Stop when the verdict is unchanged across the approved perturbation grid or remaining uncertainty requires unavailable data.", estimatedSeconds: 90, defaultBudgetUsd: 0,
    skills: [
      { id: "exploratory-data-analysis", entrypoint: "summarize", parameters: {} },
      { id: "stage1-finding-stability", entrypoint: "threshold-sweep", parameters: { thresholds: [0.01, 0.05, 0.1] } },
      { id: "scientific-visualization", entrypoint: "summary-figure", parameters: { label: "Finding stress test and threshold sensitivity" } },
      { id: "finding-stress-test-synthesis", entrypoint: "synthesize", parameters: {} },
    ],
  },
  {
    id: "ranked-pathway-investigation", version: "1.0", label: "Ranked Pathway Investigation",
    decisionPrompt: "Which biological programs appear across the full ordered signal, and where do they agree with or diverge from Stage 2 module ORA?",
    description: "Look beyond the hit cutoff using the complete Stage 1 ranking while preserving the distinction from Stage 2 Fisher enrichment.",
    starterTemplates: ["Run a preranked pathway analysis over all Stage 1 features and compare it with Stage 2 module ORA.", "Which pathways are driven by a small leading edge versus a broad coordinated shift?", "Why does [Stage 2 term] appear in ORA but not in the full ranked analysis, or vice versa?"],
    targetKinds: ["go-term", "top-feature", "diagnosis"], controls: commonControls(["preranked enrichment", "leading edge", "up/down split", "gene-set redundancy", "module concordance"], ["preranked enrichment", "leading edge"]),
    autoSlices: ["Stage 2 term rows", "Stage 2 configuration and summary", "module membership rows", "Stage 1 ranking columns"],
    fullFileRules: [{ mode: "full-analytical-file", files: ["volcano_results.tsv", "gene-set-reference.gmt"], reason: "Ranked enrichment must use every ranked feature and a frozen gene-set reference; significant-only lists would bias the result.", requiredFor: ["preranked enrichment", "leading edge", "up/down split"] }],
    requiredFamilies: ["differential-expression", "go-enrichment"], requiredFilePatterns: ["volcano_results.tsv", "go_enrichment.*\\.(csv|tsv)"], externalSources: ["reactome", "quickgo"], computeTier: "reviewed", executionStatus: "executable", executionNote: "Reviewed offline comparison of the complete Stage 1 effect ranking with Stage 2 ORA is available and is explicitly labeled as not GSEA.",
    outputContract: ["convergent/divergent pathway table", "enrichment plot", "leading-edge proteins", "method comparison", "prominent ranked-method-not-Stage-2 label"],
    stopRuleTemplate: "Stop after leading edges and method disagreements are explained; add no database that cannot change the decision.", estimatedSeconds: 120, defaultBudgetUsd: 0,
    skills: [{ id: "signalfold-workflow-recipes", entrypoint: "run", parameters: { recipe: "ranked-pathway", seed: 0 } }],
  },
  {
    id: "module-hub-investigation", version: "1.0", label: "Module Hub Investigation",
    decisionPrompt: "Which members represent or organize a module after separating membership, sample-level connectivity, differential effect, trait relation, and external biology?",
    description: "Separate kME membership from genuine within-module connectivity and biological priority.",
    starterTemplates: ["Rank members of [module] by kME, differential effect, and trait relevance while keeping each dimension separate.", "Does the apparent hub remain central when within-module correlations are recomputed from approved samples?", "Is [protein] truly central to this module or merely a strong module member?"],
    targetKinds: ["trait-module", "module-member", "top-feature", "diagnosis"], controls: commonControls(["kME membership", "effect/trait overlay", "within-module correlation", "TOM/centrality", "STRING", "literature support"], ["kME membership", "effect/trait overlay"]),
    autoSlices: ["module assignments", "selected kME rows", "module-trait correlations", "differential-expression rows", "Stage 1 controls"],
    fullFileRules: [{ mode: "full-sample-context", files: ["normalized_matrix.csv", "sample_metadata.csv"], reason: "A protein network must be computed from selected module members across samples. stage1/network_edges.csv links module eigengenes and is not a protein PPI.", requiredFor: ["within-module correlation", "TOM/centrality"] }],
    requiredFamilies: ["module-assignments"], requiredFilePatterns: ["module_assignments.csv", "kme_matrix.csv", "normalized_matrix.csv"], externalSources: ["string"], computeTier: "reviewed-plus-external", executionStatus: "executable", executionNote: "Reviewed multi-axis hub ranking and sample-level within-module correlation graphing are available; module-eigengene network_edges.csv is never treated as PPI.",
    outputContract: ["multi-axis candidate table", "separately labeled membership/connectivity/effect/trait scores", "within-module graph when supported", "stability limitation"],
    stopRuleTemplate: "Stop when top candidates are stable across approved graph thresholds or sample size makes centrality uninterpretable.", estimatedSeconds: 180, defaultBudgetUsd: 0,
    skills: [{ id: "signalfold-workflow-recipes", entrypoint: "run", parameters: { recipe: "module-hub", seed: 0 } }],
  },
  {
    id: "external-protein-evidence", version: "1.0", label: "External Protein Evidence",
    decisionPrompt: "What public evidence supports, challenges, or contextualizes selected run proteins in the specified disease, tissue, species, cohort, and assay context?",
    description: "Bind curated public knowledge to exact SignalFold rows and explicit identifier mappings.",
    starterTemplates: ["For my top [N] Stage 1 proteins, summarize function, pathway, tissue, interaction, and disease evidence tied to each exact run row.", "What is known about [protein] in [disease/tissue], and how directly does it bear on this run?", "Resolve ambiguous identifiers before research and show every mapping decision."],
    targetKinds: ["top-feature", "borderline-feature", "module-member", "diagnosis"], controls: commonControls(["UniProt identity/function", "PubMed/PMC", "Reactome", "STRING", "tissue expression", "disease evidence"], ["UniProt identity/function", "PubMed/PMC"]),
    autoSlices: ["exact DE/module rows", "group direction", "assay level", "species and tissue metadata", "identifier candidates"],
    fullFileRules: [{ mode: "full-analytical-file", files: ["volcano_results.tsv"], reason: "The full cohort result table is only needed for cohort-wide prioritization or background-aware comparison.", requiredFor: ["cohort-wide prioritization"] }],
    requiredFamilies: ["differential-expression"], requiredFilePatterns: ["volcano_results.tsv|differential.*\\.(csv|tsv)"], externalSources: ["uniprot", "pubmed", "pmc", "reactome", "string", "quickgo"], computeTier: "reviewed-plus-external", executionStatus: "executable", executionNote: "Reviewed run-identifier mapping records and all six curated broker adapters are available; ambiguous mappings remain explicit.",
    outputContract: ["per-protein observation cards", "mapped identifiers and ambiguity record", "support/challenge/context evidence", "evidence gaps", "retrieval receipts"],
    stopRuleTemplate: "Stop when more sources repeat the same claim or cannot reduce an explicit evidence gap.", estimatedSeconds: 180, defaultBudgetUsd: 0.5,
    skills: [{ id: "signalfold-workflow-recipes", entrypoint: "run", parameters: { recipe: "external-protein-evidence", seed: 0 } }],
  },
  {
    id: "run-literature-contradiction", version: "1.0", label: "Run vs Literature Contradiction Check",
    decisionPrompt: "Where does this run disagree with published expectations, and can tissue, species, assay, cohort, direction, threshold, or study design explain it?",
    description: "Treat disagreements as a structured research product instead of forcing consensus.",
    starterTemplates: ["Find directional claims in this run that conflict with literature in the same disease and tissue.", "For [target], separate genuine contradiction from model, species, tissue, assay, cohort, or endpoint differences.", "Compare this run with attached papers; use full text when abstracts cannot establish methods or direction."],
    targetKinds: ["top-feature", "go-term", "cell-result", "trait-module", "diagnosis"], controls: commonControls(["directional claim extraction", "context matching", "attached full papers", "replication evidence", "methods comparison", "novelty check"], ["directional claim extraction", "context matching"]),
    autoSlices: ["selected directional claims", "pipeline controls", "linked module/GO/cell rows", "species/tissue/cohort metadata"],
    fullFileRules: [{ mode: "full-source-text", files: ["attached-paper.pdf|open-full-text"], reason: "Abstracts cannot reliably establish methods, subgroup, direction, or null-result interpretation; preserve page and section anchors.", requiredFor: ["attached full papers", "methods comparison"] }],
    requiredFamilies: ["differential-expression"], requiredFilePatterns: ["volcano_results.tsv|differential.*\\.(csv|tsv)"], externalSources: ["pubmed", "pmc", "uniprot", "reactome", "quickgo"], computeTier: "reviewed-plus-external", executionStatus: "executable", executionNote: "Reviewed directional claim register and context-difference framework are available; curated external evidence remains separately receipted.",
    outputContract: ["contradiction register", "context-difference classifications", "evidence anchors", "discriminating follow-up experiments"],
    stopRuleTemplate: "Stop after every high-priority contradiction has a context classification and at least one concrete discriminator.", estimatedSeconds: 240, defaultBudgetUsd: 0.75,
    skills: [{ id: "signalfold-workflow-recipes", entrypoint: "run", parameters: { recipe: "literature-contradiction", seed: 0 } }],
  },
  {
    id: "power-next-experiment", version: "1.0", label: "Power and Next Experiment",
    decisionPrompt: "What feasible follow-up design most efficiently reduces this run's uncertainty under realistic sample, cost, balance, blocking, and measurement constraints?",
    description: "Turn uncertainty into explicit sample-size, design, assumption, and information-gain trade-offs.",
    starterTemplates: ["Estimate sample size for [target] across plausible variance and dropout assumptions.", "Given at most [N] samples, what minimum detectable effect is realistic?", "Compare balanced, blocked, and paired next-study designs and show every assumption."],
    targetKinds: ["borderline-feature", "top-feature", "trait-module", "diagnosis"], controls: [...commonControls(["sample size / MDE", "assumption ranges", "balanced design", "blocking/pairing", "simulation", "information-gain ranking"], ["sample size / MDE", "assumption ranges"]), { id: "maxSamples", label: "Maximum feasible samples", type: "number", default: 0 }],
    autoSlices: ["selected uncertainty", "group counts", "effect and variance estimates", "missingness", "analysis controls"],
    fullFileRules: [{ mode: "full-sample-context", files: ["normalized_matrix.csv", "sample_metadata.csv", "traits.csv", "cleaned_matrix.csv"], reason: "Defensible variance, dropout, balance, blocking, and simulation estimates require full pilot sample context.", requiredFor: ["sample size / MDE", "blocking/pairing", "simulation", "information-gain ranking"] }],
    requiredFamilies: ["differential-expression"], requiredFilePatterns: ["normalized_matrix.csv", "sample_metadata.csv"], externalSources: [], computeTier: "reviewed", executionStatus: "executable", executionNote: "Reviewed deterministic sensitivity scenarios and balanced blocked-design recommendation are available; all pilot assumptions are emitted with the result.",
    outputContract: ["decision table", "design file", "assumptions register", "sample/cost trade-off", "stopping rule"],
    stopRuleTemplate: "Stop when one feasible design dominates on information gain per cost or missing assumptions prevent a defensible estimate.", estimatedSeconds: 180, defaultBudgetUsd: 0,
    skills: [{ id: "signalfold-workflow-recipes", entrypoint: "run", parameters: { recipe: "power-next-experiment", seed: 0 } }],
  },
] as const;

/** Open investigation is the unconstrained agentic MODE, not one of the structured cards.
 *  It lives outside RESEARCH_WORKFLOWS so the card catalog stays at six and every
 *  member there remains offline-executable; the job lookups resolve it through
 *  findWorkflow(). It reuses the whole plan/scope/synthesis/package machinery. */
export const FREEFORM_WORKFLOW: WorkflowDefinition = {
  id: "freeform", version: "1.0", label: "Open investigation",
  decisionPrompt: "What does this run actually show for my question, and how confident can we be — worked out by open agentic analysis over the frozen run?",
  description: "Sandboxed agentic analysis: the model plans, writes and runs code over the frozen run, and may reach for any available skill to answer the question.",
  starterTemplates: ["[Ask anything about this run — e.g. how many samples would I need to confirm the top Stage 1 hit, or which module is most trait-relevant and why.]"],
  targetKinds: ["top-feature", "borderline-feature", "trait-module", "go-term", "cell-result", "module-member", "diagnosis"],
  controls: [], autoSlices: ["run summaries", "stage configurations", "analysis controls"],
  fullFileRules: [], requiredFamilies: [], requiredFilePatterns: [],
  externalSources: [], computeTier: "reviewed", executionStatus: "executable",
  executionNote: "Open investigation: full agentic capability inside a sandboxed workspace (egress off, run data read-only); every code run is captured with its hash; all disk skills are loaded.",
  outputContract: ["agent findings (cited)", "evidence trail", "activity trace", "captured generated code", "narrated answer"],
  stopRuleTemplate: "Stop when the objective is answered with cited run evidence, or the remaining uncertainty requires data absent from this run.",
  estimatedSeconds: 240, defaultBudgetUsd: 0,
  skills: [
    { id: "freeform-agent", entrypoint: "investigate", parameters: {} },
    { id: "freeform-synthesis", entrypoint: "synthesize", parameters: {} },
  ],
};

/** Resolve a workflow by id across the structured cards and the open-investigation mode. */
export function findWorkflow(workflowId: string): WorkflowDefinition | undefined {
  return workflowId === FREEFORM_WORKFLOW.id ? FREEFORM_WORKFLOW : RESEARCH_WORKFLOWS.find((item) => item.id === workflowId);
}

const splitLine = (line: string, delimiter: string) => {
  const values: string[] = []; let value = ""; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"' && quoted) { value += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) { values.push(value.trim()); value = ""; }
    else value += char;
  }
  values.push(value.trim()); return values;
};

const tableRows = (filename: string, maxRows = 5000): Array<Record<string, string> & { __row: string }> => {
  try {
    const lines = fs.readFileSync(filename, "utf8").split(/\r?\n/).filter(Boolean).slice(0, maxRows + 1);
    if (lines.length < 2) return [];
    const delimiter = filename.toLowerCase().endsWith(".tsv") ? "\t" : ",";
    const headers = splitLine(lines[0], delimiter).map((item) => item.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
    return lines.slice(1).map((line, index) => Object.assign({ __row: String(index + 2) }, Object.fromEntries(splitLine(line, delimiter).map((value, column) => [headers[column] || `column_${column + 1}`, value]))));
  } catch { return []; }
};

const pick = (row: Record<string, string>, patterns: RegExp[]) => Object.entries(row).find(([key]) => patterns.some((pattern) => pattern.test(key)))?.[1] || "";
const numeric = (value: string) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };
const evidenceRef = (rel: string, row: Record<string, string>) => `${rel}#row:${row.__row}`;

function inspectCandidates(catalog: FilesystemRunCatalog, runId: string): Candidate[] {
  const run = catalog.get(runId); if (!run) throw new Error("Selected run is unavailable or not complete");
  const files = catalog.context(runId); const candidates: Candidate[] = [];
  const add = (candidate: Candidate) => { if (!candidates.some((item) => item.kind === candidate.kind && item.id === candidate.id)) candidates.push(candidate); };
  const de = files.find((item) => /(?:volcano|differential).*(?:csv|tsv)$/i.test(item.path));
  if (de) {
    const rows = tableRows(path.join(run.path, de.path));
    const enriched = rows.map((row) => ({ row, id: pick(row, [/^gene$/, /protein/, /feature/, /accession/, /^id$/]) || `row ${row.__row}`, fc: numeric(pick(row, [/log2.*fc/, /fold.*change/, /^effect$/])), adj: numeric(pick(row, [/adj.*p/, /fdr/, /q_value/])) }));
    const effects = enriched.filter((item) => item.fc !== null).sort((a, b) => Math.abs(b.fc!) - Math.abs(a.fc!));
    for (const item of effects.slice(0, 3)) add({ kind: "top-feature", id: item.id, label: item.id, whySuggested: `One of the largest absolute effects in the complete Stage 1 table (${item.fc!.toFixed(3)} log2 scale${item.adj === null ? "" : `; adjusted p ${item.adj}`} ).`, evidenceRefs: [evidenceRef(de.path, item.row)] });
    const borderline = enriched.filter((item) => item.fc !== null && item.adj !== null).sort((a, b) => Math.abs(a.adj! - 0.05) - Math.abs(b.adj! - 0.05))[0];
    if (borderline) add({ kind: "borderline-feature", id: borderline.id, label: borderline.id, whySuggested: `Large or notable effect with an adjusted p-value near the common 0.05 decision boundary (${borderline.adj}); threshold sensitivity may change its status.`, evidenceRefs: [evidenceRef(de.path, borderline.row)] });
  }
  const trait = files.find((item) => /module_trait_cor.*(?:csv|tsv)$/i.test(item.path));
  if (trait) {
    const scored = tableRows(path.join(run.path, trait.path)).flatMap((row) => Object.entries(row).filter(([key, value]) => /^cor_/.test(key) && numeric(value) !== null).map(([key, value]) => ({ row, key, value: Number(value), module: pick(row, [/module/, /color/]) || `row ${row.__row}` }))).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    const top = scored[0]; if (top) add({ kind: "trait-module", id: top.module, label: top.module, whySuggested: `Strongest available absolute module-trait relationship (${top.key} = ${top.value.toFixed(3)}).`, evidenceRefs: [evidenceRef(trait.path, top.row)] });
  }
  const kme = files.find((item) => /kme_matrix.*(?:csv|tsv)$/i.test(item.path));
  if (kme) {
    const scored = tableRows(path.join(run.path, kme.path)).flatMap((row) => Object.entries(row).filter(([key, value]) => /(?:^kme|membership)/.test(key) && numeric(value) !== null).map(([key, value]) => ({ row, key, value: Number(value), id: pick(row, [/protein/, /gene/, /feature/, /^id$/]) || `row ${row.__row}` }))).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    for (const item of scored.slice(0, 3)) add({ kind: "module-member", id: item.id, label: item.id, whySuggested: `High module membership (${item.key} = ${item.value.toFixed(3)}); membership is evidence, not a protein-network centrality claim.`, evidenceRefs: [evidenceRef(kme.path, item.row)] });
  }
  const go = files.find((item) => /(?:go_enrichment|enrichment).*(?:csv|tsv)$/i.test(item.path));
  if (go) {
    const scored = tableRows(path.join(run.path, go.path)).map((row) => ({ row, id: pick(row, [/^term$/, /description/, /pathway/, /^name$/]) || `row ${row.__row}`, score: numeric(pick(row, [/fdr/, /adj.*p/, /q_value/, /^pvalue$/])) })).filter((item) => item.score !== null).sort((a, b) => a.score! - b.score!);
    for (const item of scored.slice(0, 3)) add({ kind: "go-term", id: item.id, label: item.id, whySuggested: `Among the strongest Stage 2 over-representation rows (FDR/adjusted p ${item.score}); this is ORA, not GSEA.`, evidenceRefs: [evidenceRef(go.path, item.row)] });
  }
  const cell = files.find((item) => /cell.*(?:enrich|type|fet).*(?:csv|tsv)$/i.test(item.path));
  if (cell) {
    const scored = tableRows(path.join(run.path, cell.path)).map((row) => ({ row, id: pick(row, [/cell.*type/, /reference/, /label/, /^term$/]) || `row ${row.__row}`, score: numeric(pick(row, [/fdr/, /adj.*p/, /q_value/, /^pvalue$/])) })).filter((item) => item.score !== null).sort((a, b) => a.score! - b.score!);
    for (const item of scored.slice(0, 2)) add({ kind: "cell-result", id: item.id, label: item.id, whySuggested: `Strong Stage 3 cell-reference overlap row (FDR/adjusted p ${item.score}); this is enrichment, not estimated cell abundance.`, evidenceRefs: [evidenceRef(cell.path, item.row)] });
  }
  if (!candidates.length) add({ kind: "diagnosis", id: "empty-result-audit", label: "Diagnose the empty or unreadable result", whySuggested: "No supported target row could be derived deterministically; inspect power, mapping, universe, thresholds, and missing context before interpretation.", evidenceRefs: files.filter((item) => /summary|config|audit/i.test(item.path)).slice(0, 4).map((item) => item.path) });
  return candidates;
}

/* ----------------------------------------------------------------------------
 * Investigation launchers. Each of the six structured cards is now a LAUNCHER for
 * the open-investigation plane, not a fixed skill pipeline: a short, run-aware form whose
 * values compose a high-quality investigation OBJECTIVE. The pipeline-science guards
 * are baked into every composed prompt so the agent can never mislabel ORA/GSEA,
 * eigengene-graph/PPI, kME/centrality, FET/abundance, or continuous/negative-
 * binomial. Run-derived picks reuse inspectCandidates(); the composed objective
 * is launched through the open-investigation path (workflow_id "freeform").
 * ------------------------------------------------------------------------- */

export type LauncherFieldType = "select" | "multiselect" | "toggle" | "number" | "text";
export interface LauncherOption { value: string; label: string; hint?: string }
export interface LauncherField {
  id: string; label: string; type: LauncherFieldType; default: unknown;
  options?: ReadonlyArray<string | LauncherOption>; from?: "candidates"; kinds?: ReadonlyArray<string>; help?: string; placeholder?: string;
}

/** The short form each card solicits. A `from: "candidates"` field has its
 *  options filled at runtime from the run-derived targets (inspectCandidates),
 *  so every "pick" is grounded in a real run row rather than free text. */
const LAUNCHER_FORMS: Record<string, ReadonlyArray<LauncherField>> = {
  "finding-stress-test": [
    { id: "target", label: "Result to stress-test", type: "select", from: "candidates", default: "", help: "A borderline/top feature, trait-module, GO term, or cell result from this run." },
    { id: "perturbations", label: "Perturbations", type: "multiselect", default: ["threshold sweep"], options: ["threshold sweep", "leave-one-sample-out", "missingness audit", "group-balance check"] },
    { id: "decisionAdjP", label: "Decision adjusted-p", type: "number", default: 0.05, help: "Significance boundary used throughout the stress test." },
  ],
  "ranked-pathway-investigation": [
    { id: "target", label: "Focus (optional)", type: "select", from: "candidates", default: "", help: "Leave empty to analyze the full Stage 1 ranking." },
    { id: "geneSetSource", label: "Gene-set source", type: "select", default: "GO-BP", options: ["GO-BP", "Reactome"] },
    { id: "compareToORA", label: "Compare with Stage 2 ORA", type: "toggle", default: true },
    { id: "leadingEdge", label: "Report leading-edge proteins", type: "toggle", default: true },
  ],
  "module-hub-investigation": [
    { id: "module", label: "Module", type: "select", from: "candidates", kinds: ["trait-module"], default: "", help: "A trait-relevant module derived from this run." },
    { id: "axes", label: "Ranking axes (kept separate)", type: "multiselect", default: ["kME membership", "within-module connectivity", "differential effect"], options: ["kME membership", "within-module connectivity", "differential effect", "trait relation", "STRING"] },
  ],
  "external-protein-evidence": [
    { id: "proteins", label: "Proteins (each tied to its run row)", type: "multiselect", from: "candidates", kinds: ["top-feature", "borderline-feature", "module-member"], default: [] },
    { id: "context", label: "Disease / tissue / species context", type: "text", default: "", placeholder: "e.g. Alzheimer's disease, human brain" },
    { id: "sources", label: "Public sources", type: "multiselect", default: ["UniProt", "PubMed/PMC"], options: ["UniProt", "PubMed/PMC", "Reactome", "STRING"] },
  ],
  "run-literature-contradiction": [
    { id: "target", label: "Claim to check", type: "select", from: "candidates", default: "" },
    { id: "context", label: "Disease / tissue / cohort", type: "text", default: "", placeholder: "e.g. Alzheimer's disease, human CSF" },
    { id: "sources", label: "Public sources", type: "multiselect", default: ["PubMed/PMC"], options: ["PubMed/PMC", "UniProt", "Reactome"] },
  ],
  "power-next-experiment": [
    { id: "target", label: "Uncertainty to resolve", type: "select", from: "candidates", default: "" },
    { id: "maxSamples", label: "Max feasible samples", type: "number", default: 0, help: "0 means no explicit cap." },
    { id: "design", label: "Design", type: "select", default: "balanced", options: ["balanced", "blocked", "paired"] },
    { id: "assumptions", label: "Effect / variance assumptions (optional)", type: "text", default: "", placeholder: "defaults to the run's own pilot variance" },
  ],
};

/** The science contract appended to every composed objective. The open-investigation
 *  agent's own system prompt also carries these guards; repeating them in the
 *  objective keeps each composed prompt self-contained and editable. */
const PIPELINE_GUARD = "Respect exactly what this SignalFold run computed and never relabel it: Stage 1 differential expression is a Welch t-test on continuous protein intensities (not limma or DESeq2, never a negative-binomial/count model) plus WGCNA-equivalent eigengene modules; Stage 2 is GO over-representation (Fisher/ORA), not GSEA; Stage 3 is cell-type Fisher enrichment over marker sets, not cell-abundance deconvolution. stage1/network_edges.csv is an eigengene graph, not a protein PPI, and kME membership is not network centrality. Cite every claim to the exact frozen run file and row(s) it rests on, and state your assumptions and limitations.";

const asArray = (value: unknown): string[] => Array.isArray(value) ? value.map((item) => String(item)) : (value === undefined || value === null || value === "") ? [] : [String(value)];
const asText = (value: unknown): string => (value === undefined || value === null) ? "" : String(value).trim();
const joinOr = (items: string[], fallback: string) => items.length ? items.join(", ") : fallback;
const targetPhrase = (target: Candidate | null, fallback: string) => target ? `${target.label} (run-cited at ${target.evidenceRefs.join(", ")})` : fallback;

/** Run-derived candidates for a workflow, filtered to the kinds it targets. */
function workflowCandidates(catalog: FilesystemRunCatalog, runId: string, workflowId: string): Candidate[] {
  const workflow = findWorkflow(workflowId);
  if (!workflow || workflowId === "freeform") throw new Error("Unknown research workflow");
  return inspectCandidates(catalog, runId).filter((item) => workflow.targetKinds.includes(item.kind));
}

/** Fill a card's form: candidate-backed fields get real run rows as options,
 *  narrowed to the kinds the field actually means (a "Module" picker offers
 *  modules, a protein picker offers proteins — never a mislabeled mix). */
function fillLauncherFields(workflowId: string, candidates: Candidate[]): LauncherField[] {
  return (LAUNCHER_FORMS[workflowId] || []).map((field) => {
    if (field.from !== "candidates") return { ...field };
    const pool = field.kinds ? candidates.filter((item) => field.kinds!.includes(item.kind)) : candidates;
    const options: LauncherOption[] = pool.map((item) => ({ value: item.id, label: item.label, hint: item.whySuggested }));
    const ids = pool.map((item) => item.id);
    return { ...field, options, default: field.type === "multiselect" ? ids.slice(0, 3) : (ids[0] || "") };
  });
}

/** fields -> a guard-bearing investigation objective. Pure and deterministic. */
function composeFreeformObjective(workflowId: string, ctx: { targets: Candidate[]; values: Record<string, unknown> }): string {
  const v = ctx.values || {};
  const byId = (id: unknown) => ctx.targets.find((item) => item.id === String(id)) || null;
  const footer = `\n\n${PIPELINE_GUARD}`;
  switch (workflowId) {
    case "finding-stress-test": {
      const target = byId(v.target) || ctx.targets[0] || null;
      const perturbations = joinOr(asArray(v.perturbations), "a threshold sweep");
      const adjp = asText(v.decisionAdjP) || "0.05";
      return `Decide whether ${targetPhrase(target, "this run's most notable Stage 1 result")} is stable enough to prioritize, or whether it depends on analytical choices. Treat that result as the claim under test.\n\nApply these stability perturbations and report, for each, which conclusions survive and which flip: ${perturbations}. Use an adjusted-p threshold of ${adjp} as the significance decision boundary throughout. Because Stage 1 significance comes from a Welch t-test on continuous intensities, sweep thresholds and run leave-one-sample-out / missingness / group-balance checks on those continuous values — do not substitute a count or negative-binomial model. Finish with one stability verdict (robust, fragile, or sample-driven) and the perturbation that most changes it.${footer}`;
    }
    case "ranked-pathway-investigation": {
      const target = byId(v.target);
      const focus = target ? ` focusing on ${targetPhrase(target, "")}` : "";
      const source = asText(v.geneSetSource) || "GO-BP";
      const lines = [`Investigate which biological programs appear across the COMPLETE Stage 1 ranking${focus}, beyond the significance cutoff. Rank every Stage 1 feature by its signed continuous Welch effect, then run a preranked gene-set enrichment over the full ordered list using ${source} gene sets. This is a ranked-method analysis: label it as such and do NOT call it permutation GSEA.`];
      if (v.compareToORA !== false) lines.push(`Compare the ranked result against this run's Stage 2 GO over-representation (ORA) output and explain where they agree and diverge. ORA is a Fisher test on the significant-hit list while the full-ranking method answers a different question, so treat ORA≠ranked as a real distinction, not a discrepancy to reconcile away.`);
      if (v.leadingEdge !== false) lines.push(`For each enriched set, report the leading-edge proteins (the exact run rows driving it) and whether it is carried by a few large effects or a broad coordinated shift.`);
      return `${lines.join("\n\n")}${footer}`;
    }
    case "module-hub-investigation": {
      const target = byId(v.module) || ctx.targets[0] || null;
      const axes = joinOr(asArray(v.axes), "kME membership, within-module connectivity, and differential effect");
      return `For module ${targetPhrase(target, "this run's most trait-relevant module")}, determine which members truly REPRESENT or ORGANIZE it, separating membership from genuine connectivity and biological priority.\n\nScore each member on these axes and KEEP EACH AXIS SEPARATE — do not collapse them into a single score: ${axes}. Produce a small candidate table ranked per axis. Compute any within-module protein graph FROM the normalized intensity matrix across the run's approved samples; do NOT use stage1/network_edges.csv, which is a module-eigengene graph, not a protein PPI. Treat kME as membership evidence, explicitly NOT network centrality, and flag where the sample size makes a centrality claim uninterpretable.${footer}`;
    }
    case "external-protein-evidence": {
      const ids = asArray(v.proteins);
      const chosen = (ids.length ? ids.map(byId) : ctx.targets.slice(0, 3)).filter((item): item is Candidate => Boolean(item));
      const proteinList = chosen.length ? chosen.map((item) => `${item.label} (${item.evidenceRefs.join(", ")})`).join("; ") : "this run's top Stage 1 proteins";
      const context = asText(v.context);
      const sources = joinOr(asArray(v.sources), "UniProt and PubMed/PMC");
      return `Gather and weigh public evidence for these run proteins${context ? ` in the context of ${context}` : ""}, tying every statement back to their exact Stage 1 rows: ${proteinList}.\n\nFor each protein: (1) map the run identifier to public identifiers EXPLICITLY and record any ambiguity instead of guessing; (2) summarize what ${sources} report about its function, pathway, tissue/disease relevance, and interactions; (3) label each piece of evidence as SUPPORTING, CHALLENGING, or CONTEXTUALIZING this run's finding for that protein; (4) list the remaining evidence gaps. The run's own contribution is the Welch effect and direction at the cited row — keep that distinct from external claims.${footer}`;
    }
    case "run-literature-contradiction": {
      const target = byId(v.target) || ctx.targets[0] || null;
      const context = asText(v.context);
      const sources = joinOr(asArray(v.sources), "PubMed/PMC");
      return `Build a contradiction register for ${targetPhrase(target, "this run's strongest directional claims")}: where does this run disagree with published expectations${context ? ` for ${context}` : ""}, and why?\n\nExtract this run's directional claim (the sign and magnitude of the Welch effect at the cited row). Search ${sources} for published expectations on the same entity${context ? ` in ${context}` : ""}. For each disagreement, classify it as a GENUINE contradiction or as one explained by a difference in tissue, species, assay or platform, cohort, effect direction, or significance threshold — do not force consensus. For every genuine contradiction, propose one concrete discriminating experiment that would resolve it.${footer}`;
    }
    case "power-next-experiment": {
      const target = byId(v.target) || ctx.targets[0] || null;
      const maxSamples = Number(asText(v.maxSamples) || 0);
      const design = asText(v.design) || "balanced";
      const assumptions = asText(v.assumptions);
      return `Recommend the most informative feasible follow-up to reduce this run's uncertainty about ${targetPhrase(target, "this run's least certain result")}.\n\nEstimate the required sample size and minimum detectable effect to confirm it, deriving the pilot variance from THIS run's own normalized intensities for the relevant feature(s). Sweep across a plausible range of effect-size and dropout assumptions.${assumptions ? ` Use these starting assumptions where stated: ${assumptions}.` : ""}${maxSamples > 0 ? ` Cap feasible samples at ${maxSamples}.` : ""} Because Stage 1 is a Welch t-test on continuous intensities, use a continuous two-sample / t-test power model — NOT a negative-binomial or count model. Recommend a ${design} design and EMIT every assumption you use (variance source, effect size, alpha, power, dropout). Conclude with one recommended design and its stopping rule.${footer}`;
    }
    default:
      throw new Error("Unknown research workflow");
  }
}

/** Resolve a card's form values into a launchable investigation objective. */
export function composeLauncher(catalog: FilesystemRunCatalog, runId: string, workflowId: string, values: Record<string, unknown> = {}): string {
  return composeFreeformObjective(workflowId, { targets: workflowCandidates(catalog, runId, workflowId), values });
}

const matchingFiles = (allPaths: string[], patterns: string[]) => patterns.flatMap((pattern) => { const regex = new RegExp(`(?:^|/)${pattern}$`, "i"); return allPaths.filter((item) => regex.test(item)); });

export function workflowCatalog(catalog?: FilesystemRunCatalog, runId?: string) {
  const candidates = catalog && runId ? inspectCandidates(catalog, runId) : [];
  const paths = catalog && runId ? catalog.context(runId).map((item) => item.path) : [];
  return RESEARCH_WORKFLOWS.map((workflow) => {
    const targets = candidates.filter((item) => workflow.targetKinds.includes(item.kind)).slice(0, 6);
    const requiredPresent = matchingFiles(paths, workflow.requiredFilePatterns);
    const missingRequirements = paths.length ? workflow.requiredFilePatterns.filter((pattern) => !matchingFiles(paths, [pattern]).length) : [];
    const readiness = workflow.executionStatus === "preview" ? "preview" : missingRequirements.length ? "missing-context" : workflow.executionStatus;
    return { ...workflow, targetCandidates: targets, launcher: { fields: fillLauncherFields(workflow.id, targets) }, controls: workflow.controls.map((control) => control.id === "target" ? { ...control, options: targets.map((item) => item.id), default: targets[0]?.id || "" } : control),
      contextPolicy: { autoSlices: workflow.autoSlices, recommendedFullFiles: workflow.fullFileRules, missingRequirements, estimatedTokens: Math.ceil(requiredPresent.reduce((sum, rel) => sum + (catalog?.context(runId! ).find((item) => item.path === rel)?.bytes || 0), 0) / 4), estimatedRuntimeSeconds: workflow.estimatedSeconds },
      capabilities: { skills: workflow.skills.map((item) => item.id), computeTier: workflow.computeTier, externalSources: workflow.externalSources, readiness, executionStatus: workflow.executionStatus, note: workflow.executionNote },
    };
  });
}

export function previewWorkflow(catalog: FilesystemRunCatalog, runId: string, workflowId: string, input: { targetId?: string; lenses?: string[]; includeRecommendedFullFiles?: boolean; customQuestion?: string } = {}) {
  const workflow = workflowCatalog(catalog, runId).find((item) => item.id === workflowId);
  if (!workflow) throw new Error("Unknown research workflow");
  const target = workflow.targetCandidates.find((item) => item.id === input.targetId) || workflow.targetCandidates[0];
  const defaultLenses = (workflow.controls.find((item) => item.id === "lenses")?.default || []) as string[];
  const lenses = Array.isArray(input.lenses) && input.lenses.length ? input.lenses.filter((item) => (workflow.controls.find((control) => control.id === "lenses")?.options || []).includes(item)) : defaultLenses;
  const starter = input.customQuestion?.trim() || workflow.starterTemplates[0].replace("[target]", target?.label || "the selected result");
  const full = input.includeRecommendedFullFiles ? workflow.contextPolicy.recommendedFullFiles : [];
  const dependent = workflow.contextPolicy.recommendedFullFiles.flatMap((rule) => rule.requiredFor);
  const effectiveLenses = input.includeRecommendedFullFiles ? lenses : lenses.filter((lens) => !dependent.includes(lens));
  return { workflowId: workflow.id, version: workflow.version, targetCandidates: workflow.targetCandidates, selectedTarget: target || null, missingInputs: workflow.contextPolicy.missingRequirements,
    contextPolicy: { ...workflow.contextPolicy, includedFullFiles: full, declinedAnalyses: lenses.filter((lens) => !effectiveLenses.includes(lens)) },
    capabilities: workflow.capabilities,
    promptPreview: `${starter}\nTarget: ${target?.label || "run-level diagnosis"}.\nEvidence: ${(target?.evidenceRefs || []).join(", ") || "run summaries and controls"}.\nLenses: ${effectiveLenses.join(", ") || "focused evidence review"}.\nStop rule: ${workflow.stopRuleTemplate}`,
    outputPreview: workflow.outputContract,
    planPreview: { decision: workflow.decisionPrompt, targetId: target?.id || null, lenses: effectiveLenses, fullContextAccepted: Boolean(input.includeRecommendedFullFiles), stopRule: workflow.stopRuleTemplate, estimatedRuntimeSeconds: workflow.estimatedSeconds },
  };
}
