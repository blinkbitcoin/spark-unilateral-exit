// Guarded writes for recovery-critical files.
//
// The recovery bundle and the refund-packages file are the only copies of the
// data needed to resume a partial recovery and sweep its refunds; losing them
// can strand funds behind timelocks. Every CLI write to such a file goes
// through writeFileWithBackup: replacing different content always leaves a
// timestamped backup next to the original, so no run - including test runs
// against the wrong path - can silently destroy resume state.

import fs from "node:fs";

export interface WriteFileWithBackupResult {
  /** Path of the timestamped copy of the previous content, if one was made. */
  backupPath: string | null;
  /** True when the file already had exactly this content (nothing written). */
  unchanged: boolean;
}

export function writeFileWithBackup(
  path: string,
  content: string,
  { mode = 0o600 }: { mode?: number } = {},
): WriteFileWithBackupResult {
  if (fs.existsSync(path)) {
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(path, "utf8");
    } catch {
      // Unreadable existing file: still preserve its bytes via copyFileSync.
    }
    if (existing === content) {
      return { backupPath: null, unchanged: true };
    }
    const backupPath = timestampedBackupPath(path);
    fs.copyFileSync(path, backupPath);
    atomicWriteFileSync(path, content, mode);
    return { backupPath, unchanged: false };
  }
  atomicWriteFileSync(path, content, mode);
  return { backupPath: null, unchanged: false };
}

// Write-to-temp + rename so a crash mid-write can never leave the target
// truncated: the file is either its previous content or the complete new
// content (rename is atomic on the same filesystem). A crash between the
// backup copy and the rename leaves a redundant backup, which is harmless.
function atomicWriteFileSync(path: string, content: string, mode: number): void {
  const tempPath = `${path}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, content, { mode });
  try {
    fs.renameSync(tempPath, path);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Keep the original error; a stray temp file is not worth masking it.
    }
    throw error;
  }
}

// <name>.<UTC timestamp>.backup.json for .json files (matching the Makefile's
// refresh-recovery-bundle naming), <path>.<UTC timestamp>.backup otherwise.
// A numeric suffix keeps same-second backups from clobbering each other.
export function timestampedBackupPath(path: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const candidate = (suffix: string) =>
    path.endsWith(".json")
      ? `${path.slice(0, -5)}.${timestamp}${suffix}.backup.json`
      : `${path}.${timestamp}${suffix}.backup`;
  let backupPath = candidate("");
  for (let i = 1; fs.existsSync(backupPath); i += 1) {
    backupPath = candidate(`-${i}`);
  }
  return backupPath;
}

/**
 * Leaf ids present in an existing packages file. Returns [] when the file is
 * missing and null when it exists but cannot be parsed, so callers can warn
 * about corruption; overwrite protection must not block on corrupt data
 * (the byte-level backup still preserves it).
 */
export function packagesFileLeafIds(path: string): string[] | null {
  if (!fs.existsSync(path)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
    const packages = parsed?.packages ?? parsed;
    if (!Array.isArray(packages)) return null;
    return packages
      .map((p) => (typeof p?.leafId === "string" ? p.leafId : null))
      .filter((id): id is string => id !== null);
  } catch {
    return null;
  }
}
