import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FilesystemRunCatalog } from "../run-catalog.js";
import { buildStandardGrounding, classifyArtifact, readHeader, type GroundingCitation, type SelectedStandardArtifact } from "../standard-grounding.js";
import { describeArtifact, isCanonicalPath, isLegacyPath, stageOf, type RunCatalogEntry } from "./artifact-catalog.js";

export interface ResearchScopeArtifact {
  path: string;
  family: string;
  sha256: string;
  bytes: number;
  rowIds: Array<number | string>;
  rowRefs: ResearchRowReference[];
  reason: string;
  /** True when the researcher forced this file into the frozen scope via an
   *  @-mention / "pin" (rather than question-adaptive retrieval selecting it). */
  pinned?: boolean;
}

export interface ResearchRowReference {
  id: string;
  selector: { type: "row-number" | "stable-id"; value: number | string };
  rowSha256: string | null;
}

export interface ResearchScopeManifest {
  schemaVersion: "1.0" | "1.1";
  runId: string;
  createdAt: string;
  query: string;
  plan: Record<string, unknown>;
  budget: { maxCostUsd: number; maxRuntimeSeconds: number };
  artifacts: ResearchScopeArtifact[];
  stageConfigs: Array<{ path: string; sha256: string; bytes: number }>;
  controlAudit?: Array<{ path: string; sha256: string; controls: Record<string, unknown> }>;
  referenceSnapshots?: Array<{ artifactPath: string; artifactSha256: string; headerSha256: string | null; rows: ResearchRowReference[] }>;
  lineage?: {
    planSha256: string;
    inputs: Array<{ artifactPath: string; sha256: string; relation: "wasSelectedFromRun" }>;
    controls: Array<{ configPath: string; sha256: string; relation: "wasControlledBy" }>;
  };
  exclusions: Array<{ path: string; reason: string }>;
  retrieval: { route: string; intent: string; budgetTokens: number; truncated: boolean };
  /** External corroboration arms approved into this frozen scope (e.g. uniprot,
   *  reactome, string, pubmed). Empty = offline, run-only evidence. */
  sources: string[];
  /** Reviewed NETWORK skills approved into this frozen scope (e.g.
   *  pathway-enrichment). Empty = no network-skill egress. Their egressDomains
   *  plus the approved sources' hosts form the per-job egress-proxy allowlist. */
  networkSkills?: string[];
  /** The WHOLE-RUN descriptive index, frozen at approval. Every run data file
   *  (canonical stageN outputs AND legacy deliverable copies) with a role,
   *  contents description, derivation note, and content hash. This is what lets
   *  the free-form agent SEE everything the run produced and pull any file on
   *  demand (fetch_input) while provenance stays auditable — the subset in
   *  `artifacts` is only the warm default that is pre-staged. Absent in cheap
   *  pre-approval previews (built only when withCatalog is set). */
  catalog?: RunCatalogEntry[];
  sha256: string;
}

const SOURCE_IDS = ["uniprot", "pubmed", "pmc", "reactome", "string", "quickgo"];
const NETWORK_SKILL_IDS = ["pathway-enrichment", "gget", "bioservices", "database-lookup", "citation-management"];
const normalizeColumns = (columns: string[]) => columns.map((value) => value.toLowerCase().replace(/[^a-z0-9]/g, ""));

const hashFile = (filename: string) => crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const hashText = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const lineAt = (filename: string, rowId: number | string) => {
  const index = Number(rowId) - 1;
  if (!Number.isInteger(index) || index < 0) return null;
  const line = fs.readFileSync(filename, "utf8").split(/\r?\n/)[index];
  return line === undefined ? null : line;
};
const rowRefs = (artifactPath: string, filename: string, ids: Array<number | string>): ResearchRowReference[] => ids.map((rowId) => {
  const line = lineAt(filename, rowId);
  return { id: hashText(`${artifactPath}\0row-number\0${rowId}`).slice(0, 24), selector: { type: "row-number", value: rowId }, rowSha256: line === null ? null : hashText(line) };
});

/** Freeze a research scope from the same question-adaptive retrieval used by
 * Standard. The manifest adds immutable hashes/configs; it never falls back to
 * filename-order context stuffing. */
