import fs from "node:fs";
import path from "node:path";
import type { FilesystemRunCatalog } from "./run-catalog.js";
import { describeArtifact, isCanonicalPath, renderCatalogForRunCard } from "./grounding/artifact-catalog.js";

const CHARS_PER_TOKEN = 4;
const MAX_ROWS_PER_ARTIFACT = 60;
const MAX_CELL_BYTES = 2_000;
const MAX_CANDIDATE_CHARACTERS = 16_000;
const indexCache = new Map<string, { signature: string; artifacts: IndexedArtifact[] }>();

export type StandardRoute = "general" | "lexical" | "lookup" | "analytical" | "explicit";
export type ArtifactFamily =
  | "differential-expression"
  | "module-assignments"
  | "module-traits"
  | "go-enrichment"
  | "cell-type"
  | "sample-metadata"
  | "run-metadata"
  | "other";

export interface StandardIntent {
  route: StandardRoute;
  kind: "general" | "lexical" | "protein" | "module" | "go" | "cell-type" | "cross-modal" | "metadata" | "summary";
  proteins: string[];
  modules: string[];
  cellTypes: string[];
  targetFamilies: ArtifactFamily[];
  // When route === "general", why: a genuine definitional/product question
  // (no run rows wanted) vs. one that simply matched no keyword and may still be
  // a data question worth a relevance-retrieval fallback. Unset otherwise.
  generalReason?: "definitional" | "product-help" | "unmatched";
}

interface IndexedArtifact {
  path: string;
  family: ArtifactFamily;
  kind: string;
  columns: string[];
  normalizedColumns: string[];
  rowCount: number | null;
  bytes: number;
  stage: string;
}

interface EvidenceCandidate {
  artifact: IndexedArtifact;
  body: string;
  rowIds: Array<number | string>;
  rowsReturned: number;
  score: number;
  reason: string;
}

export interface GroundingCitation {
  filePath: string;
  rowIds: Array<number | string>;
  artifactFamily: ArtifactFamily;
}

export interface SelectedStandardArtifact {
  path: string;
  family: ArtifactFamily;
  score: number;
  rowsReturned: number;
  includedCharacters: number;
  truncated: boolean;
  reason: string;
}

export interface StandardGrounding {
  route: StandardRoute;
  intent: StandardIntent["kind"];
  runCard: string;
  evidence: string;
  text: string;
  runCardTokens: number;
  evidenceTokens: number;
  budgetTokens: number;
  candidateArtifacts: number;
  selectedArtifacts: SelectedStandardArtifact[];
  citations: GroundingCitation[];
  truncated: boolean;
}

const CELL_TYPES = ["microglia", "microglial", "astrocyte", "astrocytes", "neuron", "neurons", "oligodendrocyte", "oligodendrocytes", "endothelial", "endothelia", "pericyte", "pericytes", "opc"];
const MODULE_NAMES = ["turquoise", "blue", "brown", "yellow", "green", "red", "black", "pink", "magenta", "purple", "greenyellow", "tan", "salmon", "cyan", "midnightblue", "lightcyan", "lightgreen", "lightyellow", "grey60", "grey"];
const SYMBOL_BLOCKLIST = new Set(["FDR", "GO", "WGCNA", "QC", "AI", "API", "CSV", "TSV", "PDF", "DE", "FC", "RNA", "DNA", "BH", "RUN"]);

// --- Lexical relevance fallback (deferred layer #3) -------------------------
// When deterministic keyword routing finds no entity or intent, the question is
// scored against every indexed artifact with BM25 over the artifact's path,
// columns, a per-family scientific concept profile, and a bounded cell sample.
// This is fully deterministic, adds no model call, no embeddings, and no
// persistent index — corpus statistics are computed per run and cached by the
// same signature the artifact index uses. The keyword fast-path is unchanged;
// this only runs when it would otherwise ground zero files on a data question.
const LEX_K1 = 1.5;
const LEX_B = 0.75;
const LEX_IDF_FLOOR = 0.7;        // an anchor term must appear in < ~half the run's artifacts to be discriminative
const LEX_MAX_FAMILIES = 3;       // promote at most three evidence families from a single lexical fallback
const LEX_SAMPLE_BYTES = 32_768;  // bounded per-artifact body sample fed to the lexical index
const LEX_MAX_DOC_TOKENS = 4_000; // bound the token multiset stored per artifact document
const lexicalCorpusCache = new Map<string, { signature: string; corpus: LexicalCorpus }>();

// Function words and bare instruction verbs that should never anchor a match.
// Scientific directionals ("up", "down") are deliberately kept.
const LEX_STOPWORDS = new Set(
  ("a an the is are was were be been being do does did of in on for to from with without by at as into onto over under between within across this that these those it its their there here what which who whom whose how why when where whether and or not any all some each per out so such we you they i me my our your show find tell give list display present provide get got want need please explain describe define compare summarize summarise about both have has had will would can could should may might").split(/\s+/),
);

