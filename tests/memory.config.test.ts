import { strict as assert } from "node:assert";
import type { existsSync as ExistsSync, readFileSync as ReadFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { __internals, diagnoseMemoryConfig, loadMemoryConfig } from "../src/config/memory.config.js";

type FsLike = { existsSync: typeof ExistsSync; readFileSync: typeof ReadFileSync };

/** Normalize separators so platform-specific tests run on any OS. */
const toPosix = (p: string) => p.replace(/\\/g, "/");

const {
  decodeFileUri,
  unescapeJsonString,
  ideStorageFiles,
  opencodeGlobalFiles,
  extractOpencodeDirectories,
  zedDbFiles,
  decodeZedPathsColumn,
  readIdeWorkspaceCandidates,
  readOpencodeWorkspaceCandidates,
  readZedWorkspaceCandidates,
  pickIdeActiveWorkspace,
  findIdeActiveWorkspace,
  resolveDynamicProjectRoot,
  isDynamicRootValue,
  tryLoadSqlite,
} = __internals;

/**
 * Build a Windows file URI from a real path. Mirrors how VS Code-derived IDEs
 * persist `windowsState.lastActiveWindow.folder`.
 */
function toFileUri(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, "/");
  const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  // Encode the colon for Windows drive letters to match real-world IDE state.
  return `file://${withLeadingSlash.replace(/^([/])([A-Za-z]):/, "$1$2%3A")}`;
}

describe("decodeFileUri", () => {
  it("decodes Windows drive-letter URIs with percent-encoded colon", () => {
    assert.equal(
      decodeFileUri("file:///c%3A/Users/me/proj"),
      "c:/Users/me/proj",
    );
  });

  it("decodes Windows drive-letter URIs with literal colon", () => {
    assert.equal(decodeFileUri("file:///c:/Users/me/proj"), "c:/Users/me/proj");
  });

  it("decodes POSIX URIs", () => {
    assert.equal(decodeFileUri("file:///home/user/proj"), "/home/user/proj");
  });

  it("decodes spaces and unicode", () => {
    assert.equal(
      decodeFileUri("file:///home/user/My%20Project"),
      "/home/user/My Project",
    );
  });

  it("returns undefined for non-string input", () => {
    assert.equal(decodeFileUri(undefined), undefined);
    assert.equal(decodeFileUri(null), undefined);
    assert.equal(decodeFileUri(123), undefined);
    assert.equal(decodeFileUri({}), undefined);
  });

  it("returns undefined for non-file URIs", () => {
    assert.equal(decodeFileUri("https://example.com"), undefined);
    assert.equal(decodeFileUri("vscode-remote://ssh/host/path"), undefined);
    assert.equal(decodeFileUri(""), undefined);
  });

  it("falls back gracefully on malformed encoding", () => {
    // Lone `%` triggers URIError in decodeURIComponent; we should still
    // return a usable string instead of throwing.
    const result = decodeFileUri("file:///broken%path");
    assert.ok(typeof result === "string" && result.length > 0);
  });
});

describe("isDynamicRootValue", () => {
  it("matches all aliases case-insensitively", () => {
    for (const alias of ["auto", "AUTO", "detect", "Dynamic", "WORKSPACE"]) {
      assert.equal(isDynamicRootValue(alias), true, `alias=${alias}`);
    }
  });

  it("rejects explicit paths and undefined", () => {
    assert.equal(isDynamicRootValue("/some/path"), false);
    assert.equal(isDynamicRootValue("C:/path"), false);
    assert.equal(isDynamicRootValue(undefined), false);
    assert.equal(isDynamicRootValue(""), false);
  });
});

describe("ideStorageFiles", () => {
  it("uses APPDATA on win32 and probes known IDE products", () => {
    const files = ideStorageFiles({ APPDATA: "C:/Users/me/AppData/Roaming" } as NodeJS.ProcessEnv, "win32");
    assert.ok(files.length >= 5, `expected several IDE products, got ${files.length}`);
    const norm = files.map((f) => f.replace(/\\/g, "/"));
    assert.ok(norm.some((p) => p.includes("/Windsurf/User/globalStorage/storage.json")));
    assert.ok(norm.some((p) => p.includes("/Cursor/User/globalStorage/storage.json")));
    assert.ok(norm.some((p) => p.includes("/Code/User/globalStorage/storage.json")));
    // Antigravity ships under two product names (legacy "Antigravity" and the
    // current "Antigravity IDE"); both must be probed.
    assert.ok(norm.some((p) => p.includes("/Antigravity/User/globalStorage/storage.json")));
    assert.ok(norm.some((p) => p.includes("/Antigravity IDE/User/globalStorage/storage.json")));
    // Kiro (AWS) is also a VS Code fork using the same storage layout.
    assert.ok(norm.some((p) => p.includes("/Kiro/User/globalStorage/storage.json")));
  });

  it("uses ~/Library/Application Support on darwin", () => {
    const files = ideStorageFiles({ HOME: "/Users/me" } as NodeJS.ProcessEnv, "darwin").map(toPosix);
    assert.ok(files.every((f) => f.startsWith("/Users/me/Library/Application Support/")));
  });

  it("respects XDG_CONFIG_HOME on linux", () => {
    const files = ideStorageFiles(
      { HOME: "/home/me", XDG_CONFIG_HOME: "/tmp/xdg" } as NodeJS.ProcessEnv,
      "linux",
    ).map(toPosix);
    assert.ok(files.every((f) => f.startsWith("/tmp/xdg/")));
  });

  it("falls back to ~/.config on linux without XDG", () => {
    const files = ideStorageFiles({ HOME: "/home/me" } as NodeJS.ProcessEnv, "linux").map(toPosix);
    assert.ok(files.every((f) => f.startsWith("/home/me/.config/")));
  });

  it("returns empty when required env is missing", () => {
    assert.deepEqual(ideStorageFiles({} as NodeJS.ProcessEnv, "win32"), []);
    assert.deepEqual(ideStorageFiles({} as NodeJS.ProcessEnv, "darwin"), []);
  });
});

