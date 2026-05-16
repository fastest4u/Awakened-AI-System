import type { NoteRepository } from "../repositories/note.repository.js";
import { normalizeMarkdownPath } from "../utils/memory-format.js";

export class NoteService {
  constructor(private readonly notes: NoteRepository) {}

  create(relativePath: string, content: string, overwrite = false) {
    const path = overwrite ? normalizeMarkdownPath(relativePath) : this.uniquePath(relativePath);
    return this.notes.write(path, content);
  }

  private uniquePath(relativePath: string) {
    const path = normalizeMarkdownPath(relativePath);
    if (!this.notes.exists(path)) return path;

    const withoutExt = path.replace(/\.md$/i, "");
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${withoutExt}-${index}.md`;
      if (!this.notes.exists(candidate)) return candidate;
    }

    throw new Error(`Could not allocate a unique note path for ${relativePath}`);
  }
}