// Per-family concept vocabulary (document expansion). Written in natural base
// form; both these terms and the query pass through the same tokenizer/stemmer,
// so plurals align automatically. Verb conjugations are listed explicitly. This
// turns the brittle, all-or-nothing keyword GATE into a graded ranking signal:
// a missing synonym degrades a score instead of dropping a turn to zero files.
const FAMILY_PROFILE: Record<ArtifactFamily, string> = {
  "differential-expression":
    "differential expression expressed abundance level fold change changed log2fc logfc magnitude up down upregulated downregulated regulated higher lower elevated reduced increase decrease shift significant volcano effect protein gene feature comparison contrast condition group treatment versus difference",
  "module-assignments":
    "module coexpression coexpressed correlate correlated correlation together lockstep tandem covary covariation cocluster cluster clustered network membership kme hub eigengene wgcna assignment gene protein feature group joint jointly parallel sync unison move rise fall track trend coregulated programme program",
  "module-traits":
    "module trait correlation correlated association associated relationship link drive driver clinical phenotype covariate eigengene significant condition group outcome",
  "go-enrichment":
    "go gene ontology pathway enrichment enriched overrepresented overrepresentation represented biological process molecular function cellular component term functional annotation route signalling signaling",
  "cell-type":
    "cell type celltype enrichment enriched marker signature deconvolution composition proportion population microglia astrocyte neuron oligodendrocyte endothelial pericyte opc",
  "sample-metadata":
    "sample metadata design group condition replicate batch covariate phenotype clinical experiment experimental cohort",
  "run-metadata":
    "run manifest pipeline profile parameter configuration setting assay format level stage status provenance",
  other: "",
};

export function estimateTokens(text: string) {
  return text ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0;
}

export function classifyStandardQuery(question: string): StandardIntent {
  const low = question.toLowerCase();
  const explicit = /<untrusted_attachment\b|\b(?:attached|attachment|pinned|pin)\b|@(?:run|artifact)\b/i.test(question);
  const proteins = [...question.matchAll(/\b([A-Z][A-Z0-9-]{1,15})\b/g)]
    .map((match) => match[1]).filter((symbol, index, all) => !SYMBOL_BLOCKLIST.has(symbol) && all.indexOf(symbol) === index);
  const modules = MODULE_NAMES.filter((name) => new RegExp(`\\b${name}\\b`, "i").test(question));
  for (const match of question.matchAll(/\b(?:module\s+)?(M\d+)\b/gi)) {
    const module = match[1].toLowerCase();
    if (!modules.includes(module)) modules.push(module);
  }
  const cellTypes = CELL_TYPES.filter((name) => new RegExp(`\\b${name}\\b`, "i").test(question));
  const wantsGo = /\b(go|pathway|pathways|enrich|enrichment|biological process|molecular function)\b/i.test(question);
  const definition = /\bwhat (?:does|is|are)\b.*\b(?:mean|definition|defined)|\bexplain\b.*\b(?:generally|concept|term)\b/i.test(question);
  // Co-expression / co-movement language: proteins that vary together across
  // samples are a module question even when "module"/"WGCNA"/"co-expression"
  // never appear literally ("rise and fall in lockstep", "co-vary", "correlated").
  // Gated on !definition so "what does co-expression mean?" stays a general answer.
  const coexpressionLanguage =
    /\b(?:co[- ]?express|co[- ]?regulat|co[- ]?vary|co[- ]?var(?:ies|ying)|covariation|co[- ]?cluster|correlat|anti[- ]?correlat|lockstep|in (?:sync|tandem|unison))/i.test(question)
    || /\b(?:rise|rises|fall|falls|move|moves|moving|track|tracks|vary|varies|varying|trend|trends|fluctuate|fluctuates|change|changes)\b[^.?!]*\b(?:together|in lockstep|in tandem|in sync|in unison|in parallel)\b/i.test(question);
  const wantsModule = /\b(module|modules|wgcna|hub|kme)\b/i.test(question) || (coexpressionLanguage && !definition) || modules.length > 0;
  const wantsCell = /\b(cell[ -]?type|celltype|microgl|astrocy|neuron|oligodendro|endothel|pericyte|opc)\b/i.test(question) || cellTypes.length > 0;
  const wantsMetadata = /\b(sample count|how many samples|feature count|how many proteins|assay|profile|study design|run status|stage status)\b/i.test(question);
  const wantsSummary = /\b(summarize|summary|overview|synthesis|interpret|biological story|what happened)\b/i.test(question);
  const productHelp = /\b(how (?:do|can) i|export|upload|download|settings|what can you do|help)\b/i.test(question);

  let kind: StandardIntent["kind"] = "general";
  let route: StandardRoute = "general";
  let targets: ArtifactFamily[] = [];
  if (wantsGo && wantsCell) {
    kind = "cross-modal"; route = "analytical"; targets = ["cell-type", "go-enrichment"];
  } else if (wantsGo) {
    kind = "go"; route = modules.length ? "lookup" : "analytical"; targets = ["go-enrichment", "module-assignments"];
  } else if (wantsCell) {
    kind = "cell-type"; route = "lookup"; targets = ["cell-type", "module-assignments"];
  } else if (proteins.length) {
    kind = "protein"; route = "lookup"; targets = ["differential-expression", "module-assignments"];
  } else if (wantsModule) {
    kind = "module"; route = modules.length || proteins.length ? "lookup" : "analytical"; targets = ["module-assignments", "module-traits"];
  } else if (wantsMetadata) {
    kind = "metadata"; route = "lookup"; targets = ["sample-metadata", "run-metadata"];
  } else if (wantsSummary) {
    kind = "summary"; route = "analytical"; targets = ["differential-expression", "module-assignments", "module-traits", "go-enrichment", "cell-type"];
  } else if (!productHelp && !definition && /\b(this|the) run\b|\bresults?\b|\bdata\b/i.test(question)) {
    kind = "summary"; route = "analytical"; targets = ["differential-expression", "module-assignments", "go-enrichment", "cell-type"];
  }
  if (explicit) route = "explicit";
  const generalReason: StandardIntent["generalReason"] = route === "general"
    ? (definition ? "definitional" : productHelp ? "product-help" : "unmatched")
    : undefined;
  return { route, kind, proteins, modules, cellTypes, targetFamilies: targets, generalReason };
}

