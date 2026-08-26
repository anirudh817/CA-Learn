import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AuthStorage, DefaultResourceLoader, ModelRegistry, SessionManager, createAgentSession, defineTool, getAgentDir, type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ModelCatalog } from "../models.js";
import { toPiModel } from "../runtime.js";
import { loadFilteredPiSkills } from "../pi-resources.js";
import type { ResearchScopeManifest } from "../grounding/research-scope.js";
import type { ExternalEvidenceItem } from "./external.js";
import { SkillExecutionGateway, type ExecutionReceipt } from "./execution-gateway.js";
import { runWorkflowRecipe, type WorkflowRecipe } from "./workflow-recipes.js";
import type { ResearchThinkingLevel } from "../config.js";

/** The researcher's three model tiers (high/medium/low capability), chosen in
 *  the configuration drawer. They are threaded into the agent environment so a
 *  future task-aware step can switch models mid-run as the work changes; today
 *  the step runs on `model` (the chosen default tier) and the tiers are recorded
 *  for observability. An empty string means that tier is unassigned. */
export interface ModelTierMap { high: string; medium: string; low: string }

export interface ResearchPiStepRequest {
  jobId: string; stepId: string; runId: string; runPath: string; jobRoot: string; objective: string; model: string; userId: string;
  reasoningProfiles: string[]; allowedSkills: string[]; skillId: string; entrypoint: string; parameters: Record<string, unknown>; scope: ResearchScopeManifest;
  /** The job's cost cap (USD). The free-form plane charges brokered external
   *  lookups against it so the agent stops before overspending. */
  budgetUsd?: number;
  /** The high/medium/low tiers available to this run (see ModelTierMap). */
  modelTiers?: ModelTierMap;
  /** Optional live-activity sink. The free-form executor streams each agent
   *  action (plan, code run, skill read, tool result) through it for observability;
   *  the durable constrained executor ignores it. */
  onActivity?: (name: string, payload: Record<string, unknown>) => void;
}
export interface ResearchPiStepResult {
  sessionId: string; loadedSkills: string[]; activatedSkills: string[]; receipts: ExecutionReceipt[]; modelTurns: number; costUsd: number;
  /** Curated external-corroboration items the agent fetched itself via the
   *  brokered request_external tool (free-form plane only). When present, the
   *  service feeds these to buildPackage instead of running the control-plane
   *  external arm — they are bound to the run's real identifiers, not regex
   *  tokens scraped from the objective. */
  externalEvidence?: ExternalEvidenceItem[];
}
export interface ResearchPiExecutionPlane { executeStep(request: ResearchPiStepRequest): Promise<ResearchPiStepResult>; closeJob?(jobId: string): void; }

interface LiveJob { session: AgentSession; sessionId: string; loadedSkills: string[]; activated: Set<string>; receipts: ExecutionReceipt[]; modelTurns: number; costUsd: number; unsubscribe: () => void; }

export class DurableResearchPiExecutor implements ResearchPiExecutionPlane {
  private live = new Map<string, LiveJob>();
  constructor(private readonly models: ModelCatalog, private readonly keyResolver: (userId: string, provider: string) => string | undefined, private readonly defaultModel: string, private readonly thinkingLevel: ResearchThinkingLevel = "low", private readonly gateway = new SkillExecutionGateway()) {}

