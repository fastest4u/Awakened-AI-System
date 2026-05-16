import fg from "fast-glob";
import { readFileSync } from "node:fs";
import matter from "gray-matter";
import type { VaultNote } from "../models/note.model.js";
import { VaultService } from "../services/vault.service.js";

export class VaultRepository {
  constructor(private readonly vault: VaultService) {}

  async listMarkdownFiles(): Promise<string[]> {
    return fg(["**/*.md"], { cwd: this.vault.vaultRoot, absolute: true });
  }

  readNote(relativePath: string) {
    return this.vault.load(relativePath);
  }

  readNoteAsModel(relativePath: string): VaultNote {
    return this.vault.toNote(relativePath);
  }

  readAllNotes() {
    return this.listMarkdownFiles().then((files) => files.map((fullPath) => {
      const raw = readFileSync(fullPath, "utf8");
      const parsed = matter(raw);
      return { fullPath, raw, parsed };
    }));
  }
}