describe("readIdeWorkspaceCandidates", () => {
  it("extracts lastActiveWindow + backupWorkspaces folders from storage.json", () => {
    const fakeStorage = JSON.stringify({
      windowsState: { lastActiveWindow: { folder: "file:///home/me/active" } },
      backupWorkspaces: {
        folders: [
          { folderUri: "file:///home/me/backup-a" },
          { folderUri: "file:///home/me/backup-b" },
          { folderUri: "not-a-uri" },
        ],
      },
    });
    const fakeFs: FsLike = {
      // Use a separator-agnostic check so the test passes on Windows where
      // path.join produces `\` even when the platform argument is "linux".
      existsSync: ((p: string) => toPosix(String(p)).endsWith("/Windsurf/User/globalStorage/storage.json")) as unknown as typeof ExistsSync,
      readFileSync: (() => fakeStorage) as unknown as typeof ReadFileSync,
    };
    const candidates = readIdeWorkspaceCandidates(
      { HOME: "/home/me" } as NodeJS.ProcessEnv,
      "linux",
      fakeFs,
    );

    const paths = candidates.map((c) => c.path);
    assert.ok(paths.includes("/home/me/active"));
    assert.ok(paths.includes("/home/me/backup-a"));
    assert.ok(paths.includes("/home/me/backup-b"));
    // Active flag set only on lastActiveWindow
    assert.equal(candidates.find((c) => c.path === "/home/me/active")?.lastActive, true);
    assert.equal(candidates.find((c) => c.path === "/home/me/backup-a")?.lastActive, false);
  });

  it("ignores non-existent storage files silently", () => {
    const fakeFs: FsLike = {
      existsSync: (() => false) as unknown as typeof ExistsSync,
      readFileSync: (() => {
        throw new Error("should not read");
      }) as unknown as typeof ReadFileSync,
    };
    const candidates = readIdeWorkspaceCandidates(
      { APPDATA: "C:/AppData" } as NodeJS.ProcessEnv,
      "win32",
      fakeFs,
    );
    assert.deepEqual(candidates, []);
  });

  it("ignores invalid JSON without throwing", () => {
    const fakeFs: FsLike = {
      existsSync: (() => true) as unknown as typeof ExistsSync,
      readFileSync: (() => "{ not json") as unknown as typeof ReadFileSync,
    };
    const candidates = readIdeWorkspaceCandidates(
      { APPDATA: "C:/AppData" } as NodeJS.ProcessEnv,
      "win32",
      fakeFs,
    );
    assert.deepEqual(candidates, []);
  });
});

describe("unescapeJsonString", () => {
  it("turns double-backslash into single backslash", () => {
    assert.equal(unescapeJsonString("C:\\\\Users\\\\me"), "C:\\Users\\me");
  });

  it("decodes escaped quotes and forward slashes", () => {
    assert.equal(unescapeJsonString('say \\"hi\\"'), 'say "hi"');
    assert.equal(unescapeJsonString("path\\/to"), "path/to");
  });

  it("decodes \\u escapes", () => {
    assert.equal(unescapeJsonString("hi\\u0041"), "hiA");
  });

  it("leaves regular text untouched", () => {
    assert.equal(unescapeJsonString("plain text 123"), "plain text 123");
  });
});

describe("opencodeGlobalFiles", () => {
  it("targets ai.opencode.desktop on win32", () => {
    const files = opencodeGlobalFiles({ APPDATA: "C:/AppData" } as NodeJS.ProcessEnv, "win32");
    assert.equal(files.length, 1);
    assert.ok(files[0].replace(/\\/g, "/").endsWith("/ai.opencode.desktop/opencode.global.dat"));
  });

  it("returns empty when env is missing", () => {
    assert.deepEqual(opencodeGlobalFiles({} as NodeJS.ProcessEnv, "win32"), []);
  });
});

