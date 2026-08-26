import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Moves a finished file into the trash and returns its final resting path.
 * Injectable so tests (and non-macOS hosts) can redirect the destination.
 */
export type TrashFile = (absolutePath: string) => Promise<string>;

export interface ArchiveEntry {
  /** Path inside the archive, relative to its root (no leading slash, no ".."). */
  archivePath: string;
  /** Inline text/JSON content for the entry. */
  content?: string;
  /** Absolute source path to copy the entry from (used for artifact files). */
  copyFrom?: string;
}

const within = (root: string, target: string) =>
  target === root || target.startsWith(`${root}${path.sep}`);

/**
 * Stages the given entries under a single top-level folder, zips that folder
 * with the system `zip`, and hands the resulting `.zip` to `trashFile`. The
 * staging directory is always removed; the zip lives wherever `trashFile`
 * moved it. Returns the trashed zip path and how many entries were written.
 *
 * The caller is expected to run this BEFORE deleting any live data — if zipping
 * or the trash move throws, nothing has been destroyed.
 */
export async function archiveToTrash(
  archiveName: string,
  entries: ArchiveEntry[],
  trashFile: TrashFile,
): Promise<{ trashedPath: string; entryCount: number }> {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "signalfold-archive-"));
  const rootDir = path.join(staging, archiveName);
  try {
    fs.mkdirSync(rootDir, { recursive: true });
    let written = 0;
    for (const entry of entries) {
      const dest = path.resolve(rootDir, entry.archivePath);
      if (!within(rootDir, dest)) continue; // never let an entry escape the archive root
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (entry.content !== undefined) {
        fs.writeFileSync(dest, entry.content, "utf8");
        written += 1;
      } else if (entry.copyFrom && fs.existsSync(entry.copyFrom)) {
        fs.copyFileSync(entry.copyFrom, dest);
        written += 1;
      }
    }
    const zipPath = path.join(staging, `${archiveName}.zip`);
    // -r recurse, -q quiet, -X drop extra OS attributes for a clean archive.
    execFileSync("zip", ["-r", "-q", "-X", zipPath, archiveName], { cwd: staging });
    const trashedPath = await trashFile(zipPath);
    return { trashedPath, entryCount: written };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Builds a TrashFile that moves files into the macOS Trash (~/.Trash). When
 * that is unavailable (non-macOS host, or no write access) it falls back to
 * `fallbackDir`. Names are made collision-free and cross-volume moves are
 * handled via copy+unlink.
 */
export function makeTrashFile(fallbackDir: string): TrashFile {
  return async (absolutePath: string) => {
    const userTrash = path.join(os.homedir(), ".Trash");
    const targetDir = process.platform === "darwin" && dirWritable(userTrash) ? userTrash : fallbackDir;
    fs.mkdirSync(targetDir, { recursive: true });
    const finalPath = collisionFreePath(targetDir, path.basename(absolutePath));
    moveFile(absolutePath, finalPath);
    return finalPath;
  };
}

function dirWritable(dir: string): boolean {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}

function collisionFreePath(dir: string, base: string): string {
  if (!fs.existsSync(path.join(dir, base))) return path.join(dir, base);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

function moveFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EXDEV") {
      fs.copyFileSync(from, to);
      fs.rmSync(from, { force: true });
    } else {
      throw error;
    }
  }
}
