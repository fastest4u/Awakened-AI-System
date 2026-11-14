# WebUI Vite + React SPA Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the string-based `/mvc/*.js` Mission Control UI with a real Vite + React 19 + TypeScript SPA (TanStack Query + Router, shadcn/ui, lucide-react) served by the existing `node:http` WebUI server, with full feature parity.

**Architecture:** A standalone `webui/` npm package builds to `dist/webui/`. `src/v2/webui.ts` serves its `index.html` (CSRF + default-project meta injected per request) for an allowlist of SPA routes and serves `/assets/*` from a precomputed, gzip+ETag, immutable cache. The `/api/*` contract is unchanged except the additive `GET /api/bootstrap`. After parity, the legacy string runtime and its VM-based tests are deleted.

**Tech Stack:** Vite 8, React 19, TypeScript 5 strict, @tanstack/react-query 5, @tanstack/react-router 1, Tailwind CSS 4 (`@tailwindcss/vite`), shadcn/ui (new-york, zinc, CSS variables), lucide-react, recharts (shadcn chart), sonner, cmdk, Vitest 5 + jsdom + @testing-library/react + @testing-library/user-event; server side Node 24 `node:http` + `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-13-webui-vite-react-spa-design.md` (design + calls) and `docs/superpowers/specs/2026-11-13-webui-feature-inventory.md` (binding parity reference: Thai copy, element ids, caps, colors). Executors read both.

## Global Constraints

- Root `package.json` scripts `build`, `test`, `test:build-artifacts`, `test:all`, and root `package-lock.json` stay byte-identical except for the four added scripts `setup:webui`, `build:webui`, `test:webui`, `dev:webui`.
- All frontend dependencies live in `webui/package.json` + `webui/package-lock.json`; nothing frontend is added to the root.
- Vite `build.outDir` = `../dist/webui`, `emptyOutDir: true`, `build.sourcemap: false`, no inline `<script>`; output must run under the unchanged CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'`.
- Fonts self-hosted (`@fontsource-variable/inter`, `@fontsource/noto-sans-thai`); no CDN URLs anywhere.
- Document title exactly `Project Memory V2 — Memory Studio & AI Memory Curator`; `<html lang="th">`.
- Mutating requests send `content-type: application/json` and `X-PM-CSRF-Token`; on HTTP 403 with `error: "CSRF_TOKEN_INVALID"` the client re-fetches `/api/bootstrap` once and retries the request once.
- Query keys: `['pm-v2', projectRoot, <resource>, ...params]` (projects/tools: `['pm-v2', 'projects']`, `['pm-v2', 'mcp-tools']`); `staleTime: 15_000`; project-scoped invalidation = `invalidateQueries({ queryKey: ['pm-v2', projectRoot] })`.
- SPA route paths: `/overview` (`/` redirects to it), `/kanban`, `/graph`, `/curator`, `/mcp`; shared search params `project`, `note`, `q`, `kind`, `status`, `node`, `session` (empty and `all` values are dropped).
- `localStorage` theme key `pm-v2-theme` with values `dark` | `light`; default `dark`; applied as class on `<html>`.
- Every keydown handler that acts on Enter/shortcuts ignores events where `isComposing === true` or `keyCode === 229`.
- Thai UI copy, element ids, caps (≤3 files, ≤4 symbols, ≤56 graph nodes, ≤14 per flow column, ≤10 orbital spotlight labels), and colors are copied verbatim from the feature inventory.
- Component layering (reuse rule): `webui/src/components/ui/` = shadcn primitives only; `webui/src/components/shared/` = app-level reusable components used by 2+ features (`KindBadge`, `StatusBadge`, `CopyButton`, `EmptyState`, `StatCard`, `NoteBadgeList`); `webui/src/features/<view>/` composes them; `webui/src/lib/` = pure logic with no React imports except `markdown.tsx`. A feature never imports another feature's internals — if two features need a piece, it moves to `components/shared/` or `lib/`.
- `npm run typecheck`, `npm test`, `npm run test:build-artifacts`, `npm run test:webui`, `npm --prefix webui run typecheck`, and `npm run build:webui` all pass at the end of every task that touches their inputs.

## Review Focus

1. **Server restarted while the tab is open** (CSRF token rotated) → the next mutation must transparently recover via `/api/bootstrap` + one retry instead of failing; pinned in Task 3 (`client.test.ts › retries once after CSRF_TOKEN_INVALID`).
2. **Empty vault** (0 notes, 0 sessions, `activitySeries` all zeros) → Overview renders empty states and `0%`, never `NaN%`/crash; pinned in Task 5 (`overview.test.tsx › renders empty vault without NaN`).
3. **Thai IME composition** in quick entry, curator chat, and command palette → Enter while composing never submits; pinned in Task 6 and Task 8 IME tests.
4. **Huge graphs** (hundreds of nodes) → visible nodes stay within caps and selection still renders; pinned in Task 7 (`graph-layout.test.ts › caps 600 nodes to 56`).
5. **Hostile markdown** (`javascript:` links, raw HTML, object-typed body) → rendered as inert text, never `[object Object]`, never executed; pinned in Task 4 (`markdown.test.tsx`).

---

### Task 1: Scaffold the `webui/` Vite + React + shadcn package

**Files:**
- Create: `webui/package.json`, `webui/package-lock.json`, `webui/.gitignore` (`node_modules/`), `webui/index.html`, `webui/vite.config.ts`, `webui/vitest.config.ts` (or `test` block in vite config), `webui/tsconfig.json`, `webui/tsconfig.app.json`, `webui/tsconfig.node.json`, `webui/components.json`, `webui/src/main.tsx`, `webui/src/App.tsx`, `webui/src/index.css`, `webui/src/lib/utils.ts`, `webui/src/components/ui/*.tsx` (shadcn), `webui/src/test/setup.ts`
- Modify: `package.json` (add 4 scripts only)
- Test: `webui/src/App.test.tsx`