describe("extractOpencodeDirectories", () => {
  it("parses the structured (outer JSON containing stringified JSON) format", () => {
    const inner = JSON.stringify({
      list: [
        { directory: "C:\\Users\\me\\proj-a", time: 100, type: "turn-complete" },
        { directory: "C:\\Users\\me\\proj-b", time: 200, type: "turn-complete" },
        { directory: "C:\\Users\\me\\proj-a", time: 300, type: "turn-complete" },
      ],
    });
    const outer = JSON.stringify({ notification: inner });
    const result = extractOpencodeDirectories(outer);
    const map = new Map(result.map((r) => [r.path, r.time]));
    // Keeps newest timestamp per path
    assert.equal(map.get("C:\\Users\\me\\proj-a"), 300);
    assert.equal(map.get("C:\\Users\\me\\proj-b"), 200);
  });

  it("falls back to a regex sweep when the file is not strict JSON", () => {
    // Simulate a future format change: keys outside any JSON envelope.
    const raw = `garbage prefix "directory":"C:\\\\Users\\\\me\\\\proj","time":42 garbage suffix`;
    const result = extractOpencodeDirectories(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].path, "C:\\Users\\me\\proj");
    assert.equal(result[0].time, 42);
  });

  it("returns an empty array when there are no matches", () => {
    assert.deepEqual(extractOpencodeDirectories("{}"), []);
    assert.deepEqual(extractOpencodeDirectories("not even json"), []);
  });
});

describe("readOpencodeWorkspaceCandidates", () => {
  it("returns the newest directory as lastActive=true", () => {
    const inner = JSON.stringify({
      list: [
        { directory: "/home/me/older", time: 1 },
        { directory: "/home/me/newer", time: 99 },
      ],
    });
    const outer = JSON.stringify({ notification: inner });
    const fakeFs: FsLike = {
      existsSync: ((p: string) => toPosix(String(p)).endsWith("/ai.opencode.desktop/opencode.global.dat")) as unknown as typeof ExistsSync,
      readFileSync: (() => outer) as unknown as typeof ReadFileSync,
    };
    const candidates = readOpencodeWorkspaceCandidates(
      { HOME: "/home/me" } as NodeJS.ProcessEnv,
      "linux",
      fakeFs,
    );
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].path, "/home/me/newer");
    assert.equal(candidates[0].lastActive, true);
    assert.equal(candidates[1].path, "/home/me/older");
    assert.equal(candidates[1].lastActive, false);
  });

  it("ignores missing or unreadable files", () => {
    const fakeFs: FsLike = {
      existsSync: (() => false) as unknown as typeof ExistsSync,
      readFileSync: (() => {
        throw new Error("nope");
      }) as unknown as typeof ReadFileSync,
    };
    const candidates = readOpencodeWorkspaceCandidates(
      { APPDATA: "C:/AppData" } as NodeJS.ProcessEnv,
      "win32",
      fakeFs,
    );
    assert.deepEqual(candidates, []);
  });
});

describe("zedDbFiles", () => {
  it("uses LOCALAPPDATA on win32 with capitalized 'Zed'", () => {
    const files = zedDbFiles(
      { LOCALAPPDATA: "C:/Users/me/AppData/Local" } as NodeJS.ProcessEnv,
      "win32",
    ).map(toPosix);
    assert.equal(files.length, 3);
    assert.ok(files.every((f) => f.startsWith("C:/Users/me/AppData/Local/Zed/db/")));
    assert.ok(files.some((f) => f.endsWith("/0-stable/db.sqlite")));
    assert.ok(files.some((f) => f.endsWith("/0-preview/db.sqlite")));
    assert.ok(files.some((f) => f.endsWith("/0-dev/db.sqlite")));
  });

  it("uses ~/Library/Application Support on darwin with capitalized 'Zed'", () => {
    const files = zedDbFiles({ HOME: "/Users/me" } as NodeJS.ProcessEnv, "darwin").map(toPosix);
    assert.ok(files.every((f) => f.startsWith("/Users/me/Library/Application Support/Zed/db/")));
  });

  it("uses lowercase 'zed' under ~/.local/share on linux", () => {
    const files = zedDbFiles({ HOME: "/home/me" } as NodeJS.ProcessEnv, "linux").map(toPosix);
    assert.ok(files.every((f) => f.startsWith("/home/me/.local/share/zed/db/")));
  });

  it("respects XDG_DATA_HOME on linux", () => {
    const files = zedDbFiles(
      { HOME: "/home/me", XDG_DATA_HOME: "/tmp/data" } as NodeJS.ProcessEnv,
      "linux",
    ).map(toPosix);
    assert.ok(files.every((f) => f.startsWith("/tmp/data/zed/db/")));
  });

  it("returns empty when required env is missing", () => {
    assert.deepEqual(zedDbFiles({} as NodeJS.ProcessEnv, "win32"), []);
    assert.deepEqual(zedDbFiles({} as NodeJS.ProcessEnv, "darwin"), []);
    assert.deepEqual(zedDbFiles({} as NodeJS.ProcessEnv, "linux"), []);
  });
});

