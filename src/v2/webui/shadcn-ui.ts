export function renderShadcnThemeCss(): string {
  return `
  :root, .dark {
    --background: 240 10% 3.9%;
    --foreground: 0 0% 98%;
    --card: 240 10% 6.2%;
    --card-foreground: 0 0% 98%;
    --popover: 240 10% 5%;
    --popover-foreground: 0 0% 98%;
    --primary: 239 84% 67%;
    --primary-foreground: 0 0% 100%;
    --secondary: 240 4.8% 13.5%;
    --secondary-foreground: 0 0% 98%;
    --muted: 240 3.7% 14%;
    --muted-foreground: 240 5% 64.9%;
    --accent: 240 3.7% 17.5%;
    --accent-foreground: 0 0% 98%;
    --destructive: 0 72.2% 50.6%;
    --destructive-foreground: 0 0% 98%;
    --success: 160 84% 39%;
    --warning: 38 92% 50%;
    --border: 240 3.7% 15.9%;
    --input: 240 3.7% 15.9%;
    --ring: 239 84% 67%;
    --radius: 0.75rem;
  }

  .light {
    --background: 0 0% 99%;
    --foreground: 240 10% 3.9%;
    --card: 0 0% 100%;
    --card-foreground: 240 10% 3.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 240 10% 3.9%;
    --primary: 239 84% 60%;
    --primary-foreground: 0 0% 100%;
    --secondary: 240 4.8% 95.9%;
    --secondary-foreground: 240 5.9% 10%;
    --muted: 240 4.8% 95.9%;
    --muted-foreground: 240 3.8% 44%;
    --accent: 240 4.8% 93%;
    --accent-foreground: 240 5.9% 10%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 0 0% 98%;
    --success: 160 84% 35%;
    --warning: 38 92% 45%;
    --border: 240 5.9% 90%;
    --input: 240 5.9% 90%;
    --ring: 239 84% 60%;
  }

  * {
    box-sizing: border-box;
    border-color: hsl(var(--border));
  }

  body {
    margin: 0;
    background-color: hsl(var(--background));
    color: hsl(var(--foreground));
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    transition: background-color 0.2s ease, color 0.2s ease;
  }

  /* Minimalist Pro App Shell (Sidebar + Main) */
  .pm-shell {
    display: grid;
    grid-template-columns: 250px 1fr;
    min-height: 100vh;
  }
  .pm-sidebar {
    border-right: 1px solid hsl(var(--border));
    background-color: hsla(var(--card), 0.75);
    padding: 1.25rem 0.9rem;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    position: sticky;
    top: 0;
    height: 100vh;
  }
  .pm-nav-list {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-top: 1.25rem;
  }
  .pm-nav-item {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    width: 100%;
    text-align: left;
    padding: 0.58rem 0.8rem;
    border-radius: calc(var(--radius) - 3px);
    border: 1px solid transparent;
    background: transparent;
    color: hsl(var(--muted-foreground));
    font-size: 0.84rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .pm-nav-item:hover {
    background-color: hsl(var(--secondary));
    color: hsl(var(--foreground));
  }
  .pm-nav-item-active {
    background-color: hsla(var(--primary), 0.14);
    color: hsl(var(--primary));
    border-color: hsla(var(--primary), 0.28);
    font-weight: 600;
  }
  .pm-topbar {
    position: sticky;
    top: 0;
    z-index: 25;
    backdrop-filter: blur(12px);
    background-color: hsla(var(--background), 0.82);
    border-bottom: 1px solid hsl(var(--border));
    padding: 0.85rem 1.75rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .pm-content {
    padding: 1.5rem 1.75rem 2.5rem;
    max-width: 1540px;
    width: 100%;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  /* shadcn/ui Minimalist Primitives */
  .sh-card {
    border-radius: var(--radius);
    border: 1px solid hsl(var(--border));
    background-color: hsl(var(--card));
    color: hsl(var(--card-foreground));
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
    transition: border-color 0.15s ease, transform 0.15s ease;
  }
  .sh-card-header {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 1.15rem 1.25rem 0.55rem;
  }
  .sh-card-title {
    font-size: 0.94rem;
    font-weight: 600;
    letter-spacing: -0.015em;
    margin: 0;
  }
  .sh-card-desc {
    font-size: 0.78rem;
    color: hsl(var(--muted-foreground));
    margin: 0;
  }
  .sh-card-content {
    padding: 0.65rem 1.25rem 1.25rem;
  }
  .sh-card-footer {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0 1.25rem 1.1rem;
  }

  .sh-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    white-space: nowrap;
    border-radius: calc(var(--radius) - 3px);
    font-size: 0.81rem;
    font-weight: 500;
    transition: all 0.15s ease;
    cursor: pointer;
    border: 1px solid transparent;
    padding: 0.45rem 0.85rem;
  }
  .sh-btn:disabled {
    opacity: 0.5;
    pointer-events: none;
  }
  .sh-btn-default {
    background-color: hsl(var(--primary));
    color: hsl(var(--primary-foreground));
  }
  .sh-btn-default:hover { filter: brightness(1.08); }
  .sh-btn-secondary {
    background-color: hsl(var(--secondary));
    color: hsl(var(--secondary-foreground));
    border-color: hsl(var(--border));
  }
  .sh-btn-secondary:hover { background-color: hsl(var(--accent)); }
  .sh-btn-outline {
    background-color: transparent;
    color: hsl(var(--foreground));
    border-color: hsl(var(--border));
  }
  .sh-btn-outline:hover { background-color: hsl(var(--accent)); }
  .sh-btn-ghost {
    background-color: transparent;
    color: hsl(var(--muted-foreground));
  }
  .sh-btn-ghost:hover {
    background-color: hsl(var(--accent));
    color: hsl(var(--foreground));
  }
  .sh-btn-destructive {
    background-color: hsla(var(--destructive), 0.16);
    color: #f87171;
    border-color: hsla(var(--destructive), 0.35);
  }
  .sh-btn-emerald {
    background-color: hsl(var(--success));
    color: #fff;
  }
  .sh-btn-sm {
    padding: 0.26rem 0.6rem;
    font-size: 0.74rem;
  }
  .lucide {
    display: inline-block;
    vertical-align: middle;
    flex-shrink: 0;
  }
  .sh-card-title {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
  }

  .sh-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    border-radius: 9999px;
    border: 1px solid transparent;
    padding: 0.1rem 0.55rem;
    font-size: 0.71rem;
    font-weight: 600;
  }
  .sh-badge-default {
    background-color: hsla(var(--primary), 0.14);
    color: hsl(var(--primary));
    border-color: hsla(var(--primary), 0.3);
  }
  .sh-badge-secondary {
    background-color: hsl(var(--secondary));
    color: hsl(var(--secondary-foreground));
  }
  .sh-badge-outline {
    background-color: transparent;
    color: hsl(var(--muted-foreground));
    border-color: hsl(var(--border));
  }
  .sh-badge-success {
    background-color: hsla(var(--success), 0.15);
    color: #10b981;
    border-color: hsla(var(--success), 0.3);
  }
  .sh-badge-warning {
    background-color: hsla(var(--warning), 0.15);
    color: #f59e0b;
    border-color: hsla(var(--warning), 0.3);
  }
  .sh-badge-destructive {
    background-color: hsla(var(--destructive), 0.15);
    color: #ef4444;
    border-color: hsla(var(--destructive), 0.3);
  }

  .sh-input, .sh-select, .sh-textarea {
    display: flex;
    width: 100%;
    border-radius: calc(var(--radius) - 3px);
    border: 1px solid hsl(var(--input));
    background-color: hsl(var(--background));
    padding: 0.45rem 0.75rem;
    font-size: 0.82rem;
    color: hsl(var(--foreground));
    outline: none;
  }
  .sh-input:focus, .sh-select:focus, .sh-textarea:focus {
    border-color: hsl(var(--ring));
    box-shadow: 0 0 0 2px hsla(var(--ring), 0.2);
  }

  .sh-tabs-list {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    border-radius: calc(var(--radius) - 2px);
    background-color: hsl(var(--secondary));
    padding: 0.25rem;
    border: 1px solid hsl(var(--border));
  }
  .sh-tabs-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
    border-radius: calc(var(--radius) - 4px);
    padding: 0.36rem 0.8rem;
    font-size: 0.79rem;
    font-weight: 500;
    color: hsl(var(--muted-foreground));
    background: transparent;
    border: none;
    cursor: pointer;
    transition: all 0.15s;
  }
  .sh-tabs-trigger-active {
    background-color: hsl(var(--card));
    color: hsl(var(--foreground));
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  }

  .sh-table-wrap {
    width: 100%;
    overflow-x: auto;
    border-radius: calc(var(--radius) - 2px);
    border: 1px solid hsl(var(--border));
  }
  .sh-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.81rem;
  }
  .sh-th {
    height: 2.4rem;
    padding: 0 0.85rem;
    text-align: left;
    vertical-align: middle;
    font-weight: 600;
    color: hsl(var(--muted-foreground));
    background-color: hsla(var(--secondary), 0.5);
    border-bottom: 1px solid hsl(var(--border));
    user-select: none;
  }
  .sh-td {
    padding: 0.6rem 0.85rem;
    vertical-align: middle;
    border-bottom: 1px solid hsl(var(--border));
  }
  .sh-tr:hover {
    background-color: hsla(var(--muted), 0.35);
  }

  .sh-alert {
    position: relative;
    width: 100%;
    border-radius: calc(var(--radius) - 2px);
    border: 1px solid hsl(var(--border));
    padding: 0.75rem 0.95rem;
    background-color: hsla(var(--secondary), 0.35);
    margin-bottom: 0.55rem;
  }
  .sh-alert-title {
    margin: 0 0 0.2rem;
    font-weight: 600;
    font-size: 0.84rem;
  }
  .sh-alert-desc {
    font-size: 0.78rem;
    color: hsl(var(--muted-foreground));
  }

  .sh-progress-track {
    width: 100%;
    height: 7px;
    background-color: hsl(var(--secondary));
    border-radius: 9999px;
    overflow: hidden;
  }
  .sh-progress-fill {
    height: 100%;
    border-radius: 9999px;
    transition: width 0.35s ease;
  }

  .sh-dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    background-color: rgba(0, 0, 0, 0.68);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
  }
  .sh-dialog-content {
    width: 100%;
    max-width: 740px;
    max-height: 85vh;
    overflow-y: auto;
    border-radius: var(--radius);
    border: 1px solid hsl(var(--border));
    background-color: hsl(var(--card));
    padding: 1.5rem;
    box-shadow: 0 20px 45px rgba(0, 0, 0, 0.5);
  }

  .pm-grid-4 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 0.9rem;
  }
  .pm-grid-3 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(310px, 1fr));
    gap: 1rem;
  }
  .pm-grid-2 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
    gap: 1rem;
  }
  .pm-kanban-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1rem;
  }
  @media (max-width: 1024px) {
    .pm-shell { grid-template-columns: 1fr; }
    .pm-sidebar { display: none; }
    .pm-kanban-grid { grid-template-columns: 1fr; }
  }
  `;
}

