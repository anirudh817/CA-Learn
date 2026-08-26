import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { scrubOutput } from "../../security.js";
import type { ComputationRecord } from "../execution-types.js";
import type { ResearchScopeManifest } from "../../grounding/research-scope.js";
import { getSynthesisSkill } from "./registry.js";
import type { AnswerModel, AnswerNarrative, SynthesisContext } from "./types.js";
import { validateSynthesisAgainstEvidence } from "./guard.js";
import type { Narrator } from "./narrator.js";
import { sha, sweepChartSvg } from "./util.js";

export interface SynthesisStepInput {
  job: { id: string; runId: string; workflowId: string; objective: string; userId: string; budgetUsd: number; model: string };
  scope: ResearchScopeManifest;
  computations: ComputationRecord[];
  runPath: string;
  outputRoot: string;
  stepId: string;
  skillId: string;
  entrypoint: string;
  parameters: Record<string, unknown>;
  narrator?: Narrator | null;
  /** Remaining USD this job may spend on narration (cost-cap gate). */
  capUsd: number;
}

export interface SynthesisStepResult { record: ComputationRecord; answer: AnswerModel | null }

const safe = (root: string, rel: string) => {
  const absolute = path.resolve(root, rel);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error("Synthesis path escapes its approved root");
  return absolute;
};

/** Final research phase: read the actual computed outputs, decide the answer
 *  deterministically, then (when a key + budget allow) narrate it under the
 *  anti-fabrication guard. Always produces a record; never throws upstream. */
export async function runSynthesisStep(input: SynthesisStepInput): Promise<SynthesisStepResult> {
  const started = Date.now();
  const outputDir = safe(input.outputRoot, input.stepId);
  fs.mkdirSync(outputDir, { recursive: true });
  const outputs: ComputationRecord["outputs"] = [];
  const inputs = input.scope.artifacts.map((item) => ({ path: item.path, sha256: item.sha256 }));

  const skill = getSynthesisSkill(input.job.workflowId);
  let answer: AnswerModel | null = null;
  let narrative: AnswerNarrative | undefined;

  if (skill) {
    const ctx: SynthesisContext = {
      job: { id: input.job.id, runId: input.job.runId, workflowId: input.job.workflowId, objective: input.job.objective, budgetUsd: input.job.budgetUsd, model: input.job.model },
      scope: input.scope,
      computations: input.computations,
      readOutput: (relPath) => fs.readFileSync(safe(input.outputRoot, relPath), "utf8"),
      readScopeArtifact: (relPath) => {
        // A citation may point at the pre-staged subset (scope.artifacts) OR any
        // file the agent pulled on demand (scope.catalog). Both carry a hash
        // frozen at approval, so verify against whichever knows this path —
        // fetched files get the same audit-to-the-byte guarantee as staged ones.
        const expected = input.scope.artifacts.find((item) => item.path === relPath)?.sha256
          ?? input.scope.catalog?.find((item) => item.path === relPath)?.sha256;
        const filename = safe(input.runPath, relPath);
        const content = fs.readFileSync(filename);
        if (expected && sha(content) !== expected) throw new Error(`Scope artifact hash changed after approval: ${relPath}`);
        return content.toString("utf8");
      },
    };
    try {
      answer = skill.decide(ctx);
      narrative = await narrate(skill, answer, input);
      answer.narrative = narrative;
    } catch (error) {
      // Degrade, never fail the job: fall back to the pre-synthesis package.
      answer = null;
      narrative = { text: error instanceof Error ? error.message : String(error), generatedBy: "deterministic", groundingConfidence: "not-applicable", guard: "skipped" };
    }
  }

  if (answer?.chart?.series.length) {
    writeOutput(outputDir, "answer-sweep.svg", sweepChartSvg("Threshold sensitivity", answer.chart.xLabel, answer.chart.yLabel, answer.chart.series), "research-figure", "image/svg+xml", outputs);
  }
  // Always emit the answer record so the synthesis step has a downloadable output
  // even when it degrades to the deterministic fallback (keeps the OCC honest).
  writeOutput(outputDir, "answer-model.json", JSON.stringify(answer ?? { degraded: true, note: narrative?.text || "synthesis unavailable" }, null, 2), "research-answer", "application/json", outputs);

  const provider = narrative?.generatedBy === "model" ? (narrative.model || "model") : "deterministic-synthesis";
  const record: ComputationRecord = {
    id: `cmp_${crypto.randomUUID().replaceAll("-", "")}`,
    jobId: input.job.id, stepId: input.stepId, skillId: input.skillId, entrypoint: input.entrypoint,
    catalogVersion: skill?.version || "1.0.0", implementationKind: "native", sourceRevision: "signalfold-v1", provider,
    environment: { node: process.versions.node, platform: process.platform, arch: process.arch },
    parameters: {
      ...input.parameters,
      verdictLabel: answer?.verdictLabel ?? "unavailable",
      generatedBy: narrative?.generatedBy ?? "none",
      guard: narrative?.guard ?? "skipped",
      groundingConfidence: narrative?.groundingConfidence ?? "not-applicable",
      ...(narrative?.promptSha ? { promptSha: narrative.promptSha } : {}),
      ...(narrative?.outputSha ? { outputSha: narrative.outputSha } : {}),
    },
    seed: null, inputs, outputs, exitStatus: "complete",
    durationMs: Date.now() - started, costUsd: Number(narrative?.costUsd || 0),
    deterministicRerun: "not-checked",
    codeSha256: sha(`${skill?.id || input.skillId}:${skill?.version || "1.0.0"}:${input.entrypoint}`),
    inputSetSha256: sha(JSON.stringify(inputs)), outputSetSha256: sha(JSON.stringify(outputs)),
    executionReceiptSha256: sha(JSON.stringify({ skillId: input.skillId, entrypoint: input.entrypoint, inputs, outputs, provider })),
  };
  return { record, answer };
}

