import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { platform as nodePlatform } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

export interface MemoryConfig {
  projectRoot: string;
  vaultRoot: string;
  vaultDirName: string;
}

const firstDefined = (...values: Array<string | undefined>) => values.find((value) => value && value.trim().length > 0);

const dynamicRootValues = new Set(["auto", "detect", "dynamic", "workspace"]);

const candidateEnvNames = [
  "MEMORY_WORKSPACE_ROOT",
  "WORKSPACE_ROOT",
  "PROJECT_ROOT",
  "INIT_CWD",
  "PWD",
  "OLDPWD",
];

// Discriminating markers only. Bare IDE config dirs (.codex / .cursor / .kiro /
// .windsurf) and a bare "memory" folder are intentionally NOT used here:
// they also exist at user home on machines running multiple AI IDEs (and
// previous broken vault runs leave behind ~/memory), which makes
// findWorkspaceRoot false-positive on the user home and resolve the vault
// to ~/memory instead of the real project workspace.
const workspaceMarkers = [
  ".git",
  "AGENTS.md",
  "GEMINI.md",
  "package.json",
  "memory/AGENTS.md",
];

// Highest-priority marker: a project that already has a memory vault.
// When auto-detecting across multiple open IDE windows, prefer a workspace
// that the user has already initialized for memory MCP usage.
const VAULT_MARKER = "memory/AGENTS.md";

// VS Code-derived IDEs persist `windowsState.lastActiveWindow.folder` and
// `backupWorkspaces.folders[]` inside `<app-data>/<IDE>/User/globalStorage/storage.json`.
// We probe these known products so MCP-launched processes can still locate
// the active workspace even when the spawning IDE does not forward the
// workspace path. Both legacy and current Antigravity product names are
// included because the IDE was renamed mid-flight ("Antigravity" → "Antigravity IDE").
// Kiro (AWS) is also a VS Code fork and uses the same layout.
const IDE_PRODUCT_DIRS = [
  "Windsurf",
  "Windsurf-Next",
  "Cursor",
  "Code",
  "VSCodium",
  "Antigravity",
  "Antigravity IDE",
  "Kiro",
];

// OpenCode (the Tauri desktop client) ships its own state files at
// `<app-data>/ai.opencode.desktop/`. The richest signal is `opencode.global.dat`
// which embeds a JSON document containing recent workspace directories and
// timestamps in `notification.list[].directory`. We scan it with a forgiving
// regex because the file is intentionally a JSON-string-of-JSON and may
// evolve; regex tolerates new top-level keys without breaking.
const OPENCODE_PRODUCT_DIR = "ai.opencode.desktop";
const OPENCODE_GLOBAL_FILE = "opencode.global.dat";

// Zed persists recent workspaces in a SQLite database. We probe each release
// channel because users may run a stable, preview, or dev build of Zed. The
// schema we care about: `workspaces.paths` (JSON-encoded list of folder
// paths or a single path string) sorted by `workspaces.timestamp DESC`.
// Linux Zed uses lowercase `zed`; macOS / Windows use `Zed`.
const ZED_DB_CHANNELS = ["0-stable", "0-preview", "0-dev"];

// Synchronous require shim so we can feature-detect built-in `node:sqlite`
// without forcing a top-level await chain through loadMemoryConfig().
const requireFn = createRequire(import.meta.url);
let cachedSqlite: { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => SqliteDatabase } | null | undefined;

interface SqliteDatabase {
  prepare(sql: string): { all(...args: unknown[]): unknown[] };
  close(): void;
}

function tryLoadSqlite(): typeof cachedSqlite {
  if (cachedSqlite !== undefined) return cachedSqlite;
  try {
    cachedSqlite = requireFn("node:sqlite") as NonNullable<typeof cachedSqlite>;
  } catch {
    cachedSqlite = null;
  }
  return cachedSqlite;
}

function isDynamicRootValue(value: string | undefined): boolean {
  return value ? dynamicRootValues.has(value.trim().toLowerCase()) : false;
}

function hasWorkspaceMarker(directory: string): boolean {
  return workspaceMarkers.some((marker) => existsSync(resolve(directory, marker)));
}

function hasVaultMarker(directory: string): boolean {
  return existsSync(resolve(directory, VAULT_MARKER));
}

function findWorkspaceRoot(start: string): string | undefined {
  let current = resolve(start);
  const root = parse(current).root;

  while (true) {
    if (hasWorkspaceMarker(current)) {
      return current;
    }

    if (current === root) {
      return undefined;
    }

    current = dirname(current);
  }
}

