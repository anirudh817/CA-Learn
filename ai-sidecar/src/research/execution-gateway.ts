import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ResearchScopeManifest } from "../grounding/research-scope.js";
import { loadScientificSkillLock, SCIENTIFIC_SKILL_POLICIES, scientificSkillsRoot, type DeterminismClass } from "../skills/scientific-catalog.js";

const sha = (value: Buffer | string) => crypto.createHash("sha256").update(value).digest("hex");
const bounded = (value: string, max = 32_000) => value.length <= max ? value : `${value.slice(0, max)}\n[truncated ${value.length - max} chars]`;
const within = (root: string, filename: string) => filename === root || filename.startsWith(`${root}${path.sep}`);

export interface ExecutionReceipt {
  schemaVersion: "1.0"; jobId: string; stepId: string; piSessionId: string;
  reasoningProfiles: string[]; approvedSkills: string[]; activatedSkill: string;
  skillMdPath: string; skillMdHash: string; upstreamRepository: string; upstreamCommit: string; skillFolderHash: string;
  executable: { type: "script" | "custom-tool"; identity: string; arguments: string[] };
  environment: { id: string; lockHash: string; python: string; image?: { ref: string; digest: string } };
  inputs: Array<{ path: string; sha256: string }>; outputs: Array<{ path: string; mimeType: string; bytes: number; sha256: string }>;
  determinism: DeterminismClass; networkPolicy: string; externalActivity: "none" | "brokered";
  /** Per-job egress proxy audit (network skills only): every outbound request the
   *  proxy saw — host, status, bytes, response sha256, per-request latency, or the
   *  reason it was blocked. Lets a reviewer audit exactly what left the box, what
   *  came back, and where the time went. */
  egress?: Array<{ at?: string; host?: string; method?: string; path?: string; status?: number; reqBytes?: number; respBytes?: number; respSha256?: string; durationMs?: number; blocked?: string }>;
  /** Latency attribution for a network-skill run (the receipt's durationMs is the
   *  whole thing): Docker bring-up vs in-container skill compute vs teardown vs the
   *  time spent in proxied egress, so the OCC can attribute slowness. */
  timing?: { totalMs: number; setupMs?: number; execMs?: number; teardownMs?: number; egressMs?: number };
  startedAt: string; endedAt: string; durationMs: number; exitCode: number | null; timedOut: boolean; stdout: string; stderr: string;
}

export class SkillExecutionGateway {
  constructor(private readonly python = path.join(process.cwd(), "..", ".venv", "bin", "python")) {}

