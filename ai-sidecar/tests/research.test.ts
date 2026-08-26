import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildResearchScopeManifest, verifyResearchScopeManifest } from "../src/grounding/research-scope.js";
import { FilesystemRunCatalog } from "../src/run-catalog.js";
import { buildServer } from "../src/server.js";
import { validateResearchClaim } from "../src/research/evidence.js";
import type { ExternalLookup } from "../src/research/external.js";
import type { Narrator } from "../src/research/synthesis/narrator.js";
import { validateSynthesisAgainstEvidence } from "../src/research/synthesis/guard.js";
import type { ResearchPiExecutionPlane, ResearchPiStepRequest } from "../src/research/pi-executor.js";
import crypto from "node:crypto";

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

// Deterministic narrator stub: returns canned prose so the model-narration path
// is exercised without a key or the network.
function fakeNarrator(text: string): Narrator {
  return {
    available: () => true,
    pickModel: () => "anthropic/claude-sonnet-4-5",
    estimateCostUsd: async () => 0.001,
    complete: async () => ({ text, model: "anthropic/claude-sonnet-4-5", costUsd: 0.001 }),
  };
}

// Deterministic, offline external arm: records every call and returns a hit so
// the corroboration path is exercised without touching the network.
function fakeExternal(): { lookup: ExternalLookup; calls: Array<{ source: string; term: string }> } {
  const calls: Array<{ source: string; term: string }> = [];
  const lookup: ExternalLookup = async ({ source, term }) => {
    calls.push({ source, term });
    return { source, term, operation: "literature-search", ok: true, status: "ok", summary: `fake ${source} hit for ${term}`, url: `https://example.test/${encodeURIComponent(term)}`, count: 3, citations: [{ title: `${source} record`, id: "1", url: "https://example.test/1", verified: true }], fetchedAt: "2026-06-23T00:00:00.000Z", snapshot: { schemaVersion: "1.0", source, operation: "literature-search", querySha256: "a".repeat(64), responseSha256: "b".repeat(64), requestUrl: "https://example.test", adapterVersion: "test-v1", citationsVerified: true, quarantined: false, fetchedAt: "2026-06-23T00:00:00.000Z" } };
  };
  return { lookup, calls };
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
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "sf-research-"));
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

test("ResearchScopeManifest shares adaptive retrieval and freezes rows, configs, hashes, and exclusions", () => {
  const { data } = researchFixture();
  const catalog = new FilesystemRunCatalog(data);
  const first = buildResearchScopeManifest(catalog, "RUN-RESEARCH", "Is APOE differential expression stable?", { workflowId: "finding-stress-test" }, { createdAt: "2026-06-23T00:00:00.000Z" });
  const second = buildResearchScopeManifest(catalog, "RUN-RESEARCH", "Is APOE differential expression stable?", { workflowId: "finding-stress-test" }, { createdAt: "2026-06-23T00:00:00.000Z" });
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.retrieval.route, "lookup");
  assert.ok(first.artifacts.some((item) => item.path === "stage1/volcano_results.tsv" && item.rowIds.length > 0 && item.sha256.length === 64));
  assert.equal(first.schemaVersion, "1.1");
  assert.ok(first.artifacts.some((item) => item.rowRefs.length > 0 && item.rowRefs.every((row) => row.id.length === 24 && row.rowSha256?.length === 64)));
  assert.ok(first.controlAudit?.every((item) => item.sha256.length === 64 && Object.keys(item.controls).length > 0));
  assert.equal(first.referenceSnapshots?.[0].artifactSha256, first.artifacts[0].sha256);
  assert.equal(first.lineage?.inputs.length, first.artifacts.length);
  assert.equal(verifyResearchScopeManifest(catalog, first).valid, true);
  assert.deepEqual(first.stageConfigs.map((item) => item.path), ["config_stage1.json", "config_stage2.json"]);
  assert.ok(first.exclusions.some((item) => item.path === "stage2/go_enrichment_all.csv"));
});

test("claim validator enforces dual grounding by claim type", () => {
  const base = { text: "A finding", decisionImplication: "Inspect it", limitations: ["Single run"], dimensions: { pipelineSupport: "direct" }, evidence: [{ arm: "pipeline" }] };
  assert.equal(validateResearchClaim({ ...base, claimType: "observation" }).valid, true);
  assert.match(validateResearchClaim({ ...base, claimType: "computation" }).errors.join(" "), /computation arm/);
  assert.match(validateResearchClaim({ ...base, claimType: "interpretation" }).errors.join(" "), /external evidence/);
});

// One end-to-end pass condition per canned workflow: plan -> approve -> run ->
// completion, with the 8-output package + computed artifacts on disk and
// downloadable, AND the job's skills/scripts visible in the Operations Control
// Center. The temp-dir fixture is auto-isolated, so test runs leave no bloat in
// the real data directory.
const PACKAGE_KINDS = ["decision-summary", "research-report", "evidence-record", "research-artifact-index", "computation-manifest", "research-rerun", "research-open-questions", "research-next-step"];
const COMPUTED_KINDS = ["research-data", "research-table", "research-figure"];

