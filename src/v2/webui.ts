import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildWikilinkResolver } from "../utils/links.js";
import {
  createV2Foundation,
  ensureProjectV2StoreReady,
  type V2Foundation,
} from "./composition.js";
import {
  computeCausalTriads,
  deriveCleanNoteTitleFromFields,
  extractMemoryEntities,
  isAcceptablePath,
  normalizeCandidatePath,
  resolveContainedWorkspaceFile,
  type CausalTriadNoteInput,
  type CausalTriadSummary,
} from "./entity-extractor.js";
import { V2_PUBLIC_TOOL_DEFINITIONS } from "./public-tools.js";
import { WebUiMvcController, renderMvcControllersJs } from "./webui/controllers.js";
import { renderMvcModelsJs } from "./webui/models.js";
import { renderShadcnUiJs } from "./webui/shadcn-ui.js";
import { renderVendorRuntimeJs } from "./webui/vendor-runtime.js";
import {
  renderMvcIndexHtml,
  renderMvcViewsJs,
  renderWebComponentsJs,
} from "./webui/views-and-web-components.js";

export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly kind: "session" | "note" | "file" | "symbol";
  readonly subkind?: string;
  readonly status?: string;
  readonly recordId?: string;
  readonly sessionId?: string;
  readonly currentTask?: string;
  readonly noteCount?: number;
  readonly summary?: string;
  readonly filePaths?: readonly string[];
  readonly symbols?: readonly string[];
  readonly wikilinks?: readonly string[];
  readonly supersedesRecordIds?: readonly string[];
}

export interface GraphEdge {
  readonly source: string;
  readonly target: string;
  readonly relation:
    | "created-in-session"
    | "forked-from"
    | "touches-file"
    | "mentions-symbol"
    | "defines-symbol"
    | "links-to-note"
    | "supersedes"
    | "causal-triad";
}

export interface KnowledgeGraphPayload {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly causalTriads?: readonly CausalTriadSummary[];
  readonly stats: {
    readonly sessionNodes: number;
    readonly noteNodes: number;
    readonly fileNodes: number;
    readonly symbolNodes: number;
    readonly edgeCount: number;
  };
}

export function deriveCleanNoteTitle(raw: Record<string, unknown>, recordId: string): {
  readonly title: string;
  readonly cleanSummary: string;
} {
  return deriveCleanNoteTitleFromFields(
    {
      title: raw.title,
      summary: raw.summary,
      text: raw.text,
      body: raw.body,
    },
    recordId,
  );
}

export function extractNoteFilePathsAndSymbols(
  text: string,
  projectRoot?: string,
): {
  readonly filePaths: readonly string[];
  readonly symbols: readonly string[];
  readonly wikilinks: readonly string[];
} {
  return extractMemoryEntities(text, projectRoot ? { projectRoot } : undefined);
}

export interface BuildKnowledgeGraphOptions {
  readonly projectRoot?: string;
  readonly filterMissingRepoFiles?: boolean;
}