describe("decodeZedPathsColumn", () => {
  it("returns the first element of a JSON-encoded array", () => {
    assert.equal(decodeZedPathsColumn('["C:\\\\Users\\\\me\\\\proj"]'), "C:\\Users\\me\\proj");
    assert.equal(
      decodeZedPathsColumn('["/home/me/a","/home/me/b"]'),
      "/home/me/a",
    );
  });

  it("returns a JSON-encoded string verbatim", () => {
    assert.equal(decodeZedPathsColumn('"/home/me/proj"'), "/home/me/proj");
  });

  it("treats unparseable input as a literal path", () => {
    assert.equal(decodeZedPathsColumn("/home/me/literal"), "/home/me/literal");
    assert.equal(decodeZedPathsColumn("C:\\Users\\me\\literal"), "C:\\Users\\me\\literal");
  });

  it("rejects empty / non-string / empty-array inputs", () => {
    assert.equal(decodeZedPathsColumn(undefined), undefined);
    assert.equal(decodeZedPathsColumn(null), undefined);
    assert.equal(decodeZedPathsColumn(""), undefined);
    assert.equal(decodeZedPathsColumn(42), undefined);
    // Empty JSON array → no path to decode → falls through to raw value, which
    // is the literal "[]" string (still a valid path on most filesystems but
    // never a real workspace). Acceptable: we just return the raw value.
    assert.equal(decodeZedPathsColumn("[]"), "[]");
  });
});

describe("readZedWorkspaceCandidates", () => {
  it("returns empty silently when node:sqlite is unavailable", () => {
    const candidates = readZedWorkspaceCandidates(
      { LOCALAPPDATA: "C:/AppData/Local" } as NodeJS.ProcessEnv,
      "win32",
      { existsSync: () => true } as unknown as { existsSync: typeof ExistsSync },
      () => null,
    );
    assert.deepEqual(candidates, []);
  });

  it("orders candidates by SQL DESC and marks the newest as lastActive", () => {
    const fakeRows = [
      { paths: '["C:\\\\Users\\\\me\\\\newer"]', timestamp: "2026-05-23 10:00:00" },
      { paths: '["C:\\\\Users\\\\me\\\\older"]', timestamp: "2026-05-22 10:00:00" },
    ];
    const fakeSqlite = {
      DatabaseSync: function FakeDatabase() {
        return {
          prepare: () => ({ all: () => fakeRows }),
          close: () => {},
        };
      } as unknown as new (path: string) => unknown,
    };
    const candidates = readZedWorkspaceCandidates(
      { LOCALAPPDATA: "C:/AppData/Local" } as NodeJS.ProcessEnv,
      "win32",
      // existsSync only matches one of the channel paths so we read exactly once
      { existsSync: ((p: string) => toPosix(String(p)).endsWith("/0-stable/db.sqlite")) as unknown as typeof ExistsSync },
      () => fakeSqlite as ReturnType<typeof tryLoadSqlite>,
    );
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].path, "C:\\Users\\me\\newer");
    assert.equal(candidates[0].lastActive, true);
    assert.equal(candidates[1].path, "C:\\Users\\me\\older");
    assert.equal(candidates[1].lastActive, false);
  });

  it("survives a database that throws on prepare/all", () => {
    const fakeSqlite = {
      DatabaseSync: function FakeDatabase() {
        return {
          prepare: () => ({ all: () => { throw new Error("schema mismatch"); } }),
          close: () => {},
        };
      } as unknown as new (path: string) => unknown,
    };
    const candidates = readZedWorkspaceCandidates(
      { LOCALAPPDATA: "C:/AppData/Local" } as NodeJS.ProcessEnv,
      "win32",
      { existsSync: (() => true) as unknown as typeof ExistsSync },
      () => fakeSqlite as ReturnType<typeof tryLoadSqlite>,
    );
    assert.deepEqual(candidates, []);
  });

  it("survives a DatabaseSync constructor that throws", () => {
    const fakeSqlite = {
      DatabaseSync: function FakeDatabase() {
        throw new Error("locked");
      } as unknown as new (path: string) => unknown,
    };
    const candidates = readZedWorkspaceCandidates(
      { LOCALAPPDATA: "C:/AppData/Local" } as NodeJS.ProcessEnv,
      "win32",
      { existsSync: (() => true) as unknown as typeof ExistsSync },
      () => fakeSqlite as ReturnType<typeof tryLoadSqlite>,
    );
    assert.deepEqual(candidates, []);
  });
});

