import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ResearchScopeManifest } from "../grounding/research-scope.js";

export type WorkflowRecipe = "ranked-pathway" | "module-hub" | "external-protein-evidence" | "literature-contradiction" | "power-next-experiment";
type Row = Record<string, string>;

const split = (line: string, delimiter: string) => { const out: string[] = []; let value = "", quoted = false; for (let i = 0; i < line.length; i += 1) { const char = line[i]; if (char === '"' && line[i + 1] === '"' && quoted) { value += '"'; i += 1; } else if (char === '"') quoted = !quoted; else if (char === delimiter && !quoted) { out.push(value.trim()); value = ""; } else value += char; } out.push(value.trim()); return out; };
const rows = (filename: string): Row[] => { const lines = fs.readFileSync(filename, "utf8").split(/\r?\n/).filter(Boolean); if (lines.length < 2) return []; const delimiter = filename.endsWith(".tsv") ? "\t" : ","; const headers = split(lines[0], delimiter).map((item) => item.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")); return lines.slice(1).map((line) => Object.fromEntries(split(line, delimiter).map((value, index) => [headers[index] || `column_${index + 1}`, value]))); };
const pick = (row: Row, patterns: RegExp[]) => Object.entries(row).find(([key]) => patterns.some((pattern) => pattern.test(key)))?.[1] || "";
const number = (value: string, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const csv = (headers: string[], values: Array<Array<string | number>>) => `${headers.join(",")}\n${values.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n")}\n`;
const correlation = (a: number[], b: number[]) => { const pairs = a.map((value, index) => [value, b[index]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)); if (pairs.length < 3) return 0; const ax = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length, bx = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length; const numerator = pairs.reduce((sum, pair) => sum + (pair[0] - ax) * (pair[1] - bx), 0); const denominator = Math.sqrt(pairs.reduce((sum, pair) => sum + Math.pow(pair[0] - ax, 2), 0) * pairs.reduce((sum, pair) => sum + Math.pow(pair[1] - bx, 2), 0)); return denominator ? numerator / denominator : 0; };

export function runWorkflowRecipe(input: { recipe: WorkflowRecipe; runPath: string; workspace: string; scope: ResearchScopeManifest }) {
  const artifacts = input.scope.artifacts.map((artifact) => ({ artifact, absolute: path.resolve(input.runPath, artifact.path) }));
  for (const { artifact, absolute } of artifacts) {
    if (!absolute.startsWith(`${path.resolve(input.runPath)}${path.sep}`)) throw new Error("Frozen input escaped run root");
    const digest = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
    if (digest !== artifact.sha256) throw new Error(`Frozen input hash changed: ${artifact.path}`);
  }
  const find = (pattern: RegExp) => artifacts.find(({ artifact }) => pattern.test(artifact.path))?.absolute;
  const deFile = find(/(?:volcano|differential).*(?:csv|tsv)$/i); const de = deFile ? rows(deFile) : [];
  let filename = `${input.recipe}.csv`; let content = "";
  if (input.recipe === "ranked-pathway") {
    const goFile = find(/go_enrichment.*(?:csv|tsv)$/i); if (!goFile || !de.length) throw new Error("Ranked pathway recipe requires full Stage 1 ranking and Stage 2 GO table");
    const ordered = de.sort((a, b) => number(pick(b, [/log2.*fc/, /fold.*change/, /effect/])) - number(pick(a, [/log2.*fc/, /fold.*change/, /effect/]))); const orderedIds = ordered.map((row) => pick(row, [/^gene$/, /protein/, /feature/, /accession/, /^id$/]));
    content = csv(["term", "module", "stage2_fdr", "leading_edge", "full_rank_score", "peak_rank", "method_comparison"], rows(goFile).map((row) => { const genes = pick(row, [/hit.*gene/, /members/, /proteins/]).split(/[;| ]+/).filter(Boolean); const set = new Set(genes); const hits = orderedIds.filter((id) => set.has(id)).length; const misses = orderedIds.length - hits; let running = 0, peak = 0, peakRank = 0; orderedIds.forEach((id, index) => { running += set.has(id) ? 1 / Math.max(1, hits) : -1 / Math.max(1, misses); if (Math.abs(running) > Math.abs(peak)) { peak = running; peakRank = index + 1; } }); return [pick(row, [/term/, /description/, /pathway/]), pick(row, [/module/]), pick(row, [/fdr/, /adj.*p/, /q_value/]), genes.join(";"), peak.toFixed(4), peakRank || "unmapped", "Deterministic running-sum over complete Stage 1 signed ranking using frozen Stage 2 sets; not permutation GSEA"]; }));
  } else if (input.recipe === "module-hub") {
    const assignmentFile = find(/module_assignments.*(?:csv|tsv)$/i); const kmeFile = find(/kme_matrix.*(?:csv|tsv)$/i); if (!assignmentFile || !kmeFile) throw new Error("Module hub recipe requires module assignments and kME matrix");
    const normalizedFile = find(/normalized_matrix\.csv$/i); if (!normalizedFile) throw new Error("Module hub graph requires the approved normalized sample matrix");
    const assignments = rows(assignmentFile); const kme = rows(kmeFile); const matrix = rows(normalizedFile); const effects = new Map(de.map((row) => [pick(row, [/^gene$/, /protein/, /feature/, /accession/, /^id$/]), number(pick(row, [/log2.*fc/, /fold.*change/, /effect/]))])); const values = new Map(matrix.map((row) => { const feature = pick(row, [/^gene$/, /protein/, /feature/, /accession/, /^id$/]) || Object.values(row)[0]; return [feature, Object.entries(row).filter(([key]) => !/^(gene|protein|feature|accession|id)$/.test(key)).map(([, value]) => number(value, Number.NaN))]; }));
    content = csv(["feature", "module", "kme_membership", "absolute_effect", "within_module_degree_r07", "mean_absolute_within_module_correlation", "external_status"], assignments.map((row, index) => { const feature = pick(row, [/^gene$/, /protein/, /feature/, /accession/, /^id$/]); const module = pick(row, [/module/, /color/]); const member = kme.find((item) => pick(item, [/^gene$/, /protein/, /feature/, /accession/, /^id$/]) === feature) || kme[index] || {}; const peers = assignments.map((item) => ({ feature: pick(item, [/^gene$/, /protein/, /feature/, /accession/, /^id$/]), module: pick(item, [/module/, /color/]) })).filter((item) => item.module === module && item.feature !== feature); const correlations = peers.map((peer) => correlation(values.get(feature) || [], values.get(peer.feature) || [])).filter(Number.isFinite); return [feature, module, Math.max(...Object.entries(member).filter(([key]) => /kme|membership/.test(key)).map(([, value]) => Math.abs(number(value))), 0), Math.abs(effects.get(feature) || 0), correlations.filter((value) => Math.abs(value) >= 0.7).length, correlations.length ? (correlations.reduce((sum, value) => sum + Math.abs(value), 0) / correlations.length).toFixed(4) : 0, "STRING broker arm separate"]; }));
  } else if (input.recipe === "external-protein-evidence") {
    content = csv(["run_identifier", "run_row", "mapping_status", "approved_external_sources", "evidence_state"], de.slice(0, 25).map((row, index) => [pick(row, [/^gene$/, /protein/, /feature/, /accession/, /^id$/]), index + 2, "exact run identifier; external canonical mapping pending", "UniProt;PubMed;PMC;Reactome;STRING;QuickGO", "broker retrieval reported separately"]));
  } else if (input.recipe === "literature-contradiction") {
    content = csv(["run_claim", "direction", "run_support", "literature_state", "context_classification", "discriminator"], de.slice(0, 25).map((row) => { const id = pick(row, [/^gene$/, /protein/, /feature/, /accession/, /^id$/]); const effect = number(pick(row, [/log2.*fc/, /fold.*change/, /effect/])); return [`${id} is ${effect >= 0 ? "higher" : "lower"} in the configured contrast`, effect >= 0 ? "up" : "down", pick(row, [/adj.*p/, /fdr/, /q_value/, /pvalue/]), "curated broker evidence pending", "unclassified until tissue/species/assay/cohort match", "matched-cohort replication or targeted assay"]; }));
  } else {
    const effects = de.map((row) => Math.abs(number(pick(row, [/log2.*fc/, /fold.*change/, /effect/])))).filter((value) => value > 0); const pilot = effects[0] || 0.5;
    const scenarios = [0.5, 0.8, 1].map((scale) => { const standardized = Math.max(0.2, pilot * scale); const n = Math.ceil(2 * Math.pow(1.96 + 0.8416, 2) / Math.pow(standardized, 2)); return [scale, standardized.toFixed(3), n, n * 2, "two-sided alpha 0.05; 80% power; equal variance", "balanced permuted blocks; seed 0"]; });
    content = csv(["effect_scale", "standardized_effect", "samples_per_group", "total_samples", "assumptions", "recommended_design"], scenarios);
  }
  const output = path.join(input.workspace, "outputs", filename); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, content);
  return { output, relativePath: `outputs/${filename}`, content };
}