export function buildStandardGrounding(
  catalog: FilesystemRunCatalog,
  runId: string,
  question: string,
  options: { evidenceTokenBudget?: number } = {},
): StandardGrounding {
  const run = catalog.get(runId);
  if (!run) throw new Error("Selected run is unavailable or not complete");
  const artifacts = indexArtifacts(catalog, runId, run.path);
  const runCard = buildRunCard(runId, run.path, artifacts);
  const classified = classifyStandardQuery(question);
  const clampBudget = (base: number) => Math.max(1, Math.min(options.evidenceTokenBudget ?? base, 24_000));
  // Keyword routing found nothing. Either the question is genuinely general
  // (definitional / product-help → keep zero run rows) or it is a data question
  // phrased outside the keyword lists, in which case the deterministic BM25
  // relevance fallback selects the artifacts/rows it should have grounded.
  let intent = classified;
  let lexicalMatches: Map<string, { score: number; terms: string[] }> | null = null;
  if (classified.route === "general") {
    const fallback = classified.generalReason === "unmatched"
      ? lexicalRelevanceFallback(run.path, artifacts, question)
      : null;
    if (!fallback) {
      return {
        route: "general", intent: classified.kind, runCard, evidence: "", text: runCard,
        runCardTokens: estimateTokens(runCard), evidenceTokens: 0, budgetTokens: clampBudget(16_000),
        candidateArtifacts: 0, selectedArtifacts: [], citations: [], truncated: false,
      };
    }
    intent = { ...classified, route: "lexical", kind: "lexical", targetFamilies: fallback.families };
    lexicalMatches = fallback.artifacts;
  }
  const routeBudget = intent.route === "lookup" ? 8_000
    : intent.route === "explicit" ? 12_000
    : intent.route === "lexical" ? 12_000
    : 16_000;
  const budgetTokens = clampBudget(routeBudget);

  const candidates = retrieveCandidates(run.path, artifacts, intent);
  if (lexicalMatches) {
    // Make ranking faithful to BM25: a lexically matched artifact must outrank
    // any incidental same-family candidate, and the "why selected" reason
    // records the matched terms for explainability/citations.
    for (const candidate of candidates) {
      const match = lexicalMatches.get(candidate.artifact.path);
      if (!match) continue;
      candidate.score += 10 + Math.min(10, match.score);
      candidate.reason = `lexical relevance (BM25 ${match.score.toFixed(2)}; matched ${match.terms.join(", ")}); ${candidate.reason}`;
    }
  }
    candidates.sort((a, b) => b.score - a.score || a.artifact.path.localeCompare(b.artifact.path));
  const maxCharacters = budgetTokens * CHARS_PER_TOKEN;
  const evidenceParts: string[] = [];
  const selectedArtifacts: SelectedStandardArtifact[] = [];
  const citations: GroundingCitation[] = [];
  let used = 0;
  let truncated = false;
  const selectedPerFamily = new Map<ArtifactFamily, number>();
  const perFamilyLimit = intent.route === "lookup" || intent.kind === "cross-modal" ? 2 : 3;
  for (const candidate of candidates) {
    if ((selectedPerFamily.get(candidate.artifact.family) || 0) >= perFamilyLimit) { truncated = true; continue; }
    const prefix = `\n### Evidence: ${candidate.artifact.path}\nFamily: ${candidate.artifact.family}; relevance: ${candidate.score.toFixed(2)}; ${candidate.reason}\n`;
    const separatorCharacters = evidenceParts.length ? 1 : 0;
    const available = maxCharacters - used - separatorCharacters - prefix.length;
    if (available <= 0) { truncated = true; break; }
    let body = candidate.body;
    let itemTruncated = false;
    if (body.length > available) {
      const marker = "\n…(budget truncated)";
      if (available <= marker.length) { truncated = true; break; }
      body = body.slice(0, available - marker.length).replace(/\n[^\n]*$/, "") + marker;
      itemTruncated = true; truncated = true;
    }
    const rendered = prefix + body;
    evidenceParts.push(rendered);
    used += separatorCharacters + rendered.length;
    selectedArtifacts.push({
      path: candidate.artifact.path, family: candidate.artifact.family, score: candidate.score,
      rowsReturned: candidate.rowsReturned, includedCharacters: rendered.length,
      truncated: itemTruncated, reason: candidate.reason,
    });
    citations.push({ filePath: candidate.artifact.path, rowIds: candidate.rowIds, artifactFamily: candidate.artifact.family });
    selectedPerFamily.set(candidate.artifact.family, (selectedPerFamily.get(candidate.artifact.family) || 0) + 1);
    if (itemTruncated) break;
  }
  if (selectedArtifacts.length < candidates.length) truncated = true;
  const evidence = evidenceParts.join("\n").trim();
  return {
    route: intent.route, intent: intent.kind, runCard, evidence,
    text: evidence ? `${runCard}\n\n# Question-specific run evidence\n${evidence}` : runCard,
    runCardTokens: estimateTokens(runCard), evidenceTokens: estimateTokens(evidence), budgetTokens,
    candidateArtifacts: candidates.length, selectedArtifacts, citations, truncated,
  };
}

