import type { V2Foundation } from "../composition.js";
import {
  CuratorModel,
  KnowledgeGraphModel,
  MVC_ARCHITECTURE_MANIFEST,
  MemoryNoteModel,
  OverviewModel,
  ProjectModel,
} from "./models.js";

export class WebUiMvcController {
  static getArchitectureManifest() {
    return MVC_ARCHITECTURE_MANIFEST;
  }

  static async listProjects(
    defaultProjectRoot: string,
    extraProjectRoots: readonly string[],
    knownProjects: Set<string>,
    getFoundation: (root: string) => Promise<V2Foundation>,
    isFoundationCached?: (root: string) => boolean,
  ) {
    const projects = await ProjectModel.listDiscoveredProjects(
      defaultProjectRoot,
      extraProjectRoots,
      knownProjects,
      getFoundation,
      isFoundationCached,
    );
    return {
      ok: true,
      defaultProjectRoot,
      projects,
    };
  }

  static async getOverview(projectRoot: string, foundation: V2Foundation) {
    return OverviewModel.getProjectOverview(projectRoot, foundation);
  }

  static async listNotes(
    projectRoot: string,
    foundation: V2Foundation,
    filters: { query?: string; status?: string; kind?: string },
  ) {
    let items = await MemoryNoteModel.listEnrichedNotes(foundation, filters.query, 100);
    if (filters.status) {
      items = items.filter((i) => i.status === filters.status);
    }
    if (filters.kind) {
      items = items.filter((i) => i.recordKind === filters.kind || i.kind === filters.kind);
    }
    return {
      ok: true,
      projectRoot,
      items,
    };
  }

  static async getNoteDetail(projectRoot: string, foundation: V2Foundation, noteId: string) {
    const note = await MemoryNoteModel.getNoteById(foundation, noteId);
    return {
      ok: true,
      projectRoot,
      note,
    };
  }

  static async executeGovernanceAction(
    foundation: V2Foundation,
    body: Record<string, unknown>,
  ): Promise<{ readonly statusCode: number; readonly payload: Record<string, unknown> }> {
    const action = String(body.action ?? "").trim();
    let result: unknown;
    switch (action) {
      case "promote":
        result = await foundation.content.invoke("memory_promote", {
          recordId: body.recordId ?? body.id,
          targetStatus: body.targetStatus ?? "verified",
          verificationMethod: body.verificationMethod ?? "user-confirmed",
          reason: body.reason ?? "Promoted via Project Memory V2 WebUI",
        });
        break;
      case "supersede":
        result = await foundation.content.invoke("memory_supersede", {
          recordId: body.recordId ?? body.id,
          supersedingRecordId: body.supersedingRecordId ?? body.replacementRecordId,
          reason: body.reason ?? "Superseded via Project Memory V2 WebUI",
        });
        break;
      case "retract":
        result = await foundation.content.invoke("memory_retract", {
          recordId: body.recordId ?? body.id,
          reason: body.reason ?? "Retracted via Project Memory V2 WebUI",
        });
        break;
      case "expire":
        result = await foundation.content.invoke("memory_expire", {
          recordId: body.recordId ?? body.id,
          reason: body.reason ?? "Expired via Project Memory V2 WebUI",
        });
        break;
      case "writeADR":
      case "write_adr":
        result = await foundation.content.invoke("memory_writeADR", {
          title: body.title,
          summary: body.summary,
          content: body.content,
        });
        break;
      case "writeInsight":
      case "write_insight":
        result = await foundation.content.invoke("memory_writeInsight", {
          title: body.title,
          summary: body.summary,
          content: body.content,
        });
        break;
      case "writeMistake":
      case "write_mistake":
        result = await foundation.content.invoke("memory_writeMistake", {
          title: body.title,
          summary: body.summary,
          content: body.content,
        });
        break;
      default:
        return {
          statusCode: 400,
          payload: { ok: false, error: "UNSUPPORTED_GOVERNANCE_ACTION" },
        };
    }
    return {
      statusCode: 200,
      payload: { ok: true, action, result },
    };
  }

  static async getKnowledgeGraph(projectRoot: string, foundation: V2Foundation) {
    return KnowledgeGraphModel.getProjectGraph(projectRoot, foundation);
  }

  static async getCuratorAudit(projectRoot: string, foundation: V2Foundation) {
    const curator = CuratorModel.createAgent(foundation);
    const audit = await curator.auditVault();
    return {
      ...audit,
      projectRoot,
    };
  }