export function renderShadcnUiJs(): string {
  return `// ============================================================================
// Project Memory V2 WebUI — shadcn/ui Component Library (/mvc/shadcn-ui.js)
// Components: Button, Card, Badge, Tabs, Input, Textarea, Select, Table, Dialog, Alert, Separator, Progress
// ============================================================================
(function (global) {
  const { h } = global.React;

  function cn(...classes) {
    return classes.filter(Boolean).join(" ");
  }

  function Button({ variant = "default", size = "default", className = "", children, ...rest }) {
    const vClass = "sh-btn-" + variant;
    const sClass = size === "sm" ? "sh-btn-sm" : "";
    return h("button", { className: cn("sh-btn", vClass, sClass, className), ...rest }, ...(children || []));
  }

  function Card({ className = "", children, ...rest }) {
    return h("div", { className: cn("sh-card", className), ...rest }, ...(children || []));
  }
  function CardHeader({ className = "", children, ...rest }) {
    return h("div", { className: cn("sh-card-header", className), ...rest }, ...(children || []));
  }
  function CardTitle({ className = "", children, ...rest }) {
    return h("h3", { className: cn("sh-card-title", className), ...rest }, ...(children || []));
  }
  function CardDescription({ className = "", children, ...rest }) {
    return h("p", { className: cn("sh-card-desc", className), ...rest }, ...(children || []));
  }
  function CardContent({ className = "", children, ...rest }) {
    return h("div", { className: cn("sh-card-content", className), ...rest }, ...(children || []));
  }
  function CardFooter({ className = "", children, ...rest }) {
    return h("div", { className: cn("sh-card-footer", className), ...rest }, ...(children || []));
  }

  function Badge({ variant = "default", className = "", children, ...rest }) {
    return h(
      "span",
      { className: cn("sh-badge", "sh-badge-" + variant, className), ...rest },
      ...(children || [])
    );
  }

  function Input({ className = "", ...rest }) {
    return h("input", { className: cn("sh-input", className), ...rest });
  }
  function Textarea({ className = "", ...rest }) {
    return h("textarea", { className: cn("sh-textarea", className), ...rest });
  }
  function Select({ className = "", children, ...rest }) {
    return h("select", { className: cn("sh-select", className), ...rest }, ...(children || []));
  }

  function Tabs({ className = "", children }) {
    return h("div", { className: cn("sh-tabs", className) }, ...(children || []));
  }
  function TabsList({ className = "", children, ...rest }) {
    return h("div", { className: cn("sh-tabs-list", className), ...rest }, ...(children || []));
  }
  function TabsTrigger({ active = false, className = "", children, ...rest }) {
    return h(
      "button",
      {
        className: cn("sh-tabs-trigger", active ? "sh-tabs-trigger-active" : "", className),
        ...rest,
      },
      ...(children || [])
    );
  }
  function TabsContent({ active = false, className = "", children }) {
    if (!active) return null;
    return h("div", { className: cn("sh-tabs-content", className) }, ...(children || []));
  }

  function Table({ className = "", children }) {
    return h(
      "div",
      { className: "sh-table-wrap" },
      h("table", { className: cn("sh-table", className) }, ...(children || []))
    );
  }
  function TableHeader({ children }) {
    return h("thead", {}, ...(children || []));
  }
  function TableBody({ children }) {
    return h("tbody", {}, ...(children || []));
  }
  function TableRow({ className = "", children, ...rest }) {
    return h("tr", { className: cn("sh-tr", className), ...rest }, ...(children || []));
  }
  function TableHead({ className = "", children, ...rest }) {
    return h("th", { className: cn("sh-th", className), ...rest }, ...(children || []));
  }
  function TableCell({ className = "", children, ...rest }) {
    return h("td", { className: cn("sh-td", className), ...rest }, ...(children || []));
  }

  function Alert({ className = "", children, ...rest }) {
    return h("div", { className: cn("sh-alert", className), ...rest }, ...(children || []));
  }
  function AlertTitle({ className = "", children }) {
    return h("div", { className: cn("sh-alert-title", className) }, ...(children || []));
  }
  function AlertDescription({ className = "", children }) {
    return h("div", { className: cn("sh-alert-desc", className) }, ...(children || []));
  }

  function Progress({ value = 0, color = "#6366f1" }) {
    const pct = Math.max(0, Math.min(100, Number(value) || 0));
    return h(
      "div",
      { className: "sh-progress-track" },
      h("div", {
        className: "sh-progress-fill",
        style: { width: pct + "%", backgroundColor: color },
      })
    );
  }

  function Dialog({ open = false, onOpenChange, children }) {
    if (!open) return null;
    return h(
      "div",
      {
        className: "sh-dialog-backdrop",
        onClick: (e) => {
          if (e.target === e.currentTarget && onOpenChange) onOpenChange(false);
        },
      },
      h("div", { className: "sh-dialog-content" }, ...(children || []))
    );
  }

  function Separator({ className = "" }) {
    return h("hr", {
      className: cn("sh-separator", className),
      style: { border: "none", borderTop: "1px solid hsl(var(--border))", margin: "0.85rem 0" },
    });
  }

  const LUCIDE_ICON_NODES = {
    "layout-dashboard": [
      ["rect", { width: "7", height: "9", x: "3", y: "3", rx: "1" }],
      ["rect", { width: "7", height: "5", x: "14", y: "3", rx: "1" }],
      ["rect", { width: "7", height: "9", x: "14", y: "12", rx: "1" }],
      ["rect", { width: "7", height: "5", x: "3", y: "16", rx: "1" }],
    ],
    kanban: [
      ["path", { d: "M6 5v11" }],
      ["path", { d: "M12 5v6" }],
      ["path", { d: "M18 5v14" }],
    ],
    network: [
      ["rect", { x: "16", y: "16", width: "6", height: "6", rx: "1" }],
      ["rect", { x: "2", y: "16", width: "6", height: "6", rx: "1" }],
      ["rect", { x: "9", y: "2", width: "6", height: "6", rx: "1" }],
      ["path", { d: "M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" }],
      ["path", { d: "M12 12V8" }],
    ],
    bot: [
      ["path", { d: "M12 8V4H8" }],
      ["rect", { width: "16", height: "12", x: "4", y: "8", rx: "2" }],
      ["path", { d: "M2 14h2" }],
      ["path", { d: "M20 14h2" }],
      ["path", { d: "M15 13v2" }],
      ["path", { d: "M9 13v2" }],
    ],
    wrench: [
      ["path", { d: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" }],
    ],
    gauge: [
      ["path", { d: "m12 14 4-4" }],
      ["path", { d: "M3.34 19a10 10 0 1 1 17.32 0" }],
    ],
    "pie-chart": [
      ["path", { d: "M21.21 15.89A10 10 0 1 1 8 2.83" }],
      ["path", { d: "M22 12A10 10 0 0 0 12 2v10z" }],
    ],
    "trending-up": [
      ["polyline", { points: "22 7 13.5 15.5 8.5 10.5 2 17" }],
      ["polyline", { points: "16 7 22 7 22 13" }],
    ],
    cpu: [
      ["rect", { width: "16", height: "16", x: "4", y: "4", rx: "2" }],
      ["rect", { width: "6", height: "6", x: "9", y: "9", rx: "1" }],
      ["path", { d: "M15 2v2" }],
      ["path", { d: "M15 20v2" }],
      ["path", { d: "M2 15h2" }],
      ["path", { d: "M2 9h2" }],
      ["path", { d: "M20 15h2" }],
      ["path", { d: "M20 9h2" }],
      ["path", { d: "M9 2v2" }],
      ["path", { d: "M9 20v2" }],
    ],
    sparkles: [
      ["path", { d: "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" }],
      ["path", { d: "M20 3v4" }],
      ["path", { d: "M22 5h-4" }],
    ],
    "check-circle-2": [
      ["circle", { cx: "12", cy: "12", r: "10" }],
      ["path", { d: "m9 12 2 2 4-4" }],
    ],
    clock: [
      ["circle", { cx: "12", cy: "12", r: "10" }],
      ["polyline", { points: "12 6 12 12 16 14" }],
    ],
    "alert-triangle": [
      ["path", { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" }],
      ["path", { d: "M12 9v4" }],
      ["path", { d: "M12 17h.01" }],
    ],
    landmark: [
      ["line", { x1: "3", x2: "21", y1: "22", y2: "22" }],
      ["line", { x1: "6", x2: "6", y1: "18", y2: "11" }],
      ["line", { x1: "10", x2: "10", y1: "18", y2: "11" }],
      ["line", { x1: "14", x2: "14", y1: "18", y2: "11" }],
      ["line", { x1: "18", x2: "18", y1: "18", y2: "11" }],
      ["polygon", { points: "12 2 20 7 4 7" }],
    ],
    lightbulb: [
      ["path", { d: "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" }],
      ["path", { d: "M9 18h6" }],
      ["path", { d: "M10 22h4" }],
    ],
    "file-text": [
      ["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" }],
      ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4" }],
      ["path", { d: "M10 9H8" }],
      ["path", { d: "M16 13H8" }],
      ["path", { d: "M16 17H8" }],
    ],
    "code-2": [
      ["path", { d: "m18 16 4-4-4-4" }],
      ["path", { d: "m6 8-4 4 4 4" }],
      ["path", { d: "m14.5 4-5 16" }],
    ],
    sun: [
      ["circle", { cx: "12", cy: "12", r: "4" }],
      ["path", { d: "M12 2v2" }],
      ["path", { d: "M12 20v2" }],
      ["path", { d: "m4.93 4.93 1.41 1.41" }],
      ["path", { d: "m17.66 17.66 1.41 1.41" }],
      ["path", { d: "M2 12h2" }],
      ["path", { d: "M20 12h2" }],
      ["path", { d: "m6.34 17.66-1.41 1.41" }],
      ["path", { d: "m19.07 4.93-1.41 1.41" }],
    ],
    moon: [
      ["path", { d: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" }],
    ],
    "refresh-cw": [
      ["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }],
      ["path", { d: "M21 3v5h-5" }],
      ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }],
      ["path", { d: "M8 16H3v5" }],
    ],
    search: [
      ["circle", { cx: "11", cy: "11", r: "8" }],
      ["path", { d: "m21 21-4.3-4.3" }],
    ],
    plus: [
      ["path", { d: "M5 12h14" }],
      ["path", { d: "M12 5v14" }],
    ],
    minus: [
      ["path", { d: "M5 12h14" }],
    ],
    x: [
      ["path", { d: "M18 6 6 18" }],
      ["path", { d: "m6 6 12 12" }],
    ],
    check: [
      ["path", { d: "M20 6 9 17l-5-5" }],
    ],
    play: [
      ["polygon", { points: "6 3 20 12 6 21 6 3" }],
    ],
    send: [
      ["path", { d: "m22 2-7 20-4-9-9-4Z" }],
      ["path", { d: "M22 2 11 13" }],
    ],
    folder: [
      ["path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }],
    ],
    "table-2": [
      ["path", { d: "M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18" }],
    ],
    "git-branch": [
      ["line", { x1: "6", x2: "6", y1: "3", y2: "15" }],
      ["circle", { cx: "18", cy: "6", r: "3" }],
      ["circle", { cx: "6", cy: "18", r: "3" }],
      ["path", { d: "M18 9a9 9 0 0 1-9 9" }],
    ],
    "shield-check": [
      ["path", { d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" }],
      ["path", { d: "m9 12 2 2 4-4" }],
    ],
    zap: [
      ["path", { d: "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" }],
    ],
    layers: [
      ["path", { d: "m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" }],
      ["path", { d: "m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" }],
      ["path", { d: "m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" }],
    ],
    "chevron-up": [["path", { d: "m18 15-6-6-6 6" }]],
    "chevron-down": [["path", { d: "m6 9 6 6 6-6" }]],
    "arrow-right": [
      ["path", { d: "M5 12h14" }],
      ["path", { d: "m12 5 7 7-7 7" }],
    ],
    activity: [
      ["path", { d: "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" }],
    ],
    terminal: [
      ["polyline", { points: "4 17 10 11 4 5" }],
      ["line", { x1: "12", x2: "20", y1: "19", y2: "19" }],
    ],
    circle: [["circle", { cx: "12", cy: "12", r: "8" }]],
  };

  function LucideIcon({ name, size = 16, color = "currentColor", strokeWidth = 2, className = "", style = {} }) {
    const shapes = LUCIDE_ICON_NODES[name] || LUCIDE_ICON_NODES.circle;
    return h(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        width: String(size),
        height: String(size),
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: color,
        "stroke-width": String(strokeWidth),
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        className: cn("lucide", "lucide-" + name, className),
        style,
      },
      ...shapes.map(([tag, attrs], idx) => h(tag, { key: idx, ...attrs }))
    );
  }

  global.ShadcnUI = {
    cn,
    LucideIcon,
    Icon: LucideIcon,
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
    TabsContent,
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
  };
})(window);
`;
}