export function buildResearchScopeManifest(
  catalog: FilesystemRunCatalog,
  runId: string,
  query: string,
  plan: Record<string, unknown>,
  options: { evidenceTokenBudget?: number; maxCostUsd?: number; maxRuntimeSeconds?: number; createdAt?: string; pinnedPaths?: string[]; sources?: string[]; networkSkills?: string[]; withCatalog?: boolean } = {},
): ResearchScopeManifest {
  const run = catalog.get(runId);
  if (!run) throw new Error("Selected run is unavailable or not complete");
  const grounding = buildStandardGrounding(catalog, runId, query, { evidenceTokenBudget: options.evidenceTokenBudget ?? 24_000 });
  const citations = new Map<string, GroundingCitation>();
  for (const citation of grounding.citations) citations.set(citation.filePath, citation);
  const selected = new Map<string, SelectedStandardArtifact>();
  for (const artifact of grounding.selectedArtifacts) selected.set(artifact.path, artifact);
  const configs = catalog.context(runId).filter((item) => /(?:^|\/)config_stage\d+\.json$/i.test(item.path));
  const artifacts: ResearchScopeArtifact[] = [...selected.values()].map((item) => {
    const absolute = path.resolve(run.path, item.path);
    if (!absolute.startsWith(`${run.path}${path.sep}`) || !fs.existsSync(absolute)) throw new Error(`Scoped artifact is unavailable: ${item.path}`);
    const rowIds = citations.get(item.path)?.rowIds || [];
    return {
      path: item.path,
      family: item.family,
      sha256: hashFile(absolute),
      bytes: fs.statSync(absolute).size,
      rowIds,
      rowRefs: rowRefs(item.path, absolute, rowIds),
      reason: item.reason,
    };
  });
  // Researcher-pinned files (@context / @myfiles / @artifacts). Forced into the
  // frozen scope even when retrieval didn't pick them, and appended AFTER the
  // retrieved evidence so they never displace the primary family file the EDA
  // skill reads first. Each is classified by its header so family-specific
  // skills can still use it; arbitrary uploads land as "other".
  const havePaths = new Set(artifacts.map((item) => item.path));
  for (const rawPath of [...new Set((options.pinnedPaths || []).map((value) => String(value || "").replaceAll("\\", "/").replace(/^\/+/, "")))]) {
    if (!rawPath || havePaths.has(rawPath)) continue;
    const absolute = path.resolve(run.path, rawPath);
    if (!absolute.startsWith(`${run.path}${path.sep}`) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`Pinned file is unavailable: ${rawPath}`);
    let family = "other";
    try { family = classifyArtifact(rawPath, normalizeColumns(readHeader(absolute)), ""); } catch { family = "other"; }
    artifacts.push({ path: rawPath, family, sha256: hashFile(absolute), bytes: fs.statSync(absolute).size, rowIds: [], rowRefs: [], reason: "pinned by the researcher into the frozen scope", pinned: true });
    havePaths.add(rawPath);
  }
  const stageConfigs = configs.map((item) => {
    const absolute = path.resolve(run.path, item.path);
    return { path: item.path, sha256: hashFile(absolute), bytes: fs.statSync(absolute).size };
  });
  const controlAudit = stageConfigs.map((item) => {
    const absolute = path.resolve(run.path, item.path);
    let controls: Record<string, unknown> = {};
    try { const parsed = JSON.parse(fs.readFileSync(absolute, "utf8")); controls = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { controls = { unreadable: true }; }
    return { path: item.path, sha256: item.sha256, controls };
  });
  const referenceSnapshots = artifacts.map((item) => {
    const absolute = path.resolve(run.path, item.path);
    let headerSha256: string | null = null;
    try { const header = fs.readFileSync(absolute, "utf8").split(/\r?\n/, 1)[0]; headerSha256 = header ? hashText(header) : null; } catch { headerSha256 = null; }
    return { artifactPath: item.path, artifactSha256: item.sha256, headerSha256, rows: item.rowRefs };
  });
  const selectedPaths = new Set([...artifacts.map((item) => item.path), ...stageConfigs.map((item) => item.path)]);
  const exclusions = catalog.context(runId)
    .filter((item) => /\.(?:csv|tsv|txt|json|md)$/i.test(item.path) && !selectedPaths.has(item.path))
    .map((item) => ({ path: item.path, reason: "not selected by approved query-adaptive scope" }));
  const unsigned = {
    schemaVersion: "1.1" as const,
    runId,
    createdAt: options.createdAt || new Date().toISOString(),
    query,
    plan,
    budget: {
      maxCostUsd: Math.max(0, options.maxCostUsd ?? 1.25),
      maxRuntimeSeconds: Math.max(1, Math.floor(options.maxRuntimeSeconds ?? 600)),
    },
    artifacts,
    stageConfigs,
    controlAudit,
    referenceSnapshots,
    lineage: {
      planSha256: hashText(stableJson(plan)),
      inputs: artifacts.map((item) => ({ artifactPath: item.path, sha256: item.sha256, relation: "wasSelectedFromRun" as const })),
      controls: stageConfigs.map((item) => ({ configPath: item.path, sha256: item.sha256, relation: "wasControlledBy" as const })),
    },
    exclusions,
    retrieval: { route: grounding.route, intent: grounding.intent, budgetTokens: grounding.budgetTokens, truncated: grounding.truncated },
    sources: [...new Set((options.sources || []).map(String).filter((source) => SOURCE_IDS.includes(source)))],
    networkSkills: [...new Set((options.networkSkills || []).map(String).filter((id) => NETWORK_SKILL_IDS.includes(id)))],
    // The whole-run descriptive index, hashed, frozen INTO the signed manifest so
    // a pulled file can be proven byte-identical to approval time. Built only at
    // approval (withCatalog) — previews skip it to stay cheap on big runs.
    ...(options.withCatalog ? { catalog: buildRunCatalog(catalog, runId) } : {}),
  };
  return { ...unsigned, sha256: crypto.createHash("sha256").update(stableJson(unsigned)).digest("hex") };
}

/**
 * Build the whole-run descriptive catalog: every visible data file the run
 * catalog exposes (canonical stageN outputs AND legacy deliverable copies),
 * each with a role, a contents description, a derivation note (respecting the
 * pipeline biologics), and a content hash. Reads each file ONCE to hash it and
 * count rows. Used to freeze the index into the scope manifest so the free-form
 * agent can navigate and fetch_input any file with provenance intact.
 */
export function buildRunCatalog(catalog: FilesystemRunCatalog, runId: string): RunCatalogEntry[] {
  const run = catalog.get(runId);
  if (!run) throw new Error("Selected run is unavailable or not complete");
  const entries: RunCatalogEntry[] = [];
  for (const item of catalog.context(runId)) {
    if (!/\.(?:csv|tsv|txt|json|md)$/i.test(item.path)) continue;
    const absolute = path.resolve(run.path, item.path);
    if (!absolute.startsWith(`${run.path}${path.sep}`) || !fs.existsSync(absolute)) continue;
    const tabular = /\.(?:csv|tsv|txt)$/i.test(item.path);
    let columns: string[] = [];
    if (tabular) { try { columns = readHeader(absolute); } catch { columns = []; } }
    const family = classifyArtifact(item.path, normalizeColumns(columns), "");
    let buffer: Buffer;
    try { buffer = fs.readFileSync(absolute); } catch { continue; }
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    let rowCount: number | null = null;
    if (tabular) {
      let newlines = 0;
      for (let i = 0; i < buffer.length; i += 1) if (buffer[i] === 0x0a) newlines += 1;
      // Line count is robust to whether the file ends with a newline: a final
      // record without a trailing newline still counts. Data rows = lines minus
      // the header row.
      const endsWithNewline = buffer.length > 0 && buffer[buffer.length - 1] === 0x0a;
      const lines = buffer.length === 0 ? 0 : newlines + (endsWithNewline ? 0 : 1);
      rowCount = Math.max(0, lines - 1);
    }
    const described = describeArtifact(item.path, family, columns, rowCount, item.bytes);
    entries.push({
      path: item.path,
      family,
      stage: stageOf(item.path),
      columns: columns.slice(0, 16),
      columnCount: tabular ? columns.length : null,
      rowCount,
      bytes: item.bytes,
      canonical: isCanonicalPath(item.path),
      legacy: isLegacyPath(item.path),
      sha256,
      ...described,
    });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export function verifyResearchScopeManifest(catalog: FilesystemRunCatalog, manifest: ResearchScopeManifest): { valid: boolean; errors: string[] } {
  const run = catalog.get(manifest.runId);
  if (!run) return { valid: false, errors: ["Selected run is unavailable"] };
  const errors: string[] = [];
  for (const item of manifest.artifacts) {
    const filename = path.resolve(run.path, item.path);
    if (!filename.startsWith(`${run.path}${path.sep}`) || !fs.existsSync(filename)) { errors.push(`Scoped artifact is missing: ${item.path}`); continue; }
    if (hashFile(filename) !== item.sha256) errors.push(`Scoped artifact hash changed: ${item.path}`);
    for (const row of item.rowRefs || []) {
      const line = lineAt(filename, row.selector.value);
      if (row.rowSha256 && (line === null || hashText(line) !== row.rowSha256)) errors.push(`Scoped row changed: ${item.path}#${row.selector.value}`);
    }
  }
  for (const config of manifest.stageConfigs) {
    const filename = path.resolve(run.path, config.path);
    if (!filename.startsWith(`${run.path}${path.sep}`) || !fs.existsSync(filename)) errors.push(`Stage config is missing: ${config.path}`);
    else if (hashFile(filename) !== config.sha256) errors.push(`Stage config hash changed: ${config.path}`);
  }
  return { valid: errors.length === 0, errors };
}
