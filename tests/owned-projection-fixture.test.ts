import assert from "node:assert/strict";
import fs, { type BigIntStats } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createOwnedProjectionFixture } from "./support/owned-projection-fixture.js";

const rootCode = "CI_PROJECTION_FIXTURE_ROOT_INVALID";
const cleanupCode = "CI_PROJECTION_FIXTURE_CLEANUP_INCOMPLETE";
const hasCode = (code: string) => (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === code;
const identity = (stat: BigIntStats) => [stat.dev, stat.ino, stat.birthtimeNs];
const equalSpelling = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const mutableFs = fs as unknown as { lstatSync: typeof fs.lstatSync };

// Independent control authority is captured before hooks or subject creation.
// Every subject root is a descendant of this fresh, independently owned root.
function control() {
  const raw = fs.mkdtempSync(join(tmpdir(), "owned-projection-control-"));
  const original = fs.lstatSync(raw, { bigint: true });
  const native = resolve(fs.realpathSync.native(raw));
  function validate() {
    for (const path of [raw, native]) {
      const current = fs.lstatSync(path, { bigint: true });
      assert.ok(current.isDirectory() && !current.isSymbolicLink());
      assert.deepEqual(identity(current), identity(original));
      assert.ok(equalSpelling(resolve(fs.realpathSync.native(path)), native));
    }
  }
  validate();
  return { root: native, cleanup() { validate(); fs.rmSync(raw, { recursive: true }); assert.equal(fs.existsSync(raw), false); } };
}

function withSubjectRoots<T>(owner: ReturnType<typeof control>, run: () => T): T {
  const original = fs.mkdtempSync;
  // Windows case spelling gives two actual lookup paths to the same native owner.
  const rawParent = process.platform === "win32" ? owner.root.toLowerCase() : owner.root;
  fs.mkdtempSync = ((prefix: string) => original(join(rawParent, basename(prefix)))) as typeof fs.mkdtempSync;
  syncBuiltinESMExports();
  try { return run(); }
  finally { fs.mkdtempSync = original; syncBuiltinESMExports(); }
}

// Catches using native lookup before capturing creation authority, or choosing raw by default.
test("owned projection fixture binds both spellings before use", () => {
  const owner = control(), originalStat = fs.lstatSync, originalNative = fs.realpathSync.native;
  try {
    withSubjectRoots(owner, () => {
      for (const spelling of [undefined, "raw", "native"] as const) {
        const calls: { kind: string; path: string; identity?: bigint[] }[] = [];
        mutableFs.lstatSync = ((path: fs.PathLike, options: unknown) => {
          const result = originalStat(path, options as { bigint: true });
          if (options && (options as { bigint?: boolean }).bigint) calls.push({ kind: "stat", path: String(path), identity: identity(result) });
          return result;
        }) as typeof fs.lstatSync;
        fs.realpathSync.native = ((path: fs.PathLike) => {
          calls.push({ kind: "native", path: String(path) }); return originalNative(path);
        }) as typeof fs.realpathSync.native;
        syncBuiltinESMExports();
        try {
          const fixture = createOwnedProjectionFixture("bind-", spelling);
          assert.equal(calls[0]?.kind, "stat", "creation BigInt lstat must precede native lookup");
          assert.equal(calls[0]?.path, fixture.rawRoot);
          const created = calls[0]!.identity;
          assert.deepEqual(identity(originalStat(fixture.rawRoot, { bigint: true })), created);
          assert.deepEqual(identity(originalStat(fixture.nativeRoot, { bigint: true })), created);
          assert.ok(calls.some(call => call.kind === "stat" && call.path === fixture.nativeRoot));
          assert.ok(calls.some(call => call.kind === "native"));
          if (process.platform === "win32") assert.notEqual(fixture.rawRoot, fixture.nativeRoot);
          assert.equal(fixture.root, spelling === "raw" ? fixture.rawRoot : fixture.nativeRoot);
          if (spelling !== undefined) fs.writeFileSync(join(fixture.root, "owned.txt"), "mutable directory ctime is not creation identity");
          fixture.cleanup(); fixture.cleanup();
          assert.equal(fs.existsSync(fixture.rawRoot), false);
        } finally {
          mutableFs.lstatSync = originalStat; fs.realpathSync.native = originalNative; syncBuiltinESMExports();
        }
      }
    });
  } finally { mutableFs.lstatSync = originalStat; fs.realpathSync.native = originalNative; syncBuiltinESMExports(); owner.cleanup(); }
});

// Catches trusting redirected native lookup even though it refers to another actual directory.
test("owned projection fixture refuses redirected native lookup", () => {
  const owner = control(), originalNative = fs.realpathSync.native;
  const outside = join(owner.root, "outside"); fs.mkdirSync(outside); fs.writeFileSync(join(outside, "sentinel"), "outside");
  let raw: string | undefined;
  try {
    withSubjectRoots(owner, () => {
      fs.realpathSync.native = ((path: fs.PathLike) => { raw = String(path); return originalNative(outside); }) as typeof fs.realpathSync.native;
      try { assert.throws(() => createOwnedProjectionFixture("redirect-"), hasCode(rootCode)); }
      finally { fs.realpathSync.native = originalNative; }
    });
    assert.ok(raw); assert.equal(fs.existsSync(raw), true, "uncertain setup root is retained");
    assert.equal(fs.readFileSync(join(outside, "sentinel"), "utf8"), "outside");
  } finally { fs.realpathSync.native = originalNative; owner.cleanup(); }
});

// Catches deleting a replacement or treating a later successful identity check as recovery.
test("owned projection fixture retains replaced roots and outside content", () => {
  const owner = control();
  try {
    withSubjectRoots(owner, () => {
      const fixture = createOwnedProjectionFixture("replace-");
      const displaced = join(owner.root, "displaced"), outside = join(owner.root, "outside");
      fs.writeFileSync(join(fixture.root, "original"), "original"); fs.renameSync(fixture.rawRoot, displaced);
      fs.mkdirSync(fixture.rawRoot); fs.writeFileSync(join(fixture.rawRoot, "replacement"), "replacement");
      fs.mkdirSync(outside); fs.writeFileSync(join(outside, "sentinel"), "outside");
      assert.throws(() => fixture.cleanup(), hasCode(cleanupCode));
      assert.equal(fs.readFileSync(join(fixture.rawRoot, "replacement"), "utf8"), "replacement");
      assert.equal(fs.readFileSync(join(outside, "sentinel"), "utf8"), "outside");
      fs.rmSync(fixture.rawRoot, { recursive: true }); fs.renameSync(displaced, fixture.rawRoot);
      assert.throws(() => fixture.cleanup(), hasCode(cleanupCode));
      assert.equal(fs.readFileSync(join(fixture.rawRoot, "original"), "utf8"), "original");
    });
  } finally { owner.cleanup(); }
});

// Catches following a real native junction/symlink during cleanup into an outside owner.
test("owned projection fixture does not traverse a junction target", context => {
  const owner = control();
  try {
    withSubjectRoots(owner, () => {
      const fixture = createOwnedProjectionFixture("junction-"), displaced = join(owner.root, "original");
      const outside = join(owner.root, "outside"); fs.mkdirSync(outside); fs.writeFileSync(join(outside, "sentinel"), "outside");
      fs.renameSync(fixture.rawRoot, displaced);
      try { fs.symlinkSync(outside, fixture.rawRoot, process.platform === "win32" ? "junction" : "dir"); }
      catch (error) {
        fs.renameSync(displaced, fixture.rawRoot); fixture.cleanup();
        if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          context.skip("native junction/symlink creation unavailable"); return;
        }
        throw error;
      }
      assert.ok(fs.lstatSync(fixture.rawRoot, { bigint: true }).isSymbolicLink());
      assert.throws(() => fixture.cleanup(), hasCode(cleanupCode));
      assert.equal(fs.readFileSync(join(outside, "sentinel"), "utf8"), "outside");
      assert.equal(fs.existsSync(displaced), true);
    });
  } finally { owner.cleanup(); }
});

