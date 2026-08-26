// Descriptive artifact catalog — the shared, science-grounded "what is this file
// and how was it derived" layer for BOTH Deep Research (free-form jail) and
// Standard chat. It turns a bare run file path into a role, a contents
// description, and a derivation note that RESPECTS the pipeline biologics:
//   • Stage 1 = differential expression by WELCH t-test on continuous (log2)
//     intensities (NOT limma / DESeq2 / negative-binomial) + WGCNA-equivalent
//     EIGENGENE co-expression modules.
//   • Stage 2 = GO OVER-REPRESENTATION (Fisher / ORA), NOT GSEA.
//   • Stage 3 = cell-type FISHER ENRICHMENT (FET) over marker sets, NOT
//     abundance / deconvolution.
//   • stage1/network_edges.csv is an EIGENGENE graph, NOT a protein PPI; kME is
//     module membership, NOT network centrality.
//
// This module is a PURE LEAF: it takes already-parsed (family, columns,
// rowCount, bytes) and returns text. It does no filesystem work and imports
// nothing from the grounding layer, so standard-grounding.ts can depend on it
// without an import cycle. The filesystem walk that builds a whole-run catalog
// lives in research-scope.ts (which has fs + the header/classify primitives).

export interface ArtifactDescription {
  /** Fine-grained slug (more specific than the 8 retrieval families), e.g.
   *  "differential-expression", "kme-matrix", "go-ora-long", "celltype-fet-matrix". */
  role: string;
  /** One or two sentences on what the file CONTAINS (rows, key columns, units). */
  description: string;
  /** How the file was PRODUCED — which stage and method, stated so the agent
   *  cannot relabel the statistics (Welch, ORA, FET, eigengene). */
  derivation: string;
}

export interface RunCatalogEntry extends ArtifactDescription {
  path: string;
  /** Coarse retrieval family (differential-expression, go-enrichment, …). */
  family: string;
  /** First path segment: "stage1", "stage2", "stage3", "input", a legacy
   *  deliverable folder, or "" for a run-root file. */
  stage: string;
  /** First handful of column headers (capped); empty for non-tabular files. */
  columns: string[];
  /** Total column count when tabular, else null. */
  columnCount: number | null;
  /** Best-effort row count (null when unknown / too large to count cheaply). */
  rowCount: number | null;
  bytes: number;
  /** A primary stageN/ or input/ output (or a run-root manifest/config). The
   *  agent should prefer these. */
  canonical: boolean;
  /** A copy in the legacy client-deliverable tree (01_input/, 03_analysis…/,
   *  "Proteomics Go/", …). Same science as a canonical file under a different
   *  name; kept reachable because run-cell citations sometimes point here. */
  legacy: boolean;
  /** Content hash, frozen at scope-approval time so fetch_input can prove the
   *  pulled file is byte-identical to what the plan was approved against. Empty
   *  in cheap previews that skip hashing. */
  sha256: string;
}

const CELL_TYPE_NAMES = ["astrocyte", "microglia", "neuron", "oligodendrocyte", "endothelia", "pericyte", "opc"];

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const has = (set: Set<string>, ...names: string[]) => names.some((name) => set.has(norm(name)));
const rowsNote = (rowCount: number | null) => (rowCount && rowCount > 0 ? ` (~${rowCount.toLocaleString("en-US")} rows)` : "");

export function stageOf(relPath: string): string {
  const clean = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  return clean.includes("/") ? clean.split("/", 1)[0] : "";
}