**Interfaces:**
- Produces: `cn(...inputs: ClassValue[]): string` in `webui/src/lib/utils.ts`; shadcn components under `@/components/ui/<name>` for: button, card, badge, input, textarea, select, dialog, alert-dialog, sheet, tabs, table, tooltip, dropdown-menu, separator, skeleton, scroll-area, progress, checkbox, label, toggle-group, command, sonner, chart, popover, alert, collapsible, switch; path alias `@/*` → `webui/src/*`; Tailwind theme tokens incl. custom `--success` and `--warning` (inventory §5 values, converted to the shadcn CSS-variable format the installed shadcn version uses); webui scripts `dev`, `build`, `preview`, `test` (`vitest run`), `typecheck` (`tsc -b --noEmit` or equivalent).
- Root scripts: `"setup:webui": "npm --prefix webui ci"`, `"build:webui": "npm --prefix webui run build"`, `"test:webui": "npm --prefix webui test"`, `"dev:webui": "npm --prefix webui run dev"`.

- [ ] **Step 1: Create the Vite React TS package and install deps** (`npm create vite@latest webui -- --template react-ts`, then add the Tech Stack libraries and `@fontsource-variable/inter`, `@fontsource/noto-sans-thai`, `tw-animate-css`; run `npx shadcn@latest init` then `npx shadcn@latest add <list above>` inside `webui/`).
- [ ] **Step 2: Configure** `vite.config.ts`: plugins react + tailwind, alias `@`, `build: { outDir: '../dist/webui', emptyOutDir: true, sourcemap: false }`, `server.proxy['/api'] = { target: 'http://127.0.0.1:4321', changeOrigin: true, configure: proxy => proxy.on('proxyReq', req => { if (req.getHeader('origin')) req.setHeader('origin', 'http://127.0.0.1:4321'); }) }`; vitest `environment: 'jsdom'`, `setupFiles: ['./src/test/setup.ts']` (jest-dom matchers). `index.html`: `lang="th"`, `class="dark"`, the exact title, module script `/src/main.tsx` only.
- [ ] **Step 3: Write the failing test** `webui/src/App.test.tsx`:

```tsx
test('renders the Memory Studio brand', () => {
  render(<App />);
  expect(screen.getByText('Memory Studio')).toBeInTheDocument();
  expect(screen.getByText('Project Memory V2')).toBeInTheDocument();
});
```

- [ ] **Step 4: Run** `npm --prefix webui test` → FAIL (App lacks brand).
- [ ] **Step 5: Implement** placeholder `App` (brand tile gradient `#6366f1`→`#10b981` with lucide `Cpu`, the two strings) and `main.tsx` importing fonts + `index.css`.
- [ ] **Step 6: Verify** `npm --prefix webui test` PASS; `npm --prefix webui run typecheck` PASS; `npm run build:webui` produces `dist/webui/index.html` whose only scripts are `<script type="module" crossorigin src="/assets/…js">` (no inline script) and `dist/webui/assets/*.css`; `npm run typecheck` and `node --test dist-test/tests/test-profiles.test.js dist-test/tests/ci-lifecycle-gates.test.js dist-test/tests/ci-fresh-start-foundation.test.js` (after `npm run test:build`) still PASS.
- [ ] **Step 7: Commit** `git add webui package.json && git commit -m "feat(webui): scaffold Vite + React + TanStack + shadcn/ui + lucide SPA package"`

---

### Task 2: Serve the SPA from the WebUI server + `/api/bootstrap`

**Files:**
- Create: `src/v2/webui/spa-assets.ts`, `tests/v2-webui-spa-serving.test.ts`
- Modify: `src/v2/webui.ts` (options, `/`, SPA routes, `/assets/*`, `/api/bootstrap`), `tests/v2-webui-and-curator.test.ts` (remove only assertions on legacy index markup: lines asserting `<pm-mission-control`, `--background`, `/mvc/*.js` script tags in the HTML, `.pm-mobile-nav`, `defer src="/mvc/vendor.js`, `hsla(var(--` / `hsl(var(--card) /` in the HTML), `scripts/run-test-profile.js` (add `v2-webui-spa-serving.test.js` to the essential list) and `tests/test-profiles.test.ts` if it pins that list.

**Interfaces:**
- Produces (in `spa-assets.ts`):
  - `export const SPA_ROUTE_PATHS: ReadonlySet<string>` = `/`, `/index.html`, `/overview`, `/kanban`, `/graph`, `/curator`, `/mcp`.
  - `export interface PrecomputedStaticAsset { readonly raw: Buffer; readonly gzip: Buffer | null; readonly etag: string; readonly contentType: string }`
  - `export interface SpaClientBundle { readonly indexTemplate: string; readonly assets: ReadonlyMap<string, PrecomputedStaticAsset> }` (map keys are URL paths like `/assets/index-abc.js`, `/favicon.svg`).
  - `export function resolveSpaClientDir(opts: { readonly clientDistDir?: string; readonly entryUrl?: string; readonly cwd?: string }): string` — first of `clientDistDir`, `<dirname(fileURLToPath(entryUrl))>/webui`, `<cwd>/dist/webui` that contains `index.html`; else the first candidate.
  - `export function loadSpaClientBundle(dir: string): SpaClientBundle | null` — null when `index.html` is missing; loads regular files under `assets/` and top-level non-HTML files; skips dotfiles, symlinks, `.map`; gzip for js/css/svg/json/html-ish text ≥ 1 KiB; strong ETag `"spa-<sha256 first 24 hex>"`; content types js `application/javascript; charset=utf-8`, css `text/css; charset=utf-8`, svg `image/svg+xml`, woff2 `font/woff2`, woff `font/woff`, png `image/png`, ico `image/x-icon`, json `application/json; charset=utf-8`, else `application/octet-stream`.
  - `export function renderSpaIndexHtml(template: string, csrfToken: string, defaultProjectRoot: string): string` — inserts `<meta name="pm-csrf-token" content="…">` and `<meta name="pm-default-project" content="…">` (HTML-escaped) immediately before `</head>`.
  - `export function renderClientMissingHtml(csrfToken: string, defaultProjectRoot: string): string` — full HTML page, same title, both metas, Thai + English text containing `npm run setup:webui` and `npm run build:webui`.
