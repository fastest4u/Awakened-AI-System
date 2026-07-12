import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

function assertPathSupplied(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("PATH_REQUIRED");
  }
}

export function canonicalExistingDirectory(path: string): string {
  assertPathSupplied(path);
  const realPath = realpathSync.native(path);
  if (!statSync(realPath).isDirectory()) throw new Error("PATH_NOT_DIRECTORY");
  return resolve(realPath);
}

export function assertContainedPath(canonicalRoot: string, canonicalTarget: string): void {
  assertPathSupplied(canonicalRoot);
  assertPathSupplied(canonicalTarget);
  const relativePath = relative(canonicalRoot, canonicalTarget);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("PATH_OUTSIDE_ROOT");
  }
}
