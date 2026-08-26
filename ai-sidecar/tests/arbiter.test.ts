import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import { buildServer } from "../src/server.js";
import type { Narrator } from "../src/research/synthesis/narrator.js";
import type { ResearchPiExecutionPlane, ResearchPiStepRequest } from "../src/research/pi-executor.js";
import { ARBITER_ROLE_IDS, composeArbiterPrompt } from "../src/research/arbiter.js";

// --- Test doubles (mirrors tests/research.test.ts; kept local so this file is self-contained) ---

function fakePi(): ResearchPiExecutionPlane {
  return { executeStep: async (request: ResearchPiStepRequest) => {
    const workspace = path.join(request.jobRoot, "workspace");
    const outputDir = path.join(workspace, "outputs"); fs.mkdirSync(outputDir, { recursive: true });
    const name = request.skillId === "stage1-finding-stability" ? "threshold-sensitivity.csv" : request.skillId === "scientific-visualization" ? "research-summary.svg" : request.skillId === "signalfold-workflow-recipes" ? `${String(request.parameters.recipe)}.csv` : "eda-summary.md";
    const content = request.skillId === "stage1-finding-stability" ? "threshold,features_passing\n0.01,1\n0.05,2\n0.1,2\n" : request.skillId === "scientific-visualization" ? "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>" : request.skillId === "signalfold-workflow-recipes" ? "result,status\nreviewed,complete\n" : "# EDA\nRows and columns inspected.\n";
    const file = path.join(outputDir, name); fs.writeFileSync(file, content);
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    return { sessionId: `fake-pi-${request.jobId}`, loadedSkills: request.allowedSkills, activatedSkills: [request.skillId], modelTurns: 1, costUsd: 0,
      receipts: [{ schemaVersion: "1.0", jobId: request.jobId, stepId: request.stepId, piSessionId: `fake-pi-${request.jobId}`, reasoningProfiles: request.reasoningProfiles, approvedSkills: request.allowedSkills, activatedSkill: request.skillId,
        skillMdPath: `scientific/${request.skillId}/SKILL.md`, skillMdHash: "a".repeat(64), upstreamRepository: "test", upstreamCommit: "b".repeat(40), skillFolderHash: "c".repeat(64), executable: { type: request.skillId === "stage1-finding-stability" ? "custom-tool" : "script", identity: request.entrypoint, arguments: [] },
        environment: { id: "test", lockHash: "d".repeat(64), python: "test" }, inputs: request.scope.artifacts.map((item) => ({ path: item.path, sha256: item.sha256 })), outputs: [{ path: `outputs/${name}`, mimeType: name.endsWith(".csv") ? "text/csv" : name.endsWith(".svg") ? "image/svg+xml" : "text/markdown", bytes: Buffer.byteLength(content), sha256 }],
        determinism: "deterministic", networkPolicy: "offline", externalActivity: "none", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1, exitCode: 0, timedOut: false, stdout: "", stderr: "" }] };
  }};
}

function fakeNarrator(text: string): Narrator {
  return {
    available: () => true,
    pickModel: () => "anthropic/claude-sonnet-4-5",
    estimateCostUsd: async () => 0.001,
    complete: async () => ({ text, model: "anthropic/claude-sonnet-4-5", costUsd: 0.001 }),
  };
}

