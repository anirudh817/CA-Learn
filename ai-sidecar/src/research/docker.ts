import { spawn } from "node:child_process";

/** Thin spawn wrapper around the docker CLI. Never rejects: a spawn failure
 *  (e.g. docker not installed) resolves with `spawnError` so callers decide
 *  (fail closed). Shared by the free-form jail and the network-skill sandbox. */
export function dockerCli(args: string[], opts: { timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    child.on("error", (error) => { if (timer) clearTimeout(timer); resolve({ code: null, stdout, stderr, spawnError: String(error) }); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