async function narrate(skill: NonNullable<ReturnType<typeof getSynthesisSkill>>, answer: AnswerModel, input: SynthesisStepInput): Promise<AnswerNarrative> {
  const fallback = (guard: AnswerNarrative["guard"]): AnswerNarrative => ({ text: skill.fallbackProse(answer), generatedBy: "deterministic", groundingConfidence: "not-applicable", guard });
  const narrator = input.narrator;
  if (!narrator || !narrator.available(input.job.userId)) return fallback("skipped");
  const { system, user } = skill.prompt(answer);
  const model = narrator.pickModel(input.job.userId, input.job.model);
  try {
    if (input.capUsd <= 0 || (await narrator.estimateCostUsd(model, system, user)) > input.capUsd) return fallback("skipped");
    const raw = await narrator.complete({ system, user, model, userId: input.job.userId });
    const prose = scrubOutput(raw.text);
    const verdict = validateSynthesisAgainstEvidence(prose, answer);
    if (verdict.hardViolation) return fallback("rejected");
    return {
      text: prose, generatedBy: "model", model: raw.model,
      promptSha: sha(`${system}\n${user}`), outputSha: sha(prose), costUsd: raw.costUsd,
      groundingConfidence: verdict.groundingConfidence, unverified: verdict.unverified,
      guard: verdict.unverified.length ? "annotated" : "passed",
    };
  } catch { return fallback("skipped"); }
}

function writeOutput(outputDir: string, name: string, content: string, kind: string, mimeType: string, outputs: ComputationRecord["outputs"]) {
  const filename = safe(outputDir, name);
  fs.writeFileSync(filename, content, { mode: 0o600 });
  const bytes = fs.readFileSync(filename);
  outputs.push({ path: path.relative(path.dirname(outputDir), filename).replaceAll("\\", "/"), kind, mimeType, sha256: sha(bytes), bytes: bytes.length });
}
