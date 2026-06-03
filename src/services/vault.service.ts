import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import fg from "fast-glob";
import type { VaultNote } from "../models/note.model.js";
import { DEFAULT_MARKDOWN_IGNORE } from "../config/vault-policy.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { canonicalizeFrontmatter } from "../utils/frontmatter-schema.js";
import { asStringArray } from "../utils/memory-format.js";

export class VaultService {
  constructor(public readonly vaultRoot: string) {}

  async listMarkdownFiles(): Promise<string[]> {
    return fg(["**/*.md"], {
      cwd: this.vaultRoot,
      absolute: true,
      ignore: [...DEFAULT_MARKDOWN_IGNORE],
    });
  }

  relativePath(fullPath: string) {
    return relative(this.vaultRoot, fullPath).replace(/\\/g, "/");
  }

  noteFullPath(relativePath: string) {
    const fullPath = resolve(this.vaultRoot, relativePath);
    const root = resolve(this.vaultRoot);
    if (fullPath !== root && !fullPath.startsWith(root + "\\" ) && !fullPath.startsWith(root + "/")) {
      throw new Error(`Path escapes memory vault: ${relativePath}`);
    }
    return fullPath;
  }

  exists(relativePath: string) {
    return existsSync(this.noteFullPath(relativePath));
  }

  readRaw(relativePath: string) {
    return readFileSync(this.noteFullPath(relativePath), "utf8");
  }

  load(relativePath: string) {
    const raw = this.readRaw(relativePath);
    const parsed = parseFrontmatter(raw);
    const { data } = canonicalizeFrontmatter(parsed.data);
    return {
      raw,
      parsed: { data, content: parsed.body },
      diagnostics: parsed.diagnostics,
      hasFrontmatter: parsed.hasFrontmatter,
    };
  }

  toNote(relativePath: string): VaultNote {
    const { parsed } = this.load(relativePath);
    return {
      path: relativePath,
      title: String(parsed.data.title ?? relativePath),
      type: String(parsed.data.type ?? "note"),
      tags: asStringArray(parsed.data.tags),
      created: parsed.data.created === undefined ? undefined : String(parsed.data.created),
      updated: parsed.data.updated === undefined ? undefined : String(parsed.data.updated),
      content: parsed.content,
    };
  }
}
