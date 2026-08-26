import type { AnswerModel } from "./types.js";

/** Security floor — these never reach the user regardless of confidence: scrub
 *  markers, absolute host paths, and key-shaped tokens. A hit forces a fallback. */
const HARD_FLOOR = [/\[REDACTED/i, /\[INTERNAL_PATH\]/i, /\/Users\//, /[A-Za-z]:\\Users\\/, /\bsk-[A-Za-z0-9]{8,}/];

export interface GuardResult {
  groundingConfidence: "high" | "partial";
  unverified: string[];
  hardViolation: boolean;
}

const numericTokens = (value: string) => (value.match(/\d+(?:\.\d+)?/g) || []);
// "0.10" -> "0.1", "2.0" -> "2": compare by numeric identity so trivially
// different spellings of the same figure don't read as fabrication.
const normalize = (token: string) => { const parsed = Number(token); return Number.isFinite(parsed) ? String(parsed) : token; };

/** Confidence annotator, not a rejecter (per review): every figure in the prose
 *  that matches the evidence reads as grounded; figures we cannot match are kept
 *  but surfaced as model-stated. Only the hard floor rejects outright. */
export function validateSynthesisAgainstEvidence(prose: string, answer: AnswerModel): GuardResult {
  if (HARD_FLOOR.some((pattern) => pattern.test(prose))) return { groundingConfidence: "partial", unverified: [], hardViolation: true };

  const allowed = new Set<string>();
  for (const metric of answer.metrics) {
    for (const token of numericTokens(String(metric.value))) allowed.add(normalize(token));
    for (const id of metric.cite.rowIds || []) allowed.add(normalize(String(id)));
  }
  // Thresholds named in the headline/series are legitimate figures too.
  for (const point of answer.chart?.series || []) allowed.add(normalize(point.label));

  const unverified = [...new Set(numericTokens(prose).map(normalize))].filter((token) => !allowed.has(token));
  return { groundingConfidence: unverified.length ? "partial" : "high", unverified, hardViolation: false };
}