test("every canned workflow plans, approves, executes its offline skills, emits deliverables, and is visible in the OCC", async () => {
  const { data } = researchFixture();
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), researchExecutionPlane: fakePi() });

  const catalog = (await app.inject({ method: "GET", url: "/api/research/workflows?runId=RUN-RESEARCH" })).json().workflows as Array<{ id: string; skills: unknown[]; capabilities: { executionStatus: string } }>;
  assert.equal(catalog.length, 6);
  const workflows = catalog.filter((item) => item.capabilities.executionStatus !== "preview");
  assert.deepEqual(workflows.map((item) => item.id), ["finding-stress-test", "ranked-pathway-investigation", "module-hub-investigation", "external-protein-evidence", "run-literature-contradiction", "power-next-experiment"]);
  assert.ok((await app.inject({ method: "GET", url: "/api/research/skills" })).json().skills.filter((item: { ready: boolean }) => item.ready).length >= 4);

  for (const workflow of workflows) {
    const created = await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId: "RUN-RESEARCH", workflowId: workflow.id, objective: `Investigate ${workflow.id} stability`, budgetUsd: 0 } });
    assert.equal(created.statusCode, 201, created.body);
    const jobId = created.json().job.id;

    const planned = await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/plan`, payload: {} });
    assert.equal(planned.statusCode, 200);
    assert.equal(planned.json().job.state, "plan_proposed");
    assert.equal(planned.json().job.plan.preflight.ready, true, `${workflow.id} preflight blocked: ${planned.json().job.error}`);

    const approved = await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/approve`, payload: {} });
    assert.equal(approved.json().job.state, "approved");
    assert.equal(approved.json().job.scopeManifestHash.length, 64);

    const launched = await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/run`, headers: { "idempotency-key": `e2e-${workflow.id}` }, payload: {} });
    assert.equal(launched.statusCode, 202);

    let job: any;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      job = (await app.inject({ method: "GET", url: `/api/research/jobs/${jobId}` })).json();
      if (["completed", "failed"].includes(job.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(job.state, "completed", `${workflow.id}: ${job.error || "did not complete"}`);
    assert.equal(job.steps.length, workflow.skills.length);
    assert.ok(job.steps.every((step: any) => step.state === "complete"), `${workflow.id} has an incomplete step`);
    assert.equal(job.computations.length, workflow.skills.length);
    assert.ok(job.computations.every((item: any) => [item.codeSha256, item.inputSetSha256, item.outputSetSha256, item.executionReceiptSha256].every((value) => /^[0-9a-f]{64}$/.test(value))), `${workflow.id} missing computation provenance hashes`);
    assert.equal(job.claims[0].verdict, "differentiated");
    assert.ok(job.claims[0].evidence.some((edge: { arm: string }) => edge.arm === "pipeline"));
    assert.ok(job.claims[0].evidence.some((edge: { arm: string }) => edge.arm === "computation"));

    // Deliverables exist for this job, are registered, and are downloadable.
    const artifacts = (await app.inject({ method: "GET", url: "/api/artifacts?runId=RUN-RESEARCH" })).json().artifacts;
    const jobArtifacts = artifacts.filter((item: any) => item.relPath.includes(`research/jobs/${jobId}/`));
    const kinds = new Set(jobArtifacts.map((item: any) => item.kind));
    for (const kind of PACKAGE_KINDS) assert.ok(kinds.has(kind), `${workflow.id} missing deliverable: ${kind}`);
    assert.ok(COMPUTED_KINDS.some((kind) => kinds.has(kind)), `${workflow.id} produced no computed artifact`);
    const report = jobArtifacts.find((item: any) => item.kind === "research-report");
    const content = await app.inject({ method: "GET", url: `/api/artifacts/${report.id}/content` });
    assert.equal(content.statusCode, 200);
    assert.match(content.body, /SignalFold Deep Research/);
    assert.match(content.body, /Provenance and lineage/);
    assert.match(content.body, /Code SHA/);

    // OCC pass condition: the job and its skill/script executions are checkable.
    const occ = (await app.inject({ method: "GET", url: "/api/operations/research?runId=RUN-RESEARCH" })).json();
    assert.equal(occ.enabled, true);
    const occJob = occ.jobs.find((item: any) => item.id === jobId);
    assert.ok(occJob, `${workflow.id} job absent from the OCC research surface`);
    assert.equal(occJob.scriptOrToolExecutions, workflow.skills.length);
    assert.ok(occJob.steps.every((step: any) => step.execution && step.execution.exitStatus === "complete"), `${workflow.id} OCC step missing execution detail`);
    assert.ok(occJob.steps.every((step: any) => step.execution.outputs.length >= 1), `${workflow.id} OCC step recorded no outputs`);
  }

  // Aggregate OCC summary reflects both completed jobs and every skill run.
  const summary = (await app.inject({ method: "GET", url: "/api/operations/research?runId=RUN-RESEARCH" })).json().summary;
  assert.equal(summary.jobs, workflows.length);
  assert.equal(summary.completed, workflows.length);
  assert.equal(summary.scriptOrToolExecutions, workflows.reduce((total, item) => total + item.skills.length, 0));

  // Durable event log still streams reconnect-safe SSE.
  const anyJob = (await app.inject({ method: "GET", url: "/api/research/jobs?runId=RUN-RESEARCH" })).json().jobs[0];
  const events = await app.inject({ method: "GET", url: `/api/research/jobs/${anyJob.id}/events` });
  assert.match(events.body, /event: job_completed/);
  assert.match(events.body, /reconnect-safe/);

  await app.close();
});

test("changed frozen input invalidates approval before any computation runs", async () => {
  const { data, run } = researchFixture();
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), researchExecutionPlane: fakePi() });
  const created = await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId: "RUN-RESEARCH", workflowId: "finding-stress-test", objective: "Is APOE stable?", budgetUsd: 0 } });
  const jobId = created.json().job.id;
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/plan`, payload: {} });
  const approved = await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/approve`, payload: {} });
  assert.equal(approved.json().job.state, "approved");
  fs.appendFileSync(path.join(run, "stage1", "volcano_results.tsv"), "\nMUTATED\t9\t0\t0\tup");
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/run`, payload: {} });
  const job = await pollJob(app, jobId);
  assert.equal(job.state, "failed");
  assert.match(job.error, /Frozen scope inputs changed after approval.*artifact hash changed/i);
  assert.equal(job.computations.length, 0);
  await app.close();
});

