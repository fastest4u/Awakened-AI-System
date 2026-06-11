import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VaultService } from "../services/vault.service.js";

/** Max timestamped note-overwrite backup dirs kept under .memory-mcp/backups. */
const MAX_BACKUP_DIRS = 20;

export class NoteRepository {
  constructor(private readonly vault: VaultService) {}

  write(relativePath: string, content: string) {
    const fullPath = this.vault.noteFullPath(relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    // Never clobber an existing, differing note without a recoverable copy.
    if (existsSync(fullPath)) {
      const current = readFileSync(fullPath, "utf8");
      if (current !== content) this.backupExisting(relativePath, current);
    }
    // Atomic write: stage to a temp file, then rename over the target.
    const tmp = `${fullPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, fullPath);
    return relativePath.replace(/\\/g, "/");
  }

  private backupExisting(relativePath: string, current: string) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupsRoot = join(this.vault.vaultRoot, ".memory-mcp", "backups");
    const dest = join(backupsRoot, `note-overwrite-${stamp}`, relativePath.replace(/\\/g, "/"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, current, "utf8");
    this.pruneBackups(backupsRoot);
  }

  /** Keep at most MAX_BACKUP_DIRS backup dirs; the ISO stamps sort chronologically. */
  private pruneBackups(backupsRoot: string) {
    let names: string[];
    try {
      names = readdirSync(backupsRoot).filter((name) => name.startsWith("note-overwrite-")).sort();
    } catch {
      return;
    }
    for (const name of names.slice(0, Math.max(0, names.length - MAX_BACKUP_DIRS))) {
      try {
        rmSync(join(backupsRoot, name), { recursive: true, force: true });
      } catch {
        // Best-effort rotation; never fail the note write because pruning failed.
      }
    }
  }

  exists(relativePath: string) {
    return this.vault.exists(relativePath);
  }
}
