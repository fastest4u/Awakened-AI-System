import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { VaultService } from "../services/vault.service.js";

export class NoteRepository {
  constructor(private readonly vault: VaultService) {}

  write(relativePath: string, content: string) {
    const fullPath = this.vault.noteFullPath(relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
    return relativePath.replace(/\\/g, "/");
  }

  exists(relativePath: string) {
    return this.vault.exists(relativePath);
  }
}
