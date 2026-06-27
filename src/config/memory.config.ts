import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform as nodePlatform } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type MemoryResolutionSource =
  | "env-explicit"
  | "env-vault-marker"
  | "cwd-vault-marker"
  | "env-workspace-marker"
  | "ide-state"
  | "incidental-env"
  | "fallback";

export interface MemoryConfigResolution {
  /** Which detection tier produced the project root. */
  source: MemoryResolutionSource;
  /** True when the resolved root contains the vault marker (memory/AGENTS.md). */
  vaultMarkerFound: boolean;
}

export interface MemoryConfig {
  projectRoot: string;
  vaultRoot: string;
  vaultDirName: string;
  resolution: MemoryConfigResolution;
}

export interface WorkspaceDiagnosticCandidate {
  source: string;
  value: string;
  dynamic: boolean;
  exists: boolean;
  workspaceRoot?: string;
  hasWorkspaceMarker: boolean;
  hasVaultMarker: boolean;
  selected: boolean;
}

export type MemoryClientName =
  | "claude-code"
  | "codex"
  | "cursor"
  | "windsurf"
  | "zed"
  | "opencode"
  | "antigravity";

export type MemoryDoctorIssueSeverity = "info" | "warning";

export interface MemoryDoctorRemediation {
  summary: string;
  path?: string;
  snippet?: string;
  command?: string;
}

export interface MemoryClientConfigDiagnostic {
  path: string;
  active: boolean;
  /** Where the config lives; global configs are only partially scanned. */
  scope?: "project" | "global";
  exists: boolean;
  hasProjectMemory: boolean;
  hasMemoryProjectRoot: boolean;
  memoryProjectRoot?: string;
  parseError?: string;
}

export interface MemoryClientDiagnostic {
  client: MemoryClientName;
  displayName: string;
  configured: boolean;
  enabled?: boolean;
  allowedTools: string[];
  configs: MemoryClientConfigDiagnostic[];
  issues: string[];
}

export interface MemoryDoctorIssue {
  severity: MemoryDoctorIssueSeverity;
  code: string;
  message: string;
  client?: MemoryClientName;
  path?: string;
  remediation?: MemoryDoctorRemediation;
}

export interface MemoryDoctorDiagnostic {
  ok: boolean;
  summary: {
    clientsChecked: number;
    configuredClients: number;
    issueCount: number;
  };
  checks: {
    projectRootExists: boolean;
    vaultRootExists: boolean;
    vaultHasAgentRules: boolean;
    vaultWithinProject: boolean;
    buildInfoPresent: boolean;
  };
  clients: MemoryClientDiagnostic[];
  issues: MemoryDoctorIssue[];
}

export interface MemoryConfigDiagnostic {
  config: MemoryConfig;
  /** Provenance of the resolved project root (mirrors `config.resolution`). */
  resolution: MemoryConfigResolution;
  workspace: {
    source: string;
    candidates: WorkspaceDiagnosticCandidate[];
  };
  env: {
    MEMORY_PROJECT_ROOT?: string;
    MEMORY_WORKSPACE_ROOT?: string;
    WORKSPACE_ROOT?: string;
    PROJECT_ROOT?: string;
    MEMORY_VAULT_DIR?: string;
    MEMORY_VAULT_PATH?: string;
  };
  runtime: {
    cwd: string;
    argv: string[];
    nodeVersion: string;
    pid: number;
    platform: NodeJS.Platform;
    startedAt: string;
  };
  build: MemoryBuildInfo | null;
  /**
   * True when the resolved vault lives inside the project root. False usually
   * means MEMORY_VAULT_PATH points elsewhere on purpose — surfaced (not
   * enforced) so a mis-resolved root is debuggable.
   */
  vaultWithinProject: boolean;
  doctor: MemoryDoctorDiagnostic;
}

export interface MemoryBuildInfo {
  builtAt: string;
  version: string;
  gitSha?: string;
}

interface RuntimeDiagnosticOptions {
  argv?: string[];
  buildInfo?: MemoryBuildInfo | null;
  buildInfoPath?: string;
  nodeVersion?: string;
  pid?: number;
  platform?: NodeJS.Platform;
  startedAt?: string;
}

const MODULE_STARTED_AT = new Date().toISOString();
const DEFAULT_BUILD_INFO_PATH = join(dirname(fileURLToPath(import.meta.url)), "build-info.json");

const firstDefined = (...values: Array<string | undefined>) => values.find((value) => value && value.trim().length > 0);

const dynamicRootValues = new Set(["auto", "detect", "dynamic", "workspace"]);

// Env vars that carry a deliberately communicated workspace location.
const intentionalEnvNames = [
  "MEMORY_WORKSPACE_ROOT",
  "WORKSPACE_ROOT",
  "PROJECT_ROOT",
  "INIT_CWD",
];

// Shell residue inherited from whatever shell spawned the client. Often stale,
// so these must never outrank a vault-bearing cwd or live IDE state.
const incidentalEnvNames = ["PWD", "OLDPWD"];

const candidateEnvNames = [...intentionalEnvNames, ...incidentalEnvNames];

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

interface ClientConfigProbe {
  relativePath: string;
  active: boolean;
  format: "json" | "toml" | "text";
}

interface ClientDefinition {
  client: MemoryClientName;
  displayName: string;
  probes: ClientConfigProbe[];
}

interface InspectedClientConfig {
  diagnostic: MemoryClientConfigDiagnostic;
  format: ClientConfigProbe["format"];
  text?: string;
  json?: unknown;
}