test("step watchdog aborts a step that never returns so a job cannot hang forever", async () => {
  const { data } = researchFixture();
  const prior = process.env.AI_RESEARCH_STEP_WATCHDOG_MS;
  process.env.AI_RESEARCH_STEP_WATCHDOG_MS = "60"; // shrink the 15-minute default so the test is fast
  try {
    const hanging: ResearchPiExecutionPlane = { executeStep: () => new Promise<never>(() => {}), closeJob: () => {} };
    const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), researchExecutionPlane: hanging });
    const created = await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId: "RUN-RESEARCH", workflowId: "finding-stress-test", objective: "Does a hung step get aborted?", budgetUsd: 0 } });
    const jobId = created.json().job.id;
    await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/plan`, payload: {} });
    await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/approve`, payload: {} });
    await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/run`, payload: {} });
    const job = await pollJob(app, jobId);
    assert.equal(job.state, "failed", job.error || "the hung job never failed");
    assert.match(job.error, /watchdog/i);
    assert.equal(job.steps[0].state, "failed", "the hung step is recorded as failed");
    assert.equal(job.computations.length, 0, "no computation is recorded for the aborted step");
    await app.close();
  } finally {
    if (prior === undefined) delete process.env.AI_RESEARCH_STEP_WATCHDOG_MS; else process.env.AI_RESEARCH_STEP_WATCHDOG_MS = prior;
  }
});

test("a job that fails mid-flight retains the spend it already burned", async () => {
  // Regression: spend_usd used to be written only on the 'completed' transition, so a
  // job that ran model turns (real OpenRouter cost) then failed recorded $0 — making the
  // run-cost tally silently undercount the actual bill. A failing step still bills tokens,
  // so its cost must survive the failure.
  const { data } = researchFixture();
  const failingPlane: ResearchPiExecutionPlane = {
    executeStep: async (request: ResearchPiStepRequest) => ({
      sessionId: `fake-fail-${request.jobId}`, loadedSkills: request.allowedSkills, activatedSkills: [request.skillId], modelTurns: 3, costUsd: 0.05,
      receipts: [{ schemaVersion: "1.0", jobId: request.jobId, stepId: request.stepId, piSessionId: `fake-fail-${request.jobId}`, reasoningProfiles: request.reasoningProfiles, approvedSkills: request.allowedSkills, activatedSkill: request.skillId,
        skillMdPath: `scientific/${request.skillId}/SKILL.md`, skillMdHash: "a".repeat(64), upstreamRepository: "test", upstreamCommit: "b".repeat(40), skillFolderHash: "c".repeat(64), executable: { type: "script", identity: request.entrypoint, arguments: [] },
        environment: { id: "test", lockHash: "d".repeat(64), python: "test" }, inputs: [], outputs: [],
        determinism: "deterministic", networkPolicy: "offline", externalActivity: "none", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1, exitCode: 1, timedOut: false, stdout: "", stderr: "synthetic failure after model spend" }] }),
    closeJob: () => {},
  };
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), researchExecutionPlane: failingPlane });
  const created = await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId: "RUN-RESEARCH", workflowId: "finding-stress-test", objective: "Does a failed job keep its spend?", budgetUsd: 1 } });
  const jobId = created.json().job.id;
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/plan`, payload: {} });
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/approve`, payload: {} });
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/run`, payload: {} });
  const job = await pollJob(app, jobId);
  assert.equal(job.state, "failed");
  // spend_usd is the column operationsSummary() SUMs for the "Run AI cost" footer, so
  // retaining it here is what stops a failed job from silently undercounting the bill.
  assert.ok(job.spendUsd >= 0.05 - 1e-9, `failed job should retain accrued spend, got ${job.spendUsd}`);
  // The burned cost is real model spend; it is mirrored into model_spend_usd, and a
  // job that died before the external arm priced anything carries no lookup fee.
  assert.ok(job.modelSpendUsd >= 0.05 - 1e-9, `failed job should retain model spend, got ${job.modelSpendUsd}`);
  assert.equal(job.lookupSpendUsd, 0, "a job that failed before the external arm should have no lookup fee");
  await app.close();
});

