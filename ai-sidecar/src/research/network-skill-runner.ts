import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dockerCli } from "./docker.js";
import { loadScientificSkillLock, SCIENTIFIC_SKILL_POLICIES, scientificSkillsRoot, type ScientificSkillPolicy } from "../skills/scientific-catalog.js";
import type { ExecutionReceipt } from "./execution-gateway.js";

const sha = (value: Buffer | string) => crypto.createHash("sha256").update(value).digest("hex");
const bounded = (value: string, max = 16_000) => (value.length <= max ? value : `${value.slice(0, max)}\n[truncated ${value.length - max} chars]`);
const within = (root: string, candidate: string) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
const mime = (file: string) => file.endsWith(".json") ? "application/json" : file.endsWith(".csv") ? "text/csv" : file.endsWith(".tsv") ? "text/tab-separated-values" : file.endsWith(".md") ? "text/markdown" : file.endsWith(".png") ? "image/png" : "application/octet-stream";

export interface NetworkSandboxConfig {
  netImage: string;
  proxyImage: string;
  memory: string;
  cpus: string;
  pids: number;
  tmpfsSize: string;
  egressMaxRequests: number;
  egressMaxResponseBytes: number;
  egressMaxRequestBytes: number;
  egressTimeoutMs: number;
}

export interface NetworkSkillRunInput {
  jobId: string; stepId: string; sessionId: string; reasoningProfiles: string[];
  skillId: string; script: string; args: string[];
  inputsRoot: string; outputsRoot: string; jobRoot: string;
  /** The frozen-input list already validated by the caller (mounted read-only). */
  receiptInputs: ExecutionReceipt["inputs"];
  /** Exact hosts this job approved (curated sources + skill egressDomains). */
  egressAllowlist: string[];
  timeoutMs?: number;
  /** Observability hook: receives phase events (started/ready/egress/failed) so
   *  the OCC can attribute latency (Docker bring-up vs skill compute vs egress)
   *  and failures live, instead of one opaque after-the-fact duration. */
  onEvent?: (name: string, detail: Record<string, unknown>) => void;
}

/** Runs ONE reviewed approved-external skill script in a per-job container behind
 *  a TLS-intercepting egress proxy. Topology (bypass-resistant by construction):
 *
 *    skill container ──(only member)──> [ --internal bridge ] <── proxy sidecar ──> [ egress bridge ] ──> internet
 *
 *  The skill container is on an `--internal` Docker network with NO route off-box;
 *  its only reachable peer is the proxy (resolved by container name via Docker DNS).
 *  The proxy enforces the host allowlist + outbound exfil scan + caps and logs every
 *  request. run_python and offline skills are unaffected — they stay in the sealed
 *  --network none jail. Fails CLOSED: any bring-up error throws (no host fallback). */
export class NetworkSkillRunner {
  constructor(private readonly config: NetworkSandboxConfig) {}

