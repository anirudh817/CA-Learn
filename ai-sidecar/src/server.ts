import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { loadConfig, publicConfig, type SidecarConfig } from "./config.js";
import { ModelCatalog } from "./models.js";
import { FilesystemRunCatalog } from "./run-catalog.js";
import { PiRuntime, type Runtime, type RuntimeFrame } from "./runtime.js";
import { inspectPrompt, scrubOperationalValue, scrubOutput, wrapUntrustedAttachment } from "./security.js";
import { AIStore } from "./store.js";
import { archiveToTrash, makeTrashFile, type ArchiveEntry, type TrashFile } from "./archive.js";
import { ResearchService } from "./research/service.js";
import { renderResearchCatalogHtml } from "./research/catalog-html.js";
import { createExternalLookup, EXTERNAL_SOURCE_CAPABILITIES, type ExternalLookup } from "./research/external.js";
import { createNarrator, type Narrator } from "./research/synthesis/narrator.js";
import { DurableResearchPiExecutor, type ModelTierMap, type ResearchPiExecutionPlane } from "./research/pi-executor.js";
import { FreeformResearchExecutor } from "./research/freeform-executor.js";
import { NetworkSkillRunner } from "./research/network-skill-runner.js";

interface ServerOptions {
  dataDir?: string;
  databasePath?: string;
  config?: SidecarConfig;
  runtime?: Runtime;
  trashFile?: TrashFile;
  /** Inject a deterministic external-lookup so Deep Research tests stay offline. */
  researchExternalLookup?: ExternalLookup;
  /** Inject (or null out) the synthesis narrator so tests stay offline. Undefined
   *  builds the real, key-gated narrator; null forces deterministic synthesis. */
  researchNarrator?: Narrator | null;
  researchExecutionPlane?: ResearchPiExecutionPlane;
  /** Inject the free-form (unconstrained-but-jailed) plane; defaults to the real one. */
  researchFreeformPlane?: ResearchPiExecutionPlane;
}

