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
    let items = await MemoryNoteModel.listEnrichedNotes(
      foundation,
      filters.query,
      100,
      projectRoot,
    );
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
    const note = await MemoryNoteModel.getNoteById(foundation, noteId, projectRoot);
    if (!note) {
      return {
        ok: false,
        error: "NOTE_NOT_FOUND",
        message: "ไม่พบข้อมูลความจำที่ระบุ",
        projectRoot,
        note: null,
      };
    }
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

  function writeDeepLinkHash(state, defaultProjectRoot, push = false) {
    if (typeof window === "undefined" || !window.history) return;
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
        if (push && typeof window.history.pushState === "function") {
          window.history.pushState(null, "", nextHash);
        } else if (typeof window.history.replaceState === "function") {
          window.history.replaceState(null, "", nextHash);
        }
      } catch (_e) {}
    }
  }

  function useDebouncedValue(value, delayMs = 250) {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
      if (Object.is(debounced, value)) return;
      const timer = setTimeout(() => {
        setDebounced(value);
      }, delayMs);
      return () => clearTimeout(timer);
    }, [value, delayMs]);
    return debounced;
  }

  function invalidateProjectQueries(queryClient, projectRoot) {
    if (!projectRoot) {
      queryClient.invalidateQueries({ queryKey: ["pm-v2"] });
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["pm-v2", "overview", projectRoot] });
    queryClient.invalidateQueries({ queryKey: ["pm-v2", "notes", projectRoot] });
    queryClient.invalidateQueries({ queryKey: ["pm-v2", "note-detail", projectRoot] });
    queryClient.invalidateQueries({ queryKey: ["pm-v2", "graph", projectRoot] });
    queryClient.invalidateQueries({ queryKey: ["pm-v2", "curator-audit", projectRoot] });
  }

  function readPersistedTheme() {
    try {
      if (typeof localStorage !== "undefined" && localStorage && typeof localStorage.getItem === "function") {
        const saved = localStorage.getItem("pm-v2-theme");
        if (saved === "light" || saved === "dark") return saved;
      }
    } catch (_e) {}
    return "dark";
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
    const [theme, setTheme] = useState(() => readPersistedTheme());
    const [showTechDetails, setShowTechDetails] = useState(false);

    useEffect(() => {
      if (typeof document !== "undefined" && document.documentElement) {
        document.documentElement.className = theme;
      }
      try {
        if (typeof localStorage !== "undefined" && localStorage && typeof localStorage.setItem === "function") {
          localStorage.setItem("pm-v2-theme", theme);
        }
      } catch (_e) {}
    }, [theme]);

    useEffect(() => {
      if (typeof window === "undefined" || !window.addEventListener) return;
      const onGlobalKeyDown = (e) => {
        if (!e || e.isComposing === true || e.keyCode === 229) return;
        const keyStr = String(e.key || "");
        const isCtrlK = (e.ctrlKey || e.metaKey) && keyStr.toLowerCase() === "k";
        const activeEl = typeof document !== "undefined" ? document.activeElement : null;
        const activeTag = activeEl && activeEl.tagName ? String(activeEl.tagName).toUpperCase() : "";
        const isEditableTarget =
          activeTag === "INPUT" ||
          activeTag === "TEXTAREA" ||
          activeTag === "SELECT" ||
          Boolean(activeEl && activeEl.isContentEditable);
        const isSlashShortcut =
          !e.ctrlKey && !e.metaKey && !e.altKey && keyStr === "/" && !isEditableTarget;
        if (isCtrlK || isSlashShortcut) {
          if (e.preventDefault) e.preventDefault();
          setInspectedRecordIdState(null);
          setActiveTabState("kanban");
          writeDeepLinkHash({ tab: "kanban", project: currentProject }, defaultProjectRoot, true);
          setTimeout(() => {
            if (typeof document !== "undefined" && document.getElementById) {
              const searchEl = document.getElementById("kanban-search-input");
              if (searchEl && typeof searchEl.focus === "function") searchEl.focus();
            }
          }, 20);
        }
      };
      window.addEventListener("keydown", onGlobalKeyDown);
      return () => window.removeEventListener("keydown", onGlobalKeyDown);
    }, [currentProject, defaultProjectRoot]);

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
        } else if (parsed.tab === "graph") {
          setGraphJumpTarget(null);
        }
        if (parsed.tab === "kanban" && (parsed.q || parsed.kind)) {
          setKanbanJumpTarget({ query: parsed.q || "", kind: parsed.kind || "", ts: Date.now() });
        } else if (parsed.tab === "kanban") {
          setKanbanJumpTarget(null);
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
          defaultProjectRoot,
          true
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
          defaultProjectRoot,
          false
        );
      },
      [activeTab, currentProject, defaultProjectRoot]
    );

    const closeInspectModal = useCallback(() => {
      setInspectedRecordIdState(null);
      writeDeepLinkHash({ tab: activeTab, project: currentProject, note: null }, defaultProjectRoot, false);
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
          defaultProjectRoot,
          true
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
          defaultProjectRoot,
          true
        );
      },
      [currentProject, defaultProjectRoot]
    );

    const toggleTheme = useCallback(() => {
      setTheme((prev) => (prev === "dark" ? "light" : "dark"));
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
      invalidateProjectQueries(queryClient, currentProject);
      queryClient.invalidateQueries({ queryKey: ProjectModel.queryKey() });
      notify("ซิงก์ข้อมูลคลังความจำเรียบร้อยแล้ว (Synced TanStack Query Cache)", "success");
    }, [queryClient, currentProject, notify]);

    const switchProject = useCallback(
      (nextProject) => {
        setCurrentProject(nextProject);
        setInspectedRecordIdState(null);
        writeDeepLinkHash({ tab: activeTab, project: nextProject }, defaultProjectRoot, true);
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
      const debouncedSearch = useDebouncedValue(searchQuery, 250);
      const [kindFilter, setKindFilter] = useState(
        jumpTarget && jumpTarget.kind ? String(jumpTarget.kind) : ""
      );
      const [viewMode, setViewMode] = useState("kanban"); // "kanban" | "table"
      const [newKind, setNewKind] = useState("writeADR");
      const [newTitle, setNewTitle] = useState("");
      const [newSummary, setNewSummary] = useState("");
      const [pendingConfirmAction, setPendingConfirmAction] = useState(null);

      useEffect(() => {
        if (!jumpTarget) return;
        if (typeof jumpTarget.query === "string") setSearchQuery(jumpTarget.query);
        if (typeof jumpTarget.kind === "string") setKindFilter(jumpTarget.kind);
      }, [jumpTarget && jumpTarget.ts]);

      const notesQuery = useQuery({
        queryKey: MemoryNoteModel.queryKey(projectRoot, { query: debouncedSearch, kind: kindFilter }),
        queryFn: ({ signal } = {}) =>
          MemoryNoteModel.fetchList(projectRoot, {
            query: debouncedSearch,
            kind: kindFilter,
            signal,
          }),
        enabled: Boolean(projectRoot),
      });

      const governanceMutation = useMutation({
        mutationFn: (payload) => MemoryNoteModel.mutateGovernance({ projectRoot, ...payload }),
        onSuccess: (_data, variables) => {
          invalidateProjectQueries(queryClient, projectRoot);
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

      const requestConfirm = useCallback((action, recordId, title = "") => {
        setPendingConfirmAction({
          action,
          recordId: String(recordId || ""),
          title: String(title || recordId || ""),
          reason: "",
        });
      }, []);

      const setConfirmReason = useCallback((reason) => {
        setPendingConfirmAction((prev) => (prev ? { ...prev, reason: String(reason || "") } : null));
      }, []);

      const cancelConfirmAction = useCallback(() => {
        setPendingConfirmAction(null);
      }, []);

      const confirmGovernanceAction = useCallback(() => {
        if (!pendingConfirmAction) return;
        const { action, recordId, reason } = pendingConfirmAction;
        const cleanReason = String(reason || "").trim();
        setPendingConfirmAction(null);
        governanceMutation.mutate({
          action,
          recordId,
          ...(cleanReason ? { reason: cleanReason } : {}),
        });
      }, [pendingConfirmAction, governanceMutation]);

      return {
        searchQuery,
        setSearchQuery,
        debouncedSearch,
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
        pendingConfirmAction,
        setConfirmReason,
        cancelConfirmAction,
        confirmGovernanceAction,
        promoteNote: (recordId) => governanceMutation.mutate({ action: "promote", recordId }),
        expireNote: (recordId, title) => requestConfirm("expire", recordId, title),
        retractNote: (recordId, title) => requestConfirm("retract", recordId, title),
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
      const [zoom, setZoom] = useState(1); const [pan, setPan] = useState({ x: 0, y: 0 }); const [hoveredNodeId, setHoveredNodeId] = useState(null); const dragRef = useRef(null); const wasDraggingRef = useRef(false); const lastClickRef = useRef({ id: null, ts: 0 });

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
          const sliceOrbital = (arr, cap) => {
            if (arr.length <= cap) return arr;
            const priority = arr
              .filter((n) => (selectedNode && n.id === selectedNode.id) || highlightedNodeIds.has(n.id))
              .slice(0, cap);
            const rest = arr
              .filter((n) => !((selectedNode && n.id === selectedNode.id) || highlightedNodeIds.has(n.id)))
              .slice(0, Math.max(0, cap - priority.length));
            const keep = new Set([...priority, ...rest].map((n) => n.id));
            return arr.filter((n) => keep.has(n.id)).slice(0, cap);
          };
          const sOrb = sliceOrbital(sessionCol, 12);
          const nOrb = sliceOrbital(noteCol, 16);
          const fOrb = sliceOrbital(fileCol, 14);
          const symOrb = sliceOrbital(symbolCol, 14);
          visibleNodes = [...sOrb, ...nOrb, ...fOrb, ...symOrb];
          const outerRing = [...fOrb, ...symOrb];

          sOrb.forEach((n, idx) => {
            const angle = (2 * Math.PI * idx) / Math.max(sOrb.length, 1) - Math.PI / 2;
            const radius = sOrb.length <= 1 ? 0 : 90;
            positions.set(n.id, {
              x: Math.round(cx + radius * Math.cos(angle)),
              y: Math.round(cy + radius * Math.sin(angle)),
              angle,
            });
          });

          nOrb.forEach((n, idx) => {
            const angle = (2 * Math.PI * idx) / Math.max(nOrb.length, 1) - Math.PI / 2 + 0.2;
            const radius = 170;
            positions.set(n.id, {
              x: Math.round(cx + radius * Math.cos(angle)),
              y: Math.round(cy + radius * Math.sin(angle)),
              angle,
            });
          });

          outerRing.forEach((n, idx) => {
            const angle = (2 * Math.PI * idx) / Math.max(outerRing.length, 1) - Math.PI / 2;
            const radius = n.kind === "file" ? 242 : 215;
            positions.set(n.id, {
              x: Math.round(cx + radius * Math.cos(angle)),
              y: Math.round(cy + radius * Math.sin(angle)),
              angle,
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
          hiddenNodeCount: Math.max(0, filteredNodes.length - visibleNodes.length),
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
      }, [graphQuery.data, kindFilter, sessionFilter, selectedNodeId, layoutMode, searchQuery]);

      const focusNode = (nodeId) => {
        const tid = nodeId || (layout.selectedNode && layout.selectedNode.id);
        const pos = tid ? layout.positions.get(tid) : null;
        if (pos) {
          setZoom(1.75);
          setPan({ x: Math.round(pos.x - layout.width / 2), y: Math.round(pos.y - layout.height / 2) });
        }
      };

      const activateNode = (node, onInspect) => {
        if (!node || wasDraggingRef.current) {
          wasDraggingRef.current = false;
          return;
        }
        const now = Date.now();
        const isDouble =
          lastClickRef.current &&
          lastClickRef.current.id === node.id &&
          now - lastClickRef.current.ts < 400;
        lastClickRef.current = { id: node.id, ts: isDouble ? 0 : now };
        setSelectedNodeId(node.id);
        if (isDouble) {
          focusNode(node.id);
          if (node.kind === "note" && node.recordId && typeof onInspect === "function") {
            onInspect(node.recordId);
          }
        }
      };

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
        hoveredNodeId,
        setHoveredNodeId,
        zoom,
        pan, setPan, dragRef, wasDraggingRef, activateNode, zoomIn: () => setZoom((z) => Math.min(2.8, Number((z + 0.25).toFixed(2)))),
        zoomOut: () => setZoom((z) => Math.max(0.55, Number((z - 0.25).toFixed(2)))),
        resetZoom: () => { setZoom(1); setPan({ x: 0, y: 0 }); }, focusNode,
        graphQuery,
        layout,
      };
    }
  }

  class CuratorController {
    static useController(projectRoot, notify) {
      const queryClient = useQueryClient();
      const [chatInput, setChatInput] = useState("");
      const [autoExecute, setAutoExecute] = useState(true);
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
          const didMutate =
            (data.promoted && data.promoted.length > 0) ||
            (data.superseded && data.superseded.length > 0) ||
            (data.expired && data.expired.length > 0);
          if (didMutate) {
            invalidateProjectQueries(queryClient, projectRoot);
          }
          const summaryMsg = didMutate
            ? "AI Auto-Curate เสร็จสิ้น! อนุมัติ Candidate " +
              (data.promoted ? data.promoted.length : 0) +
              " รายการ, ยุบรวมความจำซ้ำ " +
              (data.superseded ? data.superseded.length : 0) +
              " รายการ, หมดอายุ (Expired) " +
              (data.expired ? data.expired.length : 0) +
              " รายการ (Health Score: " +
              data.beforeHealthScore +
              " → " +
              data.afterHealthScore +
              "/100)"
            : "คลังความจำสะอาดอยู่แล้ว (ไม่มีรายการรออนุมัติหรือซ้ำซ้อน) ไม่จำเป็นต้องเปิดเซสชันใหม่ (Health Score: " +
              data.afterHealthScore +
              "/100)";
          const executedTools = didMutate
            ? [
                "memory_sessionStart",
                "memory_list",
                "memory_findDuplicates",
                "memory_checkStaleness",
                ...(data.promoted && data.promoted.length > 0 ? ["memory_promote"] : []),
                ...(data.superseded && data.superseded.length > 0 ? ["memory_supersede"] : []),
                ...(data.expired && data.expired.length > 0 ? ["memory_expire"] : []),
                "memory_sessionEnd",
              ]
            : ["memory_list", "memory_findDuplicates", "memory_checkStaleness"];
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
        onError: (err) => {
          const errMsg = "AI Auto-Curate ล้มเหลว: " + (err && err.message ? err.message : String(err));
          setMessages((prev) => [
            ...prev,
            { id: "err-" + Date.now(), role: "ai", text: errMsg, tools: [] },
          ]);
          if (notify) notify(errMsg, "error");
        },
      });

      const chatMutation = useMutation({
        mutationFn: ({ msg, exec }) => CuratorModel.sendChat(projectRoot, msg, exec),
        onSuccess: (data) => {
          if (
            data &&
            (data.intent === "write_adr" ||
              data.intent === "write_insight" ||
              data.intent === "write_mistake" ||
              data.intent === "auto_curate")
          ) {
            invalidateProjectQueries(queryClient, projectRoot);
          }
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
        onError: (err) => {
          const errMsg = "ส่งคำสั่งไม่สำเร็จ: " + (err && err.message ? err.message : String(err));
          setMessages((prev) => [
            ...prev,
            { id: "err-" + Date.now(), role: "ai", text: errMsg, tools: [] },
          ]);
          if (notify) notify(errMsg, "error");
        },
      });

      const sendMessage = useCallback(
        (overrideText) => {
          const text = (typeof overrideText === "string" ? overrideText : chatInput).trim();
          if (!text) return;
          setChatInput("");
          setMessages((prev) => [...prev, { id: "u-" + Date.now(), role: "user", text, tools: [] }]);
          chatMutation.mutate({ msg: text, exec: autoExecute });
        },
        [chatInput, autoExecute, chatMutation]
      );

      return {
        chatInput,
        setChatInput,
        autoExecute,
        setAutoExecute,
        messages,
        auditQuery,
        autoCurateMutation,
        chatMutation,
        sendMessage,
        runAutoCurate: () => autoCurateMutation.mutate(),
      };
    }
  }

  function defaultValueForSchemaProp(k, p) {
    if (!p || typeof p !== "object") return "";
    if (p.default !== undefined) return p.default;
    if (Array.isArray(p.enum) && p.enum.length > 0) return p.enum[0];
    if (p.type === "number" || p.type === "integer") {
      return k === "limit" ? 10 : k === "staleAfterDays" ? 30 : 0;
    }
    if (p.type === "boolean") return true;
    if (p.type === "array") return [];
    if (p.type === "object") return {};
    return "";
  }

  function buildToolStarterJson(toolDef) {
    const schema = toolDef && toolDef.inputSchema;
    const props = schema && schema.properties;
    if (!props || typeof props !== "object") return "{}";
    const keys = Object.keys(props);
    if (keys.length === 0) return "{}";
    const requiredSet = new Set(Array.isArray(schema.required) ? schema.required : []);
    const template = {};
    let optionalAdded = 0;
    for (const k of keys) {
      const p = props[k] || {};
      const desc = String(p.description || "");
      const isReq = requiredSet.has(k);
      if (!isReq) {
        if (k === "sessionId" || k === "projectRoot" || k === "workspaceRoot" || k === "workflowId") {
          continue;
        }
        if (/\\balias\\b/iu.test(desc)) {
          continue;
        }
        if (optionalAdded >= 3) continue;
        optionalAdded += 1;
      }
      template[k] = defaultValueForSchemaProp(k, p);
    }
    return Object.keys(template).length === 0 ? "{}" : JSON.stringify(template, null, 2);
  }

  class McpConsoleController {
    static useController(projectRoot, notify, toolsMeta = []) {
      const queryClient = useQueryClient();
      const [selectedTool, setSelectedToolState] = useState("memory_v2Status");
      const [rawArgs, setRawArgs] = useState("{}");
      const [output, setOutput] = useState("// เลือก MCP Tool และกด Run เพื่อดูผลลัพธ์ JSON");
      const [pendingDestructiveArgs, setPendingDestructiveArgs] = useState(null);

      const toolByName = useMemo(() => {
        const m = new Map();
        (toolsMeta || []).forEach((t) => {
          if (t && t.name) m.set(t.name, t);
        });
        return m;
      }, [toolsMeta]);

      const currentToolMeta = toolByName.get(selectedTool) || null;

      const setSelectedTool = useCallback(
        (nextTool) => {
          const name = String(nextTool || "");
          setSelectedToolState(name);
          setPendingDestructiveArgs(null);
          const meta = toolByName.get(name);
          setRawArgs(buildToolStarterJson(meta));
        },
        [toolByName]
      );

      const resetTemplate = useCallback(() => {
        setRawArgs(buildToolStarterJson(currentToolMeta));
      }, [currentToolMeta]);

      const insertParam = useCallback(
        (paramKey) => {
          if (!paramKey) return;
          const schemaProps =
            (currentToolMeta && currentToolMeta.inputSchema && currentToolMeta.inputSchema.properties) || {};
          let parsed = {};
          try {
            const candidate = JSON.parse(rawArgs || "{}");
            if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
              parsed = { ...candidate };
            }
          } catch (_e) {
            parsed = {};
          }
          if (!(paramKey in parsed)) {
            parsed[paramKey] = defaultValueForSchemaProp(paramKey, schemaProps[paramKey]);
          }
          setRawArgs(JSON.stringify(parsed, null, 2));
        },
        [currentToolMeta, rawArgs]
      );

      const invokeMutation = useMutation({
        mutationFn: ({ tool, args }) => McpToolModel.invokeTool(projectRoot, tool, args),
        onSuccess: (data, variables) => {
          setOutput(JSON.stringify(data, null, 2));
          const meta = toolByName.get(variables && variables.tool);
          const isReadOnly = Boolean(meta && meta.annotations && meta.annotations.readOnlyHint === true);
          if (!isReadOnly) {
            invalidateProjectQueries(queryClient, projectRoot);
          }
        },
        onError: (err) => {
          setOutput(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2));
          if (notify) {
            notify("รันคำสั่ง MCP ไม่สำเร็จ: " + String(err && err.message ? err.message : err), "error");
          }
        },
      });

      const executeTool = useCallback(
        (forceConfirmed = false) => {
          let parsed = {};
          try {
            parsed = JSON.parse(rawArgs || "{}");
          } catch (_err) {
            if (notify) notify("JSON Arguments ไม่ถูกต้อง", "warning");
            return;
          }
          const isDestructive = Boolean(
            currentToolMeta &&
              currentToolMeta.annotations &&
              currentToolMeta.annotations.destructiveHint === true
          );
          if (isDestructive && forceConfirmed !== true) {
            setPendingDestructiveArgs(parsed);
            return;
          }
          setPendingDestructiveArgs(null);
          invokeMutation.mutate({ tool: selectedTool, args: parsed });
        },
        [rawArgs, selectedTool, currentToolMeta, invokeMutation, notify]
      );

      const confirmDestructiveExecution = useCallback(() => {
        if (!pendingDestructiveArgs) return;
        const args = pendingDestructiveArgs;
        setPendingDestructiveArgs(null);
        invokeMutation.mutate({ tool: selectedTool, args });
      }, [pendingDestructiveArgs, selectedTool, invokeMutation]);

      const cancelDestructiveExecution = useCallback(() => {
        setPendingDestructiveArgs(null);
      }, []);

      return {
        selectedTool,
        setSelectedTool,
        currentToolMeta,
        resetTemplate,
        insertParam,
        rawArgs,
        setRawArgs,
        output,
        invokeMutation,
        executeTool,
        pendingDestructiveArgs,
        confirmDestructiveExecution,
        cancelDestructiveExecution,
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
