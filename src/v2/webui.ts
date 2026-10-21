import { existsSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createV2Foundation,
  ensureProjectV2StoreReady,
  type V2Foundation,
} from "./composition.js";
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
}

export interface GraphEdge {
  readonly source: string;
  readonly target: string;
  readonly relation:
    | "created-in-session"
    | "forked-from"
    | "touches-file"
    | "mentions-symbol"
    | "defines-symbol";
}

export interface KnowledgeGraphPayload {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly stats: {
    readonly sessionNodes: number;
    readonly noteNodes: number;
    readonly fileNodes: number;
    readonly symbolNodes: number;
    readonly edgeCount: number;
  };
}

export function extractNoteFilePathsAndSymbols(text: string): {
  readonly filePaths: readonly string[];
  readonly symbols: readonly string[];
} {
  const filePaths = new Set<string>();
  const symbols = new Set<string>();

  const pathRegex =
    /(?:^|[\s`'":(])((?:src|tests|scripts|docs|memory-v2|app|routes|config|packages|lib)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+|[A-Za-z0-9_-]+\.(?:ts|tsx|js|mjs|cjs|json|py|php|go|rs|sql|md))(?=$|[\s`'");,])/gu;
  for (const match of text.matchAll(pathRegex)) {
    const candidate = match[1]?.trim().replace(/\\/gu, "/");
    if (candidate && candidate.length >= 4) {
      filePaths.add(candidate);
    }
  }

  for (const match of text.matchAll(/`([A-Za-z_][A-Za-z0-9_]{2,60})(?:\(\))?`/gu)) {
    const sym = match[1]!.trim();
    if (!sym.includes("/") && !sym.includes(".")) {
      symbols.add(sym);
    }
  }

  for (const match of text.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\b/gu)) {
    const sym = match[1]!.trim();
    if (sym.length >= 6) {
      symbols.add(sym);
    }
  }

  return Object.freeze({
    filePaths: Object.freeze([...filePaths].slice(0, 25)),
    symbols: Object.freeze([...symbols].slice(0, 25)),
  });
}

export function buildMemoryKnowledgeGraph(
  notes: readonly Record<string, unknown>[],
  sessions: readonly Record<string, unknown>[] = [],
): KnowledgeGraphPayload {
  const nodesMap = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();

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
    const sNodeId = ensureSessionNode(sid, s);
    if (typeof s.parentSessionId === "string" && s.parentSessionId.trim().length > 0) {
      const parentNodeId = ensureSessionNode(s.parentSessionId.trim());
      addEdge(parentNodeId, sNodeId, "forked-from");
    }
    if (Array.isArray(s.noteIds)) {
      for (const nid of s.noteIds) {
        if (typeof nid === "string" && nid.trim()) {
          noteToSessionFallback.set(nid.trim(), sid);
        }
      }
    }
  }

  const defaultSessionId =
    sessions[0] && typeof sessions[0].sessionId === "string" && sessions[0].sessionId.trim()
      ? sessions[0].sessionId.trim()
      : "";

  for (const raw of notes) {
    const recordId = String(raw.recordId ?? raw.id ?? "").trim();
    if (!recordId) continue;
    const summary = String(raw.summary ?? raw.text ?? "");
    const colonIdx = summary.indexOf(": ");
    const title =
      typeof raw.title === "string" && raw.title.trim().length > 0
        ? raw.title.trim()
        : colonIdx > 0
          ? summary.slice(0, colonIdx)
          : summary || recordId;
    const subkind = String(raw.recordKind ?? raw.kind ?? "insight");
    const status = String(raw.status ?? "provisional");
    const sessionId =
      typeof raw.sessionId === "string" && raw.sessionId.trim().length > 0
        ? raw.sessionId.trim()
        : (noteToSessionFallback.get(recordId) ?? defaultSessionId);

    const extracted = extractNoteFilePathsAndSymbols(
      `${title}\n${summary}\n${String(raw.body ?? "")}`,
    );
    const filePaths = [
      ...new Set([
        ...(Array.isArray(raw.filePaths)
          ? raw.filePaths.filter((p): p is string => typeof p === "string")
          : []),
        ...extracted.filePaths,
      ]),
    ];
    const symbols = [
      ...new Set([
        ...(Array.isArray(raw.symbols)
          ? raw.symbols.filter((s): s is string => typeof s === "string")
          : []),
        ...extracted.symbols,
      ]),
    ];

    const cleanSummary =
      colonIdx > 0 && summary.slice(0, colonIdx).trim() === title
        ? summary.slice(colonIdx + 2).trim()
        : summary.trim();

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
        ...(sessionId ? { sessionId } : {}),
      }),
    );

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
      if (filePaths.length === 1) {
        addEdge(`file:${filePaths[0]!}`, symNodeId, "defines-symbol");
      }
    }
  }

  const nodes = [...nodesMap.values()];
  return Object.freeze({
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
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
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("INVALID_JSON_OBJECT");
  }
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendJs(res: ServerResponse, scriptBody: string): void {
  res.writeHead(200, {
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
}

export function createV2WebUiHandler(options: V2WebUiOptions) {
  const defaultProjectRoot = resolve(options.defaultProjectRoot);
  const entryUrl = options.entryUrl ?? resolveDefaultEntryUrl();
  const foundationCache = new Map<string, V2Foundation>();
  const ownedFoundations = new Set<V2Foundation>();
  const knownProjects = new Set<string>(
    discoverV2Projects(defaultProjectRoot, options.extraProjectRoots ?? []),
  );

  if (options.foundations) {
    for (const [root, foundation] of options.foundations.entries()) {
      const resolvedRoot = resolve(root);
      foundationCache.set(resolvedRoot, foundation);
      knownProjects.add(resolvedRoot);
    }
  }

  async function getFoundationForProject(projectRoot: string): Promise<V2Foundation> {
    const resolvedRoot = resolve(projectRoot);
    const cached = foundationCache.get(resolvedRoot);
    if (cached) return cached;

    const config = await ensureProjectV2StoreReady({
      projectRoot: resolvedRoot,
      entryUrl,
      syncBuild: true,
      ensureActive: true,
    });
    const foundation = await createV2Foundation(config, { entryUrl });
    foundationCache.set(resolvedRoot, foundation);
    ownedFoundations.add(foundation);
    knownProjects.add(resolvedRoot);
    return foundation;
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const method = req.method ?? "GET";
      const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = parsedUrl.pathname;

      // 1. HTML Host & Modular Frontend MVC Scripts (React + TanStack + shadcn/ui + Web Components)
      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const html = renderMvcIndexHtml(defaultProjectRoot);
        res.writeHead(200, {
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
        if (!candidate) {
          sendJson(res, 400, { ok: false, error: "INVALID_PROJECT_ROOT" });
          return;
        }
        const foundation = await getFoundationForProject(candidate);
        const st = await foundation.status();
        sendJson(res, 200, {
          ok: true,
          projectRoot: candidate,
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
        const noteId = decodeURIComponent(pathname.slice("/api/notes/".length)).trim();
        const projectRoot = validateProjectRootParam(
          parsedUrl.searchParams.get("project"),
          defaultProjectRoot,
        );
        if (!projectRoot || !noteId) {
          sendJson(res, 400, { ok: false, error: "INVALID_PROJECT_ROOT" });
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
      sendJson(res, 500, {
        ok: false,
        error: "WEBUI_INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
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
  const { handler, closeAll } = createV2WebUiHandler(options);
  const server = createServer((req, res) => {
    void handler(req, res);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(requestedPort, host, () => resolveListen());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : requestedPort;
  const url = `http://${host}:${actualPort}`;

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