  async run(input: { jobId: string; stepId: string; piSessionId: string; reasoningProfiles: string[]; approvedSkills: string[]; skillId: string; script: string; args: string[]; workspace: string; runPath: string; scope: ResearchScopeManifest; timeoutMs?: number }): Promise<ExecutionReceipt> {
    const policy = SCIENTIFIC_SKILL_POLICIES.find((item) => item.id === input.skillId);
    if (!policy || !input.approvedSkills.includes(input.skillId)) throw new Error("Skill is not approved for this research job");
    if (policy.networkPolicy !== "offline") throw new Error("Networked scientific scripts require a brokered egress boundary and are disabled");
    if (!policy.allowedScripts.includes(input.script)) throw new Error("Script is not allowed for this skill");
    const skillRoot = path.resolve(scientificSkillsRoot(), input.skillId);
    const script = path.resolve(skillRoot, input.script);
    if (!within(skillRoot, script) || !fs.existsSync(script)) throw new Error("Script path escapes the approved vendored skill folder");
    const inputsRoot = path.join(input.workspace, "inputs");
    const outputsRoot = path.join(input.workspace, "outputs");
    fs.mkdirSync(inputsRoot, { recursive: true }); fs.mkdirSync(outputsRoot, { recursive: true });
    const receiptInputs: ExecutionReceipt["inputs"] = [];
    for (const artifact of input.scope.artifacts) {
      const source = path.resolve(input.runPath, artifact.path);
      if (!within(path.resolve(input.runPath), source) || sha(fs.readFileSync(source)) !== artifact.sha256) throw new Error(`Frozen input changed or escaped: ${artifact.path}`);
      const target = path.join(inputsRoot, artifact.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Frozen inputs are staged read-only (0444). The first skill run in a job
      // stages them; later steps re-enter here with the target already present,
      // so a plain copyFileSync onto the read-only file fails with EACCES.
      // Re-stage only when the target is missing or stale (dropping the
      // read-only bit first); otherwise the already-frozen copy is reused.
      if (!fs.existsSync(target) || sha(fs.readFileSync(target)) !== artifact.sha256) {
        if (fs.existsSync(target)) fs.chmodSync(target, 0o644);
        fs.copyFileSync(source, target);
        fs.chmodSync(target, 0o444);
      }
      receiptInputs.push({ path: `inputs/${artifact.path}`, sha256: artifact.sha256 });
    }
    const safeArgs = input.args.map((arg) => {
      if (path.isAbsolute(arg) || arg.split(/[\\/]/).includes("..")) throw new Error("Script argument contains an absolute or traversing path");
      return arg;
    });
    const started = Date.now(), startedAt = new Date(started).toISOString();
    const uvSpecs: Record<string, string> = { "omics-pyopenms": "pyopenms==3.5.0", "omics-pydeseq2": "pydeseq2==0.5.4", "omics-scanpy": "scanpy>=1.12,<1.13" };
    const uvSpec = uvSpecs[policy.environmentId]; const command = uvSpec ? "uv" : this.python;
    const commandArgs = uvSpec ? ["run", "--isolated", "--with", uvSpec, "python", script, ...safeArgs] : [script, ...safeArgs];
    // Persist matplotlib's font cache across jobs. HOME is sandboxed to the
    // per-job workspace, so a per-workspace MPLCONFIGDIR would rebuild the font
    // cache on every job's first figure (~tens of seconds). Mirror UV_CACHE_DIR:
    // a stable real-home cache, shared and warm across jobs.
    const mplCacheDir = path.join(process.env.HOME || input.workspace, ".cache", "signalfold-matplotlib");
    fs.mkdirSync(mplCacheDir, { recursive: true });
    const child = spawn(command, commandArgs, { cwd: input.workspace, env: { PATH: `${path.dirname(this.python)}:${process.env.PATH || ""}`, HOME: input.workspace, TMPDIR: path.join(input.workspace, "tmp"), UV_CACHE_DIR: path.join(process.env.HOME || input.workspace, ".cache", "uv"), PYTHONDONTWRITEBYTECODE: "1", MPLCONFIGDIR: mplCacheDir, NO_PROXY: "*", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (chunk) => { stdout += String(chunk); }); child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, Math.max(100, input.timeoutMs ?? 60_000));
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); }); clearTimeout(timeout);
    const ended = Date.now();
    const outputs = fs.existsSync(outputsRoot) ? this.collectOutputs(outputsRoot, input.workspace) : [];
    const lock = loadScientificSkillLock(); const locked = lock.skills.find((item) => item.id === input.skillId)!;
    const skillMd = path.join(skillRoot, "SKILL.md");
    return { schemaVersion: "1.0", jobId: input.jobId, stepId: input.stepId, piSessionId: input.piSessionId, reasoningProfiles: input.reasoningProfiles, approvedSkills: input.approvedSkills, activatedSkill: input.skillId,
      skillMdPath: path.relative(path.join(scientificSkillsRoot(), ".."), skillMd).replaceAll("\\", "/"), skillMdHash: sha(fs.readFileSync(skillMd)), upstreamRepository: lock.upstream.repository, upstreamCommit: lock.upstream.commit, skillFolderHash: locked.folderHash,
      executable: { type: "script", identity: input.script, arguments: safeArgs }, environment: { id: policy.environmentId, lockHash: sha(`${policy.environmentId}:${uvSpec || policy.version}`), python: uvSpec ? `uv:${uvSpec}` : this.python }, inputs: receiptInputs, outputs,
      determinism: policy.determinism, networkPolicy: policy.networkPolicy, externalActivity: "none", startedAt, endedAt: new Date(ended).toISOString(), durationMs: ended - started, exitCode, timedOut, stdout: bounded(stdout), stderr: bounded(stderr) };
  }

  private collectOutputs(root: string, workspace: string): ExecutionReceipt["outputs"] {
    const result: ExecutionReceipt["outputs"] = [];
    const walk = (directory: string) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) walk(file); else { const bytes = fs.readFileSync(file); result.push({ path: path.relative(workspace, file).replaceAll("\\", "/"), mimeType: file.endsWith(".json") ? "application/json" : file.endsWith(".md") ? "text/markdown" : file.endsWith(".csv") ? "text/csv" : "application/octet-stream", bytes: bytes.length, sha256: sha(bytes) }); } } };
    walk(root); return result;
  }
}
