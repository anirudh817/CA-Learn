import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildServer } from "../src/server.js";
import type { ResearchPiExecutionPlane, ResearchPiStepRequest } from "../src/research/pi-executor.js";

/** Deterministic, offline Pi execution plane: writes a real output file per step
 *  so jobs complete + emit deliverables without a key or the network. Mirrors the
 *  stub used in research.test.ts. */
function fakePi(): ResearchPiExecutionPlane {
  return { executeStep: async (request: ResearchPiStepRequest) => {
    const outputDir = path.join(request.jobRoot, "workspace", "outputs"); fs.mkdirSync(outputDir, { recursive: true });
    const name = request.skillId === "stage1-finding-stability" ? "threshold-sensitivity.csv" : request.skillId === "scientific-visualization" ? "research-summary.svg" : "eda-summary.md";
    const content = request.skillId === "stage1-finding-stability" ? "threshold,features_passing\n0.01,1\n0.05,2\n0.1,2\n" : request.skillId === "scientific-visualization" ? "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>" : "# EDA\nRows and columns inspected.\n";
    fs.writeFileSync(path.join(outputDir, name), content);
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    return { sessionId: `fake-pi-${request.jobId}`, loadedSkills: request.allowedSkills, activatedSkills: [request.skillId], modelTurns: 1, costUsd: 0,
      receipts: [{ schemaVersion: "1.0", jobId: request.jobId, stepId: request.stepId, piSessionId: `fake-pi-${request.jobId}`, reasoningProfiles: request.reasoningProfiles, approvedSkills: request.allowedSkills, activatedSkill: request.skillId,
        skillMdPath: `scientific/${request.skillId}/SKILL.md`, skillMdHash: "a".repeat(64), upstreamRepository: "test", upstreamCommit: "b".repeat(40), skillFolderHash: "c".repeat(64), executable: { type: request.skillId === "stage1-finding-stability" ? "custom-tool" : "script", identity: request.entrypoint, arguments: [] },
        environment: { id: "test", lockHash: "d".repeat(64), python: "test" }, inputs: request.scope.artifacts.map((item) => ({ path: item.path, sha256: item.sha256 })), outputs: [{ path: `outputs/${name}`, mimeType: name.endsWith(".csv") ? "text/csv" : name.endsWith(".svg") ? "image/svg+xml" : "text/markdown", bytes: Buffer.byteLength(content), sha256 }],
        determinism: "deterministic", networkPolicy: "offline", externalActivity: "none", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1, exitCode: 0, timedOut: false, stdout: "", stderr: "" }] };
  }};
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

/** A complete run with the minimal evidence Deep Research scopes + computes on. */
function researchFixture() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "sf-research-delete-"));
  const run = path.join(data, "runs", "RUN-RESEARCH");
  fs.mkdirSync(path.join(run, "stage1"), { recursive: true });
  fs.mkdirSync(path.join(run, "stage2"), { recursive: true });
  fs.writeFileSync(path.join(run, "artifact_index.json"), JSON.stringify({ artifacts: [
    { rel_path: "stage1/volcano_results.tsv", artifact_family: "tables.variant", stage: "stage1" },
    { rel_path: "stage2/go_enrichment_all.csv", artifact_family: "tables.variant", stage: "stage2" },
  ] }));
  fs.writeFileSync(path.join(run, "config_stage1.json"), JSON.stringify({ test_method: "welch", p_adjust: "BH", adjusted_p_cutoff: 0.05 }));
  fs.writeFileSync(path.join(run, "config_stage2.json"), JSON.stringify({ method: "Fisher exact", universe: "measured", fdr_scope: "global" }));
  fs.writeFileSync(path.join(run, "stage1", "volcano_results.tsv"), [
    "gene\tlog2fc\tpvalue\tadj_pvalue\tdirection", "APOE\t1.4\t0.0001\t0.002\tup", "CLU\t0.7\t0.02\t0.04\tup", "APP\t0.2\t0.3\t0.5\tup",
  ].join("\n"));
  fs.writeFileSync(path.join(run, "stage2", "go_enrichment_all.csv"), [
    "module,term,category,pvalue,fdr,hit_genes", "turquoise,lipid transport,BP,0.0001,0.002,APOE;APP", "blue,immune response,BP,0.01,0.04,CLU",
  ].join("\n"));
  return { data };
}