describe("pickIdeActiveWorkspace + auto-detect (real fs)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "memcfg-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeProject(name: string, opts: { vault?: boolean; git?: boolean; pkg?: boolean } = {}): string {
    const dir = join(tmpRoot, name);
    mkdirSync(dir, { recursive: true });
    if (opts.vault) {
      mkdirSync(join(dir, "memory"), { recursive: true });
      writeFileSync(join(dir, "memory", "AGENTS.md"), "# vault\n");
    }
    if (opts.git) {
      mkdirSync(join(dir, ".git"), { recursive: true });
    }
    if (opts.pkg) {
      writeFileSync(join(dir, "package.json"), "{}\n");
    }
    return dir;
  }

  it("returns undefined when no candidates have markers", () => {
    const a = makeProject("plain-a");
    const result = pickIdeActiveWorkspace([
      { path: a, lastActive: true, mtimeMs: 1 },
    ]);
    assert.equal(result, undefined);
  });

  it("prefers a candidate with vault marker over plain workspace markers", () => {
    const withGit = makeProject("with-git", { git: true });
    const withVault = makeProject("with-vault", { vault: true });
    const result = pickIdeActiveWorkspace([
      { path: withGit, lastActive: true, mtimeMs: 1 },
      { path: withVault, lastActive: false, mtimeMs: 1 },
    ]);
    assert.equal(resolve(result!), resolve(withVault));
  });

  it("prefers last-active vault when multiple candidates have a vault", () => {
    const vaultA = makeProject("vault-a", { vault: true });
    const vaultB = makeProject("vault-b", { vault: true });
    const result = pickIdeActiveWorkspace([
      { path: vaultA, lastActive: false, mtimeMs: 1 },
      { path: vaultB, lastActive: true, mtimeMs: 1 },
    ]);
    assert.equal(resolve(result!), resolve(vaultB));
  });

  it("falls back to last-active candidate with any workspace marker if no vault exists", () => {
    const plain = makeProject("plain", { git: true });
    const result = pickIdeActiveWorkspace([
      { path: plain, lastActive: true, mtimeMs: 1 },
    ]);
    assert.equal(resolve(result!), resolve(plain));
  });

  it("deduplicates the same path across IDEs", () => {
    const vault = makeProject("vault", { vault: true });
    const result = pickIdeActiveWorkspace([
      { path: vault, lastActive: true, mtimeMs: 1 },
      { path: vault, lastActive: false, mtimeMs: 1 },
    ]);
    assert.equal(resolve(result!), resolve(vault));
  });

  it("uses newest mtime as a tiebreaker between equally active vaults", () => {
    const older = makeProject("older-vault", { vault: true });
    const newer = makeProject("newer-vault", { vault: true });
    const result = pickIdeActiveWorkspace([
      { path: older, lastActive: true, mtimeMs: 10 },
      { path: newer, lastActive: true, mtimeMs: 20 },
    ]);
    assert.equal(resolve(result!), resolve(newer));
  });

  it("keeps the freshest signal when deduplicating the same workspace path", () => {
    const stale = makeProject("stale-vault", { vault: true });
    const fresh = makeProject("fresh-vault", { vault: true });
    const result = pickIdeActiveWorkspace([
      { path: stale, lastActive: true, mtimeMs: 10 },
      { path: fresh, lastActive: false, mtimeMs: 100 },
      { path: fresh, lastActive: true, mtimeMs: 200 },
    ]);
    assert.equal(resolve(result!), resolve(fresh));
  });
});

describe("findIdeActiveWorkspace (storage.json on disk)", () => {
  let tmpRoot: string;
  let storageFile: string;
  let projectDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "memcfg-ide-"));
    projectDir = join(tmpRoot, "real-project");
    mkdirSync(join(projectDir, "memory"), { recursive: true });
    writeFileSync(join(projectDir, "memory", "AGENTS.md"), "# vault\n");

    // Mimic the Windsurf layout: <APPDATA>/Windsurf/User/globalStorage/storage.json
    const appData = join(tmpRoot, "appdata");
    storageFile = join(appData, "Windsurf", "User", "globalStorage", "storage.json");
    mkdirSync(join(appData, "Windsurf", "User", "globalStorage"), { recursive: true });
    writeFileSync(
      storageFile,
      JSON.stringify({
        windowsState: { lastActiveWindow: { folder: toFileUri(projectDir) } },
      }),
    );
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("locates the workspace from a Windsurf-shaped storage.json on win32", () => {
    const detected = findIdeActiveWorkspace(
      { APPDATA: join(tmpRoot, "appdata") } as NodeJS.ProcessEnv,
      "win32",
    );
    assert.ok(detected, "expected a detected path");
    assert.equal(resolve(detected!).toLowerCase(), resolve(projectDir).toLowerCase());
  });
});

