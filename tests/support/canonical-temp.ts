import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function canonicalMkdtemp(prefix: string): string {
  return resolve(realpathSync.native(mkdtempSync(join(tmpdir(), prefix))));
}
