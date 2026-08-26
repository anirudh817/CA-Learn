import fs from "node:fs";
import path from "node:path";
import type { SidecarConfig } from "./config.js";

export interface ModelOption {
  id: string;
  name: string;
  provider: "openrouter" | "anthropic";
  contextWindow: number;
  inputModalities: string[];
  toolCapable: boolean;
  promptCost: number;
  completionCost: number;
  cacheReadCost: number | null;
  cacheWriteCost: number | null;
  intelligenceIndex: number | null;
}

const FALLBACK_MODELS: ModelOption[] = [
  { id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", contextWindow: 200000, inputModalities: ["text", "image"], toolCapable: true, promptCost: 3, completionCost: 15, cacheReadCost: null, cacheWriteCost: null, intelligenceIndex: null },
];

export class ModelCatalog {
  private config: SidecarConfig;
  private cachePath: string;
  private benchmarksCachePath: string;
  constructor(config: SidecarConfig) {
    this.config = config;
    this.cachePath = path.join(config.dataDir, "ai_openrouter_models.json");
    this.benchmarksCachePath = path.join(config.dataDir, "ai_openrouter_benchmarks.json");
  }

  async list(refresh = false): Promise<ModelOption[]> {
    let models = [...FALLBACK_MODELS];
    const cached = !refresh && this.readCache();
    if (cached) models.push(...cached);
    else {
      try {
        const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`catalog status ${response.status}`);
        const payload = await response.json() as { data?: any[] };
        const openRouter = (payload.data || []).map(toModelOption).filter((model) => model.toolCapable);
        fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
        fs.writeFileSync(this.cachePath, JSON.stringify({ fetchedAt: Date.now(), models: openRouter }, null, 2), { mode: 0o600 });
        models.push(...openRouter);
      } catch {
        if (this.config.defaultModel) models.push(fallbackForConfigured(this.config.defaultModel));
      }
    }
    const allowed = new Set(this.config.allowedModels);
    models = models.filter((model) => !allowed.size || allowed.has(model.id));
    const unique = new Map(models.map((model) => [model.id, model]));
    return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolve(modelId: string) {
    const models = await this.list();
    const found = models.find((model) => model.id === modelId);
    if (!found) throw new Error("The selected model is unavailable or not allowed");
    if (!found.toolCapable) throw new Error("AI Insights requires a tool-capable model");
    return found;
  }

  async listWithBenchmarks(refresh = false, apiKey?: string): Promise<ModelOption[]> {
    const models = await this.list(refresh);
    let scores = !refresh ? this.readBenchmarkCache() : null;
    if (!scores && apiKey) {
      try {
        const response = await fetch("https://openrouter.ai/api/v1/datasets/benchmarks/artificial-analysis?max_results=100", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`benchmark status ${response.status}`);
        const payload = await response.json() as { data?: any[]; meta?: Record<string, unknown> };
        scores = Object.fromEntries((payload.data || [])
          .filter((row) => row.model_permaslug && Number.isFinite(Number(row.intelligence_index)))
          .map((row) => [String(row.model_permaslug), Number(row.intelligence_index)]));
        fs.mkdirSync(path.dirname(this.benchmarksCachePath), { recursive: true });
        fs.writeFileSync(this.benchmarksCachePath, JSON.stringify({ fetchedAt: Date.now(), scores, meta: payload.meta || {} }, null, 2), { mode: 0o600 });
      } catch {
        try {
          // OpenRouter's dataset endpoint is still returning 404 for some
          // accounts. Artificial Analysis is the attributed primary source;
          // its public model page embeds the current leaderboard rows.
          const response = await fetch("https://artificialanalysis.ai/models/minimax-m3", { signal: AbortSignal.timeout(15_000) });
          if (!response.ok) throw new Error(`Artificial Analysis status ${response.status}`);
          const html = await response.text();
          const rows = [...html.matchAll(/"label":"((?:\\.|[^"])*)","artificialAnalysisIntelligenceIndex":(-?\d+(?:\.\d+)?)/g)];
          scores = {};
          for (const row of rows) {
            const label = JSON.parse(`"${row[1]}"`) as string;
            scores[`name:${benchmarkKey(label)}`] = Number(row[2]);
          }
          if (!Object.keys(scores).length) throw new Error("Artificial Analysis leaderboard was empty");
          fs.mkdirSync(path.dirname(this.benchmarksCachePath), { recursive: true });
          fs.writeFileSync(this.benchmarksCachePath, JSON.stringify({ fetchedAt: Date.now(), scores, meta: { source: "artificial-analysis", source_url: "https://artificialanalysis.ai" } }, null, 2), { mode: 0o600 });
        } catch {
          scores = this.readBenchmarkCache(true);
        }
      }
    }
    const availableScores = scores || {};
    return models.map((model) => ({
      ...model,
      intelligenceIndex: scoreForModel(model, availableScores) ?? model.intelligenceIndex ?? null,
    }));
  }

  private readCache(): ModelOption[] | null {
    try {
      const payload = JSON.parse(fs.readFileSync(this.cachePath, "utf8"));
      if (Date.now() - Number(payload.fetchedAt) > this.config.catalogTtlHours * 3_600_000) return null;
      return Array.isArray(payload.models) ? payload.models : null;
    } catch { return null; }
  }


  private readBenchmarkCache(allowStale = false): Record<string, number> | null {
    try {
      const payload = JSON.parse(fs.readFileSync(this.benchmarksCachePath, "utf8"));
      if (!allowStale && Date.now() - Number(payload.fetchedAt) > this.config.catalogTtlHours * 3_600_000) return null;
      return payload.scores && typeof payload.scores === "object" ? payload.scores : null;
    } catch { return null; }
  }
}