  static async runCuratorAutoCurate(
    projectRoot: string,
    foundation: V2Foundation,
    body: Record<string, unknown>,
  ) {
    const curator = CuratorModel.createAgent(foundation);
    const receipt = await curator.autoCurate({
      promoteCandidates: body.promoteCandidates !== false,
      resolveDuplicates: body.resolveDuplicates !== false,
      expireStale: body.expireStale !== false,
    });
    return {
      ...receipt,
      projectRoot,
    };
  }

  static async runCuratorChat(
    projectRoot: string,
    foundation: V2Foundation,
    message: string,
    autoExecute: boolean,
  ) {
    const curator = CuratorModel.createAgent(foundation);
    const reply = await curator.chat({
      message,
      autoExecute,
    });
    return {
      ...reply,
      projectRoot,
    };
  }
}

export function renderMvcControllersJs(): string {
  return `// ============================================================================
// Project Memory V2 WebUI — MVC Controller Layer (/mvc/controllers.js)
// Powered by React Hooks + TanStack Query (useQuery, useMutation, useQueryClient)
// Controllers: MissionControlController, KanbanController, KnowledgeGraphController, CuratorController, McpConsoleController
// ============================================================================
(function (global) {
  const { useState, useEffect, useMemo, useCallback, useRef, createContext, useContext } = global.React;
  const { useQuery, useMutation, useQueryClient } = global.TanStackQuery;
  const {
    ProjectModel,
    OverviewModel,
    MemoryNoteModel,
    KnowledgeGraphModel,
    CuratorModel,
    McpToolModel,
  } = global.PM_MVC_MODELS;

  const VALID_TABS = new Set(["overview", "kanban", "graph", "curator", "mcp"]);

  function parseDeepLinkHash(defaultProjectRoot) {
    if (typeof window === "undefined" || !window.location) {
      return {
        tab: "overview",
        project: defaultProjectRoot || "",
        note: null,
        node: null,
        session: null,
        q: "",
        kind: "",
        status: "",
      };
    }
    const rawHash = String(window.location.hash || "").replace(/^#/, "");
    if (!rawHash) {
      return {
        tab: "overview",
        project: defaultProjectRoot || "",
        note: null,
        node: null,
        session: null,
        q: "",
        kind: "",
        status: "",
      };
    }
    const qIdx = rawHash.indexOf("?");
    let rawTab = "";
    let params;
    if (qIdx >= 0) {
      rawTab = rawHash.slice(0, qIdx).trim().toLowerCase();
      params = new URLSearchParams(rawHash.slice(qIdx + 1));
    } else if (rawHash.includes("=")) {
      params = new URLSearchParams(rawHash);
      rawTab = String(params.get("view") || params.get("tab") || "").trim().toLowerCase();
    } else {
      rawTab = rawHash.trim().toLowerCase();
      params = new URLSearchParams("");
    }
    const tab = VALID_TABS.has(rawTab) ? rawTab : "overview";
    return {
      tab,
      project: params.get("project") || defaultProjectRoot || "",
      note: params.get("note") || null,
      node: params.get("node") || null,
      session: params.get("session") || null,
      q: params.get("q") || "",
      kind: params.get("kind") || params.get("type") || "",
      status: params.get("status") || "",
    };
  }

  function writeDeepLinkHash(state, defaultProjectRoot) {
    if (typeof window === "undefined" || !window.history || !window.history.replaceState) return;
    const tab = VALID_TABS.has(state.tab) ? state.tab : "overview";
    const params = new URLSearchParams();
    if (state.project && state.project !== defaultProjectRoot) params.set("project", state.project);
    if (state.note) params.set("note", state.note);
    if (state.node) params.set("node", state.node);
    if (state.session && state.session !== "all") params.set("session", state.session);
    if (state.q) params.set("q", state.q);
    if (state.kind && state.kind !== "all") params.set("kind", state.kind);
    if (state.status && state.status !== "all") params.set("status", state.status);
    const qs = params.toString();
    const nextHash = "#" + tab + (qs ? "?" + qs : "");
    if (window.location.hash !== nextHash) {
      try {
        window.history.replaceState(null, "", nextHash);
      } catch (_e) {}
    }
  }

  const MissionControlContext = createContext(null);

  function useMissionControlController(defaultProjectRoot) {
    const queryClient = useQueryClient();
    const initialRoute = useMemo(() => parseDeepLinkHash(defaultProjectRoot), [defaultProjectRoot]);
    const [currentProject, setCurrentProject] = useState(initialRoute.project || defaultProjectRoot || "");
    const [activeTab, setActiveTabState] = useState(initialRoute.tab || "overview");
    const [inspectedRecordId, setInspectedRecordIdState] = useState(initialRoute.note || null);
    const [graphJumpTarget, setGraphJumpTarget] = useState(
      initialRoute.node || initialRoute.session || initialRoute.q || initialRoute.kind
        ? {
            nodeId: initialRoute.node,
            sessionId: initialRoute.session || "all",
            query: initialRoute.q || "",
            kind: initialRoute.kind || "all",
            ts: 1,
          }
        : null
    );
    const [kanbanJumpTarget, setKanbanJumpTarget] = useState(
      initialRoute.tab === "kanban" && (initialRoute.q || initialRoute.kind)
        ? { query: initialRoute.q || "", kind: initialRoute.kind || "", ts: 1 }
        : null
    );
    const [toastMessage, setToastMessage] = useState(null);
    const [theme, setTheme] = useState("dark");
    const [showTechDetails, setShowTechDetails] = useState(false);

    useEffect(() => {
      if (typeof window === "undefined" || !window.addEventListener) return;
      const onHashChange = () => {
        const parsed = parseDeepLinkHash(defaultProjectRoot);
        setActiveTabState(parsed.tab);
        if (parsed.project) setCurrentProject(parsed.project);
        setInspectedRecordIdState(parsed.note);
        if (parsed.node || parsed.session || (parsed.tab === "graph" && (parsed.q || parsed.kind))) {
          setGraphJumpTarget({
            nodeId: parsed.node,
            sessionId: parsed.session || "all",
            query: parsed.q || "",
            kind: parsed.kind || "all",
            ts: Date.now(),
          });
        }
        if (parsed.tab === "kanban" && (parsed.q || parsed.kind)) {
          setKanbanJumpTarget({ query: parsed.q || "", kind: parsed.kind || "", ts: Date.now() });
        }
      };
      window.addEventListener("hashchange", onHashChange);
      return () => window.removeEventListener("hashchange", onHashChange);
    }, [defaultProjectRoot]);

    const setActiveTab = useCallback(
      (nextTab) => {
        setActiveTabState(nextTab);
        writeDeepLinkHash(
          { tab: nextTab, project: currentProject, note: inspectedRecordId },
          defaultProjectRoot
        );
      },
      [currentProject, inspectedRecordId, defaultProjectRoot]
    );

    const inspectNote = useCallback(
      (recordId) => {
        const cleanId = recordId ? String(recordId) : null;
        setInspectedRecordIdState(cleanId);
        writeDeepLinkHash(
          { tab: activeTab, project: currentProject, note: cleanId },
          defaultProjectRoot
        );
      },
      [activeTab, currentProject, defaultProjectRoot]
    );

    const closeInspectModal = useCallback(() => {
      setInspectedRecordIdState(null);
      writeDeepLinkHash({ tab: activeTab, project: currentProject, note: null }, defaultProjectRoot);
    }, [activeTab, currentProject, defaultProjectRoot]);

    const openInGraph = useCallback(
      (opts = {}) => {
        const targetNodeId =
          opts.nodeId ||
          (opts.recordId ? "note:" + opts.recordId : null) ||
          (opts.sessionId ? "session:" + opts.sessionId : null) ||
          (opts.filePath ? "file:" + opts.filePath : null) ||
          (opts.symbol ? "symbol:" + opts.symbol : null);
        const query = opts.query || "";
        const kind = opts.kind || "all";
        const sessionId = opts.filterSessionId || "all";
        setInspectedRecordIdState(null);
        setGraphJumpTarget({ nodeId: targetNodeId, sessionId, query, kind, ts: Date.now() });
        setActiveTabState("graph");
        writeDeepLinkHash(
          { tab: "graph", project: currentProject, node: targetNodeId, session: sessionId, q: query, kind },
          defaultProjectRoot
        );
      },
      [currentProject, defaultProjectRoot]
    );

    const openInKanban = useCallback(
      (opts = {}) => {
        const query = String(opts.query || "").trim();
        const kind = String(opts.kind || "").trim();
        setInspectedRecordIdState(null);
        setKanbanJumpTarget({ query, kind, ts: Date.now() });
        setActiveTabState("kanban");
        writeDeepLinkHash(
          { tab: "kanban", project: currentProject, q: query, kind },
          defaultProjectRoot
        );
      },
      [currentProject, defaultProjectRoot]
    );

    const toggleTheme = useCallback(() => {
      setTheme((prev) => {
        const next = prev === "dark" ? "light" : "dark";
        if (typeof document !== "undefined" && document.documentElement) {
          document.documentElement.className = next;
        }
        return next;
      });
    }, []);

    const notify = useCallback((msg, tone = "info") => {
      setToastMessage({ id: Date.now(), text: msg, tone });
      setTimeout(() => {
        setToastMessage((prev) => (prev && prev.text === msg ? null : prev));
      }, 4500);
    }, []);

    const projectsQuery = useQuery({
      queryKey: ProjectModel.queryKey(),
      queryFn: () => ProjectModel.fetchAll(),
    });

    const overviewQuery = useQuery({
      queryKey: OverviewModel.queryKey(currentProject),
      queryFn: () => OverviewModel.fetch(currentProject),
      enabled: Boolean(currentProject),
    });

    const noteDetailQuery = useQuery({
      queryKey: ["pm-v2", "note-detail", currentProject, inspectedRecordId || ""],
      queryFn: () => MemoryNoteModel.fetchById(currentProject, inspectedRecordId),
      enabled: Boolean(currentProject && inspectedRecordId),
    });

    const refreshAll = useCallback(() => {
      queryClient.invalidateQueries({ queryKey: ["pm-v2"] });
      notify("ซิงก์ข้อมูลคลังความจำเรียบร้อยแล้ว (Synced TanStack Query Cache)", "success");
    }, [queryClient, notify]);

    const switchProject = useCallback(
      (nextProject) => {
        setCurrentProject(nextProject);
        setInspectedRecordIdState(null);
        writeDeepLinkHash({ tab: activeTab, project: nextProject }, defaultProjectRoot);
      },
      [activeTab, defaultProjectRoot]
    );

    return {
      currentProject,
      switchProject,
      activeTab,
      setActiveTab,
      inspectedRecordId,
      inspectNote,
      closeInspectModal,
      graphJumpTarget,
      kanbanJumpTarget,
      openInGraph,
      openInKanban,
      noteDetailQuery,
      projectsQuery,
      overviewQuery,
      refreshAll,
      toastMessage,
      notify,
      theme,
      toggleTheme,
      showTechDetails,
      setShowTechDetails,
    };
  }

  class MissionControlController {
    static useController(defaultProjectRoot) {
      return useMissionControlController(defaultProjectRoot);
    }
    static get Context() {
      return MissionControlContext;
    }
    static useMissionControl() {
      return useContext(MissionControlContext);
    }
  }

  class KanbanController {
    static useController(projectRoot, notify, jumpTarget) {
      const queryClient = useQueryClient();
      const [searchQuery, setSearchQuery] = useState(
        jumpTarget && jumpTarget.query ? String(jumpTarget.query) : ""
      );
      const [kindFilter, setKindFilter] = useState(
        jumpTarget && jumpTarget.kind ? String(jumpTarget.kind) : ""
      );
      const [viewMode, setViewMode] = useState("kanban"); // "kanban" | "table"
      const [newKind, setNewKind] = useState("writeADR");
      const [newTitle, setNewTitle] = useState("");
      const [newSummary, setNewSummary] = useState("");

      useEffect(() => {
        if (!jumpTarget) return;
        if (typeof jumpTarget.query === "string") setSearchQuery(jumpTarget.query);
        if (typeof jumpTarget.kind === "string") setKindFilter(jumpTarget.kind);
      }, [jumpTarget && jumpTarget.ts]);

      const notesQuery = useQuery({
        queryKey: MemoryNoteModel.queryKey(projectRoot, { query: searchQuery, kind: kindFilter }),
        queryFn: () => MemoryNoteModel.fetchList(projectRoot, { query: searchQuery, kind: kindFilter }),
        enabled: Boolean(projectRoot),
      });

      const governanceMutation = useMutation({
        mutationFn: (payload) => MemoryNoteModel.mutateGovernance({ projectRoot, ...payload }),
        onSuccess: (_data, variables) => {
          queryClient.invalidateQueries({ queryKey: ["pm-v2"] });
          if (notify) {
            notify("ดำเนินการ Governance (" + variables.action + ") สำเร็จ!", "success");
          }
        },
        onError: (err) => {
          if (notify) {
            notify("เกิดข้อผิดพลาด: " + (err && err.message ? err.message : String(err)), "error");
          }
        },
      });

      const items = (notesQuery.data && notesQuery.data.items) || [];
      const columns = useMemo(() => {
        const candidates = items.filter((n) => n.status === "candidate" || n.status === "provisional");
        const active = items.filter((n) => n.status === "verified" || n.status === "active");
        const stale = items.filter(
          (n) => n.status === "conflicted" || n.status === "expired" || n.status === "superseded"
        );
        return { candidates, active, stale };
      }, [items]);

      const createNote = useCallback(() => {
        if (!newTitle.trim() || !newSummary.trim()) {
          if (notify) notify("กรุณากรอกทั้งหัวข้อ (Title) และรายละเอียด (Summary)", "warning");
          return;
        }
        governanceMutation.mutate(
          {
            action: newKind,
            title: newTitle.trim(),
            summary: newSummary.trim(),
          },
          {
            onSuccess: () => {
              setNewTitle("");
              setNewSummary("");
            },
          }
        );
      }, [newKind, newTitle, newSummary, governanceMutation, notify]);

      return {
        searchQuery,
        setSearchQuery,
        kindFilter,
        setKindFilter,
        viewMode,
        setViewMode,
        newKind,
        setNewKind,
        newTitle,
        setNewTitle,
        newSummary,
        setNewSummary,
        notesQuery,
        items,
        columns,
        governanceMutation,
        createNote,
        promoteNote: (recordId) => governanceMutation.mutate({ action: "promote", recordId }),
        expireNote: (recordId) => governanceMutation.mutate({ action: "expire", recordId }),
        retractNote: (recordId) => governanceMutation.mutate({ action: "retract", recordId }),
        supersedeNote: (recordId, supersedingRecordId) =>
          governanceMutation.mutate({ action: "supersede", recordId, supersedingRecordId }),
      };
    }
  }

  class KnowledgeGraphController {
    static useController(projectRoot, jumpTarget) {
      const [kindFilter, setKindFilter] = useState(
        jumpTarget && jumpTarget.kind ? String(jumpTarget.kind) : "all"
      );
      const [sessionFilter, setSessionFilter] = useState(
        jumpTarget && jumpTarget.sessionId ? String(jumpTarget.sessionId) : "all"
      );
      const [selectedNodeId, setSelectedNodeId] = useState(
        jumpTarget && jumpTarget.nodeId ? String(jumpTarget.nodeId) : null
      );
      const [layoutMode, setLayoutMode] = useState("flow"); // "flow" | "orbital"
      const [searchQuery, setSearchQuery] = useState(
        jumpTarget && jumpTarget.query ? String(jumpTarget.query) : ""
      );
      const [zoom, setZoom] = useState(1); const [pan, setPan] = useState({ x: 0, y: 0 }); const dragRef = useRef(null);

      useEffect(() => {
        if (!jumpTarget) return;
        setKindFilter(jumpTarget.kind ? String(jumpTarget.kind) : "all");
        if (jumpTarget.nodeId) setSelectedNodeId(String(jumpTarget.nodeId));
        if (jumpTarget.sessionId) setSessionFilter(String(jumpTarget.sessionId));
        if (typeof jumpTarget.query === "string") setSearchQuery(jumpTarget.query);
      }, [jumpTarget && jumpTarget.ts]);

      const graphQuery = useQuery({
        queryKey: KnowledgeGraphModel.queryKey(projectRoot),
        queryFn: () => KnowledgeGraphModel.fetch(projectRoot),
        enabled: Boolean(projectRoot),
      });

      const layout = useMemo(() => {
        const data = graphQuery.data || { nodes: [], edges: [], stats: {}, causalTriads: [] };
        const rawNodes = data.nodes || [];
        const rawEdges = data.edges || [];
        const nodeById = new Map(rawNodes.map((n) => [n.id, n]));
        const sessionNodesList = rawNodes.filter((n) => n.kind === "session");

        let filteredNodes =
          kindFilter === "all" ? rawNodes : rawNodes.filter((n) => n.kind === kindFilter);

        if (searchQuery.trim()) {
          const q = searchQuery.trim().toLowerCase();
          filteredNodes = filteredNodes.filter(
            (n) =>
              String(n.label || "").toLowerCase().includes(q) ||
              String(n.summary || "").toLowerCase().includes(q) ||
              String(n.currentTask || "").toLowerCase().includes(q)
          );
        }

        if (sessionFilter !== "all") {
          const targetSessionNodeId = "session:" + sessionFilter;
          const noteIdsInSession = new Set(
            rawNodes
              .filter((n) => n.kind === "note" && n.sessionId === sessionFilter)
              .map((n) => n.id)
          );
          for (const e of rawEdges) {
            if (e.source === targetSessionNodeId && e.relation === "created-in-session") {
              noteIdsInSession.add(e.target);
            }
          }
          const connectedFileOrSym = new Set();
          for (const e of rawEdges) {
            if (noteIdsInSession.has(e.source)) connectedFileOrSym.add(e.target);
          }
          filteredNodes = filteredNodes.filter(
            (n) =>
              n.id === targetSessionNodeId ||
              noteIdsInSession.has(n.id) ||
              connectedFileOrSym.has(n.id)
          );
        }

        // Default selection: prefer a note node (which bridges Session -> Note -> File -> Symbol)
        const selectedNode =
          filteredNodes.find((n) => n.id === selectedNodeId) ||
          filteredNodes.find((n) => n.kind === "note") ||
          filteredNodes.find((n) => n.kind === "session") ||
          filteredNodes[0] ||
          null;

        // Compute multi-hop human story neighborhood for selectedNode
        const highlightedNodeIds = new Set();
        if (selectedNode) {
          highlightedNodeIds.add(selectedNode.id);
          if (selectedNode.kind === "note") {
            if (selectedNode.sessionId) {
              highlightedNodeIds.add("session:" + selectedNode.sessionId);
            }
            for (const e of rawEdges) {
              if (e.target === selectedNode.id) highlightedNodeIds.add(e.source);
              if (e.source === selectedNode.id) highlightedNodeIds.add(e.target);
            }
          } else if (selectedNode.kind === "session") {
            const noteIds = new Set();
            for (const e of rawEdges) {
              if (e.source === selectedNode.id || e.target === selectedNode.id) {
                highlightedNodeIds.add(e.source);
                highlightedNodeIds.add(e.target);
                if (e.target.startsWith("note:")) noteIds.add(e.target);
              }
            }
            for (const n of rawNodes) {
              if (n.kind === "note" && n.sessionId === selectedNode.sessionId) {
                highlightedNodeIds.add(n.id);
                noteIds.add(n.id);
              }
            }
            for (const e of rawEdges) {
              if (noteIds.has(e.source)) highlightedNodeIds.add(e.target);
            }
          } else if (selectedNode.kind === "file" || selectedNode.kind === "symbol") {
            const noteIds = new Set();
            for (const e of rawEdges) {
              if (e.target === selectedNode.id || e.source === selectedNode.id) {
                highlightedNodeIds.add(e.source);
                highlightedNodeIds.add(e.target);
                if (e.source.startsWith("note:")) noteIds.add(e.source);
              }
            }
            for (const nid of noteIds) {
              const noteNode = nodeById.get(nid);
              if (noteNode && noteNode.sessionId) {
                highlightedNodeIds.add("session:" + noteNode.sessionId);
              }
              for (const e of rawEdges) {
                if (e.target === nid) highlightedNodeIds.add(e.source); if (e.source === nid && ((selectedNode.kind === "file" && e.relation === "mentions-symbol") || (selectedNode.kind === "symbol" && e.relation === "touches-file"))) highlightedNodeIds.add(e.target);
              }
            }
          }
        }

        const relatedSessions = [];
        const relatedNotes = [];
        const relatedFiles = [];
        const relatedSymbols = [];
        for (const hid of highlightedNodeIds) {
          if (selectedNode && hid === selectedNode.id) continue;
          const item = nodeById.get(hid);
          if (!item) continue;
          if (item.kind === "session") relatedSessions.push(item);
          else if (item.kind === "note") relatedNotes.push(item);
          else if (item.kind === "file") relatedFiles.push(item);
          else if (item.kind === "symbol") relatedSymbols.push(item);
        }

        const sortHighlightedFirst = (arr) =>
          [...arr].sort((a, b) => {
            const aHi = highlightedNodeIds.has(a.id) ? 0 : 1;
            const bHi = highlightedNodeIds.has(b.id) ? 0 : 1;
            return aHi - bHi;
          });

        const sessionCol = filteredNodes.filter((n) => n.kind === "session");
        const noteCol = filteredNodes.filter((n) => n.kind === "note");
        const fileCol = filteredNodes.filter((n) => n.kind === "file");
        const symbolCol = filteredNodes.filter((n) => n.kind === "symbol");

        const width = 960;
        let height = 540;
        const positions = new Map();
        let visibleNodes = filteredNodes;

        if (layoutMode === "flow") {
          const maxPerCol = 14; const sliceCol = (arr) => { if (arr.length <= maxPerCol) return arr; const hi = arr.filter((n) => highlightedNodeIds.has(n.id)).slice(0, maxPerCol); const rest = arr.filter((n) => !highlightedNodeIds.has(n.id)).slice(0, Math.max(0, maxPerCol - hi.length)); const keep = new Set([...hi, ...rest].map((n) => n.id)); return arr.filter((n) => keep.has(n.id)).slice(0, maxPerCol); };
          const sVis = sliceCol(sessionCol);
          const nVis = sliceCol(noteCol);
          const fVis = sliceCol(fileCol);
          const symVis = sliceCol(symbolCol);
          visibleNodes = [...sVis, ...nVis, ...fVis, ...symVis];
          const maxRows = Math.max(sVis.length, nVis.length, fVis.length, symVis.length, 1);
          height = Math.max(500, maxRows * 44 + 76);

          const placeColumn = (colNodes, colX) => {
            const count = colNodes.length;
            if (count === 0) return;
            const topPad = 68;
            const usableH = height - topPad - 30;
            const step = count === 1 ? 0 : Math.min(46, usableH / (count - 1));
            const totalSpan = step * (count - 1);
            const startY = Math.round(topPad + (usableH - totalSpan) / 2);
            colNodes.forEach((n, idx) => {
              positions.set(n.id, {
                x: colX,
                y: Math.round(startY + idx * step),
              });
            });
          };

          placeColumn(sVis, 122);
          placeColumn(nVis, 368);
          placeColumn(fVis, 628);
          placeColumn(symVis, 852);
        } else {
          height = 560;
          const cx = width / 2;
          const cy = height / 2;
          const outerRing = [...fileCol, ...symbolCol];

          sessionCol.forEach((n, idx) => {
            const angle = (2 * Math.PI * idx) / Math.max(sessionCol.length, 1) - Math.PI / 2;
            const radius = sessionCol.length <= 1 ? 0 : 90;
            positions.set(n.id, {
              x: Math.round(cx + radius * Math.cos(angle)),
              y: Math.round(cy + radius * Math.sin(angle)),
            });
          });

          noteCol.forEach((n, idx) => {
            const angle = (2 * Math.PI * idx) / Math.max(noteCol.length, 1) - Math.PI / 2 + 0.2;
            const radius = 170;
            positions.set(n.id, {
              x: Math.round(cx + radius * Math.cos(angle)),
              y: Math.round(cy + radius * Math.sin(angle)),
            });
          });

          outerRing.forEach((n, idx) => {
            const angle = (2 * Math.PI * idx) / Math.max(outerRing.length, 1) - Math.PI / 2;
            const radius = n.kind === "file" ? 242 : 215;
            positions.set(n.id, {
              x: Math.round(cx + radius * Math.cos(angle)),
              y: Math.round(cy + radius * Math.sin(angle)),
            });
          });
        }

        const allowedIds = new Set(visibleNodes.map((n) => n.id));
        const filteredEdges = rawEdges.filter(
          (e) => allowedIds.has(e.source) && allowedIds.has(e.target)
        );

        const rawStats = data.stats || {};
        return {
          width,
          height,
          layoutMode,
          nodes: visibleNodes,
          totalFilteredCount: filteredNodes.length,
          edges: filteredEdges,
          sessionNodesList,
          selectedNode,
          highlightedNodeIds,
          selectedStory: {
            relatedSessions,
            relatedNotes,
            relatedFiles,
            relatedSymbols,
          },
          positions,
          causalTriads: data.causalTriads || [],
          stats: {
            sessionNodes:
              rawStats.sessionNodes ?? sessionNodesList.length ?? 0,
            noteNodes:
              rawStats.noteNodes ?? rawNodes.filter((n) => n.kind === "note").length ?? 0,
            fileNodes:
              rawStats.fileNodes ?? rawNodes.filter((n) => n.kind === "file").length ?? 0,
            symbolNodes:
              rawStats.symbolNodes ?? rawNodes.filter((n) => n.kind === "symbol").length ?? 0,
            edgeCount:
              rawStats.edgeCount ?? rawEdges.length ?? 0,
          },
        };
      }, [graphQuery.data, kindFilter, sessionFilter, selectedNodeId, layoutMode, searchQuery, zoom]);

      return {
        kindFilter,
        setKindFilter,
        sessionFilter,
        setSessionFilter,
        selectedNodeId,
        setSelectedNodeId,
        layoutMode,
        setLayoutMode,
        searchQuery,
        setSearchQuery,
        zoom,
        pan, setPan, dragRef, zoomIn: () => setZoom((z) => Math.min(2.8, Number((z + 0.25).toFixed(2)))),
        zoomOut: () => setZoom((z) => Math.max(0.55, Number((z - 0.25).toFixed(2)))),
        resetZoom: () => { setZoom(1); setPan({ x: 0, y: 0 }); }, focusNode: (nodeId) => { const tid = nodeId || (layout.selectedNode && layout.selectedNode.id); const pos = tid ? layout.positions.get(tid) : null; if (pos) { setZoom(1.75); setPan({ x: Math.round(pos.x - layout.width / 2), y: Math.round(pos.y - layout.height / 2) }); } },
        graphQuery,
        layout,
      };
    }
  }

  class CuratorController {
    static useController(projectRoot, notify) {
      const queryClient = useQueryClient();
      const [chatInput, setChatInput] = useState("");
      const [messages, setMessages] = useState([
        {
          id: "welcome",
          role: "ai",
          text: "สวัสดีครับ! ผมคือ AI Memory Curator Agent (React + TanStack MVC) พร้อมช่วยตรวจสอบคลังความจำ อนุมัติ Candidate ยุบรวมความจำซ้ำ และบันทึก ADR/Insight/Mistake ให้ทุกโปรเจกต์ครับ",
          tools: [],
        },
      ]);

      const auditQuery = useQuery({
        queryKey: CuratorModel.queryKey(projectRoot),
        queryFn: () => CuratorModel.fetchAudit(projectRoot),
        enabled: Boolean(projectRoot),
      });

      const autoCurateMutation = useMutation({
        mutationFn: () => CuratorModel.runAutoCurate(projectRoot),
        onSuccess: (data) => {
          queryClient.invalidateQueries({ queryKey: ["pm-v2"] });
          const summaryMsg =
            "AI Auto-Curate เสร็จสิ้น! อนุมัติ Candidate " +
            (data.promoted ? data.promoted.length : 0) +
            " รายการ, ยุบรวมความจำซ้ำ " +
            (data.superseded ? data.superseded.length : 0) +
            " รายการ, หมดอายุ (Expired) " +
            (data.expired ? data.expired.length : 0) +
            " รายการ (Health Score: " +
            data.beforeHealthScore +
            " → " +
            data.afterHealthScore +
            "/100)";
          const executedTools = [
            "memory_sessionStart",
            "memory_list",
            "memory_findDuplicates",
            "memory_checkStaleness",
          ];
          if (data.promoted && data.promoted.length > 0) executedTools.push("memory_promote");
          if (data.superseded && data.superseded.length > 0) executedTools.push("memory_supersede");
          if (data.expired && data.expired.length > 0) executedTools.push("memory_expire");
          executedTools.push("memory_sessionEnd");
          setMessages((prev) => [
            ...prev,
            {
              id: "ac-" + Date.now(),
              role: "ai",
              text: summaryMsg,
              tools: executedTools,
            },
          ]);
          if (notify) notify(summaryMsg, "success");
        },
      });

      const chatMutation = useMutation({
        mutationFn: (msg) => CuratorModel.sendChat(projectRoot, msg, true),
        onSuccess: (data) => {
          queryClient.invalidateQueries({ queryKey: ["pm-v2"] });
          setMessages((prev) => [
            ...prev,
            {
              id: "ai-" + Date.now(),
              role: "ai",
              text: data.reply || JSON.stringify(data),
              tools: data.executedTools || [],
            },
          ]);
        },
      });

      const sendMessage = useCallback(
        (overrideText) => {
          const text = (typeof overrideText === "string" ? overrideText : chatInput).trim();
          if (!text) return;
          setChatInput("");
          setMessages((prev) => [...prev, { id: "u-" + Date.now(), role: "user", text, tools: [] }]);
          chatMutation.mutate(text);
        },
        [chatInput, chatMutation]
      );

      return {
        chatInput,
        setChatInput,
        messages,
        auditQuery,
        autoCurateMutation,
        chatMutation,
        sendMessage,
        runAutoCurate: () => autoCurateMutation.mutate(),
      };
    }
  }

  class McpConsoleController {
    static useController(projectRoot, notify) {
      const queryClient = useQueryClient();
      const [selectedTool, setSelectedTool] = useState("memory_v2Status");
      const [rawArgs, setRawArgs] = useState("{}");
      const [output, setOutput] = useState("// เลือก MCP Tool และกด Run เพื่อดูผลลัพธ์ JSON");

      const invokeMutation = useMutation({
        mutationFn: ({ tool, args }) => McpToolModel.invokeTool(projectRoot, tool, args),
        onSuccess: (data) => {
          setOutput(JSON.stringify(data, null, 2));
          queryClient.invalidateQueries({ queryKey: ["pm-v2"] });
        },
        onError: (err) => {
          setOutput(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2));
        },
      });

      const executeTool = useCallback(() => {
        let parsed = {};
        try {
          parsed = JSON.parse(rawArgs || "{}");
        } catch (err) {
          if (notify) notify("JSON Arguments ไม่ถูกต้อง", "warning");
          return;
        }
        invokeMutation.mutate({ tool: selectedTool, args: parsed });
      }, [rawArgs, selectedTool, invokeMutation, notify]);

      return {
        selectedTool,
        setSelectedTool,
        rawArgs,
        setRawArgs,
        output,
        invokeMutation,
        executeTool,
      };
    }
  }

  global.PM_MVC_CONTROLLERS = {
    MissionControlController,
    KanbanController,
    KnowledgeGraphController,
    CuratorController,
    McpConsoleController,
    parseDeepLinkHash,
    writeDeepLinkHash,
  };
})(window);
`;
}