/**
 * Decode a `file://` URI as written by VS Code-derived IDEs. Handles both
 * POSIX paths (`file:///home/user/proj`) and Windows drive-letter paths
 * (`file:///c%3A/Users/...`).
 */
function decodeFileUri(uri: unknown): string | undefined {
  if (typeof uri !== "string" || !uri.startsWith("file://")) {
    return undefined;
  }
  let pathPart = uri.slice("file://".length);
  // file:///c:/... or file:///C%3A/... → strip the leading slash before drive
  if (/^\/[A-Za-z](?::|%3[Aa])/.test(pathPart)) {
    pathPart = pathPart.slice(1);
  }
  try {
    return decodeURIComponent(pathPart);
  } catch {
    return pathPart;
  }
}

/** Resolve the platform-specific application data root for VS Code-derived IDEs. */
function ideAppDataRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    const appData = env.APPDATA;
    return appData ? [appData] : [];
  }
  const home = env.HOME || env.USERPROFILE;
  if (!home) {
    return [];
  }
  if (platform === "darwin") {
    return [join(home, "Library", "Application Support")];
  }
  // Linux & other POSIX: respect XDG_CONFIG_HOME, fall back to ~/.config
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim().length > 0
    ? env.XDG_CONFIG_HOME
    : join(home, ".config");
  return [xdg];
}

function ideStorageFiles(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const roots = ideAppDataRoots(env, platform);
  const files: string[] = [];
  for (const root of roots) {
    for (const product of IDE_PRODUCT_DIRS) {
      files.push(join(root, product, "User", "globalStorage", "storage.json"));
    }
  }
  return files;
}

function opencodeGlobalFiles(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return ideAppDataRoots(env, platform).map((root) => join(root, OPENCODE_PRODUCT_DIR, OPENCODE_GLOBAL_FILE));
}

/**
 * Resolve the Zed application-data root for the current platform. Zed uses a
 * different convention than VS Code-derived IDEs: on Windows it lives under
 * `LOCALAPPDATA` (not `APPDATA`), and on Linux the directory name is lowercase.
 */
function zedAppDataRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Array<{ root: string; productDir: string }> {
  if (platform === "win32") {
    return env.LOCALAPPDATA ? [{ root: env.LOCALAPPDATA, productDir: "Zed" }] : [];
  }
  const home = env.HOME || env.USERPROFILE;
  if (!home) return [];
  if (platform === "darwin") {
    return [{ root: join(home, "Library", "Application Support"), productDir: "Zed" }];
  }
  // Linux & other POSIX: `~/.local/share/zed` (lowercase) is canonical.
  const xdgData = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim().length > 0
    ? env.XDG_DATA_HOME
    : join(home, ".local", "share");
  return [{ root: xdgData, productDir: "zed" }];
}

function zedDbFiles(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const roots = zedAppDataRoots(env, platform);
  const files: string[] = [];
  for (const { root, productDir } of roots) {
    for (const channel of ZED_DB_CHANNELS) {
      files.push(join(root, productDir, "db", channel, "db.sqlite"));
    }
  }
  return files;
}

/**
 * Best-effort decoder for the `paths` column of Zed's workspaces table. Zed
 * has stored this as both a JSON array of folder paths (multi-root workspaces)
 * and as a raw single path string at different points in its history; we
 * accept either.
 */
function decodeZedPathsColumn(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "string") {
      return parsed[0];
    }
    if (typeof parsed === "string") return parsed;
  } catch {
    // not JSON — treat as a literal path
  }
  return raw;
}

function readZedWorkspaceCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  fs: { existsSync: typeof existsSync } = { existsSync },
  sqliteLoader: typeof tryLoadSqlite = tryLoadSqlite,
): IdeWorkspaceCandidate[] {
  const sqlite = sqliteLoader();
  if (!sqlite) return [];
  const candidates: IdeWorkspaceCandidate[] = [];
  for (const dbPath of zedDbFiles(env, platform)) {
    if (!fs.existsSync(dbPath)) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(dbPath).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    let db: SqliteDatabase;
    try {
      db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    } catch {
      continue;
    }
    try {
      // Limit to a small recent window — we only need the most-active project.
      const rows = db
        .prepare("SELECT paths, timestamp FROM workspaces WHERE paths IS NOT NULL ORDER BY timestamp DESC LIMIT 20")
        .all() as Array<{ paths: unknown; timestamp: unknown }>;
      rows.forEach((row, index) => {
        const decoded = decodeZedPathsColumn(row.paths);
        if (!decoded) return;
        candidates.push({
          path: decoded,
          lastActive: index === 0,
          mtimeMs,
        });
      });
    } catch {
      // schema mismatch (Zed migrated tables); skip this db
    } finally {
      try {
        db.close();
      } catch {
        // ignore close failures
      }
    }
  }
  return candidates;
}