describe("loadMemoryConfig", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "memcfg-load-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("explicit MEMORY_PROJECT_ROOT wins over auto-detect", () => {
    const explicit = join(tmpRoot, "explicit");
    mkdirSync(explicit, { recursive: true });
    const result = loadMemoryConfig(
      { MEMORY_PROJECT_ROOT: explicit } as NodeJS.ProcessEnv,
      tmpRoot,
    );
    assert.equal(result.projectRoot, resolve(explicit));
    assert.equal(result.vaultRoot, resolve(explicit, "memory"));
  });

  it("'dynamic' triggers auto-detect from cwd walk-up when IDE state is unavailable", () => {
    const project = join(tmpRoot, "proj");
    mkdirSync(join(project, "memory"), { recursive: true });
    writeFileSync(join(project, "memory", "AGENTS.md"), "# vault\n");
    // Start cwd inside a deeper folder; walk-up should find the project.
    const sub = join(project, "src", "deep");
    mkdirSync(sub, { recursive: true });

    const result = loadMemoryConfig(
      { MEMORY_PROJECT_ROOT: "dynamic" } as NodeJS.ProcessEnv,
      sub,
    );
    assert.equal(resolve(result.projectRoot), resolve(project));
  });

  it("prefers the cwd workspace when it already has a vault, even if IDE state points elsewhere", () => {
    const cwdProject = join(tmpRoot, "cwd-project");
    mkdirSync(join(cwdProject, "memory"), { recursive: true });
    writeFileSync(join(cwdProject, "memory", "AGENTS.md"), "# cwd vault\n");

    const ideProject = join(tmpRoot, "ide-project");
    mkdirSync(join(ideProject, "memory"), { recursive: true });
    writeFileSync(join(ideProject, "memory", "AGENTS.md"), "# ide vault\n");

    const appData = join(tmpRoot, "appdata");
    const storageFile = join(appData, "Windsurf", "User", "globalStorage", "storage.json");
    mkdirSync(join(appData, "Windsurf", "User", "globalStorage"), { recursive: true });
    writeFileSync(storageFile, JSON.stringify({ windowsState: { lastActiveWindow: { folder: toFileUri(ideProject) } } }));

    const result = loadMemoryConfig(
      { MEMORY_PROJECT_ROOT: "dynamic", APPDATA: appData } as NodeJS.ProcessEnv,
      cwdProject,
    );

    assert.equal(resolve(result.projectRoot), resolve(cwdProject));
  });

  it("MEMORY_VAULT_PATH overrides the resolved vault location", () => {
    const project = join(tmpRoot, "p");
    const vault = join(tmpRoot, "external-vault");
    mkdirSync(project, { recursive: true });
    mkdirSync(vault, { recursive: true });
    const result = loadMemoryConfig(
      { MEMORY_PROJECT_ROOT: project, MEMORY_VAULT_PATH: vault } as NodeJS.ProcessEnv,
      tmpRoot,
    );
    assert.equal(resolve(result.vaultRoot), resolve(vault));
  });
});