- `V2WebUiOptions` gains `readonly clientDistDir?: string`. The handler loads the bundle at creation; if null, it retries loading at most once every 2 000 ms when an SPA route is requested.
- `GET /api/bootstrap` → `200 { ok: true, csrfToken, defaultProjectRoot }` (`cache-control: no-store`).
- `/mvc/*.js` routes remain until Task 10.

- [ ] **Step 1: Write failing tests** in `tests/v2-webui-spa-serving.test.ts` using a temp client dir containing `index.html` (`<!doctype html><html lang="th"><head><title>Project Memory V2 — Memory Studio & AI Memory Curator</title><script type="module" src="/assets/app-abc123.js"></script></head><body><div id="root"></div></body></html>`), `assets/app-abc123.js` (≥2 KiB), `assets/app-abc123.css`, `assets/.secret`, and the existing `createActiveStoreFixture` pattern from `tests/v2-webui-and-curator.test.ts`:
  - `serves index with injected csrf and default-project meta` — `GET /` 200 `text/html`, `cache-control: no-store`, body matches `/<meta name="pm-csrf-token" content="[0-9a-f]{48}">/` and contains `<meta name="pm-default-project" content="<escaped root>">` and `/assets/app-abc123.js`; CSP header equals the constant in Global Constraints.
  - `serves the same index for every SPA route` — `/overview`, `/kanban`, `/graph`, `/curator`, `/mcp` → 200 HTML with the meta; `/nope` → 404 JSON `NOT_FOUND`.
  - `serves hashed assets immutable with gzip and 304` — `/assets/app-abc123.js` 200, `content-type: application/javascript; charset=utf-8`, `cache-control: public, max-age=31536000, immutable`, ETag present; with `Accept-Encoding: gzip` → `content-encoding: gzip`, gunzip equals file bytes; `If-None-Match: <etag>` → 304.
  - `refuses traversal, dotfiles and unknown assets` — `/assets/../index.html`, `/assets/%2e%2e/index.html`, `/assets/.secret`, `/assets/missing.js` → 404.
  - `returns 503 setup page when the client is not built` — `clientDistDir` = empty temp dir → `GET /` 503 `text/html` containing `npm run build:webui` and the csrf meta; `GET /api/projects` still 200.
  - `bootstrap token authorizes mutations` — `GET /api/bootstrap` token equals the meta token; `POST /api/projects/register` `{ projectRoot: "relative/path" }` with that token → 400 `INVALID_PROJECT_ROOT`; without token → 403 `CSRF_TOKEN_INVALID`.
  - `escapes hostile default project roots` — unit assertion: `renderSpaIndexHtml('<html><head></head><body></body></html>', 'tok', 'C:\\a"b<c')` contains `content="C:\a&quot;b&lt;c"` and the metas appear before `</head>`.
- [ ] **Step 2: Run** `npm run test:build; node --test dist-test/tests/v2-webui-spa-serving.test.js` → FAIL (module missing).
- [ ] **Step 3: Implement** `spa-assets.ts` and wire `webui.ts` (index/SPA routes before the legacy `/mvc` branch; `/assets/` prefix lookup only in the precomputed map — never touch the filesystem per request).
- [ ] **Step 4: Verify** the new test file PASS; `node --test dist-test/tests/v2-webui-and-curator.test.js` PASS (only the listed legacy-markup assertions removed); `npm run typecheck`, `npm test`, `npm run test:build-artifacts` PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(webui-server): serve Vite SPA bundle with injected CSRF meta, immutable assets and /api/bootstrap"`

---

### Task 3: Client core — API, routing, theme, app shell, command palette

**Files:**
- Create: `webui/src/api/types.ts`, `webui/src/api/client.ts`, `webui/src/api/queries.ts`, `webui/src/lib/search.ts`, `webui/src/lib/keyboard.ts`, `webui/src/lib/status.ts`, `webui/src/hooks/use-debounced-value.ts`, `webui/src/providers/theme-provider.tsx`, `webui/src/providers/app-providers.tsx`, `webui/src/router.tsx`, `webui/src/routes/*.tsx` (root layout + 5 lazy route stubs), `webui/src/components/shell/{app-sidebar,mobile-nav,topbar,project-switcher,command-palette}.tsx`, `webui/src/components/shared/{kind-badge,status-badge,copy-button,empty-state}.tsx`, `webui/src/test/render-app.tsx` (test helper: memory history + fresh QueryClient + stub fetch)
- Modify: `webui/src/main.tsx`, `webui/src/App.tsx` (becomes `RouterProvider`)
- Test: `webui/src/api/client.test.ts`, `webui/src/lib/search.test.ts`, `webui/src/components/shell/shell.test.tsx`

