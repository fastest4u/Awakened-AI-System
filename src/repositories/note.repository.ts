import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VaultService } from "../services/vault.service.js";

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
    const dest = join(this.vault.vaultRoot, ".memory-mcp", "backups", `note-overwrite-${stamp}`, relativePath.replace(/\\/g, "/"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, current, "utf8");
  }

  exists(relativePath: string) {
    return this.vault.exists(relativePath);
  }
}
