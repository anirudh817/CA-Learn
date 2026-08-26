import type { ResearchScopeManifest } from "../../grounding/research-scope.js";
import type { ComputationRecord } from "../execution-types.js";

/** Plain verdict tags (implementation-plan §8) — never GRADE labels. */
export type VerdictLabel = "stable" | "threshold-sensitive" | "sample-driven" | "context-dependent" | "insufficient-evidence";

/** One number in the answer, bound to the artifact/row it came from. */
export interface AnswerMetric {
  label: string;
  value: string | number;
  cite: { path: string; rowIds?: Array<number | string> };
}

/** The only model-touched field on an AnswerModel. Confidence is expressed,
 *  not suppressed: verified prose is "high", prose carrying figures we could not
 *  match to the evidence is kept but flagged "partial". A hard floor (path
 *  escape / redaction) still rejects outright. */
export interface AnswerNarrative {
  text: string;
  generatedBy: "model" | "deterministic";
  model?: string;
  promptSha?: string;
  outputSha?: string;
  costUsd?: number;
  groundingConfidence: "high" | "partial" | "not-applicable";
  unverified?: string[];
  guard: "passed" | "annotated" | "rejected" | "skipped";
}

/** The structured answer the deterministic interpreter produces and everything
 *  (panel, report, decision-summary, evidence claim) renders. */
export interface AnswerModel {
  schemaVersion: "1.0";
  objective: string;
  workflowId: string;
  verdictLabel: VerdictLabel;
  marginalValue: "differentiated" | "standard-equivalent";
  headline: string;
  summary: string;
  metrics: AnswerMetric[];
  pipelineFacts: Array<{ path: string; family: string; sha256: string; rowIds: Array<number | string> }>;
  computationFacts: Array<{ skillId: string; entrypoint: string; params: Record<string, unknown>; seed: number | null; outputs: string[]; deterministicRerun: string }>;
  decisionImplication: string;
  limitations: string[];
  chart?: { kind: "sweep"; xLabel: string; yLabel: string; series: Array<{ label: string; value: number }> };
  narrative?: AnswerNarrative;
}

export interface SynthesisContext {
  job: { id: string; runId: string; workflowId: string; objective: string; budgetUsd: number; model: string };
  scope: ResearchScopeManifest;
  computations: ComputationRecord[];
  /** Read a computed output by the relPath recorded in ComputationRecord.outputs[].path. */
  readOutput: (relPath: string) => string;
  /** Read a frozen scope artifact (run-relative path), with hash verification. */
  readScopeArtifact: (path: string) => string;
}

/** One synthesis skill per workflow. decide() is the deterministic decisions;
 *  prompt() is the workflow-tailored narrator prompt; fallbackProse() is the
 *  deterministic prose used when the LLM is off or the guard rejects. */
export interface SynthesisSkill {
  id: string;
  workflowId: string;
  version: string;
  reads: { computations: string[]; families: string[] };
  decide(ctx: SynthesisContext): AnswerModel;
  prompt(answer: AnswerModel): { system: string; user: string };
  fallbackProse(answer: AnswerModel): string;
}
