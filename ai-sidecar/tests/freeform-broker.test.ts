import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateExternalRequest, buildRunTokenSet, resolveSkillScriptPath, withIntentComment } from "../src/research/freeform-executor.js";
import { SkillExecutionGateway } from "../src/research/execution-gateway.js";

// Tier 1 brokered free-form capabilities: the agent corroborates against curated
// public databases (request_external) and runs OFFLINE vendored skills (use_skill)
// OUT-OF-BAND, while its own code stays in the --network none jail. These tests
// pin the anti-exfiltration gate, the run-traceability signal, and the gateway's
// refusal to run a networked skill in this tier.

const base = { enabled: true, allowedSources: ["uniprot", "pubmed", "reactome", "string"], source: "uniprot", count: 0, maxLookups: 12, costUsd: 0.01, spend: 0, budget: 1, term: "APOE" };

test("run_python snippets are normalized with a first-line intent comment", () => {
  const stamped = withIntentComment("print('hello')\n", "Inspect the staged volcano table");
  assert.equal(stamped.split(/\r?\n/)[0], "# Intent: Inspect the staged volcano table");
  assert.match(stamped, /\nprint\('hello'\)/);

  const explicit = "# Intent: Count APOE rows\nprint('ok')\n";
  assert.equal(withIntentComment(explicit, "ignored"), explicit);
});

test("egress gate: a clean identifier passes and is reduced to a safe token", () => {
  const gate = evaluateExternalRequest({ ...base, term: "P02768" });
  assert.equal(gate.ok, true);
  assert.equal(gate.ok && gate.safeTerm, "P02768");
});

test("egress gate: exfiltration vectors (paths, URLs, secrets) are hard-blocked, never sent", () => {
  // The guard's job is anti-exfiltration: nothing run-specific or credential-like
  // leaves the host. Response-side prompt-injection is handled separately by the
  // adapter's inspectPrompt quarantine (see external.ts / external.test.ts).
  for (const term of ["/etc/passwd", "../../etc/shadow", "https://evil.test/leak", "my secret token", "ANTHROPIC_API_KEY=sk-abcdefgh"]) {
    const gate = evaluateExternalRequest({ ...base, term });
    assert.equal(gate.ok, false, `expected ${term} blocked`);
    assert.equal(gate.ok === false && gate.error, "egress-blocked");
  }
});

test("egress gate: disabled job blocks all lookups", () => {
  const gate = evaluateExternalRequest({ ...base, enabled: false });
  assert.equal(gate.ok === false && gate.error, "disabled");
});

test("egress gate: source outside the per-job allowlist is rejected", () => {
  const gate = evaluateExternalRequest({ ...base, allowedSources: ["uniprot"], source: "string" });
  assert.equal(gate.ok === false && gate.error, "source-not-allowed");
});

test("egress gate: the lookup-count cap stops further lookups", () => {
  assert.equal(evaluateExternalRequest({ ...base, count: 12, maxLookups: 12 }).ok, false);
  assert.equal(evaluateExternalRequest({ ...base, count: 11, maxLookups: 12 }).ok, true);
});

test("egress gate: the cost ceiling stops a lookup that would overspend", () => {
  // No budget at all → blocked when each lookup costs money.
  assert.equal(evaluateExternalRequest({ ...base, budget: 0 }).ok, false);
  // The marginal lookup would cross the cap → blocked.
  assert.equal(evaluateExternalRequest({ ...base, spend: 0.095, budget: 0.1, costUsd: 0.01 }).ok, false);
  // Within budget → allowed.
  assert.equal(evaluateExternalRequest({ ...base, spend: 0, budget: 0.1, costUsd: 0.01 }).ok, true);
  // Free lookups are never budget-blocked.
  assert.equal(evaluateExternalRequest({ ...base, budget: 0, costUsd: 0 }).ok, true);
});

test("buildRunTokenSet flags identifiers that actually appear in the frozen run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-tokens-"));
  try {
    fs.writeFileSync(path.join(dir, "volcano_results.tsv"), "protein_id\tlog2fc\nP02768\t1.8\nAPOE\t-2.1\n");
    const tokens = buildRunTokenSet(dir);
    assert.equal(tokens.has("p02768"), true, "queried id present in run is recognized (lowercased)");
    assert.equal(tokens.has("apoe"), true);
    assert.equal(tokens.has("trem2"), false, "an id absent from the run is not falsely flagged");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("use_skill gateway refuses a NETWORKED skill in Tier 1 (awaits the egress sandbox)", async () => {
  const gateway = new SkillExecutionGateway();
  await assert.rejects(
    () => gateway.run({ jobId: "j", stepId: "s", piSessionId: "p", reasoningProfiles: [], approvedSkills: ["pathway-enrichment"], skillId: "pathway-enrichment", script: "scripts/run_enrichment.py", args: [], workspace: "/tmp/sf-x", runPath: "/tmp/sf-x", scope: { artifacts: [] } as any, timeoutMs: 1000 }),
    /brokered egress boundary|not approved/i,
  );
});

test("use_skill gateway refuses a script outside an offline skill's allowlist", async () => {
  const gateway = new SkillExecutionGateway();
  await assert.rejects(
    () => gateway.run({ jobId: "j", stepId: "s", piSessionId: "p", reasoningProfiles: [], approvedSkills: ["exploratory-data-analysis"], skillId: "exploratory-data-analysis", script: "scripts/not_allowed.py", args: [], workspace: "/tmp/sf-x", runPath: "/tmp/sf-x", scope: { artifacts: [] } as any, timeoutMs: 1000 }),
    /not allowed for this skill/i,
  );
});

// The free-form plane now runs offline skills INSIDE the jail and drops the
// per-script allowlist (the box is the boundary). resolveSkillScriptPath is the
// only pre-flight: it tolerates a bare filename (the dead-end the allowlist
// caused on a live run) and blocks traversal out of the skill folder.
const edaRoot = path.resolve(import.meta.dirname, "..", "skills", "scientific", "exploratory-data-analysis");

test("resolveSkillScriptPath: a bare filename resolves under scripts/ (the dead-end the allowlist caused)", () => {
  assert.equal(resolveSkillScriptPath(edaRoot, "eda_analyzer.py"), path.join("scripts", "eda_analyzer.py"));
  assert.equal(resolveSkillScriptPath(edaRoot, "scripts/eda_analyzer.py"), path.join("scripts", "eda_analyzer.py"));
});

test("resolveSkillScriptPath: a missing script or a path escaping the skill folder returns null", () => {
  assert.equal(resolveSkillScriptPath(edaRoot, "not_a_real_script.py"), null);
  assert.equal(resolveSkillScriptPath(edaRoot, "../../src/security.ts"), null);
  assert.equal(resolveSkillScriptPath(edaRoot, "/etc/passwd"), null);
});