export function compactConversationHistory(
  history: Array<{ role: string; content: string; pinned?: boolean }>,
  options: { maxTokens?: number; recentTurns?: number } = {},
) {
  const maxTokens = Math.max(100, options.maxTokens ?? 6_000);
  const recentMessages = Math.max(2, (options.recentTurns ?? 4) * 2);
  const render = (items: typeof history) => items.map((item) => `${item.role.toUpperCase()}: ${item.content}`).join("\n\n");
  const full = render(history);
  if (estimateTokens(full) <= maxTokens || history.length <= recentMessages) return { text: full, tokens: estimateTokens(full), compacted: false, recentMessages: history.length };

  const recent = history.slice(-recentMessages);
  const older = history.slice(0, -recentMessages);
  const pinned = older.filter((item) => item.pinned);
  const important = older.filter((item) => !item.pinned && /\b(decision|focus|hypothesis|unresolved|follow[- ]?up|cite|\[[^\]]+\.(?:csv|tsv|json|txt)\])\b/i.test(item.content));
  const summaryItems = [...pinned, ...important].filter((item, index, all) => all.indexOf(item) === index);
  const lines = summaryItems.map((item) => `- ${item.pinned ? "PINNED " : ""}${item.role.toUpperCase()}: ${snippet(item.content, 480)}`);
  if (!lines.length) {
    for (const item of older.slice(-6)) lines.push(`- ${item.role.toUpperCase()}: ${snippet(item.content, 220)}`);
  }
  const header = `COMPACTED EARLIER HISTORY (${older.length} messages; preserve these decisions, citations, pins, and open questions):\n`;
  let text = `${header}${lines.join("\n")}\n\nRECENT HISTORY (verbatim):\n${render(recent)}`;
  if (estimateTokens(text) > maxTokens) text = text.slice(0, maxTokens * CHARS_PER_TOKEN);
  return { text, tokens: estimateTokens(text), compacted: true, recentMessages: recent.length };
}

function indexArtifacts(catalog: FilesystemRunCatalog, runId: string, runPath: string): IndexedArtifact[] {
  const signature = runSignature(runPath);
  const cached = indexCache.get(runPath);
  if (cached?.signature === signature) return cached.artifacts;
  const metadata = readArtifactMetadata(runPath);
  const results: IndexedArtifact[] = [];
  for (const item of catalog.context(runId)) {
    if (!/\.(?:csv|tsv|txt|json|md)$/i.test(item.path)) continue;
    const absolute = safeRunPath(runPath, item.path);
    if (!absolute) continue;
    const tabular = /\.(?:csv|tsv|txt)$/i.test(item.path);
    const header = tabular ? readHeader(absolute) : [];
    const normalizedColumns = header.map(normalizeColumn);
    const meta = metadata.get(item.path);
    const family = classifyArtifact(item.path, normalizedColumns, String(meta?.artifact_family || ""));
    results.push({
      path: item.path, family, kind: item.kind, columns: header, normalizedColumns,
      rowCount: tabular ? countRowsBounded(absolute, item.bytes) : null, bytes: item.bytes,
      stage: String(meta?.stage || item.path.split("/", 1)[0] || ""),
    });
  }
  const artifacts = dedupeArtifacts(results);
  indexCache.set(runPath, { signature, artifacts });
  return artifacts;
}