async function pollJob(app: Awaited<ReturnType<typeof buildServer>>, jobId: string) {
  let job: any;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    job = (await app.inject({ method: "GET", url: `/api/research/jobs/${jobId}` })).json();
    if (["completed", "failed"].includes(job.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return job;
}

function researchFixture() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "sf-arbiter-"));
  const run = path.join(data, "runs", "RUN-RESEARCH");
  fs.mkdirSync(path.join(run, "stage1"), { recursive: true });
  fs.mkdirSync(path.join(run, "stage2"), { recursive: true });
  fs.writeFileSync(path.join(run, "artifact_index.json"), JSON.stringify({ artifacts: [
    { rel_path: "stage1/volcano_results.tsv", artifact_family: "tables.variant", stage: "stage1" },
    { rel_path: "stage1/module_assignments.csv", artifact_family: "tables.variant", stage: "stage1" },
    { rel_path: "stage1/kme_matrix.csv", artifact_family: "tables.variant", stage: "stage1" },
    { rel_path: "stage1/normalized_matrix.csv", artifact_family: "tables.variant", stage: "stage1" },
    { rel_path: "stage1/sample_metadata.csv", artifact_family: "tables.variant", stage: "stage1" },
    { rel_path: "stage2/go_enrichment_all.csv", artifact_family: "tables.variant", stage: "stage2" },
  ] }));
  fs.writeFileSync(path.join(run, "config_stage1.json"), JSON.stringify({ test_method: "welch", p_adjust: "BH", adjusted_p_cutoff: 0.05 }));
  fs.writeFileSync(path.join(run, "config_stage2.json"), JSON.stringify({ method: "Fisher exact", universe: "measured", fdr_scope: "global" }));
  fs.writeFileSync(path.join(run, "stage1", "volcano_results.tsv"), [
    "gene\tlog2fc\tpvalue\tadj_pvalue\tdirection", "APOE\t1.4\t0.0001\t0.002\tup", "CLU\t0.7\t0.02\t0.04\tup", "APP\t0.2\t0.3\t0.5\tup",
  ].join("\n"));
  fs.writeFileSync(path.join(run, "stage1", "module_assignments.csv"), ["gene,module,kME", "APOE,turquoise,0.91", "APP,turquoise,0.82", "CLU,blue,0.88"].join("\n"));
  fs.writeFileSync(path.join(run, "stage1", "kme_matrix.csv"), ["gene,module,kME_turquoise,kME_blue", "APOE,turquoise,0.91,0.1", "APP,turquoise,0.82,0.2", "CLU,blue,0.1,0.88"].join("\n"));
  fs.writeFileSync(path.join(run, "stage1", "normalized_matrix.csv"), ["gene,S1,S2,S3,S4", "APOE,2,3,5,6", "APP,1,2,2,4", "CLU,5,4,3,2"].join("\n"));
  fs.writeFileSync(path.join(run, "stage1", "sample_metadata.csv"), ["sample,group", "S1,control", "S2,control", "S3,case", "S4,case"].join("\n"));
  fs.writeFileSync(path.join(run, "stage2", "go_enrichment_all.csv"), [
    "module,term,category,pvalue,fdr,hit_genes", "turquoise,lipid transport,BP,0.0001,0.002,APOE;APP", "blue,immune response,BP,0.01,0.04,CLU",
  ].join("\n"));
  return { data, run };
}

async function runBaseJob(app: Awaited<ReturnType<typeof buildServer>>, model: string) {
  const created = await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId: "RUN-RESEARCH", workflowId: "finding-stress-test", objective: "Is APOE stable?", model, budgetUsd: 1 } });
  const jobId = created.json().job.id;
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/plan`, payload: {} });
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/approve`, payload: {} });
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/run`, payload: {} });
  const job = await pollJob(app, jobId);
  assert.equal(job.state, "completed", "base research job did not complete");
  return jobId;
}

// --- Pure template layer ---

test("every arbiter template substitutes {SOURCES} and exposes a stable id set", () => {
  assert.deepEqual(ARBITER_ROLE_IDS, ["distill", "critique", "counsel", "steelman", "extend", "contrast", "referee"]);
  for (const roleId of ARBITER_ROLE_IDS) {
    const prompt = composeArbiterPrompt(roleId, "SRC-BLOCK");
    assert.ok(!prompt.includes("{SOURCES}"), `${roleId} left an unsubstituted placeholder`);
    assert.ok(prompt.includes("SRC-BLOCK"), `${roleId} dropped the sources block`);
  }
  assert.throws(() => composeArbiterPrompt("nope", "x"), /Unknown arbiter role/);
});

// --- In-thread re-run ---

test("in-thread re-run threads a child run into the same conversation (no separate top-level job)", async () => {
  const { data } = researchFixture();
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), researchExecutionPlane: fakePi(), researchNarrator: fakeNarrator("APOE is the strongest signal; prioritize it.") });
  const jobId = await runBaseJob(app, "openrouter/model-a");

  const res = await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/rerun-thread`, payload: { model: "openrouter/model-b" } });
  assert.equal(res.statusCode, 200, res.body);
  const msgs = res.json().conversation.messages;
  const last = msgs.at(-1);
  assert.equal(last.role, "assistant");
  assert.equal(last.outcome, "rerun");
  assert.ok(last.childJobId, "re-run records the child job id on the assistant message");
  assert.equal(msgs.at(-2).outcome, "rerun_request", "the user-intent message precedes the re-run");

  const child = (await app.inject({ method: "GET", url: `/api/research/jobs/${last.childJobId}` })).json();
  assert.equal(child.parentJobId, jobId, "re-run child is parented to the original job");
  assert.equal(child.model, "openrouter/model-b", "re-run honors the chosen model");
  const done = await pollJob(app, last.childJobId);
  assert.equal(done.state, "completed");

  // The re-run lives in the ORIGINAL job's conversation — it is not a new top-level
  // conversation the UI navigated to.
  const parent = (await app.inject({ method: "GET", url: `/api/research/jobs/${jobId}` })).json();
  assert.ok(parent.conversation.messages.some((m: any) => m.outcome === "rerun" && m.childJobId === last.childJobId), "parent thread carries the re-run");
  await app.close();
});

