import fs from "node:fs";
import path from "node:path";

export type PolicyName = "standard" | "deep-research";
export type PythonExecution = "developer-local" | "isolated" | "disabled";
/** Pi thinking effort for the durable research execution plane. Lower = faster
 * per turn. The plane's steps are mechanical (activate an approved skill, call
 * the named tool), so "low" keeps the model fully in the loop with less latency
 * than the SDK's default of "medium". Override via AI_RESEARCH_THINKING_LEVEL. */
export type ResearchThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface SidecarConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  defaultPolicy: PolicyName;
  deepResearchEnabled: boolean;
  developerMode: boolean;
  operationsCenter: boolean;
  operationsRetentionTurns: number;
  modelPicker: boolean;
  defaultModel: string;
  allowedModels: string[];
  externalSourcesDefault: string[];
  pythonExecution: PythonExecution;
  pythonTrace: boolean;
  sessionSecret: string;
  providerKeys: { anthropic?: string; openrouter?: string };
  catalogTtlHours: number;
  turnTimeoutSeconds: number;
  research: {
    externalEnabled: boolean;
    externalTimeoutMs: number;
    externalTtlHours: number;
    externalCostUsd: number;
    externalMaxLookups: number;
    externalMaxRequestsPerSource: number;
    externalMaxConcurrency: number;
    defaultBudgetUsd: number;
    thinkingLevel: ResearchThinkingLevel;
    ncbiApiKey?: string;
    /** Per-job Docker sandbox for the free-form agent's run_python cells. The
     * agent writes arbitrary code, so its only filesystem is a container with
     * inputs/ (ro) + outputs/ (rw) bind-mounted and --network none — confining
     * by construction rather than by convention. */
    freeformJail: {
      image: string;
      memory: string;
      cpus: string;
      pids: number;
      tmpfsSize: string;
      cellTimeoutMs: number;
    };
    /** Network-mode (approved-external) skills: run a REVIEWED network skill in a
     *  per-job container behind a per-job TLS-intercepting egress proxy on an
     *  --internal bridge. run_python and offline skills stay sealed. Default OFF;
     *  enabling it still requires the job to approve specific networkSkills. */
    networkSkillsEnabled: boolean;
    networkSkillImage: string;
    egressProxyImage: string;
    egressMaxRequests: number;
    egressMaxResponseBytes: number;
    egressMaxRequestBytes: number;
    egressTimeoutMs: number;
  };
}

const truthy = (value: string | undefined, fallback: boolean) =>
  value === undefined ? fallback : !["0", "false", "off", "no"].includes(value.toLowerCase());
const csv = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

/** Load the sidecar-local .env without allowing an inherited blank value to
 * mask a real local setting. Non-empty process values still take precedence. */