  async run(input: NetworkSkillRunInput): Promise<ExecutionReceipt> {
    const policy = SCIENTIFIC_SKILL_POLICIES.find((item) => item.id === input.skillId);
    if (!policy || policy.networkPolicy !== "approved-external") throw new Error(`"${input.skillId}" is not a network skill`);
    if (policy.readiness === "unavailable") throw new Error(`Network skill "${input.skillId}" is not yet enabled (readiness: unavailable)`);
    if (!input.egressAllowlist.length) throw new Error("No egress hosts are approved for this job — nothing for the network skill to reach");

    // Resolve the requested script within the skill's vendored folder (tolerate a
    // bare filename; block traversal out of the folder) — same rule as the jail.
    const skillRootHost = path.resolve(scientificSkillsRoot(), input.skillId);
    let relScript = "";
    for (const candidate of [input.script, path.join("scripts", input.script)]) {
      const abs = path.resolve(skillRootHost, candidate);
      if (within(skillRootHost, abs) && fs.existsSync(abs) && fs.statSync(abs).isFile()) { relScript = path.relative(skillRootHost, abs); break; }
    }
    if (!relScript) throw new Error(`Script "${input.script}" was not found in skill "${input.skillId}"`);
    const safeArgs = input.args.map((arg) => { if (path.isAbsolute(arg) || arg.split(/[\\/]/).includes("..")) throw new Error("Script argument contains an absolute or traversing path"); return arg; });
    const containerScript = `/opt/skills/scientific/${input.skillId}/${relScript.replaceAll(path.sep, "/")}`;

    const short = crypto.randomUUID().slice(0, 10);
    const egressNet = `sf-egn-${short}`, internalNet = `sf-int-${short}`, proxyName = `sf-egp-${short}`, skillName = `sf-net-${short}`;
    const egressDir = path.join(input.jobRoot, "egress"); fs.mkdirSync(egressDir, { recursive: true });
    const auditPath = path.join(egressDir, `audit-${short}.jsonl`); fs.writeFileSync(auditPath, "");

    const onEvent = input.onEvent ?? (() => { /* observability is best-effort */ });
    const startedMs = Date.now(); const startedAt = new Date(startedMs).toISOString();
    onEvent("netskill_started", { skillId: input.skillId, script: relScript, egressAllowlist: input.egressAllowlist, netImage: this.config.netImage, proxyImage: this.config.proxyImage });
    let result: { code: number | null; stdout: string; stderr: string; spawnError?: string; timedOut?: boolean } | null = null;
    let proxyDigest = "", netDigest = "", phase = "image";
    let setupMs = 0, execMs = 0, teardownMs = 0;
    const setupStart = Date.now();
    try {
      // Resolve + probe both images first (also the Docker-availability check).
      proxyDigest = await this.imageDigest(this.config.proxyImage, "egress proxy");
      netDigest = await this.imageDigest(this.config.netImage, "network-skill");
      // 1. Networks: an egress-capable bridge for the proxy, and a SEALED internal
      //    bridge (no off-box route) shared by the proxy + skill.
      phase = "network";
      await this.must(["network", "create", egressNet], "create egress network");
      await this.must(["network", "create", "--internal", internalNet], "create internal network");
      // 2. Proxy on the egress bridge (gets internet), then also attached to the
      //    internal bridge (the skill's only reachable peer).
      phase = "proxy";
      await this.must([
        "run", "-d", "--name", proxyName, "--network", egressNet,
        "--label", "signalfold.netskill=1", "--label", `signalfold.job=${input.jobId}`,
        "-e", `EGRESS_ALLOWLIST=${input.egressAllowlist.join(",")}`,
        "-e", "EGRESS_AUDIT_LOG=/work/egress/audit.jsonl",
        "-e", `EGRESS_MAX_REQUESTS=${this.config.egressMaxRequests}`,
        "-e", `EGRESS_MAX_RESPONSE_BYTES=${this.config.egressMaxResponseBytes}`,
        "-e", `EGRESS_MAX_REQUEST_BYTES=${this.config.egressMaxRequestBytes}`,
        "-e", `EGRESS_TIMEOUT_MS=${this.config.egressTimeoutMs}`,
        "-v", `${auditPath}:/work/egress/audit.jsonl:rw`,
        this.config.proxyImage,
      ], "start egress proxy");
      await this.must(["network", "connect", internalNet, proxyName], "attach proxy to internal network");
      await this.waitForProxy(proxyName);
      // 3. Skill container on the SEALED internal bridge only: it can resolve +
      //    reach ONLY the proxy (by name). Frozen inputs read-only; rootfs read-only.
      phase = "container";
      await this.must([
        "run", "-d", "--name", skillName, "--network", internalNet,
        "--label", "signalfold.netskill=1", "--label", `signalfold.job=${input.jobId}`,
        "--read-only", "--tmpfs", `/tmp:rw,size=${this.config.tmpfsSize},mode=1777`,
        "--memory", this.config.memory, "--cpus", this.config.cpus, "--pids-limit", String(this.config.pids),
        "--security-opt", "no-new-privileges", "--init",
        "-e", `HTTP_PROXY=http://${proxyName}:8080`, "-e", `HTTPS_PROXY=http://${proxyName}:8080`,
        "-e", `http_proxy=http://${proxyName}:8080`, "-e", `https_proxy=http://${proxyName}:8080`,
        "-e", "NO_PROXY=", "-e", "no_proxy=", "-e", "HOME=/tmp", "-e", "TMPDIR=/tmp", "-e", "MPLBACKEND=Agg", "-e", "MPLCONFIGDIR=/tmp",
        "-v", `${input.inputsRoot}:/work/inputs:ro`, "-v", `${input.outputsRoot}:/work/outputs:rw`,
        "-w", "/work", this.config.netImage, "sleep", "infinity",
      ], "start network-skill container");
      setupMs = Date.now() - setupStart;
      onEvent("netskill_ready", { setupMs, imageDigest: netDigest, proxyDigest });
      // 4. Run the reviewed skill script (wall clock enforced in-container).
      phase = "exec";
      const seconds = Math.max(1, Math.round((input.timeoutMs ?? 90_000) / 1000));
      const execStart = Date.now();
      const exec = await dockerCli(["exec", "-w", "/work", skillName, "timeout", "-k", "5", String(seconds), "python", containerScript, ...safeArgs], { timeoutMs: (input.timeoutMs ?? 90_000) + 30_000 });
      execMs = Date.now() - execStart;
      const timedOut = (!exec.spawnError && exec.code === null) || exec.code === 124 || exec.code === 137;
      result = { ...exec, timedOut };
    } catch (error) {
      // Attribute the failure to its PHASE (image / network / proxy / container /
      // exec) so the OCC shows where a network-skill run died, not just that it did.
      onEvent("netskill_failed", { phase, error: error instanceof Error ? error.message : String(error), setupMs: setupMs || (Date.now() - setupStart) });
      throw error;
    } finally {
      // Teardown no matter what: kill both containers, drop both networks. Outputs +
      // the egress audit log already live on the host through the bind mounts.
      const teardownStart = Date.now();
      await dockerCli(["rm", "-f", skillName], { timeoutMs: 20_000 }).catch(() => undefined);
      await dockerCli(["rm", "-f", proxyName], { timeoutMs: 20_000 }).catch(() => undefined);
      await dockerCli(["network", "rm", internalNet], { timeoutMs: 15_000 }).catch(() => undefined);
      await dockerCli(["network", "rm", egressNet], { timeoutMs: 15_000 }).catch(() => undefined);
      teardownMs = Date.now() - teardownStart;
    }
    const endedAt = new Date().toISOString(); const durationMs = Date.now() - startedMs;
    const egress = this.readEgressLog(auditPath);
    // Egress latency attribution: total time spent in proxied requests + a per-host
    // roll-up, so a slow run can be pinned to a specific upstream (vs Docker/compute).
    const egressMs = egress.reduce((sum, entry) => sum + (Number(entry.durationMs) || 0), 0);
    const egressByHost: Record<string, { host: string; requests: number; totalMs: number; blocked: number }> = {};
    for (const entry of egress) { const host = String(entry.host || "?"); (egressByHost[host] ??= { host, requests: 0, totalMs: 0, blocked: 0 }); egressByHost[host].requests += 1; egressByHost[host].totalMs += Number(entry.durationMs) || 0; if (entry.blocked) egressByHost[host].blocked += 1; }
    onEvent("netskill_egress", { requests: egress.length, egressMs, blocked: egress.filter((entry) => entry.blocked).length, hosts: Object.values(egressByHost) });
    const timing = { totalMs: durationMs, setupMs, execMs, teardownMs, egressMs };
    const outputs = this.collectOutputs(input.outputsRoot, input.outputsRoot);
    const lock = loadScientificSkillLock();
    const locked = lock.skills.find((item) => item.id === input.skillId);
    const skillMd = path.join(skillRootHost, "SKILL.md");
    const stderr = result?.spawnError ? `${result?.stderr || ""}${result.spawnError}` : (result?.stderr || "");
    return {
      schemaVersion: "1.0", jobId: input.jobId, stepId: input.stepId, piSessionId: input.sessionId,
      reasoningProfiles: input.reasoningProfiles, approvedSkills: [input.skillId], activatedSkill: input.skillId,
      skillMdPath: path.relative(path.join(scientificSkillsRoot(), ".."), skillMd).replaceAll("\\", "/"),
      skillMdHash: fs.existsSync(skillMd) ? sha(fs.readFileSync(skillMd)) : "", upstreamRepository: lock?.upstream.repository ?? "K-Dense-AI/scientific-agent-skills", upstreamCommit: lock?.upstream.commit ?? "vendored", skillFolderHash: locked?.folderHash ?? "",
      executable: { type: "script", identity: relScript, arguments: safeArgs },
      environment: { id: policy.environmentId, lockHash: sha(`${policy.environmentId}@${netDigest}+proxy@${proxyDigest}`), python: `python (${this.config.netImage})`, image: { ref: this.config.netImage, digest: netDigest } },
      inputs: input.receiptInputs, outputs,
      // Honest determinism for a live network result; the egress log is the audit trail.
      determinism: "live-external-state", networkPolicy: "approved-external", externalActivity: "brokered", egress, timing,
      startedAt, endedAt, durationMs, exitCode: result?.code ?? null, timedOut: Boolean(result?.timedOut),
      stdout: bounded(`network skill via egress proxy ${this.config.proxyImage}@${proxyDigest}; allow=[${input.egressAllowlist.join(",")}]; ${egress.length} egress request(s)\n${result?.stdout || ""}`), stderr: bounded(stderr),
    };
  }

