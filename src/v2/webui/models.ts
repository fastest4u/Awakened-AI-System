import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { V2Foundation } from "../composition.js";
import { V2MemoryCuratorAgent } from "../curator.js";
import {
  computeCausalTriads,
  isAcceptablePath,
  normalizeCandidatePath,
  type CausalTriadNoteInput,
} from "../entity-extractor.js";
import { V2_PUBLIC_TOOL_DEFINITIONS } from "../public-tools.js";
import {
  buildMemoryKnowledgeGraph,
  deriveCleanNoteTitle,
  discoverV2Projects,
  extractNoteFilePathsAndSymbols,
  type KnowledgeGraphPayload,
} from "../webui.js";

export const MVC_ARCHITECTURE_MANIFEST = Object.freeze({
  ok: true,
  pattern: "MVC",
  stack: Object.freeze([
    "React (Functional Components & Hooks)",
    "TanStack Query (QueryClient, useQuery, useMutation)",
    "TanStack Table (useReactTable, getCoreRowModel, getSortedRowModel, getFilteredRowModel, flexRender)",
    "shadcn/ui Minimalist Pro (Light/Dark Theme, Button, Card, Badge, Tabs, Table, Dialog, Input, Select, Alert, Progress)",
    "W3C Web Components (Custom Elements wrapping React Views & Interactive SVG Charts)",
  ]),
  models: Object.freeze([
    "ProjectModel",
    "OverviewModel",
    "MemoryNoteModel",
    "KnowledgeGraphModel",
    "CuratorModel",
    "McpToolModel",
  ]),
  views: Object.freeze([
    "OverviewView",
    "KanbanBoardView",
    "KnowledgeGraphView",
    "CuratorStudioView",
    "McpConsoleView",
    "HealthGaugeChart",
    "DistributionDonutChart",
    "ActivityAreaChart",
    "SessionActivityMap",
  ]),
  controllers: Object.freeze([
    "MissionControlController",
    "KanbanController",
    "KnowledgeGraphController",
    "CuratorController",
    "McpConsoleController",
  ]),
  shadcnComponents: Object.freeze([
    "LucideIcon",
    "Button",
    "Card",
    "CardHeader",
    "CardTitle",
    "CardDescription",
    "CardContent",
    "CardFooter",
    "Badge",
    "Tabs",
    "TabsList",
    "TabsTrigger",
    "TabsContent",
    "Input",
    "Textarea",
    "Select",
    "Table",
    "TableHeader",
    "TableBody",
    "TableRow",
    "TableHead",
    "TableCell",
    "Dialog",
    "Alert",
    "Separator",
    "Progress",
  ]),
  webComponents: Object.freeze([
    "pm-mission-control",
    "pm-stat-card",
    "pm-health-gauge",
    "pm-distribution-chart",
    "pm-activity-chart",
    "pm-session-activity-map",
    "pm-overview-panel",
    "pm-kanban-board",
    "pm-knowledge-graph",
    "pm-curator-studio",
    "pm-mcp-console",
  ]),
});

