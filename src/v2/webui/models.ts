import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { V2Foundation } from "../composition.js";
import { V2MemoryCuratorAgent } from "../curator.js";
import {
  computeCausalTriads,
  isAcceptablePath,
  normalizeCandidatePath,
  resolveContainedWorkspaceFile,
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
  pattern: "SPA + REST API",
  stack: Object.freeze([
    "Vite 8 SPA Bundler",
    "React 19 (Functional Components & Hooks)",
    "TanStack Router (Client-side routing & search params)",
    "TanStack Query v5 (QueryClient, useQuery, useMutation)",
    "Tailwind CSS v4 + shadcn/ui Minimalist Pro (Light/Dark Theme)",
    "lucide-react & recharts (Data Visualization)",
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
    "NoteDetailSheet",
  ]),
  controllers: Object.freeze([
    "WebUiMvcController",
  ]),
  endpoints: Object.freeze([
    "/api/bootstrap",
    "/api/projects",
    "/api/projects/register",
    "/api/overview",
    "/api/notes",
    "/api/notes/:id",
    "/api/graph",
    "/api/curator/audit",
    "/api/curator/auto-curate",
    "/api/curator/chat",
    "/api/mcp/call",
    "/api/governance",
    "/api/mvc/architecture",
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
  static extractMarkdownBody(item: Record<string, unknown>): string {
    if (typeof item.body === "string" && item.body.trim().length > 0) {
      return item.body;
    }
    if (typeof item.content === "string") {
      return item.content;
    }
    if (item.content && typeof item.content === "object" && !Array.isArray(item.content)) {
      const nestedBody = (item.content as Record<string, unknown>).body;
      if (typeof nestedBody === "string") {
        return nestedBody;
      }
    }
    return "";
  }

  static enrichRawItems(
    items: readonly Record<string, unknown>[],
    projectRoot?: string,
  ): Array<Record<string, unknown>> {
    return items.map((item) => {
      const recordId = String(item.recordId ?? item.id ?? "");
      const summary = String(item.summary ?? item.text ?? "");
      const body = MemoryNoteModel.extractMarkdownBody(item);
      const { title } = deriveCleanNoteTitle({ ...item, body }, recordId);
      const hasProjectedEntities =
        Array.isArray(item.filePaths) &&
        Array.isArray(item.symbols) &&
        Array.isArray(item.wikilinks);
      const extracted = hasProjectedEntities
        ? { filePaths: [] as readonly string[], symbols: [] as readonly string[], wikilinks: [] as readonly string[] }
        : extractNoteFilePathsAndSymbols(`${title}\n${summary}\n${body}`, projectRoot);
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
        body,
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

  static async getNoteById(
    foundation: V2Foundation,
    noteId: string,
    projectRoot?: string,
  ): Promise<Record<string, unknown> | null> {
    const raw = await foundation.content.invoke("memory_get", { id: noteId });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }
    const rec = raw as Record<string, unknown>;
    if (rec.ok === false || rec.found === false) {
      return null;
    }
    if ("recordId" in rec || "id" in rec) {
      return MemoryNoteModel.enrichRawItems([rec], projectRoot)[0] ?? null;
    }
    return null;
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
    const activeRawItems = collectedRawItems.filter(
      (r) =>
        !["retracted", "superseded", "expired", "erased-evidence"].includes(
          String(r.status ?? ""),
        ),
    );
    const filterMissingRepoFiles =
      existsSync(join(projectRoot, "src")) || existsSync(join(projectRoot, "package.json"));
    const notes = MemoryNoteModel.enrichRawItems(activeRawItems.slice(0, 100), projectRoot);

    const triadInputs: CausalTriadNoteInput[] = notes.map((n) => {
      const rawPaths = Array.isArray(n.filePaths)
        ? n.filePaths.filter((p): p is string => typeof p === "string")
        : [];
      const filePaths = filterMissingRepoFiles
        ? rawPaths.filter(
            (fp) => resolveContainedWorkspaceFile(projectRoot, fp, 16 * 1024 * 1024) !== null,
          )
        : rawPaths;
      return {
        id: String(n.recordId ?? n.id ?? ""),
        recordId: String(n.recordId ?? n.id ?? ""),
        recordKind: String(n.recordKind ?? n.kind ?? "insight"),
        title: String(n.title ?? ""),
        sessionId: typeof n.sessionId === "string" ? n.sessionId : null,
        filePaths,
        symbols: Array.isArray(n.symbols)
          ? n.symbols.filter((s): s is string => typeof s === "string")
          : [],
      };
    });
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
    for (const n of activeRawItems) {
      const k = String(n.recordKind ?? n.kind ?? "insight").toLowerCase();
      if (k.includes("adr")) byKind.adr = (byKind.adr ?? 0) + 1;
      else if (k.includes("mistake")) byKind.mistake = (byKind.mistake ?? 0) + 1;
      else if (k.includes("session")) byKind["session-log"] = (byKind["session-log"] ?? 0) + 1;
      else byKind.insight = (byKind.insight ?? 0) + 1;
    }

    const totalVerified = audit.counts.verifiedNotes;
    const sessionCount = Array.isArray(lifecycle.sessions) ? lifecycle.sessions.length : 0;
    const sortedChronoItems = [...activeRawItems].sort((a, b) => {
      const ta = Date.parse(String(a.validFrom ?? "")) || 0;
      const tb = Date.parse(String(b.validFrom ?? "")) || 0;
      if (ta !== tb) return ta - tb;
      return Number(a.sourceEventPosition ?? 0) - Number(b.sourceEventPosition ?? 0);
    });
    const bucketCount =
      sortedChronoItems.length === 0
        ? 2
        : Math.min(6, Math.max(2, sortedChronoItems.length));
    const activitySeries =
      sortedChronoItems.length === 0
        ? [
            {
              label: "Start",
              notes: 0,
              verified: 0,
              sessions: 0,
            },
            {
              label: "Current",
              notes: 0,
              verified: 0,
              sessions: sessionCount,
            },
          ]
        : Array.from({ length: bucketCount }, (_, idx) => {
            const isLast = idx === bucketCount - 1;
            const cutoff = isLast
              ? sortedChronoItems.length
              : Math.max(1, Math.round(((idx + 1) / bucketCount) * sortedChronoItems.length));
            const slice = sortedChronoItems.slice(0, cutoff);
            const verifiedSlice = slice.filter((r) => {
              const st = String(r.status ?? "");
              return st === "verified" || st === "active";
            }).length;
            const sessionsSlice = isLast
              ? sessionCount
              : Math.round(((idx + 1) / bucketCount) * sessionCount);
            const rawDate = String(slice[slice.length - 1]?.validFrom ?? "");
            const shortDate = /^\d{4}-\d{2}-\d{2}/u.test(rawDate) ? rawDate.slice(5, 10) : "";
            return {
              label: isLast ? "Current" : shortDate || `S-${bucketCount - 1 - idx}`,
              notes: slice.length,
              verified: isLast ? totalVerified : verifiedSlice,
              sessions: sessionsSlice,
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