  /** Resolve + probe an image (also the Docker-availability check). Throws (fail closed) if unavailable. */
  private async imageDigest(ref: string, label: string): Promise<string> {
    const inspect = await dockerCli(["image", "inspect", ref, "--format", "{{.Id}}"], { timeoutMs: 15_000 });
    if (inspect.spawnError) throw new Error(`Network skills require Docker, but the docker CLI is unavailable (${inspect.spawnError.trim()})`);
    if (inspect.code !== 0) throw new Error(`The ${label} image "${ref}" is not built. Build it: ai-sidecar/run.sh net-build`);
    return inspect.stdout.trim();
  }

  private async must(args: string[], what: string): Promise<void> {
    const out = await dockerCli(args, { timeoutMs: 30_000 });
    if (out.spawnError || out.code !== 0) throw new Error(`Network-skill sandbox failed to ${what}: ${(out.stderr || out.spawnError || "").trim()}`);
  }

  /** Wait until the proxy reports it is listening (bounded), so the skill's first
   *  request does not race startup. */
  private async waitForProxy(proxyName: string): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      const logs = await dockerCli(["logs", proxyName], { timeoutMs: 5_000 });
      if (/egress-proxy listening/.test(logs.stdout + logs.stderr)) return;
      const alive = await dockerCli(["inspect", proxyName, "--format", "{{.State.Running}}"], { timeoutMs: 5_000 });
      if (alive.stdout.trim() !== "true") throw new Error("Egress proxy exited before it became ready");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Egress proxy did not become ready in time");
  }

  private readEgressLog(auditPath: string): NonNullable<ExecutionReceipt["egress"]> {
    try {
      return fs.readFileSync(auditPath, "utf8").split("\n").filter(Boolean).slice(0, 500).map((line) => { try { return JSON.parse(line); } catch { return { blocked: "unparsed" }; } });
    } catch { return []; }
  }

  private collectOutputs(root: string, base: string): ExecutionReceipt["outputs"] {
    const result: ExecutionReceipt["outputs"] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(file); continue; }
        const bytes = fs.readFileSync(file);
        result.push({ path: `outputs/${path.relative(base, file).replaceAll("\\", "/")}`, mimeType: mime(file), bytes: bytes.length, sha256: sha(bytes) });
      }
    };
    walk(root);
    return result;
  }
}
