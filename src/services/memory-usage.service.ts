import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { todayIso } from "../utils/memory-format.js";

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

  private readState(): UsageState {
    if (!existsSync(this.usagePath)) return { ...EMPTY_STATE, records: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.usagePath, "utf8")) as UsageState;
      return {
        version: 1,
        updatedAt: parsed.updatedAt ?? todayIso(),
        records: parsed.records ?? {},
      };
    } catch {
      return { ...EMPTY_STATE, records: {} };
    }
  }

  private writeState(state: UsageState) {
    mkdirSync(dirname(this.usagePath), { recursive: true });
    writeFileSync(this.usagePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private queryTerms(query?: string, taskArea?: string) {
    return `${query ?? ""} ${taskArea ?? ""}`
      .toLowerCase()
      .split(/[^a-z0-9ก-๙_-]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length > 1);
  }
}