test("completed-job conversation is durable, policy-isolated, model-selectable, and links approved child extensions", async () => {
  const { data, run } = researchFixture();
  const narrator: Narrator = {
    available: () => true,
    pickModel: (_userId, requested) => requested,
    estimateCostUsd: async () => 0.001,
    complete: async ({ system, model }) => system.includes("post-research question strategist")
      ? { text: JSON.stringify({ question: "Would APOE remain prioritized under sample-level influence analysis?", why_now: "Sample influence is the largest unresolved robustness gap.", decision_improved: "Whether APOE should proceed to validation.", recommended_includes: ["@answer", "@report", "@missing"], recommended_skills: ["stage1-finding-stability", "not-a-skill"], external_access: "none", stop_rule: "Stop when leave-one-out results no longer change the priority." }), model, costUsd: 0.001 }
      : system.includes("one completed SignalFold")
        ? { text: "The immutable report supports a threshold-sensitive conclusion; see @answer and @report.", model, costUsd: 0.001 }
        : { text: "The finding is sensitive near the approved threshold and should be replicated before prioritization.", model, costUsd: 0.001 },
  };
  const databasePath = path.join(data, "ai.sqlite");
  let app = await buildServer({ dataDir: data, databasePath, researchExecutionPlane: fakePi(), researchNarrator: narrator });
  const created = await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId: "RUN-RESEARCH", workflowId: "finding-stress-test", objective: "Is APOE stable?", model: "openrouter/same-model", budgetUsd: 1 } });
  const jobId = created.json().job.id;
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/plan`, payload: {} });
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/approve`, payload: {} });
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/run`, payload: {} });
  let job = await pollJob(app, jobId);
  assert.equal(job.state, "completed");
  assert.ok(job.conversation?.id);
  assert.equal(job.conversation.suggestion.model, "openrouter/same-model");
  assert.deepEqual(job.conversation.suggestion.recommended_includes, ["@answer", "@report"]);
  assert.deepEqual(job.conversation.suggestion.recommended_skills, ["stage1-finding-stability"]);
  const suggestionAgain = await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/followup-suggestion`, payload: {} });
  assert.equal(suggestionAgain.json().suggestion.outputSha256, job.conversation.suggestion.outputSha256, "suggestion is idempotent per report hash");

  const reportFile = path.join(run, "ai_insights", "research", "jobs", jobId, "package", "research-report.html");
  const reportBefore = crypto.createHash("sha256").update(fs.readFileSync(reportFile)).digest("hex");
  const readOnly = await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/messages`, payload: { query: "What does the verdict mean for prioritization?", requestedModel: "openrouter/turn-model", includes: ["@answer", "@report"], runtimePolicy: "read_only" } });
  assert.equal(readOnly.statusCode, 200, readOnly.body);
  const answer = readOnly.json().conversation.messages.at(-1);
  assert.equal(answer.outcome, "answer");
  assert.equal(answer.effectiveModel, "openrouter/turn-model");
  assert.equal(answer.allowedSkills.length, 0);
  assert.ok(answer.includes.every((item: any) => /^[0-9a-f]{64}$/.test(item.sha256)));
  assert.match(answer.content, /@answer and @report/);
  const forbidden = await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/messages`, payload: { query: "Compute more", allowedSkills: ["stage1-finding-stability"], runtimePolicy: "read_only" } });
  assert.equal(forbidden.statusCode, 409);
  assert.match(forbidden.body, /cannot activate skills/);

  const extension = await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/messages`, payload: { query: "Run a sample influence extension", allowedSkills: ["stage1-finding-stability"], runtimePolicy: "compute", includes: ["@answer", "@report"] } });
  assert.equal(extension.statusCode, 200, extension.body);
  const extensionAnswer = extension.json().conversation.messages.at(-1);
  assert.equal(extensionAnswer.outcome, "extension_plan");
  assert.ok(extensionAnswer.childJobId);
  const child = (await app.inject({ method: "GET", url: `/api/research/jobs/${extensionAnswer.childJobId}` })).json();
  assert.equal(child.state, "plan_proposed");
  assert.equal(child.parentJobId, jobId);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(reportFile)).digest("hex"), reportBefore, "conversation and extension do not mutate completed report");

  await app.close();
  app = await buildServer({ dataDir: data, databasePath, researchExecutionPlane: fakePi(), researchNarrator: narrator });
  job = (await app.inject({ method: "GET", url: `/api/research/jobs/${jobId}` })).json();
  assert.equal(job.conversation.messages.length, 4);
  assert.equal(job.conversation.messages.at(-1).childJobId, extensionAnswer.childJobId);
  assert.equal(job.conversation.suggestion.reportSha256, reportBefore);

  // The OCC research surface must carry the same follow-up conversation, so Ask/Extend
  // turns are traceable to the job (not just a bare conversation_turn event).
  const occList = (await app.inject({ method: "GET", url: "/api/operations/research?runId=RUN-RESEARCH" })).json().jobs.find((item: any) => item.id === jobId);
  assert.equal(occList.conversation.messages.length, 4, "OCC research job is missing the follow-up conversation");
  assert.equal(occList.conversation.messages.find((m: any) => m.role === "assistant" && m.runtimePolicy === "read_only")?.outcome, "answer");
  assert.equal(occList.conversation.messages.at(-1).childJobId, extensionAnswer.childJobId, "OCC follow-up does not link the child extension job");
  const occSingle = (await app.inject({ method: "GET", url: `/api/operations/research/${jobId}` })).json();
  assert.deepEqual(occSingle.conversation, occList.conversation, "single-job OCC endpoint diverges from the list");
  await app.close();
});

test("plan editor re-derives steps, persists budget + sources, and freezes pinned files into the scope", async () => {
  const { data } = researchFixture();
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), researchExecutionPlane: fakePi() });

  const created = await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId: "RUN-RESEARCH", workflowId: "finding-stress-test", objective: "Does APOE survive thresholds?", budgetUsd: 0 } });
  const jobId = created.json().job.id;
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/plan`, payload: {} });

  // Reorder + drop the visualization step, change the stability thresholds,
  // raise the budget, approve a source, and pin a run file that retrieval did
  // not select for this workflow.
  const editedSteps = [
    { skillId: "stage1-finding-stability", entrypoint: "threshold-sweep", parameters: { thresholds: [0.2, 0.3] } },
    { skillId: "exploratory-data-analysis", entrypoint: "summarize", parameters: {} },
  ];
  const patched = await app.inject({ method: "PATCH", url: `/api/research/jobs/${jobId}/plan`, payload: { objective: "Does APOE survive thresholds?", steps: editedSteps, maxCostUsd: 2, sources: ["pubmed"], pinned: [{ scope: "context", path: "stage2/go_enrichment_all.csv" }] } });
  assert.equal(patched.statusCode, 200, patched.body);
  const plan = patched.json().job.plan;
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].skillId, "stage1-finding-stability");
  assert.equal(plan.steps[0].ordinal, 1);
  assert.deepEqual(plan.steps[0].parameters.thresholds, [0.2, 0.3]);
  assert.deepEqual(plan.sources, ["pubmed"]);
  assert.equal(plan.maxCostUsd, 2);
  assert.equal(patched.json().job.budgetUsd, 2);
  assert.equal(plan.preflight.ready, true);
  assert.equal(plan.preflight.pinnedArtifacts, 1);

  // The server is the authoritative parameter gate: an unknown param (such as
  // the old inert `seed`) is rejected, not silently dropped.
  const rejected = await app.inject({ method: "PATCH", url: `/api/research/jobs/${jobId}/plan`, payload: { objective: "Does APOE survive thresholds?", steps: [{ skillId: "stage1-finding-stability", entrypoint: "threshold-sweep", parameters: { thresholds: [0.2], seed: 7 } }], maxCostUsd: 2 } });
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.match(rejected.json().detail, /unknown parameter "seed"/);

  // The durable step rows were rebuilt to match the edit.
  const job = (await app.inject({ method: "GET", url: `/api/research/jobs/${jobId}` })).json();
  assert.equal(job.steps.length, 2);
  assert.equal(job.steps[0].skillId, "stage1-finding-stability");

  // Editing an invalid skill is rejected against the catalog.
  const bad = await app.inject({ method: "PATCH", url: `/api/research/jobs/${jobId}/plan`, payload: { steps: [{ skillId: "not-a-skill", entrypoint: "x" }] } });
  assert.equal(bad.statusCode, 409);

  const approved = await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/approve`, payload: {} });
  assert.equal(approved.json().job.scopeManifestHash.length, 64);

  const occJob = (await app.inject({ method: "GET", url: "/api/operations/research?runId=RUN-RESEARCH" })).json().jobs.find((item: any) => item.id === jobId);
  assert.deepEqual(occJob.scope.sources, ["pubmed"]);
  assert.ok(occJob.scope.artifacts.some((item: any) => item.pinned && item.path === "stage2/go_enrichment_all.csv"), "pinned file is not frozen into the scope");
  await app.close();
});

test("approved external sources run as a third evidence arm and surface in deliverables + OCC", async () => {
  const { data } = researchFixture();
  const { lookup, calls } = fakeExternal();
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), researchExternalLookup: lookup, researchNarrator: null, researchExecutionPlane: fakePi() });

  const created = await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId: "RUN-RESEARCH", workflowId: "finding-stress-test", objective: "Does APOE survive thresholds?", budgetUsd: 5 } });
  const jobId = created.json().job.id;
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/plan`, payload: {} });
  await app.inject({ method: "PATCH", url: `/api/research/jobs/${jobId}/plan`, payload: { sources: ["pubmed"], maxCostUsd: 5 } });
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/approve`, payload: {} });
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/run`, headers: { "idempotency-key": "ext-1" }, payload: {} });
  const job = await pollJob(app, jobId);

  assert.equal(job.state, "completed", job.error);
  assert.ok(calls.length >= 1, "external lookup was never called");
  assert.ok(calls.every((call) => call.source === "pubmed"));
  assert.ok(job.claims[0].evidence.some((edge: any) => edge.arm === "external"));
  assert.equal(job.claims[0].verdict, "externally-corroborated");

  const artifacts = (await app.inject({ method: "GET", url: "/api/artifacts?runId=RUN-RESEARCH" })).json().artifacts;
  const ext = artifacts.find((item: any) => item.kind === "research-external-evidence");
  assert.ok(ext, "external-evidence.json deliverable is missing");
  const extContent = await app.inject({ method: "GET", url: `/api/artifacts/${ext.id}/content` });
  assert.match(extContent.body, /"responseSha256": "b{64}"/);
  assert.match(extContent.body, /"citationsVerified": true/);
  const content = JSON.parse((await app.inject({ method: "GET", url: `/api/artifacts/${ext.id}/content` })).body);
  assert.ok(content.assessed >= 1 && content.items[0].ok);

  const occJob = (await app.inject({ method: "GET", url: "/api/operations/research?runId=RUN-RESEARCH" })).json().jobs.find((item: any) => item.id === jobId);
  assert.ok(occJob.external.length >= 1, "external arm absent from OCC");
  // OCC step outputs are resolvable to a downloadable artifact id.
  assert.ok(occJob.steps.some((step: any) => step.execution?.outputs?.some((output: any) => output.artifactId)));

  // Cost calibration: the synthetic per-lookup fee is tracked apart from the real
  // (OpenRouter-comparable) model cost, and the two reconcile to the headline total
  // so the dashboard can no longer conflate or invert them. The OCC exposes both.
  assert.ok(job.lookupSpendUsd > 0, "external-lookup fee was not tracked separately");
  assert.ok(Math.abs(job.modelSpendUsd + job.lookupSpendUsd - job.spendUsd) < 1e-9, `model (${job.modelSpendUsd}) + lookup (${job.lookupSpendUsd}) must reconcile to spend (${job.spendUsd})`);
  assert.equal(occJob.modelSpendUsd, job.modelSpendUsd, "OCC model spend differs from job detail");
  assert.equal(occJob.lookupSpendUsd, job.lookupSpendUsd, "OCC lookup fee differs from job detail");
  const summary = (await app.inject({ method: "GET", url: "/api/operations/research?runId=RUN-RESEARCH" })).json().summary;
  assert.ok(Math.abs(summary.modelSpendUsd + summary.lookupSpendUsd - summary.spendUsd) < 1e-9, "OCC summary split must reconcile to total spend");

  // The raw/triage pointer targets one job: /api/operations/research/:id returns
  // the same enriched record (artifact ids included) the list endpoint produces.
  const single = await app.inject({ method: "GET", url: `/api/operations/research/${jobId}` });
  assert.equal(single.statusCode, 200);
  assert.deepEqual(single.json(), occJob);
  assert.equal((await app.inject({ method: "GET", url: "/api/operations/research/nope" })).statusCode, 404);
  await app.close();
});