const PUBLIC_DIR = path.join(import.meta.dirname, "..", "public");
const USER_ID = "local";
const SOURCES = ["uniprot", "reactome", "string", "pubmed"];
// Advertised skills now mirror the committed, executable skills under
// ai-sidecar/skills/ so "advertised" converges with what Pi actually discovers.
const ADVERTISED_SKILLS = [
  { id: "sf-runtime-probe", label: "Runtime Probe", execution: "bash" },
  { id: "sf-echo-script", label: "Echo Script", execution: "bash" },
  { id: "sf-python-compute", label: "Python Compute", execution: "python" },
  { id: "sf-artifact-report", label: "Artifact Report", execution: "python" },
];
const MODEL_SORTS = ["intelligence", "cost", "value"] as const;
type ModelSort = typeof MODEL_SORTS[number];
const TIER_NAMES = ["high", "medium", "low"] as const;
type TierName = typeof TIER_NAMES[number];
const modelKey = (value: string) => value.toLowerCase().replace(/^openrouter\//, "").replace(/[^a-z0-9]/g, "");

function canonicalModelId(value: string, catalog: { id: string; name: string }[]) {
  const exact = catalog.find((model) => model.id === value);
  if (exact) return exact.id;
  const key = modelKey(value);
  const matches = catalog.filter((model) => {
    const idKey = modelKey(model.id);
    const nameKey = modelKey(model.name);
    return idKey === key || nameKey === key || nameKey.endsWith(key);
  });
  return matches.length === 1 ? matches[0].id : undefined;
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const base = options.config || loadConfig();
  const config = { ...base, dataDir: options.dataDir || base.dataDir, databasePath: options.databasePath || base.databasePath };
  const app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024 });
  const store = new AIStore(config.databasePath);
  const runs = new FilesystemRunCatalog(config.dataDir);
  // Network-skill master toggle: the stored UI preference overrides the env
  // default (AI_RESEARCH_NETWORK_SKILLS_ENABLED). Read at runtime so flipping it
  // in the settings panel takes effect on the next job without a restart.
  const effectiveNetworkSkillsEnabled = () => {
    const pref = store.getPreference<boolean | null>(USER_ID, "research_network_skills_enabled", null);
    return pref === null || pref === undefined ? config.research.networkSkillsEnabled : Boolean(pref);
  };
  const researchExternalLookup = options.researchExternalLookup
    || (config.research.externalEnabled
      ? createExternalLookup({ timeoutMs: config.research.externalTimeoutMs, ttlMs: config.research.externalTtlHours * 3_600_000, ncbiApiKey: config.research.ncbiApiKey, maxRequestsPerSource: config.research.externalMaxRequestsPerSource, maxConcurrency: config.research.externalMaxConcurrency })
      : undefined);
  const models = new ModelCatalog(config);
  const keyResolver = (userId: string, provider: string) => {
    const encrypted = store.getCredential(userId, provider);
    if (encrypted && config.sessionSecret) {
      try { return decryptSecret(encrypted, config.sessionSecret); } catch { return undefined; }
    }
    return config.providerKeys[provider as "anthropic" | "openrouter"];
  };
  // The researcher's three model tiers + which one is the default. Stored as
  // plain preferences (validated against the catalog when saved), so these
  // runtime reads are cheap and don't re-query the provider catalog. The default
  // tier's model is the single source of truth for "the default model to use"
  // across Standard chat and Deep Research; we fall back to the first enabled
  // model, then the static configured default, only when no tier is set.
  const readModelTiers = (userId: string): { tiers: ModelTierMap; defaultTier: TierName | "" } => {
    const raw = store.getPreference<Record<string, unknown>>(userId, "model_tiers", {}) || {};
    const tiers: ModelTierMap = { high: String(raw.high || ""), medium: String(raw.medium || ""), low: String(raw.low || "") };
    const stored = String(store.getPreference<string>(userId, "default_tier", ""));
    const defaultTier: TierName | "" = (TIER_NAMES as readonly string[]).includes(stored) && tiers[stored as TierName]
      ? stored as TierName
      : (TIER_NAMES.find((tier) => tiers[tier]) || "");
    return { tiers, defaultTier };
  };
  const userModelDefaults = (userId: string) => {
    const { tiers, defaultTier } = readModelTiers(userId);
    const enabled = store.getPreference<string[]>(userId, "enabled_models", []).filter(Boolean);
    const defaultModel = (defaultTier && tiers[defaultTier]) || enabled[0] || config.defaultModel;
    return { tiers, defaultTier, defaultModel };
  };
  // Deep Research defaults to the MEDIUM tier (a balanced model for a long
  // agentic run), falling back to the global default tier, then the configured
  // model. This keeps the API fallback in lock-step with the UI's launch-form
  // default, so a cheap default tier never silently captures research jobs when
  // a caller omits `model`.
  const researchDefaultModel = (userId: string) => {
    const { tiers, defaultModel } = userModelDefaults(userId);
    return tiers.medium || defaultModel;
  };
  const research = new ResearchService(config.databasePath, runs, (input) => store.addArtifact(input), {
    externalLookup: researchExternalLookup,
    externalCostUsd: config.research.externalCostUsd,
    externalMaxLookups: config.research.externalMaxLookups,
    // Synthesis narrator: any provider key enables it; gated per job by the cost cap.
    narrator: options.researchNarrator !== undefined ? options.researchNarrator : createNarrator(models, keyResolver, config.defaultModel),
    executionPlane: options.researchExecutionPlane || new DurableResearchPiExecutor(models, keyResolver, config.defaultModel, config.research.thinkingLevel),
    freeformPlane: options.researchFreeformPlane || new FreeformResearchExecutor(models, keyResolver, config.defaultModel, config.research.freeformJail, {
      // Tier 1: the free-form agent corroborates against the curated adapters
      // itself (brokered out-of-band; the jail stays --network none).
      externalLookup: researchExternalLookup,
      externalEnabled: config.research.externalEnabled,
      externalCostUsd: config.research.externalCostUsd,
      externalMaxLookups: config.research.externalMaxLookups,
      // Network mode (default off): an approved reviewed network skill runs in a
      // per-job container behind the TLS-intercepting egress proxy. Resolver →
      // the UI toggle applies live.
      networkSkillsEnabled: effectiveNetworkSkillsEnabled,
      networkRunner: new NetworkSkillRunner({
        netImage: config.research.networkSkillImage,
        proxyImage: config.research.egressProxyImage,
        memory: config.research.freeformJail.memory,
        cpus: config.research.freeformJail.cpus,
        pids: config.research.freeformJail.pids,
        tmpfsSize: config.research.freeformJail.tmpfsSize,
        egressMaxRequests: config.research.egressMaxRequests,
        egressMaxResponseBytes: config.research.egressMaxResponseBytes,
        egressMaxRequestBytes: config.research.egressMaxRequestBytes,
        egressTimeoutMs: config.research.egressTimeoutMs,
      }),
    }),
    modelTiers: (userId) => readModelTiers(userId).tiers,
    networkSkillsEnabled: effectiveNetworkSkillsEnabled,
  });
  const runtime = options.runtime || new PiRuntime(config, runs, models, keyResolver, (input) => store.addArtifact(input));
  const activeTurnCancels = new Map<string, () => void>();
  const operationsEnabled = config.developerMode && config.operationsCenter;
  const trashFile = options.trashFile || makeTrashFile(path.join(config.dataDir, "_trashed_archives"));

  // Zip the given conversations (chat + Operations Control Center turns/events +
  // their artifacts) to the Trash, THEN hard-delete the live data. Archiving
  // runs first so a zip/move failure leaves everything intact. Shared by the
  // single-delete and bulk-delete routes.
  async function purgeConversationsToTrash(ids: string[]): Promise<{ deleted: string[]; missing: string[]; trashedPath: string | null }> {
    const seen = new Set<string>();
    const bundles: NonNullable<ReturnType<typeof store.gatherConversationExport>>[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const bundle = store.gatherConversationExport(id);
      if (bundle && bundle.conversation.userId === USER_ID) bundles.push(bundle);
    }
    if (!bundles.length) return { deleted: [], missing: ids, trashedPath: null };

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
    const archiveName = `signalfold-ai-conversations-${stamp}`;
    const manifest = {
      archivedAt: new Date().toISOString(),
      conversationCount: bundles.length,
      conversations: bundles.map((bundle) => ({
        id: bundle.conversation.id, runId: bundle.conversation.runId, title: bundle.conversation.title,
        messages: bundle.messages.length, operationTurns: bundle.operationTurns.length, artifacts: bundle.artifacts.length,
      })),
    };
    const entries: ArchiveEntry[] = [{ archivePath: "manifest.json", content: JSON.stringify(manifest, null, 2) }];
    for (const bundle of bundles) {
      const folder = bundle.conversation.id;
      entries.push({ archivePath: `${folder}/conversation.json`, content: JSON.stringify({ conversation: bundle.conversation, messages: bundle.messages, feedback: bundle.feedback }, null, 2) });
      entries.push({ archivePath: `${folder}/transcript.md`, content: conversationMarkdown(bundle.conversation, bundle.messages) });
      entries.push({ archivePath: `${folder}/operations/turns.json`, content: JSON.stringify(bundle.operationTurns, null, 2) });
      let aiRoot: string | null = null;
      try { aiRoot = runs.aiRoot(bundle.conversation.runId); } catch { aiRoot = null; }
      if (aiRoot) {
        for (const artifact of bundle.artifacts) {
          const absolute = path.resolve(aiRoot, artifact.relPath);
          if (absolute.startsWith(`${aiRoot}${path.sep}`) && fs.existsSync(absolute)) {
            entries.push({ archivePath: `${folder}/artifacts/${artifact.relPath}`, copyFrom: absolute });
          }
        }
      }
    }

    // Step 1 — archive to Trash. Throws on failure before anything is deleted.
    const { trashedPath } = await archiveToTrash(archiveName, entries, trashFile);

    // Step 2 — hard-delete each conversation's DB rows + on-disk files.
    const deleted: string[] = [];
    for (const bundle of bundles) {
      const { id, runId } = bundle.conversation;
      const result = store.purgeConversation(id);
      if (!result) continue;
      await runtime.reset(id).catch(() => undefined);
      try {
        const aiRoot = runs.aiRoot(runId);
        for (const rel of result.artifactRelPaths) {
          const absolute = path.resolve(aiRoot, rel);
          if (absolute.startsWith(`${aiRoot}${path.sep}`) && fs.existsSync(absolute)) fs.rmSync(absolute, { force: true });
        }
        const workDir = path.resolve(aiRoot, "work", id);
        if (workDir.startsWith(`${aiRoot}${path.sep}`) && fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // Run directory unavailable — DB rows are already removed, which is the contract.
      }
      deleted.push(id);
    }
    const deletedSet = new Set(deleted);
    return { deleted, missing: ids.filter((id) => !deletedSet.has(id)), trashedPath };
  }

  // Zip a set of Deep Research jobs (metadata + their on-disk package/artifacts)
  // to the Trash, THEN hard-delete them. Mirrors purgeConversationsToTrash:
  // archive first so a zip/move failure destroys nothing. Deleting a job's rows
  // also clears it from the Operations Control Center, which reads research live.
  async function purgeResearchJobsToTrash(ids: string[]): Promise<{ deleted: string[]; missing: string[]; trashedPath: string | null }> {
    const seen = new Set<string>();
    const jobs: NonNullable<ReturnType<typeof research.get>>[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const job = research.get(id);
      if (job && job.userId === USER_ID) jobs.push(job);
    }
    if (!jobs.length) return { deleted: [], missing: ids, trashedPath: null };

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
    const archiveName = `signalfold-ai-research-jobs-${stamp}`;
    const manifest = {
      archivedAt: new Date().toISOString(),
      jobCount: jobs.length,
      jobs: jobs.map((job) => ({ id: job.id, runId: job.runId, workflowId: job.workflowId, title: job.title, objective: job.objective, state: job.state, steps: job.steps.length, claims: job.claims.length })),
    };
    const entries: ArchiveEntry[] = [{ archivePath: "manifest.json", content: JSON.stringify(manifest, null, 2) }];
    for (const job of jobs) {
      const folder = job.id;
      entries.push({ archivePath: `${folder}/job.json`, content: JSON.stringify(job, null, 2) });
      for (const file of research.jobFiles(job.id)) entries.push({ archivePath: `${folder}/files/${file.archiveRel}`, copyFrom: file.absolute });
    }

    // Step 1 — archive to Trash. Throws on failure before anything is deleted.
    const { trashedPath } = await archiveToTrash(archiveName, entries, trashFile);

    // Step 2 — hard-delete each job's research rows (clears the OCC) + its on-disk
    // dir, then drop the run-scoped artifact index rows it registered.
    const deleted: string[] = [];
    for (const job of jobs) {
      const result = research.deleteJob(job.id);
      if (!result) continue;
      store.deleteResearchArtifacts(result.runId, job.id);
      deleted.push(job.id);
    }
    const deletedSet = new Set(deleted);
    return { deleted, missing: ids.filter((id) => !deletedSet.has(id)), trashedPath };
  }

  app.addHook("onClose", async () => { research.close(); store.close(); });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'");
    return payload;
  });

  app.get("/api/health", async () => ({ status: "ok", runtime: "single_pi_sidecar", node: process.versions.node, operationsCenter: operationsEnabled }));
  app.get("/api/config", async () => {
    const catalog = await models.list();
    const storedModels = store.getPreference<string[]>(USER_ID, "enabled_models", [config.defaultModel]).filter(Boolean);
    let enabledModels = [...new Set(storedModels.map((model) => canonicalModelId(model, catalog)).filter((model): model is string => Boolean(model)))];
    if (!enabledModels.length) {
      const fallback = canonicalModelId(config.defaultModel, catalog) || catalog[0]?.id;
      enabledModels = fallback ? [fallback] : [];
    }
    // Heal stale preferences written by older builds (for example a model's
    // display name instead of its canonical provider/model ID).
    if (JSON.stringify(enabledModels) !== JSON.stringify(storedModels)) {
      store.setPreference(USER_ID, "enabled_models", enabledModels);
    }
    const { tiers: modelTiers, defaultTier } = readModelTiers(USER_ID);
    const defaultModel = (defaultTier && modelTiers[defaultTier]) || enabledModels[0] || config.defaultModel;
    const visible = { ...publicConfig(config), defaultModel };
    const byok = new Set(store.credentialProviders(USER_ID));
    const modelSort = store.getPreference<ModelSort>(USER_ID, "model_sort", "intelligence");
    return { ...visible, enabledModels, modelTiers, defaultTier, modelSort: MODEL_SORTS.includes(modelSort) ? modelSort : "intelligence",
      // Reflect the live (preference-overridden) network-skill toggle, not just the env default.
      research: { ...visible.research, networkSkillsEnabled: effectiveNetworkSkillsEnabled() }, keyStatus: {
      anthropic: byok.has("anthropic") ? "encrypted-byok" : visible.keyStatus.anthropic,
      openrouter: byok.has("openrouter") ? "encrypted-byok" : visible.keyStatus.openrouter,
    } };
  });
  app.put<{ Body: { provider?: string; apiKey?: string } }>("/api/settings/credentials", async (request, reply) => {
    const provider = String(request.body?.provider || "");
    const key = String(request.body?.apiKey || "").trim();
    if (!config.sessionSecret) return reply.code(409).send({ detail: "Set SESSION_SECRET before saving encrypted BYOK credentials" });
    if (!["anthropic", "openrouter"].includes(provider) || key.length < 12) return reply.code(400).send({ detail: "A valid provider and API key are required" });
    store.setCredential(USER_ID, provider, encryptSecret(key, config.sessionSecret));
    return { ok: true, provider, status: "encrypted-byok" };
  });

  app.put<{ Body: { modelIds?: string[]; sortMode?: string } }>("/api/settings/models", async (request, reply) => {
    const requested = Array.isArray(request.body?.modelIds)
      ? [...new Set(request.body.modelIds.map(String).map((value) => value.trim()).filter(Boolean))]
      : [];
    if (!requested.length) return reply.code(400).send({ detail: "Keep at least one model in the conversation menu" });
    const catalog = await models.list();
    const available = new Set(catalog.map((model) => model.id));
    const invalid = requested.filter((model) => !available.has(model));
    if (invalid.length) return reply.code(400).send({ detail: `Unavailable or disallowed model: ${invalid[0]}` });
    const sortMode = MODEL_SORTS.includes(request.body?.sortMode as ModelSort) ? request.body.sortMode as ModelSort : "intelligence";
    store.setPreference(USER_ID, "enabled_models", requested);
    store.setPreference(USER_ID, "model_sort", sortMode);
    return { ok: true, enabledModels: requested, modelSort: sortMode };
  });

  // The default-model tiers: three catalog models tagged high/medium/low, and
  // which tier is THE default. The default tier's model is the model actually
  // used by Standard chat and Deep Research (see userModelDefaults). The full
  // set is threaded into the Pi agent environment for future task-aware
  // switching. A tier may be left blank, but the default tier must be assigned.
  app.put<{ Body: { tiers?: Record<string, unknown>; defaultTier?: string } }>("/api/settings/model-tiers", async (request, reply) => {
    const catalog = await models.list();
    const available = new Set(catalog.map((model) => model.id));
    const input = request.body?.tiers || {};
    const tiers: ModelTierMap = { high: "", medium: "", low: "" };
    for (const tier of TIER_NAMES) {
      const id = String(input[tier] || "").trim();
      if (id && !available.has(id)) return reply.code(400).send({ detail: `Unavailable or disallowed model for the ${tier} tier: ${id}` });
      tiers[tier] = id;
    }
    const defaultTier = String(request.body?.defaultTier || "");
    if (!(TIER_NAMES as readonly string[]).includes(defaultTier)) return reply.code(400).send({ detail: "Choose which tier (high, medium, or low) is the default" });
    if (!tiers[defaultTier as TierName]) return reply.code(400).send({ detail: `Assign a model to the ${defaultTier} tier before making it the default` });
    store.setPreference(USER_ID, "model_tiers", tiers);
    store.setPreference(USER_ID, "default_tier", defaultTier);
    return { ok: true, modelTiers: tiers, defaultTier, defaultModel: tiers[defaultTier as TierName] };
  });

  // Deep Research capability toggles (currently the network-skill master switch).
  // Stored as a preference that overrides the env default at runtime, so a network
  // skill can be enabled from the settings panel without restarting the sidecar.
  // Off → no plan can approve a network skill and the executor refuses to run one.
  app.put<{ Body: { networkSkillsEnabled?: boolean } }>("/api/settings/research", async (request, reply) => {
    if (typeof request.body?.networkSkillsEnabled !== "boolean") return reply.code(400).send({ detail: "networkSkillsEnabled (boolean) is required" });
    store.setPreference(USER_ID, "research_network_skills_enabled", request.body.networkSkillsEnabled);
    return { ok: true, networkSkillsEnabled: effectiveNetworkSkillsEnabled() };
  });

  app.get("/api/runs", async () => ({ runs: runs.list().map(({ path: _path, ...run }) => run) }));
  app.get<{ Params: { id: string } }>("/api/runs/:id/context", async (request, reply) => {
    if (!runs.get(request.params.id)) return reply.code(404).send({ detail: "Run not found" });
    return { runId: request.params.id, items: runs.context(request.params.id) };
  });
  app.get<{ Querystring: { refresh?: string } }>("/api/models", async (request) => ({
    models: await models.listWithBenchmarks(request.query.refresh === "1", keyResolver(USER_ID, "openrouter")),
    benchmark: {
      label: "Artificial Analysis Intelligence Index",
      source: "Artificial Analysis via OpenRouter",
      sourceUrl: "https://artificialanalysis.ai",
    },
  }));
  const executionEnabled = config.developerMode && config.pythonExecution !== "disabled";
  app.get("/api/skills", async () => ({ skills: ADVERTISED_SKILLS.map((skill) => ({ ...skill, enabled: executionEnabled })) }));

  // Durable Deep Research is a separate, plan-approved product path. These
  // endpoints never expose generic shell/web execution; the worker resolves
  // only repository-owned, offline skill manifests.
  app.get<{ Querystring: { runId?: string } }>("/api/research/workflows", async (request, reply) => {
    const runId = request.query.runId ? String(request.query.runId) : undefined;
    if (runId && !runs.get(runId)) return reply.code(404).send({ detail: "Run not found" });
    return { workflows: research.workflows(runId) };
  });
  app.post<{ Params: { id: string }; Body: { runId?: string; targetId?: string; lenses?: string[]; includeRecommendedFullFiles?: boolean; customQuestion?: string } }>("/api/research/workflows/:id/preview", async (request, reply) => {
    try {
      const runId = String(request.body?.runId || "");
      if (!runId) return reply.code(400).send({ detail: "runId is required" });
      return { preview: research.previewWorkflow(runId, request.params.id, request.body || {}) };
    } catch (error) { return reply.code(400).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  // Compose a card's short form into a free-form objective. Returns prompt text
  // only — the card is a launcher; the job is started via the free-form path.
  app.post<{ Params: { id: string }; Body: { runId?: string; values?: Record<string, unknown> } }>("/api/research/workflows/:id/compose", async (request, reply) => {
    try {
      const runId = String(request.body?.runId || "");
      if (!runId) return reply.code(400).send({ detail: "runId is required" });
      return { objective: research.composeLauncher(runId, request.params.id, request.body?.values || {}) };
    } catch (error) { return reply.code(400).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  // Live scope preview for the launch composer — same frozen-scope counts/preflight
  // a proposed plan would show, with no job created. Deterministic and free.
  app.post<{ Body: { runId?: string; workflowId?: string; objective?: string; pinned?: unknown; sources?: unknown; maxCostUsd?: number } }>("/api/research/scope-preview", async (request, reply) => {
    try {
      const runId = String(request.body?.runId || "");
      if (!runId) return reply.code(400).send({ detail: "runId is required" });
      return research.scopePreview({ runId, workflowId: String(request.body?.workflowId || "freeform"), objective: request.body?.objective, pinned: request.body?.pinned, sources: request.body?.sources, maxCostUsd: request.body?.maxCostUsd });
    } catch (error) { return reply.code(400).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  app.get("/api/research/skills", async () => ({ skills: research.skills() }));
  app.get("/api/research/external-capabilities", async () => ({ enabled: config.research.externalEnabled, sources: EXTERNAL_SOURCE_CAPABILITIES }));
  // Reusable plan templates (saved skeletons: steps + sources + cost cap). The
  // server is the authoritative gate — saveTemplate runs the same catalog
  // validation as a plan edit, so a bad skill/parameter is rejected here.
  app.get("/api/research/templates", async () => ({ templates: research.listTemplates(USER_ID) }));
  app.post<{ Body: { label?: string; workflowId?: string; steps?: unknown[]; sources?: unknown; maxCostUsd?: unknown } }>("/api/research/templates", async (request, reply) => {
    try {
      const template = research.saveTemplate({ userId: USER_ID, label: String(request.body?.label || ""), workflowId: String(request.body?.workflowId || ""), steps: Array.isArray(request.body?.steps) ? request.body.steps : [], sources: request.body?.sources, maxCostUsd: request.body?.maxCostUsd });
      return reply.code(201).send({ template });
    } catch (error) { return reply.code(400).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  app.delete<{ Params: { id: string } }>("/api/research/templates/:id", async (request, reply) => {
    if (!research.deleteTemplate(request.params.id, USER_ID)) return reply.code(404).send({ detail: "Template not found" });
    return { ok: true };
  });
  app.get<{ Querystring: { runId?: string } }>("/api/research/jobs", async (request, reply) => {
    const runId = String(request.query.runId || "");
    if (!runId) return reply.code(400).send({ detail: "runId is required" });
    return { jobs: research.list(runId, USER_ID) };
  });
  app.post<{ Body: { runId?: string; workflowId?: string; objective?: string; title?: string; model?: string; conversationId?: string; budgetUsd?: number } }>("/api/research/jobs", async (request, reply) => {
    try {
      const job = research.create({ runId: String(request.body?.runId || ""), userId: USER_ID, workflowId: String(request.body?.workflowId || ""), objective: String(request.body?.objective || ""), title: request.body?.title, model: request.body?.model || researchDefaultModel(USER_ID), conversationId: request.body?.conversationId, budgetUsd: request.body?.budgetUsd });
      return reply.code(201).send({ job });
    } catch (error) { return reply.code(400).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  app.get<{ Params: { id: string } }>("/api/research/jobs/:id", async (request, reply) => {
    const job = research.get(request.params.id);
    return job || reply.code(404).send({ detail: "Research job not found" });
  });
  app.post<{ Params: { id: string } }>("/api/research/jobs/:id/plan", async (request, reply) => {
    try { return { job: research.propose(request.params.id) }; } catch (error) { return reply.code(409).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/research/jobs/:id/plan", async (request, reply) => {
    try { return { job: research.updatePlan(request.params.id, request.body || {}) }; } catch (error) { return reply.code(409).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  app.post<{ Params: { id: string } }>("/api/research/jobs/:id/approve", async (request, reply) => {
    try { return { job: research.approve(request.params.id) }; } catch (error) { return reply.code(409).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  app.post<{ Params: { id: string }; Headers: { "idempotency-key"?: string } }>("/api/research/jobs/:id/run", async (request, reply) => {
    try { return reply.code(202).send({ job: research.queue(request.params.id, String(request.headers["idempotency-key"] || "")) }); } catch (error) { return reply.code(409).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  for (const action of ["pause", "resume", "stop"] as const) {
    app.post<{ Params: { id: string } }>(`/api/research/jobs/:id/${action}`, async (request, reply) => {
      try { return { job: research[action](request.params.id) }; } catch (error) { return reply.code(409).send({ detail: error instanceof Error ? error.message : String(error) }); }
    });
  }
  app.post<{ Params: { id: string }; Body: { model?: string } }>("/api/research/jobs/:id/rerun", async (request, reply) => {
    try { return reply.code(202).send({ job: research.rerun(request.params.id, String(request.body?.model || "") || userModelDefaults(USER_ID).defaultModel) }); } catch (error) { return reply.code(409).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  // In-thread re-run: reproduce the completed investigation on a chosen model and
  // thread the child run into this job's conversation (no separate top-level job).
  app.post<{ Params: { id: string }; Body: { model?: string } }>("/api/research/jobs/:id/rerun-thread", async (request, reply) => {
    try { return { conversation: await research.rerunInThread(request.params.id, String(request.body?.model || "") || userModelDefaults(USER_ID).defaultModel) }; }
    catch (error) { return reply.code(409).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  app.post<{ Params: { id: string } }>("/api/research/jobs/:id/retry-step", async (request, reply) => {
    try { return reply.code(202).send({ job: research.retryStep(request.params.id) }); } catch (error) { return reply.code(409).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  app.get<{ Params: { id: string } }>("/api/research/jobs/:id/conversation", async (request, reply) => {
    if (!research.get(request.params.id)) return reply.code(404).send({ detail: "Research job not found" });
    return { conversation: research.conversation(request.params.id) };
  });
  // The whole-run descriptive catalog + per-file usage (staged/read/cited/fetched)
  // for the MAIN UI. Same payload the OCC route serves, but un-gated so the
  // research thread can show users which run files an investigation actually used.
  app.get<{ Params: { id: string } }>("/api/research/jobs/:id/catalog", async (request, reply) => {
    if (!research.get(request.params.id)) return reply.code(404).send({ detail: "Research job not found" });
    const result = research.researchCatalog(request.params.id);
    return result || reply.code(404).send({ detail: "No frozen catalog for this job (older job, or not yet approved)" });
  });
  app.get<{ Params: { id: string } }>("/api/research/jobs/:id/catalog.html", async (request, reply) => {
    if (!research.get(request.params.id)) return reply.code(404).send({ detail: "Research job not found" });
    const result = research.researchCatalog(request.params.id);
    if (!result) return reply.code(404).send({ detail: "No frozen catalog for this job (older job, or not yet approved)" });
    return reply.type("text/html; charset=utf-8").send(renderResearchCatalogHtml(result));
  });
  app.post<{ Params: { id: string }; Body: { query?: string; parentMessageId?: string; requestedModel?: string; includes?: unknown; allowedSkills?: unknown; runtimePolicy?: string; sourcePolicy?: unknown; autoApprove?: boolean; budgetUsd?: number } }>("/api/research/jobs/:id/messages", async (request, reply) => {
    try { return { conversation: await research.addConversationMessage(request.params.id, request.body || {}) }; }
    catch (error) { return reply.code(409).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  // Arbiter: run one of the council roles over the completed model answers in this
  // thread (original report + in-thread re-runs). Requires >=2 distinct models.
  app.post<{ Params: { id: string }; Body: { role?: string; model?: string } }>("/api/research/jobs/:id/arbiter", async (request, reply) => {
    try { return { conversation: await research.arbiter(request.params.id, { role: request.body?.role, model: String(request.body?.model || "") || userModelDefaults(USER_ID).defaultModel }) }; }
    catch (error) { return reply.code(409).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  app.post<{ Params: { id: string } }>("/api/research/jobs/:id/followup-suggestion", async (request, reply) => {
    try { return { suggestion: await research.generateFollowupSuggestion(request.params.id) }; }
    catch (error) { return reply.code(409).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/research/jobs/:id/events", async (request, reply) => {
    if (!research.get(request.params.id)) return reply.code(404).send({ detail: "Research job not found" });
    const events = research.events(request.params.id, Number(request.query.after || 0));
    reply.type("text/event-stream").header("Cache-Control", "no-cache");
    return events.map((event) => `id: ${event.id}\nevent: ${event.name}\ndata: ${JSON.stringify(event)}\n\n`).join("") + ": reconnect-safe\n\n";
  });
  app.delete<{ Params: { id: string } }>("/api/research/jobs/:id", async (request, reply) => {
    const result = await purgeResearchJobsToTrash([request.params.id]);
    if (!result.deleted.length) return reply.code(404).send({ detail: "Research job not found" });
    return { ok: true, trashedPath: result.trashedPath };
  });
  app.post<{ Body: { ids?: string[] } }>("/api/research/jobs/bulk-delete", async (request, reply) => {
    const ids = Array.isArray(request.body?.ids) ? [...new Set(request.body.ids.map(String).filter(Boolean))] : [];
    if (!ids.length) return reply.code(400).send({ detail: "Provide one or more research job ids to delete" });
    const result = await purgeResearchJobsToTrash(ids);
    if (!result.deleted.length) return reply.code(404).send({ detail: "No matching research jobs found" });
    return result;
  });

  app.get<{ Querystring: { runId?: string } }>("/api/operations/summary", async (request, reply) => {
    if (!operationsEnabled) return reply.code(404).send({ detail: "Developer operations center is disabled" });
    const runId = request.query.runId ? String(request.query.runId) : undefined;
    const stats = store.operationSummary(runId);
    const diagnostics = runtime.diagnostics?.() || { implementation: runtime.constructor?.name || "Runtime", activeSessions: 0, sessions: [], registeredTools: [], skills: [] };
    const discoveredSkills = diagnostics.skills || [];
    const hasExecutionTool = diagnostics.registeredTools.some((name) => /python|bash|exec|skill/i.test(name));
    const warnings: string[] = [];
    if (config.pythonExecution !== "disabled" && !hasExecutionTool) warnings.push("Python execution is configured, but no execution tool is registered with Pi; scripts cannot run yet.");
    if (ADVERTISED_SKILLS.length && diagnostics.registeredTools.length === 0) warnings.push(`${ADVERTISED_SKILLS.length} skills are advertised by the API, but the Pi session currently has tools: []; advertised is not executable.`);
    return {
      enabled: true,
      stats,
      runtime: { ...diagnostics, activeTurns: activeTurnCancels.size },
      configuration: {
        developerMode: config.developerMode,
        pythonExecution: config.pythonExecution,
        pythonTrace: config.pythonTrace,
        retentionTurns: config.operationsRetentionTurns,
        turnTimeoutSeconds: config.turnTimeoutSeconds,
      },
      capabilities: {
        promptCapture: true,
        groundingManifest: true,
        piEventTrace: true,
        advertisedSkills: ADVERTISED_SKILLS,
        discoveredSkills,
        registeredTools: diagnostics.registeredTools,
        pythonExecutable: config.pythonExecution !== "disabled" && hasExecutionTool,
      },
      warnings,
    };
  });
  app.get<{ Querystring: { runId?: string; conversationId?: string; status?: string; limit?: string } }>("/api/operations/turns", async (request, reply) => {
    if (!operationsEnabled) return reply.code(404).send({ detail: "Developer operations center is disabled" });
    return { turns: store.listOperationTurns({
      runId: request.query.runId ? String(request.query.runId) : undefined,
      conversationId: request.query.conversationId ? String(request.query.conversationId) : undefined,
      status: request.query.status ? String(request.query.status) : undefined,
      limit: Number(request.query.limit || 100),
    }) };
  });
  app.get<{ Params: { id: string } }>("/api/operations/turns/:id", async (request, reply) => {
    if (!operationsEnabled) return reply.code(404).send({ detail: "Developer operations center is disabled" });
    const detail = store.getOperationTurn(request.params.id);
    return detail || reply.code(404).send({ detail: "Operational turn not found" });
  });
  // Durable Deep Research execution is recorded in its own tables, so the OCC
  // reads it through a dedicated surface (the chat operation-turns endpoints
  // above never see research skills/scripts).
  app.get<{ Querystring: { runId?: string } }>("/api/operations/research", async (request, reply) => {
    if (!operationsEnabled) return reply.code(404).send({ detail: "Developer operations center is disabled" });
    const runId = request.query.runId ? String(request.query.runId) : undefined;
    const jobs = research.operationsView(runId) as any[];
    // Resolve each step output to its registered artifact id so the OCC can fetch
    // /api/artifacts/:id/content for inline preview + download.
    const idsByRun = new Map<string, Map<string, string>>();
    const idFor = (jobRunId: string, relPath: string) => {
      if (!idsByRun.has(jobRunId)) idsByRun.set(jobRunId, new Map(store.listArtifacts(jobRunId).map((artifact) => [artifact.relPath, artifact.id])));
      return idsByRun.get(jobRunId)!.get(relPath) || null;
    };
    for (const job of jobs) {
      for (const step of job.steps || []) {
        if (!step.execution) continue;
        for (const output of step.execution.outputs || []) output.artifactId = idFor(job.runId, output.relPath);
      }
    }
    return { enabled: true, summary: research.operationsSummary(runId), jobs };
  });
  // Single research job in the same shape as the list endpoint's entries, so the
  // OCC raw/triage pointer can target one job (mirrors /api/operations/turns/:id).
  app.get<{ Params: { id: string } }>("/api/operations/research/:id", async (request, reply) => {
    if (!operationsEnabled) return reply.code(404).send({ detail: "Developer operations center is disabled" });
    const job = research.operationsJob(request.params.id) as any;
    if (!job) return reply.code(404).send({ detail: "Research job not found" });
    const ids = new Map(store.listArtifacts(job.runId).map((artifact) => [artifact.relPath, artifact.id]));
    for (const step of job.steps || []) {
      if (!step.execution) continue;
      for (const output of step.execution.outputs || []) output.artifactId = ids.get(output.relPath) || null;
    }
    return job;
  });
  // Lazy: the whole-run descriptive catalog frozen for this job (every file the
  // agent could see/fetch, with role/contents/derivation + staged-vs-fetch). Kept
  // off the job poll because it is large; the inspector fetches it on expand.
  app.get<{ Params: { id: string } }>("/api/operations/research/:id/catalog", async (request, reply) => {
    if (!operationsEnabled) return reply.code(404).send({ detail: "Developer operations center is disabled" });
    const result = research.researchCatalog(request.params.id);
    return result || reply.code(404).send({ detail: "No frozen catalog for this job (older job, or not yet approved)" });
  });

  app.post<{ Body: { runId?: string; title?: string; policy?: string; model?: string; defaultSources?: string[] } }>("/api/conversations", async (request, reply) => {
    const runId = String(request.body?.runId || "");
    if (!runs.get(runId)) return reply.code(404).send({ detail: "Select a completed run" });
    const policy = request.body?.policy === "deep-research" && config.deepResearchEnabled ? "deep-research" : "standard";
    const conversation = store.createConversation({ runId, userId: USER_ID, title: request.body?.title, policy, model: request.body?.model || userModelDefaults(USER_ID).defaultModel, defaultSources: sanitizeSources(request.body?.defaultSources) });
    return reply.code(201).send({ conversation });
  });
  app.get<{ Querystring: { runId?: string } }>("/api/conversations", async (request, reply) => {
    const runId = String(request.query.runId || "");
    if (!runId) return reply.code(400).send({ detail: "runId is required" });
    // "Run AI cost" spans two disjoint stores: Standard-chat turns (ai_messages,
    // via store.runCost) and Deep Research jobs (ai_research_jobs.spend_usd, via
    // research.operationsSummary). Surface the combined total plus the split so the
    // footer stops freezing whenever the user works only in one mode.
    const standardUsd = store.runCost(runId);
    const researchUsd = research.operationsSummary(runId).spendUsd;
    return {
      conversations: store.listConversations(runId, USER_ID),
      runCostUsd: standardUsd + researchUsd,
      runCostBreakdown: { standardUsd, researchUsd },
    };
  });
  // Live OpenRouter account spend, pulled with the configured .env key (no login).
  // The per-run tally above is a local estimate that misses deleted/aborted jobs and
  // price deltas; this is OpenRouter's authoritative account-wide number, for
  // reconciliation. Account-scoped (OpenRouter has no concept of a run), so it is NOT
  // folded into runCostUsd. Cached ~60s so a resync click cannot hammer upstream.
  let openRouterCredits: { at: number; data: unknown } | null = null;
  app.get<{ Querystring: { refresh?: string } }>("/api/cost/openrouter", async (request) => {
    const key = config.providerKeys.openrouter;
    if (!key) return { configured: false };
    if (request.query.refresh !== "1" && openRouterCredits && Date.now() - openRouterCredits.at < 60_000) return openRouterCredits.data;
    try {
      const response = await fetch("https://openrouter.ai/api/v1/credits", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`OpenRouter credits returned ${response.status}`);
      const payload = await response.json() as { data?: { total_credits?: number; total_usage?: number } };
      const totalCredits = Number(payload.data?.total_credits || 0);
      const totalUsage = Number(payload.data?.total_usage || 0);
      const data = { configured: true, totalUsage, totalCredits, remaining: totalCredits - totalUsage, fetchedAt: new Date().toISOString() };
      openRouterCredits = { at: Date.now(), data };
      return data;
    } catch (error) {
      return { configured: true, error: error instanceof Error ? error.message : "OpenRouter resync failed" };
    }
  });
  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation || conversation.userId !== USER_ID) return reply.code(404).send({ detail: "Conversation not found" });
    return { conversation, messages: store.listMessages(conversation.id), feedback: Object.fromEntries(store.listMessages(conversation.id).filter((message) => message.role === "assistant").map((message) => [message.id, store.listFeedback(message.id)])) };
  });
  app.patch<{ Params: { id: string }; Body: { title?: string; policy?: string; model?: string; defaultSources?: string[] } }>("/api/conversations/:id", async (request, reply) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation || conversation.userId !== USER_ID) return reply.code(404).send({ detail: "Conversation not found" });
    const policy = request.body?.policy === "deep-research" && config.deepResearchEnabled ? "deep-research" : request.body?.policy === "standard" ? "standard" : undefined;
    return { conversation: store.updateConversation(conversation.id, { ...request.body, policy, defaultSources: request.body?.defaultSources ? sanitizeSources(request.body.defaultSources) : undefined }) };
  });
  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const result = await purgeConversationsToTrash([request.params.id]);
    if (!result.deleted.length) return reply.code(404).send({ detail: "Conversation not found" });
    return { ok: true, trashedPath: result.trashedPath };
  });
  app.post<{ Body: { ids?: string[] } }>("/api/conversations/bulk-delete", async (request, reply) => {
    const ids = Array.isArray(request.body?.ids) ? [...new Set(request.body.ids.map(String).filter(Boolean))] : [];
    if (!ids.length) return reply.code(400).send({ detail: "Provide one or more conversation ids to delete" });
    const result = await purgeConversationsToTrash(ids);
    if (!result.deleted.length) return reply.code(404).send({ detail: "No matching conversations found" });
    return result;
  });
  app.post<{ Params: { id: string } }>("/api/conversations/:id/clear", async (request, reply) => {
    if (!store.getConversation(request.params.id)) return reply.code(404).send({ detail: "Conversation not found" });
    await runtime.reset(request.params.id); store.clearConversation(request.params.id); return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/conversations/:id/abort", async (request) => {
    activeTurnCancels.get(request.params.id)?.();
    // Cancellation of the SSE response is synchronous above. Runtime cleanup
    // is deliberately detached so a reluctant provider cannot hang Stop.
    void runtime.abort(request.params.id).catch(() => undefined);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { message?: string; model?: string; policy?: string; sources?: string[]; attachmentIds?: string[]; mentions?: Array<{ scope?: string; path?: string }> } }>("/api/conversations/:id/turns", async (request, reply) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation || conversation.userId !== USER_ID) return reply.code(404).send({ detail: "Conversation not found" });
    const message = String(request.body?.message || "").trim();
    if (!message) return reply.code(400).send({ detail: "message is required" });
    const model = String(request.body?.model || conversation.model || userModelDefaults(USER_ID).defaultModel);
    if (!model) return reply.code(400).send({ detail: "Select a model before sending" });
    if (activeTurnCancels.has(conversation.id)) return reply.code(409).send({ detail: "This conversation is already streaming a response" });
    const policy = request.body?.policy === "deep-research" && config.deepResearchEnabled ? "deep-research" : conversation.policy;
    const requestedSources = sanitizeSources(request.body?.sources);
    const effectiveSources = request.body?.sources ? requestedSources : conversation.defaultSources;
    const attachmentText = readAttachmentContext(runs, store, conversation.runId, request.body?.attachmentIds);
    const mentions = Array.isArray(request.body?.mentions) ? request.body.mentions : [];
    const mentionResolved = readMentionContext(runs, store, conversation.runId, mentions);
    const inspected = inspectPrompt(message);
    const operationTurn = operationsEnabled ? store.startOperationTurn({
      runId: conversation.runId, conversationId: conversation.id, userId: USER_ID, model, policy, questionPreview: message,
    }, config.operationsRetentionTurns) : null;
    const op = (category: string, name: string, status = "info", payload: Record<string, unknown> = {}, durationMs?: number) => {
      if (!operationTurn) return;
      const scrubbed = scrubOperationalValue(payload) as Record<string, unknown>;
      if (name === "prompt_composed" && typeof payload.prompt === "string") {
        scrubbed.capturedCharacters = typeof scrubbed.prompt === "string" ? scrubbed.prompt.length : 0;
        scrubbed.captureTruncated = payload.prompt.length > 200_000;
      }
      store.appendOperationEvent(operationTurn.id, {
        category, name, status, durationMs,
        payload: scrubbed,
      });
    };
    op("lifecycle", "turn_received", "running", {
      runId: conversation.runId, conversationId: conversation.id, model, policy,
      requestedSources, effectiveSources, attachmentCount: Array.isArray(request.body?.attachmentIds) ? request.body.attachmentIds.length : 0,
      mentionCount: mentionResolved.count, mentions: mentionResolved.labels,
    });
    const userRecord = store.addMessage(conversation.id, "user", message, { requestedSources, effectiveSources, model });
    op("persistence", "user_message_saved", "complete", { messageId: userRecord.id, characters: message.length });
    if (conversation.title === "New research chat") store.updateConversation(conversation.id, { title: message.slice(0, 72) });
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const write = (frame: RuntimeFrame | Record<string, unknown>) => { if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(frame)}\n\n`); };
    if (!inspected.allowed) {
      const refused = store.addMessage(conversation.id, "assistant", inspected.message, { status: "blocked", model });
      op("security", "prompt_blocked", "blocked", { reason: inspected.message });
      op("persistence", "assistant_message_saved", "complete", { messageId: refused.id, status: "blocked" });
      if (operationTurn) store.finishOperationTurn(operationTurn.id, { status: "blocked", assistantMessageId: refused.id, errorMessage: inspected.message });
      write({ type: "message_start", role: "assistant", messageId: refused.id }); write({ type: "text_delta", delta: inspected.message }); write({ type: "done" }); reply.raw.end(); return;
    }
    op("security", "prompt_allowed", "complete", { checks: ["prompt-extraction"] });
    let content = "";
    let failureMessage = "";
    const trace: { label: string; text: string }[] = [];
    let usage = { provider: model.startsWith("openrouter/") ? "openrouter" : "anthropic", model, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    let status = "complete";
    let textDeltaCount = 0;
    let textCharacters = 0;
    let thinkingDeltaCount = 0;
    let groundingFiles = 0;
    let groundingBytes = 0;
    let groundingCitations: Record<string, unknown>[] = [];
    let groundingProvenance: Record<string, unknown>[] = [];
    let promptCharacters = 0;
    let cancelTurn: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelTurn = () => reject(new Error("Response stopped by the user."));
    });
    activeTurnCancels.set(conversation.id, cancelTurn);
    try {
      const history = store.listMessages(conversation.id).slice(0, -1).map((item) => ({ role: item.role, content: item.content, pinned: item.pinned }));
      const frames = runtime.turn({ conversationId: conversation.id, userId: USER_ID, runId: conversation.runId, message: message + attachmentText + mentionResolved.text, model, policy, sources: effectiveSources, history });
      for await (const frame of withTurnTimeout(frames, config.turnTimeoutSeconds, () => runtime.abort(conversation.id), cancelled)) {
        if (frame.type === "operation") {
          const payload = frame.event.payload || {};
          op(frame.event.category, frame.event.name, frame.event.status || "info", payload, frame.event.durationMs);
          if (frame.event.name === "grounding_selected") {
            groundingFiles = Array.isArray(payload.files) ? payload.files.length : 0;
            groundingBytes = Number(payload.includedBytes || 0);
            groundingCitations = Array.isArray(payload.citations) ? payload.citations as Record<string, unknown>[] : [];
            const mappedFiles = Array.isArray(payload.files) ? (payload.files as Record<string, unknown>[]).map((file) => ({
              kind: "run-artifact", route: payload.route, intent: payload.intent, path: file.path, family: file.family, score: file.score,
              rowsReturned: file.rowsReturned, truncated: file.truncated, reason: file.reason,
            })) : [];
            // Even when no run files are retrieved (e.g. a general/definitional
            // question answered from the run card alone), record the grounding
            // mode so the conversation UI can distinguish it from legacy turns.
            groundingProvenance = mappedFiles.length ? mappedFiles : [{ kind: "run-card", route: payload.route, intent: payload.intent }];
          }
          if (frame.event.name === "prompt_composed") promptCharacters = Number(payload.characters || 0);
          if (operationTurn) store.setOperationPromptMetrics(operationTurn.id, promptCharacters, groundingFiles, groundingBytes);
          continue;
        }
        if (frame.type === "text_delta") { content += frame.delta; textDeltaCount += 1; textCharacters += frame.delta.length; }
        if (frame.type === "thinking_delta") { appendTrace(trace, "Reasoning", frame.delta); thinkingDeltaCount += 1; }
        if (["tool_start", "skill_start", "python_start"].includes(frame.type)) appendTrace(trace, "Tool", `${String((frame as { toolName?: unknown }).toolName || frame.type.replace(/_start$/, "")).toString()} started`);
        // PiRuntime records each tool call as a categorized operation event
        // (handled above), so only categorized frames (emitted by runtimes that
        // signal execution via frames, e.g. test fakes) are recorded here —
        // generic tool_start/tool_end frames would otherwise double-count.
        if (["skill_start", "skill_end", "python_start", "python_end"].includes(frame.type)) {
          const category = frame.type.startsWith("python") ? "python" : "skill";
          op(category, `runtime_${frame.type}`, frame.type.endsWith("end") ? ((frame as any).isError ? "failed" : "complete") : "running", frame as unknown as Record<string, unknown>);
        }
        if (frame.type === "message_start") op("message", "assistant_stream_started", "running", { role: frame.role });
        if (frame.type === "usage") {
          usage = frame;
          if (operationTurn) store.setOperationUsage(operationTurn.id, frame.inputTokens, frame.outputTokens, frame.costUsd);
          op("usage", "usage_reported", "complete", frame as unknown as Record<string, unknown>);
        }
        if (frame.type === "error") { status = "failed"; failureMessage = frame.message; op("runtime", "runtime_error", "failed", { kind: frame.kind, message: frame.message }); }
        if (frame.type !== "done") write(frame as RuntimeFrame & Record<string, unknown>);
      }
      op("message", "sse_stream_summary", "complete", { textDeltaCount, textCharacters, thinkingDeltaCount });
    } catch (error) {
      status = "failed";
      failureMessage = scrubOutput((error as Error).message);
      op("runtime", "turn_exception", "failed", { message: failureMessage });
      write({ type: "error", message: failureMessage, kind: "runtime" });
    } finally {
      if (activeTurnCancels.get(conversation.id) === cancelTurn) activeTurnCancels.delete(conversation.id);
    }
    if (status === "complete" && !content.trim()) {
      status = "failed";
      failureMessage = "The model returned no answer text. Retry the turn or choose another model.";
    }
    if (status === "failed" && !content.trim()) content = `Response failed: ${failureMessage || "The model did not return an answer."}`;
    const assistant = store.addMessage(conversation.id, "assistant", content, {
      status, ...usage, requestedSources, effectiveSources, trace,
      citations: groundingCitations,
      provenance: [...groundingProvenance, ...effectiveSources.map((source) => ({ kind: "external-allowed", source }))],
    });
    op("persistence", "assistant_message_saved", "complete", { messageId: assistant.id, status, characters: content.length });
    op("lifecycle", "turn_finished", status === "complete" ? "complete" : "failed", { status, assistantMessageId: assistant.id });
    if (operationTurn) store.finishOperationTurn(operationTurn.id, { status, assistantMessageId: assistant.id, errorMessage: failureMessage });
    if (!conversation.model) store.updateConversation(conversation.id, { model });
    write({ type: "message_saved", messageId: assistant.id }); write({ type: "done" }); reply.raw.end();
  });

  app.post<{ Body: { runId?: string; conversationId?: string; name?: string; mimeType?: string; dataBase64?: string } }>("/api/attachments", async (request, reply) => {
    const { runId = "", conversationId = "", name = "", mimeType = "application/octet-stream", dataBase64 = "" } = request.body || {};
    if (!runs.get(runId) || !store.getConversation(conversationId)) return reply.code(404).send({ detail: "Run or conversation not found" });
    const safeName = path.basename(name).replace(/[^A-Za-z0-9._-]/g, "_");
    if (!/\.(csv|tsv|txt|json|md|pdf|png|jpe?g)$/i.test(safeName)) return reply.code(400).send({ detail: "Unsupported attachment type" });
    const bytes = Buffer.from(dataBase64, "base64");
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) return reply.code(400).send({ detail: "Attachment must be between 1 byte and 10 MB" });
    const relPath = `artifacts/uploads/${crypto.randomUUID()}-${safeName}`;
    const absolute = path.join(runs.aiRoot(runId), relPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, bytes, { mode: 0o600 });
    const artifact = store.addArtifact({ runId, conversationId, kind: "attachment", relPath, mimeType, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
    return reply.code(201).send({ artifact });
  });

  app.post<{ Params: { messageId: string }; Body: { rating?: number | null; note?: string } }>("/api/messages/:messageId/feedback", async (request, reply) => {
    const feedback = store.addFeedback(request.params.messageId, USER_ID, request.body?.rating ?? null, String(request.body?.note || "").slice(0, 5000));
    const message = store.getMessage(request.params.messageId);
    if (message) appendNote(runs, store, message, feedback);
    return reply.code(201).send({ feedback });
  });
  app.post<{ Params: { messageId: string }; Body: { pinned?: boolean } }>("/api/messages/:messageId/pin", async (request, reply) => {
    if (!store.setPinned(request.params.messageId, Boolean(request.body?.pinned))) return reply.code(404).send({ detail: "Assistant message not found" });
    return { ok: true, pinned: Boolean(request.body?.pinned) };
  });

  app.get<{ Querystring: { runId?: string } }>("/api/artifacts", async (request, reply) => {
    const runId = String(request.query.runId || "");
    if (!runs.get(runId)) return reply.code(404).send({ detail: "Run not found" });
    return { artifacts: store.listArtifacts(runId) };
  });
  app.get<{ Params: { id: string } }>("/api/artifacts/:id/content", async (request, reply) => {
    const artifact = runs.list().flatMap((run) => store.listArtifacts(run.id)).find((item) => item.id === request.params.id);
    if (!artifact) return reply.code(404).send({ detail: "Artifact not found" });
    const absolute = path.resolve(runs.aiRoot(artifact.runId), artifact.relPath);
    const root = runs.aiRoot(artifact.runId);
    if (!absolute.startsWith(`${root}${path.sep}`) || !fs.existsSync(absolute)) return reply.code(404).send({ detail: "Artifact file not found" });
    return reply.type(artifact.mimeType || "application/octet-stream").send(fs.createReadStream(absolute));
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/export", async (request, reply) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation) return reply.code(404).send({ detail: "Conversation not found" });
    const body = conversationMarkdown(conversation, store.listMessages(conversation.id));
    return reply.type("text/markdown").header("Content-Disposition", `attachment; filename=ai-insights-${conversation.id}.md`).send(body);
  });

  if (operationsEnabled) {
    for (const [route, file, type] of [["/operations", "operations.html", "text/html"], ["/operations.js", "operations.js", "text/javascript"], ["/operations.css", "operations.css", "text/css"]] as const) {
      app.get(route, async (_request, reply) => reply.type(type).send(fs.createReadStream(path.join(PUBLIC_DIR, file))));
    }
  }
  for (const [route, file, type] of [["/", "index.html", "text/html"], ["/app.js", "app.js", "text/javascript"], ["/bootstrap.js", "bootstrap.js", "text/javascript"], ["/styles.css", "styles.css", "text/css"]] as const) {
    app.get(route, async (_request, reply) => reply.header("Cache-Control", "no-cache").type(type).send(fs.createReadStream(path.join(PUBLIC_DIR, file))));
  }
  return app;
}

async function* withTurnTimeout(
  frames: AsyncGenerator<RuntimeFrame>,
  timeoutSeconds: number,
  abort: () => Promise<void>,
  cancelled: Promise<never> = new Promise(() => undefined),
) {
  const iterator = frames[Symbol.asyncIterator]();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`The model did not respond within ${timeoutSeconds} seconds. The turn was stopped; you can retry or choose another model.`)), timeoutSeconds * 1000);
  });
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), timeout, cancelled]);
      if (next.done) return;
      yield next.value;
    }
  } catch (error) {
    void abort().catch(() => undefined);
    void iterator.return?.(undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sanitizeSources(value: unknown): string[] { return Array.isArray(value) ? value.map(String).filter((source) => SOURCES.includes(source)) : []; }
function conversationMarkdown(conversation: { title: string; runId: string; policy: string }, messages: any[]): string {
  return [`# ${conversation.title}`, `Run: ${conversation.runId}`, `Policy: ${conversation.policy}`, "", ...messages.map((message) => {
    const citations = message.citations.length ? `\nCitations:\n${message.citations.map((citation: any) => `- ${citation.filePath || citation.path || "run artifact"}${Array.isArray(citation.rowIds) && citation.rowIds.length ? ` (rows ${citation.rowIds.join(", ")})` : ""}`).join("\n")}\n` : "";
    const provenance = message.provenance.length ? `\nProvenance: \`${JSON.stringify(message.provenance)}\`\n` : "";
    return `## ${message.role === "user" ? "Researcher" : "AI Insights"}\n\n${message.content}\n${citations}${provenance}\n_Model: ${message.model || "n/a"}; cost: $${Number(message.costUsd).toFixed(6)}_\n`;
  })].join("\n");
}
function appendTrace(trace: { label: string; text: string }[], label: string, text: string) {
  const last = trace.at(-1);
  if (last?.label === label) last.text += text;
  else trace.push({ label, text });
}
function appendNote(runs: FilesystemRunCatalog, store: AIStore, message: any, feedback: any) {
  const aiRoot = runs.aiRoot(message.runId);
  const relPath = "artifacts/notes.md";
  const absolute = path.join(aiRoot, relPath);
  const entry = `\n## ${feedback.createdAt} — revision ${feedback.revision}\n\n- Message: ${message.id}\n- Rating: ${feedback.rating ?? "none"}\n- Answer hash: ${Buffer.from(message.content).toString("base64url").slice(0, 32)}\n\n${feedback.note || "No written note."}\n`;
  fs.appendFileSync(absolute, entry, { encoding: "utf8", mode: 0o600 });
  if (!store.listArtifacts(message.runId).some((artifact) => artifact.relPath === relPath)) store.addArtifact({ runId: message.runId, messageId: message.id, kind: "notes", relPath, mimeType: "text/markdown" });
}

// Resolve @-mentions (@context/file, @myfiles/file, @artifacts/file) into
// untrusted-wrapped context appended to a Standard turn. Paths are validated
// against an allowlist of this run's real files + registered artifacts so a
// mention can never read an arbitrary host file.
function readMentionContext(runs: FilesystemRunCatalog, store: AIStore, runId: string, mentions: Array<{ scope?: string; path?: string }>) {
  const empty = { count: 0, labels: [] as string[], text: "" };
  if (!Array.isArray(mentions) || !mentions.length) return empty;
  const run = runs.get(runId);
  if (!run) return empty;
  const root = run.path;
  const allowed = new Set<string>(runs.context(runId).map((item) => item.path));
  for (const artifact of store.listArtifacts(runId)) allowed.add(`ai_insights/${artifact.relPath}`.replaceAll("\\", "/"));
  const seen = new Set<string>();
  const labels: string[] = [];
  const parts: string[] = [];
  for (const mention of mentions.slice(0, 12)) {
    const rel = String(mention?.path || "").replaceAll("\\", "/").replace(/^\/+/, "");
    if (!rel || seen.has(rel) || !allowed.has(rel)) continue;
    const absolute = path.resolve(root, rel);
    if (!absolute.startsWith(`${root}${path.sep}`) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    seen.add(rel);
    const scope = ["context", "myfiles", "artifacts"].includes(String(mention.scope)) ? String(mention.scope) : "file";
    const label = `@${scope}/${path.basename(rel)}`;
    labels.push(label);
    if (!/\.(csv|tsv|txt|json|md)$/i.test(rel)) { parts.push(`\n<untrusted_attachment name=${JSON.stringify(label)}>Binary file referenced via @-mention; available as a run file, contents not inlined.</untrusted_attachment>`); continue; }
    parts.push(wrapUntrustedAttachment(label, fs.readFileSync(absolute, "utf8").slice(0, 60_000)));
  }
  return { count: labels.length, labels, text: parts.join("\n") };
}

function readAttachmentContext(runs: FilesystemRunCatalog, store: AIStore, runId: string, ids: unknown) {
  if (!Array.isArray(ids) || !ids.length) return "";
  const root = runs.aiRoot(runId);
  const selected = store.listArtifacts(runId).filter((artifact) => ids.includes(artifact.id) && artifact.kind === "attachment");
  return selected.map((artifact) => {
    if (!/\.(csv|tsv|txt|json|md)$/i.test(artifact.relPath)) return `\n<untrusted_attachment name=${JSON.stringify(path.basename(artifact.relPath))}>Binary attachment available as a run artifact; do not infer unseen contents.</untrusted_attachment>`;
    const absolute = path.resolve(root, artifact.relPath);
    if (!absolute.startsWith(`${root}${path.sep}`)) return "";
    return wrapUntrustedAttachment(path.basename(artifact.relPath), fs.readFileSync(absolute, "utf8").slice(0, 100_000));
  }).join("\n");
}