export function buildMemoryKnowledgeGraph(
  notes: readonly Record<string, unknown>[],
  sessions: readonly Record<string, unknown>[] = [],
  options?: BuildKnowledgeGraphOptions,
): KnowledgeGraphPayload {
  const nodesMap = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const fileContentsCache = new Map<string, string | null>();

  const cacheFileEntry = (key: string, value: string | null): void => {
    if (!fileContentsCache.has(key) && fileContentsCache.size >= 256) {
      const oldest = fileContentsCache.keys().next().value;
      if (oldest !== undefined) {
        fileContentsCache.delete(oldest);
      }
    }
    fileContentsCache.set(key, value);
  };

  const readRepoFileCached = (relPath: string): string | null => {
    if (!options?.projectRoot) return null;
    if (fileContentsCache.has(relPath)) {
      return fileContentsCache.get(relPath) ?? null;
    }
    try {
      const contained = resolveContainedWorkspaceFile(options.projectRoot, relPath, 512 * 1024);
      if (!contained) {
        cacheFileEntry(relPath, null);
        return null;
      }
      const content = readFileSync(contained.absPath, "utf8");
      cacheFileEntry(relPath, content);
      return content;
    } catch {
      cacheFileEntry(relPath, null);
      return null;
    }
  };

  const fileDefinesSymbolOnDisk = (relPath: string, sym: string): boolean => {
    const content = readRepoFileCached(relPath);
    if (!content) return false;
    const escaped = sym.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const declRe = new RegExp(
      `(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:class|function|interface|type|const|let|var|enum)\\s+${escaped}\\b`,
      "u",
    );
    return declRe.test(content);
  };

  const addEdge = (
    source: string,
    target: string,
    relation: GraphEdge["relation"],
  ) => {
    const key = `${source}->${target}:${relation}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(Object.freeze({ source, target, relation }));
  };

  const ensureSessionNode = (
    sessionId: string,
    meta?: Record<string, unknown>,
  ): string => {
    const sessionNodeId = `session:${sessionId}`;
    if (!nodesMap.has(sessionNodeId)) {
      const currentTask =
        typeof meta?.currentTask === "string" && meta.currentTask.trim().length > 0
          ? meta.currentTask.trim()
          : "";
      const semanticState = String(meta?.semanticState ?? "active");
      const subkind = String(meta?.kind ?? "root");
      const shortId = sessionId.slice(0, 8);
      const label = currentTask
        ? `Session ${shortId} • ${currentTask.slice(0, 28)}`
        : `Session ${shortId}`;
      nodesMap.set(
        sessionNodeId,
        Object.freeze({
          id: sessionNodeId,
          label,
          kind: "session",
          subkind,
          status: semanticState,
          sessionId,
          currentTask: currentTask || "AI Agent Working Session",
          noteCount: Number(meta?.noteCount ?? 0),
        }),
      );
    }
    return sessionNodeId;
  };

  const noteToSessionFallback = new Map<string, string>();
  for (const s of sessions) {
    const sid = String(s.sessionId ?? "").trim();
    if (!sid) continue;
    if (Array.isArray(s.noteIds)) {
      for (const nid of s.noteIds) {
        if (typeof nid === "string" && nid.trim()) {
          noteToSessionFallback.set(nid.trim(), sid);
        }
      }
    }
    const hasNotes =
      Number(s.noteCount ?? 0) > 0 || (Array.isArray(s.noteIds) && s.noteIds.length > 0);
    const hasParent =
      typeof s.parentSessionId === "string" && s.parentSessionId.trim().length > 0;
    if (!hasNotes && !hasParent && s.semanticState !== "active" && s !== sessions[0]) {
      continue;
    }
    const sNodeId = ensureSessionNode(sid, s);
    if (hasParent) {
      const parentNodeId = ensureSessionNode(String(s.parentSessionId).trim());
      addEdge(parentNodeId, sNodeId, "forked-from");
    }
  }

  interface ParsedNoteGraphEntry extends CausalTriadNoteInput {
    readonly normalizedKey: string;
    readonly wikilinks: readonly string[];
    readonly supersedesTargets: readonly string[];
  }

  const parsedNotes: ParsedNoteGraphEntry[] = [];

  for (const raw of notes) {
    const recordId = String(raw.recordId ?? raw.id ?? "").trim();
    if (!recordId) continue;
    const { title, cleanSummary } = deriveCleanNoteTitle(raw, recordId);
    const summary = String(raw.summary ?? raw.text ?? "");
    const subkind = String(raw.recordKind ?? raw.kind ?? "insight");
    const status = String(raw.status ?? "provisional");
    const normalizedKey =
      typeof raw.normalizedKey === "string" ? raw.normalizedKey.trim() : "";

    // Never fall back to sessions[0] for orphan / imported notes lacking a sessionId.
    const sessionId =
      typeof raw.sessionId === "string" && raw.sessionId.trim().length > 0
        ? raw.sessionId.trim()
        : (noteToSessionFallback.get(recordId) ?? "");

    const extracted = extractMemoryEntities(
      `${title}\n${summary}\n${String(raw.body ?? "")}`,
      options?.projectRoot ? { projectRoot: options.projectRoot } : undefined,
    );
    const safeRawFilePaths = Array.isArray(raw.filePaths)
      ? raw.filePaths
          .filter((p): p is string => typeof p === "string")
          .map((p) => normalizeCandidatePath(p))
          .filter((p) => isAcceptablePath(p, options?.projectRoot))
      : [];
    const mergedFilePaths = [...new Set([...safeRawFilePaths, ...extracted.filePaths])];
    const filePaths =
      options?.filterMissingRepoFiles && options.projectRoot
        ? mergedFilePaths.filter(
            (fp) =>
              resolveContainedWorkspaceFile(options.projectRoot!, fp, 16 * 1024 * 1024) !== null,
          )
        : mergedFilePaths;

    const symbols = [
      ...new Set([
        ...(Array.isArray(raw.symbols)
          ? raw.symbols.filter((s): s is string => typeof s === "string")
          : []),
        ...extracted.symbols,
      ]),
    ];
    const wikilinks = [
      ...new Set([
        ...(Array.isArray(raw.wikilinks)
          ? raw.wikilinks.filter((w): w is string => typeof w === "string")
          : []),
        ...extracted.wikilinks,
      ]),
    ];

    const supersedesTargets = [
      ...new Set([
        ...(typeof raw.supersedesRecordId === "string" && raw.supersedesRecordId.trim()
          ? [raw.supersedesRecordId.trim()]
          : []),
        ...(Array.isArray(raw.supersedesRecordIds)
          ? raw.supersedesRecordIds
              .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
              .map((id) => id.trim())
          : []),
      ]),
    ];

    const noteNodeId = `note:${recordId}`;
    nodesMap.set(
      noteNodeId,
      Object.freeze({
        id: noteNodeId,
        label: title.slice(0, 80),
        kind: "note",
        subkind,
        status,
        recordId,
        summary: (cleanSummary || title).slice(0, 360),
        filePaths: Object.freeze(filePaths.slice(0, 12)),
        symbols: Object.freeze(symbols.slice(0, 16)),
        ...(wikilinks.length > 0 ? { wikilinks: Object.freeze(wikilinks.slice(0, 20)) } : {}),
        ...(supersedesTargets.length > 0
          ? { supersedesRecordIds: Object.freeze(supersedesTargets) }
          : {}),
        ...(sessionId ? { sessionId } : {}),
      }),
    );

    parsedNotes.push({
      id: recordId,
      recordId,
      recordKind: subkind,
      title,
      sessionId: sessionId || null,
      filePaths,
      symbols,
      normalizedKey,
      wikilinks,
      supersedesTargets,
    });

    if (sessionId) {
      const sNodeId = ensureSessionNode(sessionId, {
        currentTask: title,
      });
      addEdge(sNodeId, noteNodeId, "created-in-session");
    }

    for (const filePath of filePaths) {
      const fileNodeId = `file:${filePath}`;
      if (!nodesMap.has(fileNodeId)) {
        nodesMap.set(
          fileNodeId,
          Object.freeze({
            id: fileNodeId,
            label: filePath,
            kind: "file",
          }),
        );
      }
      addEdge(noteNodeId, fileNodeId, "touches-file");
    }

    for (const sym of symbols) {
      const symNodeId = `symbol:${sym}`;
      if (!nodesMap.has(symNodeId)) {
        nodesMap.set(
          symNodeId,
          Object.freeze({
            id: symNodeId,
            label: sym,
            kind: "symbol",
          }),
        );
      }
      addEdge(noteNodeId, symNodeId, "mentions-symbol");

      if (options?.projectRoot) {
        for (const fp of filePaths) {
          if (fileDefinesSymbolOnDisk(fp, sym)) {
            addEdge(`file:${fp}`, symNodeId, "defines-symbol");
          }
        }
      } else if (filePaths.length === 1) {
        addEdge(`file:${filePaths[0]!}`, symNodeId, "defines-symbol");
      }
    }
  }

  // Pass 2: Wikilink, Supersession, and IDF-weighted Causal Triad edges across notes
  const wikilinkResolver = buildWikilinkResolver(
    parsedNotes.map((n) => ({
      path: n.recordId,
      title: n.title,
      id: n.recordId,
      aliases: n.normalizedKey
        ? [n.normalizedKey, n.normalizedKey.split("/").pop() ?? ""].filter(Boolean)
        : [],
    })),
  );

  for (const n of parsedNotes) {
    const sourceNodeId = `note:${n.recordId}`;
    for (const target of n.wikilinks) {
      const resolvedRecordId = wikilinkResolver(target);
      if (
        resolvedRecordId
        && resolvedRecordId !== n.recordId
        && nodesMap.has(`note:${resolvedRecordId}`)
      ) {
        addEdge(sourceNodeId, `note:${resolvedRecordId}`, "links-to-note");
      }
    }
    for (const oldRecordId of n.supersedesTargets) {
      if (oldRecordId !== n.recordId && nodesMap.has(`note:${oldRecordId}`)) {
        addEdge(sourceNodeId, `note:${oldRecordId}`, "supersedes");
      }
    }
  }

  const { causalTriads } = computeCausalTriads(
    parsedNotes.map((note) => ({ note, score: 1 })),
    parsedNotes,
  );
  for (const triad of causalTriads) {
    const mistakeNodeId = `note:${triad.anchorMistakeId}`;
    if (!nodesMap.has(mistakeNodeId)) continue;
    for (const adrId of triad.relatedAdrIds) {
      if (adrId !== triad.anchorMistakeId && nodesMap.has(`note:${adrId}`)) {
        addEdge(mistakeNodeId, `note:${adrId}`, "causal-triad");
      }
    }
    for (const insightId of triad.relatedInsightIds) {
      if (insightId !== triad.anchorMistakeId && nodesMap.has(`note:${insightId}`)) {
        addEdge(mistakeNodeId, `note:${insightId}`, "causal-triad");
      }
    }
  }

  const nodes = [...nodesMap.values()];
  return Object.freeze({
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    causalTriads,
    stats: Object.freeze({
      sessionNodes: nodes.filter((n) => n.kind === "session").length,
      noteNodes: nodes.filter((n) => n.kind === "note").length,
      fileNodes: nodes.filter((n) => n.kind === "file").length,
      symbolNodes: nodes.filter((n) => n.kind === "symbol").length,
      edgeCount: edges.length,
    }),
  });
}

export function discoverV2Projects(
  seedProjectRoot: string,
  extraRoots: readonly string[] = [],
): string[] {
  const discovered = new Set<string>();
  const tryAdd = (candidatePath: string) => {
    try {
      const resolved = resolve(candidatePath);
      const identityFile = join(resolved, "memory-v2", ".memory-mcp", "project-identity.json");
      if (existsSync(identityFile)) {
        discovered.add(resolved);
      }
    } catch {
      // Ignore inaccessible directories
    }
  };

  tryAdd(seedProjectRoot);
  for (const extra of extraRoots) {
    tryAdd(extra);
  }

  try {
    const parentDir = dirname(resolve(seedProjectRoot));
    for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        tryAdd(join(parentDir, entry.name));
      }
    }
  } catch {
    // Ignore parent scan errors
  }

  if (discovered.size === 0 && isAbsolute(seedProjectRoot)) {
    discovered.add(resolve(seedProjectRoot));
  }

  return [...discovered].sort((a, b) => a.localeCompare(b));
}

function validateProjectRootParam(raw: string | null | undefined, fallback: string): string | null {
  if (!raw || raw.trim().length === 0) return fallback;
  const trimmed = raw.trim();
  if (trimmed.includes("\0") || !isAbsolute(trimmed)) return null;
  const segments = trimmed.split(/[\\/]+/u);
  if (segments.includes("..")) return null;
  return resolve(trimmed);
}

function resolveDefaultEntryUrl(): string {
  try {
    const selfPath = fileURLToPath(import.meta.url);
    const adjacentV2 = join(dirname(selfPath), "v2.js");
    if (existsSync(adjacentV2) && statSync(adjacentV2).isFile()) {
      return pathToFileURL(adjacentV2).href;
    }
  } catch {
    // Fallback below
  }
  const distV2 = resolve(process.cwd(), "dist", "v2.js");
  if (existsSync(distV2)) {
    return pathToFileURL(distV2).href;
  }
  return import.meta.url;
}

const WEBUI_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
});

const WILDCARD_BIND_HOSTS = new Set(["0.0.0.0", "::", "[::]", "::0", "[::0]", "*"]);

function isAllowedHostName(hostname: string, extraHost?: string): boolean {
  const lower = hostname.trim().toLowerCase();
  if (!lower || WILDCARD_BIND_HOSTS.has(lower)) {
    return false;
  }
  if (
    lower === "127.0.0.1"
    || lower === "localhost"
    || lower === "[::1]"
    || lower === "::1"
  ) {
    return true;
  }
  if (extraHost) {
    const normalizedExtra = extraHost.trim().toLowerCase();
    if (
      normalizedExtra &&
      !WILDCARD_BIND_HOSTS.has(normalizedExtra) &&
      (lower === normalizedExtra ||
        (normalizedExtra.includes(":") && !normalizedExtra.startsWith("[") && lower === `[${normalizedExtra}]`))
    ) {
      return true;
    }
  }
  return false;
}

function pathContainsOrEquals(root: string, target: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const rel = relative(norm(root), norm(target));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function canonicalizeProjectRoot(projectRoot: string): string {
  const resolved = resolve(projectRoot);
  try {
    if (existsSync(resolved)) {
      return realpathSync.native(resolved);
    }
  } catch {
    // Fall back to resolved path when target is missing
  }
  return resolved;
}

function canonicalProjectKey(projectRoot: string): string {
  const canonical = canonicalizeProjectRoot(projectRoot);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function extractHostnameFromHostHeader(hostHeader: string): string {
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith("[")) {
    const closeIdx = trimmed.indexOf("]");
    return closeIdx > 0 ? trimmed.slice(0, closeIdx + 1) : trimmed;
  }
  const colonIdx = trimmed.indexOf(":");
  return colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > 1024 * 1024) {
      throw new Error("PAYLOAD_TOO_LARGE");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("INVALID_JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("INVALID_JSON_OBJECT");
  }
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...WEBUI_SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendJs(res: ServerResponse, scriptBody: string): void {
  res.writeHead(200, {
    ...WEBUI_SECURITY_HEADERS,
    "content-type": "application/javascript; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(scriptBody);
}

export interface V2WebUiOptions {
  readonly defaultProjectRoot: string;
  readonly extraProjectRoots?: readonly string[];
  readonly entryUrl?: string;
  readonly foundations?: ReadonlyMap<string, V2Foundation>;
  readonly allowedHost?: string;
}

export function createV2WebUiHandler(options: V2WebUiOptions) {
  const defaultProjectRoot = canonicalizeProjectRoot(options.defaultProjectRoot);
  const entryUrl = options.entryUrl ?? resolveDefaultEntryUrl();
  const csrfToken = randomBytes(24).toString("hex");
  const foundationCache = new Map<string, V2Foundation>();
  const foundationPromiseCache = new Map<string, Promise<V2Foundation>>();
  const ownedFoundations = new Set<V2Foundation>();
  const knownProjects = new Set<string>();
  const addKnownProject = (root: string): void => {
    const canonical = canonicalizeProjectRoot(root);
    const key = canonicalProjectKey(canonical);
    for (const existing of knownProjects) {
      if (canonicalProjectKey(existing) === key) return;
    }
    knownProjects.add(canonical);
  };
  for (const p of discoverV2Projects(defaultProjectRoot, options.extraProjectRoots ?? [])) {
    addKnownProject(p);
  }
  addKnownProject(defaultProjectRoot);

  if (options.foundations) {
    for (const [root, foundation] of options.foundations.entries()) {
      const canonical = canonicalizeProjectRoot(root);
      foundationCache.set(canonicalProjectKey(canonical), foundation);
      addKnownProject(canonical);
    }
  }

  function isRegisteredOrInitializedProject(projectRoot: string): boolean {
    const canonical = canonicalizeProjectRoot(projectRoot);
    const key = canonicalProjectKey(canonical);
    if (foundationCache.has(key)) return true;
    for (const known of knownProjects) {
      if (canonicalProjectKey(known) === key) return true;
    }
    const identityFile = join(canonical, "memory-v2", ".memory-mcp", "project-identity.json");
    if (existsSync(identityFile)) {
      addKnownProject(canonical);
      return true;
    }
    return false;
  }

  async function getFoundationForProject(projectRoot: string): Promise<V2Foundation> {
    const canonicalRoot = canonicalizeProjectRoot(projectRoot);
    const cacheKey = canonicalProjectKey(canonicalRoot);
    const cached = foundationCache.get(cacheKey);
    if (cached) {
      foundationCache.delete(cacheKey);
      foundationCache.set(cacheKey, cached);
      return cached;
    }
    const inflight = foundationPromiseCache.get(cacheKey);
    if (inflight) return inflight;

    const initPromise = (async () => {
      const config = await ensureProjectV2StoreReady({
        projectRoot: canonicalRoot,
        entryUrl,
        syncBuild: true,
        ensureActive: true,
      });
      const foundation = await createV2Foundation(config, { entryUrl });
      if (ownedFoundations.size >= 32) {
        for (const [oldKey, oldFoundation] of foundationCache.entries()) {
          if (ownedFoundations.has(oldFoundation)) {
            foundationCache.delete(oldKey);
            ownedFoundations.delete(oldFoundation);
            void oldFoundation.close().catch(() => undefined);
            break;
          }
        }
      }
      foundationCache.set(cacheKey, foundation);
      ownedFoundations.add(foundation);
      addKnownProject(canonicalRoot);
      return foundation;
    })();
    foundationPromiseCache.set(cacheKey, initPromise);
    try {
      return await initPromise;
    } finally {
      foundationPromiseCache.delete(cacheKey);
    }
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const method = (req.method ?? "GET").toUpperCase();

      // 0a. DNS-Rebinding defense: strictly require & validate Host header
      const rawHostHeader = typeof req.headers.host === "string" ? req.headers.host.trim() : "";
      if (!rawHostHeader) {
        sendJson(res, 403, { ok: false, error: "FORBIDDEN_HOST" });
        return;
      }
      const hostOnly = extractHostnameFromHostHeader(rawHostHeader);
      if (!isAllowedHostName(hostOnly, options.allowedHost)) {
        sendJson(res, 403, { ok: false, error: "FORBIDDEN_HOST" });
        return;
      }

      // 0b. Mutating request security: Content-Type + Origin/Sec-Fetch-Site + Unconditional X-PM-CSRF-Token
      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
        const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
        if (!contentType.startsWith("application/json")) {
          sendJson(res, 415, { ok: false, error: "UNSUPPORTED_MEDIA_TYPE" });
          return;
        }

        const secFetchSite =
          typeof req.headers["sec-fetch-site"] === "string"
            ? req.headers["sec-fetch-site"].trim().toLowerCase()
            : "";
        if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
          sendJson(res, 403, { ok: false, error: "CSRF_ORIGIN_DENIED" });
          return;
        }

        const originHeader = typeof req.headers.origin === "string" ? req.headers.origin.trim() : "";
        if (originHeader) {
          let parsedOrigin: URL;
          try {
            parsedOrigin = new URL(originHeader);
          } catch {
            sendJson(res, 403, { ok: false, error: "CSRF_ORIGIN_DENIED" });
            return;
          }
          if (!isAllowedHostName(parsedOrigin.hostname, options.allowedHost)) {
            sendJson(res, 403, { ok: false, error: "CSRF_ORIGIN_DENIED" });
            return;
          }
          const originPort =
            parsedOrigin.port || (parsedOrigin.protocol === "https:" ? "443" : "80");
          const closeBracket = rawHostHeader.indexOf("]");
          const colonIdx = rawHostHeader.lastIndexOf(":");
          if (colonIdx > closeBracket) {
            const reqPort = rawHostHeader.slice(colonIdx + 1).trim();
            if (reqPort && originPort !== reqPort) {
              sendJson(res, 403, { ok: false, error: "CSRF_ORIGIN_DENIED" });
              return;
            }
          }
        }

        const providedCsrf =
          typeof req.headers["x-pm-csrf-token"] === "string"
            ? req.headers["x-pm-csrf-token"].trim()
            : "";
        const expectedBuf = Buffer.from(csrfToken, "utf8");
        const providedBuf = Buffer.from(providedCsrf, "utf8");
        if (
          providedBuf.byteLength !== expectedBuf.byteLength
          || !timingSafeEqual(providedBuf, expectedBuf)
        ) {
          sendJson(res, 403, { ok: false, error: "CSRF_TOKEN_INVALID" });
          return;
        }
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        sendJson(res, 400, { ok: false, error: "INVALID_URI" });
        return;
      }
      const pathname = parsedUrl.pathname;

      // 1. HTML Host & Modular Frontend MVC Scripts (React + TanStack + shadcn/ui + Web Components)
      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const html = renderMvcIndexHtml(defaultProjectRoot, csrfToken);
        res.writeHead(200, {
          ...WEBUI_SECURITY_HEADERS,
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(html);
        return;
      }
      if (method === "GET" && pathname === "/mvc/vendor.js") {
        sendJs(res, renderVendorRuntimeJs());
        return;
      }
      if (method === "GET" && pathname === "/mvc/models.js") {
        sendJs(res, renderMvcModelsJs());
        return;
      }
      if (method === "GET" && pathname === "/mvc/controllers.js") {
        sendJs(res, renderMvcControllersJs());
        return;
      }
      if (method === "GET" && pathname === "/mvc/shadcn-ui.js") {
        sendJs(res, renderShadcnUiJs());
        return;
      }
      if (method === "GET" && pathname === "/mvc/views.js") {
        sendJs(res, renderMvcViewsJs());
        return;
      }
      if (method === "GET" && pathname === "/mvc/web-components.js") {
        sendJs(res, renderWebComponentsJs());
        return;
      }

      // 2. MVC Architecture Inspection Endpoint
      if (method === "GET" && pathname === "/api/mvc/architecture") {
        sendJson(res, 200, WebUiMvcController.getArchitectureManifest());
        return;
      }

      // 3. MVC Controller Routes
      if (method === "GET" && pathname === "/api/projects") {
        const payload = await WebUiMvcController.listProjects(
          defaultProjectRoot,
          options.extraProjectRoots ?? [],
          knownProjects,
          getFoundationForProject,
          (root) => foundationCache.has(canonicalProjectKey(root)),
        );
        sendJson(res, 200, payload);
        return;
      }

      if (method === "POST" && pathname === "/api/projects/register") {
        const body = await readJsonBody(req);
        const candidate = validateProjectRootParam(
          typeof body.projectRoot === "string" ? body.projectRoot : null,
          "",
        );
        if (!candidate || !existsSync(candidate)) {
          sendJson(res, 400, { ok: false, error: "INVALID_PROJECT_ROOT" });
          return;
        }
        let candidateStat: ReturnType<typeof lstatSync>;
        try {
          candidateStat = lstatSync(candidate);
        } catch {
          sendJson(res, 400, { ok: false, error: "INVALID_PROJECT_ROOT" });
          return;
        }
        if (candidateStat.isSymbolicLink() || !candidateStat.isDirectory()) {
          sendJson(res, 400, { ok: false, error: "INVALID_PROJECT_ROOT" });
          return;
        }
        let canonicalCandidate: string;
        try {
          canonicalCandidate = realpathSync.native(candidate);
        } catch {
          sendJson(res, 400, { ok: false, error: "INVALID_PROJECT_ROOT" });
          return;
        }
        if (canonicalProjectKey(canonicalCandidate) !== canonicalProjectKey(defaultProjectRoot)) {
          const defaultMemory = join(defaultProjectRoot, "memory");
          const defaultVaultV2 = join(defaultProjectRoot, "memory-v2");
          if (
            pathContainsOrEquals(defaultMemory, canonicalCandidate) ||
            pathContainsOrEquals(canonicalCandidate, defaultMemory) ||
            pathContainsOrEquals(defaultVaultV2, canonicalCandidate) ||
            pathContainsOrEquals(canonicalCandidate, defaultVaultV2)
          ) {
            sendJson(res, 400, { ok: false, error: "PROJECT_PATH_OVERLAP" });
            return;
          }
        }
        const foundation = await getFoundationForProject(canonicalCandidate);
        const st = await foundation.status();
        sendJson(res, 200, {
          ok: true,
          projectRoot: canonicalCandidate,
          status: st,
        });
        return;
      }

      if (method === "GET" && pathname === "/api/overview") {
        const projectRoot = validateProjectRootParam(
          parsedUrl.searchParams.get("project"),
          defaultProjectRoot,
        );
        if (!projectRoot) {
          sendJson(res, 400, { ok: false, error: "INVALID_PROJECT_ROOT" });
          return;
        }
        if (!isRegisteredOrInitializedProject(projectRoot)) {
          sendJson(res, 403, { ok: false, error: "UNREGISTERED_PROJECT_ROOT" });
          return;
        }
        const foundation = await getFoundationForProject(projectRoot);
        const payload = await WebUiMvcController.getOverview(projectRoot, foundation);
        sendJson(res, 200, payload);
        return;
      }

      if (method === "GET" && pathname === "/api/notes") {
        const projectRoot = validateProjectRootParam(
          parsedUrl.searchParams.get("project"),
          defaultProjectRoot,
        );
        if (!projectRoot) {
          sendJson(res, 400, { ok: false, error: "INVALID_PROJECT_ROOT" });
          return;
        }
        if (!isRegisteredOrInitializedProject(projectRoot)) {
          sendJson(res, 403, { ok: false, error: "UNREGISTERED_PROJECT_ROOT" });
          return;
        }
        const foundation = await getFoundationForProject(projectRoot);
        const payload = await WebUiMvcController.listNotes(projectRoot, foundation, {
          query: parsedUrl.searchParams.get("query") ?? undefined,
          status: parsedUrl.searchParams.get("status") ?? "",
          kind: parsedUrl.searchParams.get("kind") ?? "",
        });
        sendJson(res, 200, payload);
        return;
      }

      if (method === "GET" && pathname.startsWith("/api/notes/")) {
        let noteId = "";
        try {
          noteId = decodeURIComponent(pathname.slice("/api/notes/".length)).trim();
        } catch {
          sendJson(res, 400, { ok: false, error: "INVALID_URI" });
          return;
        }
        const projectRoot = validateProjectRootParam(
          parsedUrl.searchParams.get("project"),
          defaultProjectRoot,
        );
        if (!projectRoot || !noteId) {
          sendJson(res, 400, { ok: false, error: "INVALID_PROJECT_ROOT" });
          return;
        }
        if (!isRegisteredOrInitializedProject(projectRoot)) {
          sendJson(res, 403, { ok: false, error: "UNREGISTERED_PROJECT_ROOT" });
          return;
        }
        const foundation = await getFoundationForProject(projectRoot);
        const payload = await WebUiMvcController.getNoteDetail(projectRoot, foundation, noteId);
        sendJson(res, 200, payload);
        return;
      }

      if (method === "POST" && pathname === "/api/governance") {
        const body = await readJsonBody(req);
        const projectRoot = validateProjectRootParam(
          typeof body.projectRoot === "string"
            ? body.projectRoot
            : parsedUrl.searchParams.get("project"),
          defaultProjectRoot,
        );
        if (!projectRoot) {
          sendJson(res, 400, { ok: false, error: "INVALID_PROJECT_ROOT" });
          return;
        }
        if (!isRegisteredOrInitializedProject(projectRoot)) {
          sendJson(res, 403, { ok: false, error: "UNREGISTERED_PROJECT_ROOT" });
          return;
        }
        const foundation = await getFoundationForProject(projectRoot);
        const { statusCode, payload } = await WebUiMvcController.executeGovernanceAction(
          foundation,
          body,
        );
        sendJson(res, statusCode, payload);
        return;
      }

      if (method === "GET" && pathname === "/api/graph") {
        const projectRoot = validateProjectRootParam(
          parsedUrl.searchParams.get("project"),
          defaultProjectRoot,
        );
        if (!projectRoot) {
          sendJson(res, 400, { ok: false, error: "INVALID_PROJECT_ROOT" });
          return;
        }
        if (!isRegisteredOrInitializedProject(projectRoot)) {
          sendJson(res, 403, { ok: false, error: "UNREGISTERED_PROJECT_ROOT" });
          return;
        }
        const foundation = await getFoundationForProject(projectRoot);
        const payload = await WebUiMvcController.getKnowledgeGraph(projectRoot, foundation);
        sendJson(res, 200, payload);
        return;
      }

      if (method === "GET" && pathname === "/api/curator/audit") {
        const projectRoot = validateProjectRootParam(
          parsedUrl.searchParams.get("project"),
          defaultProjectRoot,
        );
        if (!projectRoot) {
          sendJson(res, 400, { ok: false, error: "INVALID_PROJECT_ROOT" });
          return;
        }
        if (!isRegisteredOrInitializedProject(projectRoot)) {
          sendJson(res, 403, { ok: false, error: "UNREGISTERED_PROJECT_ROOT" });
          return;
        }
        const foundation = await getFoundationForProject(projectRoot);
        const payload = await WebUiMvcController.getCuratorAudit(projectRoot, foundation);
        sendJson(res, 200, payload);
        return;
      }

      if (method === "POST" && pathname === "/api/curator/auto-curate") {
        const body = await readJsonBody(req);
        const projectRoot = validateProjectRootParam(
          typeof body.projectRoot === "string"
            ? body.projectRoot
            : parsedUrl.searchParams.get("project"),
          defaultProjectRoot,
        );
        if (!projectRoot) {
          sendJson(res, 400, { ok: false, error: "INVALID_PROJECT_ROOT" });
          return;
        }
        if (!isRegisteredOrInitializedProject(projectRoot)) {
          sendJson(res, 403, { ok: false, error: "UNREGISTERED_PROJECT_ROOT" });
          return;
        }
        const foundation = await getFoundationForProject(projectRoot);
        const payload = await WebUiMvcController.runCuratorAutoCurate(
          projectRoot,
          foundation,
          body,
        );
        sendJson(res, 200, payload);
        return;
      }

      if (method === "POST" && pathname === "/api/curator/chat") {
        const body = await readJsonBody(req);
        const projectRoot = validateProjectRootParam(
          typeof body.projectRoot === "string"
            ? body.projectRoot
            : parsedUrl.searchParams.get("project"),
          defaultProjectRoot,
        );
        if (!projectRoot) {
          sendJson(res, 400, { ok: false, error: "INVALID_PROJECT_ROOT" });
          return;
        }
        if (!isRegisteredOrInitializedProject(projectRoot)) {
          sendJson(res, 403, { ok: false, error: "UNREGISTERED_PROJECT_ROOT" });
          return;
        }
        const message = typeof body.message === "string" ? body.message.trim() : "";
        if (!message) {
          sendJson(res, 400, { ok: false, error: "EMPTY_MESSAGE" });
          return;
        }
        const foundation = await getFoundationForProject(projectRoot);
        const payload = await WebUiMvcController.runCuratorChat(
          projectRoot,
          foundation,
          message,
          body.autoExecute !== false,
        );
        sendJson(res, 200, payload);
        return;
      }

      if (method === "GET" && pathname === "/api/mcp/tools") {
        sendJson(res, 200, {
          ok: true,
          tools: V2_PUBLIC_TOOL_DEFINITIONS,
        });
        return;
      }

      if (method === "POST" && pathname === "/api/mcp/call") {
        const body = await readJsonBody(req);
        const projectRoot = validateProjectRootParam(
          typeof body.projectRoot === "string"
            ? body.projectRoot
            : parsedUrl.searchParams.get("project"),
          defaultProjectRoot,
        );
        if (!projectRoot) {
          sendJson(res, 400, { ok: false, error: "INVALID_PROJECT_ROOT" });
          return;
        }
        if (!isRegisteredOrInitializedProject(projectRoot)) {
          sendJson(res, 403, { ok: false, error: "UNREGISTERED_PROJECT_ROOT" });
          return;
        }
        const toolName = typeof body.tool === "string" ? body.tool.trim() : "";
        const isAllowedTool = V2_PUBLIC_TOOL_DEFINITIONS.some((t) => t.name === toolName);
        if (!toolName || !isAllowedTool) {
          sendJson(res, 400, { ok: false, error: "INVALID_MCP_TOOL" });
          return;
        }
        const toolArgs =
          body.args && typeof body.args === "object" && !Array.isArray(body.args)
            ? (body.args as Record<string, unknown>)
            : {};
        const foundation = await getFoundationForProject(projectRoot);
        if (toolName === "memory_v2Status") {
          sendJson(res, 200, {
            ok: true,
            tool: toolName,
            result: await foundation.status(),
          });
          return;
        }
        const result = await foundation.content.invoke(toolName, toolArgs);
        sendJson(res, 200, {
          ok: true,
          tool: toolName,
          result,
        });
        return;
      }

      sendJson(res, 404, { ok: false, error: "NOT_FOUND", path: pathname });
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      if (code === "PAYLOAD_TOO_LARGE") {
        sendJson(res, 413, { ok: false, error: "PAYLOAD_TOO_LARGE" });
        return;
      }
      if (
        err instanceof URIError
        || code === "INVALID_JSON"
        || code === "INVALID_JSON_OBJECT"
      ) {
        sendJson(res, 400, { ok: false, error: code || "INVALID_REQUEST" });
        return;
      }
      sendJson(res, 500, {
        ok: false,
        error: "WEBUI_INTERNAL_ERROR",
      });
    }
  };

  return {
    handler,
    async closeAll(): Promise<void> {
      for (const f of ownedFoundations) {
        try {
          await f.close();
        } catch {
          // Ignore close errors
        }
      }
      ownedFoundations.clear();
    },
  };
}

export async function startV2WebUiServer(
  options: V2WebUiOptions & { readonly port?: number; readonly host?: string },
): Promise<{
  readonly url: string;
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 4321;
  const { handler, closeAll } = createV2WebUiHandler({
    ...options,
    allowedHost: host,
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(requestedPort, host, () => resolveListen());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : requestedPort;
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const url = `http://${formattedHost}:${actualPort}`;

  return {
    url,
    port: actualPort,
    host,
    async close(): Promise<void> {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
      await closeAll();
    },
  };
}