describe("diagnoseMemoryConfig", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "memcfg-diag-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("reports the selected workspace source, candidates, config, and runtime metadata", () => {
    const project = join(tmpRoot, "explicit");
    mkdirSync(join(project, "memory"), { recursive: true });
    writeFileSync(join(project, "memory", "AGENTS.md"), "# vault\n");

    const diagnostic = diagnoseMemoryConfig(
      { MEMORY_PROJECT_ROOT: project } as NodeJS.ProcessEnv,
      tmpRoot,
      {
        argv: ["node", "dist/index.js"],
        buildInfo: { builtAt: "2026-06-01T00:00:00.000Z", version: "0.1.0-test" },
        nodeVersion: "v-test",
        pid: 123,
        startedAt: "2026-06-01T00:00:00.000Z",
      },
    );

    assert.equal(resolve(diagnostic.config.projectRoot), resolve(project));
    assert.equal(resolve(diagnostic.config.vaultRoot), resolve(project, "memory"));
    assert.equal(diagnostic.workspace.source, "MEMORY_PROJECT_ROOT");
    assert.equal(diagnostic.workspace.candidates[0].source, "MEMORY_PROJECT_ROOT");
    assert.equal(diagnostic.workspace.candidates[0].selected, true);
    assert.deepEqual(diagnostic.runtime.argv, ["node", "dist/index.js"]);
    assert.deepEqual(diagnostic.build, { builtAt: "2026-06-01T00:00:00.000Z", version: "0.1.0-test" });
    assert.equal(diagnostic.runtime.nodeVersion, "v-test");
    assert.equal(diagnostic.runtime.pid, 123);
    assert.equal(diagnostic.vaultWithinProject, true);
  });

  it("reports vaultWithinProject=false when MEMORY_VAULT_PATH points outside the project", () => {
    const project = join(tmpRoot, "proj");
    mkdirSync(join(project, "memory"), { recursive: true });
    writeFileSync(join(project, "memory", "AGENTS.md"), "# vault\n");
    const external = join(tmpRoot, "external-vault");
    mkdirSync(external, { recursive: true });

    const diagnostic = diagnoseMemoryConfig(
      { MEMORY_PROJECT_ROOT: project, MEMORY_VAULT_PATH: external } as NodeJS.ProcessEnv,
      tmpRoot,
    );

    assert.equal(diagnostic.vaultWithinProject, false);
  });

  it("reports MCP Doctor diagnostics for configured local AI clients", () => {
    const project = join(tmpRoot, "doctor-project");
    mkdirSync(join(project, "memory"), { recursive: true });
    mkdirSync(join(project, ".claude"), { recursive: true });
    mkdirSync(join(project, ".codex"), { recursive: true });
    mkdirSync(join(project, ".cursor"), { recursive: true });
    mkdirSync(join(project, ".windsurf"), { recursive: true });
    mkdirSync(join(project, ".zed"), { recursive: true });
    mkdirSync(join(project, ".antigravity"), { recursive: true });
    writeFileSync(join(project, "memory", "AGENTS.md"), "# vault\n");
    writeFileSync(join(project, "CLAUDE.md"), "# Claude rules\nproject-memory\n");
    writeFileSync(
      join(project, ".claude", "settings.local.json"),
      JSON.stringify({
        permissions: { allow: ["mcp__project-memory__memory_sessionStart"] },
        enabledMcpjsonServers: ["project-memory"],
      }),
    );
    writeFileSync(
      join(project, ".codex", "config.toml"),
      [
        "[mcp_servers.project-memory]",
        "command = \"node\"",
        "",
        "[mcp_servers.project-memory.env]",
        "MEMORY_PROJECT_ROOT = \"dynamic\"",
      ].join("\n"),
    );
    writeFileSync(
      join(project, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { "project-memory": { env: { MEMORY_PROJECT_ROOT: "dynamic" } } } }),
    );
    writeFileSync(
      join(project, ".windsurf", "mcp.json"),
      JSON.stringify({ mcpServers: { "project-memory": { env: { MEMORY_PROJECT_ROOT: "dynamic" } } } }),
    );
    writeFileSync(
      join(project, ".zed", "settings.json"),
      JSON.stringify({ context_servers: { "project-memory": { env: { MEMORY_PROJECT_ROOT: "dynamic" } } } }),
    );
    writeFileSync(
      join(project, ".antigravity", "mcp.json"),
      JSON.stringify({ mcpServers: { "project-memory": { env: { MEMORY_PROJECT_ROOT: "dynamic" } } } }),
    );
    writeFileSync(
      join(project, "opencode.json"),
      JSON.stringify({ mcp: { "project-memory": { environment: { MEMORY_PROJECT_ROOT: "dynamic" } } } }),
    );

    const diagnostic = diagnoseMemoryConfig(
      { MEMORY_PROJECT_ROOT: project } as NodeJS.ProcessEnv,
      tmpRoot,
      { buildInfo: { builtAt: "2026-06-01T00:00:00.000Z", version: "0.1.0-test" } },
    );
    const doctor = (diagnostic as any).doctor;

    assert.equal(doctor.checks.projectRootExists, true);
    assert.equal(doctor.checks.vaultRootExists, true);
    assert.equal(doctor.checks.vaultHasAgentRules, true);
    assert.equal(doctor.checks.buildInfoPresent, true);
    assert.equal(doctor.summary.clientsChecked, 7);
    assert.equal(doctor.summary.configuredClients, 7);
    assert.equal(
      doctor.issues.some((issue: { code: string }) => issue.code === "CLAUDE_MCP_SERVER_DEFINITION_NOT_LOCAL"),
      true,
    );

    const claude = doctor.clients.find((client: { client: string }) => client.client === "claude-code");
    assert.equal(claude.configured, true);
    assert.equal(claude.enabled, true);
    assert.deepEqual(claude.allowedTools, ["mcp__project-memory__memory_sessionStart"]);
    assert.equal(claude.configs[0].hasProjectMemory, true);
    assert.equal(claude.configs[0].hasMemoryProjectRoot, false);

    const codex = doctor.clients.find((client: { client: string }) => client.client === "codex");
    assert.equal(codex.configured, true);
    assert.equal(codex.configs[0].hasMemoryProjectRoot, true);
    assert.equal(codex.configs[0].memoryProjectRoot, "dynamic");
  });

  it("accepts BOM-prefixed JSON client configs", () => {
    const project = join(tmpRoot, "bom-project");
    mkdirSync(join(project, "memory"), { recursive: true });
    mkdirSync(join(project, ".cursor"), { recursive: true });
    writeFileSync(join(project, "memory", "AGENTS.md"), "# vault\n");
    writeFileSync(
      join(project, ".cursor", "mcp.json"),
      `\uFEFF${JSON.stringify({ mcpServers: { "project-memory": { env: { MEMORY_PROJECT_ROOT: "dynamic" } } } })}`,
    );

    const diagnostic = diagnoseMemoryConfig(
      { MEMORY_PROJECT_ROOT: project } as NodeJS.ProcessEnv,
      tmpRoot,
      { buildInfo: { builtAt: "2026-06-01T00:00:00.000Z", version: "0.1.0-test" } },
    );
    const doctor = (diagnostic as any).doctor;
    const cursor = doctor.clients.find((client: { client: string }) => client.client === "cursor");

    assert.equal(cursor.configured, true);
    assert.equal(cursor.configs[0].parseError, undefined);
    assert.equal(doctor.issues.some((issue: { code: string }) => issue.code === "CLIENT_CONFIG_PARSE_ERROR"), false);
  });

  it("does not raise Doctor warnings for parse errors in inactive example configs", () => {
    const project = join(tmpRoot, "inactive-example-project");
    mkdirSync(join(project, "memory"), { recursive: true });
    mkdirSync(join(project, ".windsurf"), { recursive: true });
    writeFileSync(join(project, "memory", "AGENTS.md"), "# vault\n");
    writeFileSync(
      join(project, ".windsurf", "mcp.json"),
      JSON.stringify({ mcpServers: { "project-memory": { env: { MEMORY_PROJECT_ROOT: "dynamic" } } } }),
    );
    writeFileSync(join(project, ".windsurf", "mcp_config.example.json"), "{ not json");

    const diagnostic = diagnoseMemoryConfig(
      { MEMORY_PROJECT_ROOT: project } as NodeJS.ProcessEnv,
      tmpRoot,
      { buildInfo: { builtAt: "2026-06-01T00:00:00.000Z", version: "0.1.0-test" } },
    );
    const doctor = (diagnostic as any).doctor;

    assert.equal(doctor.ok, true);
    assert.equal(doctor.issues.some((issue: { code: string }) => issue.code === "CLIENT_CONFIG_PARSE_ERROR"), false);
    const windsurf = doctor.clients.find((client: { client: string }) => client.client === "windsurf");
    assert.equal(windsurf.configs[1].active, false);
    assert.ok(windsurf.configs[1].parseError);
  });

  it("flags missing vault rules and client configs that omit project-memory", () => {
    const project = join(tmpRoot, "broken-project");
    const externalVault = join(tmpRoot, "external-vault");
    mkdirSync(project, { recursive: true });
    mkdirSync(externalVault, { recursive: true });
    mkdirSync(join(project, ".cursor"), { recursive: true });
    writeFileSync(join(project, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {} }));

    const diagnostic = diagnoseMemoryConfig(
      { MEMORY_PROJECT_ROOT: project, MEMORY_VAULT_PATH: externalVault } as NodeJS.ProcessEnv,
      tmpRoot,
    );
    const doctor = (diagnostic as any).doctor;
    const codes = doctor.issues.map((issue: { code: string }) => issue.code);

    assert.equal(doctor.ok, false);
    assert.equal(doctor.checks.vaultRootExists, true);
    assert.equal(doctor.checks.vaultHasAgentRules, false);
    assert.equal(doctor.checks.vaultWithinProject, false);
    assert.ok(codes.includes("VAULT_AGENT_RULES_MISSING"));
    assert.ok(codes.includes("VAULT_OUTSIDE_PROJECT"));
    assert.ok(codes.includes("CLIENT_CONFIG_MISSING_PROJECT_MEMORY"));

    const missingRules = doctor.issues.find((issue: { code: string }) => issue.code === "VAULT_AGENT_RULES_MISSING");
    assert.equal(missingRules.remediation.path, join(externalVault, "AGENTS.md"));
    assert.match(missingRules.remediation.summary, /Create/);

    const cursorIssue = doctor.issues.find(
      (issue: { code: string; client?: string }) =>
        issue.code === "CLIENT_CONFIG_MISSING_PROJECT_MEMORY" && issue.client === "cursor",
    );
    assert.equal(cursorIssue.remediation.path, join(project, ".cursor", "mcp.json"));
    assert.match(cursorIssue.remediation.snippet, /"project-memory"/);
    assert.match(cursorIssue.remediation.snippet, /"MEMORY_PROJECT_ROOT": "dynamic"/);

    const cursor = doctor.clients.find((client: { client: string }) => client.client === "cursor");
    assert.equal(cursor.configured, false);
    assert.equal(cursor.configs[0].exists, true);
    assert.deepEqual(cursor.issues, ["CLIENT_CONFIG_MISSING_PROJECT_MEMORY"]);
  });
});