  async executeStep(request: ResearchPiStepRequest): Promise<ResearchPiStepResult> {
    const live = this.live.get(request.jobId) || await this.createJob(request);
    if (!live.loadedSkills.includes(request.skillId)) throw new Error("Planned skill was not loaded into the controlled Pi session");
    const before = live.receipts.length;
    const invocationHint = request.skillId === "exploratory-data-analysis"
      ? `For a tabular frozen input, the approved script is scripts/eda_analyzer.py. Call sf_skill_run with args ["inputs/${request.scope.artifacts[0]?.path}", "outputs/eda-report.md"].`
      : request.skillId === "scientific-visualization" ? "To prove the unchanged helper is importable, activate the skill then call sf_skill_run for scripts/style_presets.py with no arguments." : request.skillId === "stage1-finding-stability" ? `Activate the native skill and call stage1_finding_stability with thresholds ${JSON.stringify((request.parameters.thresholds as number[]) || [0.01, 0.05, 0.1])}.` : request.skillId === "signalfold-workflow-recipes" ? `Activate the native skill and call signalfold_workflow_recipe with recipe ${JSON.stringify(request.parameters.recipe)}. Generated code is disabled.` : "Do not call a restricted or unavailable script.";
    await live.session.prompt([
      `Research objective: ${request.objective}`,
      `Reasoning profiles: ${request.reasoningProfiles.join(", ") || "none"}`,
      `Approved skills (hard allowlist): ${request.allowedSkills.join(", ")}`,
      `Evaluate whether ${request.skillId} is useful for this phase (${request.entrypoint}). If useful, activate its real SKILL.md with read_skill and follow it. Execute an allowed upstream script only through sf_skill_run. If it is not useful, say so and do not fabricate a run.`,
      `Frozen inputs are available under inputs/. Parameters: ${JSON.stringify(request.parameters)}.`,
      `Frozen input paths: ${request.scope.artifacts.map((item) => item.path).join(", ")}. ${invocationHint}`,
    ].join("\n\n"));
    return { sessionId: live.sessionId, loadedSkills: live.loadedSkills, activatedSkills: [...live.activated], receipts: live.receipts.slice(before), modelTurns: live.modelTurns, costUsd: live.costUsd };
  }

  closeJob(jobId: string) { const live = this.live.get(jobId); if (live) { live.unsubscribe(); live.session.dispose(); this.live.delete(jobId); } }

  private async createJob(request: ResearchPiStepRequest): Promise<LiveJob> {
    const model = await this.models.resolve(request.model || this.defaultModel);
    const key = this.keyResolver(request.userId, model.provider);
    if (!key) throw new Error(`No ${model.provider} key is configured for durable Pi research`);
    const authStorage = AuthStorage.create(); authStorage.setRuntimeApiKey(model.provider, key);
    const registry = ModelRegistry.create(authStorage);
    const workspace = path.join(request.jobRoot, "workspace"); const sessions = path.join(request.jobRoot, "pi-sessions");
    fs.mkdirSync(workspace, { recursive: true });
    const filtered = loadFilteredPiSkills(request.allowedSkills);
    const resourceLoader = new DefaultResourceLoader({ cwd: workspace, agentDir: getAgentDir(), noSkills: false, skillsOverride: () => filtered });
    await resourceLoader.reload();
    const sessionId = `pi_${crypto.randomUUID().replaceAll("-", "")}`;
    const live: LiveJob = { session: null as unknown as AgentSession, sessionId, loadedSkills: resourceLoader.getSkills().skills.map((skill) => skill.name), activated: new Set(), receipts: [], modelTurns: 0, costUsd: 0, unsubscribe: () => {} };
    const customTools = this.tools(request, live, workspace);
    // Suppress every built-in coding tool while retaining the three custom,
    // policy-enforcing research tools. `tools: []` would also suppress custom
    // tools in Pi's allowlist; noTools:"builtin" is the SDK's intended mode.
    const created = await createAgentSession({ cwd: workspace, model: toPiModel(model), authStorage, modelRegistry: registry, sessionManager: SessionManager.create(workspace, sessions), resourceLoader, noTools: "builtin", customTools, thinkingLevel: this.thinkingLevel });
    live.session = created.session;
    live.unsubscribe = live.session.subscribe((event: any) => { if (event.type === "turn_end") { live.modelTurns += 1; live.costUsd += Number(event.message?.usage?.cost?.total || 0); } });
    this.live.set(request.jobId, live); return live;
  }