test("the cost cap is a real ceiling that gates the external arm", async () => {
  const { data } = researchFixture();
  const { lookup, calls } = fakeExternal();
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), researchExternalLookup: lookup, researchNarrator: null, researchExecutionPlane: fakePi() });

  const created = await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId: "RUN-RESEARCH", workflowId: "finding-stress-test", objective: "Does APOE survive thresholds?", budgetUsd: 0 } });
  const jobId = created.json().job.id;
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/plan`, payload: {} });
  // Sources approved but a $0 cap must block every (non-free) lookup.
  await app.inject({ method: "PATCH", url: `/api/research/jobs/${jobId}/plan`, payload: { sources: ["pubmed"], maxCostUsd: 0 } });
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/approve`, payload: {} });
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/run`, headers: { "idempotency-key": "cap-1" }, payload: {} });
  const job = await pollJob(app, jobId);

  assert.equal(job.state, "completed", job.error);
  assert.equal(calls.length, 0, "the $0 cap did not block external lookups");
  assert.equal(job.spendUsd, 0);
  assert.ok(!job.claims[0].evidence.some((edge: any) => edge.arm === "external"));

  const occJob = (await app.inject({ method: "GET", url: "/api/operations/research?runId=RUN-RESEARCH" })).json().jobs.find((item: any) => item.id === jobId);
  assert.ok(occJob.events.some((event: any) => event.name === "external_budget_capped"), "no budget-cap event recorded");
  await app.close();
});

test("preflight names the in-scope artifacts (+exclusions) and get() exposes the frozen scope after approval", async () => {
  const { data } = researchFixture();
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), researchExecutionPlane: fakePi() });

  const created = await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId: "RUN-RESEARCH", workflowId: "finding-stress-test", objective: "Is APOE stable?", budgetUsd: 0 } });
  const jobId = created.json().job.id;
  // Pin a run file retrieval did not select, so the preview reports both a
  // retrieved and a pinned artifact.
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/plan`, payload: {} });
  const patched = await app.inject({ method: "PATCH", url: `/api/research/jobs/${jobId}/plan`, payload: { pinned: [{ scope: "context", path: "stage2/go_enrichment_all.csv" }] } });
  const preflight = patched.json().job.plan.preflight;

  // The COUNT the editor always had is now backed by the actual paths.
  assert.equal(preflight.artifacts.length, preflight.selectedArtifacts);
  assert.ok(preflight.artifacts.some((item: any) => item.path === "stage1/volcano_results.tsv" && item.family && item.reason && item.pinned === false));
  assert.ok(preflight.artifacts.some((item: any) => item.path === "stage2/go_enrichment_all.csv" && item.pinned === true));
  // Exclusions reconcile the rail: a run file present but not in scope is listed.
  assert.ok(Array.isArray(preflight.exclusions));
  // The pinned file is in scope, so it must NOT also appear as excluded.
  assert.ok(!preflight.exclusions.some((item: any) => item.path === "stage2/go_enrichment_all.csv"));

  // Pre-approval get() carries no frozen scope yet; post-approval it does, in the
  // same {path, family, reason, pinned} shape the editor/rail render.
  assert.equal((await app.inject({ method: "GET", url: `/api/research/jobs/${jobId}` })).json().scope, null);
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/approve`, payload: {} });
  const approved = (await app.inject({ method: "GET", url: `/api/research/jobs/${jobId}` })).json();
  assert.ok(approved.scope && Array.isArray(approved.scope.artifacts) && Array.isArray(approved.scope.exclusions));
  assert.ok(approved.scope.artifacts.some((item: any) => item.path === "stage1/volcano_results.tsv"));
  assert.ok(approved.scope.artifacts.some((item: any) => item.path === "stage2/go_enrichment_all.csv" && item.pinned === true));
  await app.close();
});

test("plan templates persist a reusable skeleton (no objective/pins) and seed a new job", async () => {
  const { data } = researchFixture();
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), researchExecutionPlane: fakePi() });

  const steps = [
    { skillId: "stage1-finding-stability", entrypoint: "threshold-sweep", parameters: { thresholds: [0.2, 0.3] } },
    { skillId: "exploratory-data-analysis", entrypoint: "summarize", parameters: {} },
  ];
  const saved = await app.inject({ method: "POST", url: "/api/research/templates", payload: { label: "Strict thresholds", workflowId: "finding-stress-test", steps, sources: ["pubmed"], maxCostUsd: 3 } });
  assert.equal(saved.statusCode, 201, saved.body);
  const template = saved.json().template;
  assert.equal(template.label, "Strict thresholds");
  assert.equal(template.steps.length, 2);
  assert.deepEqual(template.sources, ["pubmed"]);
  assert.equal(template.maxCostUsd, 3);
  // The skeleton stores no objective and no pinned files.
  assert.equal(template.objective, undefined);
  assert.equal(template.pinned, undefined);

  assert.ok((await app.inject({ method: "GET", url: "/api/research/templates" })).json().templates.some((item: any) => item.id === template.id));

  // The catalog gate is authoritative — an unknown skill is rejected, not stored.
  const bad = await app.inject({ method: "POST", url: "/api/research/templates", payload: { label: "Bad", workflowId: "finding-stress-test", steps: [{ skillId: "not-a-skill", entrypoint: "x" }] } });
  assert.equal(bad.statusCode, 400);
  // An unknown workflow is rejected too.
  assert.equal((await app.inject({ method: "POST", url: "/api/research/templates", payload: { label: "X", workflowId: "nope", steps } })).statusCode, 400);

  // "Start from template": create on the origin workflow, propose, apply skeleton.
  const created = await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId: "RUN-RESEARCH", workflowId: template.workflowId, objective: "Does APOE survive strict thresholds?", budgetUsd: template.maxCostUsd } });
  const jobId = created.json().job.id;
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/plan`, payload: {} });
  const patched = await app.inject({ method: "PATCH", url: `/api/research/jobs/${jobId}/plan`, payload: { objective: "Does APOE survive strict thresholds?", steps: template.steps, sources: template.sources, maxCostUsd: template.maxCostUsd } });
  assert.equal(patched.statusCode, 200, patched.body);
  const plan = patched.json().job.plan;
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].skillId, "stage1-finding-stability");
  assert.deepEqual(plan.steps[0].parameters.thresholds, [0.2, 0.3]);
  assert.deepEqual(plan.sources, ["pubmed"]);
  assert.equal(plan.maxCostUsd, 3);

  // Delete the template.
  assert.equal((await app.inject({ method: "DELETE", url: `/api/research/templates/${template.id}` })).statusCode, 200);
  assert.ok(!(await app.inject({ method: "GET", url: "/api/research/templates" })).json().templates.some((item: any) => item.id === template.id));
  assert.equal((await app.inject({ method: "DELETE", url: `/api/research/templates/${template.id}` })).statusCode, 404);
  await app.close();
});