**Interfaces:**
- Consumes: Task 2 `/api/bootstrap`, meta names `pm-csrf-token`, `pm-default-project`.
- Produces:
  - `types.ts`: `ProjectSummary`, `ProjectsResponse`, `OverviewResponse`, `NoteItem` (`id, recordId, kind, recordKind, title, summary, body: unknown, status, filePaths: string[], symbols: string[], wikilinks: string[], sessionId: string | null`), `NoteDetailResponse`, `GraphNode`, `GraphEdge`, `GraphResponse`, `CuratorAudit`, `AutoCurateReceipt`, `CuratorChatReply`, `McpToolDefinition`, `McpCallResponse`, `GovernanceAction = 'promote'|'supersede'|'retract'|'expire'|'writeADR'|'writeInsight'|'writeMistake'` — field names exactly per inventory §1 (`GraphNode`/`GraphEdge` mirror `src/v2/webui.ts:34-76`).
  - `client.ts`: `getBootstrap(): Promise<{ csrfToken: string; defaultProjectRoot: string }>` (meta first, else `GET /api/bootstrap`, memoized; `resetBootstrap()` for tests), `apiGet<T>(path: string, params?: Record<string, string | undefined>, signal?: AbortSignal): Promise<T>`, `apiPost<T>(path: string, body: unknown): Promise<T>`, `class ApiError extends Error { readonly status: number; readonly code: string }` (code from JSON `error`, message from JSON `message` or code).
  - `queries.ts`: `pmKeys.projects()`, `pmKeys.project(p)`, `pmKeys.overview(p)`, `pmKeys.notes(p, f: { query?: string; kind?: string; status?: string })`, `pmKeys.note(p, id)`, `pmKeys.graph(p)`, `pmKeys.audit(p)`, `pmKeys.mcpTools()`; matching `queryOptions` factories `projectsQuery()`, `overviewQuery(p)`, `notesQuery(p, f)`, `noteQuery(p, id)`, `graphQuery(p)`, `auditQuery(p)`, `mcpToolsQuery()`; `invalidateProject(qc: QueryClient, p: string): Promise<void>`.
  - `search.ts`: `type TabId = 'overview'|'kanban'|'graph'|'curator'|'mcp'`, `interface AppSearch { project?: string; note?: string; q?: string; kind?: string; status?: string; node?: string; session?: string }`, `validateAppSearch(raw: Record<string, unknown>): AppSearch`, `legacyHashToHref(hash: string): string | null`.
  - `keyboard.ts`: `isImeComposing(e: { isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean; keyCode?: number } }): boolean`, `isEditableTarget(el: Element | null): boolean`.
  - `status.ts`: `statusBadgeVariant(status: string): 'success'|'warning'|'destructive'|'secondary'` (mapping as in `<StatusBadge>` below).
  - `useDebouncedValue<T>(value: T, delayMs: number): T`.
  - `useTheme(): { theme: 'dark' | 'light'; toggleTheme(): void }`.
  - `useProjectRoot(): string` — `search.project ?? bootstrap.defaultProjectRoot`.
  - `useOpenNote(): (recordId: string | null) => void` — sets/removes `note` search param with `replace: true`.
  - Shared components: `<KindBadge kind={string} />` (ADR/Insight/Mistake/Session Log with inventory colors + lucide icons `Landmark`/`Lightbulb`/`AlertTriangle`/`FileText`), `<StatusBadge status={string} />` (variant from status: verified|active → success, candidate|provisional → warning, conflicted|expired|superseded|retracted → destructive, else secondary), `<CopyButton value={string} label={string} toastMessage?={string} />` (clipboard + sonner toast), `<EmptyState icon={LucideIcon} title={string} description?={string} />`.
  - Router: browser history, `defaultPreload: 'intent'`, `defaultViewTransition: true`, `/` → redirect `/overview`; on boot, if `location.hash` yields `legacyHashToHref`, `router.history.replace(href)`.

- [ ] **Step 1: Write failing tests**:
  - `client.test.ts › reads csrf token from meta and sends it on POST` — meta present; stub fetch; `apiPost('/api/curator/chat', {…})` called with headers `content-type: application/json` and `X-PM-CSRF-Token: tok-meta`.
  - `client.test.ts › falls back to /api/bootstrap when meta is absent` — first fetch hits `/api/bootstrap`; token used on POST.
  - `client.test.ts › retries once after CSRF_TOKEN_INVALID` — first POST 403 `{error:'CSRF_TOKEN_INVALID'}`, bootstrap returns `tok-new`, second POST 200; result resolves; exactly 2 POSTs, second carries `tok-new`; a second consecutive 403 rejects with `ApiError` code `CSRF_TOKEN_INVALID`.
  - `client.test.ts › maps error JSON to ApiError` — 404 `{ ok:false, error:'NOTE_NOT_FOUND', message:'ไม่พบข้อมูลความจำที่ระบุ' }` → `status 404`, `code 'NOTE_NOT_FOUND'`, `message 'ไม่พบข้อมูลความจำที่ระบุ'`.
  - `search.test.ts › legacyHashToHref` table: `'#kanban?q=redis&note=n1'`→`'/kanban?q=redis&note=n1'`; `'#view=graph&node=x&type=adr'`→`'/graph?node=x&kind=adr'`; `'#tab=mcp'`→`'/mcp'`; `'#bogus?q=a'`→`'/overview?q=a'`; `''` and `'#'`→`null`; `'#graph?session=all&kind=all'`→`'/graph'`.
  - `search.test.ts › validateAppSearch drops empty/all and non-strings` — `{ q:' ', kind:'all', session:'all', status:'', note: 5, project:'C:\\p' }` → `{ project:'C:\\p' }`.
  - `shell.test.tsx › renders five Thai nav items` — `ภาพรวม & กราฟ`, `จัดการความจำ`, `กราฟเชื่อมโยง`, `ผู้ช่วย AI ดูแลความจำ`, `เครื่องมือนักพัฒนา`.
  - `shell.test.tsx › nav keeps project param` — start at `/overview?project=C%3A%5Cp`, click `กราฟเชื่อมโยง` → location `/graph?project=C%3A%5Cp`.
  - `shell.test.tsx › theme toggle persists` — click `โหมดสว่าง (Light)` → `document.documentElement` has class `light`, `localStorage['pm-v2-theme'] === 'light'`.
  - `shell.test.tsx › slash jumps to kanban search, IME ignored` — keydown `/` on body → path `/kanban` and `#kanban-search-input` focused (route stub renders that input); keydown `/` with `isComposing: true` from `/overview` → stays.
  - `shell.test.tsx › Ctrl+K opens command palette` — dialog with input placeholder `ค้นหาเมนู ความจำ หรือคำสั่ง...` opens; selecting `จัดการความจำ` navigates to `/kanban`.
  - `shell.test.tsx › project switcher lists projects` — stub `/api/projects` two projects → `#project-switcher-select` options `alpha (active)`, `beta (prepared)`; choosing beta sets `project` param (push).