  private tools(request: ResearchPiStepRequest, live: LiveJob, workspace: string): ToolDefinition[] {
    const readParams = Type.Object({ skillId: Type.String() });
    const readSkill = defineTool<typeof readParams, { skillId?: string; sha256?: string; error?: string }>({ name: "read_skill", label: "Read approved SKILL.md", description: "Activate and read one approved native Pi skill package by ID.", parameters: readParams, execute: async (_id, params) => {
      if (!request.allowedSkills.includes(params.skillId)) return { content: [{ type: "text" as const, text: "Skill is not approved." }], details: { error: "not-approved" } };
      const skill = loadFilteredPiSkills([params.skillId]).skills[0]; const content = fs.readFileSync(skill.filePath, "utf8"); live.activated.add(params.skillId);
      return { content: [{ type: "text" as const, text: content }], details: { skillId: params.skillId, sha256: crypto.createHash("sha256").update(content).digest("hex") } };
    }});
    const runParams = Type.Object({ skillId: Type.String(), script: Type.String(), args: Type.Array(Type.String()) });
    const runSkill = defineTool<typeof runParams, { receipt?: ExecutionReceipt; error?: string }>({ name: "sf_skill_run", label: "Run approved scientific skill script", description: "Run an exact allowlisted script from an activated approved vendored skill. Paths are relative to the job workspace.", parameters: runParams, execute: async (_id, params) => {
      if (!live.activated.has(params.skillId)) return { content: [{ type: "text" as const, text: "Activate the approved SKILL.md first." }], details: { error: "not-activated" } };
      try { const receipt = await this.gateway.run({ ...request, piSessionId: live.sessionId, approvedSkills: request.allowedSkills, skillId: params.skillId as any, script: params.script, args: params.args, workspace, timeoutMs: 60_000 }); live.receipts.push(receipt); return { content: [{ type: "text" as const, text: JSON.stringify({ exitCode: receipt.exitCode, outputs: receipt.outputs, stdout: receipt.stdout, stderr: receipt.stderr }) }], details: { receipt } }; }
      catch (error) { return { content: [{ type: "text" as const, text: String(error) }], details: { error: String(error) } }; }
    }});
    const stabilityParams = Type.Object({ thresholds: Type.Array(Type.Number()) });
    const stability = defineTool<typeof stabilityParams, { receipt?: ExecutionReceipt; error?: string }>({ name: "stage1_finding_stability", label: "Stage 1 finding stability", description: "Run the deterministic adjusted-p threshold sweep over the approved frozen differential-expression artifact.", parameters: stabilityParams, execute: async (_id, params) => {
      if (!request.allowedSkills.includes("stage1-finding-stability") || !live.activated.has("stage1-finding-stability")) return { content: [{ type: "text" as const, text: "Native skill is not approved and activated." }], details: { error: "not-approved-or-activated" } };
      try {
        const artifact = request.scope.artifacts.find((item) => item.family === "differential-expression"); if (!artifact) throw new Error("Frozen scope has no differential-expression artifact");
        const source = path.resolve(request.runPath, artifact.path); if (!source.startsWith(`${path.resolve(request.runPath)}${path.sep}`)) throw new Error("Frozen input escaped run root");
        const bytes = fs.readFileSync(source); if (crypto.createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("Frozen input hash changed");
        const lines = bytes.toString("utf8").split(/\r?\n/).filter(Boolean); const delimiter = artifact.path.endsWith(".tsv") ? "\t" : ","; const header = lines[0].split(delimiter).map((item) => item.toLowerCase().replace(/[^a-z0-9]/g, ""));
        const p = header.findIndex((item) => /^(adjp|adjpvalue|padj|fdr|adjustedpvalue)$/.test(item)); if (p < 0) throw new Error("Differential-expression table has no adjusted p-value column");
        const values = lines.slice(1).map((line) => Number(line.split(delimiter)[p])).filter(Number.isFinite); const thresholds = params.thresholds.filter(Number.isFinite);
        const content = `threshold,features_passing\n${thresholds.map((value) => `${value},${values.filter((pvalue) => pvalue <= value).length}`).join("\n")}\n`; const output = path.join(workspace, "outputs", "threshold-sensitivity.csv"); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, content);
        const skillMd = path.join(import.meta.dirname, "..", "..", "skills", "native", "stage1-finding-stability", "SKILL.md"); const startedAt = new Date().toISOString();
        const receipt: ExecutionReceipt = { schemaVersion: "1.0", jobId: request.jobId, stepId: request.stepId, piSessionId: live.sessionId, reasoningProfiles: request.reasoningProfiles, approvedSkills: request.allowedSkills, activatedSkill: "stage1-finding-stability", skillMdPath: "native/stage1-finding-stability/SKILL.md", skillMdHash: crypto.createHash("sha256").update(fs.readFileSync(skillMd)).digest("hex"), upstreamRepository: "SignalFold", upstreamCommit: "signalfold-native-v1", skillFolderHash: crypto.createHash("sha256").update(fs.readFileSync(skillMd)).digest("hex"), executable: { type: "custom-tool", identity: "stage1_finding_stability", arguments: thresholds.map(String) }, environment: { id: "signalfold-node", lockHash: crypto.createHash("sha256").update(process.versions.node).digest("hex"), python: "not-used" }, inputs: [{ path: artifact.path, sha256: artifact.sha256 }], outputs: [{ path: "outputs/threshold-sensitivity.csv", mimeType: "text/csv", bytes: Buffer.byteLength(content), sha256: crypto.createHash("sha256").update(content).digest("hex") }], determinism: "deterministic", networkPolicy: "offline", externalActivity: "none", startedAt, endedAt: new Date().toISOString(), durationMs: 0, exitCode: 0, timedOut: false, stdout: "", stderr: "" };
        live.receipts.push(receipt); return { content: [{ type: "text" as const, text: content }], details: { receipt } };
      } catch (error) { return { content: [{ type: "text" as const, text: String(error) }], details: { error: String(error) } }; }
    }});
    const recipeParams = Type.Object({ recipe: Type.Union([Type.Literal("ranked-pathway"), Type.Literal("module-hub"), Type.Literal("external-protein-evidence"), Type.Literal("literature-contradiction"), Type.Literal("power-next-experiment")]) });
    const recipe = defineTool<typeof recipeParams, { receipt?: ExecutionReceipt; error?: string }>({ name: "signalfold_workflow_recipe", label: "SignalFold workflow recipe", description: "Run one committed deterministic workflow recipe over the approved frozen scope. Generated code is not accepted.", parameters: recipeParams, execute: async (_id, params) => {
      if (request.skillId !== "signalfold-workflow-recipes" || request.parameters.recipe !== params.recipe || !request.allowedSkills.includes("signalfold-workflow-recipes") || !live.activated.has("signalfold-workflow-recipes")) return { content: [{ type: "text" as const, text: "Recipe is not the approved and activated plan step." }], details: { error: "not-approved-or-activated" } };
      try {
        const started = Date.now(); const result = runWorkflowRecipe({ recipe: params.recipe as WorkflowRecipe, runPath: request.runPath, workspace, scope: request.scope }); const bytes = Buffer.from(result.content);
        const skillMd = path.join(import.meta.dirname, "..", "..", "skills", "native", "signalfold-workflow-recipes", "SKILL.md"); const skillHash = crypto.createHash("sha256").update(fs.readFileSync(skillMd)).digest("hex");
        const receipt: ExecutionReceipt = { schemaVersion: "1.0", jobId: request.jobId, stepId: request.stepId, piSessionId: live.sessionId, reasoningProfiles: request.reasoningProfiles, approvedSkills: request.allowedSkills, activatedSkill: "signalfold-workflow-recipes", skillMdPath: "native/signalfold-workflow-recipes/SKILL.md", skillMdHash: skillHash, upstreamRepository: "SignalFold", upstreamCommit: "signalfold-native-v1", skillFolderHash: skillHash, executable: { type: "custom-tool", identity: "signalfold_workflow_recipe", arguments: [params.recipe] }, environment: { id: "signalfold-node", lockHash: crypto.createHash("sha256").update(process.versions.node).digest("hex"), python: "not-used" }, inputs: request.scope.artifacts.map((item) => ({ path: item.path, sha256: item.sha256 })), outputs: [{ path: result.relativePath, mimeType: "text/csv", bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") }], determinism: "deterministic", networkPolicy: "offline", externalActivity: "none", startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString(), durationMs: Date.now() - started, exitCode: 0, timedOut: false, stdout: `completed ${params.recipe}`, stderr: "" };
        live.receipts.push(receipt); return { content: [{ type: "text" as const, text: result.content }], details: { receipt } };
      } catch (error) { return { content: [{ type: "text" as const, text: String(error) }], details: { error: String(error) } }; }
    }});
    return [readSkill, runSkill, stability, recipe];
  }
}