export function isCanonicalPath(relPath: string): boolean {
  const clean = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (/^(?:stage[123]|input)\//i.test(clean)) return true;
  // Run-root config / manifest / audit files are canonical orientation data.
  return !clean.includes("/") && /\.(?:json|txt)$/i.test(clean);
}

export function isLegacyPath(relPath: string): boolean {
  const clean = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  return /^(?:\d{2}_[a-z]|proteomics )/i.test(clean);
}

/**
 * Describe ONE artifact from its parsed schema. `family` is the coarse
 * retrieval family (used only as a last-resort fallback); the role is detected
 * here from the basename + columns so wide matrices that the coarse classifier
 * dumps into "other" (kME matrix, GO FDR matrix, eigengenes, network edges)
 * still get a precise, correct description.
 */
export function describeArtifact(
  relPath: string,
  family: string,
  columns: string[],
  rowCount: number | null,
  bytes: number,
): ArtifactDescription {
  const clean = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  const base = (clean.split("/").pop() || clean).toLowerCase();
  const cols = new Set(columns.map(norm));
  const wideModuleCols = columns.filter((c) => /^(?:me|kme)?(?:turquoise|blue|brown|yellow|green|red|black|pink|magenta|purple|greenyellow|tan|salmon|cyan|midnightblue|lightcyan|lightgreen|lightyellow|grey60|grey|darkred|darkgreen|royalblue)$/i.test(c)).length;
  const wideCellCols = columns.filter((c) => CELL_TYPE_NAMES.some((cell) => norm(c).startsWith(cell.slice(0, 6)))).length;

  // --- Non-analytical meta files FIRST --------------------------------------
  // Summary / config / viz / manifest files often carry an analytical keyword
  // in their name ("volcano_summary.txt", "celltype_viz_config.json"); classify
  // them by their meta nature before the keyword matchers can mislabel them.
  if (/^config_stage\d|params\.json$/.test(base)) {
    return {
      role: "stage-config",
      description: "Exact parameters a pipeline stage ran with (normalization method, soft-threshold power, significance thresholds, etc.) — the reproducibility record for that stage.",
      derivation: "Emitted by the pipeline alongside the stage it configures; the authoritative settings for interpreting that stage's outputs.",
    };
  }
  if (/run_manifest|pipeline_profile|dataset_manifest/.test(base)) {
    return {
      role: "run-metadata",
      description: "Run-level manifest: assay/format/level, sample and feature counts, pipeline profile, and provenance for the whole run.",
      derivation: "Emitted at pipeline start/finish to describe the run as a whole.",
    };
  }
  if (/stats_control_audit/.test(base)) {
    return {
      role: "stats-control-audit",
      description: "Audit of the statistical controls applied across the run (multiple-testing correction, filters, thresholds).",
      derivation: "Emitted by the pipeline to record which statistical safeguards were in force.",
    };
  }
  if (/artifact_index|artifact_manifest/.test(base)) {
    return {
      role: "artifact-index",
      description: "Machine index/manifest of every run artifact (UI/orientation metadata, not analytical results).",
      derivation: "Generated after the pipeline to catalog the run's files for the dashboard.",
    };
  }
  if (/viz_config|_config\.json$/.test(base)) {
    return {
      role: "viz-config",
      description: "Visualization configuration for the dashboard (color scales, layout). Not analytical data.",
      derivation: "Emitted for the interactive dashboard; safe to ignore for analysis.",
    };
  }
  if (/_summary\.(?:txt|json)$|analysis_summary|top_proteins/.test(base)) {
    return {
      role: "summary",
      description: "A short human/JSON digest of a stage's results — convenient orientation, but defer to the underlying tables for exact numbers.",
      derivation: "Emitted by the pipeline as a summary of the corresponding stage; not the primary data.",
    };
  }

  // --- Stage 1: differential expression (Welch) -----------------------------
  if (/volcano/.test(base) || (has(cols, "log2fc", "logfc") && has(cols, "pvalue", "adj_pvalue", "padj"))) {
    const direction = /down/.test(base) ? "down" : /up/.test(base) ? "up" : null;
    const scope = direction
      ? `The significant ${direction === "down" ? "DOWN" : "UP"}-regulated subset of the full volcano table`
      : "The COMPLETE differential-expression (volcano) table — every tested peptide/feature, significant or not";
    return {
      role: direction ? `differential-expression-${direction}` : "differential-expression",
      description: `${scope}${rowsNote(rowCount)}. One row per peptide/feature with \`log2fc\` (signed log2 fold-change, Disease vs Control), raw \`pvalue\`, Benjamini–Hochberg \`adj_pvalue\`, a \`significant\` flag, \`direction\`, and the WGCNA \`module\` the feature belongs to.`,
      derivation: "Stage 1 — Welch's two-sample t-test on CONTINUOUS log2-normalized intensities (Disease vs Control), p-values BH-adjusted. This is NOT limma, DESeq2, or a negative-binomial model.",
    };
  }

  // --- Stage 1: WGCNA module structure --------------------------------------
  if (/kme_matrix|kme\b|kme_/.test(base) && wideModuleCols >= 2) {
    return {
      role: "kme-matrix",
      description: `Wide module-membership (kME) matrix${rowsNote(rowCount)}: one row per feature, one \`kME<module>\` column per module holding the feature's signed correlation to that module's eigengene. High |kME| = strongly representative of the module.`,
      derivation: "Stage 1 — WGCNA-equivalent eigengene analysis. kME is correlation to the module eigengene (module membership), NOT a network-centrality / hub-degree score.",
    };
  }
  if (/module_eigengenes|module_eigengene|_eigengenes/.test(base) || (has(cols, "sample_name", "sample") && wideModuleCols >= 2)) {
    return {
      role: "module-eigengenes",
      description: `Module eigengenes${rowsNote(rowCount)}: one row per sample, one \`ME<module>\` column per module = that module's representative expression profile across samples.`,
      derivation: "Stage 1 — each eigengene is the 1st principal component of its module's standardized intensities; the per-sample summary signal correlated against traits.",
    };
  }
  if (/module_assignments|module_membership|hub_protein/.test(base) || (has(cols, "module_color", "modulecolor", "module") && has(cols, "kme"))) {
    const hub = /hub/.test(base);
    return {
      role: hub ? "module-hub-proteins" : "module-assignments",
      description: hub
        ? `Hub proteins per module${rowsNote(rowCount)}: the highest-kME (most representative) members of each WGCNA module, with \`module_color\` and \`kME\`.`
        : `WGCNA module assignments${rowsNote(rowCount)}: each peptide/feature mapped to a co-expression module (\`module_color\`) with its membership \`kME\` and \`alternative_module\`.`,
      derivation: "Stage 1 — WGCNA-equivalent eigengene module detection over the feature co-expression network. Module membership = kME; this is co-expression clustering, not a PPI graph.",
    };
  }
  if (/module_trait_cor|module.?trait|disease_associated_modules|trait.?association/.test(base) || (has(cols, "module", "module_color") && (has(cols, "cor_disease", "correlation") || columns.some((c) => /^cor[_a-z]/i.test(c))))) {
    return {
      role: "module-trait-correlation",
      description: `Module–trait associations${rowsNote(rowCount)}: per module, the correlation (\`cor_Disease\`/\`Correlation\`) and p-value (\`p_Disease\`/\`P_Value\`) between the module eigengene and the Disease trait, with \`Direction\`.`,
      derivation: "Stage 1 — Pearson correlation of each module eigengene with the binary Disease trait; the standard WGCNA module–trait relationship.",
    };
  }
  if (/network_edges|edge_list|edges\b/.test(base) || (has(cols, "source", "target") && has(cols, "weight"))) {
    return {
      role: "eigengene-network-edges",
      description: `Edge list of the module/eigengene relationship graph${rowsNote(rowCount)}: \`source\`, \`target\`, \`weight\`. An EIGENGENE / topological-overlap co-expression graph — NOT a protein–protein interaction (PPI) network and not a physical-binding graph.`,
      derivation: "Stage 1 — derived from the WGCNA adjacency / topological overlap; weights are co-expression strength, not interaction evidence.",
    };
  }
  if (/wgcna_power|power_diagnostic|sft/.test(base) || has(cols, "sftrsq", "sft_r_sq")) {
    return {
      role: "wgcna-power-diagnostics",
      description: `Soft-threshold power selection diagnostics${rowsNote(rowCount)}: per candidate power, scale-free-topology fit (\`SFT.R.sq\`), \`slope\`, and mean/median connectivity.`,
      derivation: "Stage 1 — WGCNA soft-thresholding sweep used to pick the adjacency power before module detection.",
    };
  }

  // --- Stage 1 inputs: intensity matrices -----------------------------------
  if (/normalized_log2|normalized_matrix\b/.test(base) || (/normalized/.test(base) && /log2/.test(base))) {
    return {
      role: "normalized-log2-intensities",
      description: `Normalized log2 intensity matrix${rowsNote(rowCount)}: rows = features (\`feature_id\`,\`gene\`), columns = samples. These are the continuous values the Welch t-test and WGCNA actually operate on.`,
      derivation: "Stage 1 input — CBN/median-normalized abundances, log2-transformed.",
    };
  }
  if (/normalized_linear|normalized_abundance/.test(base)) {
    return {
      role: "normalized-linear-intensities",
      description: `Normalized intensity matrix on the LINEAR (un-logged) scale${rowsNote(rowCount)}: rows = features, columns = samples.`,
      derivation: "Stage 1 — normalized abundances before the log2 transform; provided for reference.",
    };
  }
  if (/abundance_matrix|cleaned_matrix|abundance_data/.test(base)) {
    return {
      role: "raw-abundance",
      description: `Raw (pre-normalization) abundance matrix${rowsNote(rowCount)}: rows = features (\`feature_id\`,\`gene\`), columns = samples — the intensities before normalization.`,
      derivation: "Pipeline input — cleaned raw intensities prior to normalization.",
    };
  }

  // --- Stage 2: GO over-representation (ORA / Fisher) ------------------------
  const goLong = has(cols, "term") && has(cols, "pvalue", "zscore") && (has(cols, "module") || has(cols, "hits", "hit_genes", "term_size"));
  if (/go_enrichment|go-enr|go_enr|_module\.txt$|gsa-go-fet/.test(base) || goLong) {
    const pruned = /redundancy_removed|redundancy/.test(base);
    const perModule = /^[a-z]+_module\.txt$/.test(base);
    return {
      role: "go-ora-long",
      description: `GO over-representation results, long form${rowsNote(rowCount)}: one row per (module × GO term) with \`pvalue\`, \`zscore\`, \`hits\`, \`term_size\`, \`hit_genes\`, and \`category\` (BP/MF/CC).${pruned ? " Redundancy-pruned to representative, non-overlapping terms." : ""}${perModule ? " Restricted to a single module's terms." : ""}`,
      derivation: "Stage 2 — Fisher / over-representation analysis (ORA) of each WGCNA module's member genes against GO term gene sets. This is OVER-REPRESENTATION, NOT GSEA (no ranked-list enrichment).",
    };
  }
  if (/go_(?:fdr|pvalues|zscore)_matrix/.test(base) || (has(cols, "term") && wideModuleCols >= 3)) {
    const metric = /fdr/.test(base) ? "BH-FDR" : /pvalue/.test(base) ? "raw p-value" : /zscore/.test(base) ? "enrichment z-score" : "enrichment statistic";
    return {
      role: "go-ora-matrix",
      description: `GO over-representation results as a wide term × module matrix${rowsNote(rowCount)}: one row per GO \`term\`, one column per module, cells = ${metric}.`,
      derivation: "Stage 2 — Fisher/ORA per module reshaped to a term × module grid for heatmaps. Over-representation, NOT GSEA.",
    };
  }

  // --- Stage 3: cell-type Fisher enrichment (FET) ---------------------------
  if (/celltype.*fdr_matrix|celltype_fdr/.test(base) || (has(cols, "module") && wideCellCols >= 2)) {
    return {
      role: "celltype-fet-matrix",
      description: `Cell-type enrichment as a wide module × cell-type matrix${rowsNote(rowCount)}: one row per module, one column per brain cell type (Astrocytes, Microglia, Neuron, Oligodendrocytes, Endothelia), cells = FDR.`,
      derivation: "Stage 3 — Fisher exact test (FET) of each module's members against curated brain cell-type marker sets. ENRICHMENT over markers, NOT abundance estimation or deconvolution.",
    };
  }
  if (/celltype|hitliststats|cell_type/.test(base) || (has(cols, "module", "cell_type", "celltype") && has(cols, "fdr", "pvalue"))) {
    const oneCell = CELL_TYPE_NAMES.find((cell) => base.includes(cell.slice(0, 6)));
    return {
      role: "celltype-fet-long",
      description: `Cell-type FET results, long form${rowsNote(rowCount)}: one row per (module × cell type) with \`pvalue\`, \`fdr\`, \`minus_log10_fdr\`.${oneCell ? ` Restricted to one cell type.` : ""}`,
      derivation: "Stage 3 — Fisher exact test of module membership against cell-type marker sets. Marker over-representation, NOT cell abundance / deconvolution.",
    };
  }

  // --- Design inputs (real tabular data) ------------------------------------
  if (/sample_metadata|sample.?meta/.test(base) || (has(cols, "sample_name", "sample") && has(cols, "group"))) {
    return {
      role: "sample-metadata",
      description: `Sample design table${rowsNote(rowCount)}: one row per sample with its \`group\`/condition assignment and sample key — the grouping behind every Disease-vs-Control comparison.`,
      derivation: "Pipeline input — experimental design / sample-to-group mapping.",
    };
  }
  if (/traits|sample_traits/.test(base) || (has(cols, "sampleid", "sample_id") && has(cols, "group"))) {
    return {
      role: "sample-traits",
      description: `Sample → trait table${rowsNote(rowCount)} (\`SAMPLE_ID\`, \`GROUP\`) — the phenotype vector used for differential expression and module–trait correlation.`,
      derivation: "Pipeline input — sample trait/phenotype assignments.",
    };
  }

  // --- Fallback by coarse family --------------------------------------------
  const familyFallback: Record<string, ArtifactDescription> = {
    "differential-expression": { role: "differential-expression", description: `Differential-expression table${rowsNote(rowCount)} with fold-change and significance columns.`, derivation: "Stage 1 — Welch t-test on continuous log2 intensities." },
    "module-assignments": { role: "module-assignments", description: `WGCNA module-membership table${rowsNote(rowCount)}.`, derivation: "Stage 1 — eigengene co-expression modules (kME membership)." },
    "module-traits": { role: "module-trait-correlation", description: `Module–trait correlation table${rowsNote(rowCount)}.`, derivation: "Stage 1 — eigengene vs trait correlation." },
    "go-enrichment": { role: "go-ora", description: `GO over-representation results${rowsNote(rowCount)}.`, derivation: "Stage 2 — Fisher/ORA per module (NOT GSEA)." },
    "cell-type": { role: "celltype-fet", description: `Cell-type enrichment results${rowsNote(rowCount)}.`, derivation: "Stage 3 — Fisher exact test over marker sets (NOT deconvolution)." },
    "sample-metadata": { role: "sample-metadata", description: `Sample design / metadata table${rowsNote(rowCount)}.`, derivation: "Pipeline input — experimental design." },
    "run-metadata": { role: "run-metadata", description: "Run-level metadata.", derivation: "Pipeline manifest/profile." },
  };
  if (familyFallback[family]) return familyFallback[family];
  const kind = /\.json$/i.test(base) ? "JSON file" : /\.(?:csv|tsv|txt)$/i.test(base) ? `tabular file${rowsNote(rowCount)}` : "file";
  return {
    role: "other",
    description: `Run ${kind}${columns.length ? ` with columns: ${columns.slice(0, 8).join(", ")}` : ""}. Inspect it directly to confirm its contents before relying on it.`,
    derivation: "A pipeline output not in the primary analytical families; inspect to determine provenance.",
  };
}

const STAGE_LABELS: Record<string, string> = {
  input: "Inputs (design + raw/normalized matrices)",
  stage1: "Stage 1 — differential expression (Welch) + WGCNA eigengene modules",
  stage2: "Stage 2 — GO over-representation (Fisher/ORA)",
  stage3: "Stage 3 — cell-type Fisher enrichment (FET)",
  "": "Run-level (manifests, configs, audits)",
};

/**
 * Render the catalog for the free-form agent's context. Canonical files are
 * shown in full (grouped by stage, marked staged vs fetchable); the legacy
 * deliverable tree is collapsed to one navigable line so the prompt stays
 * bounded while every path remains reachable via fetch_input.
 */
export function renderCatalogForAgent(entries: RunCatalogEntry[], stagedPaths: Set<string>): string {
  const canonical = entries.filter((entry) => entry.canonical);
  const legacy = entries.filter((entry) => entry.legacy);
  const other = entries.filter((entry) => !entry.canonical && !entry.legacy);
  const order = ["input", "stage1", "stage2", "stage3", ""];
  const byStage = new Map<string, RunCatalogEntry[]>();
  for (const entry of [...canonical, ...other]) {
    const key = order.includes(entry.stage) ? entry.stage : "";
    byStage.set(key, [...(byStage.get(key) || []), entry]);
  }
  const lines: string[] = [];
  for (const stage of order) {
    const group = byStage.get(stage);
    if (!group || !group.length) continue;
    lines.push(`\n## ${STAGE_LABELS[stage] || stage}`);
    for (const entry of group.sort((a, b) => a.path.localeCompare(b.path))) {
      const mark = stagedPaths.has(entry.path) ? "[staged]" : "[fetch] ";
      lines.push(`- ${mark} ${entry.path} — ${entry.description} Derivation: ${entry.derivation}`);
    }
  }
  if (legacy.length) {
    const folders = [...new Set(legacy.map((entry) => entry.stage))].sort();
    lines.push(`\n## Legacy client-deliverable tree (${legacy.length} files under ${folders.map((f) => `\`${f}/\``).join(", ")})`);
    lines.push(`- Duplicate copies of the canonical stageN data under alternate names/layouts. Same science. Citations sometimes point here (e.g. \`03_analysis_CBN_median/PROTEOMICS_Volcano_Downregulated_Disease.csv\`); fetch_input the exact cited path when so.`);
  }
  return lines.join("\n").trim();
}