- [ ] **Step 2: Run** `npm --prefix webui test` → FAIL.
- [ ] **Step 3: Implement** per Interfaces and inventory §2–§3 (topbar: syncing badge when any overview query fetching, `รีเฟรชข้อมูล` → `invalidateProject` + toast `รีเฟรชข้อมูลเรียบร้อย`, `ให้ AI จัดระเบียบ` → `/curator`; sonner `<Toaster position="bottom-right" duration={4500} />`; mobile nav below `lg`; route stubs render a `Skeleton` placeholder and, for `/kanban`, an input `#kanban-search-input` so the shortcut test has a target until Task 6 replaces it).
- [ ] **Step 4: Verify** `npm --prefix webui test` PASS, `npm --prefix webui run typecheck` PASS, `npm run build:webui` PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(webui): typed API client, TanStack Router/Query core, theme and app shell"`

---

### Task 4: Note detail panel + safe Markdown

**Files:**
- Create: `webui/src/lib/markdown.tsx`, `webui/src/lib/note.ts`, `webui/src/features/note/note-detail-sheet.tsx`
- Modify: root layout route (mount `NoteDetailSheet` once, driven by `note` search param)
- Test: `webui/src/lib/markdown.test.tsx`, `webui/src/lib/note.test.ts`, `webui/src/features/note/note-detail-sheet.test.tsx`

**Interfaces:**
- Consumes: `noteQuery`, `useOpenNote`, `useProjectRoot` (Task 3).
- Produces:
  - `note.ts`: `extractNoteBodyText(body: unknown): string` (string → itself; `{ body: string }` / `{ content: { body } }` → body; else `''`), `deriveHumanTitle(note: Pick<NoteItem,'title'|'summary'|'recordId'> & { body?: unknown }): string` (skips generic headings `Problem`, `Context`, `Summary`, `Background`, `Overview`, `ปัญหา`, `บริบท`). Status badges use Task 3's `<StatusBadge>`; copy buttons use `<CopyButton>`.
  - `markdown.tsx`: `isSafeMarkdownHref(href: string): boolean` (allow `http:`, `https:`, `mailto:`, `vscode:`, `cursor:`, `#…`), `<InlineMarkdown text={string} onWikilink={(target: string) => void} />`, `<MarkdownBlocks text={string} onWikilink={…} />`; no `dangerouslySetInnerHTML`.
  - `NoteDetailSheet` (shadcn `Sheet`, side right, width `sm:max-w-2xl`) — copy and controls per inventory "Note detail view"; wikilink `note:<id>` → `openNote(id)`, other targets → navigate `/kanban?q=<target>`; files/symbols → `/graph?q=<value>`; `ดูความเชื่อมโยงในกราฟ` → `/graph?node=<recordId>` and closes.

- [ ] **Step 1: Write failing tests**:
  - `markdown.test.tsx › safe href table` — true: `https://a.b`, `http://a`, `mailto:x@y`, `vscode://file/x`, `cursor://x`, `#h`; false: `javascript:alert(1)`, ` JavaScript:alert(1)`, `data:text/html,x`, `//evil.com`, `vbscript:x`.
  - `markdown.test.tsx › unsafe link renders as plain text` — `[x](javascript:alert(1))` → no `<a>`; text `x` present.
  - `markdown.test.tsx › raw html is inert` — `<img src=x onerror=alert(1)>` renders as text, `container.querySelector('img') === null`.
  - `markdown.test.tsx › blocks` — fenced code → `<pre><code>`; `## H` → heading level 2; `- a` → list item; `**b**` → `<strong>`; `` `c` `` → `<code>`.
  - `markdown.test.tsx › wikilinks` — `[[note:abc|ดูต่อ]]` renders button `ดูต่อ`; click calls `onWikilink('note:abc')`.
  - `note.test.ts › extractNoteBodyText` — `{ format:'markdown', body:'# T' }` → `'# T'`; `{ content: { body:'x' } }` → `'x'`; `42` → `''`.
  - `note-detail-sheet.test.tsx › opens from ?note= and copies id` — route `/kanban?note=n1`, stub note → heading `รายละเอียดความจำ (Human-Readable Memory View)`; click `คัดลอก ID` → `navigator.clipboard.writeText('n1')`; text `[object Object]` absent.
  - `note-detail-sheet.test.tsx › escape closes and clears param` — Escape → `note` param removed, path stays `/kanban`.
  - `note-detail-sheet.test.tsx › 404 shows Thai error` — stub 404 `NOTE_NOT_FOUND` → `ไม่พบข้อมูลความจำที่ระบุ` visible.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** webui test + typecheck + build PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(webui): note detail sheet with safe markdown rendering"`

