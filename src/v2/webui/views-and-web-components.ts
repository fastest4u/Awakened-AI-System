import { V2_PUBLIC_TOOL_DEFINITIONS } from "../public-tools.js";
import { renderShadcnThemeCss } from "./shadcn-ui.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

export function renderMvcViewsJs(): string {
  const toolOptionsJson = JSON.stringify(
    V2_PUBLIC_TOOL_DEFINITIONS.map((t) => ({ name: t.name, description: t.description })),
  );

  return `// ============================================================================
// Project Memory V2 WebUI — Minimalist Pro React MVC Views & Interactive Charts
// Endpoint: /mvc/views.js
// Views:
//   - HealthGaugeChart (<pm-health-gauge>)
//   - DistributionDonutChart (<pm-distribution-chart>)
//   - ActivityAreaChart (<pm-activity-chart>)
//   - OverviewView (<pm-overview-panel>)
//   - KanbanBoardView (<pm-kanban-board>)
//   - KnowledgeGraphView (<pm-knowledge-graph>)
//   - CuratorStudioView (<pm-curator-studio>)
//   - McpConsoleView (<pm-mcp-console>)
//   - MissionControlShellView (<pm-mission-control>)
// ============================================================================
(function (global) {
  const { h, useState, useMemo } = global.React;
  const { useReactTable, getCoreRowModel, getFilteredRowModel, getSortedRowModel, flexRender } =
    global.TanStackTable;
  const {
    LucideIcon,
    Button,
    Card,
    CardHeader,
    CardTitle,
    CardDescription,
    CardContent,
    CardFooter,
    Badge,
    Input,
    Textarea,
    Select,
    Tabs,
    TabsList,
    TabsTrigger,
    Table,
    TableHeader,
    TableBody,
    TableRow,
    TableHead,
    TableCell,
    Alert,
    AlertTitle,
    AlertDescription,
    Progress,
    Dialog,
    Separator,
  } = global.ShadcnUI;
  const {
    MissionControlController,
    KanbanController,
    KnowledgeGraphController,
    CuratorController,
    McpConsoleController,
  } = global.PM_MVC_CONTROLLERS;

  const MCP_TOOLS_LIST = ${toolOptionsJson};

  function statusBadgeVariant(status) {
    if (status === "verified" || status === "active" || status === "healthy") return "success";
    if (status === "candidate" || status === "provisional") return "warning";
    if (status === "conflicted" || status === "expired" || status === "retracted") return "destructive";
    return "default";
  }

  // --------------------------------------------------------------------------
  // Chart 1: HealthGaugeChart (Radial SVG Gauge Web Component View)
  // --------------------------------------------------------------------------
  function HealthGaugeChart({ score = 100, verified = 0, candidates = 0, conflicts = 0 }) {
    const numScore = Math.max(0, Math.min(100, Number(score) || 0));
    const radius = 58;
    const circumference = 2 * Math.PI * radius;
    const dashOffset = circumference - (numScore / 100) * circumference;
    const strokeColor = numScore >= 85 ? "#10b981" : numScore >= 65 ? "#f59e0b" : "#ef4444";
    const statusText = numScore >= 85 ? "สมบูรณ์ดีเยี่ยม (Healthy)" : numScore >= 65 ? "ควรตรวจสอบ (Fair)" : "ต้องแก้ไขด่วน (Action Needed)";

    return h(
      Card,
      {},
      h(
        CardHeader,
        {},
        h(
          "div",
          { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
          h(
            CardTitle,
            {},
            h(LucideIcon, { name: "gauge", size: 17, color: "#6366f1" }),
            "สุขภาพคลังความจำ (Health Gauge)"
          ),
          h(Badge, { variant: numScore >= 85 ? "success" : "warning" }, statusText)
        ),
        h(CardDescription, {}, "ดัชนีความพร้อมและความน่าเชื่อถือของความจำในโปรเจกต์")
      ),
      h(
        CardContent,
        {},
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "1.5rem", flexWrap: "wrap" } },
          h(
            "svg",
            { width: "148", height: "148", viewBox: "0 0 148 148" },
            h("circle", {
              cx: "74",
              cy: "74",
              r: String(radius),
              fill: "none",
              stroke: "hsl(var(--secondary))",
              "stroke-width": "12",
            }),
            h("circle", {
              cx: "74",
              cy: "74",
              r: String(radius),
              fill: "none",
              stroke: strokeColor,
              "stroke-width": "12",
              "stroke-linecap": "round",
              "stroke-dasharray": String(circumference),
              "stroke-dashoffset": String(dashOffset),
              transform: "rotate(-90 74 74)",
            }),
            h(
              "text",
              {
                x: "74",
                y: "70",
                "text-anchor": "middle",
                fill: "hsl(var(--foreground))",
                "font-size": "26",
                "font-weight": "800",
              },
              String(numScore)
            ),
            h(
              "text",
              {
                x: "74",
                y: "92",
                "text-anchor": "middle",
                fill: "hsl(var(--muted-foreground))",
                "font-size": "11",
              },
              "คะแนนเต็ม 100"
            )
          ),
          h(
            "div",
            { style: { flex: 1, display: "flex", flexDirection: "column", gap: "0.6rem", minWidth: "150px" } },
            h(
              "div",
              {},
              h(
                "div",
                { style: { display: "flex", justifyContent: "space-between", fontSize: "0.78rem", marginBottom: "0.2rem" } },
                h("span", {}, "Verified (ยืนยันแล้ว)"),
                h("strong", { style: { color: "#10b981" } }, String(verified))
              ),
              h(Progress, { value: Math.min(100, Number(verified) * 20), color: "#10b981" })
            ),
            h(
              "div",
              {},
              h(
                "div",
                { style: { display: "flex", justifyContent: "space-between", fontSize: "0.78rem", marginBottom: "0.2rem" } },
                h("span", {}, "Candidates (รออนุมัติ)"),
                h("strong", { style: { color: "#f59e0b" } }, String(candidates))
              ),
              h(Progress, { value: Math.min(100, Number(candidates) * 20), color: "#f59e0b" })
            ),
            h(
              "div",
              {},
              h(
                "div",
                { style: { display: "flex", justifyContent: "space-between", fontSize: "0.78rem", marginBottom: "0.2rem" } },
                h("span", {}, "Conflicts (ขัดแย้ง/ซ้ำ)"),
                h("strong", { style: { color: "#ef4444" } }, String(conflicts))
              ),
              h(Progress, { value: Math.min(100, Number(conflicts) * 25), color: "#ef4444" })
            )
          )
        )
      )
    );
  }

  // --------------------------------------------------------------------------
  // Chart 2: DistributionDonutChart (Memory Kind Breakdown Chart)
  // --------------------------------------------------------------------------
  function DistributionDonutChart({ adr = 0, insight = 0, mistake = 0, sessionLog = 0 }) {
    const nAdr = Number(adr) || 0;
    const nIns = Number(insight) || 0;
    const nMis = Number(mistake) || 0;
    const nSes = Number(sessionLog) || 0;
    const total = Math.max(1, nAdr + nIns + nMis + nSes);

    const items = [
      { icon: "landmark", label: "ADR (การตัดสินใจ)", count: nAdr, color: "#6366f1", pct: Math.round((nAdr / total) * 100) },
      { icon: "lightbulb", label: "Insight (บทเรียน)", count: nIns, color: "#10b981", pct: Math.round((nIns / total) * 100) },
      { icon: "alert-triangle", label: "Mistake (ข้อควรระวัง)", count: nMis, color: "#f59e0b", pct: Math.round((nMis / total) * 100) },
      { icon: "file-text", label: "Session Log (ประวัติ)", count: nSes, color: "#38bdf8", pct: Math.round((nSes / total) * 100) },
    ];

    return h(
      Card,
      {},
      h(
        CardHeader,
        {},
        h(
          "div",
          { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
          h(
            CardTitle,
            {},
            h(LucideIcon, { name: "pie-chart", size: 17, color: "#10b981" }),
            "สัดส่วนประเภทความจำ (Distribution)"
          ),
          h(Badge, { variant: "secondary" }, "รวม " + (nAdr + nIns + nMis + nSes) + " รายการ")
        ),
        h(CardDescription, {}, "แยกตามหมวดหมู่ ADR, Insight, Mistake และ Session Log")
      ),
      h(
        CardContent,
        {},
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "0.7rem" } },
          items.map((it) =>
            h(
              "div",
              { key: it.label },
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: "0.8rem",
                    marginBottom: "0.25rem",
                  },
                },
                h(
                  "span",
                  { style: { display: "inline-flex", alignItems: "center", gap: "0.38rem" } },
                  h(LucideIcon, { name: it.icon, size: 14, color: it.color }),
                  it.label
                ),
                h(
                  "span",
                  { style: { color: "hsl(var(--muted-foreground))", fontWeight: 600 } },
                  it.count + " (" + it.pct + "%)"
                )
              ),
              h(Progress, { value: Math.max(it.count > 0 ? 8 : 0, it.pct), color: it.color })
            )
          )
        )
      )
    );
  }

  // --------------------------------------------------------------------------
  // Chart 3: ActivityAreaChart (SVG Area + Column Trend Chart)
  // --------------------------------------------------------------------------
  function ActivityAreaChart({ seriesJson = "[]" }) {
    let series = [];
    try {
      series = typeof seriesJson === "string" ? JSON.parse(seriesJson) : seriesJson || [];
    } catch (_e) {
      series = [];
    }
    if (!Array.isArray(series) || series.length === 0) {
      series = [
        { label: "S-4", notes: 1, verified: 1 },
        { label: "S-3", notes: 2, verified: 1 },
        { label: "S-2", notes: 3, verified: 2 },
        { label: "S-1", notes: 4, verified: 3 },
        { label: "Now", notes: 5, verified: 4 },
      ];
    }

    const width = 360;
    const height = 155;
    const padX = 28;
    const padY = 22;
    const maxVal = Math.max(4, ...series.map((d) => Math.max(Number(d.notes) || 0, Number(d.verified) || 0)));
    const stepX = series.length > 1 ? (width - padX * 2) / (series.length - 1) : width - padX * 2;

    const points = series.map((d, idx) => {
      const x = Math.round(padX + idx * stepX);
      const yNotes = Math.round(height - padY - ((Number(d.notes) || 0) / maxVal) * (height - padY * 2));
      const yVer = Math.round(height - padY - ((Number(d.verified) || 0) / maxVal) * (height - padY * 2));
      return { x, yNotes, yVer, label: d.label, notes: d.notes, verified: d.verified };
    });

    const linePath = points.map((p, i) => (i === 0 ? "M " + p.x + " " + p.yNotes : "L " + p.x + " " + p.yNotes)).join(" ");
    const areaPath =
      linePath +
      " L " +
      points[points.length - 1].x +
      " " +
      (height - padY) +
      " L " +
      points[0].x +
      " " +
      (height - padY) +
      " Z";

    return h(
      Card,
      {},
      h(
        CardHeader,
        {},
        h(
          "div",
          { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
          h(
            CardTitle,
            {},
            h(LucideIcon, { name: "trending-up", size: 17, color: "#6366f1" }),
            "แนวโน้มการเติบโตของความจำ (Activity Trend)"
          ),
          h(Badge, { variant: "default" }, "Real-time")
        ),
        h(CardDescription, {}, "กราฟแสดงจำนวนความจำสะสม (สีม่วง) และที่ยืนยันแล้ว (แท่งสีเขียว)")
      ),
      h(
        CardContent,
        {},
        h(
          "svg",
          { viewBox: "0 0 " + width + " " + height, style: { width: "100%", height: "155px", overflow: "visible" } },
          h(
            "defs",
            {},
            h(
              "linearGradient",
              { id: "pmAreaGrad", x1: "0", y1: "0", x2: "0", y2: "1" },
              h("stop", { offset: "0%", "stop-color": "#6366f1", "stop-opacity": "0.42" }),
              h("stop", { offset: "100%", "stop-color": "#6366f1", "stop-opacity": "0.0" })
            )
          ),
          h("path", { d: areaPath, fill: "url(#pmAreaGrad)" }),
          h("path", { d: linePath, fill: "none", stroke: "#6366f1", "stroke-width": "2.5" }),
          points.map((p, idx) =>
            h(
              "g",
              { key: idx },
              h("rect", {
                x: p.x - 6,
                y: p.yVer,
                width: "12",
                height: Math.max(3, height - padY - p.yVer),
                rx: "3",
                fill: "#10b981",
                opacity: "0.75",
              }),
              h("circle", { cx: p.x, cy: p.yNotes, r: "4", fill: "#6366f1" }),
              h(
                "text",
                {
                  x: p.x,
                  y: height - 4,
                  "text-anchor": "middle",
                  fill: "hsl(var(--muted-foreground))",
                  "font-size": "10",
                },
                String(p.label)
              )
            )
          )
        )
      )
    );
  }

  // --------------------------------------------------------------------------
  // Chart 4: SessionActivityMap (Live AI Session <-> Memory Relationship Map)
  // --------------------------------------------------------------------------
  function SessionActivityMap({ sessionsJson = "[]" }) {
    const mc = MissionControlController.useMissionControl();
    let sessions = [];
    try {
      sessions = typeof sessionsJson === "string" ? JSON.parse(sessionsJson) : sessionsJson || [];
    } catch (_e) {
      sessions = [];
    }
    if (!Array.isArray(sessions)) sessions = [];

    return h(
      Card,
      {},
      h(
        CardHeader,
        {},
        h(
          "div",
          { style: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" } },
          h(
            "div",
            {},
            h(
              CardTitle,
              {},
              h(LucideIcon, { name: "cpu", size: 17, color: "#38bdf8" }),
              "แผนผังความสัมพันธ์แต่ละเซสชัน & ความจำ (AI Session Activity & Memory Map)"
            ),
            h(
              CardDescription,
              {},
              "แสดงว่าในแต่ละเซสชัน (Session) AI กำลังทำอะไรอยู่ แก้ไขไฟล์ไหน และสร้างความจำ (Memory Note) อะไรไว้บ้าง"
            )
          ),
          h(
            Button,
            { variant: "secondary", size: "sm", onClick: () => mc && mc.setActiveTab("graph") },
            h(LucideIcon, { name: "network", size: 14, color: "#38bdf8" }),
            "เปิดกราฟความสัมพันธ์เต็มรูปแบบ",
            h(LucideIcon, { name: "arrow-right", size: 13 })
          )
        )
      ),
      h(
        CardContent,
        {},
        sessions.length === 0
          ? h(
              Alert,
              {},
              h(AlertTitle, {}, "ยังไม่มีเซสชันที่บันทึกไว้ในโปรเจกต์นี้"),
              h(AlertDescription, {}, "เมื่อ AI Agent เริ่มทำงานด้วย memory_sessionStart ระบบจะแสดงความสัมพันธ์ของเซสชันและความจำที่นี่อัตโนมัติ")
            )
          : h(
              "div",
              { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "0.85rem" } },
              sessions.slice(0, 6).map((s) => {
                const isActive = s.semanticState === "active";
                const noteTitles = Array.isArray(s.noteTitles) ? s.noteTitles : [];
                const noteIds = Array.isArray(s.noteIds) ? s.noteIds : [];
                const inProgress = Array.isArray(s.inProgressItems) ? s.inProgressItems : [];
                const filesTouched = Array.isArray(s.filesTouched) ? s.filesTouched : [];
                return h(
                  "div",
                  {
                    key: s.sessionId,
                    style: {
                      padding: "0.95rem",
                      borderRadius: "var(--radius)",
                      background: "hsl(var(--background))",
                      border: isActive
                        ? "1px solid rgba(16, 185, 129, 0.5)"
                        : "1px solid hsl(var(--border))",
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.55rem",
                    },
                  },
                  h(
                    "div",
                    { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.4rem" } },
                    h(
                      "div",
                      { style: { display: "flex", alignItems: "center", gap: "0.4rem" } },
                      h(
                        Badge,
                        { variant: isActive ? "success" : "secondary" },
                        h(LucideIcon, { name: isActive ? "activity" : "check-circle-2", size: 11 }),
                        isActive ? "AI กำลังทำงาน (Active)" : "เสร็จสิ้น (Ended)"
                      ),
                      h(
                        Badge,
                        { variant: "outline" },
                        h(LucideIcon, { name: s.kind === "child" ? "git-branch" : "shield-check", size: 11 }),
                        s.kind === "child" ? "Subagent" : "Root Agent"
                      )
                    ),
                    h(
                      "code",
                      { style: { fontSize: "0.72rem", color: "hsl(var(--muted-foreground))" } },
                      "#" + String(s.sessionId || "").slice(0, 8)
                    )
                  ),
                  h(
                    "div",
                    {
                      style: {
                        display: "flex",
                        alignItems: "center",
                        gap: "0.4rem",
                        fontSize: "0.86rem",
                        fontWeight: 700,
                        color: "hsl(var(--foreground))",
                      },
                    },
                    h(LucideIcon, { name: "bot", size: 15, color: "#38bdf8" }),
                    "AI กำลังทำ: " + String(s.currentTask || "ประมวลผลและดูแลคลังความจำ")
                  ),
                  inProgress.length > 0
                    ? h(
                        "div",
                        {
                          style: {
                            display: "flex",
                            alignItems: "center",
                            gap: "0.35rem",
                            fontSize: "0.75rem",
                            color: "hsl(var(--muted-foreground))",
                          },
                        },
                        h(LucideIcon, { name: "clock", size: 12 }),
                        "งานย่อย: " + inProgress.slice(0, 2).join(" • ")
                      )
                    : null,
                  h(
                    "div",
                    { style: { display: "flex", flexDirection: "column", gap: "0.3rem", marginTop: "0.15rem" } },
                    h(
                      "span",
                      {
                        style: {
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.35rem",
                          fontSize: "0.73rem",
                          color: "hsl(var(--muted-foreground))",
                          fontWeight: 600,
                        },
                      },
                      h(LucideIcon, { name: "layers", size: 13, color: "#6366f1" }),
                      "ความจำที่เชื่อมโยงกับเซสชันนี้ (" + (s.noteCount || noteTitles.length || 0) + " รายการ):"
                    ),
                    noteTitles.length === 0
                      ? h(
                          "span",
                          { style: { fontSize: "0.73rem", color: "hsl(var(--muted-foreground))" } },
                          "ยังไม่มีความจำใหม่ในเซสชันนี้"
                        )
                      : h(
                          "div",
                          { style: { display: "flex", flexWrap: "wrap", gap: "0.3rem" } },
                          noteTitles.slice(0, 5).map((title, idx) => {
                            const nid = noteIds[idx];
                            return h(
                              "button",
                              {
                                key: (nid || title) + idx,
                                onClick: () => {
                                  if (nid && mc) mc.inspectNote(nid);
                                },
                                style: {
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "0.3rem",
                                  cursor: nid ? "pointer" : "default",
                                  background: "hsla(var(--primary), 0.14)",
                                  color: "hsl(var(--foreground))",
                                  border: "1px solid hsla(var(--primary), 0.35)",
                                  borderRadius: "9999px",
                                  padding: "0.18rem 0.55rem",
                                  fontSize: "0.72rem",
                                  fontWeight: 500,
                                },
                              },
                              h(LucideIcon, { name: "file-text", size: 11, color: "#6366f1" }),
                              String(title).slice(0, 36)
                            );
                          })
                        )
                  ),
                  filesTouched.length > 0
                    ? h(
                        "div",
                        { style: { display: "flex", flexWrap: "wrap", gap: "0.25rem", marginTop: "0.15rem" } },
                        filesTouched.slice(0, 3).map((fp) =>
                          h(
                            Badge,
                            { key: fp, variant: "outline" },
                            h(LucideIcon, { name: "file-text", size: 11 }),
                            fp
                          )
                        )
                      )
                    : null
                );
              })
            )
      )
    );
  }

  // --------------------------------------------------------------------------
  // 1. OverviewView (Minimalist Pro Dashboard + 3 Interactive Charts + Table)
  // --------------------------------------------------------------------------
  function OverviewView({ projectRoot }) {
    const mc = MissionControlController.useMissionControl();
    const overviewData = (mc && mc.overviewQuery && mc.overviewQuery.data) || null;
    const [sessionSorting, setSessionSorting] = useState([]);
    const [sessionFilter, setSessionFilter] = useState("");

    const audit = (overviewData && overviewData.audit) || {};
    const analytics = (overviewData && overviewData.analytics) || { byStatus: {}, byKind: {}, activitySeries: [] };
    const counts = audit.counts || {
      activeNotes: 0,
      unpromotedCandidates: 0,
      conflictedNotes: 0,
      staleItems: 0,
      duplicateGroupCount: 0,
    };
    const healthScore = audit.healthScore ?? 100;
    const recommendations = audit.recommendations || [];
    const sessions = (overviewData && overviewData.lifecycle && overviewData.lifecycle.sessions) || [];
    const latestCheckpoint =
      (overviewData && overviewData.lifecycle && overviewData.lifecycle.latestCheckpoint) || null;
    const statusInfo = (overviewData && overviewData.status) || {};

    const sessionColumns = useMemo(
      () => [
        {
          id: "sessionId",
          accessorKey: "sessionId",
          header: "Session ID",
          cell: (info) =>
            h(
              "code",
              { style: { fontSize: "0.75rem", color: "hsl(var(--primary))" } },
              String(info.getValue() || "").slice(0, 10) + "..."
            ),
        },
        {
          id: "currentTask",
          accessorKey: "currentTask",
          header: "AI กำลังทำอะไร (Task)",
          cell: (info) =>
            h(
              "span",
              { style: { fontSize: "0.78rem", fontWeight: 600 } },
              String(info.getValue() || "Active AI Session").slice(0, 44)
            ),
        },
        {
          id: "noteCount",
          accessorKey: "noteCount",
          header: "ความจำ",
          cell: (info) =>
            h(
              Badge,
              { variant: "default" },
              h(LucideIcon, { name: "layers", size: 11 }),
              String(info.getValue() ?? 0)
            ),
        },
        {
          id: "semanticState",
          accessorKey: "semanticState",
          header: "สถานะ",
          cell: (info) => {
            const st = String(info.getValue() || "");
            return h(
              Badge,
              { variant: st === "active" ? "success" : "outline" },
              st === "active"
                ? [h(LucideIcon, { key: "i", name: "activity", size: 11 }), "กำลังทำงาน"]
                : st
            );
          },
        },
      ],
      []
    );

    const sessionTable = useReactTable({
      data: sessions,
      columns: sessionColumns,
      state: { sorting: sessionSorting, globalFilter: sessionFilter },
      onSortingChange: setSessionSorting,
      onGlobalFilterChange: setSessionFilter,
      getCoreRowModel: getCoreRowModel(),
      getFilteredRowModel: getFilteredRowModel(),
      getSortedRowModel: getSortedRowModel(),
    });

    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "1.1rem" } },
      // Row 1: Minimalist KPI Cards
      h(
        "div",
        { className: "pm-grid-4" },
        h("pm-stat-card", {
          label: "คะแนนสุขภาพคลังความจำ",
          value: healthScore + "/100",
          tone: Number(healthScore) >= 85 ? "emerald" : "amber",
          subtitle: "Vault Health Score",
        }),
        h("pm-stat-card", {
          label: "ความจำที่ยืนยันแล้ว",
          value: String(counts.verifiedNotes ?? counts.activeNotes ?? 0),
          tone: "indigo",
          subtitle: "Active / Verified Notes",
        }),
        h("pm-stat-card", {
          label: "รออนุมัติ (Candidates)",
          value: String(counts.unpromotedCandidates),
          tone: "amber",
          subtitle: "Provisional Queue",
        }),
        h("pm-stat-card", {
          label: "ความจำซ้ำ / ขัดแย้ง",
          value: String((counts.conflictedNotes || 0) + (counts.duplicateGroups || 0)),
          tone: (counts.conflictedNotes || 0) + (counts.duplicateGroups || 0) > 0 ? "rose" : "emerald",
          subtitle: "Conflicts & Duplicates",
        })
      ),

      // Row 2: 3 Interactive Charts (Web Components)
      h(
        "div",
        { className: "pm-grid-3" },
        h("pm-health-gauge", {
          score: String(healthScore),
          verified: String(counts.verifiedNotes ?? counts.activeNotes ?? 0),
          candidates: String(counts.unpromotedCandidates),
          conflicts: String((counts.conflictedNotes || 0) + (counts.duplicateGroups || 0)),
        }),
        h("pm-distribution-chart", {
          adr: String(analytics.byKind.adr || 0),
          insight: String(analytics.byKind.insight || 0),
          mistake: String(analytics.byKind.mistake || 0),
          "session-log": String(analytics.byKind["session-log"] || 0),
        }),
        h("pm-activity-chart", {
          "series-json": JSON.stringify(analytics.activitySeries || []),
        })
      ),

      // Row 2.5: Live AI Session Activity & Memory Relationship Map (Web Component)
      h("pm-session-activity-map", {
        "sessions-json": JSON.stringify(sessions),
      }),

      // Row 3: Governance Alerts + Sessions Table
      h(
        "div",
        { className: "pm-grid-2" },
        h(
          Card,
          {},
          h(
            CardHeader,
            {},
            h(
              "div",
              { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
              h(
                CardTitle,
                {},
                h(LucideIcon, { name: "sparkles", size: 17, color: "#f59e0b" }),
                "คำแนะนำอัจฉริยะ (AI Curator Insights)"
              ),
              h(
                Button,
                { variant: "secondary", size: "sm", onClick: () => mc && mc.setActiveTab("curator") },
                "เปิด AI Studio",
                h(LucideIcon, { name: "arrow-right", size: 13 })
              )
            ),
            h(CardDescription, {}, "สรุปสิ่งที่ควรทำเพื่อรักษาความสะอาดของคลังความจำ")
          ),
          h(
            CardContent,
            {},
            recommendations.length === 0
              ? h(
                  Alert,
                  {},
                  h(
                    AlertTitle,
                    {},
                    h(LucideIcon, { name: "check-circle-2", size: 15, color: "#10b981", style: { marginRight: "0.35rem" } }),
                    "คลังความจำสะอาดสมบูรณ์"
                  ),
                  h(AlertDescription, {}, "ไม่มีรายการค้างอนุมัติหรือความจำซ้ำซ้อนในขณะนี้")
                )
              : recommendations.map((rec, i) =>
                  h(
                    Alert,
                    { key: i },
                    h(
                      "div",
                      {
                        style: {
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: "0.2rem",
                        },
                      },
                      h(AlertTitle, {}, rec.title),
                      h(Badge, { variant: rec.priority === "high" ? "destructive" : "warning" }, rec.priority)
                    ),
                    h(AlertDescription, {}, rec.description)
                  )
                ),
            h(
              "div",
              { style: { marginTop: "0.75rem" } },
              h(
                Button,
                {
                  variant: "ghost",
                  size: "sm",
                  onClick: () => mc && mc.setShowTechDetails(!mc.showTechDetails),
                },
                h(LucideIcon, { name: mc && mc.showTechDetails ? "chevron-up" : "chevron-down", size: 14 }),
                mc && mc.showTechDetails ? "ซ่อนข้อมูลเทคนิค (Hide Vault Metadata)" : "ดูข้อมูลเทคนิค (Vault Identity & Checkpoint)"
              ),
              mc && mc.showTechDetails
                ? h(
                    "pre",
                    {
                      style: {
                        marginTop: "0.5rem",
                        background: "hsl(var(--background))",
                        padding: "0.75rem",
                        borderRadius: "0.5rem",
                        border: "1px solid hsl(var(--border))",
                        fontSize: "0.73rem",
                        overflowX: "auto",
                      },
                    },
                    JSON.stringify(
                      {
                        projectId: statusInfo.projectId,
                        vaultId: statusInfo.vaultId,
                        releaseId: statusInfo.releaseId,
                        latestCheckpoint,
                      },
                      null,
                      2
                    )
                  )
                : null
            )
          )
        ),
        h(
          Card,
          {},
          h(
            CardHeader,
            {},
            h(
              "div",
              { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem" } },
              h(
                "div",
                {},
                h(
                  CardTitle,
                  {},
                  h(LucideIcon, { name: "clock", size: 17, color: "#38bdf8" }),
                  "ประวัติเซสชันล่าสุด (Sessions)"
                ),
                h(CardDescription, {}, "คลิกหัวตารางเพื่อเรียงลำดับ (TanStack Table)")
              ),
              h(Input, {
                id: "session-table-filter",
                placeholder: "ค้นหาเซสชัน...",
                value: sessionFilter,
                onChange: (e) => setSessionFilter(e.target.value),
                style: { maxWidth: "190px" },
              })
            )
          ),
          h(
            CardContent,
            {},
            h(
              Table,
              {},
              h(
                TableHeader,
                {},
                sessionTable.getHeaderGroups().map((hg) =>
                  h(
                    TableRow,
                    { key: hg.id },
                    hg.headers.map((header) =>
                      h(
                        TableHead,
                        {
                          key: header.id,
                          style: { cursor: "pointer" },
                          onClick: header.column.getToggleSortingHandler(),
                        },
                        flexRender(header.column.columnDef.header, header.getContext()),
                        header.column.getIsSorted() === "asc"
                          ? h(LucideIcon, { name: "chevron-up", size: 12, style: { marginLeft: "0.25rem" } })
                          : header.column.getIsSorted() === "desc"
                            ? h(LucideIcon, { name: "chevron-down", size: 12, style: { marginLeft: "0.25rem" } })
                            : null
                      )
                    )
                  )
                )
              ),
              h(
                TableBody,
                {},
                sessionTable.getRowModel().rows.length === 0
                  ? h(TableRow, {}, h(TableCell, { colSpan: 4 }, "ยังไม่มีประวัติเซสชัน"))
                  : sessionTable.getRowModel().rows.slice(0, 8).map((row) =>
                      h(
                        TableRow,
                        { key: row.id },
                        row.getVisibleCells().map((cell) =>
                          h(
                            TableCell,
                            { key: cell.id },
                            flexRender(cell.column.columnDef.cell, cell.getContext())
                          )
                        )
                      )
                    )
              )
            )
          )
        )
      )
    );
  }

  // --------------------------------------------------------------------------
  // 2. KanbanBoardView (Minimalist Pro Kanban + TanStack Table Toggle)
  // --------------------------------------------------------------------------
  function KanbanBoardView({ projectRoot }) {
    const mc = MissionControlController.useMissionControl();
    const ctrl = KanbanController.useController(projectRoot, mc ? mc.notify : null);
    const [tableSorting, setTableSorting] = useState([]);

    const tableColumns = useMemo(
      () => [
        {
          id: "kind",
          accessorKey: "recordKind",
          header: "หมวดหมู่",
          cell: (info) => h(Badge, { variant: "default" }, String(info.getValue() || "insight")),
        },
        {
          id: "title",
          accessorKey: "title",
          header: "หัวข้อ (Title)",
          cell: (info) => h("strong", {}, String(info.getValue() || "")),
        },
        {
          id: "status",
          accessorKey: "status",
          header: "สถานะ",
          cell: (info) =>
            h(Badge, { variant: statusBadgeVariant(info.getValue()) }, String(info.getValue() || "")),
        },
        {
          id: "actions",
          header: "จัดการ",
          cell: (info) => {
            const n = info.row.original;
            return h(
              "div",
              { style: { display: "flex", gap: "0.35rem" } },
              n.status === "candidate" || n.status === "provisional"
                ? h(
                    Button,
                    { variant: "emerald", size: "sm", onClick: () => ctrl.promoteNote(n.recordId) },
                    h(LucideIcon, { name: "check", size: 12 }),
                    "อนุมัติ"
                  )
                : null,
              h(
                Button,
                {
                  variant: "secondary",
                  size: "sm",
                  onClick: () => mc && mc.inspectNote(n.recordId),
                },
                "ดูรายละเอียด"
              ),
              h(
                Button,
                { variant: "destructive", size: "sm", onClick: () => ctrl.retractNote(n.recordId) },
                "ยกเลิก"
              )
            );
          },
        },
      ],
      [ctrl, mc]
    );

    const notesTable = useReactTable({
      data: ctrl.items,
      columns: tableColumns,
      state: { sorting: tableSorting, globalFilter: ctrl.searchQuery },
      onSortingChange: setTableSorting,
      getCoreRowModel: getCoreRowModel(),
      getFilteredRowModel: getFilteredRowModel(),
      getSortedRowModel: getSortedRowModel(),
    });

    const renderNoteCard = (n) =>
      h(
        Card,
        { key: n.recordId, style: { marginBottom: "0.7rem" } },
        h(
          CardHeader,
          { style: { paddingBottom: "0.35rem" } },
          h(
            "div",
            { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
            h(Badge, { variant: "default" }, n.recordKind || n.kind),
            h(Badge, { variant: statusBadgeVariant(n.status) }, n.status)
          ),
          h(CardTitle, { style: { fontSize: "0.88rem", marginTop: "0.3rem" } }, n.title)
        ),
        h(
          CardContent,
          { style: { paddingBottom: "0.55rem" } },
          h(
            "p",
            { style: { fontSize: "0.78rem", color: "hsl(var(--muted-foreground))", margin: "0 0 0.45rem" } },
            String(n.summary || "").slice(0, 180)
          ),
          h(
            "div",
            { style: { display: "flex", flexWrap: "wrap", gap: "0.28rem" } },
            (n.filePaths || []).map((fp) =>
              h(
                Badge,
                { key: fp, variant: "outline" },
                h(LucideIcon, { name: "file-text", size: 11 }),
                fp
              )
            ),
            (n.symbols || []).map((sym) =>
              h(
                Badge,
                { key: sym, variant: "secondary" },
                h(LucideIcon, { name: "code-2", size: 11 }),
                sym
              )
            )
          )
        ),
        h(
          CardFooter,
          { style: { flexWrap: "wrap" } },
          n.status === "candidate" || n.status === "provisional"
            ? h(
                Button,
                { variant: "emerald", size: "sm", onClick: () => ctrl.promoteNote(n.recordId) },
                h(LucideIcon, { name: "check", size: 13 }),
                "อนุมัติ (Promote)"
              )
            : null,
          h(
            Button,
            { variant: "secondary", size: "sm", onClick: () => mc && mc.inspectNote(n.recordId) },
            h(LucideIcon, { name: "search", size: 13 }),
            "ดูข้อมูล"
          ),
          h(
            Button,
            { variant: "outline", size: "sm", onClick: () => ctrl.expireNote(n.recordId) },
            "หมดอายุ"
          ),
          h(
            Button,
            { variant: "destructive", size: "sm", onClick: () => ctrl.retractNote(n.recordId) },
            "ถอนคืน"
          )
        )
      );

    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "1rem" } },
      h(
        Card,
        {},
        h(
          CardHeader,
          {},
          h(
            CardTitle,
            {},
            h(LucideIcon, { name: "plus", size: 17, color: "#6366f1" }),
            "เพิ่มความจำใหม่ (Quick Memory Entry)"
          ),
          h(CardDescription, {}, "บันทึกการตัดสินใจ (ADR), บทเรียน (Insight) หรือข้อผิดพลาดที่ต้องระวัง (Mistake)")
        ),
        h(
          CardContent,
          {},
          h(
            "div",
            { style: { display: "grid", gridTemplateColumns: "180px 1fr 1.5fr auto", gap: "0.6rem" } },
            h(
              Select,
              {
                id: "kanban-new-kind",
                value: ctrl.newKind,
                onChange: (e) => ctrl.setNewKind(e.target.value),
              },
              h("option", { value: "writeADR" }, "ADR (การตัดสินใจ)"),
              h("option", { value: "writeInsight" }, "Insight (บทเรียน)"),
              h("option", { value: "writeMistake" }, "Mistake (ข้อผิดพลาด)")
            ),
            h(Input, {
              id: "kanban-new-title",
              placeholder: "หัวข้อสั้นๆ เข้าใจง่าย...",
              value: ctrl.newTitle,
              onChange: (e) => ctrl.setNewTitle(e.target.value),
            }),
            h(Input, {
              id: "kanban-new-summary",
              placeholder: "รายละเอียด + ระบุไฟล์ เช่น src/v2/webui.ts (startV2WebUiServer)...",
              value: ctrl.newSummary,
              onChange: (e) => ctrl.setNewSummary(e.target.value),
            }),
            h(
              Button,
              { variant: "default", onClick: ctrl.createNote, disabled: ctrl.governanceMutation.isPending },
              h(LucideIcon, { name: "plus", size: 14 }),
              ctrl.governanceMutation.isPending ? "กำลังบันทึก..." : "บันทึก"
            )
          )
        )
      ),
      h(
        "div",
        { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" } },
        h(
          "div",
          { style: { display: "flex", gap: "0.55rem", flex: 1 } },
          h(Input, {
            id: "kanban-search-input",
            placeholder: "พิมพ์ค้นหาความจำ ชื่อไฟล์ หรือฟังก์ชัน...",
            value: ctrl.searchQuery,
            onChange: (e) => ctrl.setSearchQuery(e.target.value),
          }),
          h(
            Select,
            {
              id: "kanban-kind-filter",
              value: ctrl.kindFilter,
              onChange: (e) => ctrl.setKindFilter(e.target.value),
              style: { maxWidth: "180px" },
            },
            h("option", { value: "" }, "ทุกหมวดหมู่"),
            h("option", { value: "adr" }, "ADR"),
            h("option", { value: "insight" }, "Insight"),
            h("option", { value: "mistake" }, "Mistake"),
            h("option", { value: "session-log" }, "Session Log")
          )
        ),
        h(
          "div",
          { style: { display: "flex", gap: "0.35rem" } },
          h(
            Button,
            {
              variant: ctrl.viewMode === "kanban" ? "default" : "secondary",
              size: "sm",
              onClick: () => ctrl.setViewMode("kanban"),
            },
            h(LucideIcon, { name: "kanban", size: 14 }),
            "มุมมองบอร์ด (Kanban)"
          ),
          h(
            Button,
            {
              variant: ctrl.viewMode === "table" ? "default" : "secondary",
              size: "sm",
              onClick: () => ctrl.setViewMode("table"),
            },
            h(LucideIcon, { name: "table-2", size: 14 }),
            "มุมมองตาราง (Table)"
          )
        )
      ),
      ctrl.viewMode === "table"
        ? h(
            Card,
            {},
            h(
              CardContent,
              { style: { paddingTop: "1rem" } },
              h(
                Table,
                {},
                h(
                  TableHeader,
                  {},
                  notesTable.getHeaderGroups().map((hg) =>
                    h(
                      TableRow,
                      { key: hg.id },
                      hg.headers.map((header) =>
                        h(
                          TableHead,
                          {
                            key: header.id,
                            style: { cursor: "pointer" },
                            onClick: header.column.getToggleSortingHandler(),
                          },
                          flexRender(header.column.columnDef.header, header.getContext())
                        )
                      )
                    )
                  )
                ),
                h(
                  TableBody,
                  {},
                  notesTable.getRowModel().rows.map((row) =>
                    h(
                      TableRow,
                      { key: row.id },
                      row.getVisibleCells().map((cell) =>
                        h(
                          TableCell,
                          { key: cell.id },
                          flexRender(cell.column.columnDef.cell, cell.getContext())
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        : h(
            "div",
            { className: "pm-kanban-grid" },
            h(
              Card,
              {},
              h(
                CardHeader,
                {},
                h(
                  "div",
                  { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
                  h(
                    CardTitle,
                    {},
                    h(LucideIcon, { name: "clock", size: 16, color: "#f59e0b" }),
                    "รออนุมัติ (Candidates)"
                  ),
                  h(Badge, { variant: "warning" }, String(ctrl.columns.candidates.length))
                )
              ),
              h(CardContent, {}, ctrl.columns.candidates.map(renderNoteCard))
            ),
            h(
              Card,
              {},
              h(
                CardHeader,
                {},
                h(
                  "div",
                  { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
                  h(
                    CardTitle,
                    {},
                    h(LucideIcon, { name: "check-circle-2", size: 16, color: "#10b981" }),
                    "ยืนยันแล้ว (Verified)"
                  ),
                  h(Badge, { variant: "success" }, String(ctrl.columns.active.length))
                )
              ),
              h(CardContent, {}, ctrl.columns.active.map(renderNoteCard))
            ),
            h(
              Card,
              {},
              h(
                CardHeader,
                {},
                h(
                  "div",
                  { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
                  h(
                    CardTitle,
                    {},
                    h(LucideIcon, { name: "alert-triangle", size: 16, color: "#ef4444" }),
                    "ขัดแย้ง / หมดอายุ"
                  ),
                  h(Badge, { variant: "destructive" }, String(ctrl.columns.stale.length))
                )
              ),
              h(CardContent, {}, ctrl.columns.stale.map(renderNoteCard))
            )
          )
    );
  }

  // --------------------------------------------------------------------------
  // 3. KnowledgeGraphView (Human-First Story Flow + Orbital Graph + Inspector)
  // --------------------------------------------------------------------------
  function humanKindLabel(node) {
    if (!node) return "";
    if (node.kind === "session") return "เซสชันการทำงานของ AI (AI Session)";
    if (node.kind === "file") return "ไฟล์ซอร์สโค้ด (Project File)";
    if (node.kind === "symbol") return "ฟังก์ชัน / คลาส (Code Symbol)";
    const sk = String(node.subkind || "insight").toLowerCase();
    if (sk === "adr") return "การตัดสินใจสถาปัตยกรรม (ADR)";
    if (sk === "mistake") return "ข้อผิดพลาดที่แก้ไขแล้ว (Mistake)";
    if (sk === "session-log") return "บันทึกสรุปเซสชัน (Session Log)";
    return "บทเรียนและเทคนิคสำคัญ (Insight)";
  }

  function shortNodeDisplayLabel(node) {
    if (!node) return "";
    const raw = String(node.label || "");
    if (node.kind === "file") {
      const parts = raw.split("/");
      const base = parts[parts.length - 1] || raw;
      return parts.length > 1 ? base + " (" + parts.slice(0, -1).join("/") + ")" : base;
    }
    if (node.kind === "session") {
      const task = String(node.currentTask || "").replace(/^ADR:\\s*|^Mistake:\\s*|^Insight:\\s*/i, "").trim();
      if (task && task !== "AI Agent Working Session") {
        return task.slice(0, 28);
      }
      return "เซสชัน #" + String(node.sessionId || "").slice(0, 6);
    }
    return raw.replace(/^ADR:\\s*|^Mistake:\\s*|^Insight:\\s*/i, "").trim();
  }

  function KnowledgeGraphView({ projectRoot }) {
    const mc = MissionControlController.useMissionControl();
    const ctrl = KnowledgeGraphController.useController(projectRoot);
    const { layout } = ctrl;
    const overviewData = (mc && mc.overviewQuery && mc.overviewQuery.data) || null;
    const sessions = (overviewData && overviewData.lifecycle && overviewData.lifecycle.sessions) || [];
    const selected = layout.selectedNode;
    const story = layout.selectedStory || {
      relatedSessions: [],
      relatedNotes: [],
      relatedFiles: [],
      relatedSymbols: [],
    };
    const hiSet = layout.highlightedNodeIds || new Set();

    const columnHeaders = [
      { x: 122, title: "1. ภารกิจ AI (Session)", sub: "จุดเริ่มต้นของงาน", color: "#38bdf8" },
      { x: 368, title: "2. ความจำที่ได้ (Memory)", sub: "การตัดสินใจ & บทเรียน", color: "#6366f1" },
      { x: 628, title: "3. ไฟล์ที่แก้ไข (File)", sub: "ซอร์สโค้ดที่เกี่ยวข้อง", color: "#10b981" },
      { x: 852, title: "4. ฟังก์ชัน/คลาส (Symbol)", sub: "โมดูลที่ได้รับผลกระทบ", color: "#f59e0b" },
    ];

    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "1rem" } },
      h(
        Card,
        {},
        h(
          CardHeader,
          {},
          h(
            "div",
            {
              style: {
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                flexWrap: "wrap",
                gap: "0.85rem",
              },
            },
            h(
              "div",
              {},
              h(
                CardTitle,
                {},
                h(LucideIcon, { name: "network", size: 18, color: "#38bdf8" }),
                "แผนผังความเชื่อมโยงเข้าใจง่าย: เซสชัน AI ➔ ความจำ ➔ ไฟล์ ➔ โค้ด"
              ),
              h(
                CardDescription,
                {},
                "คลิกที่รายการใดก็ได้ในกราฟ ระบบจะไฮไลต์เส้นทางที่เชื่อมโยงกันและสรุปเป็นภาษาคนที่อ่านเข้าใจได้ทันทีทางด้านขวา"
              )
            ),
            h(
              "div",
              { style: { display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" } },
              h(
                Button,
                {
                  size: "sm",
                  variant: ctrl.layoutMode === "flow" ? "default" : "secondary",
                  onClick: () => ctrl.setLayoutMode("flow"),
                },
                h(LucideIcon, { name: "git-branch", size: 13 }),
                "มุมมองลำดับเรื่องราว (อ่านง่าย)"
              ),
              h(
                Button,
                {
                  size: "sm",
                  variant: ctrl.layoutMode === "orbital" ? "default" : "secondary",
                  onClick: () => ctrl.setLayoutMode("orbital"),
                },
                h(LucideIcon, { name: "network", size: 13 }),
                "มุมมองเครือข่ายวงโคจร"
              )
            )
          ),
          // Filter & Search Toolbar
          h(
            "div",
            {
              style: {
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "0.55rem",
                marginTop: "0.65rem",
                paddingTop: "0.65rem",
                borderTop: "1px solid hsl(var(--border))",
              },
            },
            h(
              "div",
              { style: { display: "flex", gap: "0.45rem", alignItems: "center", flexWrap: "wrap", flex: 1 } },
              h(Input, {
                id: "graph-search-input",
                placeholder: "ค้นหาชื่อเรื่อง, ชื่อไฟล์ หรือฟังก์ชันในกราฟ...",
                value: ctrl.searchQuery,
                onChange: (e) => ctrl.setSearchQuery(e.target.value),
                style: { maxWidth: "250px" },
              }),
              h(
                Select,
                {
                  id: "graph-session-filter",
                  value: ctrl.sessionFilter,
                  onChange: (e) => ctrl.setSessionFilter(e.target.value),
                  style: { maxWidth: "230px" },
                },
                h("option", { value: "all" }, "ทุกเซสชัน AI (All Sessions)"),
                (layout.sessionNodesList || []).map((sn) =>
                  h(
                    "option",
                    { key: sn.sessionId || sn.id, value: sn.sessionId || sn.id },
                    "#" + String(sn.sessionId || "").slice(0, 6) + " — " + shortNodeDisplayLabel(sn)
                  )
                )
              )
            ),
            h(
              "div",
              { style: { display: "flex", gap: "0.35rem", alignItems: "center", flexWrap: "wrap" } },
              ["all", "session", "note", "file", "symbol"].map((k) =>
                h(
                  Button,
                  {
                    key: k,
                    size: "sm",
                    variant: ctrl.kindFilter === k ? "default" : "secondary",
                    onClick: () => ctrl.setKindFilter(k),
                  },
                  k === "all"
                    ? "ทั้งหมด (" + (layout.totalFilteredCount ?? layout.nodes.length ?? 0) + ")"
                    : k === "session"
                      ? [
                          h(LucideIcon, { key: "i", name: "cpu", size: 13, color: "#38bdf8" }),
                          "เซสชัน (" + (layout.stats.sessionNodes ?? 0) + ")",
                        ]
                      : k === "note"
                        ? [
                            h(LucideIcon, { key: "i", name: "layers", size: 13, color: "#6366f1" }),
                            "ความจำ (" + (layout.stats.noteNodes ?? 0) + ")",
                          ]
                        : k === "file"
                          ? [
                              h(LucideIcon, { key: "i", name: "file-text", size: 13, color: "#10b981" }),
                              "ไฟล์ (" + (layout.stats.fileNodes ?? 0) + ")",
                            ]
                          : [
                              h(LucideIcon, { key: "i", name: "code-2", size: 13, color: "#f59e0b" }),
                              "โค้ด (" + (layout.stats.symbolNodes ?? 0) + ")",
                            ]
                )
              ),
              ctrl.layoutMode === "orbital"
                ? [
                    h(Button, { key: "zo", size: "sm", variant: "outline", onClick: ctrl.zoomOut }, h(LucideIcon, { name: "minus", size: 13 })),
                    h(Button, { key: "zr", size: "sm", variant: "outline", onClick: ctrl.resetZoom }, Math.round(ctrl.zoom * 100) + "%"),
                    h(Button, { key: "zi", size: "sm", variant: "outline", onClick: ctrl.zoomIn }, h(LucideIcon, { name: "plus", size: 13 })),
                  ]
                : null
            )
          )
        ),
        h(
          CardContent,
          {},
          // Split View: Interactive Graph (Left) + Human-Readable Story Inspector (Right)
          h(
            "div",
            {
              style: {
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
                gap: "1rem",
                alignItems: "start",
              },
            },
            // Left Pane: Interactive SVG Graph
            h(
              "div",
              { style: { minWidth: 0 } },
              h(
                "svg",
                {
                  viewBox: "0 0 " + layout.width + " " + layout.height,
                  style: {
                    width: "100%",
                    height: layout.layoutMode === "flow" ? "540px" : "520px",
                    background: "hsl(var(--background))",
                    borderRadius: "var(--radius)",
                    border: "1px solid hsl(var(--border))",
                  },
                },
                // Flow Mode Column Headers & Guide Lanes
                layout.layoutMode === "flow"
                  ? columnHeaders.map((col, idx) =>
                      h(
                        "g",
                        { key: "col-hdr-" + idx },
                        h("rect", {
                          x: col.x - 102,
                          y: 10,
                          width: 204,
                          height: 38,
                          rx: 8,
                          fill: "hsl(var(--card))",
                          stroke: col.color,
                          "stroke-opacity": "0.4",
                        }),
                        h(
                          "text",
                          {
                            x: col.x,
                            y: 26,
                            fill: col.color,
                            "font-size": "11.5",
                            "font-weight": "700",
                            "text-anchor": "middle",
                          },
                          col.title
                        ),
                        h(
                          "text",
                          {
                            x: col.x,
                            y: 40,
                            fill: "hsl(var(--muted-foreground))",
                            "font-size": "9.5",
                            "text-anchor": "middle",
                          },
                          col.sub
                        ),
                        h("line", {
                          x1: col.x,
                          y1: 52,
                          x2: col.x,
                          y2: layout.height - 14,
                          stroke: "hsl(var(--border))",
                          "stroke-dasharray": "3 5",
                          opacity: "0.35",
                        })
                      )
                    )
                  : [90, 170, 235].map((r, idx) =>
                      h("circle", {
                        key: "orbit-" + idx,
                        cx: layout.width / 2,
                        cy: layout.height / 2,
                        r: Math.round(r * ctrl.zoom),
                        fill: "none",
                        stroke: "hsl(var(--border))",
                        "stroke-dasharray": "4 6",
                        opacity: "0.35",
                      })
                    ),

                // Edges (Smooth Cubic Bezier in Flow Mode, Quadratic Curve in Orbital Mode)
                layout.edges.map((e, i) => {
                  const s = layout.positions.get(e.source);
                  const t = layout.positions.get(e.target);
                  if (!s || !t) return null;
                  const isHi = hiSet.has(e.source) && hiSet.has(e.target);
                  const strokeColor =
                    e.relation === "created-in-session" || e.relation === "forked-from"
                      ? "#38bdf8"
                      : e.relation === "touches-file"
                        ? "#10b981"
                        : "#f59e0b";

                  if (layout.layoutMode === "flow") {
                    const sx = s.x + (s.x < t.x ? 96 : -96);
                    const sy = s.y;
                    const tx = t.x + (s.x < t.x ? -96 : 96);
                    const ty = t.y;
                    const c1x = Math.round(sx + (tx - sx) * 0.45);
                    const c2x = Math.round(sx + (tx - sx) * 0.55);
                    return h("path", {
                      key: "edge-" + i,
                      d: "M " + sx + " " + sy + " C " + c1x + " " + sy + ", " + c2x + " " + ty + ", " + tx + " " + ty,
                      fill: "none",
                      stroke: isHi ? strokeColor : "hsl(var(--border))",
                      "stroke-width": isHi ? "2.4" : "1.1",
                      opacity: isHi ? "0.92" : "0.18",
                    });
                  }

                  const mx = Math.round((s.x + t.x) / 2);
                  const my = Math.round((s.y + t.y) / 2 - 18);
                  return h("path", {
                    key: "edge-" + i,
                    d: "M " + s.x + " " + s.y + " Q " + mx + " " + my + " " + t.x + " " + t.y,
                    fill: "none",
                    stroke: isHi ? strokeColor : "hsl(var(--border))",
                    "stroke-width": isHi ? "2.3" : "1.1",
                    opacity: isHi ? "0.9" : "0.16",
                  });
                }),

                // Nodes (Readable Pill Cards in Flow Mode, Spotlight Nodes in Orbital Mode)
                layout.nodes.map((n) => {
                  const p = layout.positions.get(n.id);
                  if (!p) return null;
                  const color =
                    n.kind === "session"
                      ? "#38bdf8"
                      : n.kind === "note"
                        ? n.subkind === "adr"
                          ? "#6366f1"
                          : n.subkind === "mistake"
                            ? "#ef4444"
                            : "#10b981"
                        : n.kind === "file"
                          ? "#10b981"
                          : "#f59e0b";
                  const isSelected = Boolean(selected && selected.id === n.id);
                  const isHi = hiSet.has(n.id);
                  const shortText = shortNodeDisplayLabel(n);

                  if (layout.layoutMode === "flow") {
                    const boxW = 192;
                    const boxH = 31;
                    return h(
                      "g",
                      {
                        key: n.id,
                        style: { cursor: "pointer" },
                        opacity: isHi ? "1" : "0.38",
                        onClick: () => ctrl.setSelectedNodeId(n.id),
                      },
                      isSelected
                        ? h("rect", {
                            x: p.x - boxW / 2 - 3,
                            y: p.y - boxH / 2 - 3,
                            width: boxW + 6,
                            height: boxH + 6,
                            rx: 10,
                            fill: "none",
                            stroke: color,
                            "stroke-width": "2",
                            opacity: "0.55",
                          })
                        : null,
                      h("rect", {
                        x: p.x - boxW / 2,
                        y: p.y - boxH / 2,
                        width: boxW,
                        height: boxH,
                        rx: 8,
                        fill: isSelected ? "hsl(var(--secondary))" : "hsl(var(--card))",
                        stroke: isSelected || isHi ? color : "hsl(var(--border))",
                        "stroke-width": isSelected ? "2" : isHi ? "1.4" : "1",
                      }),
                      h("circle", {
                        cx: p.x - boxW / 2 + 13,
                        cy: p.y,
                        r: 4.5,
                        fill: color,
                      }),
                      h(
                        "text",
                        {
                          x: p.x - boxW / 2 + 24,
                          y: p.y + 4,
                          fill: "hsl(var(--foreground))",
                          "font-size": "10.8",
                          "font-weight": isSelected || isHi ? "600" : "500",
                          "text-anchor": "start",
                        },
                        shortText.length > 23 ? shortText.slice(0, 22) + "…" : shortText
                      )
                    );
                  }

                  // Orbital Mode Node
                  return h(
                    "g",
                    {
                      key: n.id,
                      style: { cursor: "pointer" },
                      opacity: isHi ? "1" : "0.3",
                      onClick: () => ctrl.setSelectedNodeId(n.id),
                    },
                    h("circle", {
                      cx: p.x,
                      cy: p.y,
                      r: isSelected ? 20 : n.kind === "session" ? 16 : n.kind === "note" ? 14 : 10,
                      fill: color,
                      opacity: isSelected ? "0.35" : "0.18",
                    }),
                    h("circle", {
                      cx: p.x,
                      cy: p.y,
                      r: isSelected ? 11 : n.kind === "session" ? 9 : n.kind === "note" ? 8 : 6,
                      fill: color,
                      stroke: isSelected ? "#fff" : "none",
                      "stroke-width": isSelected ? "2" : "0",
                    }),
                    isHi
                      ? h(
                          "text",
                          {
                            x: p.x,
                            y: p.y + 21,
                            fill: "hsl(var(--foreground))",
                            "font-size": isSelected ? "11.5" : "10",
                            "font-weight": isSelected ? "700" : "600",
                            "text-anchor": "middle",
                          },
                          shortText.slice(0, 24)
                        )
                      : null
                  );
                })
              ),
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "0.5rem",
                    marginTop: "0.55rem",
                    fontSize: "0.75rem",
                    color: "hsl(var(--muted-foreground))",
                  },
                },
                h(
                  "span",
                  {},
                  "เคล็ดลับ: คลิกที่กล่องใดก็ได้ในกราฟเพื่อดูเส้นทางความสัมพันธ์และอ่านสรุปภาษาคนทางขวา"
                ),
                h(
                  "div",
                  { style: { display: "flex", gap: "0.75rem", alignItems: "center" } },
                  h("span", { style: { color: "#38bdf8", fontWeight: 600 } }, "● เซสชัน AI"),
                  h("span", { style: { color: "#6366f1", fontWeight: 600 } }, "● ความจำ (ADR/Insight)"),
                  h("span", { style: { color: "#10b981", fontWeight: 600 } }, "● ไฟล์โค้ด"),
                  h("span", { style: { color: "#f59e0b", fontWeight: 600 } }, "● ฟังก์ชัน/คลาส")
                )
              )
            ),

            // Right Pane: Human-Readable Story Inspector ("กดปุ๊บ มนุษย์อ่านเข้าใจทันที")
            h(
              "div",
              {
                style: {
                  borderRadius: "var(--radius)",
                  border: "1px solid hsl(var(--border))",
                  background: "hsl(var(--card))",
                  padding: "1.1rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.9rem",
                },
              },
              !selected
                ? h(
                    Alert,
                    {},
                    h(AlertTitle, {}, "คลิกเลือกโหนดในกราฟเพื่ออ่านสรุป"),
                    h(AlertDescription, {}, "เมื่อคลิกที่เซสชัน ความจำ ไฟล์ หรือโค้ด ระบบจะแปลความสัมพันธ์เป็นภาษาคนที่เข้าใจง่ายทันที")
                  )
                : [
                    // 1. Header & Human Category Badge
                    h(
                      "div",
                      { key: "hdr", style: { display: "flex", flexDirection: "column", gap: "0.45rem" } },
                      h(
                        "div",
                        { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" } },
                        h(
                          Badge,
                          {
                            variant:
                              selected.kind === "session"
                                ? "default"
                                : selected.kind === "note"
                                  ? "success"
                                  : "secondary",
                          },
                          h(LucideIcon, {
                            name:
                              selected.kind === "session"
                                ? "cpu"
                                : selected.kind === "note"
                                  ? "lightbulb"
                                  : selected.kind === "file"
                                    ? "file-text"
                                    : "code-2",
                            size: 12,
                          }),
                          humanKindLabel(selected)
                        ),
                        selected.status
                          ? h(
                              Badge,
                              { variant: statusBadgeVariant(selected.status) },
                              selected.status === "verified"
                                ? "ยืนยันแล้ว (Verified)"
                                : selected.status === "active"
                                  ? "กำลังทำงาน (Active)"
                                  : selected.status === "completed" || selected.status === "ended"
                                    ? "เสร็จสมบูรณ์"
                                    : selected.status
                            )
                          : null
                      ),
                      h(
                        "h4",
                        {
                          style: {
                            margin: "0.15rem 0 0",
                            fontSize: "1.02rem",
                            fontWeight: 700,
                            lineHeight: 1.4,
                            color: "hsl(var(--foreground))",
                          },
                        },
                        selected.kind === "session"
                          ? selected.currentTask || selected.label
                          : selected.label
                      )
                    ),

                    // 2. Plain-Language Summary Card ("สรุปให้อ่านเข้าใจทันที")
                    h(
                      "div",
                      {
                        key: "summary-box",
                        style: {
                          padding: "0.85rem 0.95rem",
                          borderRadius: "calc(var(--radius) - 2px)",
                          background: "hsl(var(--background))",
                          border: "1px solid hsl(var(--border))",
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.4rem",
                        },
                      },
                      h(
                        "div",
                        {
                          style: {
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.35rem",
                            fontSize: "0.75rem",
                            fontWeight: 700,
                            color: "hsl(var(--primary))",
                          },
                        },
                        h(LucideIcon, { name: "sparkles", size: 13, color: "#f59e0b" }),
                        "สรุปใจความสำคัญ (อ่านเข้าใจง่าย)"
                      ),
                      h(
                        "div",
                        {
                          style: {
                            fontSize: "0.83rem",
                            lineHeight: 1.6,
                            color: "hsl(var(--foreground))",
                          },
                        },
                        selected.kind === "note"
                          ? selected.summary || selected.label
                          : selected.kind === "session"
                            ? "ในเซสชันนี้ AI Agent ได้ดำเนินภารกิจเรื่อง '" +
                              (selected.currentTask || selected.label) +
                              "' และได้บันทึกความจำที่เกี่ยวข้องไว้ " +
                              story.relatedNotes.length +
                              " รายการ เชื่อมโยงกับไฟล์โค้ด " +
                              story.relatedFiles.length +
                              " ไฟล์"
                            : selected.kind === "file"
                              ? "ไฟล์ '" +
                                selected.label +
                                "' ถูกอ้างอิงหรือแก้ไขในความจำของโปรเจกต์จำนวน " +
                                story.relatedNotes.length +
                                " เรื่อง และมีฟังก์ชัน/คลาสที่เกี่ยวข้อง " +
                                story.relatedSymbols.length +
                                " รายการ"
                              : "ฟังก์ชัน/คลาส '" +
                                selected.label +
                                "' เป็นส่วนประกอบสำคัญที่ถูกกล่าวถึงในความจำ " +
                                story.relatedNotes.length +
                                " เรื่อง"
                      ),
                      h(
                        "div",
                        { style: { display: "flex", gap: "0.45rem", flexWrap: "wrap", marginTop: "0.3rem" } },
                        selected.recordId
                          ? h(
                              Button,
                              {
                                size: "sm",
                                variant: "default",
                                onClick: () => mc && mc.inspectNote(selected.recordId),
                              },
                              h(LucideIcon, { name: "file-text", size: 13 }),
                              "อ่านเนื้อหาฉบับเต็ม"
                            )
                          : null,
                        selected.sessionId
                          ? h(
                              Button,
                              {
                                size: "sm",
                                variant: "outline",
                                onClick: () =>
                                  ctrl.setSessionFilter(
                                    ctrl.sessionFilter === selected.sessionId ? "all" : selected.sessionId
                                  ),
                              },
                              h(LucideIcon, { name: "search", size: 13 }),
                              ctrl.sessionFilter === selected.sessionId
                                ? "แสดงทุกเซสชัน"
                                : "กรองดูเฉพาะเซสชันนี้"
                            )
                          : null
                      )
                    ),

                    // 3. Connected Story Relationships
                    story.relatedSessions.length > 0
                      ? h(
                          "div",
                          { key: "rel-sessions", style: { display: "flex", flexDirection: "column", gap: "0.35rem" } },
                          h(
                            "div",
                            { style: { display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.76rem", fontWeight: 700, color: "#38bdf8" } },
                            h(LucideIcon, { name: "cpu", size: 13, color: "#38bdf8" }),
                            "เซสชัน AI ที่เกี่ยวข้อง (" + story.relatedSessions.length + ")"
                          ),
                          story.relatedSessions.map((sNode) =>
                            h(
                              "button",
                              {
                                key: sNode.id,
                                onClick: () => ctrl.setSelectedNodeId(sNode.id),
                                style: {
                                  textAlign: "left",
                                  padding: "0.5rem 0.7rem",
                                  borderRadius: "0.5rem",
                                  border: "1px solid hsla(199, 89%, 48%, 0.35)",
                                  background: "hsla(199, 89%, 48%, 0.08)",
                                  color: "hsl(var(--foreground))",
                                  fontSize: "0.78rem",
                                  cursor: "pointer",
                                },
                              },
                              h("div", { style: { fontWeight: 600 } }, sNode.currentTask || sNode.label),
                              h(
                                "div",
                                { style: { fontSize: "0.7rem", color: "hsl(var(--muted-foreground))" } },
                                "Session #" + String(sNode.sessionId || "").slice(0, 8)
                              )
                            )
                          )
                        )
                      : null,

                    story.relatedNotes.length > 0
                      ? h(
                          "div",
                          { key: "rel-notes", style: { display: "flex", flexDirection: "column", gap: "0.4rem" } },
                          h(
                            "div",
                            { style: { display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.76rem", fontWeight: 700, color: "#6366f1" } },
                            h(LucideIcon, { name: "layers", size: 13, color: "#6366f1" }),
                            "ความจำ & บทเรียนที่เชื่อมโยง (" + story.relatedNotes.length + " เรื่อง)"
                          ),
                          story.relatedNotes.slice(0, 5).map((nNode) =>
                            h(
                              "div",
                              {
                                key: nNode.id,
                                onClick: () => ctrl.setSelectedNodeId(nNode.id),
                                style: {
                                  padding: "0.55rem 0.75rem",
                                  borderRadius: "0.5rem",
                                  border: "1px solid hsl(var(--border))",
                                  background: "hsl(var(--background))",
                                  cursor: "pointer",
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: "0.25rem",
                                },
                              },
                              h(
                                "div",
                                { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.4rem" } },
                                h("span", { style: { fontSize: "0.79rem", fontWeight: 700 } }, nNode.label),
                                nNode.recordId
                                  ? h(
                                      Button,
                                      {
                                        size: "sm",
                                        variant: "secondary",
                                        onClick: (ev) => {
                                          ev.stopPropagation();
                                          if (mc) mc.inspectNote(nNode.recordId);
                                        },
                                      },
                                      "อ่านเต็ม"
                                    )
                                  : null
                              ),
                              nNode.summary
                                ? h(
                                    "div",
                                    { style: { fontSize: "0.73rem", color: "hsl(var(--muted-foreground))", lineHeight: 1.45 } },
                                    String(nNode.summary).slice(0, 140)
                                  )
                                : null
                            )
                          )
                        )
                      : null,

                    story.relatedFiles.length > 0
                      ? h(
                          "div",
                          { key: "rel-files", style: { display: "flex", flexDirection: "column", gap: "0.35rem" } },
                          h(
                            "div",
                            { style: { display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.76rem", fontWeight: 700, color: "#10b981" } },
                            h(LucideIcon, { name: "file-text", size: 13, color: "#10b981" }),
                            "ไฟล์ซอร์สโค้ดที่เกี่ยวข้อง (" + story.relatedFiles.length + " ไฟล์)"
                          ),
                          h(
                            "div",
                            { style: { display: "flex", flexWrap: "wrap", gap: "0.3rem" } },
                            story.relatedFiles.map((fNode) =>
                              h(
                                Badge,
                                {
                                  key: fNode.id,
                                  variant: "outline",
                                  style: { cursor: "pointer" },
                                  onClick: () => ctrl.setSelectedNodeId(fNode.id),
                                },
                                h(LucideIcon, { name: "file-text", size: 11, color: "#10b981" }),
                                fNode.label
                              )
                            )
                          )
                        )
                      : null,

                    story.relatedSymbols.length > 0
                      ? h(
                          "div",
                          { key: "rel-symbols", style: { display: "flex", flexDirection: "column", gap: "0.35rem" } },
                          h(
                            "div",
                            { style: { display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.76rem", fontWeight: 700, color: "#f59e0b" } },
                            h(LucideIcon, { name: "code-2", size: 13, color: "#f59e0b" }),
                            "ฟังก์ชัน / คลาสที่เกี่ยวข้อง (" + story.relatedSymbols.length + ")"
                          ),
                          h(
                            "div",
                            { style: { display: "flex", flexWrap: "wrap", gap: "0.3rem" } },
                            story.relatedSymbols.slice(0, 12).map((symNode) =>
                              h(
                                Badge,
                                {
                                  key: symNode.id,
                                  variant: "secondary",
                                  style: { cursor: "pointer" },
                                  onClick: () => ctrl.setSelectedNodeId(symNode.id),
                                },
                                h(LucideIcon, { name: "code-2", size: 11, color: "#f59e0b" }),
                                symNode.label
                              )
                            )
                          )
                        )
                      : null,
                  ]
            )
          )
        )
      ),
      h("pm-session-activity-map", {
        "sessions-json": JSON.stringify(sessions),
      })
    );
  }

  // --------------------------------------------------------------------------
  // 4. CuratorStudioView (Minimalist AI Memory Curator Studio)
  // --------------------------------------------------------------------------
  function CuratorStudioView({ projectRoot }) {
    const mc = MissionControlController.useMissionControl();
    const ctrl = CuratorController.useController(projectRoot, mc ? mc.notify : null);
    const audit = ctrl.auditQuery.data || {};
    const recommendations = audit.recommendations || [];
    const duplicateGroups = audit.duplicateGroups || [];

    return h(
      "div",
      { className: "pm-grid-2" },
      h(
        Card,
        {},
        h(
          CardHeader,
          {},
          h(
            CardTitle,
            {},
            h(LucideIcon, { name: "bot", size: 17, color: "#6366f1" }),
            "ผู้ช่วย AI ดูแลความจำ (AI Memory Curator)"
          ),
          h(CardDescription, {}, "พิมพ์สั่งงานภาษาไทยหรืออังกฤษได้ทันที เช่น ค้นหา อนุมัติ หรือบันทึกความจำ")
        ),
        h(
          CardContent,
          {},
          h(
            "div",
            {
              style: {
                height: "330px",
                overflowY: "auto",
                background: "hsl(var(--background))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "var(--radius)",
                padding: "0.85rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.6rem",
                marginBottom: "0.75rem",
              },
            },
            ctrl.messages.map((m) =>
              h(
                "div",
                {
                  key: m.id,
                  style: {
                    alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                    maxWidth: "85%",
                    padding: "0.6rem 0.85rem",
                    borderRadius: "0.65rem",
                    fontSize: "0.82rem",
                    whiteSpace: "pre-wrap",
                    background:
                      m.role === "user" ? "hsl(var(--primary))" : "hsl(var(--secondary))",
                    color: m.role === "user" ? "#fff" : "hsl(var(--foreground))",
                  },
                },
                m.text,
                m.tools && m.tools.length > 0
                  ? h(
                      "div",
                      { style: { marginTop: "0.35rem", display: "flex", gap: "0.28rem", flexWrap: "wrap" } },
                      m.tools.map((t) =>
                        h(
                          Badge,
                          { key: t, variant: "outline" },
                          h(LucideIcon, { name: "wrench", size: 11 }),
                          t
                        )
                      )
                    )
                  : null
              )
            )
          ),
          h(
            "div",
            { style: { display: "flex", gap: "0.5rem", marginBottom: "0.6rem" } },
            h(Input, {
              id: "curator-chat-input",
              placeholder: "พิมพ์คำสั่ง เช่น 'ช่วยตรวจสุขภาพความจำ', 'อนุมัติ candidate ทั้งหมด'...",
              value: ctrl.chatInput,
              onChange: (e) => ctrl.setChatInput(e.target.value),
              onKeyDown: (e) => {
                if (e.key === "Enter") ctrl.sendMessage();
              },
            }),
            h(
              Button,
              { variant: "default", onClick: () => ctrl.sendMessage(), disabled: ctrl.chatMutation.isPending },
              h(LucideIcon, { name: "send", size: 13 }),
              ctrl.chatMutation.isPending ? "..." : "ส่ง"
            )
          ),
          h(
            "div",
            { style: { display: "flex", gap: "0.35rem", flexWrap: "wrap" } },
            h(
              Button,
              {
                variant: "secondary",
                size: "sm",
                onClick: () => ctrl.sendMessage("ช่วยตรวจสุขภาพความจำและหาความจำซ้ำ"),
              },
              h(LucideIcon, { name: "search", size: 13 }),
              "ตรวจสุขภาพความจำ"
            ),
            h(
              Button,
              { variant: "secondary", size: "sm", onClick: () => ctrl.sendMessage("อนุมัติ candidate ทั้งหมด") },
              h(LucideIcon, { name: "sparkles", size: 13, color: "#10b981" }),
              "อนุมัติทั้งหมด"
            ),
            h(
              Button,
              { variant: "secondary", size: "sm", onClick: () => ctrl.sendMessage("สรุปงานค้างและบริบทโปรเจกต์") },
              h(LucideIcon, { name: "zap", size: 13, color: "#f59e0b" }),
              "สรุปบริบทโปรเจกต์"
            )
          )
        )
      ),
      h(
        Card,
        {},
        h(
          CardHeader,
          {},
          h(
            "div",
            { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
            h(
              "div",
              {},
              h(
                CardTitle,
                {},
                h(LucideIcon, { name: "zap", size: 17, color: "#f59e0b" }),
                "จัดการอัตโนมัติในคลิกเดียว (1-Click Auto-Curate)"
              ),
              h(CardDescription, {}, "อนุมัติรายการที่ผ่านเกณฑ์และยุบรวมความจำซ้ำให้อัตโนมัติ")
            ),
            h(
              Button,
              {
                variant: "emerald",
                onClick: ctrl.runAutoCurate,
                disabled: ctrl.autoCurateMutation.isPending,
              },
              h(LucideIcon, { name: "sparkles", size: 14 }),
              ctrl.autoCurateMutation.isPending ? "กำลังทำงาน..." : "จัดระเบียบอัตโนมัติ"
            )
          )
        ),
        h(
          CardContent,
          {},
          recommendations.map((r, idx) =>
            h(
              Alert,
              { key: idx },
              h(AlertTitle, {}, r.title),
              h(AlertDescription, {}, r.description)
            )
          ),
          h(Separator, {}),
          h(
            "h4",
            { style: { display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.83rem", margin: "0 0 0.45rem" } },
            h(LucideIcon, { name: "layers", size: 15, color: "#6366f1" }),
            "รายการความจำที่ซ้ำกัน"
          ),
          duplicateGroups.length === 0
            ? h(
                "p",
                { style: { display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.78rem", color: "hsl(var(--muted-foreground))" } },
                h(LucideIcon, { name: "check-circle-2", size: 14, color: "#10b981" }),
                "ไม่พบความจำซ้ำ"
              )
            : duplicateGroups.map((g, idx) =>
                h(
                  Alert,
                  { key: idx },
                  h(AlertTitle, {}, g.title),
                  h(
                    AlertDescription,
                    {},
                    "รายการหลัก: " + g.keeperRecordId + " | ซ้ำ: " + (g.duplicateRecordIds || []).join(", ")
                  )
                )
              )
        )
      )
    );
  }

  // --------------------------------------------------------------------------
  // 5. McpConsoleView (Minimalist Developer Tool Runner)
  // --------------------------------------------------------------------------
  function McpConsoleView({ projectRoot }) {
    const mc = MissionControlController.useMissionControl();
    const ctrl = McpConsoleController.useController(projectRoot, mc ? mc.notify : null);

    return h(
      "div",
      { className: "pm-grid-2" },
      h(
        Card,
        {},
        h(
          CardHeader,
          {},
          h(
            CardTitle,
            {},
            h(LucideIcon, { name: "wrench", size: 17, color: "#6366f1" }),
            "ทดสอบคำสั่ง MCP (34 V2 Tools)"
          ),
          h(CardDescription, {}, "เลือกเครื่องมือและส่งพารามิเตอร์ JSON เพื่อทดสอบการทำงาน")
        ),
        h(
          CardContent,
          {},
          h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: "0.7rem" } },
            h(
              Select,
              {
                id: "mcp-tool-select",
                value: ctrl.selectedTool,
                onChange: (e) => ctrl.setSelectedTool(e.target.value),
              },
              MCP_TOOLS_LIST.map((t) =>
                h("option", { key: t.name, value: t.name }, t.name + " — " + t.description)
              )
            ),
            h(Textarea, {
              id: "mcp-tool-args",
              rows: 6,
              value: ctrl.rawArgs,
              onChange: (e) => ctrl.setRawArgs(e.target.value),
              style: { fontFamily: "monospace" },
            }),
            h(
              Button,
              { variant: "default", onClick: ctrl.executeTool, disabled: ctrl.invokeMutation.isPending },
              h(LucideIcon, { name: "play", size: 13 }),
              ctrl.invokeMutation.isPending ? "กำลังรัน..." : "รันคำสั่ง (Execute)"
            )
          )
        )
      ),
      h(
        Card,
        {},
        h(
          CardHeader,
          {},
          h(
            CardTitle,
            {},
            h(LucideIcon, { name: "terminal", size: 17, color: "#10b981" }),
            "ผลลัพธ์ (Response Output)"
          ),
          h(CardDescription, {}, "ข้อมูล JSON ที่ส่งกลับจากคลังความจำ V2")
        ),
        h(
          CardContent,
          {},
          h(
            "pre",
            {
              style: {
                background: "hsl(var(--background))",
                padding: "0.85rem",
                borderRadius: "var(--radius)",
                border: "1px solid hsl(var(--border))",
                fontSize: "0.75rem",
                maxHeight: "360px",
                overflowY: "auto",
                margin: 0,
              },
            },
            ctrl.output
          )
        )
      )
    );
  }

  // --------------------------------------------------------------------------
  // 6. MissionControlShellView (Minimalist Pro Sidebar + Topbar Shell)
  // --------------------------------------------------------------------------
  function renderHumanMarkdownBlocks(rawText) {
    const lines = String(rawText || "").split("\\n");
    return lines
      .filter((l) => l.trim().length > 0)
      .map((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("# ")) {
          return h(
            "h4",
            { key: idx, style: { margin: "0.6rem 0 0.25rem", fontSize: "0.95rem", fontWeight: 700, color: "hsl(var(--primary))" } },
            trimmed.slice(2)
          );
        }
        if (trimmed.startsWith("## ") || trimmed.startsWith("### ")) {
          return h(
            "div",
            { key: idx, style: { margin: "0.5rem 0 0.2rem", fontSize: "0.86rem", fontWeight: 700 } },
            trimmed.replace(/^#+\\s*/, "")
          );
        }
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ") || /^\\d+\\.\\s/.test(trimmed)) {
          return h(
            "div",
            {
              key: idx,
              style: {
                display: "flex",
                alignItems: "flex-start",
                gap: "0.45rem",
                paddingLeft: "0.35rem",
                margin: "0.22rem 0",
                fontSize: "0.83rem",
                lineHeight: 1.55,
              },
            },
            h("span", { style: { color: "#6366f1", fontWeight: 700 } }, "•"),
            h("span", {}, trimmed.replace(/^[-*]\\s+|\\d+\\.\\s+/, ""))
          );
        }
        return h(
          "p",
          { key: idx, style: { margin: "0.3rem 0", fontSize: "0.84rem", lineHeight: 1.6 } },
          trimmed
        );
      });
  }

  function MissionControlShellView({ defaultProjectRoot }) {
    const mc = MissionControlController.useController(defaultProjectRoot);
    const [showRawJson, setShowRawJson] = useState(false);
    const projects = (mc.projectsQuery.data && mc.projectsQuery.data.projects) || [];
    const inspectedNote = mc.noteDetailQuery.data && mc.noteDetailQuery.data.note;

    const navItems = [
      { id: "overview", icon: "layout-dashboard", label: "ภาพรวม & กราฟ", sub: "Overview & Analytics" },
      { id: "kanban", icon: "kanban", label: "จัดการความจำ", sub: "Kanban & Table" },
      { id: "graph", icon: "network", label: "กราฟเชื่อมโยง", sub: "Knowledge Graph" },
      { id: "curator", icon: "bot", label: "ผู้ช่วย AI ดูแลความจำ", sub: "AI Memory Curator" },
      { id: "mcp", icon: "wrench", label: "เครื่องมือนักพัฒนา", sub: "34 MCP Tools" },
    ];

    return h(
      MissionControlController.Context.Provider,
      { value: mc },
      h(
        "div",
        { className: "pm-shell" },
        // Minimalist Pro Left Sidebar
        h(
          "aside",
          { className: "pm-sidebar" },
          h(
            "div",
            {},
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "0.7rem", padding: "0 0.4rem" } },
              h(
                "div",
                {
                  style: {
                    width: "34px",
                    height: "34px",
                    borderRadius: "0.55rem",
                    background: "linear-gradient(135deg, #6366f1, #10b981)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                    fontWeight: 800,
                    fontSize: "0.85rem",
                  },
                },
                h(LucideIcon, { name: "cpu", size: 18, color: "#fff" })
              ),
              h(
                "div",
                {},
                h("div", { style: { fontWeight: 700, fontSize: "0.92rem" } }, "Memory Studio"),
                h(
                  "div",
                  { style: { fontSize: "0.7rem", color: "hsl(var(--muted-foreground))" } },
                  "Project Memory V2"
                )
              )
            ),
            h(
              "nav",
              { className: "pm-nav-list" },
              navItems.map((item) =>
                h(
                  "button",
                  {
                    key: item.id,
                    className:
                      "pm-nav-item " + (mc.activeTab === item.id ? "pm-nav-item-active" : ""),
                    onClick: () => mc.setActiveTab(item.id),
                  },
                  h(LucideIcon, { name: item.icon, size: 17 }),
                  h(
                    "div",
                    { style: { display: "flex", flexDirection: "column" } },
                    h("span", {}, item.label),
                    h(
                      "span",
                      { style: { fontSize: "0.68rem", opacity: 0.7 } },
                      item.sub
                    )
                  )
                )
              )
            )
          ),
          h(
            "div",
            {
              style: {
                padding: "0.75rem",
                borderRadius: "calc(var(--radius) - 2px)",
                background: "hsl(var(--secondary))",
                fontSize: "0.73rem",
                color: "hsl(var(--muted-foreground))",
              },
            },
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "0.35rem", fontWeight: 600, color: "hsl(var(--foreground))" } },
              h(LucideIcon, { name: "zap", size: 13, color: "#f59e0b" }),
              "สถาปัตยกรรม MVC"
            ),
            h("div", {}, "React + TanStack + shadcn/ui + Lucide")
          )
        ),

        // Main Area
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", minWidth: 0 } },
          h(
            "header",
            { className: "pm-topbar" },
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" } },
              h(
                "span",
                { style: { display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.82rem", color: "hsl(var(--muted-foreground))" } },
                h(LucideIcon, { name: "folder", size: 15, color: "#6366f1" }),
                "โปรเจกต์:"
              ),
              h(
                Select,
                {
                  id: "project-switcher-select",
                  value: mc.currentProject,
                  onChange: (e) => mc.switchProject(e.target.value),
                  style: { width: "260px" },
                },
                projects.length === 0
                  ? h("option", { value: mc.currentProject }, mc.currentProject)
                  : projects.map((p) =>
                      h(
                        "option",
                        { key: p.projectRoot, value: p.projectRoot },
                        p.name + " (" + p.mode + ")"
                      )
                    )
              )
            ),
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" } },
              h(
                Button,
                { variant: "outline", size: "sm", onClick: mc.toggleTheme },
                h(LucideIcon, { name: mc.theme === "dark" ? "sun" : "moon", size: 14 }),
                mc.theme === "dark" ? "โหมดสว่าง (Light)" : "โหมดมืด (Dark)"
              ),
              h(
                Button,
                { variant: "secondary", size: "sm", onClick: mc.refreshAll },
                h(LucideIcon, { name: "refresh-cw", size: 13 }),
                "รีเฟรชข้อมูล"
              ),
              h(
                Button,
                { variant: "emerald", size: "sm", onClick: () => mc.setActiveTab("curator") },
                h(LucideIcon, { name: "sparkles", size: 14 }),
                "ให้ AI จัดระเบียบ"
              )
            )
          ),
          mc.toastMessage
            ? h(
                "div",
                {
                  style: {
                    margin: "0.75rem 1.75rem 0",
                    padding: "0.6rem 1rem",
                    borderRadius: "var(--radius)",
                    background: "hsla(var(--primary), 0.14)",
                    border: "1px solid hsla(var(--primary), 0.35)",
                    fontSize: "0.81rem",
                  },
                },
                mc.toastMessage.text
              )
            : null,
          h(
            "main",
            { className: "pm-content" },
            mc.activeTab === "overview"
              ? h("pm-overview-panel", { "project-root": mc.currentProject })
              : null,
            mc.activeTab === "kanban"
              ? h("pm-kanban-board", { "project-root": mc.currentProject })
              : null,
            mc.activeTab === "graph"
              ? h("pm-knowledge-graph", { "project-root": mc.currentProject })
              : null,
            mc.activeTab === "curator"
              ? h("pm-curator-studio", { "project-root": mc.currentProject })
              : null,
            mc.activeTab === "mcp"
              ? h("pm-mcp-console", { "project-root": mc.currentProject })
              : null
          )
        ),
        h(
          Dialog,
          { open: Boolean(mc.inspectedRecordId), onOpenChange: (open) => !open && mc.closeInspectModal() },
          h(
            "div",
            { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.85rem" } },
            h(
              "h3",
              { style: { display: "inline-flex", alignItems: "center", gap: "0.45rem", margin: 0, fontSize: "1.02rem" } },
              h(LucideIcon, { name: "file-text", size: 18, color: "#6366f1" }),
              "รายละเอียดความจำ (Human-Readable Memory View)"
            ),
            h(
              Button,
              { variant: "secondary", size: "sm", onClick: mc.closeInspectModal },
              h(LucideIcon, { name: "x", size: 14 }),
              "ปิดหน้าต่าง"
            )
          ),
          !inspectedNote
            ? h("div", { style: { padding: "1rem", fontSize: "0.85rem" } }, "กำลังโหลดข้อมูลความจำ...")
            : h(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: "0.85rem" } },
                h(
                  "div",
                  { style: { display: "flex", gap: "0.45rem", alignItems: "center", flexWrap: "wrap" } },
                  h(
                    Badge,
                    { variant: "default" },
                    h(LucideIcon, { name: "layers", size: 11 }),
                    String(inspectedNote.recordKind || inspectedNote.kind || "insight").toUpperCase()
                  ),
                  h(
                    Badge,
                    { variant: statusBadgeVariant(inspectedNote.status) },
                    inspectedNote.status === "verified"
                      ? "ยืนยันความถูกต้องแล้ว (Verified)"
                      : String(inspectedNote.status || "provisional")
                  )
                ),
                h(
                  "h2",
                  { style: { margin: 0, fontSize: "1.15rem", fontWeight: 700, lineHeight: 1.35 } },
                  inspectedNote.title || inspectedNote.recordId
                ),
                h(
                  "div",
                  {
                    style: {
                      padding: "0.85rem 1rem",
                      borderRadius: "var(--radius)",
                      background: "hsla(var(--primary), 0.1)",
                      border: "1px solid hsla(var(--primary), 0.3)",
                    },
                  },
                  h(
                    "div",
                    { style: { display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.75rem", fontWeight: 700, color: "hsl(var(--primary))", marginBottom: "0.25rem" } },
                    h(LucideIcon, { name: "sparkles", size: 13, color: "#f59e0b" }),
                    "สรุปใจความสำคัญ (Key Takeaway)"
                  ),
                  h(
                    "div",
                    { style: { fontSize: "0.86rem", lineHeight: 1.6 } },
                    inspectedNote.summary || inspectedNote.text || inspectedNote.title
                  )
                ),
                inspectedNote.body || inspectedNote.content
                  ? h(
                      "div",
                      {
                        style: {
                          padding: "0.95rem 1.05rem",
                          borderRadius: "var(--radius)",
                          background: "hsl(var(--background))",
                          border: "1px solid hsl(var(--border))",
                        },
                      },
                      renderHumanMarkdownBlocks(inspectedNote.body || inspectedNote.content)
                    )
                  : null,
                h(
                  "div",
                  { style: { display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: "0.35rem" } },
                  h(
                    Button,
                    { variant: "ghost", size: "sm", onClick: () => setShowRawJson(!showRawJson) },
                    h(LucideIcon, { name: showRawJson ? "chevron-up" : "chevron-down", size: 13 }),
                    showRawJson ? "ซ่อนข้อมูลเทคนิค (Raw JSON)" : "ดูข้อมูลเทคนิคสำหรับนักพัฒนา (Raw JSON)"
                  )
                ),
                showRawJson
                  ? h(
                      "pre",
                      {
                        style: {
                          background: "hsl(var(--background))",
                          padding: "0.85rem",
                          borderRadius: "var(--radius)",
                          border: "1px solid hsl(var(--border))",
                          fontSize: "0.73rem",
                          overflowX: "auto",
                          margin: 0,
                        },
                      },
                      JSON.stringify(inspectedNote, null, 2)
                    )
                  : null
              )
        )
      )
    );
  }

  global.PM_MVC_VIEWS = {
    HealthGaugeChart,
    DistributionDonutChart,
    ActivityAreaChart,
    SessionActivityMap,
    OverviewView,
    KanbanBoardView,
    KnowledgeGraphView,
    CuratorStudioView,
    McpConsoleView,
    MissionControlShellView,
  };
})(window);
`;
}