function buildRunCard(runId: string, runPath: string, artifacts: IndexedArtifact[]) {
  const manifest = readJson(path.join(runPath, "run_manifest.json"));
  const profile = readJson(path.join(runPath, "pipeline_profile.json"));
  const configFiles = fs.readdirSync(runPath).filter((name) => /^config_stage\d+\.json$/i.test(name));
  const stages = [...new Set(artifacts.map((artifact) => artifact.stage).filter(Boolean))].sort();
  const families = new Map<ArtifactFamily, IndexedArtifact[]>();
  for (const artifact of artifacts) families.set(artifact.family, [...(families.get(artifact.family) || []), artifact]);
  const familyLines = [...families.entries()]
    .filter(([family]) => family !== "other")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, items]) => {
      const examples = items.slice(0, 3).map((item) => ({
        path: item.path, rows: item.rowCount, available: item.bytes > 0,
        columns: item.columns.slice(0, 12),
      }));
      return { family, artifacts: items.length, examples };
    });
  // Descriptive data inventory: what each canonical file CONTAINS and HOW it was
  // derived (Welch DE, ORA, FET, eigengene modules). Standard cannot run code,
  // so this is orientation — it lets the model name and reach for the right file
  // and never relabel the statistics. Shares the Deep Research catalog logic.
  const dataInventory = renderCatalogForRunCard(
    artifacts.map((artifact) => {
      const described = describeArtifact(artifact.path, artifact.family, artifact.columns, artifact.rowCount, artifact.bytes);
      return { path: artifact.path, role: described.role, stage: artifact.stage, canonical: isCanonicalPath(artifact.path), description: described.description, derivation: described.derivation };
    }),
  );
  const card = {
    run: {
      id: runId, status: "COMPLETE",
      formatFamily: manifest.format_family ?? profile.format_family ?? null,
      assayLevel: manifest.assay_level ?? profile.assay_level ?? null,
      inputLevel: manifest.input_level ?? profile.input_level ?? null,
      sampleCount: manifest.sample_count ?? null,
      featureCount: manifest.feature_count ?? null,
    },
    stages: { available: stages, configurationFiles: configFiles, completeByRunStatus: true },
    artifacts: familyLines,
    dataInventory,
    qualityFlags: {
      missingData: manifest.missingness ?? manifest.missing_data ?? null,
      qualityControl: manifest.quality_control ?? manifest.qc ?? null,
      unavailableFieldsAreNull: true,
    },
  };
  return `# Compact deterministic run card\nThis is orientation metadata, not a scientific summary or a ranking of findings.\n${JSON.stringify(card, null, 2)}`;
}