---

### Task 5: Overview page

**Files:**
- Create: `webui/src/lib/overview-math.ts`, `webui/src/components/shared/stat-card.tsx`, `webui/src/features/overview/{overview-page,kpi-cards,health-gauge-card,distribution-card,activity-card,session-activity-map,causal-triads-card,recommendations-card,sessions-table}.tsx`
- Modify: `webui/src/routes/overview.tsx`
- Test: `webui/src/lib/overview-math.test.ts`, `webui/src/features/overview/overview.test.tsx`

**Interfaces:**
- Consumes: `overviewQuery`, `useOpenNote`, `useProjectRoot`.
- Produces: `healthTone(score: number): { tone: 'healthy'|'fair'|'critical'; color: '#10b981'|'#f59e0b'|'#ef4444'; label: string }` (labels per inventory), `gaugePercents(v: { verified: number; candidates: number; conflicts: number }): { verified: number; candidates: number; conflicts: number }` (integers, 0 when total is 0), `kindDistribution(byKind: Record<string, number>): Array<{ key: 'adr'|'insight'|'mistake'|'session-log'; count: number; percent: number }>`.
- Charts: health gauge as shadcn `chart` radial bar (or SVG), distribution as recharts pie/donut, activity as recharts `ComposedChart` (area `notes` indigo, bars `verified` emerald, x `label`). Sessions table with column sort + filter `#session-table-filter`.

- [ ] **Step 1: Write failing tests**:
  - `overview-math.test.ts` — `healthTone(85).tone==='healthy'`, `healthTone(65).tone==='fair'`, `healthTone(64).tone==='critical'`; `gaugePercents({verified:2,candidates:2,conflicts:0})` → `{50,50,0}`; `gaugePercents({0,0,0})` → `{0,0,0}`; `kindDistribution({adr:1,insight:3})` percents `25`,`75`,`0`,`0`.
  - `overview.test.tsx › renders KPIs and charts` — stub overview (healthScore 90, verifiedNotes 4, unpromotedCandidates 2, conflictedNotes 1, duplicateGroups 1) → texts `90/100`, `สมบูรณ์ดีเยี่ยม (Healthy)`, `รออนุมัติ (Candidates)` card shows `2`, `ความจำซ้ำ / ขัดแย้ง` shows `2`.
  - `overview.test.tsx › renders empty vault without NaN` — zeros everywhere, empty sessions/triads → no text matching `/NaN/`, shows `0/100`.
  - `overview.test.tsx › triad and session pills open notes` — clicking a linked note pill sets `?note=<id>`; `ดูในกราฟ` navigates to `/graph?node=<mistakeId>`.
  - `overview.test.tsx › sessions table filters` — typing in `#session-table-filter` hides non-matching rows.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** per inventory "Overview". **Step 4: Verify** webui test + typecheck + build PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(webui): overview analytics page"`

---

### Task 6: Kanban & table page

**Files:**
- Create: `webui/src/lib/kanban.ts`, `webui/src/components/shared/note-badge-list.tsx`, `webui/src/features/kanban/{kanban-page,quick-entry,kanban-toolbar,kanban-board,note-card,notes-table,governance-confirm-dialog,use-governance}.tsx|ts`
- Modify: `webui/src/routes/kanban.tsx`
- Test: `webui/src/lib/kanban.test.ts`, `webui/src/features/kanban/kanban.test.tsx`

**Interfaces:**
- Consumes: `notesQuery` (with `placeholderData: keepPreviousData`), `apiPost('/api/governance')`, `invalidateProject`, `isImeComposing`, `useDebouncedValue`, `useOpenNote`.
- Produces: `columnForStatus(status: string): 'candidates'|'verified'|'archived'|null`, `capNoteBadges(n: { filePaths: string[]; symbols: string[] }): { files: string[]; symbols: string[]; hidden: number }` (≤3 files, ≤4 symbols, `hidden` = remaining count), `useGovernance(projectRoot: string)` returning a TanStack mutation for `{ action: GovernanceAction; recordId?: string; reason?: string; title?: string; summary?: string; content?: string }` that invalidates the project and toasts on success/error.
- URL state: `q` ↔ search input (debounced 250 ms, `replace`), `kind` ↔ `#kanban-kind-filter`; view mode local state.

- [ ] **Step 1: Write failing tests**:
  - `kanban.test.ts` — `columnForStatus('provisional')==='candidates'`, `('active')==='verified'`, `('superseded')==='archived'`, `('retracted')===null`; `capNoteBadges({ filePaths: 5 items, symbols: 6 items })` → 3 files, 4 symbols, `hidden: 4`.
  - `kanban.test.tsx › debounces search into one request` — type `r`,`re`,`red`,`redis` quickly → after 300 ms exactly one new `/api/notes` request with `query=redis`; URL has `q=redis`.
  - `kanban.test.tsx › retract requires confirmation` — click `ถอนคืน` → no POST; dialog `ยืนยันการถอนคืนความจำ (Confirm Retract)`; type reason; click `ยืนยันการดำเนินการ` → one POST `/api/governance` body `{ action:'retract', recordId:'n1', reason:'…', projectRoot }`.
  - `kanban.test.tsx › promote only on candidates` — `อนุมัติ (Promote)` present on candidate card, absent on verified card.
  - `kanban.test.tsx › quick entry IME-safe Enter` — Enter with `isComposing:true` on `#kanban-new-title` → no POST; Enter without → POST `{ action:'writeADR', title, summary, content }`.
  - `kanban.test.tsx › table mode` — click `มุมมองตาราง (Table)` → table headers `หมวดหมู่`, `หัวข้อ (Title)`, `สถานะ`, `จัดการ`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** per inventory "Kanban". **Step 4: Verify** webui test + typecheck + build PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(webui): kanban board, table view and governance actions"`

