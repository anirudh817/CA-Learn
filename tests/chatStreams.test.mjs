// Deep tests for the per-conversation stream registry.
// Run: node --test tests/chatStreams.test.mjs
//
// These encode the exact regressions from the cross-conversation bleed bug:
// independent accumulation, no cross-talk, finished streams retain state for
// re-projection, and concurrent streams across conversations.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatStreams } from "../frontend/modules/chatStreams.js";

test("start creates active state for a conversation", () => {
  const s = createChatStreams();
  s.start("A");
  assert.equal(s.isActive("A"), true);
  assert.equal(s.get("A").buffer, "");
  assert.equal(s.activeCount(), 1);
});

test("unknown conversation is never active", () => {
  const s = createChatStreams();
  assert.equal(s.isActive("nope"), false);
  assert.equal(s.get("nope"), null);
});

test("BUG REPRO: deltas to one conversation never bleed into another", () => {
  const s = createChatStreams();
  s.start("A");
  s.start("B");
  s.appendDelta("A", "alpha answer ");
  s.appendDelta("A", "continues");
  s.appendDelta("B", "beta");
  assert.equal(s.get("A").buffer, "alpha answer continues");
  assert.equal(s.get("B").buffer, "beta");
});

test("concurrent streams across conversations are both active (independent agents)", () => {
  const s = createChatStreams();
  s.start("A");
  s.start("B");
  assert.equal(s.activeCount(), 2);
  assert.equal(s.isActive("A"), true);
  assert.equal(s.isActive("B"), true);
});

test("finish marks inactive but RETAINS the buffer for re-projection", () => {
  const s = createChatStreams();
  s.start("A");
  s.appendDelta("A", "final answer");
  s.finish("A");
  assert.equal(s.isActive("A"), false);
  assert.equal(s.get("A").buffer, "final answer"); // still recoverable on switch-in
  assert.equal(s.activeCount(), 0);
});

test("tool calls and results are isolated per conversation and matched by id", () => {
  const s = createChatStreams();
  s.start("A");
  s.start("B");
  s.addToolCall("A", { id: "t1", adapter: "read_file_slice", status: "called" });
  s.addToolCall("B", { id: "t2", adapter: "lookup_protein", status: "called" });
  s.patchToolResult("A", "t1", { rows_returned: 30 });
  assert.equal(s.get("A").toolCalls.length, 1);
  assert.equal(s.get("B").toolCalls.length, 1);
  assert.equal(s.get("A").toolCalls[0].result.rows_returned, 30);
  assert.equal(s.get("B").toolCalls[0].result, undefined); // B untouched
});

test("patchToolResult on a missing id is a no-op (no throw)", () => {
  const s = createChatStreams();
  s.start("A");
  assert.equal(s.patchToolResult("A", "ghost", {}), null);
  assert.equal(s.patchToolResult("missing-conv", "t1", {}), null);
});

test("setAsstId / mergeExtras / setRedacted update only the target conversation", () => {
  const s = createChatStreams();
  s.start("A");
  s.start("B");
  s.setAsstId("A", "msg-A");
  s.mergeExtras("A", { model: "claude-sonnet-4-6", input_tokens: 10 });
  s.mergeExtras("A", { output_tokens: 5 });
  s.setRedacted("B", "[refused]");
  assert.equal(s.get("A").asstId, "msg-A");
  assert.deepEqual(s.get("A").extras, { model: "claude-sonnet-4-6", input_tokens: 10, output_tokens: 5 });
  assert.equal(s.get("B").asstId, null);
  assert.equal(s.get("B").redactedText, "[refused]");
  assert.equal(s.get("B").buffer, "[refused]");
});

test("abort calls the controller and deactivates only that conversation", () => {
  const s = createChatStreams();
  let abortedA = false;
  s.start("A", { abort: () => { abortedA = true; } });
  s.start("B", { abort: () => { throw new Error("B should not be aborted"); } });
  s.abort("A");
  assert.equal(abortedA, true);
  assert.equal(s.isActive("A"), false);
  assert.equal(s.isActive("B"), true);
});

test("fail deactivates and records the error", () => {
  const s = createChatStreams();
  s.start("A");
  s.fail("A", new Error("provider down"));
  assert.equal(s.isActive("A"), false);
  assert.ok(s.get("A").error);
});

test("clear removes a conversation's state entirely", () => {
  const s = createChatStreams();
  s.start("A");
  s.finish("A");
  s.clear("A");
  assert.equal(s.has("A"), false);
  assert.equal(s.get("A"), null);
});

test("restarting a conversation resets its buffer (no stale carry-over)", () => {
  const s = createChatStreams();
  s.start("A");
  s.appendDelta("A", "old");
  s.start("A"); // user re-asks in the same conversation
  assert.equal(s.get("A").buffer, "");
  assert.equal(s.isActive("A"), true);
});

test("mutators on an UNKNOWN conversation are safe no-ops (no auto-vivify)", () => {
  const s = createChatStreams();
  assert.equal(s.appendDelta("ghost", "x"), null);
  s.addToolCall("ghost", { id: "t" });
  s.mergeExtras("ghost", { model: "x" });
  s.setRedacted("ghost", "[no]");
  s.setAsstId("ghost", "m");
  // A stray delta for a torn-down conversation must vanish, not create state.
  assert.equal(s.has("ghost"), false);
  assert.equal(s.get("ghost"), null);
});

test("mergeExtras: later values overwrite earlier (no duplication)", () => {
  const s = createChatStreams();
  s.start("A");
  s.mergeExtras("A", { tok: 1 });
  s.mergeExtras("A", { tok: 2, model: "x" });
  assert.equal(s.get("A").extras.tok, 2);
  assert.equal(s.get("A").extras.model, "x");
});

test("setRedacted overwrites an already-accumulated buffer (leak redaction)", () => {
  const s = createChatStreams();
  s.start("A");
  s.appendDelta("A", "leaked internal secret");
  s.setRedacted("A", "[refused]");
  assert.equal(s.get("A").buffer, "[refused]");
  assert.equal(s.get("A").redactedText, "[refused]");
});

test("abort on a stream with no controller deactivates without throwing", () => {
  const s = createChatStreams();
  s.start("A"); // default controller = null
  assert.doesNotThrow(() => s.abort("A"));
  assert.equal(s.isActive("A"), false);
});

test("a late delta after finish appends but does NOT reactivate the stream", () => {
  const s = createChatStreams();
  s.start("A");
  s.finish("A");
  s.appendDelta("A", " trailing");
  assert.equal(s.get("A").buffer, " trailing");
  assert.equal(s.isActive("A"), false);
});
