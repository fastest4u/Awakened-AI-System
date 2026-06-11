import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryLifecycleService } from "../src/services/memory-lifecycle.service.js";

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

describe("MemoryLifecycleService", () => {
  let root: string;
  let lifecycle: MemoryLifecycleService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mem-lifecycle-"));
    lifecycle = new MemoryLifecycleService(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** riskyWork inferred by the quality gate for a one-shot start+end session. */
  function riskyWorkFor(input: { topic: string; outcomes?: string[]; openFollowUps?: string[]; filesTouched?: string[] }) {
    lifecycle.start({});
    return lifecycle.end({ agent: "tester", ...input }, null).qualityGate.riskyWork;
  }

  describe("supersede on a second sessionStart", () => {
    it("archives the still-active session with a null gate instead of a fabricated F", () => {
      lifecycle.start({ taskArea: "first" });
      const second = lifecycle.start({ taskArea: "second" });
      assert.ok(second.warnings.some((warning) => warning.includes("archived")));

      const persisted = JSON.parse(readFileSync(join(root, ".memory-mcp", "lifecycle.json"), "utf8"));
      assert.equal(persisted.recentSessions.length, 1);
      const archived = persisted.recentSessions[0];
      assert.equal(archived.lastQualityGate, null);
      assert.equal(archived.endReason, "superseded");
      assert.ok(Array.isArray(archived.warnings));
      assert.ok(archived.warnings.some((warning: string) => warning.includes("replaced by a new memory_sessionStart")));
    });

    it("status() tolerates archived sessions with null gates", () => {
      lifecycle.start({ taskArea: "first" });
      lifecycle.start({ taskArea: "second" });

      const status = lifecycle.status({ includeHistory: true });
      assert.equal(status.recentSessions.length, 1);
      assert.equal(status.recentSessions[0].lastQualityGate, null);
      assert.equal(status.recentSessions[0].endReason, "superseded");
      assert.ok(status.activeSession, "the new session stays active");
    });
  });

  describe("risky-work inference", () => {
    it("flags real risk keywords as whole tokens", () => {
      assert.equal(riskyWorkFor({ topic: "deploy to production" }), true);
      assert.equal(riskyWorkFor({ topic: "refactor auth flow" }), true);
    });

    it("does not flag keywords inside hyphenated slugs or negated phrases", () => {
      assert.equal(riskyWorkFor({ topic: "update docs", outcomes: ["no refactor needed"] }), false);
      assert.equal(riskyWorkFor({ topic: "rename the no-refactor-needed note" }), false);
      assert.equal(riskyWorkFor({ topic: "documentation cleanup" }), false);
    });

    it("flags Thai risk keywords (substring match: Thai has no word separators)", () => {
      assert.equal(riskyWorkFor({ topic: "เตรียมดีพลอยระบบใหม่" }), true);
      assert.equal(riskyWorkFor({ topic: "ปรับสคีมาตารางผู้ใช้" }), true);
      assert.equal(riskyWorkFor({ topic: "ปรับปรุงเอกสารคู่มือ" }), false);
    });

    it("keeps the multi-file rule", () => {
      assert.equal(riskyWorkFor({ topic: "tidy comments", filesTouched: ["a.ts", "b.ts"] }), true);
      assert.equal(riskyWorkFor({ topic: "tidy comments", filesTouched: ["a.ts"] }), false);
    });
  });

  describe("state file safety", () => {
    it("warns on stderr and falls back to empty state when lifecycle.json is corrupt", () => {
      mkdirSync(join(root, ".memory-mcp"), { recursive: true });
      writeFileSync(join(root, ".memory-mcp", "lifecycle.json"), "{ torn-write", "utf8");

      const { value: status, errors } = captureStderr(() => lifecycle.status({}));
      assert.equal(status.activeSession, null);
      assert.ok(errors.some((line) => line.includes("lifecycle.json")), "a one-line stderr warning must mention lifecycle.json");
    });

    it("writes atomically and leaves no temp files behind", () => {
      lifecycle.start({ taskArea: "memory" });
      const entries = readdirSync(join(root, ".memory-mcp"));
      assert.deepEqual(entries.filter((name) => name.includes(".tmp")), []);
      const parsed = JSON.parse(readFileSync(join(root, ".memory-mcp", "lifecycle.json"), "utf8"));
      assert.equal(parsed.version, 1);
    });
  });
});