function retrieveCandidates(runPath: string, artifacts: IndexedArtifact[], intent: StandardIntent): EvidenceCandidate[] {
  const candidates: EvidenceCandidate[] = [];
  const targets = new Set(intent.targetFamilies);
  const familyCounts = new Map<ArtifactFamily, number>();
  const relevant = artifacts.filter((artifact) => targets.has(artifact.family))
    .sort((a, b) => artifactStaticPriority(b) - artifactStaticPriority(a) || a.path.localeCompare(b.path))
    .filter((artifact) => {
      const count = familyCounts.get(artifact.family) || 0;
      if (count >= 6) return false;
      familyCounts.set(artifact.family, count + 1); return true;
    });
  let crossModules = intent.modules.slice();

  if (intent.kind === "cross-modal") {
    const cellOrientation = relevant.filter((item) => {
      const columns = new Set(item.normalizedColumns);
      return item.family === "cell-type" && hasAny(columns, ["module", "modulecolor", "module_color"]) && hasAny(columns, ["celltype", "cell_type", "cell"]);
    }).slice(0, 1);
    for (const artifact of cellOrientation) {
      const table = readTable(runPath, artifact);
      const rankedRows = filterAndRankRows(table, artifact, intent);
      const fdrColumn = firstColumn(table.columns, ["fdr", "adj_pvalue", "padj", "pvalue"]);
      const significantRows = fdrColumn >= 0 ? rankedRows.filter((row) => Number(row.values[fdrColumn]) <= 0.05) : rankedRows;
      const rows = (significantRows.length ? significantRows : rankedRows).slice(0, 8);
      crossModules.push(...rows.map((row) => valueFor(row.values, table.columns, ["module", "module_color"]).toLowerCase()).filter(Boolean));
      const candidate = renderCandidate(artifact, table.columns, rows, intent, "cell-type match used to resolve associated modules");
      if (candidate) candidates.push(candidate);
    }
    crossModules = [...new Set(crossModules)];
  }

  for (const artifact of relevant) {
    if (intent.kind === "cross-modal" && artifact.family === "cell-type") continue;
    const table = readTable(runPath, artifact);
    if (!table.rows.length) continue;
    const effective = intent.kind === "cross-modal" ? { ...intent, modules: crossModules } : intent;
    const rows = filterAndRankRows(table, artifact, effective);
    if (!rows.length && intent.route === "lookup") continue;
    const selectedRows = rows.length ? rows : table.rows.slice(0, intent.route === "analytical" ? 25 : 10);
    const candidate = renderCandidate(artifact, table.columns, selectedRows, effective, retrievalReason(artifact, effective));
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function renderCandidate(
  artifact: IndexedArtifact,
  columns: string[],
  rows: Array<{ index: number; values: string[] }>,
  intent: StandardIntent,
  reason: string,
): EvidenceCandidate | null {
  if (!rows.length) return null;
  const header = columns.map(escapeCell).join("\t").slice(0, MAX_CANDIDATE_CHARACTERS);
  const includedRows: Array<{ index: number; values: string[] }> = [];
  const bodyRows = [header];
  let bodyCharacters = header.length;
  for (const row of rows.slice(0, MAX_ROWS_PER_ARTIFACT)) {
    const rendered = row.values.map(escapeCell).join("\t");
    if (bodyCharacters + rendered.length + 1 > MAX_CANDIDATE_CHARACTERS) break;
    bodyRows.push(rendered); includedRows.push(row); bodyCharacters += rendered.length + 1;
  }
  if (!includedRows.length) return null;
  const body = bodyRows.join("\n");
  const haystack = body.toLowerCase();
  let score = familyPriority(artifact.family, intent.kind);
  if (/^stage\d+\//i.test(artifact.path)) score += 2;
  else if (/^(?:input|run_manifest|pipeline_profile)/i.test(artifact.path)) score += 1;
  const entityHits = [...intent.proteins, ...intent.modules, ...intent.cellTypes]
    .filter((entity) => haystack.includes(entity.toLowerCase())).length;
  score += Math.min(15, entityHits * 5);
  score += Math.min(2, includedRows.length / 20);
  if (reason.includes("fallback")) score -= 4;
  return { artifact, body, rowIds: includedRows.map((row) => row.index + 2), rowsReturned: includedRows.length, score, reason };
}

function filterAndRankRows(
  table: { columns: string[]; rows: Array<{ index: number; values: string[] }> },
  artifact: IndexedArtifact,
  intent: StandardIntent,
) {
  const columns = table.columns;
  let rows = table.rows.slice();
  if (intent.proteins.length && ["differential-expression", "module-assignments"].includes(artifact.family)) {
    rows = rows.filter((row) => intent.proteins.some((protein) => protein === valueFor(row.values, columns, ["gene", "protein", "symbol"]).toUpperCase() || row.values.some((value) => tokenContains(value, protein))));
  }
  if (intent.modules.length && ["module-assignments", "module-traits", "go-enrichment", "cell-type"].includes(artifact.family)) {
    rows = rows.filter((row) => intent.modules.some((module) => normalizeModule(valueFor(row.values, columns, ["module", "module_color"])) === normalizeModule(module)));
  }
  if (intent.cellTypes.length && artifact.family === "cell-type") {
    rows = rows.filter((row) => intent.cellTypes.some((cell) => valueFor(row.values, columns, ["cell_type", "celltype", "cell"]).toLowerCase().includes(cell.toLowerCase().replace(/s$/, ""))));
  }
  const sortColumn = firstColumn(columns, artifact.family === "module-assignments" ? ["kME", "hub_score"] : ["fdr", "adj_pvalue", "padj", "pvalue"]);
  if (sortColumn >= 0) {
    const descending = normalizeColumn(columns[sortColumn]) === "kme" || normalizeColumn(columns[sortColumn]) === "hubscore";
    rows.sort((a, b) => {
      const av = Number(a.values[sortColumn]); const bv = Number(b.values[sortColumn]);
      if (!Number.isFinite(av)) return 1; if (!Number.isFinite(bv)) return -1;
      return descending ? bv - av : av - bv;
    });
  }
  const rowLimit = intent.route === "lookup" ? 30 : MAX_ROWS_PER_ARTIFACT;
  return rows.slice(0, rowLimit);
}

export function classifyArtifact(relPath: string, columns: string[], hint: string): ArtifactFamily {
  const set = new Set(columns);
  const low = `${relPath} ${hint}`.toLowerCase();
  if (hasAny(set, ["celltype", "cell_type", "cell"]) && hasAny(set, ["module", "modulecolor", "module_color"])) return "cell-type";
  if (hasAny(set, ["term", "goterm", "description"]) && hasAny(set, ["pvalue", "fdr", "adjpvalue", "padj"])) return "go-enrichment";
  if (hasAny(set, ["log2fc", "logfc"]) && hasAny(set, ["gene", "protein", "featureid", "feature_id"])) return "differential-expression";
  if (hasAny(set, ["module", "modulecolor", "module_color"]) && hasAny(set, ["gene", "protein", "featureid", "feature_id", "peptideid", "peptide_id"])) return "module-assignments";
  if (hasAny(set, ["module", "modulecolor", "module_color"]) && (columns.some((column) => column.startsWith("cor")) || columns.some((column) => column.startsWith("p_")))) return "module-traits";
  if (hasAny(set, ["samplename", "sample_name", "sample", "samplekey", "sample_key"])) return "sample-metadata";
  if (/go[_ .-]?(?:enrich|fet)|go-enr|enrichment/.test(low)) return "go-enrichment";
  if (/cell.?type|hitliststats/.test(low)) return "cell-type";
  if (/volcano|differential|de_results/.test(low)) return "differential-expression";
  if (/module.?trait|trait.?correlation/.test(low)) return "module-traits";
  if (/module.?assignment|module.?membership|wgcna.*module/.test(low)) return "module-assignments";
  if (/manifest|pipeline_profile|params/.test(low)) return "run-metadata";
  return "other";
}

function readTable(runPath: string, artifact: IndexedArtifact) {
  const absolute = safeRunPath(runPath, artifact.path);
  if (!absolute) return { columns: [] as string[], rows: [] as Array<{ index: number; values: string[] }> };
  const text = fs.readFileSync(absolute, "utf8");
  const delimiter = chooseDelimiter(text.split(/\r?\n/, 1)[0] || "", artifact.path);
  const records = parseDelimited(text, delimiter);
  const columns = records.shift() || [];
  return { columns, rows: records.map((values, index) => ({ index, values })) };
}

function parseDelimited(text: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ""; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell); if (row.some((value) => value.length)) rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function readHeader(filename: string) {
  const fd = fs.openSync(filename, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, bytes).toString("utf8").split(/\r?\n/, 1)[0] || "";
    return parseDelimited(first, chooseDelimiter(first, filename))[0] || [];
  } finally { fs.closeSync(fd); }
}

function countRowsBounded(filename: string, bytes: number) {
  if (bytes > 4 * 1024 * 1024) return null;
  try { return Math.max(0, fs.readFileSync(filename, "utf8").split(/\r?\n/).filter(Boolean).length - 1); }
  catch { return null; }
}

function readArtifactMetadata(runPath: string) {
  const raw = readJson(path.join(runPath, "artifact_index.json"));
  return new Map((Array.isArray(raw.artifacts) ? raw.artifacts : []).map((entry: any) => [String(entry.rel_path || ""), entry]));
}

function readJson(filename: string): Record<string, any> {
  try { return JSON.parse(fs.readFileSync(filename, "utf8")); } catch { return {}; }
}

function dedupeArtifacts(artifacts: IndexedArtifact[]) {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const signature = `${artifact.family}:${artifact.path.toLowerCase()}`;
    if (seen.has(signature)) return false;
    seen.add(signature); return true;
  });
}

