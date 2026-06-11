import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryUsageService } from "../src/services/memory-usage.service.js";

/** Run fn with console.error captured (the service warns on stderr, not via return values). */
function captureStderr<T>(fn: () => T): { value: T; errors: string[] } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    return { value: fn(), errors };
  } finally {
    console.error = original;
  }
}

describe("MemoryUsageService state safety", () => {
  let root: string;
  let usage: MemoryUsageService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mem-usage-"));
    usage = new MemoryUsageService(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("persists selections and rereads them from usage.json", () => {
    usage.recordContextPack([{ path: "a.md" }], { query: "memory index" });
    usage.recordContextPack([{ path: "a.md" }], { query: "memory" });

    const record = usage.statsFor("a.md");
    assert.ok(record);
    assert.equal(record!.selectedCount, 2);
    assert.equal(record!.contexts.memory, 2);
    assert.equal(record!.contexts.index, 1);

    const onDisk = JSON.parse(readFileSync(join(root, ".memory-mcp", "usage.json"), "utf8"));
    assert.equal(onDisk.records["a.md"].selectedCount, 2);
  });

  it("prunes contexts only past the hysteresis threshold (48), down to the top 40", () => {
    const fillers = Array.from({ length: 55 }, (_, index) => `t${String(index + 1).padStart(2, "0")}`);
    usage.recordContextPack([{ path: "a.md" }], { query: `hot hot hot ${fillers.join(" ")}` });

    const record = usage.statsFor("a.md");
    assert.ok(record);
    const terms = Object.keys(record!.contexts);
    assert.equal(terms.length, 40);
    // Highest-count term survives; count-1 ties are kept lexicographically.
    assert.equal(record!.contexts.hot, 3);
    assert.equal("t01" in record!.contexts, true);
    assert.equal("t39" in record!.contexts, true);
    assert.equal("t40" in record!.contexts, false);
    assert.equal("t55" in record!.contexts, false);
  });

  it("lets new terms accumulate on a saturated record and survive the next prune", () => {
    const fillers = Array.from({ length: 41 }, (_, index) => `t${String(index + 1).padStart(2, "0")}`);
    usage.recordContextPack([{ path: "a.md" }], { query: fillers.join(" ") });
    // 41 terms: past the old hard cap of 40, but under the prune threshold.
    assert.equal(Object.keys(usage.statsFor("a.md")!.contexts).length, 41);

    // The old top-40 hard cap rejected any count-1 newcomer on a full record.
    usage.recordContextPack([{ path: "a.md" }], { query: "fresh fresh" });
    let record = usage.statsFor("a.md")!;
    assert.equal(record.contexts.fresh, 2);
    assert.equal(Object.keys(record.contexts).length, 42);

    // Crossing the threshold prunes to 40; the accumulated newcomer outranks count-1 fillers.
    const more = Array.from({ length: 10 }, (_, index) => `u${String(index + 1).padStart(2, "0")}`);
    usage.recordContextPack([{ path: "a.md" }], { query: more.join(" ") });
    record = usage.statsFor("a.md")!;
    assert.equal(Object.keys(record.contexts).length, 40);
    assert.equal(record.contexts.fresh, 2);
  });

  it("warns on stderr and falls back to empty state when usage.json is corrupt", () => {
    mkdirSync(join(root, ".memory-mcp"), { recursive: true });
    writeFileSync(join(root, ".memory-mcp", "usage.json"), "{ torn-write", "utf8");

    const { value: state, errors } = captureStderr(() => usage.snapshot());
    assert.deepEqual(state.records, {});
    assert.ok(errors.some((line) => line.includes("usage.json")), "a one-line stderr warning must mention usage.json");
  });

  it("writes atomically and leaves no temp files behind", () => {
    usage.recordContextPack([{ path: "a.md" }], { query: "memory" });
    const entries = readdirSync(join(root, ".memory-mcp"));
    assert.deepEqual(entries.filter((name) => name.includes(".tmp")), []);
    // The final file is complete, parseable JSON.
    const parsed = JSON.parse(readFileSync(join(root, ".memory-mcp", "usage.json"), "utf8"));
    assert.equal(parsed.version, 1);
  });

  it("does not fail the tool call when the usage.json rename is blocked (telemetry is best-effort)", () => {
    // A directory at the target path makes renameSync throw on every platform.
    mkdirSync(join(root, ".memory-mcp", "usage.json"), { recursive: true });

    const { errors } = captureStderr(() => {
      assert.doesNotThrow(() => usage.recordContextPack([{ path: "a.md" }], { query: "memory" }));
    });
    assert.ok(errors.some((line) => line.includes("usage.json write skipped")), "one stderr warning explains the skipped write");
    // The staged temp file is still cleaned up.
    const entries = readdirSync(join(root, ".memory-mcp"));
    assert.deepEqual(entries.filter((name) => name.includes(".tmp")), []);
  });
});