// --- Per-file usage join ----------------------------------------------------
// The catalog says what the agent COULD see; usage says what it ACTUALLY did
// with each file in a given run. Computed entirely from data already on disk /
// in the job record — no new jail instrumentation. Signals, weakest→strongest:
//   • staged  — bytes pre-copied into the sandbox at job start (scope.artifacts).
//   • read    — the run-relative path appears as `inputs/<path>` in a saved
//               Python cell (workspace/code/cell_*.py). How the agent opens a
//               file, so a literal substring match is exact and proven reliable.
//   • cited   — the path backs a final claim (answer-model.json metrics[].cite
//               or findings.json claims[].evidence[].path).
//   • fetched — the agent pulled it on demand via fetch_input (agent_fetch_input
//               event). Always also one of the above when truly used, but kept
//               as its own chip because it is the strongest intent signal.
// USED = read | cited | fetched.  staged-but-unused (staged & !used) is the
// waste signal the user asked to surface. This module stays a pure leaf: it does
// the JOIN over already-extracted signals; service.ts does the filesystem IO.

export interface CatalogUsage {
  /** Bytes pre-staged into the sandbox at job start. */
  staged: boolean;
  /** Agent pulled it on demand via fetch_input. */
  fetched: boolean;
  /** Path read by a saved Python cell (`inputs/<path>` in the code). */
  read: boolean;
  /** Path cites a final claim (answer metrics or findings evidence). */
  cited: boolean;
  /** read || cited || fetched — the agent actually used the file. */
  used: boolean;
  /** staged && !used — pre-staged but never touched. */
  stagedUnused: boolean;
  /** Primary bucket for sort + color: used > staged (staged-unused) > available. */
  tier: "used" | "staged" | "available";
}