// --- Arbiter gating + happy path ---

test("Arbiter is blocked until two or more distinct models have answered", async () => {
  const { data } = researchFixture();
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), researchExecutionPlane: fakePi(), researchNarrator: fakeNarrator("APOE leads.") });
  const jobId = await runBaseJob(app, "openrouter/model-a");
  const blocked = await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/arbiter`, payload: { role: "distill", model: "openrouter/arbiter" } });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.match(blocked.body, /at least two models/);
  await app.close();
});

test("Arbiter runs a role over the thread's model answers and threads the synthesis (cost folds into spend)", async () => {
  const { data } = researchFixture();
  const synthText = "COUNCIL VERDICT: both models converge on APOE; prioritize it, replicate CLU.";
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), researchExecutionPlane: fakePi(), researchNarrator: fakeNarrator(synthText) });
  const jobId = await runBaseJob(app, "openrouter/model-a");

  // Add a second model's answer via an in-thread re-run, and wait for it to complete.
  const rr = await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/rerun-thread`, payload: { model: "openrouter/model-b" } });
  const childId = rr.json().conversation.messages.at(-1).childJobId;
  assert.equal((await pollJob(app, childId)).state, "completed");

  const spendBefore = (await app.inject({ method: "GET", url: `/api/research/jobs/${jobId}` })).json().spendUsd;

  // Unknown role is rejected before any model call.
  const badRole = await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/arbiter`, payload: { role: "nope", model: "openrouter/arbiter" } });
  assert.equal(badRole.statusCode, 409);
  assert.match(badRole.body, /Unknown arbiter role/);

  const res = await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/arbiter`, payload: { role: "referee", model: "openrouter/arbiter" } });
  assert.equal(res.statusCode, 200, res.body);
  const last = res.json().conversation.messages.at(-1);
  assert.equal(last.role, "assistant");
  assert.equal(last.outcome, "arbiter");
  assert.equal(last.content, synthText, "arbiter threads the model's synthesis verbatim");
  assert.equal(last.requestedModel, "openrouter/arbiter", "arbiter honors the selected model");
  assert.equal(last.sourcePolicy.arbiterRole, "referee", "the chosen role is recorded for the UI label");
  assert.ok(last.costUsd > 0, "arbiter records its model cost");
  const receipt = (last.receipts || []).find((r: any) => r.kind === "arbiter");
  assert.ok(receipt, "an arbiter receipt is written");
  assert.ok(receipt.models.length >= 2, "the receipt lists at least two source models");

  // The arbiter's model cost is folded into the parent job's spend.
  const after = (await app.inject({ method: "GET", url: `/api/research/jobs/${jobId}` })).json();
  assert.ok(after.spendUsd > spendBefore, "arbiter spend is folded into the job total");
  await app.close();
});

test("an in-thread re-run does NOT appear as a top-level row in the DR rail or the OCC list", async () => {
  const { data } = researchFixture();
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), researchExecutionPlane: fakePi(), researchNarrator: fakeNarrator("APOE leads.") });
  const jobId = await runBaseJob(app, "openrouter/model-a");

  const rr = await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/rerun-thread`, payload: { model: "openrouter/model-b" } });
  const childId = rr.json().conversation.messages.at(-1).childJobId;
  assert.equal((await pollJob(app, childId)).state, "completed");

  // Rail: the DR job list for the run shows the parent but NOT the re-run child.
  const railIds = (await app.inject({ method: "GET", url: "/api/research/jobs?runId=RUN-RESEARCH" })).json().jobs.map((j: any) => j.id);
  assert.ok(railIds.includes(jobId), "parent investigation is still in the rail");
  assert.ok(!railIds.includes(childId), "re-run child must not surface as its own rail row");

  // OCC list: same — parent listed, re-run child excluded.
  const occIds = (await app.inject({ method: "GET", url: "/api/operations/research?runId=RUN-RESEARCH" })).json().jobs.map((j: any) => j.id);
  assert.ok(occIds.includes(jobId), "parent investigation is still in the OCC list");
  assert.ok(!occIds.includes(childId), "re-run child must not surface as its own OCC row");

  // But it is still reachable: threaded under the parent, and drill-in-able by id.
  const parent = (await app.inject({ method: "GET", url: `/api/research/jobs/${jobId}` })).json();
  assert.ok(parent.conversation.messages.some((m: any) => m.outcome === "rerun" && m.childJobId === childId), "re-run still threads under the parent");
  const occSingle = (await app.inject({ method: "GET", url: `/api/operations/research/${childId}` })).json();
  assert.equal(occSingle.id, childId, "re-run child is still auditable by direct id");
  await app.close();
});
