import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface RunSummary { id: string; name: string; status: "COMPLETE"; completedAt: string; path: string }
export interface ContextItem { id: string; name: string; path: string; kind: string; bytes: number }
export interface GroundingFile {
  path: string;
  kind: string;
  availableBytes: number;
  includedBytes: number;
  truncated: boolean;
}
export interface GroundingSnapshot {
  text: string;
  budgetBytes: number;
  includedBytes: number;
  candidateFiles: number;
  files: GroundingFile[];
}

const visibleFile = (rel: string) => {
  const normalized = rel.replaceAll("\\", "/");
  return !normalized.startsWith("ai_insights/") && !normalized.includes("/.RData") &&
    !normalized.endsWith(".RData") && !normalized.endsWith(".Rhistory") && !normalized.endsWith(".rds") &&
    // Web-asset bundles emitted alongside the interactive HTML dashboards
    // (e.g. "..._Interactive_Heatmap_files/jquery-3.5.1/jquery-AUTHORS.txt").
    // These are not pipeline artifacts — keep them out of all AI context.
    !normalized.includes("_files/");
};

export class FilesystemRunCatalog {
  readonly dataDir: string;
  readonly runsDir: string;
  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    this.runsDir = path.join(this.dataDir, "runs");
  }

  list(): RunSummary[] {
    if (!fs.existsSync(this.runsDir)) return [];
    const databaseRuns = this.fromDatabase();
    if (databaseRuns.length) return databaseRuns;
    return fs.readdirSync(this.runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.runsDir, entry.name))
      .filter((directory) => fs.existsSync(path.join(directory, "artifact_index.json")))
      .map((directory) => {
        const stat = fs.statSync(path.join(directory, "artifact_index.json"));
        return { id: path.basename(directory), name: path.basename(directory), status: "COMPLETE" as const, completedAt: stat.mtime.toISOString(), path: directory };
      })
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  }

  get(runId: string) {
    if (!/^[-A-Za-z0-9_.]+$/.test(runId)) return null;
    return this.list().find((run) => run.id === runId) || null;
  }

  context(runId: string): ContextItem[] {
    const run = this.get(runId);
    if (!run) return [];
    const output: ContextItem[] = [];
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        const rel = path.relative(run.path, absolute).replaceAll("\\", "/");
        if (!visibleFile(rel)) continue;
        if (entry.isDirectory()) walk(absolute);
        else {
          const bytes = fs.statSync(absolute).size;
          output.push({ id: `run:${runId}:${rel}`, name: entry.name, path: rel, kind: kindFor(rel), bytes });
        }
      }
    };
    walk(run.path);
    return output.sort((a, b) => a.path.localeCompare(b.path));
  }

  grounding(runId: string, maxBytes = 120_000) {
    return this.groundingSnapshot(runId, maxBytes).text;
  }

  groundingSnapshot(runId: string, maxBytes = 120_000): GroundingSnapshot {
    const run = this.get(runId);
    if (!run) throw new Error("Selected run is unavailable or not complete");
    const preferred = this.context(runId).filter((item) => /(?:artifact_index|manifest|summary|result|enrich|module|cell|volcano|differential)/i.test(item.path));
    const files = (preferred.length ? preferred : this.context(runId)).filter((item) => /\.(?:json|csv|tsv|txt|md)$/i.test(item.path));
    let remaining = maxBytes;
    const excerpts: string[] = [];
    const selected: GroundingFile[] = [];
    for (const item of files) {
      if (remaining <= 0 || excerpts.length >= 12) break;
      const absolute = path.resolve(run.path, item.path);
      if (!absolute.startsWith(`${run.path}${path.sep}`) && absolute !== run.path) continue;
      const text = fs.readFileSync(absolute, "utf8").slice(0, Math.min(20_000, remaining));
      const includedBytes = Buffer.byteLength(text);
      remaining -= includedBytes;
      excerpts.push(`\n--- ${item.path} ---\n${text}`);
      selected.push({
        path: item.path,
        kind: item.kind,
        availableBytes: item.bytes,
        includedBytes,
        truncated: includedBytes < item.bytes,
      });
    }
    const text = `Selected SignalFold run: ${runId}\nTreat these immutable pipeline outputs as primary evidence. Cite file paths for claims.${excerpts.join("")}`;
    return {
      text,
      budgetBytes: maxBytes,
      includedBytes: maxBytes - remaining,
      candidateFiles: files.length,
      files: selected,
    };
  }

  aiRoot(runId: string) {
    const run = this.get(runId);
    if (!run) throw new Error("Selected run is unavailable or not complete");
    const root = path.join(run.path, "ai_insights");
    fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
    fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(root, "work"), { recursive: true });
    fs.mkdirSync(path.join(root, "evals"), { recursive: true });
    return root;
  }

  private fromDatabase(): RunSummary[] {
    const dbPath = path.join(this.dataDir, "proteomics.db");
    if (!fs.existsSync(dbPath)) return [];
    try {
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA query_only=ON");
      const rows = db.prepare("SELECT id,name,completed_at FROM runs WHERE status='COMPLETE' AND trashed_at IS NULL ORDER BY completed_at DESC").all() as any[];
      db.close();
      return rows.filter((row) => fs.existsSync(path.join(this.runsDir, row.id))).map((row) => ({
        id: row.id, name: row.name || row.id, status: "COMPLETE", completedAt: row.completed_at || "", path: path.join(this.runsDir, row.id),
      }));
    } catch { return []; }
  }
}

function kindFor(rel: string) {
  if (/\.(csv|tsv|txt)$/i.test(rel)) return "table";
  if (/\.(png|jpg|jpeg|svg|pdf)$/i.test(rel)) return "visual";
  if (/\.json$/i.test(rel)) return "metadata";
  return "file";
}
