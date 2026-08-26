import type { SynthesisSkill } from "./types.js";
import { findingStressTestSynthesis } from "./workflows/finding-stress-test.js";
import { freeformSynthesis } from "./generic.js";

/** Synthesis skills keyed by workflowId. The registry is the seam where each
 *  workflow attaches its own decide()/prompt() without touching the engine or
 *  service layer. finding-stress-test is the structured baseline; freeform is the
 *  generic decider for the unconstrained agentic arm. */
export const synthesisRegistry: Record<string, SynthesisSkill> = {
  [findingStressTestSynthesis.workflowId]: findingStressTestSynthesis,
  [freeformSynthesis.workflowId]: freeformSynthesis,
};

export function getSynthesisSkill(workflowId: string): SynthesisSkill | undefined {
  return synthesisRegistry[workflowId];
}
