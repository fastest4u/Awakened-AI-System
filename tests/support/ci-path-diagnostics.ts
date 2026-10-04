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

export function classifyEvidence(value: {
  record: unknown; collectorIncomplete: boolean; operationCode: string; expectedCode: string;
  cleanupComplete: boolean; location: "guard" | "snapshot" | "later-read";
}): "exact-refusal" | "snapshot-only" | "incomplete" {
  if (value.collectorIncomplete !== false || value.cleanupComplete !== true
    || !value.expectedCode || value.expectedCode === "none" || value.operationCode !== value.expectedCode
    || !["guard", "snapshot", "later-read"].includes(value.location)) return "incomplete";

  // Reuse D1's closed validator and inspect only its sanitized serialized copy.
  // This also rejects accessors without invoking them and preserves the same caps.
  let row: any;
  const validator = createCiDiagnosticCollector(line => { row = JSON.parse(line); });
  if (!validator.observe(value.record) || validator.incomplete || !row) return "incomplete";
  const o = row.observed;
  const known = (keys: string[]) => keys.every(key => o[key] !== "unknown");
  const unknown = (keys: string[]) => keys.every(key => o[key] === "unknown");
  const comparisons = ["descriptorEqual", "pathEqual", "sizeEqual", "mtimeEqual", "ctimeEqual"];
  const counts = ["linkCount", "size", "limit"];
  const before = ["regular", "singleLink", "withinSizeLimit"];

  if (row.family !== "build") {
    if (!known(["absolute", "normalized", "resolved", "statSuccess"])) return "incomplete";
    if (row.family === "durable-directory" && !known(["relativeAbsolute", "parentEscape"])) return "incomplete";
    if (o.statSuccess === false) {
      if (row.reason !== "filesystem" || o.operation !== "lstat" || o.errorCode === "unknown" || o.errorCode === "none"
        || !unknown(["directory", "symlink", "nativeRealpathSuccess", "canonicalEqual"])) return "incomplete";
    } else {
      if (!known(["directory", "symlink", "nativeRealpathSuccess"])) return "incomplete";
      if (o.nativeRealpathSuccess === false) {
        if (row.reason !== "filesystem" || o.operation !== "realpath" || o.errorCode === "unknown" || o.errorCode === "none"
          || o.canonicalEqual !== "unknown") return "incomplete";
      } else if (row.reason !== "snapshot" || !known(["canonicalEqual"]) || o.operation !== "none" || o.errorCode !== "none") {
        return "incomplete";
      }
    }
    // This schema records parent snapshots, even if a caller labels its location guard.
    return "snapshot-only";
  }

  let sufficient = false;
  if (row.reason === "filesystem") {
    const operations: Record<string, string[]> = {
      "recipe-path": ["lstat", "realpath"], "descriptor-before": ["open", "fstat"],
      read: ["read"], "descriptor-after": ["fstat", "lstat"],
    };
    // A close error cannot substitute for the primary refusal.
    sufficient = operations[row.boundary]?.includes(o.operation) === true
      && o.errorCode !== "unknown" && o.errorCode !== "none" && o.errorCode === value.operationCode
      && unknown([...before, ...comparisons, ...counts]);
  } else if (value.operationCode === "REHEARSAL_BUILD_INVALID" && o.operation === "none" && o.errorCode === "none") {
    if (row.boundary === "recipe-path") {
      // The fixed reason proves only this coarse branch, not its unrecorded subcondition.
      sufficient = row.reason === "path" && unknown([...before, ...comparisons, ...counts]);
    } else if (known(counts)) {
      if (row.boundary === "descriptor-before" && unknown(comparisons)) {
        sufficient = row.reason === "non-regular" && o.regular === false && unknown(["singleLink", "withinSizeLimit"])
          || row.reason === "link-count" && o.regular === true && o.singleLink === false && o.withinSizeLimit === "unknown"
          || row.reason === "size" && o.regular === true && o.singleLink === true && o.withinSizeLimit === false;
      } else if (row.boundary === "read") {
        sufficient = row.reason === "short-read" && before.every(key => o[key] === true) && unknown(comparisons);
      } else if (row.boundary === "descriptor-after" && o.withinSizeLimit === "unknown") {
        if (row.reason === "non-regular" || row.reason === "link-count") {
          sufficient = (row.reason === "non-regular" ? o.regular === false && o.singleLink === "unknown"
            : o.regular === true && o.singleLink === false)
            && (o.descriptorEqual === "unknown" || o.descriptorEqual === true)
            && unknown(["pathEqual", "sizeEqual", "mtimeEqual", "ctimeEqual"]);
        } else if (row.reason === "identity-change" && o.regular === true && o.singleLink === true) {
          const selectedIdentity = o.pathEqual === "unknown" ? o.descriptorEqual : o.pathEqual;
          const chain = [selectedIdentity, o.sizeEqual, o.mtimeEqual, o.ctimeEqual];
          const firstFalse = chain.indexOf(false);
          sufficient = (o.pathEqual === "unknown" || o.descriptorEqual === true) && firstFalse >= 0
            && chain.slice(0, firstFalse).every(predicate => predicate === true)
            && chain.slice(firstFalse + 1).every(predicate => predicate === "unknown");
        }
      }
    }
  }
  if (!sufficient) return "incomplete";
  return value.location === "guard" ? "exact-refusal" : "snapshot-only";
}

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