test("discard deletes a proposed plan via the delete cascade", async () => {
  const { data } = researchFixture();
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), researchExecutionPlane: fakePi() });

  const created = await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId: "RUN-RESEARCH", workflowId: "finding-stress-test", objective: "Throwaway", budgetUsd: 0 } });
  const jobId = created.json().job.id;
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/plan`, payload: {} });

  const discarded = await app.inject({ method: "DELETE", url: `/api/research/jobs/${jobId}` });
  assert.equal(discarded.statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/api/research/jobs/${jobId}` })).statusCode, 404);
  assert.ok(!(await app.inject({ method: "GET", url: "/api/research/jobs?runId=RUN-RESEARCH" })).json().jobs.some((item: any) => item.id === jobId));
  await app.close();
});

// Free-form (unconstrained) arm: a fake jailed agent emits findings.json citing
// run files via the live onActivity stream; the generic decider must KEEP the
// resolvable claim, DROP the claim citing a nonexistent file (audit-to-source),
// narrate under the guard, and reuse the whole package — all offline.
function fakeFreeform(): ResearchPiExecutionPlane {
  return { executeStep: async (request: ResearchPiStepRequest) => {
    request.onActivity?.("plan_requested", { objective: request.objective });
    request.onActivity?.("code_run", { label: "inspect volcano_results", codeSha: "f".repeat(64) });
    const outputDir = path.join(request.jobRoot, "workspace", "outputs"); fs.mkdirSync(outputDir, { recursive: true });
    const findings = {
      headline: "APOE shows the strongest case-vs-control increase in this run.",
      summary: "The largest Stage 1 effect is APOE at log2fc 1.4.",
      claims: [
        { statement: "APOE is up in the case contrast at log2fc 1.4.", evidence: [{ path: "inputs/stage1/volcano_results.tsv", rowIds: [2], value: 1.4, note: "log2fc" }] },
        { statement: "A fabricated claim citing a file that does not exist.", evidence: [{ path: "inputs/stage1/ghost.csv", value: 99 }] },
      ],
      limitations: ["Pilot run, small n."],
      decisionImplication: "Prioritize APOE for the follow-up.",
    };
    const findingsJson = JSON.stringify(findings, null, 2);
    const traceJson = JSON.stringify([{ ordinal: 1, type: "code_run", detail: { label: "inspect volcano_results" } }], null, 2);
    fs.writeFileSync(path.join(outputDir, "findings.json"), findingsJson);
    fs.writeFileSync(path.join(outputDir, "activity-trace.json"), traceJson);
    request.onActivity?.("findings_emitted", { claims: 2 });
    const out = (name: string, content: string) => ({ path: `outputs/${name}`, mimeType: "application/json", bytes: Buffer.byteLength(content), sha256: crypto.createHash("sha256").update(content).digest("hex") });
    return { sessionId: `fake-freeform-${request.jobId}`, loadedSkills: request.allowedSkills, activatedSkills: ["exploratory-data-analysis"], modelTurns: 2, costUsd: 0,
      receipts: [{ schemaVersion: "1.0", jobId: request.jobId, stepId: request.stepId, piSessionId: `fake-freeform-${request.jobId}`, reasoningProfiles: request.reasoningProfiles, approvedSkills: request.allowedSkills, activatedSkill: "freeform-agent",
        skillMdPath: "native/freeform-agent/SKILL.md", skillMdHash: "a".repeat(64), upstreamRepository: "SignalFold", upstreamCommit: "signalfold-freeform-v1", skillFolderHash: "c".repeat(64), executable: { type: "custom-tool", identity: "freeform-agent", arguments: [] },
        environment: { id: "signalfold-freeform", lockHash: "d".repeat(64), python: "test" }, inputs: request.scope.artifacts.map((item) => ({ path: `inputs/${item.path}`, sha256: item.sha256 })),
        outputs: [out("findings.json", findingsJson), out("activity-trace.json", traceJson)],
        determinism: "not-verified", networkPolicy: "offline", externalActivity: "none", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1, exitCode: 0, timedOut: false, stdout: "", stderr: "" }] };
  }};
}

