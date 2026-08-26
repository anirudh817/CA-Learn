import { complete, registerBuiltInApiProviders } from "@earendil-works/pi-ai";
import type { ModelCatalog } from "../../models.js";
import { toPiModel } from "../../runtime.js";

export interface NarratorRequest { system: string; user: string; model: string; userId: string; maxOutputTokens?: number }
export interface NarratorResult { text: string; model: string; costUsd: number }

/** One-shot, non-streaming LLM narration over a frozen AnswerModel. The narrator
 *  has NO tools and NO skills — it only phrases facts it is handed, which is what
 *  keeps a non-deterministic component safe inside the deterministic spine. */
export interface Narrator {
  available(userId: string): boolean;
  pickModel(userId: string, jobModel: string): string;
  estimateCostUsd(model: string, system: string, user: string, maxOutputTokens?: number): Promise<number>;
  complete(request: NarratorRequest): Promise<NarratorResult>;
}

type KeyResolver = (userId: string, provider: string) => string | undefined;
const DEFAULT_MAX_OUTPUT = 1200;

let providersRegistered = false;
function ensureProviders() { if (!providersRegistered) { registerBuiltInApiProviders(); providersRegistered = true; } }

export function createNarrator(models: ModelCatalog, keyResolver: KeyResolver, defaultModel: string): Narrator {
  return {
    // Narration runs on ANY available provider key (Anthropic or OpenRouter).
    available(userId) {
      return Boolean(keyResolver(userId, "anthropic") || keyResolver(userId, "openrouter"));
    },
    // Honor the researcher's selected model for narration too — the same model
    // the job ran on (its chosen default tier). Only fall back to the configured
    // default when the job carries no model. (userId is kept for parity with the
    // Narrator interface and future per-user routing.)
    pickModel(_userId, jobModel) {
      return jobModel || defaultModel;
    },
    async estimateCostUsd(model, system, user, maxOutputTokens = DEFAULT_MAX_OUTPUT) {
      const option = await models.resolve(model);
      const inputTokens = Math.ceil((system.length + user.length) / 4);
      return (inputTokens * option.promptCost + maxOutputTokens * option.completionCost) / 1_000_000;
    },
    async complete(request) {
      const option = await models.resolve(request.model);
      const key = keyResolver(request.userId, option.provider);
      if (!key) throw new Error(`No ${option.provider} API key is configured for synthesis`);
      ensureProviders();
      const piModel = { ...toPiModel(option), maxTokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT };
      const result = await complete(piModel, {
        systemPrompt: request.system,
        messages: [{ role: "user", content: request.user, timestamp: Date.now() }],
      }, { apiKey: key });
      if (result.stopReason === "error") throw new Error(result.errorMessage || "synthesis provider returned an error");
      const text = result.content.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("").trim();
      if (!text) throw new Error("synthesis provider returned no text");
      return { text, model: option.id, costUsd: Number(result.usage?.cost?.total || 0) };
    },
  };
}
