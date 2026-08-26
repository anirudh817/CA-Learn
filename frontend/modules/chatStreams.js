// Per-conversation streaming registry — the core of "each chat is its own agent".
//
// The chat used to keep ONE global set of streaming fields (streamingAsstId,
// streamingBuffer, streamingToolCalls, streamController) and paint directly into
// the single shared thread DOM. When the user opened/created another conversation
// mid-stream, that global state was reassigned, so a still-running stream bled
// its tokens into the newly-shown conversation and then blanked it on finish.
//
// This module makes each conversation own an INDEPENDENT stream. Accumulation is
// always per-conversation; the DOM is a *projection* of whichever conversation is
// currently on screen. It is intentionally DOM-free and pure so the isolation
// logic can be unit-tested without a browser.
//
// State shape per conversation:
//   { convId, controller, asstId, buffer, toolCalls[], extras{}, active, error, redactedText }

export function createChatStreams() {
  const streams = new Map();

  function _blank(convId) {
    return {
      convId,
      controller: null,
      asstId: null,
      buffer: "",
      toolCalls: [],
      extras: {},
      active: false,
      error: null,
      redactedText: null,
    };
  }

  return {
    /** Begin a stream for a conversation. Replaces any prior state for it. */
    start(convId, controller = null) {
      const s = _blank(convId);
      s.controller = controller;
      s.active = true;
      streams.set(convId, s);
      return s;
    },

    get(convId) {
      return streams.get(convId) || null;
    },

    has(convId) {
      return streams.has(convId);
    },

    /** True only when this conversation has a stream still in flight. */
    isActive(convId) {
      const s = streams.get(convId);
      return !!(s && s.active);
    },

    activeCount() {
      let n = 0;
      for (const s of streams.values()) if (s.active) n += 1;
      return n;
    },

    setAsstId(convId, asstId) {
      const s = streams.get(convId);
      if (s) s.asstId = asstId;
    },

    appendDelta(convId, text) {
      const s = streams.get(convId);
      if (s) s.buffer += text || "";
      return s || null;
    },

    setBuffer(convId, text) {
      const s = streams.get(convId);
      if (s) s.buffer = text || "";
    },

    addToolCall(convId, toolCall) {
      const s = streams.get(convId);
      if (s) s.toolCalls.push(toolCall);
      return s || null;
    },

    /** Patch a previously-added tool call with its result, matched by id. */
    patchToolResult(convId, toolUseId, result) {
      const s = streams.get(convId);
      if (!s) return null;
      const tc = s.toolCalls.find((t) => t.id === toolUseId);
      if (tc) tc.result = result;
      return tc || null;
    },

    mergeExtras(convId, extras) {
      const s = streams.get(convId);
      if (s && extras) Object.assign(s.extras, extras);
    },

    setRedacted(convId, text) {
      const s = streams.get(convId);
      if (s) {
        s.redactedText = text || "";
        s.buffer = text || "";
      }
    },

    /** Mark the stream finished but KEEP its state (so a switch-in can project it). */
    finish(convId) {
      const s = streams.get(convId);
      if (s) s.active = false;
      return s || null;
    },

    fail(convId, error) {
      const s = streams.get(convId);
      if (s) {
        s.active = false;
        s.error = error || true;
      }
      return s || null;
    },

    /** Abort an in-flight stream (used when a conversation is force-stopped). */
    abort(convId) {
      const s = streams.get(convId);
      if (s && s.controller) {
        try {
          s.controller.abort();
        } catch (_) {
          /* already aborted */
        }
      }
      if (s) s.active = false;
      return s || null;
    },

    /** Drop all state for a conversation (e.g. after it's been persisted+reloaded). */
    clear(convId) {
      streams.delete(convId);
    },
  };
}