const CLIENT_DEFINITIONS: ClientDefinition[] = [
  {
    client: "claude-code",
    displayName: "Claude Code",
    probes: [
      { relativePath: ".claude/settings.local.json", active: true, format: "json" },
      { relativePath: ".claude/settings.json", active: true, format: "json" },
      { relativePath: ".mcp.json", active: true, format: "json" },
      { relativePath: "CLAUDE.md", active: false, format: "text" },
    ],
  },
  {
    client: "codex",
    displayName: "Codex",
    probes: [
      { relativePath: ".codex/config.toml", active: true, format: "toml" },
    ],
  },
  {
    client: "cursor",
    displayName: "Cursor",
    probes: [
      { relativePath: ".cursor/mcp.json", active: true, format: "json" },
    ],
  },
  {
    client: "windsurf",
    displayName: "Windsurf",
    probes: [
      { relativePath: ".windsurf/mcp.json", active: true, format: "json" },
      { relativePath: ".windsurf/mcp_config.example.json", active: false, format: "json" },
    ],
  },
  {
    client: "zed",
    displayName: "Zed",
    probes: [
      { relativePath: ".zed/settings.json", active: true, format: "json" },
    ],
  },
  {
    client: "opencode",
    displayName: "OpenCode",
    probes: [
      { relativePath: "opencode.json", active: true, format: "json" },
    ],
  },
  {
    client: "antigravity",
    displayName: "Antigravity",
    probes: [
      { relativePath: ".antigravity/mcp.json", active: true, format: "json" },
      { relativePath: ".antigravity/mcp_config.json", active: true, format: "json" },
      { relativePath: ".antigravity/mcp.example.json", active: false, format: "json" },
    ],
  },
];