describe("resolveDynamicProjectRoot priority order", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "memcfg-pri-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("explicit env (WORKSPACE_ROOT) beats cwd", () => {
    const explicit = join(tmpRoot, "explicit");
    const explicitVault = join(explicit, "memory");
    mkdirSync(explicitVault, { recursive: true });
    writeFileSync(join(explicitVault, "AGENTS.md"), "# vault\n");

    const cwdProject = join(tmpRoot, "cwd-project");
    const cwdVault = join(cwdProject, "memory");
    mkdirSync(cwdVault, { recursive: true });
    writeFileSync(join(cwdVault, "AGENTS.md"), "# vault\n");

    const result = resolveDynamicProjectRoot(
      { WORKSPACE_ROOT: explicit } as NodeJS.ProcessEnv,
      cwdProject,
    );
    assert.equal(resolve(result), resolve(explicit));
  });

  it("returns the workspace root when cwd is inside a marked project", () => {
    // Create a self-contained project so walk-up cannot escape into the OS
    // tmpdir's accidental markers (e.g. package.json files left behind by
    // other tools).
    const project = join(tmpRoot, "proj");
    const inner = join(project, "src", "deep");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(project, "package.json"), "{}\n");

    const result = resolveDynamicProjectRoot({} as NodeJS.ProcessEnv, inner);
    assert.equal(resolve(result), resolve(project));
  });
});