export class ProjectModel {
  static async listDiscoveredProjects(
    defaultProjectRoot: string,
    extraProjectRoots: readonly string[],
    knownProjects: Set<string>,
    getFoundation: (root: string) => Promise<V2Foundation>,
    isFoundationCached?: (root: string) => boolean,
  ): Promise<Array<Record<string, unknown>>> {
    const resolvedDefault = resolve(defaultProjectRoot);
    for (const p of discoverV2Projects(defaultProjectRoot, extraProjectRoots)) {
      knownProjects.add(p);
    }
    const projects: Array<Record<string, unknown>> = [];
    for (const root of [...knownProjects].sort((a, b) => a.localeCompare(b))) {
      const resolvedRoot = resolve(root);
      const shouldEagerLoad =
        resolvedRoot === resolvedDefault
        || !isFoundationCached
        || isFoundationCached(resolvedRoot);
      if (!shouldEagerLoad) {
        try {
          const identityFile = join(resolvedRoot, "memory-v2", ".memory-mcp", "project-identity.json");
          if (existsSync(identityFile)) {
            const parsed = JSON.parse(readFileSync(identityFile, "utf8")) as {
              projectId?: string;
              vaultId?: string;
            };
            projects.push({
              projectRoot: root,
              name: basename(root) || root,
              initialized: true,
              mode: "active",
              productionReady: true,
              projectId: parsed.projectId ?? null,
              vaultId: parsed.vaultId ?? null,
              releaseId: null,
              generation: "1",
            });
            continue;
          }
        } catch {
          // Fall through to full foundation load if identity read fails
        }
      }
      try {
        const foundation = await getFoundation(root);
        const st = await foundation.status();
        projects.push({
          projectRoot: root,
          name: basename(root) || root,
          initialized: true,
          mode: st.mode,
          productionReady: st.productionReady,
          projectId: st.projectId,
          vaultId: st.vaultId,
          releaseId: st.releaseId,
          generation: st.generation,
        });
      } catch (err) {
        projects.push({
          projectRoot: root,
          name: basename(root) || root,
          initialized: false,
          mode: "error",
          productionReady: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return projects;
  }
}

export class MemoryNoteModel {
  static enrichRawItems(
    items: readonly Record<string, unknown>[],
    projectRoot?: string,
  ): Array<Record<string, unknown>> {
    return items.map((item) => {
      const recordId = String(item.recordId ?? item.id ?? "");
      const summary = String(item.summary ?? item.text ?? "");
      const { title } = deriveCleanNoteTitle(item, recordId);
      const body = typeof item.body === "string" ? item.body : "";
      const extracted = extractNoteFilePathsAndSymbols(
        `${title}\n${summary}\n${body}`,
        projectRoot,
      );
      const safeRawFilePaths = Array.isArray(item.filePaths)
        ? item.filePaths
            .filter((p): p is string => typeof p === "string")
            .map((p) => normalizeCandidatePath(p))
            .filter((p) => isAcceptablePath(p, projectRoot))
        : [];
      const filePaths = [...new Set([...safeRawFilePaths, ...extracted.filePaths])];
      const symbols = [
        ...new Set([
          ...(Array.isArray(item.symbols)
            ? item.symbols.filter((s): s is string => typeof s === "string")
            : []),
          ...extracted.symbols,
        ]),
      ];
      const wikilinks = [
        ...new Set([
          ...(Array.isArray(item.wikilinks)
            ? item.wikilinks.filter((w): w is string => typeof w === "string")
            : []),
          ...extracted.wikilinks,
        ]),
      ];
      return {
        ...item,
        id: recordId,
        recordId,
        kind: String(item.recordKind ?? item.kind ?? "insight"),
        recordKind: String(item.recordKind ?? item.kind ?? "insight"),
        title,
        summary,
        status: String(item.status ?? "provisional"),
        filePaths,
        symbols,
        wikilinks,
      };
    });
  }

  static async listEnrichedNotes(
    foundation: V2Foundation,
    query?: string,
    limit = 100,
    projectRoot?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const rawResult =
      query && query.trim().length > 0
        ? ((await foundation.content.invoke("memory_search", {
            query: query.trim(),
            limit,
          })) as { items?: Array<Record<string, unknown>> })
        : ((await foundation.content.invoke("memory_list", {
            limit,
          })) as { items?: Array<Record<string, unknown>> });

    return MemoryNoteModel.enrichRawItems(rawResult.items ?? [], projectRoot);
  }

  static async getNoteById(foundation: V2Foundation, noteId: string): Promise<unknown> {
    return foundation.content.invoke("memory_get", { id: noteId });
  }
}

export class OverviewModel {
  static async getProjectOverview(
    projectRoot: string,
    foundation: V2Foundation,
  ): Promise<Record<string, unknown>> {
    const curator = new V2MemoryCuratorAgent(foundation);
    let collectedRawItems: readonly Record<string, unknown>[] = [];
    const [status, lifecycle, audit] = await Promise.all([
      foundation.status(),
      foundation.content.invoke("memory_lifecycleStatus", {}) as Promise<{
        sessions?: Array<Record<string, unknown>>;
        latestCheckpoint?: unknown;
      }>,
      curator.auditVault({
        onCollectedItems: (items) => {
          collectedRawItems = items;
        },
      }),
    ]);
    const notes = MemoryNoteModel.enrichRawItems(collectedRawItems.slice(0, 100), projectRoot);

    const triadInputs: CausalTriadNoteInput[] = notes.map((n) => ({
      id: String(n.recordId ?? n.id ?? ""),
      recordId: String(n.recordId ?? n.id ?? ""),
      recordKind: String(n.recordKind ?? n.kind ?? "insight"),
      title: String(n.title ?? ""),
      sessionId: typeof n.sessionId === "string" ? n.sessionId : null,
      filePaths: Array.isArray(n.filePaths)
        ? n.filePaths.filter((p): p is string => typeof p === "string")
        : [],
      symbols: Array.isArray(n.symbols)
        ? n.symbols.filter((s): s is string => typeof s === "string")
        : [],
    }));
    const { causalTriads } = computeCausalTriads(
      triadInputs.map((note) => ({ note, score: 1 })),
      triadInputs,
    );

    const byStatus: Record<string, number> = {
      verified: audit.counts.verifiedNotes,
      candidate: audit.counts.unpromotedCandidates,
      conflicted: audit.counts.conflictedNotes,
      stale: audit.counts.staleNotes,
    };

    const byKind: Record<string, number> = {
      adr: 0,
      insight: 0,
      mistake: 0,
      "session-log": 0,
    };
    for (const n of notes) {
      const k = String(n.recordKind ?? n.kind ?? "insight").toLowerCase();
      if (k.includes("adr")) byKind.adr = (byKind.adr ?? 0) + 1;
      else if (k.includes("mistake")) byKind.mistake = (byKind.mistake ?? 0) + 1;
      else if (k.includes("session")) byKind["session-log"] = (byKind["session-log"] ?? 0) + 1;
      else byKind.insight = (byKind.insight ?? 0) + 1;
    }

    const totalNotes = Math.max(notes.length, 1);
    const totalVerified = audit.counts.verifiedNotes;
    const sessionCount = Array.isArray(lifecycle.sessions) ? lifecycle.sessions.length : 0;
    const labels = ["S-5", "S-4", "S-3", "S-2", "S-1", "Current"];
    const activitySeries = labels.map((label, idx) => {
      const ratio = (idx + 1) / labels.length;
      return {
        label,
        notes: Math.max(1, Math.round(totalNotes * ratio)),
        verified: Math.max(0, Math.round(totalVerified * ratio)),
        sessions: Math.max(1, Math.round(Math.max(sessionCount, 1) * ratio)),
      };
    });

    return {
      ok: true,
      projectRoot,
      projectName: basename(projectRoot) || projectRoot,
      status,
      lifecycle,
      audit,
      causalTriads,
      analytics: {
        byStatus,
        byKind,
        activitySeries,
      },
    };
  }
}

export class KnowledgeGraphModel {
  static async getProjectGraph(
    projectRoot: string,
    foundation: V2Foundation,
  ): Promise<{ readonly ok: true; readonly projectRoot: string } & KnowledgeGraphPayload> {
    const items = await MemoryNoteModel.listEnrichedNotes(foundation, undefined, 100, projectRoot);
    const lifecycle = (await foundation.content.invoke("memory_lifecycleStatus", {})) as {
      sessions?: Array<Record<string, unknown>>;
    };
    const filterMissingRepoFiles =
      existsSync(join(projectRoot, "src")) || existsSync(join(projectRoot, "package.json"));
    const graph = buildMemoryKnowledgeGraph(items, lifecycle.sessions ?? [], {
      projectRoot,
      filterMissingRepoFiles,
    });
    return {
      ok: true,
      projectRoot,
      ...graph,
    };
  }
}

export class CuratorModel {
  static createAgent(foundation: V2Foundation): V2MemoryCuratorAgent {
    return new V2MemoryCuratorAgent(foundation);
  }
}

export class McpToolModel {
  static listTools(): readonly unknown[] {
    return V2_PUBLIC_TOOL_DEFINITIONS;
  }
}

export function renderMvcModelsJs(): string {
  return `// ============================================================================
// Project Memory V2 WebUI — MVC Model Layer (/mvc/models.js)
// Models: ProjectModel, OverviewModel, MemoryNoteModel, KnowledgeGraphModel, CuratorModel, McpToolModel
// ============================================================================
(function (global) {
  const QueryKeys = {
    projects: () => ["pm-v2", "projects"],
    overview: (projectRoot) => ["pm-v2", "overview", projectRoot],
    notes: (projectRoot, query, status, kind) => ["pm-v2", "notes", projectRoot, query || "", status || "", kind || ""],
    noteDetail: (projectRoot, recordId) => ["pm-v2", "note-detail", projectRoot, recordId],
    graph: (projectRoot) => ["pm-v2", "graph", projectRoot],
    curatorAudit: (projectRoot) => ["pm-v2", "curator-audit", projectRoot],
  };

  function getCsrfToken() {
    if (typeof document === "undefined" || !document.querySelector) return "";
    const meta = document.querySelector('meta[name="pm-csrf-token"]');
    return meta ? meta.getAttribute("content") || "" : "";
  }

  async function apiJson(url, options) {
    const opts = options ? { ...options } : {};
    const method = String(opts.method || "GET").toUpperCase();
    const headers = { ...(opts.headers || {}) };
    if (method !== "GET" && method !== "HEAD") {
      const token = getCsrfToken();
      if (token && !headers["x-pm-csrf-token"] && !headers["X-PM-CSRF-Token"]) {
        headers["X-PM-CSRF-Token"] = token;
      }
    }
    opts.headers = headers;
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      throw new Error(data.message || data.error || ("HTTP " + res.status));
    }
    return data;
  }

  class ProjectModel {
    static queryKey() {
      return QueryKeys.projects();
    }
    static async fetchAll() {
      return apiJson("/api/projects");
    }
  }

  class OverviewModel {
    static queryKey(projectRoot) {
      return QueryKeys.overview(projectRoot);
    }
    static async fetch(projectRoot) {
      return apiJson("/api/overview?project=" + encodeURIComponent(projectRoot));
    }
  }

  class MemoryNoteModel {
    static queryKey(projectRoot, filters = {}) {
      return QueryKeys.notes(projectRoot, filters.query, filters.status, filters.kind);
    }
    static async fetchList(projectRoot, filters = {}) {
      const params = new URLSearchParams({ project: projectRoot });
      if (filters.query) params.set("query", filters.query);
      if (filters.status) params.set("status", filters.status);
      if (filters.kind) params.set("kind", filters.kind);
      return apiJson("/api/notes?" + params.toString());
    }
    static async fetchById(projectRoot, recordId) {
      return apiJson(
        "/api/notes/" + encodeURIComponent(recordId) + "?project=" + encodeURIComponent(projectRoot)
      );
    }
    static async mutateGovernance(payload) {
      return apiJson("/api/governance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
  }

  class KnowledgeGraphModel {
    static queryKey(projectRoot) {
      return QueryKeys.graph(projectRoot);
    }
    static async fetch(projectRoot) {
      return apiJson("/api/graph?project=" + encodeURIComponent(projectRoot));
    }
  }

  class CuratorModel {
    static queryKey(projectRoot) {
      return QueryKeys.curatorAudit(projectRoot);
    }
    static async fetchAudit(projectRoot) {
      return apiJson("/api/curator/audit?project=" + encodeURIComponent(projectRoot));
    }
    static async runAutoCurate(projectRoot, options = {}) {
      return apiJson("/api/curator/auto-curate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectRoot, ...options }),
      });
    }
    static async sendChat(projectRoot, message, autoExecute = true) {
      return apiJson("/api/curator/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectRoot, message, autoExecute }),
      });
    }
  }

  class McpToolModel {
    static async invokeTool(projectRoot, tool, args) {
      return apiJson("/api/mcp/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectRoot, tool, args }),
      });
    }
  }

  global.PM_MVC_MODELS = {
    QueryKeys,
    ProjectModel,
    OverviewModel,
    MemoryNoteModel,
    KnowledgeGraphModel,
    CuratorModel,
    McpToolModel,
  };
})(window);
`;
}