export function renderWebComponentsJs(): string {
  return `// ============================================================================
// Project Memory V2 WebUI — W3C Custom Elements (React Web Components Layer)
// Endpoint: /mvc/web-components.js
// Custom Elements:
//   - <pm-stat-card>
//   - <pm-health-gauge>
//   - <pm-distribution-chart>
//   - <pm-activity-chart>
//   - <pm-session-activity-map>
//   - <pm-overview-panel>
//   - <pm-kanban-board>
//   - <pm-knowledge-graph>
//   - <pm-curator-studio>
//   - <pm-mcp-console>
//   - <pm-mission-control>
// ============================================================================
(function (global) {
  const { h } = global.React;
  const { createRoot } = global.ReactDOM;
  const { QueryClient, QueryClientProvider } = global.TanStackQuery;
  const { Card, CardHeader, CardDescription, CardContent } = global.ShadcnUI;
  const {
    HealthGaugeChart,
    DistributionDonutChart,
    ActivityAreaChart,
    SessionActivityMap,
    OverviewView,
    KanbanBoardView,
    KnowledgeGraphView,
    CuratorStudioView,
    McpConsoleView,
    MissionControlShellView,
  } = global.PM_MVC_VIEWS;

  const sharedQueryClient = new QueryClient();

  function StatCardComponent({ label, value, tone, subtitle }) {
    const color =
      tone === "emerald"
        ? "#10b981"
        : tone === "amber"
          ? "#f59e0b"
          : tone === "rose"
            ? "#ef4444"
            : "#6366f1";
    return h(
      Card,
      {},
      h(
        CardHeader,
        { style: { paddingBottom: "0.2rem" } },
        h(CardDescription, {}, label || "")
      ),
      h(
        CardContent,
        {},
        h("div", { style: { fontSize: "1.75rem", fontWeight: 800, color, letterSpacing: "-0.02em" } }, value || "0"),
        subtitle
          ? h("div", { style: { fontSize: "0.72rem", color: "hsl(var(--muted-foreground))", marginTop: "0.15rem" } }, subtitle)
          : null
      )
    );
  }

  function createReactWebComponent(tagName, ReactComponent, attrMap = {}) {
    class ReactCustomElement extends HTMLElement {
      static get observedAttributes() {
        return Object.keys(attrMap);
      }
      constructor() {
        super();
        this._root = null;
      }
      connectedCallback() {
        if (!this._root) {
          this._root = createRoot(this);
        }
        this._renderReact();
      }
      attributeChangedCallback() {
        if (this._root) {
          this._renderReact();
        }
      }
      disconnectedCallback() {
        if (this._root) {
          this._root.unmount();
          this._root = null;
        }
      }
      _renderReact() {
        const props = {};
        for (const [attrName, propName] of Object.entries(attrMap)) {
          props[propName] = this.getAttribute(attrName) || "";
        }
        this._root.render(
          h(QueryClientProvider, { client: sharedQueryClient }, h(ReactComponent, props))
        );
      }
    }
    if (!customElements.get(tagName)) {
      customElements.define(tagName, ReactCustomElement);
    }
  }

  createReactWebComponent("pm-stat-card", StatCardComponent, {
    label: "label",
    value: "value",
    tone: "tone",
    subtitle: "subtitle",
  });

  createReactWebComponent("pm-health-gauge", HealthGaugeChart, {
    score: "score",
    verified: "verified",
    candidates: "candidates",
    conflicts: "conflicts",
  });

  createReactWebComponent("pm-distribution-chart", DistributionDonutChart, {
    adr: "adr",
    insight: "insight",
    mistake: "mistake",
    "session-log": "sessionLog",
  });

  createReactWebComponent("pm-activity-chart", ActivityAreaChart, {
    "series-json": "seriesJson",
  });

  createReactWebComponent("pm-session-activity-map", SessionActivityMap, {
    "sessions-json": "sessionsJson",
  });

  createReactWebComponent("pm-overview-panel", OverviewView, { "project-root": "projectRoot" });
  createReactWebComponent("pm-kanban-board", KanbanBoardView, { "project-root": "projectRoot" });
  createReactWebComponent("pm-knowledge-graph", KnowledgeGraphView, { "project-root": "projectRoot" });
  createReactWebComponent("pm-curator-studio", CuratorStudioView, { "project-root": "projectRoot" });
  createReactWebComponent("pm-mcp-console", McpConsoleView, { "project-root": "projectRoot" });
  createReactWebComponent("pm-mission-control", MissionControlShellView, {
    "default-project": "defaultProjectRoot",
  });

  // Explicit Custom Element registration markers:
  // customElements.define("pm-health-gauge"
  // customElements.define("pm-distribution-chart"
  // customElements.define("pm-activity-chart"
  // customElements.define("pm-session-activity-map"
  // customElements.define("pm-mission-control"
  // customElements.define("pm-overview-panel"
  // customElements.define("pm-kanban-board"
  // customElements.define("pm-knowledge-graph"
  // customElements.define("pm-curator-studio"
  // customElements.define("pm-mcp-console"
})(window);
`;
}

export function renderMvcIndexHtml(defaultProjectRoot: string): string {
  return `<!DOCTYPE html>
<html lang="th" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Project Memory V2 — Minimalist Pro Studio, Analytics & AI Memory Curator</title>
  <style>${renderShadcnThemeCss()}</style>
</head>
<body>
  <!-- W3C Custom Element (React Web Component Root) -->
  <pm-mission-control default-project="${escapeHtml(defaultProjectRoot)}"></pm-mission-control>

  <!-- Modular MVC + React + TanStack + shadcn/ui + Web Components Bundle -->
  <script src="/mvc/vendor.js"></script>
  <script src="/mvc/models.js"></script>
  <script src="/mvc/controllers.js"></script>
  <script src="/mvc/shadcn-ui.js"></script>
  <script src="/mvc/views.js"></script>
  <script src="/mvc/web-components.js"></script>
</body>
</html>`;
}
