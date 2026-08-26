import fs from "node:fs";
import path from "node:path";
import { loadScientificSkillLock, SCIENTIFIC_SKILL_POLICIES, scientificSkillsRoot } from "./scientific-catalog.js";
import type { ParamSchema } from "./param-validation.js";

export interface SkillEntrypoint {
  id: string;
  /** One-line, human-readable "what this operation does" for the plan editor. */
  summary?: string;
  network: { policy: "none" | "llm" | "curated" };
  resources: { cpu: number; memoryMb: number; timeoutSec: number };
  deterministic: boolean;
  /** Closed JSON-Schema (subset) describing the operation's parameters, with
   *  per-field defaults/examples. Drives the editor form and validates input. */
  params?: ParamSchema;
  /** Primary committed script this operation runs (when applicable), surfaced so
   *  the editor can show "runs eda_analyzer.py" without exposing internals. */
  primaryScript?: string;
}

export interface SkillManifest {
  id: string;
  catalogVersion: string;
  label: string;
  kind: "native" | "third-party";
  /** Human description of what the skill does (sourced from the manifest for
   *  native skills, or the SKILL.md frontmatter for vendored scientific ones). */
  description?: string;
  source: { storage: "repository"; revision: string; license: string };
  provider: { type: "signalfold-pipeline" | "python-script"; implementation: string };
  entrypoints: SkillEntrypoint[];
}

export interface SkillReadiness extends SkillManifest {
  ready: boolean;
  diagnostics: string[];
  /** Path to this skill's manifest, relative to the ai-sidecar root, so the
   *  Operations Control Center can point a developer straight at the committed
   *  source (e.g. skills/research/native/.../signalfold.skill.json). */
  manifestPath: string;
}

const MANIFEST = "signalfold.skill.json";

export function loadResearchSkillCatalog(root = path.join(import.meta.dirname, "..", "..", "skills", "research")): SkillReadiness[] {
  if (!fs.existsSync(root)) return [];
  const sidecarRoot = path.join(import.meta.dirname, "..", "..");
  const manifests: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name === MANIFEST) manifests.push(absolute);
    }
  };
  walk(root);
  return manifests.sort().map((filename) => {
    const diagnostics: string[] = [];
    let value: Partial<SkillManifest> = {};
    try { value = JSON.parse(fs.readFileSync(filename, "utf8")); } catch { diagnostics.push("manifest is not valid JSON"); }
    if (!value.id || !/^[a-z0-9-]+$/.test(value.id)) diagnostics.push("id must be a stable kebab-case identifier");
    if (!value.catalogVersion) diagnostics.push("catalogVersion is required");
    if (!value.provider || !["signalfold-pipeline", "python-script"].includes(value.provider.type)) diagnostics.push("provider type is unsupported");
    if (!Array.isArray(value.entrypoints) || !value.entrypoints.length) diagnostics.push("at least one entrypoint is required");
    for (const entrypoint of value.entrypoints || []) {
      if (!entrypoint.id || !entrypoint.resources || entrypoint.resources.timeoutSec <= 0) diagnostics.push("entrypoint resources are invalid");
      // Offline compute is "none"; the synthesis skill narrates over an LLM ("llm").
      // "curated" external lookups are a declared-but-not-yet-enabled future arm.
      if (!["none", "llm"].includes(entrypoint.network?.policy as string)) diagnostics.push("network policy must be 'none' or 'llm' (curated external lookups are not enabled yet)");
      if (entrypoint.params && entrypoint.params.type !== "object") diagnostics.push(`entrypoint ${entrypoint.id} params schema must be an object`);
    }
    return { ...(value as SkillManifest), ready: diagnostics.length === 0, diagnostics, manifestPath: path.relative(sidecarRoot, filename).replaceAll("\\", "/") };
  });
}

