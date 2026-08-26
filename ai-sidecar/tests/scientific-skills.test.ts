import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { SCIENTIFIC_SKILL_IDS, SCIENTIFIC_SKILL_POLICIES, loadScientificSkillLock } from "../src/skills/scientific-catalog.js";

const SIDECAR = path.join(import.meta.dirname, "..");
const ROOT = path.join(SIDECAR, "skills", "scientific");

test("all and only the approved 17 complete upstream SKILL.md packages are vendored", () => {
  const directories = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((item) => item.isDirectory()).map((item) => item.name).sort();
  assert.deepEqual(directories, [...SCIENTIFIC_SKILL_IDS].sort());
  for (const id of SCIENTIFIC_SKILL_IDS) assert.equal(fs.existsSync(path.join(ROOT, id, "SKILL.md")), true, `${id}/SKILL.md`);
  const loaded = loadSkillsFromDir({ dir: ROOT, source: "scientific-lock-test" });
  assert.deepEqual(loaded.skills.map((item) => item.name).sort(), [...SCIENTIFIC_SKILL_IDS].sort());
});

test("scientific lock records the real source commit and verifies complete-folder hashes", () => {
  const lock = loadScientificSkillLock();
  assert.equal(lock.upstream.repository, "https://github.com/K-Dense-AI/scientific-agent-skills.git");
  assert.match(lock.upstream.commit, /^[0-9a-f]{40}$/);
  assert.equal(lock.skills.length, 17);
  assert.equal(lock.skills.every((item) => /^[0-9a-f]{64}$/.test(item.folderHash) && item.fileCount > 0), true);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/sync-scientific-skills.ts"], { cwd: SIDECAR, stdio: "pipe" });
});

test("catalog surfaces license, readiness, environment, network, determinism, and script policy honestly", () => {
  assert.equal(SCIENTIFIC_SKILL_POLICIES.length, 17);
  assert.equal(SCIENTIFIC_SKILL_POLICIES.find((item) => item.id === "bioservices")?.license, "GPL-3.0");
  assert.equal(SCIENTIFIC_SKILL_POLICIES.find((item) => item.id === "citation-management")?.prohibitedScripts.includes("scripts/generate_schematic_ai.py"), true);
  assert.equal(SCIENTIFIC_SKILL_POLICIES.find((item) => item.id === "markitdown")?.prohibitedScripts.includes("scripts/convert_with_ai.py"), true);
  assert.equal(SCIENTIFIC_SKILL_POLICIES.filter((item) => ["pyopenms", "pydeseq2", "scanpy"].includes(item.id)).every((item) => item.readiness === "smoke-tested" && item.allowedScripts.length === 1), true);
});