/** Normalize a signal path (citation, code reference, fetch payload) to the
 *  run-relative form catalog entries use: drop a leading `./` and ONE leading
 *  `inputs/` or `outputs/` jail prefix. Catalog paths themselves (e.g. the
 *  `input/` singular stage, or a legacy `03_analysis…/` folder) are left intact. */
export function normalizeCatalogPath(value: string): string {
  return String(value || "").replaceAll("\\", "/").replace(/^\.?\//, "").replace(/^(?:inputs|outputs)\//, "");
}

/**
 * Annotate each catalog entry with how it was used in one run. `read` is matched
 * against the concatenated code-cell text by the exact `inputs/<path>` reference
 * the agent writes; `fetched`/`cited`/`staged` come from already-extracted path
 * lists (normalized here, so callers can pass raw event/citation paths).
 */
export function annotateCatalogUsage<T extends { path: string }>(
  entries: T[],
  signals: { staged?: Iterable<string>; fetched?: Iterable<string>; cited?: Iterable<string>; codeText?: string },
): Array<T & { usage: CatalogUsage }> {
  const stagedSet = new Set([...(signals.staged || [])].map(normalizeCatalogPath));
  const fetchedSet = new Set([...(signals.fetched || [])].map(normalizeCatalogPath));
  const citedSet = new Set([...(signals.cited || [])].map(normalizeCatalogPath));
  const code = signals.codeText || "";
  return entries.map((entry) => {
    const staged = stagedSet.has(entry.path);
    const fetched = fetchedSet.has(entry.path);
    const cited = citedSet.has(entry.path);
    const read = entry.path ? code.includes(`inputs/${entry.path}`) : false;
    const used = read || cited || fetched;
    return { ...entry, usage: { staged, fetched, read, cited, used, stagedUnused: staged && !used, tier: used ? "used" : staged ? "staged" : "available" } as CatalogUsage };
  });
}

/** Minimal shape renderCatalogForRunCard needs — so callers that only have
 *  (path, role, stage, canonical, description, derivation) can pass through
 *  without constructing a full RunCatalogEntry. */
export type RunCardCatalogInput = Pick<RunCatalogEntry, "path" | "role" | "stage" | "canonical" | "description" | "derivation">;

/**
 * Compact, bounded catalog block for the Standard run card: canonical analytical
 * files only, one tight line each. Standard cannot run code, so this is an
 * orientation aid ("here is what exists, what's in it, and how it was derived"),
 * not a fetch list. Returns one string per file to keep the always-on run card
 * lean. Ranked so the headline analytical tables come first under a token cap.
 */
export function renderCatalogForRunCard(entries: RunCardCatalogInput[], maxFiles = 24): string[] {
  const rank = (entry: RunCardCatalogInput) => {
    if (entry.stage === "stage1") return /differential-expression|module-assignments|module-trait/.test(entry.role) ? 0 : 1;
    if (entry.stage === "stage2") return 2;
    if (entry.stage === "stage3") return 3;
    if (entry.stage === "input") return 4;
    return 6;
  };
  return entries
    .filter((entry) => entry.canonical && entry.role !== "viz-config" && entry.role !== "artifact-index")
    .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))
    .slice(0, maxFiles)
    .map((entry) => `${entry.path} — ${entry.description} Derivation: ${entry.derivation}`);
}
