import { DEEP_RESEARCH_SYNTHESIS_POLICY } from "../evidence.js";
import type { AnswerMetric, AnswerModel, SynthesisContext, SynthesisSkill } from "./types.js";

/** The free-form agentic step writes its self-declared answer here as its final
 *  act; the generic decider treats it as untrusted input and validates every
 *  citation against the real frozen run before any of it becomes the answer. */
const AGENT_SKILL = "freeform-agent";

interface FreeformEvidence { path?: string; rowIds?: Array<number | string>; value?: string | number; note?: string }
interface FreeformClaim { id?: string; statement?: string; evidence?: FreeformEvidence[] }
interface FreeformFindings { headline?: string; summary?: string; claims?: FreeformClaim[]; limitations?: string[]; decisionImplication?: string }

function readFindings(ctx: SynthesisContext): FreeformFindings | null {
  const comp = ctx.computations.find((item) => item.skillId === AGENT_SKILL && item.exitStatus === "complete");
  const out = comp?.outputs.find((item) => item.path.endsWith("findings.json"));
  if (!comp || !out) return null;
  try { return JSON.parse(ctx.readOutput(out.path)) as FreeformFindings; } catch { return null; }
}

/** Path-level citation check: a claim's evidence must resolve to a real frozen
 *  scope artifact or a produced output. Unresolvable citations never become
 *  metrics (so the narrator guard cannot certify their numbers) and are surfaced
 *  as an explicit limitation — this is the audit-to-the-source floor for the
 *  unconstrained arm. (Deep cell-value matching is a planned hardening.) */
function resolves(ctx: SynthesisContext, cite: string | undefined): boolean {
  if (!cite) return false;
  // The jailed workspace exposes frozen files under inputs/<run-relative-path> and
  // produced files under outputs/; normalize to the run-relative form before matching.
  const rel = cite.replace(/^\.?\//, "").replace(/^(?:inputs|outputs)\//, "");
  if (ctx.scope.artifacts.some((item) => item.path === rel || rel.startsWith(item.path) || item.path.endsWith(rel))) return true;
  // A claim may cite a file the agent pulled on demand via fetch_input: it is a
  // real, hash-frozen run file even though it was not in the pre-staged subset.
  if (ctx.scope.catalog?.some((item) => item.path === rel || item.path.endsWith(rel) || rel.endsWith(item.path))) return true;
  if (ctx.computations.some((comp) => comp.outputs.some((out) => out.path === rel || out.path.endsWith(rel) || rel.endsWith(out.path)))) return true;
  try { ctx.readScopeArtifact(rel); return true; } catch { return false; }
}

function decide(ctx: SynthesisContext): AnswerModel {
  const findings = readFindings(ctx);
  const claims = (findings?.claims || []).filter((claim) => claim.statement);
  const metrics: AnswerMetric[] = [];
  const dropped: string[] = [];
  for (const claim of claims) {
    const grounded = (claim.evidence || []).find((item) => resolves(ctx, item.path));
    if (grounded && grounded.value !== undefined) {
      metrics.push({ label: String(claim.statement).slice(0, 120), value: grounded.value, cite: { path: grounded.path!, rowIds: grounded.rowIds } });
    } else if (!grounded) {
      dropped.push(String(claim.statement).slice(0, 80));
    }
  }

  const verdictLabel = claims.length ? "context-dependent" : "insufficient-evidence";
  const headline = findings?.headline?.trim()
    || (claims.length ? "The free-form investigation produced cited findings over the frozen run." : "The free-form investigation could not ground an answer in the frozen run.");

  const limitations = [
    ...(findings?.limitations || []),
    "Free-form agentic run: generated code is captured and hashed, but the result is not exact-rerun-verified (determinism: not-verified).",
    "Single completed run; association is not causation, and discovery is not validation.",
    ...(dropped.length ? [`${dropped.length} claim(s) were dropped for lacking a resolvable run citation: ${dropped.slice(0, 3).join("; ")}.`] : []),
  ];

  return {
    schemaVersion: "1.0",
    objective: ctx.job.objective,
    workflowId: ctx.job.workflowId,
    verdictLabel,
    marginalValue: ctx.computations.length ? "differentiated" : "standard-equivalent",
    headline,
    summary: findings?.summary?.trim() || "",
    metrics,
    pipelineFacts: ctx.scope.artifacts.map((item) => ({ path: item.path, family: item.family, sha256: item.sha256, rowIds: item.rowIds })),
    computationFacts: ctx.computations.map((item) => ({ skillId: item.skillId, entrypoint: item.entrypoint, params: item.parameters, seed: item.seed, outputs: item.outputs.map((output) => output.path), deterministicRerun: item.deterministicRerun })),
    decisionImplication: findings?.decisionImplication?.trim() || "Treat free-form findings as exploratory; confirm each cited claim against the frozen run before acting on it.",
    limitations,
  };
}

function prompt(answer: AnswerModel): { system: string; user: string } {
  const system = `${DEEP_RESEARCH_SYNTHESIS_POLICY}
You are writing the answer for a free-form investigation of one SignalFold run. Write 3-6 sentences, bottom-line-up-front: open with what the run shows for the objective, then the supporting figures, then the most important caveat. Use ONLY the numbers and citations supplied below; never introduce a figure or a file path that is not listed. Explain plainly; no headings, no markdown, no fabrication.`;
  const user = [
    `Objective: ${answer.objective}`,
    `Headline (already decided — do not contradict): ${answer.headline}`,
    answer.summary ? `Summary: ${answer.summary}` : "",
    "Numbers you may cite (and only these):",
    ...(answer.metrics.length ? answer.metrics.map((metric) => `  - ${metric.label}: ${metric.value} [${metric.cite.path}${metric.cite.rowIds?.length ? ` rows ${metric.cite.rowIds.slice(0, 8).join(",")}` : ""}]`) : ["  - (no run-grounded figures were produced)"]),
    `Decision implication: ${answer.decisionImplication}`,
    `Limitations: ${answer.limitations.join(" ")}`,
  ].filter(Boolean).join("\n");
  return { system, user };
}

function fallbackProse(answer: AnswerModel): string {
  return [answer.headline, answer.summary, answer.decisionImplication, `Limitations: ${answer.limitations.join(" ")}`].filter(Boolean).join(" ");
}

/** Generic synthesis for the free-form workflow: no per-card decide(); it reads
 *  the agent's self-declared findings.json, keeps only run-grounded claims, and
 *  hands them to the same narrator + anti-fabrication guard the structured cards
 *  use — so the unconstrained arm still produces an auditable, cited answer. */
export const freeformSynthesis: SynthesisSkill = {
  id: "freeform-synthesis",
  workflowId: "freeform",
  version: "1.0.0",
  reads: { computations: [AGENT_SKILL], families: [] },
  decide, prompt, fallbackProse,
};