// VS Code-derived IDEs persist `windowsState.lastActiveWindow.folder` and
// `backupWorkspaces.folders[]` inside `<app-data>/<IDE>/User/globalStorage/storage.json`.
// We probe these known products so MCP-launched processes can still locate
// the active workspace even when the spawning IDE does not forward the
// workspace path. Both legacy and current Antigravity product names are
// included because the IDE was renamed mid-flight ("Antigravity" → "Antigravity IDE").
// Kiro (AWS) is also a VS Code fork and uses the same layout.
const IDE_PRODUCT_DIRS = [
  "Windsurf",
  "devin",
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

// ZCode stores desktop workspace state under the user's home directory instead
// of APPDATA. `lastWorkspaceSession[lastActiveTabIndex]` is the active tab,
// while `recentProjects` is a weaker fallback when no active tab is available.
const ZCODE_SETTING_FILE = join(".zcode", "v2", "setting.json");

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

/** True when `child` resolves to `parent` or a path nested under it. */
function isPathWithin(parent: string, child: string, platform: NodeJS.Platform = nodePlatform()): boolean {
  // win32 filesystems are case-insensitive; compare lowercased so casing drift
  // between env-provided and IDE-provided paths (C:\Users vs c:\users) does
  // not flag VAULT_OUTSIDE_PROJECT spuriously.
  const normalize = (value: string) => {
    const resolved = resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const base = normalize(parent);
  const target = normalize(child);
  return target === base || target.startsWith(`${base}/`) || target.startsWith(`${base}\\`);
}

function hasVaultMarker(directory: string): boolean {
  return existsSync(resolve(directory, VAULT_MARKER));
}

/**
 * True when `directory` must never be adopted as a workspace root: the user
 * home (stray ~/AGENTS.md or ~/package.json files — and ~/memory leftovers
 * from broken vault runs — would otherwise turn the home directory into a
 * vault location) or a filesystem root.
 */
function isForbiddenWorkspaceRoot(directory: string, homeDir: string): boolean {
  const resolved = resolve(directory);
  if (resolved === parse(resolved).root) {
    return true;
  }
  const home = resolve(homeDir);
  if (nodePlatform() === "win32") {
    return resolved.toLowerCase() === home.toLowerCase();
  }
  return resolved === home;
}

function walkUpForMarker(
  start: string,
  matches: (directory: string) => boolean,
  homeDir: string,
): string | undefined {
  let current = resolve(start);
  const root = parse(current).root;

  while (true) {
    if (!isForbiddenWorkspaceRoot(current, homeDir) && matches(current)) {
      return current;
    }

    if (current === root) {
      return undefined;
    }

    current = dirname(current);
  }
}

function findWorkspaceRoot(start: string, homeDir: string = homedir()): string | undefined {
  return walkUpForMarker(start, hasWorkspaceMarker, homeDir);
}

/** Walk up looking specifically for the vault marker (`memory/AGENTS.md`). */
function findVaultWorkspaceRoot(start: string, homeDir: string = homedir()): string | undefined {
  return walkUpForMarker(start, hasVaultMarker, homeDir);
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

function zcodeSettingFiles(env: NodeJS.ProcessEnv): string[] {
  const home = env.USERPROFILE || env.HOME;
  return home ? [join(home, ZCODE_SETTING_FILE)] : [];
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

function zcodeWorkspacePath(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    return entry.startsWith("file://") ? decodeFileUri(entry) ?? entry : entry;
  }
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const data = entry as Record<string, unknown>;
  if (typeof data.kind === "string" && data.kind !== "local") {
    return undefined;
  }
  const raw = data.workspacePath ?? data.path;
  if (typeof raw !== "string") {
    return undefined;
  }
  return raw.startsWith("file://") ? decodeFileUri(raw) ?? raw : raw;
}

function readZcodeWorkspaceCandidates(
  env: NodeJS.ProcessEnv,
  fs: { existsSync: typeof existsSync; readFileSync: typeof readFileSync } = { existsSync, readFileSync },
): IdeWorkspaceCandidate[] {
  const candidates: IdeWorkspaceCandidate[] = [];
  for (const file of zcodeSettingFiles(env)) {
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

    const sessions = Array.isArray(root.lastWorkspaceSession) ? root.lastWorkspaceSession : [];
    const activeIndex = typeof root.lastActiveTabIndex === "number" && Number.isInteger(root.lastActiveTabIndex)
      ? root.lastActiveTabIndex
      : -1;
    let activePathRecorded = false;
    if (activeIndex >= 0 && activeIndex < sessions.length) {
      const activePath = zcodeWorkspacePath(sessions[activeIndex]);
      if (activePath) {
        candidates.push({ path: activePath, lastActive: true, mtimeMs });
        activePathRecorded = true;
      }
    }
    sessions.forEach((entry, index) => {
      if (index === activeIndex) return;
      const path = zcodeWorkspacePath(entry);
      if (path) {
        candidates.push({ path, lastActive: false, mtimeMs });
      }
    });

    const recentProjects = Array.isArray(root.recentProjects) ? root.recentProjects : [];
    recentProjects.forEach((entry, index) => {
      const path = zcodeWorkspacePath(entry);
      if (path) {
        candidates.push({ path, lastActive: !activePathRecorded && index === 0, mtimeMs });
      }
    });
  }
  return candidates;
}

function isZcodeRuntimeCwd(cwd: string | undefined, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (!cwd) return false;
  const home = env.USERPROFILE || env.HOME;
  if (!home) return false;
  return isPathWithin(join(home, ".zcode"), cwd, platform);
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
  const byPath = new Map<string, IdeWorkspaceCandidate>();
  for (const c of candidates) {
    const key = resolve(c.path).toLowerCase();
    if (!existsSync(c.path)) continue;
    const previous = byPath.get(key);
    if (!previous) {
      byPath.set(key, c);
      continue;
    }
    byPath.set(key, {
      path: previous.path,
      lastActive: previous.lastActive || c.lastActive,
      mtimeMs: Math.max(previous.mtimeMs, c.mtimeMs),
    });
  }

  const unique = Array.from(byPath.values());
  const byBestSignal = (a: IdeWorkspaceCandidate, b: IdeWorkspaceCandidate) => {
    if (a.lastActive !== b.lastActive) return a.lastActive ? -1 : 1;
    return b.mtimeMs - a.mtimeMs;
  };

  const withVault = unique.filter((c) => hasVaultMarker(c.path));
  if (withVault.length > 0) {
    return withVault.sort(byBestSignal)[0].path;
  }

  const lastActiveWithMarker = unique
    .filter((c) => c.lastActive && hasWorkspaceMarker(c.path))
    .sort(byBestSignal)[0];
  if (lastActiveWithMarker) {
    return lastActiveWithMarker.path;
  }

  return undefined;
}

function findIdeActiveWorkspace(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = nodePlatform(),
  cwd?: string,
): string | undefined {
  const vscodeLike = readIdeWorkspaceCandidates(env, platform);
  const opencode = readOpencodeWorkspaceCandidates(env, platform);
  const zed = readZedWorkspaceCandidates(env, platform);
  const zcode = readZcodeWorkspaceCandidates(env);
  if (isZcodeRuntimeCwd(cwd, env, platform)) {
    const zcodeWorkspace = pickIdeActiveWorkspace(zcode);
    if (zcodeWorkspace) return zcodeWorkspace;
  }
  // VS Code-derived state is generally fresher (the IDE writes it on every
  // window focus); list it first so the dedup pass keeps that variant. Other
  // IDE-specific readers are appended afterwards so they fill gaps for users
  // who do not run any VS Code-derived IDE alongside.
  return pickIdeActiveWorkspace([...vscodeLike, ...opencode, ...zed, ...zcode]);
}

interface DynamicRootResolution {
  root: string;
  source: Exclude<MemoryResolutionSource, "env-explicit">;
  vaultMarkerFound: boolean;
}

function resolveDynamicProjectRoot(
  env: NodeJS.ProcessEnv,
  cwd: string,
  homeDir: string = homedir(),
): DynamicRootResolution {
  const envValue = (name: string): string | undefined => {
    const value = env[name];
    return value && value.trim().length > 0 && !isDynamicRootValue(value) ? value : undefined;
  };

  // Pass 1 — strongest dynamic signal: an intentional env candidate, then cwd,
  // whose walk-up reaches a directory already containing the vault marker
  // (memory/AGENTS.md). An initialized vault always beats generic workspace
  // markers. PWD/OLDPWD are deliberately NOT consulted here: stale shell
  // residue must not outrank the real cwd or live IDE state even when it
  // points at a vault-bearing project (see pass 4).
  for (const name of intentionalEnvNames) {
    const value = envValue(name);
    if (!value) continue;
    const vaultWorkspace = findVaultWorkspaceRoot(value, homeDir);
    if (vaultWorkspace) {
      return { root: vaultWorkspace, source: "env-vault-marker", vaultMarkerFound: true };
    }
  }
  const cwdVaultWorkspace = findVaultWorkspaceRoot(cwd, homeDir);
  if (cwdVaultWorkspace) {
    return { root: cwdVaultWorkspace, source: "cwd-vault-marker", vaultMarkerFound: true };
  }

  // Pass 2 — intentionally communicated env locations (NOT PWD/OLDPWD, which
  // are just shell residue): accept any generic workspace marker.
  for (const name of intentionalEnvNames) {
    const value = envValue(name);
    if (!value) continue;
    const workspaceRoot = findWorkspaceRoot(value, homeDir);
    if (workspaceRoot) {
      return { root: workspaceRoot, source: "env-workspace-marker", vaultMarkerFound: hasVaultMarker(workspaceRoot) };
    }
  }

  // Pass 3 — IDE state fills the MCP-server case where cwd is usually the
  // client install directory rather than the user's project.
  const ideWorkspace = findIdeActiveWorkspace(env, nodePlatform(), cwd);
  if (ideWorkspace) {
    const workspaceRoot = findWorkspaceRoot(ideWorkspace, homeDir);
    if (workspaceRoot) {
      return { root: workspaceRoot, source: "ide-state", vaultMarkerFound: hasVaultMarker(workspaceRoot) };
    }
  }

  // Pass 4 — incidental env (PWD/OLDPWD) vault check, demoted below cwd and
  // IDE state: a vault marker still outranks the generic-marker walks below,
  // but stale shell residue must never beat the tiers above.
  for (const name of incidentalEnvNames) {
    const value = envValue(name);
    if (!value) continue;
    const vaultWorkspace = findVaultWorkspaceRoot(value, homeDir);
    if (vaultWorkspace) {
      return { root: vaultWorkspace, source: "incidental-env", vaultMarkerFound: true };
    }
  }

  // cwd walk-up to a generic marker keeps the CLI pointed at the project it
  // was launched from. It stays above the PWD/OLDPWD generic check because
  // cwd is at least the directory this process actually runs in.
  const cwdWorkspace = findWorkspaceRoot(cwd, homeDir);
  if (cwdWorkspace) {
    return { root: cwdWorkspace, source: "fallback", vaultMarkerFound: hasVaultMarker(cwdWorkspace) };
  }

  // Pass 5 — incidental shell residue is the LAST env tier: a stale PWD with
  // only generic markers must never outrank cwd or live IDE state.
  for (const name of incidentalEnvNames) {
    const value = envValue(name);
    if (!value) continue;
    const workspaceRoot = findWorkspaceRoot(value, homeDir);
    if (workspaceRoot) {
      return { root: workspaceRoot, source: "incidental-env", vaultMarkerFound: hasVaultMarker(workspaceRoot) };
    }
  }

  // Pass 6 — last resort: trust the IDE state path itself even if the marker
  // walk didn't find one (e.g. brand-new project without a vault yet).
  if (ideWorkspace) {
    const root = resolve(ideWorkspace);
    return { root, source: "ide-state", vaultMarkerFound: hasVaultMarker(root) };
  }
  const root = resolve(cwd);
  return { root, source: "fallback", vaultMarkerFound: hasVaultMarker(root) };
}

export function loadMemoryConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): MemoryConfig {
  const configuredProjectRoot = firstDefined(env.MEMORY_PROJECT_ROOT, env.PROJECT_ROOT, env.WORKSPACE_ROOT);
  let projectRoot: string;
  let resolution: MemoryConfigResolution;
  if (configuredProjectRoot && !isDynamicRootValue(configuredProjectRoot)) {
    projectRoot = resolve(configuredProjectRoot);
    resolution = { source: "env-explicit", vaultMarkerFound: hasVaultMarker(projectRoot) };
  } else {
    const dynamic = resolveDynamicProjectRoot(env, cwd);
    projectRoot = dynamic.root;
    resolution = { source: dynamic.source, vaultMarkerFound: dynamic.vaultMarkerFound };
  }
  const vaultDirName = firstDefined(env.MEMORY_VAULT_DIR) ?? "memory";
  const vaultRoot = env.MEMORY_VAULT_PATH ? resolve(env.MEMORY_VAULT_PATH) : resolve(projectRoot, vaultDirName);

  return {
    projectRoot,
    vaultRoot,
    vaultDirName,
    resolution,
  };
}

function configuredRootSource(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of ["MEMORY_PROJECT_ROOT", "PROJECT_ROOT", "WORKSPACE_ROOT"] as const) {
    const value = env[name];
    if (value && value.trim().length > 0) return name;
  }
  return undefined;
}

function candidateFromValue(source: string, value: string, selectedRoot: string): WorkspaceDiagnosticCandidate {
  const dynamic = isDynamicRootValue(value);
  const workspaceRoot = dynamic ? undefined : findWorkspaceRoot(value);
  const candidatePath = dynamic ? value : resolve(value);
  const resolvedWorkspace = workspaceRoot ? resolve(workspaceRoot) : undefined;
  // The vault walk can resolve higher than the generic-marker walk (e.g. a
  // nested dir with its own package.json under a vault-bearing root), so
  // `selected` must consider both walks or it can contradict `resolution`.
  const vaultWorkspaceRoot = dynamic ? undefined : findVaultWorkspaceRoot(value);
  const resolvedVaultWorkspace = vaultWorkspaceRoot ? resolve(vaultWorkspaceRoot) : undefined;
  const selectedTarget = resolve(selectedRoot).toLowerCase();
  const matchesSelected = (candidate: string | undefined) =>
    candidate !== undefined && candidate.toLowerCase() === selectedTarget;
  return {
    source,
    value,
    dynamic,
    exists: dynamic ? false : existsSync(candidatePath),
    workspaceRoot: resolvedWorkspace,
    hasWorkspaceMarker: dynamic ? false : hasWorkspaceMarker(candidatePath),
    hasVaultMarker: dynamic ? false : hasVaultMarker(candidatePath),
    selected: matchesSelected(resolvedWorkspace) || matchesSelected(resolvedVaultWorkspace),
  };
}

function workspaceDiagnosticCandidates(env: NodeJS.ProcessEnv, cwd: string, selectedRoot: string): WorkspaceDiagnosticCandidate[] {
  const candidates: WorkspaceDiagnosticCandidate[] = [];
  const names = [...new Set(["MEMORY_PROJECT_ROOT", "PROJECT_ROOT", "WORKSPACE_ROOT", ...candidateEnvNames])];
  for (const name of names) {
    const value = env[name];
    if (value && value.trim().length > 0) {
      candidates.push(candidateFromValue(name, value, selectedRoot));
    }
  }

  const ideWorkspace = findIdeActiveWorkspace(env, nodePlatform(), cwd);
  if (ideWorkspace) {
    candidates.push(candidateFromValue("IDE_STATE", ideWorkspace, selectedRoot));
  }

  candidates.push(candidateFromValue("cwd", cwd, selectedRoot));
  return candidates;
}

function readBuildInfo(path = DEFAULT_BUILD_INFO_PATH): MemoryBuildInfo | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const data = parsed as Record<string, unknown>;
    if (typeof data.builtAt !== "string" || typeof data.version !== "string") return null;
    return {
      builtAt: data.builtAt,
      version: data.version,
      gitSha: typeof data.gitSha === "string" ? data.gitSha : undefined,
    };
  } catch {
    return null;
  }
}