---

### Task 7: Knowledge Graph page

**Files:**
- Create: `webui/src/lib/graph-layout.ts`, `webui/src/lib/graph-labels.ts`, `webui/src/features/graph/{graph-page,graph-toolbar,graph-canvas,graph-zoom-hud,graph-inspector,use-pan-zoom}.tsx|ts`
- Modify: `webui/src/routes/graph.tsx`
- Test: `webui/src/lib/graph-layout.test.ts`, `webui/src/lib/graph-labels.test.ts`, `webui/src/features/graph/graph.test.tsx`

**Interfaces:**
- Consumes: `graphQuery`, `useOpenNote`, search params `node`, `session`, `q`, `kind`.
- Produces:
  - `graph-labels.ts`: `humanKindLabel(n: GraphNode): string`, `shortNodeDisplayLabel(n: GraphNode): string` (≤30 chars, file basename), `fullNodeTooltipLabel(n: GraphNode): string`.
  - `graph-layout.ts`: `computeNeighborhood(selectedId: string | null, edges: readonly GraphEdge[]): Set<string>` (selected + direct neighbours + their session/note neighbours, matching legacy `controllers.ts:801-850`), `filterGraph(g: GraphResponse, f: { q?: string; kind?: 'all'|'session'|'note'|'file'|'symbol'; session?: string }): { nodes: GraphNode[]; edges: GraphEdge[] }`, `computeFlowLayout(nodes: readonly GraphNode[], highlighted: ReadonlySet<string>): { positions: Map<string, { x: number; y: number }>; width: 960; height: number }` (columns x 122/368/628/852, ≤14 per column, ≤56 total, highlighted first, row spacing 44, height `max(500, rows*44+76)`), `computeOrbitalLayout(nodes, highlighted): { positions: Map<…>; width: 960; height: 560 }` (center 480,280; r 90/170/215/242; caps 12/16/14/14; ≤56), `pickSpotlightLabels(nodes, positions, selectedId, highlighted): Set<string>` (≤10: 2 sessions, 3 notes, 3 files, 3 symbols).
  - Pan/zoom: zoom range 0.5–2.5, step 0.25, `ซูมดูจุดที่เลือก` → 1.75 centered; 4 px drag dead-zone; Ctrl+wheel zoom; HUD `#graph-zoom-hud` rendered above the SVG.

- [ ] **Step 1: Write failing tests**:
  - `graph-layout.test.ts › caps 600 nodes to 56` — 150 of each kind → flow and orbital each position ≤56 nodes, flow ≤14 per column; highlighted ids always included.
  - `graph-layout.test.ts › flow geometry` — positions use the 4 x values; height for 3 rows = 500, for 14 rows = `14*44+76`.
  - `graph-layout.test.ts › neighborhood` — fixture triangle session→note→file → selecting note includes session and file.
  - `graph-labels.test.ts` — file node `src/v2/webui/views-and-web-components.ts` short label `views-and-web-components.ts`; label >30 chars truncated with `…`.
  - `graph.test.tsx › selecting a node updates URL and inspector` — click a node → URL `node=<id>` (replace), inspector shows `สรุปใจความสำคัญ (อ่านเข้าใจง่าย)`.
  - `graph.test.tsx › double-click note opens note sheet` — double-click note node → `note=<recordId>` param set.
  - `graph.test.tsx › mode switch keeps svg mounted` — toggling `มุมมองเครือข่ายวงโคจร` / `มุมมองลำดับเรื่องราว (อ่านง่าย)` keeps the same `svg` element instance.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** per inventory "Knowledge Graph" (SVG rendered by React; edges cubic in flow, quadratic in orbital; selected pin `● จุดที่เลือก`; hover labels). **Step 4: Verify** webui test + typecheck + build PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(webui): knowledge graph flow/orbital views with inspector"`

---

### Task 8: AI Curator page

**Files:**
- Create: `webui/src/features/curator/{curator-page,curator-chat,auto-curate-card}.tsx`
- Modify: `webui/src/routes/curator.tsx`
- Test: `webui/src/features/curator/curator.test.tsx`

**Interfaces:**
- Consumes: `auditQuery`, `apiPost('/api/curator/chat')`, `apiPost('/api/curator/auto-curate')`, `invalidateProject`, `isImeComposing`, `useOpenNote`.
- Produces: chat messages kept in component state (`{ id: string; role: 'user'|'ai'; text: string; tools: string[] }`); after a chat reply invalidate the project only when the request had `autoExecute: true`.

- [ ] **Step 1: Write failing tests**:
  - `curator.test.tsx › chips prefill textarea` — click `+ ADR` → `#curator-chat-input` value `บันทึก ADR: ` and focused.
  - `curator.test.tsx › Enter sends, Shift+Enter and IME do not` — Enter with `isComposing:true` → no POST; Shift+Enter → no POST; Enter → one POST `{ message, autoExecute: true, projectRoot }`; reply text and tool badge `memory_list` rendered.
  - `curator.test.tsx › dry-run sends autoExecute false and skips invalidation` — check `#curator-dry-run-toggle` → POST body `autoExecute: false`; no refetch of overview.
  - `curator.test.tsx › duplicate ids open note` — click duplicate id button `dup-rec-2` → `note=dup-rec-2`.
  - `curator.test.tsx › chat error toasts` — POST 500 → toast containing `ไม่สำเร็จ`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** per inventory "AI Curator". **Step 4: Verify** webui test + typecheck + build PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(webui): AI curator chat and auto-curate"`

