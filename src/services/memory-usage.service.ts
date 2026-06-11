import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { todayIso } from "../utils/memory-format.js";

/** Context terms kept per record after a prune; unbounded maps made usage.json grow forever. */
const MAX_CONTEXT_TERMS = 40;

/** Prune only past this size (hysteresis): pruning at exactly MAX_CONTEXT_TERMS
 *  kept a saturated record permanently full, so every new count-1 term was
 *  rejected before it could ever accumulate a competitive count. */
const CONTEXT_PRUNE_THRESHOLD = 48;

interface UsageRecord {
  path: string;
  selectedCount: number;
  lastSelectedAt?: string;
  contexts: Record<string, number>;
}

interface UsageState {
  version: 1;
  updatedAt: string;
  records: Record<string, UsageRecord>;
}

const EMPTY_STATE: UsageState = {
  version: 1,
  updatedAt: todayIso(),
  records: {},
};

export class MemoryUsageService {
  private readonly usagePath: string;

  constructor(vaultRoot: string) {
    this.usagePath = join(vaultRoot, ".memory-mcp", "usage.json");
  }

  snapshot() {
    return this.readState();
  }

  recordContextPack(selected: Array<{ path: string }>, context: { query?: string; taskArea?: string }) {
    if (selected.length === 0) return this.readState();

    const state = this.readState();
    const now = new Date().toISOString();
    const terms = this.queryTerms(context.query, context.taskArea);

    for (const item of selected) {
      const record = state.records[item.path] ?? {
        path: item.path,
        selectedCount: 0,
        contexts: {},
      };
      record.selectedCount += 1;
      record.lastSelectedAt = now;
      for (const term of terms) {
        record.contexts[term] = (record.contexts[term] ?? 0) + 1;
      }
      record.contexts = this.capContexts(record.contexts);
      state.records[item.path] = record;
    }

    state.updatedAt = now;
    this.writeState(state);
    return state;
  }

  scoreBoost(path: string, terms: string[]) {
    return this.buildBooster(terms)(path);
  }

  /**
   * Build a per-path boost function for one query, reading usage.json exactly
   * once. Use this when scoring many paths (e.g. ranking a search) so the state
   * file is not re-read per document.
   */
  buildBooster(terms: string[]): (path: string) => number {
    const state = this.readState();
    return (path: string) => {
      const record = state.records[path];
      if (!record) return 0;
      const useBoost = Math.min(8, Math.log2(record.selectedCount + 1) * 2);
      const termBoost = Math.min(6, terms.reduce((sum, term) => sum + (record.contexts[term] ?? 0), 0));
      const recencyBoost = this.recencyBoost(record.lastSelectedAt);
      return Math.round((useBoost + termBoost + recencyBoost) * 10) / 10;
    };
  }

  statsFor(path: string) {
    return this.readState().records[path] ?? null;
  }

  private recencyBoost(value?: string) {
    if (!value) return 0;
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return 0;
    const ageDays = (Date.now() - timestamp) / 86_400_000;
    if (ageDays <= 1) return 4;
    if (ageDays <= 7) return 2;
    if (ageDays <= 30) return 1;
    return 0;
  }

  /** Let terms grow to CONTEXT_PRUNE_THRESHOLD, then keep only the top
   *  MAX_CONTEXT_TERMS (highest count first; ties keep the lexicographically smaller term). */
  private capContexts(contexts: Record<string, number>): Record<string, number> {
    const entries = Object.entries(contexts);
    if (entries.length <= CONTEXT_PRUNE_THRESHOLD) return contexts;
    entries.sort(([termA, countA], [termB, countB]) => countB - countA || termA.localeCompare(termB));
    return Object.fromEntries(entries.slice(0, MAX_CONTEXT_TERMS));
  }

  private readState(): UsageState {
    if (!existsSync(this.usagePath)) return { ...EMPTY_STATE, records: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.usagePath, "utf8")) as UsageState;
      return {
        version: 1,
        updatedAt: parsed.updatedAt ?? todayIso(),
        records: parsed.records ?? {},
      };
    } catch (error) {
      // A torn/corrupt file must not be reset silently: the next writeState
      // would permanently wipe all accumulated usage data without a trace.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[memory-mcp] usage.json unreadable (${message}); falling back to empty usage state: ${this.usagePath}`);
      return { ...EMPTY_STATE, records: {} };
    }
  }

  private writeState(state: UsageState) {
    mkdirSync(dirname(this.usagePath), { recursive: true });
    // Atomic write: stage to a per-process temp file, then rename over the
    // target. The vault is shared across agents/processes, so a concurrent or
    // interrupted write must never leave a torn usage.json for the next reader.
    const tmp = `${this.usagePath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    try {
      renameSync(tmp, this.usagePath);
    } catch (error) {
      // Usage data is telemetry: a failed rename (e.g. target locked) must not
      // fail the user-facing tool call (contextPack/sessionStart/awaken) that
      // triggered it. Warn once and continue — unlike lifecycle.json, which
      // stays loud because it carries the session state itself.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[memory-mcp] usage.json write skipped (${message}); usage stats may lag: ${this.usagePath}`);
      // Don't leak the temp file when the rename fails.
      try {
        unlinkSync(tmp);
      } catch {
        // Best-effort cleanup only.
      }
    }
  }

  private queryTerms(query?: string, taskArea?: string) {
    return `${query ?? ""} ${taskArea ?? ""}`
      .toLowerCase()
      .split(/[^a-z0-9ก-๙_-]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length > 1);
  }
}
