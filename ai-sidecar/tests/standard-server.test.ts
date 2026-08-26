import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildServer } from "../src/server.js";
import type { Runtime, RuntimeFrame, TurnRequest } from "../src/runtime.js";

class GroundedRuntime implements Runtime {
  requests: TurnRequest[] = [];
  async *turn(request: TurnRequest): AsyncGenerator<RuntimeFrame> {
    this.requests.push(request);
    yield { type: "operation", event: { category: "grounding", name: "grounding_selected", status: "complete", payload: {
      route: "lookup", includedBytes: 120,
      files: [{ path: "stage1/variant.csv", family: "differential-expression", score: 13, rowsReturned: 1, truncated: false }],
      citations: [{ filePath: "stage1/variant.csv", rowIds: [42], artifactFamily: "differential-expression" }],
    } } };
    yield { type: "text_delta", delta: "APOE is supported by the selected row [stage1/variant.csv, row 42]." };
    yield { type: "usage", provider: "openrouter", model: request.model, inputTokens: 12, uncachedInputTokens: 12, cacheWriteTokens: 30, cacheReadTokens: 80, totalContextTokens: 122, modelCalls: 2, outputTokens: 7, costUsd: 0.001 };
    yield { type: "done" };
  }
  async abort() {}
  async reset() {}
  diagnostics() { return { implementation: "GroundedRuntime", activeSessions: 0, sessions: [], registeredTools: [], skills: [] }; }
}

test("attachments and pins reach Standard while citations and provenance persist and export", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "sf-standard-server-"));
  const run = path.join(data, "runs", "RUN-STANDARD");
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, "artifact_index.json"), "{}");
  const runtime = new GroundedRuntime();
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), runtime });
  const created = await app.inject({ method: "POST", url: "/api/conversations", payload: { runId: "RUN-STANDARD", policy: "standard", model: "openrouter/test/model" } });
  const conversationId = created.json().conversation.id;
  const uploaded = await app.inject({ method: "POST", url: "/api/attachments", payload: {
    runId: "RUN-STANDARD", conversationId, name: "authoritative.csv", mimeType: "text/csv",
    dataBase64: Buffer.from("gene,value\nAPOE,attached\n").toString("base64"),
  } });
  const attachmentId = uploaded.json().artifact.id;

  await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/turns`, payload: { message: "Check APOE", attachmentIds: [attachmentId] } });
  assert.match(runtime.requests[0].message, /<untrusted_attachment/);
  assert.match(runtime.requests[0].message, /APOE,attached/);
  const thread = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}` });
  const assistant = thread.json().messages.find((message: any) => message.role === "assistant");
  assert.deepEqual(assistant.citations, [{ filePath: "stage1/variant.csv", rowIds: [42], artifactFamily: "differential-expression" }]);
  assert.equal(assistant.provenance[0].path, "stage1/variant.csv");

  await app.inject({ method: "POST", url: `/api/messages/${assistant.id}/pin`, payload: { pinned: true } });
  await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/turns`, payload: { message: "Follow up" } });
  assert.equal(runtime.requests[1].history?.some((message) => message.pinned && message.content.includes("APOE is supported")), true);

  const exported = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}/export` });
  assert.match(exported.body, /stage1\/variant\.csv \(rows 42\)/);
  assert.match(exported.body, /run-artifact/);
  await app.close();
});

test("@-mentions inject allowlisted run files + uploads into Standard context and reject unknown paths", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "sf-mention-"));
  const run = path.join(data, "runs", "RUN-MENTION");
  fs.mkdirSync(path.join(run, "stage1"), { recursive: true });
  fs.writeFileSync(path.join(run, "artifact_index.json"), "{}");
  fs.writeFileSync(path.join(run, "stage1", "variant.csv"), "gene,value\nAPOE,CONTEXT_MARKER\n");
  const runtime = new GroundedRuntime();
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), runtime });
  const conversationId = (await app.inject({ method: "POST", url: "/api/conversations", payload: { runId: "RUN-MENTION", policy: "standard", model: "openrouter/test/model" } })).json().conversation.id;
  const uploaded = await app.inject({ method: "POST", url: "/api/attachments", payload: { runId: "RUN-MENTION", conversationId, name: "upload.csv", mimeType: "text/csv", dataBase64: Buffer.from("k,v\nx,UPLOAD_MARKER\n").toString("base64") } });
  const relPath = uploaded.json().artifact.relPath;

  await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/turns`, payload: { message: "Look at the referenced files", mentions: [
    { scope: "context", path: "stage1/variant.csv" },
    { scope: "myfiles", path: `ai_insights/${relPath}` },
    { scope: "context", path: "../../../etc/passwd" },
  ] } });
  const message = runtime.requests[0].message;
  assert.match(message, /@context\/variant\.csv/);
  assert.match(message, /CONTEXT_MARKER/);
  assert.match(message, /@myfiles\/[\w-]*upload\.csv/); // uploads carry a uuid-prefixed name
  assert.match(message, /UPLOAD_MARKER/);
  assert.doesNotMatch(message, /passwd/); // out-of-allowlist mention is dropped
  await app.close();
});
