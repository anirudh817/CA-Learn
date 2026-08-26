import assert from "node:assert/strict";
import test from "node:test";
import { freeformRunOutcome, shouldRetryFinalTurn } from "../src/research/freeform-outcome.js";

// Regression for the "insufficient-evidence" mislabel: a free-form run whose FINAL
// model turn errored (e.g. OpenRouter "JSON error injected into SSE stream") ends the
// Pi loop before emit_findings is ever called. It must be recorded as a failed step,
// not an empty findings.json that synthesis then labels a clean "insufficient-evidence".

test("errored final turn with no findings → FAILED step carrying the real provider error", () => {
  const o = freeformRunOutcome({ hasFindings: false, lastStopReason: "error", lastErrorMessage: "JSON error injected into SSE stream" });
  assert.equal(o.exitCode, 1, "exitCode!==0 routes recordPiExecution → exitStatus failed → job failed");
  assert.match(o.stderr, /final model turn errored/);
  assert.match(o.stderr, /JSON error injected into SSE stream/, "surfaces the real provider error");
  assert.equal(o.emptyLimitation, o.stderr, "the empty findings.json marker carries the real error, not the generic message");
});

test("errored final turn with a missing error message still fails, with a fallback reason", () => {
  const o = freeformRunOutcome({ hasFindings: false, lastStopReason: "error" });
  assert.equal(o.exitCode, 1);
  assert.match(o.stderr, /unknown model\/stream error/);
});

test("clean stop with no findings stays a COMPLETED step (legit insufficient-evidence path)", () => {
  const o = freeformRunOutcome({ hasFindings: false, lastStopReason: "stop" });
  assert.equal(o.exitCode, 0);
  assert.equal(o.stderr, "");
  assert.equal(o.emptyLimitation, "The agent did not emit structured findings before stopping.");
});

test("a run that emitted findings completes even if a later turn errored (valid work preserved)", () => {
  const o = freeformRunOutcome({ hasFindings: true, lastStopReason: "error", lastErrorMessage: "x" });
  assert.equal(o.exitCode, 0);
  assert.equal(o.stderr, "");
});

test("undefined stopReason (no turns / abnormal teardown) does not spuriously fail", () => {
  const o = freeformRunOutcome({ hasFindings: false, lastStopReason: undefined });
  assert.equal(o.exitCode, 0);
});

// Recovery policy: re-prompt the live session ONLY on a transient final-turn error that
// left no findings — the case where a flaky provider would otherwise discard real work.
const retryBase = { hasFindings: false, lastStopReason: "error", attempt: 1, maxRetries: 2, jobLive: true };

test("errored final turn with no findings, job still live, within budget → retry", () => {
  assert.equal(shouldRetryFinalTurn(retryBase), true);
});

test("findings already emitted → never retry (work is preserved, don't burn a turn)", () => {
  assert.equal(shouldRetryFinalTurn({ ...retryBase, hasFindings: true }), false);
});

test("clean stop / aborted with no findings → not the error path, do not retry", () => {
  assert.equal(shouldRetryFinalTurn({ ...retryBase, lastStopReason: "stop" }), false);
  assert.equal(shouldRetryFinalTurn({ ...retryBase, lastStopReason: "aborted" }), false);
  assert.equal(shouldRetryFinalTurn({ ...retryBase, lastStopReason: undefined }), false);
});

test("job closed (watchdog/abort dropped it from live) → do not retry into a dead jail", () => {
  assert.equal(shouldRetryFinalTurn({ ...retryBase, jobLive: false }), false);
});

test("retry budget is bounded: stops once attempt exceeds maxRetries", () => {
  assert.equal(shouldRetryFinalTurn({ ...retryBase, attempt: 2, maxRetries: 2 }), true);
  assert.equal(shouldRetryFinalTurn({ ...retryBase, attempt: 3, maxRetries: 2 }), false);
  assert.equal(shouldRetryFinalTurn({ ...retryBase, attempt: 1, maxRetries: 0 }), false, "retries disabled (maxRetries 0) never fires");
});
