import { DEEP_RESEARCH_SYNTHESIS_POLICY } from "../../evidence.js";
import type { AnswerMetric, AnswerModel, SynthesisContext, SynthesisSkill, VerdictLabel } from "../types.js";
import { normalizeHeader, parseDelimited } from "../util.js";

const STABILITY_SKILL = "stage1-finding-stability";
const EDA_SKILL = "exploratory-data-analysis";
const num = (value: unknown) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : NaN; };

/** The literal stability answer: features passing per adjusted-p cutoff, read
 *  back from the computation's own output (the source of truth for counts). */
function readSweep(ctx: SynthesisContext): Array<{ threshold: number; count: number }> {
  const comp = ctx.computations.find((item) => item.skillId === STABILITY_SKILL && item.exitStatus === "complete");
  const out = comp?.outputs.find((item) => item.path.endsWith("threshold-sensitivity.csv"));
  if (!comp || !out) return [];
  try {
    const { header, rows } = parseDelimited(ctx.readOutput(out.path), out.path);
    const norm = normalizeHeader(header);
    const ti = norm.indexOf("threshold");
    const ci = norm.findIndex((value) => /featurespassing|features|passing|count/.test(value));
    if (ti < 0 || ci < 0) return [];
    return rows.map((row) => ({ threshold: num(row[ti]), count: num(row[ci]) }))
      .filter((row) => Number.isFinite(row.threshold) && Number.isFinite(row.count))
      .sort((a, b) => a.threshold - b.threshold);
  } catch { return []; }
}

function readEda(ctx: SynthesisContext): { rows?: number; columns?: number; missingFraction?: number } {
  const comp = ctx.computations.find((item) => item.skillId === EDA_SKILL && item.exitStatus === "complete");
  const out = comp?.outputs.find((item) => item.path.endsWith("eda-summary.json"));
  if (!comp || !out) return {};
  try { return JSON.parse(ctx.readOutput(out.path)); } catch { return {}; }
}

/** The frozen DE table, for the per-feature note + row-level citation. */
function readDe(ctx: SynthesisContext) {
  const artifact = ctx.scope.artifacts.find((item) => item.family === "differential-expression");
  if (!artifact) return null;
  let content = "";
  try { content = ctx.readScopeArtifact(artifact.path); } catch { return { path: artifact.path, rowIds: artifact.rowIds, features: [] as Array<{ feature: string; p: number }> }; }
  const { header, rows } = parseDelimited(content, artifact.path);
  const norm = normalizeHeader(header);
  const pi = norm.findIndex((value) => /^(adjp|adjpvalue|padj|fdr|adjustedpvalue)$/.test(value));
  const fi = norm.findIndex((value) => /^(feature|gene|protein|symbol|id)$/.test(value));
  const features = pi < 0 ? [] : rows.map((row) => ({ feature: fi >= 0 ? (row[fi] || "unknown") : "unknown", p: num(row[pi]) })).filter((row) => Number.isFinite(row.p));
  return { path: artifact.path, rowIds: artifact.rowIds, features };
}

