/** How a finished free-form run is recorded.
 *
 *  The agent's only channel to the user is emit_findings. When the final model turn
 *  errors (stopReason "error" — e.g. the provider injects an error object into the SSE
 *  stream) the Pi agent loop ends WITHOUT throwing and without emit_findings ever being
 *  called, so session.prompt() returns "normally" leaving no findings behind. That is a
 *  crashed run, not an "insufficient-evidence" answer, so it must be recorded as a FAILED
 *  step (exitCode 1): recordPiExecution maps exitCode!==0 → exitStatus "failed", the
 *  service throws, the job is marked failed, and synthesis never runs to mislabel an empty
 *  findings.json as a clean verdict.
 *
 *  A clean stop with no findings (the agent simply chose to stop), or any run that did
 *  emit findings (even if a later turn errored), stays a completed step so valid work is
 *  preserved. Kept dependency-free so the decision is unit-testable in isolation. */
export interface FreeformRunOutcome { exitCode: number; stderr: string; emptyLimitation: string }

/** Whether to re-prompt the live session after a final-turn provider error.
 *
 *  A stopReason "error" with no findings is usually a TRANSIENT provider/stream
 *  hiccup (e.g. OpenRouter injecting an error object) — not the model deciding it
 *  is done. Re-prompting the SAME session resumes all prior context, so we recover
 *  the answer for one more turn instead of discarding a run that already did real
 *  analysis (the difference we observed between a flaky model that failed and a
 *  steadier one that emitted on its own). We retry ONLY on the error path: a clean
 *  stop (the agent chose to stop) or any run that already emitted findings is left
 *  alone, and a closed job (watchdog/abort dropped it from `live`) is never retried.
 *  Pure so the retry policy is unit-testable in isolation, like freeformRunOutcome. */
export function shouldRetryFinalTurn(input: { hasFindings: boolean; lastStopReason?: string; attempt: number; maxRetries: number; jobLive: boolean }): boolean {
  return !input.hasFindings && input.lastStopReason === "error" && input.jobLive && input.attempt <= input.maxRetries;
}

export function freeformRunOutcome(input: { hasFindings: boolean; lastStopReason?: string; lastErrorMessage?: string }): FreeformRunOutcome {
  const failed = !input.hasFindings && input.lastStopReason === "error";
  const stderr = failed
    ? `Free-form agent run did not complete: the final model turn errored (${input.lastErrorMessage || "unknown model/stream error"}) before any findings were recorded.`
    : "";
  return { exitCode: failed ? 1 : 0, stderr, emptyLimitation: failed ? stderr : "The agent did not emit structured findings before stopping." };
}