// Catches removing a directory before a real SQLite handle is positively closed, or closing twice.
test("owned projection fixture closes resources before removal", () => {
  const owner = control(); let database: DatabaseSync | undefined, second: DatabaseSync | undefined;
  try {
    withSubjectRoots(owner, () => {
      const fixture = createOwnedProjectionFixture("close-");
      database = new DatabaseSync(join(fixture.root, "one.sqlite"));
      let firstCalls = 0, secondCalls = 0;
      const closeFirst = fixture.closeWith(() => { assert.equal(fs.existsSync(fixture.root), true); firstCalls++; database!.close(); });
      database.exec("CREATE TABLE owned(value)");
      second = new DatabaseSync(join(fixture.root, "two.sqlite"));
      fixture.closeWith(() => { assert.equal(fs.existsSync(fixture.root), true); secondCalls++; second!.close(); });
      second.exec("CREATE TABLE owned(value)");
      closeFirst(); closeFirst();
      assert.throws(() => database!.exec("SELECT 1"), { code: "ERR_INVALID_STATE" });
      fixture.cleanup(); fixture.cleanup(); closeFirst();
      assert.throws(() => second!.exec("SELECT 1"), { code: "ERR_INVALID_STATE" });
      assert.equal(firstCalls, 1); assert.equal(secondCalls, 1); assert.equal(fs.existsSync(fixture.root), false);
    });
  } finally { if (database?.isOpen) database.close(); if (second?.isOpen) second.close(); owner.cleanup(); }
});