function decide(ctx: SynthesisContext): AnswerModel {
  const sweep = readSweep(ctx);
  const eda = readEda(ctx);
  const de = readDe(ctx);
  const thresholds = sweep.map((point) => point.threshold);
  const counts = sweep.map((point) => point.count);
  const tmin = thresholds.length ? Math.min(...thresholds) : 0.01;
  const tmax = thresholds.length ? Math.max(...thresholds) : 0.1;
  const first = counts[0] ?? 0;
  const last = counts[counts.length - 1] ?? 0;

  let verdictLabel: VerdictLabel;
  if (!sweep.length || counts.every((count) => count === 0)) verdictLabel = "insufficient-evidence";
  else if (counts.every((count) => count === counts[0])) verdictLabel = "stable";
  else verdictLabel = "threshold-sensitive";

  // Per-feature note: does the strongest feature survive every cutoff, or only
  // enter as the threshold loosens? This nuance is the useful part of the answer.
  let featureNote = "";
  if (de?.features.length) {
    const top = [...de.features].sort((a, b) => a.p - b.p)[0];
    const entersAt = thresholds.find((threshold) => top.p <= threshold);
    if (verdictLabel === "stable") featureNote = `${top.feature} clears every tested cutoff.`;
    else if (top.p <= tmin) featureNote = `${top.feature} clears every cutoff; additional features enter only as it loosens.`;
    else if (entersAt !== undefined) featureNote = `${top.feature} enters only at adjusted-p ≤ ${entersAt}.`;
  }

  const metrics: AnswerMetric[] = sweep.map((point) => ({
    label: `features passing at adjusted-p ≤ ${point.threshold}`, value: point.count, cite: { path: "threshold-sensitivity.csv" },
  }));
  if (de) metrics.push({ label: "Stage 1 features analyzed", value: de.features.length, cite: { path: de.path, rowIds: de.rowIds } });
  if (Number.isFinite(eda.missingFraction)) metrics.push({ label: "missing cells", value: `${Math.round((eda.missingFraction as number) * 1000) / 10}%`, cite: { path: "eda-summary.json" } });

  const headline =
    verdictLabel === "stable" ? `Stable: ${first} feature${first === 1 ? "" : "s"} pass at every tested adjusted-p cutoff (${tmin}–${tmax}).${featureNote ? ` ${featureNote}` : ""}`
    : verdictLabel === "threshold-sensitive" ? `Threshold-sensitive: ${first}→${last} features pass as the adjusted-p cutoff loosens from ${tmin} to ${tmax}.${featureNote ? ` ${featureNote}` : ""}`
    : `Insufficient evidence: no features pass at the tested adjusted-p cutoffs (${tmin}–${tmax}).`;

  const decisionImplication =
    verdictLabel === "stable" ? "Treat the surviving feature(s) as a robust anchor for the follow-up; the result does not hinge on the threshold choice."
    : verdictLabel === "threshold-sensitive" ? "Anchor on the feature(s) that survive the strictest cutoff; confirm threshold-dependent additions with an independent check before acting on them."
    : "Do not select a follow-up target from this contrast at the tested cutoffs; revisit upstream filtering, normalization, or statistical power.";

  const summary = [
    sweep.length ? `At adjusted-p ≤ ${tmin}, ${first} feature${first === 1 ? "" : "s"} pass; loosening to ≤ ${tmax} yields ${last}.` : "",
    Number.isFinite(eda.rows) && Number.isFinite(eda.columns) ? `The analyzed table has ${eda.rows} rows × ${eda.columns} columns${Number.isFinite(eda.missingFraction) ? ` with ${Math.round((eda.missingFraction as number) * 1000) / 10}% missing cells` : ""}.` : "",
    featureNote,
  ].filter(Boolean).join(" ");

  return {
    schemaVersion: "1.0",
    objective: ctx.job.objective,
    workflowId: ctx.job.workflowId,
    verdictLabel,
    marginalValue: ctx.computations.length ? "differentiated" : "standard-equivalent",
    headline,
    summary,
    metrics,
    pipelineFacts: ctx.scope.artifacts.map((item) => ({ path: item.path, family: item.family, sha256: item.sha256, rowIds: item.rowIds })),
    computationFacts: ctx.computations.map((item) => ({ skillId: item.skillId, entrypoint: item.entrypoint, params: item.parameters, seed: item.seed, outputs: item.outputs.map((output) => output.path), deterministicRerun: item.deterministicRerun })),
    decisionImplication,
    limitations: [
      "Single completed run; association is not causation, and discovery is not validation.",
      "Stage 1 significance reflects the configured Welch/Wilcoxon test and BH adjustment, not a moderated model.",
      "This tests the hit set across thresholds; it does not test leave-one-sample-out stability.",
    ],
    chart: sweep.length ? { kind: "sweep", xLabel: "adjusted-p threshold", yLabel: "features passing", series: sweep.map((point) => ({ label: String(point.threshold), value: point.count })) } : undefined,
  };
}

function prompt(answer: AnswerModel): { system: string; user: string } {
  const system = `${DEEP_RESEARCH_SYNTHESIS_POLICY}
You are writing the answer for a "Finding Stress Test": does a Stage 1 finding survive reasonable adjusted-p thresholds?
Write 3-6 sentences, bottom-line-up-front. Open with what the result means for a decision, then the supporting figures, then the most important caveat. Use ONLY the numbers and citations supplied below; never introduce another figure or a file path that is not listed. Explain the verdict in plain language rather than restating its tag. No headings, no markdown, no fabrication.`;
  const user = [
    `Objective: ${answer.objective}`,
    `Verdict: ${answer.verdictLabel}`,
    `Headline (already decided — do not contradict): ${answer.headline}`,
    `Numbers you may cite (and only these):`,
    ...answer.metrics.map((metric) => `  - ${metric.label}: ${metric.value} [${metric.cite.path}${metric.cite.rowIds?.length ? ` rows ${metric.cite.rowIds.slice(0, 8).join(",")}` : ""}]`),
    `Decision implication: ${answer.decisionImplication}`,
    `Limitations: ${answer.limitations.join(" ")}`,
  ].join("\n");
  return { system, user };
}

function fallbackProse(answer: AnswerModel): string {
  return [answer.headline, answer.summary, answer.decisionImplication, `Limitations: ${answer.limitations.join(" ")}`].filter(Boolean).join(" ");
}

export const findingStressTestSynthesis: SynthesisSkill = {
  id: "finding-stress-test-synthesis",
  workflowId: "finding-stress-test",
  version: "1.0.0",
  reads: { computations: [STABILITY_SKILL, EDA_SKILL], families: ["differential-expression"] },
  decide, prompt, fallbackProse,
};