function clientConfigAbsolutePath(projectRoot: string, relativePath: string): string {
  return join(projectRoot, ...relativePath.split("/"));
}

function safeExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function safeReadText(path: string): { text?: string; error?: string } {
  try {
    return { text: readFileSync(path, "utf8") };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function parseJsonConfig(text: string): { json?: unknown; error?: string } {
  try {
    return { json: JSON.parse(text.replace(/^\uFEFF/, "")) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function extractMemoryProjectRoot(text: string): string | undefined {
  const match = text.match(/["']?MEMORY_PROJECT_ROOT["']?\s*[:=]\s*["']([^"']+)["']/);
  return match?.[1];
}

function configPathForSnippet(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Resolve the runnable MCP server bundle at `<packageRoot>/dist/index.js`.
 * Walks up from this module to the nearest package.json (same logic as
 * memory-bootstrap.service.ts) because `import.meta.url` sits at different
 * depths per build (bundled dist/, tsc dist-test/, raw src/). Snippets must
 * point at THIS installation's bundle — `<projectRoot>/dist/index.js` is
 * wrong for every project except this repo itself.
 */
function resolveServerEntrypoint(moduleUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(dir, "dist", "index.js").replace(/\\/g, "/");
}

function projectMemoryCommandArgs(): string[] {
  return ["node", resolveServerEntrypoint()];
}

function projectMemoryJsonServer(projectRoot: string): Record<string, unknown> {
  const [command, serverPath] = projectMemoryCommandArgs();
  // Pin the literal project root: auto-detection ("dynamic") can mis-resolve
  // when the client spawns the server from its own install directory.
  return {
    command,
    args: [serverPath],
    env: {
      MEMORY_PROJECT_ROOT: configPathForSnippet(projectRoot),
    },
  };
}

function projectMemorySnippet(client: MemoryClientName, projectRoot: string): string {
  const server = projectMemoryJsonServer(projectRoot);
  if (client === "codex") {
    const [command, serverPath] = projectMemoryCommandArgs();
    return [
      "[mcp_servers.project-memory]",
      `command = "${command}"`,
      `args = ["${serverPath}"]`,
      "enabled = true",
      "",
      "[mcp_servers.project-memory.env]",
      `MEMORY_PROJECT_ROOT = "${configPathForSnippet(projectRoot)}"`,
    ].join("\n");
  }
  if (client === "zed") {
    return JSON.stringify({ context_servers: { "project-memory": server } }, null, 2);
  }
  if (client === "opencode") {
    const [command, serverPath] = projectMemoryCommandArgs();
    return JSON.stringify(
      {
        mcp: {
          "project-memory": {
            type: "local",
            command: [command, serverPath],
            enabled: true,
            environment: {
              MEMORY_PROJECT_ROOT: configPathForSnippet(projectRoot),
            },
          },
        },
      },
      null,
      2,
    );
  }
  return JSON.stringify({ mcpServers: { "project-memory": server } }, null, 2);
}

const CLAUDE_GLOBAL_CONFIG_FILE = ".claude.json";

// ~/.claude.json also accumulates prompt history and every other project's
// MCP entries, so it can grow without bound; cap the structured scan.
const CLAUDE_GLOBAL_CONFIG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Locate the global Claude Code config (`~/.claude.json`). Resolved from env
 * (like ideAppDataRoots) so tests can point HOME at a fixture directory.
 */
function claudeGlobalConfigPath(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME || env.USERPROFILE;
  return home ? join(home, CLAUDE_GLOBAL_CONFIG_FILE) : undefined;
}

function recordHasProjectMemoryServer(value: unknown): boolean {
  const servers = asRecord(asRecord(value)?.mcpServers);
  return servers !== undefined && "project-memory" in servers;
}

/**
 * Collect every project-memory server object registered in the global Claude
 * Code config (top-level `mcpServers` plus `projects[*].mcpServers`). Used to
 * scope env extraction to project-memory entries: a whole-file regex would
 * pick up other projects' servers or prompt history stored in the same file.
 */
function projectMemoryServersInClaudeGlobal(root: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const servers: Array<Record<string, unknown>> = [];
  const top = asRecord(asRecord(root?.mcpServers)?.["project-memory"]);
  if (top) servers.push(top);
  const projects = asRecord(root?.projects);
  if (projects) {
    for (const project of Object.values(projects)) {
      const server = asRecord(asRecord(asRecord(project)?.mcpServers)?.["project-memory"]);
      if (server) servers.push(server);
    }
  }
  return servers;
}

/**
 * Partial scan of the global Claude Code config: project-memory may be
 * registered at the top-level `mcpServers` or per-project under
 * `projects[*].mcpServers`. Only this one global location is probed — other
 * clients' global configs are not scanned at all.
 */
function inspectClaudeGlobalConfig(path: string): InspectedClientConfig | undefined {
  if (!safeExists(path)) {
    return undefined;
  }
  let sizeBytes: number | undefined;
  try {
    sizeBytes = statSync(path).size;
  } catch {
    sizeBytes = undefined;
  }
  if (sizeBytes !== undefined && sizeBytes > CLAUDE_GLOBAL_CONFIG_MAX_BYTES) {
    return {
      diagnostic: {
        path,
        active: true,
        scope: "global",
        exists: true,
        hasProjectMemory: false,
        hasMemoryProjectRoot: false,
        parseError: "too large, partially scanned",
      },
      format: "json",
    };
  }
  const readResult = safeReadText(path);
  const text = readResult.text ?? "";
  const parsed = readResult.text !== undefined ? parseJsonConfig(text) : {};
  const root = asRecord(parsed.json);
  const projects = asRecord(root?.projects);
  const hasProjectMemory = recordHasProjectMemoryServer(root)
    || (projects !== undefined && Object.values(projects).some(recordHasProjectMemoryServer));
  const memoryProjectRoot = projectMemoryServersInClaudeGlobal(root)
    .map((server) => {
      const value = asRecord(server.env)?.MEMORY_PROJECT_ROOT;
      return typeof value === "string" ? value : undefined;
    })
    .find((value) => value !== undefined);
  return {
    diagnostic: {
      path,
      active: true,
      scope: "global",
      exists: true,
      hasProjectMemory,
      hasMemoryProjectRoot: memoryProjectRoot !== undefined,
      memoryProjectRoot,
      parseError: readResult.error ?? parsed.error,
    },
    format: "json",
    text: readResult.text,
    json: parsed.json,
  };
}

function inspectClientConfig(projectRoot: string, probe: ClientConfigProbe): InspectedClientConfig {
  const absolutePath = clientConfigAbsolutePath(projectRoot, probe.relativePath);
  if (!safeExists(absolutePath)) {
    return {
      diagnostic: {
        path: absolutePath,
        active: probe.active,
        exists: false,
        hasProjectMemory: false,
        hasMemoryProjectRoot: false,
      },
      format: probe.format,
    };
  }

  const readResult = safeReadText(absolutePath);
  const text = readResult.text ?? "";
  const memoryProjectRoot = extractMemoryProjectRoot(text);
  const parsed = probe.format === "json" && readResult.text !== undefined
    ? parseJsonConfig(text)
    : {};

  return {
    diagnostic: {
      path: absolutePath,
      active: probe.active,
      exists: true,
      hasProjectMemory: text.includes("project-memory"),
      hasMemoryProjectRoot: text.includes("MEMORY_PROJECT_ROOT"),
      memoryProjectRoot,
      parseError: readResult.error ?? parsed.error,
    },
    format: probe.format,
    text: readResult.text,
    json: parsed.json,
  };
}

// project-memory server entries live under different container keys per
// client: mcpServers (Claude/Cursor/Windsurf/Antigravity), mcp (OpenCode),
// context_servers (Zed).
const PROJECT_MEMORY_SERVER_CONTAINER_KEYS = ["mcpServers", "mcp", "context_servers"] as const;

function findProjectMemoryServer(json: unknown): Record<string, unknown> | undefined {
  const root = asRecord(json);
  if (!root) return undefined;
  for (const key of PROJECT_MEMORY_SERVER_CONTAINER_KEYS) {
    const server = asRecord(asRecord(root[key])?.["project-memory"]);
    if (server) return server;
  }
  return undefined;
}

function enabledFlagFromServer(server: Record<string, unknown>): boolean | undefined {
  if (server.disabled === true || server.enabled === false) return false;
  if (server.disabled === false || server.enabled === true) return true;
  return undefined;
}

/**
 * Scoped TOML scan: only key/value lines inside the
 * `[mcp_servers.project-memory]` table count, so enabled/disabled flags of
 * unrelated servers in the same file are ignored.
 */
function enabledFlagFromToml(text: string): boolean | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    /^\s*\[mcp_servers\.(?:"project-memory"|'project-memory'|project-memory)\]\s*(?:#.*)?$/.test(line));
  if (start === -1) return undefined;
  const block: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) break;
    block.push(lines[index]);
  }
  const scoped = block.join("\n");
  if (/^\s*disabled\s*=\s*true\b/m.test(scoped) || /^\s*enabled\s*=\s*false\b/m.test(scoped)) return false;
  if (/^\s*disabled\s*=\s*false\b/m.test(scoped) || /^\s*enabled\s*=\s*true\b/m.test(scoped)) return true;
  return undefined;
}

function inferProjectMemoryEnabled(inspected: InspectedClientConfig[]): boolean | undefined {
  for (const config of inspected) {
    if (config.format === "toml") {
      if (typeof config.text !== "string") continue;
      const enabled = enabledFlagFromToml(config.text);
      if (enabled !== undefined) return enabled;
      continue;
    }
    const server = findProjectMemoryServer(config.json);
    if (!server) continue;
    const enabled = enabledFlagFromServer(server);
    if (enabled !== undefined) return enabled;
  }
  return undefined;
}

function diagnoseClientIntegration(
  projectRoot: string,
  definition: ClientDefinition,
  env: NodeJS.ProcessEnv,
): MemoryClientDiagnostic {
  const inspected = definition.probes.map((probe) => inspectClientConfig(projectRoot, probe));
  const activeInspected = inspected.filter((config) => config.diagnostic.active);
  const configs = inspected.map((config) => config.diagnostic);
  const activeConfigs = configs.filter((config) => config.active && config.exists);
  const issues: string[] = [];
  let configured = activeConfigs.some((config) => config.hasProjectMemory);
  let enabled = inferProjectMemoryEnabled(activeInspected);
  let allowedTools: string[] = [];

  for (const config of activeConfigs) {
    if (config.parseError) {
      issues.push("CLIENT_CONFIG_PARSE_ERROR");
      break;
    }
  }

  if (definition.client === "claude-code") {
    const projectMcp = inspected.find((config) => config.diagnostic.path.endsWith(join(projectRoot, ".mcp.json")));
    // Both settings files contribute: shared .claude/settings.json and the
    // per-developer .claude/settings.local.json override.
    const settingsConfigs = inspected.filter((config) =>
      config.diagnostic.path.endsWith(join(".claude", "settings.local.json"))
      || config.diagnostic.path.endsWith(join(".claude", "settings.json")));
    const enabledServers = new Set<string>();
    const allowed = new Set<string>();
    let enableAllProjectMcpServers = false;
    let settingsExist = false;
    for (const settings of settingsConfigs) {
      if (!settings.diagnostic.exists) continue;
      settingsExist = true;
      const settingsRecord = asRecord(settings.json);
      if (!settingsRecord) continue;
      for (const server of stringArray(settingsRecord.enabledMcpjsonServers)) {
        enabledServers.add(server);
      }
      const permissions = asRecord(settingsRecord.permissions);
      for (const tool of stringArray(permissions?.allow)) {
        if (tool.startsWith("mcp__project-memory__")) allowed.add(tool);
      }
      if (settingsRecord.enableAllProjectMcpServers === true) {
        enableAllProjectMcpServers = true;
      }
    }
    allowedTools = [...allowed];
    if (settingsExist) {
      const projectMcpHasServer = Boolean(projectMcp?.diagnostic.exists && projectMcp.diagnostic.hasProjectMemory);
      enabled = enabledServers.has("project-memory")
        || (enableAllProjectMcpServers && projectMcpHasServer);
      configured = configured || enabled;
    }

    if (enabled && !projectMcp?.diagnostic.exists) {
      issues.push("CLAUDE_MCP_SERVER_DEFINITION_NOT_LOCAL");
    }

    // The global ~/.claude.json can also register project-memory. Appended
    // after the project-local probes so existing config indexes stay stable,
    // and deliberately kept out of activeConfigs/inferProjectMemoryEnabled: a
    // partial scan must not raise parse warnings or flip the enabled signal.
    const globalPath = claudeGlobalConfigPath(env);
    const globalConfig = globalPath ? inspectClaudeGlobalConfig(globalPath) : undefined;
    if (globalConfig) {
      configs.push(globalConfig.diagnostic);
      if (globalConfig.diagnostic.hasProjectMemory) {
        configured = true;
      }
    }
  }

  if (activeConfigs.length > 0 && !configured) {
    issues.push("CLIENT_CONFIG_MISSING_PROJECT_MEMORY");
  }

  return {
    client: definition.client,
    displayName: definition.displayName,
    configured,
    enabled,
    allowedTools,
    configs,
    issues: [...new Set(issues)],
  };
}

function addDoctorIssue(
  issues: MemoryDoctorIssue[],
  severity: MemoryDoctorIssueSeverity,
  code: string,
  message: string,
  client?: MemoryClientName,
  path?: string,
  remediation?: MemoryDoctorRemediation,
): void {
  issues.push({ severity, code, message, client, path, remediation });
}

function clientIssueMessage(code: string, client: MemoryClientDiagnostic): string {
  switch (code) {
    case "CLIENT_CONFIG_MISSING_PROJECT_MEMORY":
      return `${client.displayName} has an active config file, but it does not mention project-memory.`;
    case "CLIENT_CONFIG_PARSE_ERROR":
      return `${client.displayName} has a config file that could not be parsed.`;
    case "CLAUDE_MCP_SERVER_DEFINITION_NOT_LOCAL":
      return "Claude Code enables project-memory locally, but this project has no root .mcp.json; the server definition may live in a global config.";
    default:
      return `${client.displayName} reported ${code}.`;
  }
}

function clientIssueSeverity(code: string): MemoryDoctorIssueSeverity {
  return code === "CLAUDE_MCP_SERVER_DEFINITION_NOT_LOCAL" ? "info" : "warning";
}

function firstIssuePath(client: MemoryClientDiagnostic): string | undefined {
  return client.configs.find((config) => config.exists)?.path;
}

function clientIssueRemediation(
  code: string,
  client: MemoryClientDiagnostic,
  projectRoot: string,
): MemoryDoctorRemediation | undefined {
  const path = code === "CLAUDE_MCP_SERVER_DEFINITION_NOT_LOCAL"
    ? join(projectRoot, ".mcp.json")
    : firstIssuePath(client);

  switch (code) {
    case "CLIENT_CONFIG_MISSING_PROJECT_MEMORY":
      return {
        summary: `Add a project-memory MCP server entry to ${client.displayName}'s active config. The snippet pins MEMORY_PROJECT_ROOT to this project's path; set it to "dynamic" to fall back to auto-detection.`,
        path,
        snippet: projectMemorySnippet(client.client, projectRoot),
      };
    case "CLIENT_CONFIG_PARSE_ERROR":
      return {
        summary: "Fix the config syntax, then rerun memory_diagnoseWorkspace.",
        path,
      };
    case "CLAUDE_MCP_SERVER_DEFINITION_NOT_LOCAL":
      return {
        summary: "Add a project-local .mcp.json if this repo should be self-contained for Claude Code.",
        path,
        snippet: projectMemorySnippet("claude-code", projectRoot),
      };
    default:
      return undefined;
  }
}

const UNVERIFIED_RESOLUTION_SOURCES: MemoryResolutionSource[] = ["ide-state", "incidental-env", "fallback"];

function buildMemoryDoctorDiagnostic(
  config: MemoryConfig,
  build: MemoryBuildInfo | null,
  vaultWithinProject: boolean,
  env: NodeJS.ProcessEnv,
): MemoryDoctorDiagnostic {
  const checks = {
    projectRootExists: safeExists(config.projectRoot),
    vaultRootExists: safeExists(config.vaultRoot),
    vaultHasAgentRules: safeExists(join(config.vaultRoot, "AGENTS.md")),
    vaultWithinProject,
    buildInfoPresent: build !== null,
  };
  const clients = CLIENT_DEFINITIONS.map((definition) => diagnoseClientIntegration(config.projectRoot, definition, env));
  const issues: MemoryDoctorIssue[] = [];

  if (UNVERIFIED_RESOLUTION_SOURCES.includes(config.resolution.source) && !config.resolution.vaultMarkerFound) {
    addDoctorIssue(
      issues,
      "warning",
      "PROJECT_ROOT_UNVERIFIED",
      `The project root was auto-detected (${config.resolution.source}) without finding a memory vault marker; it may point at the wrong workspace.`,
      undefined,
      config.projectRoot,
      {
        summary: `Set MEMORY_PROJECT_ROOT to the intended workspace path (e.g. "${configPathForSnippet(config.projectRoot)}" if this detection is correct); "dynamic" re-enables auto-detection.`,
        path: config.projectRoot,
      },
    );
  }

  if (!checks.projectRootExists) {
    addDoctorIssue(
      issues,
      "warning",
      "PROJECT_ROOT_MISSING",
      "The resolved project root does not exist.",
      undefined,
      config.projectRoot,
      {
        summary: "Set MEMORY_PROJECT_ROOT to an existing workspace, or open the project root before launching the MCP client.",
        path: config.projectRoot,
      },
    );
  }
  if (!checks.vaultRootExists) {
    addDoctorIssue(
      issues,
      "warning",
      "VAULT_ROOT_MISSING",
      "The resolved memory vault directory does not exist.",
      undefined,
      config.vaultRoot,
      {
        summary: "Create the vault directory with memory_bootstrapProject or point MEMORY_VAULT_PATH at an existing vault.",
        path: config.vaultRoot,
      },
    );
  }
  if (checks.vaultRootExists && !checks.vaultHasAgentRules) {
    const rulesPath = join(config.vaultRoot, "AGENTS.md");
    addDoctorIssue(
      issues,
      "warning",
      "VAULT_AGENT_RULES_MISSING",
      "The resolved memory vault is missing AGENTS.md.",
      undefined,
      rulesPath,
      {
        summary: "Create the vault rule file so agents can discover the memory protocol.",
        path: rulesPath,
        snippet: "# Project Memory Rules\n\nUse memory_sessionStart at task start and memory_sessionEnd at task completion.\n",
      },
    );
  }
  if (!checks.vaultWithinProject) {
    addDoctorIssue(
      issues,
      "warning",
      "VAULT_OUTSIDE_PROJECT",
      "The resolved memory vault is outside the project root.",
      undefined,
      config.vaultRoot,
      {
        summary: "Unset MEMORY_VAULT_PATH or set it to a vault inside the resolved project root if this was not intentional.",
        path: config.vaultRoot,
      },
    );
  }
  if (!checks.buildInfoPresent) {
    addDoctorIssue(
      issues,
      "info",
      "BUILD_INFO_MISSING",
      "dist/build-info.json was not found for this runtime.",
      undefined,
      undefined,
      {
        summary: "Run the project build so runtime diagnostics include build metadata.",
        command: "npm run build",
      },
    );
  }

  for (const client of clients) {
    for (const code of client.issues) {
      addDoctorIssue(
        issues,
        clientIssueSeverity(code),
        code,
        clientIssueMessage(code, client),
        client.client,
        firstIssuePath(client),
        clientIssueRemediation(code, client, config.projectRoot),
      );
    }
  }

  // Global configs are only partially scanned (currently just Claude Code's
  // ~/.claude.json), so they only count as "found" when they actually register
  // project-memory.
  const anyClientConfigFound = clients.some((client) =>
    client.configs.some((configFile) =>
      configFile.active && configFile.exists && (configFile.scope !== "global" || configFile.hasProjectMemory)));
  if (!anyClientConfigFound) {
    addDoctorIssue(
      issues,
      "warning",
      "NO_CLIENT_CONFIGS_FOUND",
      "No known project-local AI client MCP config files were found (global client configs are only partially scanned).",
      undefined,
      undefined,
      {
        summary: "Create a local client MCP config or run memory_bootstrapProject with IDE config generation enabled. The snippet pins MEMORY_PROJECT_ROOT to this project's path; set it to \"dynamic\" to fall back to auto-detection.",
        snippet: projectMemorySnippet("cursor", config.projectRoot),
      },
    );
  }

  return {
    ok: !issues.some((issue) => issue.severity === "warning"),
    summary: {
      clientsChecked: clients.length,
      configuredClients: clients.filter((client) => client.configured).length,
      issueCount: issues.length,
    },
    checks,
    clients,
    issues,
  };
}

export function diagnoseMemoryConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  runtime: RuntimeDiagnosticOptions = {},
): MemoryConfigDiagnostic {
  const config = loadMemoryConfig(env, cwd);
  const candidates = workspaceDiagnosticCandidates(env, cwd, config.projectRoot);
  const selected = candidates.find((candidate) => candidate.selected);
  const configuredSource = configuredRootSource(env);
  const explicitSource = configuredSource && !isDynamicRootValue(env[configuredSource])
    ? configuredSource
    : undefined;
  const build = runtime.buildInfo ?? readBuildInfo(runtime.buildInfoPath);
  const vaultWithinProject = isPathWithin(config.projectRoot, config.vaultRoot);

  return {
    config,
    resolution: config.resolution,
    workspace: {
      source: explicitSource ?? selected?.source ?? "fallback-cwd",
      candidates,
    },
    env: {
      MEMORY_PROJECT_ROOT: env.MEMORY_PROJECT_ROOT,
      MEMORY_WORKSPACE_ROOT: env.MEMORY_WORKSPACE_ROOT,
      WORKSPACE_ROOT: env.WORKSPACE_ROOT,
      PROJECT_ROOT: env.PROJECT_ROOT,
      MEMORY_VAULT_DIR: env.MEMORY_VAULT_DIR,
      MEMORY_VAULT_PATH: env.MEMORY_VAULT_PATH,
    },
    runtime: {
      cwd,
      argv: runtime.argv ?? process.argv,
      nodeVersion: runtime.nodeVersion ?? process.version,
      pid: runtime.pid ?? process.pid,
      platform: runtime.platform ?? nodePlatform(),
      startedAt: runtime.startedAt ?? MODULE_STARTED_AT,
    },
    build,
    vaultWithinProject,
    doctor: buildMemoryDoctorDiagnostic(config, build, vaultWithinProject, env),
  };
}

// Internal API exposed for tests. Keep this list tight and explicit so the
// public surface (`loadMemoryConfig`) stays the supported entry point.
export const __internals = {
  decodeFileUri,
  unescapeJsonString,
  ideStorageFiles,
  opencodeGlobalFiles,
  zcodeSettingFiles,
  extractOpencodeDirectories,
  zedDbFiles,
  decodeZedPathsColumn,
  readIdeWorkspaceCandidates,
  readOpencodeWorkspaceCandidates,
  readZedWorkspaceCandidates,
  readZcodeWorkspaceCandidates,
  isZcodeRuntimeCwd,
  pickIdeActiveWorkspace,
  findIdeActiveWorkspace,
  resolveDynamicProjectRoot,
  resolveServerEntrypoint,
  readBuildInfo,
  hasWorkspaceMarker,
  hasVaultMarker,
  findWorkspaceRoot,
  findVaultWorkspaceRoot,
  isPathWithin,
  isDynamicRootValue,
  tryLoadSqlite,
};