/**
 * Apply standard JSON string unescape rules so paths like `C:\\Users\\me`
 * (as written in JSON) round-trip back to `C:\Users\me`.
 */
function unescapeJsonString(value: string): string {
  return value.replace(/\\(["\\/])|\\u([0-9a-fA-F]{4})/g, (_, char, hex) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    return char;
  });
}

/**
 * Scan an OpenCode `opencode.global.dat` payload and pull out distinct
 * workspace directories with their newest timestamp.
 *
 * The file format is an outer JSON object whose values are themselves
 * stringified JSON (so backslashes and quotes are escaped twice). The fast
 * path is a structured parse via `JSON.parse(outer).notification → JSON.parse →
 * list[]`. The fallback is a forgiving regex that runs on a flattened copy of
 * the raw bytes, which tolerates unknown top-level keys and minor format drift.
 */
function extractOpencodeDirectories(raw: string): Array<{ path: string; time: number }> {
  const seen = new Map<string, number>();
  const record = (path: string, time: number) => {
    if (!path) return;
    const prev = seen.get(path);
    if (prev === undefined || time > prev) seen.set(path, time);
  };

  // Fast path: structured parse.
  try {
    const outer: unknown = JSON.parse(raw);
    if (outer && typeof outer === "object") {
      for (const value of Object.values(outer as Record<string, unknown>)) {
        if (typeof value !== "string") continue;
        let inner: unknown;
        try {
          inner = JSON.parse(value);
        } catch {
          continue;
        }
        if (!inner || typeof inner !== "object") continue;
        const list = (inner as { list?: unknown }).list;
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
          if (!entry || typeof entry !== "object") continue;
          const dir = (entry as { directory?: unknown }).directory;
          const time = (entry as { time?: unknown }).time;
          if (typeof dir === "string") {
            record(dir, typeof time === "number" ? time : 0);
          }
        }
      }
    }
  } catch {
    // outer JSON.parse failed; fall through to regex sweep.
  }

  if (seen.size === 0) {
    // Fallback: flatten one level of escaping to convert `\"directory\":\"C:\\\\..\"`
    // into `"directory":"C:\\..\"`, then regex-scan. Order matters: collapse the
    // string-quote escape before the doubled backslashes.
    const flattened = raw
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
    const re = /"directory"\s*:\s*"((?:[^"\\]|\\.)*)"(?:[\s\S]{0,200}?"time"\s*:\s*(\d+))?/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(flattened))) {
      const decoded = unescapeJsonString(match[1]);
      const time = match[2] ? Number(match[2]) : 0;
      record(decoded, time);
    }
  }

  return Array.from(seen.entries()).map(([path, time]) => ({ path, time }));
}

function readOpencodeWorkspaceCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  fs: { existsSync: typeof existsSync; readFileSync: typeof readFileSync } = { existsSync, readFileSync },
): IdeWorkspaceCandidate[] {
  const candidates: IdeWorkspaceCandidate[] = [];
  for (const file of opencodeGlobalFiles(env, platform)) {
    if (!fs.existsSync(file)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    const dirs = extractOpencodeDirectories(raw).sort((a, b) => b.time - a.time);
    dirs.forEach((entry, index) => {
      candidates.push({
        path: entry.path,
        // Treat the most-recent directory as `lastActive` for ranking parity
        // with VS Code-derived IDE candidates.
        lastActive: index === 0,
        mtimeMs,
      });
    });
  }
  return candidates;
}

interface IdeWorkspaceCandidate {
  /** Decoded absolute path. */
  path: string;
  /** True when this entry was the IDE's last-active window. */
  lastActive: boolean;
  /** Source storage file mtime; newer wins when comparing across IDEs. */
  mtimeMs: number;
}

function readIdeWorkspaceCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  fs: { existsSync: typeof existsSync; readFileSync: typeof readFileSync } = { existsSync, readFileSync },
): IdeWorkspaceCandidate[] {
  const candidates: IdeWorkspaceCandidate[] = [];
  for (const file of ideStorageFiles(env, platform)) {
    if (!fs.existsSync(file)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!data || typeof data !== "object") continue;
    const root = data as Record<string, unknown>;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      mtimeMs = 0;
    }

    const windowsState = root["windowsState"] as { lastActiveWindow?: { folder?: unknown } } | undefined;
    const lastActivePath = decodeFileUri(windowsState?.lastActiveWindow?.folder);
    if (lastActivePath) {
      candidates.push({ path: lastActivePath, lastActive: true, mtimeMs });
    }

    const backup = root["backupWorkspaces"] as { folders?: unknown } | undefined;
    if (backup && Array.isArray(backup.folders)) {
      for (const entry of backup.folders) {
        if (!entry || typeof entry !== "object") continue;
        const folderUri = (entry as Record<string, unknown>)["folderUri"];
        const decoded = decodeFileUri(folderUri);
        if (decoded) {
          candidates.push({ path: decoded, lastActive: false, mtimeMs });
        }
      }
    }
  }
  return candidates;
}