export function loadLocalEnvFile(filename: string, env: NodeJS.ProcessEnv = process.env) {
  if (!fs.existsSync(filename)) return env;
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!(env[key] || "").trim()) env[key] = rawValue.trim();
  }
  return env;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SidecarConfig {
  const dataDir = path.resolve(env.SIGNALFOLD_DATA_DIR || path.join(import.meta.dirname, "..", "..", "data"));
  const policy = env.PI_RUNTIME_DEFAULT_POLICY === "deep-research" ? "deep-research" : "standard";
  const execution = ["developer-local", "isolated", "disabled"].includes(env.AI_PYTHON_EXECUTION ?? "")
    ? env.AI_PYTHON_EXECUTION as PythonExecution
    : "developer-local";
  return {
    host: env.PI_RUNTIME_HOST || "127.0.0.1",
    port: Number(env.PI_RUNTIME_PORT || 4317),
    dataDir,
    databasePath: path.resolve(env.AI_INSIGHTS_DATABASE || path.join(dataDir, "ai_insights.sqlite")),
    defaultPolicy: policy,
    deepResearchEnabled: truthy(env.AI_DEEP_RESEARCH_ENABLED, true),
    developerMode: truthy(env.AI_DEVELOPER_MODE, true),
    operationsCenter: truthy(env.AI_OPERATIONS_CENTER, truthy(env.AI_DEVELOPER_MODE, true)),
    operationsRetentionTurns: Math.max(10, Math.floor(Number(env.AI_OPERATIONS_RETENTION_TURNS || 100) || 100)),
    modelPicker: truthy(env.AI_DEV_MODEL_PICKER, true),
    defaultModel: env.AI_DEV_OPENROUTER_MODEL || "openrouter/minimax/minimax-m3",
    allowedModels: csv(env.AI_DEV_ALLOWED_MODELS),
    externalSourcesDefault: csv(env.AI_EXTERNAL_SOURCES_DEFAULT),
    pythonExecution: execution,
    pythonTrace: truthy(env.AI_PYTHON_TRACE, true),
    sessionSecret: env.SESSION_SECRET || "",
    providerKeys: {
      anthropic: env.ANTHROPIC_API_KEY || undefined,
      openrouter: env.OPENROUTER_API_KEY || undefined,
    },
    catalogTtlHours: Math.max(1, Number(env.AI_OPENROUTER_CATALOG_TTL_HOURS || 24)),
    turnTimeoutSeconds: Math.max(0.05, Number(env.AI_PI_TURN_TIMEOUT_SECONDS || 180)),
    research: {
      externalEnabled: truthy(env.AI_RESEARCH_EXTERNAL_ENABLED, true),
      externalTimeoutMs: Math.max(500, Number(env.AI_RESEARCH_EXTERNAL_TIMEOUT_MS || 6000)),
      externalTtlHours: Math.max(0, Number(env.AI_RESEARCH_EXTERNAL_TTL_HOURS || 6)),
      externalCostUsd: Math.max(0, Number(env.AI_RESEARCH_EXTERNAL_COST_USD ?? 0.01)),
      // Ceiling, not a target: a multi-protein investigation needs several lookups per
      // protein (identity + interactions + pathways + literature), so 12 truncated real
      // work mid-investigation. The per-job budget (defaultBudgetUsd / externalCostUsd ≈ 50)
      // and the per-source cap (60) are the real governors; this just stops the global count
      // from binding first. Raise AI_RESEARCH_DEFAULT_BUDGET_USD too for a true 100.
      externalMaxLookups: Math.max(1, Math.floor(Number(env.AI_RESEARCH_EXTERNAL_MAX_LOOKUPS || 100))),
      externalMaxRequestsPerSource: Math.max(1, Math.floor(Number(env.AI_RESEARCH_EXTERNAL_MAX_REQUESTS_PER_SOURCE || 60))),
      externalMaxConcurrency: Math.max(1, Math.floor(Number(env.AI_RESEARCH_EXTERNAL_MAX_CONCURRENCY || 3))),
      defaultBudgetUsd: Math.max(0, Number(env.AI_RESEARCH_DEFAULT_BUDGET_USD ?? 0.5)),
      thinkingLevel: (["minimal", "low", "medium", "high", "xhigh"].includes(env.AI_RESEARCH_THINKING_LEVEL ?? "")
        ? env.AI_RESEARCH_THINKING_LEVEL
        : "low") as ResearchThinkingLevel,
      ncbiApiKey: env.NCBI_API_KEY || undefined,
      freeformJail: {
        image: env.FREEFORM_JAIL_IMAGE || "signalfold-freeform-jail:1.1",
        memory: env.FREEFORM_JAIL_MEMORY || "2g",
        cpus: env.FREEFORM_JAIL_CPUS || "2",
        pids: Math.max(16, Math.floor(Number(env.FREEFORM_JAIL_PIDS || 256) || 256)),
        tmpfsSize: env.FREEFORM_JAIL_TMPFS || "512m",
        cellTimeoutMs: Math.max(1000, Number(env.FREEFORM_JAIL_CELL_TIMEOUT_MS || 60000) || 60000),
      },
      networkSkillsEnabled: truthy(env.AI_RESEARCH_NETWORK_SKILLS_ENABLED, false),
      networkSkillImage: env.FREEFORM_NET_IMAGE || "signalfold-freeform-net:1.0",
      egressProxyImage: env.EGRESS_PROXY_IMAGE || "signalfold-egress-proxy:1.0",
      egressMaxRequests: Math.max(1, Math.floor(Number(env.AI_RESEARCH_EGRESS_MAX_REQUESTS || 40))),
      egressMaxResponseBytes: Math.max(1024, Math.floor(Number(env.AI_RESEARCH_EGRESS_MAX_RESPONSE_BYTES || 8 * 1024 * 1024))),
      egressMaxRequestBytes: Math.max(256, Math.floor(Number(env.AI_RESEARCH_EGRESS_MAX_REQUEST_BYTES || 64 * 1024))),
      egressTimeoutMs: Math.max(1000, Math.floor(Number(env.AI_RESEARCH_EGRESS_TIMEOUT_MS || 15000))),
    },
  };
}

export function publicConfig(config: SidecarConfig) {
  return {
    defaultPolicy: config.defaultPolicy,
    deepResearchEnabled: config.deepResearchEnabled,
    developerMode: config.developerMode,
    operationsCenter: config.developerMode && config.operationsCenter,
    operationsRetentionTurns: config.operationsRetentionTurns,
    modelPicker: config.modelPicker,
    defaultModel: config.defaultModel,
    allowedModels: config.allowedModels,
    externalSourcesDefault: config.externalSourcesDefault,
    pythonExecution: config.pythonExecution,
    turnTimeoutSeconds: config.turnTimeoutSeconds,
    research: {
      externalEnabled: config.research.externalEnabled,
      externalCostUsd: config.research.externalCostUsd,
      externalMaxLookups: config.research.externalMaxLookups,
      externalMaxRequestsPerSource: config.research.externalMaxRequestsPerSource,
      externalMaxConcurrency: config.research.externalMaxConcurrency,
      defaultBudgetUsd: config.research.defaultBudgetUsd,
      thinkingLevel: config.research.thinkingLevel,
      sources: ["uniprot", "pubmed", "pmc", "reactome", "string", "quickgo"],
      networkSkillsEnabled: config.research.networkSkillsEnabled,
    },
    credentialStorageEnabled: Boolean(config.sessionSecret),
    keyStatus: {
      anthropic: config.providerKeys.anthropic ? "environment" : "missing",
      openrouter: config.providerKeys.openrouter ? "environment" : "missing",
    },
  };
}