function familyPriority(family: ArtifactFamily, kind: StandardIntent["kind"]) {
  const direct: Record<StandardIntent["kind"], ArtifactFamily[]> = {
    general: [], protein: ["differential-expression", "module-assignments"], module: ["module-assignments", "module-traits"],
    go: ["go-enrichment", "module-assignments"], "cell-type": ["cell-type", "module-assignments"],
    "cross-modal": ["cell-type", "go-enrichment", "module-assignments"], metadata: ["sample-metadata", "run-metadata"],
    summary: ["differential-expression", "module-assignments", "module-traits", "go-enrichment", "cell-type"],
    // Lexical fallback: BM25 already picked the families; this only orders ties.
    lexical: ["differential-expression", "module-assignments", "module-traits", "go-enrichment", "cell-type"],
  };
  const index = direct[kind].indexOf(family);
  return index < 0 ? 0 : 8 - index;
}

function artifactStaticPriority(artifact: IndexedArtifact) {
  let score = /^stage\d+\//i.test(artifact.path) ? 10 : 0;
  const columns = new Set(artifact.normalizedColumns);
  if (artifact.family === "go-enrichment" && hasAny(columns, ["module", "modulecolor", "module_color"]) && hasAny(columns, ["term", "goterm", "description"])) score += 6;
  if (artifact.family === "cell-type" && hasAny(columns, ["module", "modulecolor", "module_color"]) && hasAny(columns, ["celltype", "cell_type", "cell"])) score += 6;
  if (artifact.family === "differential-expression" && hasAny(columns, ["log2fc", "logfc"])) score += 4;
  if (artifact.family === "module-assignments" && hasAny(columns, ["kme", "hubscore"])) score += 4;
  return score;
}

function retrievalReason(artifact: IndexedArtifact, intent: StandardIntent) {
  const entities = [...intent.proteins, ...intent.modules, ...intent.cellTypes];
  return entities.length ? `schema matched ${artifact.family}; rows filtered for ${entities.join(", ")}` : `schema matched ${artifact.family}; top statistically ranked rows`;
}

interface LexicalDoc { path: string; family: ArtifactFamily; tf: Map<string, number>; length: number }
interface LexicalCorpus { docs: LexicalDoc[]; df: Map<string, number>; avgdl: number; n: number }

