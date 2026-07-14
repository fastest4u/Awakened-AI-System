import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function canonicalMkdtemp(prefix: string): string {
  const rawDirectory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return resolve(realpathSync.native(rawDirectory));
  } catch (error) {
    try {
      rmSync(rawDirectory, { recursive: true, force: true });
    } finally {
      throw error;
    }
  }
}