/**
 * Pick the most likely active workspace from IDE state.
 *
 * Strategy:
 *   1. Prefer candidates that already contain a memory vault (`memory/AGENTS.md`).
 *      This is the strongest signal that the user has opted-in to memory MCP
 *      for that project.
 *   2. Among those, prefer the IDE-reported last-active window.
 *   3. Otherwise, prefer the IDE-reported last-active window if it has any
 *      generic workspace marker.
 *   4. Otherwise, give up and let the caller fall back to `cwd`.
 */
function pickIdeActiveWorkspace(candidates: IdeWorkspaceCandidate[]): string | undefined {
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const key = resolve(c.path).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return existsSync(c.path);
  });

  const withVault = unique.filter((c) => hasVaultMarker(c.path));
  if (withVault.length > 0) {
    const active = withVault.find((c) => c.lastActive);
    return active?.path ?? withVault[0].path;
  }

  const lastActiveWithMarker = unique.find((c) => c.lastActive && hasWorkspaceMarker(c.path));
  if (lastActiveWithMarker) {
    return lastActiveWithMarker.path;
  }

  return undefined;
}

function findIdeActiveWorkspace(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = nodePlatform(),
): string | undefined {
  const vscodeLike = readIdeWorkspaceCandidates(env, platform);
  const opencode = readOpencodeWorkspaceCandidates(env, platform);
  const zed = readZedWorkspaceCandidates(env, platform);
  // VS Code-derived state is generally fresher (the IDE writes it on every
  // window focus); list it first so the dedup pass keeps that variant. Zed
  // and OpenCode are appended afterwards so they only fill gaps for users
  // who do not run any VS Code-derived IDE alongside.
  return pickIdeActiveWorkspace([...vscodeLike, ...opencode, ...zed]);
}

function resolveDynamicProjectRoot(env: NodeJS.ProcessEnv, cwd: string): string {
  const ideWorkspace = findIdeActiveWorkspace(env);

  // Order matters: explicit env > IDE state > cwd walk-up.
  // IDE state beats cwd because MCP servers are typically spawned with
  // cwd = IDE install directory, not the user's project.
  const candidates = [
    ...candidateEnvNames.map((name) => env[name]),
    ideWorkspace,
    cwd,
  ].filter((value): value is string => Boolean(value && value.trim().length > 0 && !isDynamicRootValue(value)));

  for (const candidate of candidates) {
    const workspaceRoot = findWorkspaceRoot(candidate);
    if (workspaceRoot) {
      return workspaceRoot;
    }
  }

  // Last resort: trust the IDE state path itself even if the marker walk
  // didn't find one (e.g. brand-new project without a vault yet).
  if (ideWorkspace) {
    return resolve(ideWorkspace);
  }
  return resolve(cwd);
}

export function loadMemoryConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): MemoryConfig {
  const configuredProjectRoot = firstDefined(env.MEMORY_PROJECT_ROOT, env.PROJECT_ROOT, env.WORKSPACE_ROOT);
  const projectRoot = configuredProjectRoot && !isDynamicRootValue(configuredProjectRoot)
    ? resolve(configuredProjectRoot)
    : resolveDynamicProjectRoot(env, cwd);
  const vaultDirName = firstDefined(env.MEMORY_VAULT_DIR) ?? "memory";
  const vaultRoot = env.MEMORY_VAULT_PATH ? resolve(env.MEMORY_VAULT_PATH) : resolve(projectRoot, vaultDirName);

  return {
    projectRoot,
    vaultRoot,
    vaultDirName,
  };
}

// Internal API exposed for tests. Keep this list tight and explicit so the
// public surface (`loadMemoryConfig`) stays the supported entry point.
export const __internals = {
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
  hasWorkspaceMarker,
  hasVaultMarker,
  findWorkspaceRoot,
  isDynamicRootValue,
  tryLoadSqlite,
};
