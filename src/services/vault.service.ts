import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import fg from "fast-glob";
import matter from "gray-matter";
import type { VaultNote } from "../models/note.model.js";
import { asStringArray } from "../utils/memory-format.js";

export class VaultService {
  constructor(public readonly vaultRoot: string) {}

  async listMarkdownFiles(): Promise<string[]> {
    return fg(["**/*.md"], {
      cwd: this.vaultRoot,
      absolute: true,
      ignore: [".obsidian/**", "node_modules/**", "dist/**", "build/**"],
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

  load(relativePath: string) {
    const raw = readFileSync(this.noteFullPath(relativePath), "utf8");
    const parsed = matter(raw);
    return { raw, parsed };
  }

  toNote(relativePath: string): VaultNote {
    const { parsed } = this.load(relativePath);
    return {
      path: relativePath,
      title: String(parsed.data.title ?? relativePath),
      type: String(parsed.data.type ?? "note"),
      tags: asStringArray(parsed.data.tags),
      created: parsed.data.created,
      updated: parsed.data.updated,
      content: parsed.content,
    };
  }
}
