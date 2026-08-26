import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildServer } from "../src/server.js";
import type { RuntimeFrame, TurnRequest } from "../src/runtime.js";

class FakeRuntime {
  async *turn(request: TurnRequest): AsyncGenerator<RuntimeFrame> {
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", delta: `Grounded on ${request.runId}` };
    yield { type: "usage", provider: "openrouter", model: request.model, inputTokens: 3, outputTokens: 4, costUsd: 0.0001 };
    yield { type: "done" };
  }
  async abort(): Promise<void> {}
  async reset(): Promise<void> {}
}

/** Captures trashed zips into a temp dir so the real ~/.Trash is never touched. */
function fakeTrash(dir: string) {
  const trashed: string[] = [];
  const trashFile = async (absolutePath: string) => {
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, path.basename(absolutePath));
    fs.copyFileSync(absolutePath, dest);
    fs.rmSync(absolutePath, { force: true });
    trashed.push(dest);
    return dest;
  };
  return { trashed, trashFile };
}

const zipEntries = (zipPath: string) =>
  execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).split("\n").filter(Boolean);

async function turnAndAttach(app: any, runId: string, conversationId: string, filename: string) {
  await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/turns`, payload: { message: "Summarize the run" } });
  const attach = await app.inject({ method: "POST", url: "/api/attachments", payload: {
    runId, conversationId, name: filename, mimeType: "text/csv", dataBase64: Buffer.from("gene,p\nAPOE,0.01\n").toString("base64"),
  } });
  return attach.json().artifact.relPath as string;
}

test("bulk delete zips chat + Operations Control Center records + artifacts to Trash, then hard-deletes everything", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "signalfold-conv-delete-"));
  fs.mkdirSync(path.join(data, "runs", "RUN-DEL"), { recursive: true });
  fs.writeFileSync(path.join(data, "runs", "RUN-DEL", "artifact_index.json"), "{}");
  const { trashed, trashFile } = fakeTrash(path.join(data, "_test_trash"));
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), runtime: new FakeRuntime(), trashFile });

  const a = (await app.inject({ method: "POST", url: "/api/conversations", payload: { runId: "RUN-DEL", title: "Alpha" } })).json().conversation.id;
  const b = (await app.inject({ method: "POST", url: "/api/conversations", payload: { runId: "RUN-DEL", title: "Beta" } })).json().conversation.id;
  const relA = await turnAndAttach(app, "RUN-DEL", a, "alpha.csv");
  await turnAndAttach(app, "RUN-DEL", b, "beta.csv");

  // Pre-conditions: two conversations, two Operations Control Center turns, artifact files on disk.
  assert.equal((await app.inject({ method: "GET", url: "/api/conversations?runId=RUN-DEL" })).json().conversations.length, 2);
  assert.equal((await app.inject({ method: "GET", url: "/api/operations/turns?runId=RUN-DEL" })).json().turns.length, 2);
  const artifactAbs = path.join(data, "runs", "RUN-DEL", "ai_insights", relA);
  assert.equal(fs.existsSync(artifactAbs), true);

  const res = await app.inject({ method: "POST", url: "/api/conversations/bulk-delete", payload: { ids: [a, b] } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(new Set(res.json().deleted), new Set([a, b]));

  // The zip landed in (fake) Trash and contains the chat, operations, and artifact files.
  assert.equal(trashed.length, 1);
  assert.equal(fs.existsSync(trashed[0]), true);
  assert.equal(fs.statSync(trashed[0]).size > 0, true);
  const entries = zipEntries(trashed[0]).join("\n");
  assert.match(entries, /manifest\.json/);
  assert.match(entries, new RegExp(`${a}/conversation\\.json`));
  assert.match(entries, new RegExp(`${a}/operations/turns\\.json`));
  assert.match(entries, /alpha\.csv/);

  // Post-conditions: chat, Operations Control Center records, and artifact files are gone.
  assert.equal((await app.inject({ method: "GET", url: "/api/conversations?runId=RUN-DEL" })).json().conversations.length, 0);
  assert.equal((await app.inject({ method: "GET", url: `/api/conversations/${a}` })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/operations/turns?runId=RUN-DEL" })).json().turns.length, 0);
  assert.equal((await app.inject({ method: "GET", url: "/api/artifacts?runId=RUN-DEL" })).json().artifacts.length, 0);
  assert.equal(fs.existsSync(artifactAbs), false);
  await app.close();
});

test("single delete also hard-deletes via Trash, and a bad id is reported, not fatal", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "signalfold-conv-delete-one-"));
  fs.mkdirSync(path.join(data, "runs", "RUN-ONE"), { recursive: true });
  fs.writeFileSync(path.join(data, "runs", "RUN-ONE", "artifact_index.json"), "{}");
  const { trashed, trashFile } = fakeTrash(path.join(data, "_test_trash"));
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), runtime: new FakeRuntime(), trashFile });

  const id = (await app.inject({ method: "POST", url: "/api/conversations", payload: { runId: "RUN-ONE", title: "Solo" } })).json().conversation.id;
  await app.inject({ method: "POST", url: `/api/conversations/${id}/turns`, payload: { message: "Hello" } });

  const del = await app.inject({ method: "DELETE", url: `/api/conversations/${id}` });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().ok, true);
  assert.equal(trashed.length, 1);
  assert.equal((await app.inject({ method: "GET", url: `/api/conversations/${id}` })).statusCode, 404);

  // Unknown ids 404 rather than throwing; no zip is produced for an empty batch.
  assert.equal((await app.inject({ method: "DELETE", url: "/api/conversations/conv_missing" })).statusCode, 404);
  const bulkMissing = await app.inject({ method: "POST", url: "/api/conversations/bulk-delete", payload: { ids: ["conv_missing"] } });
  assert.equal(bulkMissing.statusCode, 404);
  assert.equal(trashed.length, 1);
  await app.close();
});
