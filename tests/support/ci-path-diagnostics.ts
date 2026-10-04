import { createRequire } from "node:module";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

export type PathFamily = "coordinator" | "manifest" | "integrity" | "fresh-admission" | "durable-directory";
export type DiagnosticCase = "recipe-measurement" | "regular-control" | "link-control" | "size-control" | "read-control"
  | "identity-control" | "path-control" | "coordinator-control" | "manifest-control" | "integrity-control"
  | "admission-control" | "durability-control" | "cleanup-control";
export interface DiagnosticCollector {
  observe(record: unknown): boolean;
  readonly incomplete: boolean;
}

// Require imports the inert measured script; its CLI main guard is never entered.
export const createCiDiagnosticCollector: (writeJSON: (line: string) => void) => DiagnosticCollector =
  createRequire(import.meta.url)(resolve("scripts/run-v2-shadow-migration-rehearsal.js")).createCiDiagnosticCollector;

export function capturePathSnapshot(input: {
  family: PathFamily; caseId: DiagnosticCase; directory: string; durableBase?: string;
}, collector: DiagnosticCollector): void {
  const observed: Record<string, boolean | string> = {
    absolute: isAbsolute(input.directory), normalized: normalize(input.directory) === input.directory,
    resolved: resolve(input.directory) === input.directory, statSuccess: "unknown", nativeRealpathSuccess: "unknown",
    directory: "unknown", symlink: "unknown", canonicalEqual: "unknown", relativeAbsolute: "unknown",
    parentEscape: "unknown", walkReachedBase: "unknown", operation: "none", errorCode: "none",
  };
  if (input.durableBase !== undefined) {
    const fromBase = relative(resolve(input.durableBase), resolve(input.directory));
    observed.relativeAbsolute = isAbsolute(fromBase);
    observed.parentEscape = fromBase === ".." || fromBase.startsWith(`..${sep}`);
  }
  let reason = "snapshot";
  let operation = "lstat";
  try {
    const stat = lstatSync(input.directory);
    observed.statSuccess = true;
    observed.directory = stat.isDirectory();
    observed.symlink = stat.isSymbolicLink();
    operation = "realpath";
    const native = resolve(realpathSync.native(input.directory));
    observed.nativeRealpathSuccess = true;
    const expected = resolve(input.directory);
    observed.canonicalEqual = process.platform === "win32"
      ? native.toLowerCase() === expected.toLowerCase() : native === expected;
  } catch (error) {
    reason = "filesystem";
    observed[operation === "lstat" ? "statSuccess" : "nativeRealpathSuccess"] = false;
    observed.operation = operation;
    let code: unknown;
    try { code = (error as NodeJS.ErrnoException)?.code; } catch { /* Unavailable codes stay unknown. */ }
    observed.errorCode = ["ENOENT", "EACCES", "EPERM", "EINVAL", "EIO"].includes(code as string) ? code as string : "unknown";
  }
  try {
    collector.observe({ schemaVersion: 1, family: input.family, caseId: input.caseId, platform: process.platform,
      boundary: "path-snapshot", phase: "pre-boundary-snapshot", reason, observed });
  } catch { /* A diagnostic observer cannot replace the existing product outcome. */ }
}