// Per-operation contract for the vendored scientific skills. These have no
// signalfold.skill.json (their source of truth is the Anthropic-style SKILL.md),
// so the operation summary + parameter schema is declared here, keyed by the
// entrypoint the unified catalog assigns. Anything not listed activates its
// SKILL.md with no parameters.
const SCIENTIFIC_ENTRYPOINT_META: Record<string, { summary: string; params: ParamSchema }> = {
  summarize: {
    summary: "Profile the frozen tabular artifact and emit a structured EDA report.",
    params: { type: "object", additionalProperties: false, properties: {}, examples: [{}] },
  },
  "summary-figure": {
    summary: "Render a deterministic summary figure for the scoped result.",
    params: {
      type: "object", additionalProperties: false,
      properties: { label: { type: "string", description: "Caption shown on the generated summary figure." } },
      examples: [{ label: "Summary figure" }],
    },
  },
  "rank-existing-ora": {
    summary: "Rank the existing Stage 2 ORA evidence in place (no new enrichment is computed).",
    params: {
      type: "object", additionalProperties: false,
      properties: {
        method: { type: "string", enum: ["stage2-ora-ranking"], default: "stage2-ora-ranking", description: "Ranking strategy over the existing ORA table." },
        seed: { type: "integer", minimum: 0, default: 0, description: "Deterministic tie-break seed." },
      },
      examples: [{ method: "stage2-ora-ranking", seed: 0 }],
    },
  },
};

const ACTIVATE_PARAMS: ParamSchema = { type: "object", additionalProperties: false, properties: {}, examples: [{}] };

// SKILL.md frontmatter `description:` for a vendored scientific skill. Cached:
// SKILL.md is committed and immutable at runtime.
const descriptionCache = new Map<string, string>();
function scientificDescription(id: string): string {
  if (descriptionCache.has(id)) return descriptionCache.get(id)!;
  let description = "";
  try {
    const text = fs.readFileSync(path.join(scientificSkillsRoot(), id, "SKILL.md"), "utf8");
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const match = (frontmatter ? frontmatter[1] : text).match(/^description:\s*(.+)$/m);
    description = match ? match[1].trim() : "";
  } catch { description = ""; }
  descriptionCache.set(id, description);
  return description;
}

export function loadUnifiedResearchSkillCatalog(): SkillReadiness[] {
  const native = [
    ...loadResearchSkillCatalog(path.join(import.meta.dirname, "..", "..", "skills", "research", "native")),
    ...loadResearchSkillCatalog(path.join(import.meta.dirname, "..", "..", "skills", "native")),
  ];
  const lock = loadScientificSkillLock();
  const ids: Record<string, string> = { "exploratory-data-analysis": "summarize", "scientific-visualization": "summary-figure", "pathway-enrichment": "rank-existing-ora" };
  const scientific = SCIENTIFIC_SKILL_POLICIES.map((policy) => {
    const locked = lock.skills.find((item) => item.id === policy.id)!;
    const ready = policy.readiness !== "unavailable";
    const entrypointId = ids[policy.id] || "activate";
    const meta = SCIENTIFIC_ENTRYPOINT_META[entrypointId];
    return {
      id: policy.id, catalogVersion: policy.version, label: policy.id.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "), kind: "third-party" as const,
      description: scientificDescription(policy.id),
      source: { storage: "repository" as const, revision: lock.upstream.commit, license: policy.license },
      provider: { type: "python-script" as const, implementation: `scientific/${policy.id}` },
      entrypoints: [{
        id: entrypointId,
        summary: meta?.summary || "Activate this skill's SKILL.md guidance for the approved frozen scope.",
        network: { policy: policy.networkPolicy === "offline" ? "none" as const : "curated" as const },
        resources: { cpu: 1, memoryMb: 512, timeoutSec: 120 },
        deterministic: ["deterministic", "seeded"].includes(policy.determinism),
        params: meta?.params || ACTIVATE_PARAMS,
        primaryScript: policy.allowedScripts[0] ? path.basename(policy.allowedScripts[0]) : undefined,
      }],
      ready, diagnostics: ready ? [] : [policy.diagnostic], manifestPath: `skills/scientific/${policy.id}/SKILL.md`, folderHash: locked.folderHash,
    } as SkillReadiness & { folderHash: string };
  });
  return [...scientific, ...native];
}
