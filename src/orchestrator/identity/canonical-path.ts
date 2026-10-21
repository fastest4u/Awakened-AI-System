import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

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

export function canonicalExistingPath(path: string): string {
  assertPathSupplied(path);
  return resolve(realpathSync.native(path));
}

export function sameCanonicalPath(left: string, right: string): boolean {
  assertPathSupplied(left);
  assertPathSupplied(right);
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

/**
 * Resolve a lexical child path while proving every existing path component
 * remains inside the canonical root. Nonexistent leaf paths are allowed so a
 * deleted/anticipated project artifact can still be represented safely.
 */
export function resolveContainedProjectPath(
  projectRoot: string,
  projectRelativePath: string,
): string {
  assertPathSupplied(projectRelativePath);
  if (isAbsolute(projectRelativePath)) throw new Error("PATH_OUTSIDE_ROOT");
  const canonicalRoot = canonicalExistingDirectory(projectRoot);
  const lexicalTarget = resolve(canonicalRoot, projectRelativePath);
  assertContainedPath(canonicalRoot, lexicalTarget);

  let existing = lexicalTarget;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (sameCanonicalPath(parent, existing)) throw new Error("PATH_OUTSIDE_ROOT");
    existing = parent;
  }
  const canonicalExisting = canonicalExistingPath(existing);
  assertContainedPath(canonicalRoot, canonicalExisting);
  if (existsSync(lexicalTarget)) {
    assertContainedPath(canonicalRoot, canonicalExistingPath(lexicalTarget));
  }
  return lexicalTarget;
}
