import { readFileSync } from "node:fs";
import type { VaultNote } from "../models/note.model.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { canonicalizeFrontmatter } from "../utils/frontmatter-schema.js";
import { VaultService } from "../services/vault.service.js";

export class VaultRepository {
  constructor(private readonly vault: VaultService) {}

  async listMarkdownFiles(): Promise<string[]> {
    return this.vault.listMarkdownFiles();
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
      const parsed = parseFrontmatter(raw);
      const { data } = canonicalizeFrontmatter(parsed.data);
      return { fullPath, raw, parsed: { data, content: parsed.body }, diagnostics: parsed.diagnostics };
    }));
  }
}