test("free-form arm: jailed agent findings flow through the generic decider (resolvable claim kept, fabricated claim dropped) and reuse the full package", async () => {
  const { data } = researchFixture();
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), researchFreeformPlane: fakeFreeform(), researchNarrator: fakeNarrator("APOE shows the strongest increase (log2fc 1.4); prioritize it for the follow-up. Pilot run, small n.") });

  const created = await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId: "RUN-RESEARCH", workflowId: "freeform", objective: "Which protein has the strongest case-vs-control change?", budgetUsd: 1 } });
  assert.equal(created.statusCode, 201, created.body);
  const jobId = created.json().job.id;

  const planned = await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/plan`, payload: {} });
  assert.equal(planned.json().job.state, "plan_proposed", planned.body);
  assert.equal(planned.json().job.plan.preflight.ready, true);
  assert.deepEqual(planned.json().job.plan.allowedSkills, ["freeform-agent"], "synthesis skill excluded from the loaded allowlist");

  // The free-form plan is editable (objective/budget/pins) without a 409 on its
  // synthetic steps: updatePlan re-derives the fixed investigate->synthesize
  // pipeline rather than validating freeform-agent against the skill catalog.
  const edited = await app.inject({ method: "PATCH", url: `/api/research/jobs/${jobId}/plan`, payload: { objective: "Edited via PATCH: which protein moves most?", maxCostUsd: 0.5 } });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.deepEqual(edited.json().job.plan.steps.map((step: any) => step.skillId), ["freeform-agent", "freeform-synthesis"], "free-form steps preserved across a plan edit");
  assert.equal(edited.json().job.objective, "Edited via PATCH: which protein moves most?");

  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/approve`, payload: {} });
  const launched = await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/run`, headers: { "idempotency-key": "freeform-e2e" }, payload: {} });
  assert.equal(launched.statusCode, 202);

  const job = await pollJob(app, jobId);
  assert.equal(job.state, "completed", job.error || "did not complete");
  assert.equal(job.steps.length, 2);
  assert.ok(job.steps.every((step: any) => step.state === "complete"));
  const agentComp = job.computations.find((item: any) => item.skillId === "freeform-agent");
  assert.ok(agentComp, "free-form agent computation recorded");
  assert.equal(agentComp.implementationKind, "pi-freeform-agent");
  assert.ok([agentComp.codeSha256, agentComp.inputSetSha256, agentComp.outputSetSha256, agentComp.executionReceiptSha256].every((value: string) => /^[0-9a-f]{64}$/.test(value)), "free-form computation carries provenance hashes");

  const artifacts = (await app.inject({ method: "GET", url: "/api/artifacts?runId=RUN-RESEARCH" })).json().artifacts.filter((item: any) => item.relPath.includes(`research/jobs/${jobId}/`));
  const answerArtifact = artifacts.find((item: any) => item.kind === "research-answer");
  assert.ok(answerArtifact, "answer-model.json registered");
  const answer = JSON.parse((await app.inject({ method: "GET", url: `/api/artifacts/${answerArtifact.id}/content` })).body);
  assert.equal(answer.verdictLabel, "context-dependent");
  assert.ok(answer.metrics.some((metric: any) => String(metric.value) === "1.4" && metric.cite.path.includes("volcano_results")), "resolvable APOE claim kept as a cited metric");
  assert.ok(!answer.metrics.some((metric: any) => metric.cite.path.includes("ghost")), "fabricated ghost-file claim dropped from metrics");
  assert.ok(answer.limitations.some((line: string) => /dropped/i.test(line)), "dropped claim surfaced as a limitation");

  assert.ok(artifacts.some((item: any) => item.relPath.endsWith("activity-trace.json")), "activity trace captured as a deliverable");
  assert.ok(artifacts.some((item: any) => item.kind === "research-report"), "research report emitted");
  await app.close();
});

test("scope-preview matches a proposed plan's frozen-scope counts and creates no job", async () => {
  const { data } = researchFixture();
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), researchExecutionPlane: fakePi() });
  const runId = "RUN-RESEARCH";
  const objective = "Is APOE stable?";

  // A real proposed plan computes the authoritative preflight.
  const created = (await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId, workflowId: "finding-stress-test", objective, budgetUsd: 0 } })).json();
  const planned = (await app.inject({ method: "POST", url: `/api/research/jobs/${created.job.id}/plan`, payload: {} })).json();
  const truth = planned.job.plan.preflight;
  const before = (await app.inject({ method: "GET", url: `/api/research/jobs?runId=${runId}` })).json().jobs.length;

  // The pre-job preview must match it on the counts that gate the Run button.
  const previewRes = await app.inject({ method: "POST", url: "/api/research/scope-preview", payload: { runId, workflowId: "finding-stress-test", objective } });
  assert.equal(previewRes.statusCode, 200);
  const preview = previewRes.json();
  assert.equal(preview.workflowId, "finding-stress-test");
  assert.equal(preview.preflight.ready, truth.ready);
  assert.equal(preview.preflight.selectedArtifacts, truth.selectedArtifacts);
  assert.equal(preview.preflight.stageConfigs, truth.stageConfigs);
  assert.equal(preview.preflight.pinnedArtifacts, truth.pinnedArtifacts);
  assert.deepEqual(preview.preflight.missingFamilies, truth.missingFamilies);

  // Free-form is the launch default and must also preview cleanly against its plan.
  const freeCreated = (await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId, workflowId: "freeform", objective, budgetUsd: 0.5 } })).json();
  const freePlan = (await app.inject({ method: "POST", url: `/api/research/jobs/${freeCreated.job.id}/plan`, payload: {} })).json();
  const freePreview = (await app.inject({ method: "POST", url: "/api/research/scope-preview", payload: { runId, workflowId: "freeform", objective, maxCostUsd: 0.5 } })).json();
  assert.equal(freePreview.preflight.selectedArtifacts, freePlan.job.plan.preflight.selectedArtifacts);
  assert.equal(freePreview.preflight.ready, freePlan.job.plan.preflight.ready);

  // Preview is side-effect-free: the two created jobs above, none from preview.
  const after = (await app.inject({ method: "GET", url: `/api/research/jobs?runId=${runId}` })).json().jobs.length;
  assert.equal(after, before + 1, "scope-preview must not create a job (only the freeform create did)");

  // Missing runId is a 400.
  assert.equal((await app.inject({ method: "POST", url: "/api/research/scope-preview", payload: {} })).statusCode, 400);
  await app.close();
});

test("atomic Extend approves + runs a child extension in one call; Plan only stops at a plan", async () => {
  const { data } = researchFixture();
  const app = await buildServer({ dataDir: data, databasePath: path.join(data, "ai.sqlite"), researchExecutionPlane: fakePi(), researchNarrator: fakeNarrator("APOE is the strongest signal; prioritize it. Pilot run.") });
  const created = (await app.inject({ method: "POST", url: "/api/research/jobs", payload: { runId: "RUN-RESEARCH", workflowId: "finding-stress-test", objective: "Is APOE stable?", budgetUsd: 1 } })).json();
  const jobId = created.job.id;
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/plan`, payload: {} });
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/approve`, payload: {} });
  await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/run`, payload: {} });
  assert.equal((await pollJob(app, jobId)).state, "completed");

  // One /messages call with autoApprove must spawn a child that is already running/done,
  // not parked at plan_proposed — the whole point of the atomic Extend.
  const ext = (await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/messages`, payload: { query: "Re-rank dropping the two lowest-coverage samples.", runtimePolicy: "compute", autoApprove: true, budgetUsd: 1 } })).json();
  const last = ext.conversation.messages.at(-1);
  assert.equal(last.outcome, "extension_run", "autoApprove compute extension should run, not stop at a plan");
  assert.ok(last.childJobId, "child job id recorded on the assistant message");
  const child = await pollJob(app, last.childJobId);
  assert.equal(child.state, "completed", "child extension runs to completion");
  assert.equal(child.objective, "Re-rank dropping the two lowest-coverage samples.", "child carries the follow-up question as its objective");

  // Plan only (autoApprove=false) preserves the reviewable-plan path.
  const planOnly = (await app.inject({ method: "POST", url: `/api/research/jobs/${jobId}/messages`, payload: { query: "Add a second sensitivity sweep.", runtimePolicy: "compute", autoApprove: false } })).json();
  const planMsg = planOnly.conversation.messages.at(-1);
  assert.equal(planMsg.outcome, "extension_plan", "Plan only stops at plan_proposed");
  assert.equal((await app.inject({ method: "GET", url: `/api/research/jobs/${planMsg.childJobId}` })).json().state, "plan_proposed");
  await app.close();
});