/** Plan -> approve -> run -> completion for one offline job; returns its id. */
async function runJob(app: Awaited<ReturnType<typeof buildServer>>, workflowId: string, objective: string) {
  const created = await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId: "RUN-RESEARCH", workflowId, objective, budgetUsd: 0 } });
  assert.equal(created.statusCode, 201, created.body);
  const jobId = created.json().job.id as string;
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/plan`, payload: {} });
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/approve`, payload: {} });
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/run`, headers: { "idempotency-key": `del-${jobId}` }, payload: {} });
  let job: any;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    job = (await app.inject({ method: "GET", url: `/api/research/jobs/${jobId}` })).json();
    if (["completed", "failed"].includes(job.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(job.state, "completed", `job did not complete: ${job?.error}`);
  return jobId;
}

const jobIds = async (app: Awaited<ReturnType<typeof buildServer>>) =>
  ((await app.inject({ method: "GET", url: "/api/research/jobs?runId=RUN-RESEARCH" })).json().jobs as any[]).map((job) => job.id);
const occResearch = async (app: Awaited<ReturnType<typeof buildServer>>) =>
  (await app.inject({ method: "GET", url: "/api/operations/research?runId=RUN-RESEARCH" })).json();
const jobArtifacts = async (app: Awaited<ReturnType<typeof buildServer>>, jobId: string) =>
  ((await app.inject({ method: "GET", url: "/api/artifacts?runId=RUN-RESEARCH" })).json().artifacts as any[]).filter((item) => item.relPath.includes(`research/jobs/${jobId}/`));
const jobDir = (data: string, jobId: string) => path.join(data, "runs", "RUN-RESEARCH", "ai_insights", "research", "jobs", jobId);

test("DELETE a research job zips it to Trash, then removes it from the app, the OCC, disk, and the artifact index", async () => {
  const { data } = researchFixture();
  const { trashed, trashFile } = fakeTrash(path.join(data, "_test_trash"));
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), trashFile, researchExecutionPlane: fakePi() });

  const jobId = await runJob(app, "finding-stress-test", "Is APOE differential expression stable?");

  // Pre-conditions: visible in the jobs list, the OCC, the artifact index, and on disk.
  assert.deepEqual(await jobIds(app), [jobId]);
  const occBefore = await occResearch(app);
  assert.equal(occBefore.enabled, true);
  assert.ok(occBefore.jobs.some((job: any) => job.id === jobId), "job missing from OCC before delete");
  assert.equal(occBefore.summary.jobs, 1);
  assert.ok((await jobArtifacts(app, jobId)).length > 0, "no registered artifacts before delete");
  assert.equal(fs.existsSync(jobDir(data, jobId)), true);

  const del = await app.inject({ method: "DELETE", url: `/api/research/jobs/${jobId}` });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().ok, true);

  // The zip landed in (fake) Trash and carries the job metadata + deliverable files.
  assert.equal(trashed.length, 1);
  assert.equal(fs.statSync(trashed[0]).size > 0, true);
  const entries = zipEntries(trashed[0]).join("\n");
  assert.match(entries, /manifest\.json/);
  assert.match(entries, new RegExp(`${jobId}/job\\.json`));
  assert.match(entries, new RegExp(`${jobId}/files/`));

  // Post-conditions: gone from the jobs list, the OCC, the artifact index, and disk.
  assert.deepEqual(await jobIds(app), []);
  const occAfter = await occResearch(app);
  assert.equal(occAfter.jobs.some((job: any) => job.id === jobId), false);
  assert.equal(occAfter.summary.jobs, 0);
  assert.equal((await jobArtifacts(app, jobId)).length, 0);
  assert.equal(fs.existsSync(jobDir(data, jobId)), false);
  assert.equal((await app.inject({ method: "GET", url: `/api/research/jobs/${jobId}` })).statusCode, 404);

  // An unknown id 404s rather than throwing, and produces no extra zip.
  assert.equal((await app.inject({ method: "DELETE", url: "/api/research/jobs/research_missing" })).statusCode, 404);
  assert.equal(trashed.length, 1);
  await app.close();
});

test("bulk-delete removes every selected research job from the app + OCC; bad input is reported, not fatal", async () => {
  const { data } = researchFixture();
  const { trashed, trashFile } = fakeTrash(path.join(data, "_test_trash"));
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), trashFile, researchExecutionPlane: fakePi() });

  const a = await runJob(app, "finding-stress-test", "Stability of APOE — run A");
  const b = await runJob(app, "ranked-pathway-investigation", "Pathway ranking — run B");
  assert.equal((await occResearch(app)).summary.jobs, 2);

  const res = await app.inject({ method: "POST", url: "/api/research/jobs/bulk-delete", payload: { ids: [a, b] } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(new Set(res.json().deleted), new Set([a, b]));
  assert.equal(trashed.length, 1, "one batch zip for the whole selection");

  assert.deepEqual(await jobIds(app), []);
  const occAfter = await occResearch(app);
  assert.equal(occAfter.summary.jobs, 0);
  assert.equal(occAfter.jobs.length, 0);
  assert.equal(fs.existsSync(jobDir(data, a)), false);
  assert.equal(fs.existsSync(jobDir(data, b)), false);

  // Empty selection is a 400; an all-unknown selection is a 404; neither makes a zip.
  assert.equal((await app.inject({ method: "POST", url: "/api/research/jobs/bulk-delete", payload: { ids: [] } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/research/jobs/bulk-delete", payload: { ids: ["research_missing"] } })).statusCode, 404);
  assert.equal(trashed.length, 1);
  await app.close();
});