function toModelOption(value: any): ModelOption {
  const input = String(value.architecture?.modality || "text->text").includes("image") ? ["text", "image"] : ["text"];
  return {
    id: `openrouter/${value.id}`,
    name: value.name || value.id,
    provider: "openrouter",
    contextWindow: Number(value.context_length || 128000),
    inputModalities: input,
    toolCapable: Array.isArray(value.supported_parameters) && value.supported_parameters.includes("tools"),
    promptCost: Number(value.pricing?.prompt || 0) * 1_000_000,
    completionCost: Number(value.pricing?.completion || 0) * 1_000_000,
    cacheReadCost: value.pricing?.input_cache_read != null ? Number(value.pricing.input_cache_read) * 1_000_000 : null,
    cacheWriteCost: value.pricing?.input_cache_write != null ? Number(value.pricing.input_cache_write) * 1_000_000 : null,
    intelligenceIndex: Number.isFinite(Number(value.intelligenceIndex)) ? Number(value.intelligenceIndex) : null,
  };
}

function fallbackForConfigured(id: string): ModelOption {
  // The OpenRouter catalog fetch failed, so we have no pricing for this model.
  // Surface that loudly instead of silently pricing every turn at $0 — an
  // unpriced model would otherwise report a real run as costing nothing.
  console.warn(`[research] no pricing for "${id}" (model catalog unavailable); per-turn cost will read $0 until the catalog refreshes`);
  return { id, name: id.replace(/^openrouter\//, ""), provider: id.startsWith("openrouter/") ? "openrouter" : "anthropic", contextWindow: 128000, inputModalities: ["text"], toolCapable: true, promptCost: 0, completionCost: 0, cacheReadCost: null, cacheWriteCost: null, intelligenceIndex: null };
}

const benchmarkKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "")
  .replace(/(withfallback|xhigh|max|high|medium|low)$/, "");

function scoreForModel(model: ModelOption, scores: Record<string, number>) {
  const direct = scores[model.id.replace(/^openrouter\//, "")];
  if (direct != null) return direct;
  const name = benchmarkKey(model.name);
  const tail = benchmarkKey(model.id.split("/").at(-1) || "");
  const matches = Object.entries(scores).filter(([key]) => key.startsWith("name:")).filter(([key]) => {
    const candidate = key.slice(5);
    return candidate === name || candidate === tail || name.endsWith(candidate) || candidate.endsWith(name);
  });
  return matches.length === 1 ? matches[0][1] : undefined;
}
