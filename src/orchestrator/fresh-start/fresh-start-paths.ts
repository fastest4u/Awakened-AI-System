import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalExistingDirectory } from "../identity/canonical-path.js";
import { FreshStartError } from "./contracts.js";

export type FreshStartPaths = Readonly<{ projectRoot: string; v2VaultRoot: string; v1ArchiveRoot: string }>;

/** Resolve existing ancestors too, so an absent child under a junction cannot bypass separation. */
export function canonicalFreshStartPath(value: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) throw new FreshStartError("FRESH_START_PATH_INVALID");
  const requested = resolve(value);
  let cursor = requested;
  while (true) {
    try {
      const stat = lstatSync(cursor);
      if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new FreshStartError("FRESH_START_PATH_INVALID");
      const canonical = canonicalExistingDirectory(cursor);
      return resolve(canonical, relative(cursor, requested));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new FreshStartError("FRESH_START_PATH_INVALID");
      const parent = dirname(cursor);
      if (parent === cursor) throw new FreshStartError("FRESH_START_PATH_INVALID");
      cursor = parent;
    }
  }
}

export function freshStartPathContains(root: string, target: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const rel = relative(normalize(root), normalize(target));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function assertFreshStartDisjoint(left: string, right: string): void {
  if (freshStartPathContains(left, right) || freshStartPathContains(right, left)) throw new FreshStartError("FRESH_START_PATH_OVERLAP");
}

export async function assertFreshStartPaths(paths: FreshStartPaths): Promise<FreshStartPaths> {
  try {
    const projectRoot = canonicalExistingDirectory(paths.projectRoot);
    const v1ArchiveRoot = canonicalExistingDirectory(paths.v1ArchiveRoot);
    const v2VaultRoot = canonicalFreshStartPath(paths.v2VaultRoot);
    assertFreshStartDisjoint(v1ArchiveRoot, v2VaultRoot);
    if (!freshStartPathContains(projectRoot, v2VaultRoot)) throw new FreshStartError("FRESH_START_PATH_INVALID");
    return Object.freeze({ projectRoot, v2VaultRoot, v1ArchiveRoot });
  } catch (error) {
    if (error instanceof FreshStartError) throw error;
    throw new FreshStartError("FRESH_START_PATH_INVALID");
  }
}

/** Canonical administrative descendants must never be replaced with links. */
export function assertFreshStartOwnedDirectory(path: string, archive: string): void {
  const canonical = canonicalFreshStartPath(path);
  assertFreshStartDisjoint(canonical, archive);
  const same = process.platform === "win32" ? canonical.toLowerCase() === resolve(path).toLowerCase() : canonical === resolve(path);
  if (!same) throw new FreshStartError("FRESH_START_PATH_CHANGED");
  try {
    if (lstatSync(path).isSymbolicLink() || realpathSync.native(path) !== canonical) throw new FreshStartError("FRESH_START_PATH_CHANGED");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