// Deterministic BM25 relevance retrieval over the run's own artifacts. Returns
// the evidence families to ground and the per-artifact matched terms/score, or
// null when nothing clears the discriminative-anchor floor (so a question that
// slips past definitional detection still grounds zero rather than dumping data).
function lexicalRelevanceFallback(
  runPath: string,
  artifacts: IndexedArtifact[],
  question: string,
): { families: ArtifactFamily[]; artifacts: Map<string, { score: number; terms: string[] }> } | null {
  const queryTerms = [...new Set(lexTokens(question))];
  if (!queryTerms.length) return null;
  const corpus = buildLexicalCorpus(runPath, artifacts);
  if (!corpus.n) return null;
  const scored = corpus.docs.map((doc) => {
    let score = 0;
    const matched: string[] = [];
    const anchors: string[] = [];
    for (const term of queryTerms) {
      const tf = doc.tf.get(term);
      if (!tf) continue;
      const idf = lexIdf(corpus.df.get(term) || 0, corpus.n);
      if (idf <= 0) continue;
      const denom = tf + LEX_K1 * (1 - LEX_B + LEX_B * (doc.length / (corpus.avgdl || 1)));
      score += (idf * (tf * (LEX_K1 + 1))) / (denom || 1);
      matched.push(term);
      if (idf >= LEX_IDF_FLOOR) anchors.push(term);
    }
    return { doc, score, matched, anchors };
  })
    .filter((entry) => entry.score > 0 && entry.anchors.length > 0)
    .sort((a, b) => b.score - a.score || a.doc.path.localeCompare(b.doc.path));
  if (!scored.length) return null;

  const families: ArtifactFamily[] = [];
  const matches = new Map<string, { score: number; terms: string[] }>();
  for (const entry of scored) {
    if (entry.doc.family === "other") continue;
    if (!families.includes(entry.doc.family) && families.length < LEX_MAX_FAMILIES) families.push(entry.doc.family);
    if (families.includes(entry.doc.family)) {
      matches.set(entry.doc.path, { score: entry.score, terms: (entry.anchors.length ? entry.anchors : entry.matched).slice(0, 6) });
    }
  }
  if (!families.length) return null;
  return { families, artifacts: matches };
}

function buildLexicalCorpus(runPath: string, artifacts: IndexedArtifact[]): LexicalCorpus {
  const signature = runSignature(runPath);
  const cached = lexicalCorpusCache.get(runPath);
  if (cached?.signature === signature) return cached.corpus;
  const docs: LexicalDoc[] = [];
  const df = new Map<string, number>();
  for (const artifact of artifacts) {
    const document = [
      artifact.path.replace(/[/_.\-]+/g, " "),
      artifact.columns.join(" "),
      artifact.normalizedColumns.join(" "),
      FAMILY_PROFILE[artifact.family] || "",
      readSample(runPath, artifact),
    ].join(" ");
    const tokens = lexTokens(document).slice(0, LEX_MAX_DOC_TOKENS);
    if (!tokens.length) continue;
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
    for (const token of tf.keys()) df.set(token, (df.get(token) || 0) + 1);
    docs.push({ path: artifact.path, family: artifact.family, tf, length: tokens.length });
  }
  const avgdl = docs.length ? docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length : 0;
  const corpus: LexicalCorpus = { docs, df, avgdl, n: docs.length };
  lexicalCorpusCache.set(runPath, { signature, corpus });
  return corpus;
}

function readSample(runPath: string, artifact: IndexedArtifact): string {
  if (!/\.(?:csv|tsv|txt)$/i.test(artifact.path)) return "";
  const absolute = safeRunPath(runPath, artifact.path);
  if (!absolute) return "";
  try {
    const fd = fs.openSync(absolute, "r");
    try {
      const buffer = Buffer.alloc(LEX_SAMPLE_BYTES);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytes).toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return ""; }
}

function runSignature(runPath: string): string {
  const indexPath = path.join(runPath, "artifact_index.json");
  const stat = fs.existsSync(indexPath) ? fs.statSync(indexPath) : fs.statSync(runPath);
  return `${stat.mtimeMs}:${stat.size}`;
}

function lexTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z0-9_]+/g) || []) {
    if (raw.length < 2 || LEX_STOPWORDS.has(raw)) continue;
    const stem = lexStem(raw);
    if (stem.length >= 2 && !LEX_STOPWORDS.has(stem)) out.push(stem);
  }
  return out;
}
function lexStem(token: string): string { return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token; }
function lexIdf(df: number, n: number): number { return Math.log(1 + (n - df + 0.5) / (df + 0.5)); }

function normalizeColumn(column: string) { return column.trim().toLowerCase().replace(/[^a-z0-9_]/g, ""); }
function normalizeModule(module: string) { return module.trim().toLowerCase().replace(/^me/, ""); }
function hasAny(set: Set<string>, names: string[]) { return names.some((name) => set.has(name)); }
function chooseDelimiter(header: string, filename: string) { return filename.toLowerCase().endsWith(".tsv") || (header.match(/\t/g)?.length || 0) > (header.match(/,/g)?.length || 0) ? "\t" : ","; }
function firstColumn(columns: string[], names: string[]) { const normalized = columns.map(normalizeColumn); return normalized.findIndex((column) => names.map(normalizeColumn).includes(column)); }
function valueFor(values: string[], columns: string[], names: string[]) { const index = firstColumn(columns, names); return index >= 0 ? String(values[index] || "") : ""; }
function tokenContains(value: string, token: string) { return new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(token)}([^A-Za-z0-9]|$)`, "i").test(value); }
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function escapeCell(value: string) { return String(value ?? "").replace(/[\r\n\t]+/g, " ").slice(0, MAX_CELL_BYTES); }
function snippet(value: string, length: number) { const flat = value.replace(/\s+/g, " ").trim(); return flat.length <= length ? flat : `${flat.slice(0, length)}…`; }
function safeRunPath(runPath: string, relPath: string) { const absolute = path.resolve(runPath, relPath); return absolute.startsWith(`${runPath}${path.sep}`) ? absolute : null; }
