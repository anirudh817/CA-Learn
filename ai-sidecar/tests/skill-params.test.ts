import assert from "node:assert/strict";
import test from "node:test";
import { validateParams, defaultParams, exampleParams } from "../src/skills/param-validation.js";
import { loadUnifiedResearchSkillCatalog } from "../src/skills/catalog.js";
import { RESEARCH_WORKFLOWS } from "../src/research/service.js";

test("catalog surfaces descriptions, entrypoint summaries, and param schemas", () => {
  const catalog = loadUnifiedResearchSkillCatalog();

  const stability = catalog.find((skill) => skill.id === "stage1-finding-stability");
  assert.ok(stability, "stage1-finding-stability is present");
  assert.match(stability!.description || "", /threshold|robust/i);
  const sweep = stability!.entrypoints.find((entry) => entry.id === "threshold-sweep")!;
  assert.ok(sweep.summary && sweep.summary.length > 0, "entrypoint carries a summary");
  assert.equal(sweep.params?.type, "object");
  assert.deepEqual(sweep.params?.required, ["thresholds"]);

  // Scientific skills have no signalfold.skill.json; description must be lifted
  // from SKILL.md frontmatter and the primary script surfaced for the UI.
  const eda = catalog.find((skill) => skill.id === "exploratory-data-analysis")!;
  assert.ok(eda.description && eda.description.length > 0, "scientific description came from SKILL.md");
  assert.equal(eda.entrypoints[0].primaryScript, "eda_analyzer.py");
  assert.equal(eda.entrypoints[0].summary?.length ? true : false, true);
});

test("every workflow default parameter set satisfies its entrypoint schema", () => {
  const catalog = loadUnifiedResearchSkillCatalog();
  for (const workflow of RESEARCH_WORKFLOWS) {
    for (const step of workflow.skills) {
      const skill = catalog.find((item) => item.id === step.id);
      assert.ok(skill, `${step.id} is in the catalog`);
      const entry = skill!.entrypoints.find((item) => item.id === step.entrypoint);
      assert.ok(entry, `${step.id}/${step.entrypoint} entrypoint exists`);
      const errors = validateParams(entry!.params, step.parameters);
      assert.deepEqual(errors, [], `${workflow.id} → ${step.id}/${step.entrypoint}: ${errors.join("; ")}`);
    }
  }
});

test("validateParams enforces required, item types, and closed properties", () => {
  const schema = {
    type: "object" as const, additionalProperties: false, required: ["thresholds"],
    properties: { thresholds: { type: "array" as const, items: { type: "number" as const }, minItems: 1 } },
  };
  assert.deepEqual(validateParams(schema, { thresholds: [0.01, 0.05] }), []);
  assert.deepEqual(validateParams(schema, {}), ['missing required parameter "thresholds"']);
  assert.ok(validateParams(schema, { thresholds: [0.01], seed: 0 }).some((error) => /unknown parameter "seed"/.test(error)), "rejects the inert seed param");
  assert.ok(validateParams(schema, { thresholds: "x" }).some((error) => /must be an array/.test(error)));
  assert.ok(validateParams(schema, { thresholds: ["a"] }).some((error) => /thresholds\[0\]/.test(error)));
});

test("enum and integer constraints are enforced", () => {
  const schema = {
    type: "object" as const, additionalProperties: false,
    properties: { method: { type: "string" as const, enum: ["stage2-ora-ranking"] }, seed: { type: "integer" as const, minimum: 0 } },
  };
  assert.deepEqual(validateParams(schema, { method: "stage2-ora-ranking", seed: 0 }), []);
  assert.ok(validateParams(schema, { method: "gsea" }).some((error) => /must be one of/.test(error)));
  assert.ok(validateParams(schema, { seed: 1.5 }).some((error) => /must be an integer/.test(error)));
  assert.ok(validateParams(schema, { seed: -1 }).some((error) => /must be ≥ 0/.test(error)));
});

test("defaultParams and exampleParams derive from the schema", () => {
  const schema = {
    type: "object" as const,
    properties: { thresholds: { type: "array" as const, items: { type: "number" as const }, default: [0.01, 0.05, 0.1] } },
    examples: [{ thresholds: [0.01, 0.05, 0.1] }],
  };
  assert.deepEqual(defaultParams(schema), { thresholds: [0.01, 0.05, 0.1] });
  assert.deepEqual(exampleParams(schema), { thresholds: [0.01, 0.05, 0.1] });
});