---

### Task 9: MCP Console page

**Files:**
- Create: `webui/src/lib/mcp-template.ts`, `webui/src/features/mcp/{mcp-page,tool-runner,response-output}.tsx`
- Modify: `webui/src/routes/mcp.tsx`
- Test: `webui/src/lib/mcp-template.test.ts`, `webui/src/features/mcp/mcp.test.tsx`

**Interfaces:**
- Consumes: `mcpToolsQuery`, `apiPost('/api/mcp/call')`, `invalidateProject`.
- Produces: `defaultValueForSchemaProp(key: string, prop: unknown): unknown`, `buildToolStarterJson(tool: McpToolDefinition | null | undefined): string`, `insertParamIntoArgs(rawArgs: string, key: string, prop: unknown): string` (parses object JSON, adds key with default if absent, pretty-prints 2 spaces; unparsable/non-object → `{ key: default }`), `toolSafety(tool): 'read-only'|'destructive'|'mutating'` — rules per inventory "MCP Console" §3.

- [ ] **Step 1: Write failing tests**:
  - `mcp-template.test.ts › supersede template` — tool with properties `projectRoot, sessionId, recordId, id (desc 'Alias for recordId.'), supersedingRecordId, reason` and `required: ['supersedingRecordId']` → parsed keys exactly `recordId`, `supersedingRecordId`, `reason` (all `''`).
  - `mcp-template.test.ts › defaults` — `limit`→10, `staleAfterDays`→30, enum→first, boolean→true, array→[], no props→`'{}'`.
  - `mcp-template.test.ts › insertParamIntoArgs keeps edits` — `'{"query":"x"}'` + `limit` → `{ query:'x', limit:10 }`; `'not json'` + `reason` → `{ reason:'' }`.
  - `mcp.test.tsx › read-only run keeps cache` — default `memory_v2Status`, badge `Read-Only (อ่านอย่างเดียว)`; click `รันคำสั่ง (Execute)` → POST `{ tool:'memory_v2Status', args:{} , projectRoot }`; pre-seeded overview query `dataUpdatedAt` unchanged; output `<pre>` shows result JSON.
  - `mcp.test.tsx › selecting a tool seeds template and pills insert params` — select `memory_search` → `#mcp-tool-args` contains `"query"`; set args `{}` then click pill `limit` → args contain `"limit": 10`.
  - `mcp.test.tsx › destructive tool needs confirmation` — select `memory_forgetEvidence` → click execute → no POST until `ยืนยันรันคำสั่ง`.
  - `mcp.test.tsx › invalid JSON warns` — args `{` → toast `JSON Arguments ไม่ถูกต้อง`, no POST.
  - `mcp.test.tsx › copy output` — click `คัดลอก JSON` → clipboard receives output text.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** webui test + typecheck + build PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(webui): MCP developer console"`

---

### Task 10: Remove the legacy string runtime and finalize

**Files:**
- Delete: `src/v2/webui/vendor-runtime.ts`, `src/v2/webui/shadcn-ui.ts`, `src/v2/webui/views-and-web-components.ts`
- Modify: `src/v2/webui/controllers.ts` (remove `renderMvcControllersJs`), `src/v2/webui/models.ts` (remove `renderMvcModelsJs`; update `MVC_ARCHITECTURE_MANIFEST` stack/views to describe the Vite SPA), `src/v2/webui.ts` (remove `/mvc/*` routes, precomputed MVC assets, legacy imports), `tests/v2-webui-and-curator.test.ts` (delete tests/subtests that VM-execute or string-match `/mvc/*.js` bundles — Task 3 bundle parts, Task 4 view parts 4.2–4.6, Task 5 subtests 5.1, 5.3, and the frontend parts of 5.4; keep every `/api/*`, curator, graph-builder, security and serving assertion), `README.md` / `AGENTS.md` WebUI sections (setup: `npm run setup:webui`, `npm run build:webui`, `npm run webui`; dev: `npm run webui` + `npm run dev:webui` → `http://localhost:5173`)
- Test: `tests/v2-webui-spa-serving.test.ts` (add `legacy /mvc routes are gone` → `GET /mvc/vendor.js` 404)

**Interfaces:**
- Consumes: everything above. Produces: no new interfaces.

- [ ] **Step 1: Write the failing test** `legacy /mvc routes are gone` and run it → FAIL (route still served).
- [ ] **Step 2: Delete/modify** per Files; `git grep -n "renderMvc\|renderVendorRuntimeJs\|renderShadcnUiJs\|renderWebComponentsJs\|/mvc/" src tests` returns nothing except the new 404 assertion.
- [ ] **Step 3: Verify full gates** — `npm run typecheck` (0 errors), `npm test` (0 failures), `npm run test:build-artifacts` (3 smokes PASS), `npm run test:webui` (0 failures), `npm --prefix webui run typecheck`, `npm run build:webui`.
- [ ] **Step 4: Commit** `git commit -m "refactor(webui): remove legacy string-based MVC runtime in favor of Vite SPA"`
- [ ] **Step 5: Live check** — restart `npm run webui`, open `http://127.0.0.1:4321` in the browser: all 5 routes, note sheet via `?note=`, Ctrl+K palette, `/` shortcut, theme toggle persistence, legacy `/#kanban?q=x` redirect, zero console errors, zero CSP violations.
