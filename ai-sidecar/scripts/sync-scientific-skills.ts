import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SCIENTIFIC_SKILL_IDS, SCIENTIFIC_SKILL_POLICIES } from "../src/skills/scientific-catalog.js";

const UPSTREAM_REPOSITORY = "https://github.com/K-Dense-AI/scientific-agent-skills.git";
const UPSTREAM_COMMIT = "209390194c85b3466259853417eeac81ea4f0976";
const sidecarRoot = path.join(import.meta.dirname, "..");
const destinationRoot = path.join(sidecarRoot, "skills", "scientific");
const lockFile = path.join(destinationRoot, "scientific-skills.lock.json");
const ignored = new Set([".DS_Store"]);

function files(directory: string, base = directory): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? files(absolute, base) : [path.relative(base, absolute).replaceAll("\\", "/")];
  }).sort();
}

function folderHash(directory: string) {
  const listing = files(directory);
  const digest = crypto.createHash("sha256");
  for (const relative of listing) {
    digest.update(relative); digest.update("\0");
    digest.update(crypto.createHash("sha256").update(fs.readFileSync(path.join(directory, relative))).digest("hex"));
    digest.update("\n");
  }
  return { folderHash: digest.digest("hex"), fileCount: listing.length };
}

function buildLock() {
  return {
    schemaVersion: "1.0",
    generatedAt: "2026-06-23T00:00:00.000Z",
    upstream: { repository: UPSTREAM_REPOSITORY, commit: UPSTREAM_COMMIT },
    hashAlgorithm: "sha256(sorted-relative-path + NUL + file-sha256 + LF), Finder metadata excluded",
    skills: SCIENTIFIC_SKILL_IDS.map((id) => {
      const policy = SCIENTIFIC_SKILL_POLICIES.find((item) => item.id === id)!;
      const directory = path.join(destinationRoot, id);
      if (!fs.existsSync(path.join(directory, "SKILL.md"))) throw new Error(`${id}: complete package is missing SKILL.md`);
      return { ...policy, ...folderHash(directory) };
    }),
  };
}

function verify() {
  const expected = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  const actual = buildLock();
  const failures: string[] = [];
  if (expected.upstream.repository !== UPSTREAM_REPOSITORY || expected.upstream.commit !== UPSTREAM_COMMIT) failures.push("upstream source revision differs");
  for (const skill of actual.skills) {
    const locked = expected.skills.find((item: { id: string }) => item.id === skill.id);
    if (!locked) failures.push(`${skill.id}: absent from lock`);
    else if (locked.folderHash !== skill.folderHash || locked.fileCount !== skill.fileCount) failures.push(`${skill.id}: folder content drift`);
  }
  if (expected.skills.length !== SCIENTIFIC_SKILL_IDS.length) failures.push("lock does not contain exactly the approved 17 skills");
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(`Verified ${actual.skills.length} complete scientific skill packages at ${UPSTREAM_COMMIT}.`);
}

if (process.argv.includes("--write-lock")) {
  fs.writeFileSync(lockFile, `${JSON.stringify(buildLock(), null, 2)}\n`);
  console.log(`Wrote ${path.relative(sidecarRoot, lockFile)}.`);
} else verify();