// Catches retrying an uncertain close, skipping another owned close, or deleting retained roots.
test("owned projection fixture latches close uncertainty", () => {
  const owner = control(); let database: DatabaseSync | undefined, second: DatabaseSync | undefined, acquired: DatabaseSync | undefined;
  const originalClose = DatabaseSync.prototype.close, fault = new Error("controlled close fault");
  try {
    withSubjectRoots(owner, () => {
      const fixture = createOwnedProjectionFixture("uncertain-");
      database = new DatabaseSync(join(fixture.root, "one.sqlite"));
      let attempts = 0;
      const close = fixture.closeWith(() => database!.close());
      database.exec("CREATE TABLE owned(value)");
      second = new DatabaseSync(join(fixture.root, "two.sqlite"));
      fixture.closeWith(() => second!.close());
      DatabaseSync.prototype.close = function () { if (this === database) { attempts++; throw fault; } originalClose.call(this); };
      try {
        assert.throws(close, error => error === fault);
        assert.throws(() => fixture.cleanup(), hasCode(cleanupCode));
        assert.throws(() => second!.exec("SELECT 1"), { code: "ERR_INVALID_STATE" });
        assert.throws(close, hasCode(cleanupCode));
        assert.throws(() => fixture.cleanup(), hasCode(cleanupCode));
        assert.equal(attempts, 1); assert.equal(database!.isOpen, true); assert.equal(fs.existsSync(fixture.root), true);
      } finally { DatabaseSync.prototype.close = originalClose; }
      const retained = createOwnedProjectionFixture("retain-");
      acquired = new DatabaseSync(join(retained.root, "owned.sqlite"));
      retained.closeWith(() => acquired!.close()); retained.retain();
      assert.throws(() => retained.cleanup(), hasCode(cleanupCode));
      assert.equal(acquired.isOpen, false); assert.equal(fs.existsSync(retained.root), true);
      assert.throws(() => retained.cleanup(), hasCode(cleanupCode));
    });
  } finally {
    DatabaseSync.prototype.close = originalClose;
    for (const resource of [database, second, acquired]) if (resource?.isOpen) originalClose.call(resource);
    owner.cleanup();
  }
});

// Catches losing the primary setup error while attempting closure of an actually acquired database.
test("owned projection fixture preserves primary setup failure", () => {
  const owner = control(), setupFault = new Error("controlled schema fault"), closeFault = new Error("controlled close fault");
  const originalExec = DatabaseSync.prototype.exec, originalClose = DatabaseSync.prototype.close;
  let database: DatabaseSync | undefined, root: string | undefined, closeAttempts = 0;
  try {
    withSubjectRoots(owner, () => {
      const fixture = createOwnedProjectionFixture("setup-"); root = fixture.root;
      database = new DatabaseSync(join(fixture.root, "owned.sqlite"));
      fixture.closeWith(() => database!.close());
      DatabaseSync.prototype.exec = function (sql) { if (this === database) throw setupFault; return originalExec.call(this, sql); };
      DatabaseSync.prototype.close = function () { if (this === database) { closeAttempts++; throw closeFault; } originalClose.call(this); };
      try {
        assert.throws(() => {
          try { database!.exec("CREATE TABLE owned(value)"); }
          catch (primary) { try { fixture.cleanup(); } catch { fixture.retain(); } throw primary; }
        }, error => error === setupFault);
        assert.equal(closeAttempts, 1); assert.equal(database!.isOpen, true); assert.equal(fs.existsSync(root), true);
        assert.throws(() => fixture.cleanup(), hasCode(cleanupCode)); assert.equal(closeAttempts, 1);
      } finally { DatabaseSync.prototype.exec = originalExec; DatabaseSync.prototype.close = originalClose; }
    });
  } finally {
    DatabaseSync.prototype.exec = originalExec; DatabaseSync.prototype.close = originalClose;
    if (database?.isOpen) originalClose.call(database); owner.cleanup();
  }
});
