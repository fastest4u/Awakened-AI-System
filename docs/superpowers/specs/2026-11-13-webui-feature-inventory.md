# Project Memory V2 WebUI — Feature Inventory (parity reference for the Vite + React SPA)

Companion to `2026-11-13-webui-vite-react-spa-design.md`. Line refs are to the legacy string-runtime
sources at commit `d30fffd` (`src/v2/webui.ts`, `src/v2/webui/*.ts`). Thai copy below is binding.

## 1. HTTP API contract (unchanged by the migration)

Security headers (`webui.ts:555-561`): `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
Host allowlist: `127.0.0.1`, `localhost`, `::1`, `[::1]`, or `options.allowedHost`; wildcards rejected.
Mutations (non GET/HEAD/OPTIONS): `content-type: application/json*` (else 415 `UNSUPPORTED_MEDIA_TYPE`); `sec-fetch-site` ∈ {`same-origin`,`none`, absent} and Origin host/port must match (else 403 `CSRF_ORIGIN_DENIED`); header `X-PM-CSRF-Token` must equal the per-process token (else 403 `CSRF_TOKEN_INVALID`). Token is delivered today via `<meta name="pm-csrf-token">`; default project via `<pm-mission-control default-project="…">`.

| Endpoint | Method | Params | Response fields the UI reads |
|---|---|---|---|
| `/api/projects` | GET | — | `{ ok, defaultProjectRoot, projects: [{ projectRoot, name, initialized, mode, productionReady, projectId, vaultId, releaseId, generation, error? }] }` |
| `/api/projects/register` | POST | `{ projectRoot }` | `{ ok, projectRoot, status }` |
| `/api/overview` | GET | `?project=` | `{ ok, projectRoot, projectName, status, lifecycle: { sessions[], latestCheckpoint }, audit: { healthScore, counts, recommendations[], duplicateGroups[] }, causalTriads[], analytics: { byStatus, byKind, activitySeries: [{ label, notes, verified, sessions }] } }` |
| `/api/notes` | GET | `?project=&query=&status=&kind=` | `{ ok, projectRoot, items: [{ id, recordId, recordKind, kind, title, summary, body, status, filePaths[], symbols[], wikilinks[], sessionId }] }` |
| `/api/notes/:id` | GET | `?project=` | `{ ok, projectRoot, note }` or 404 `{ ok:false, error:"NOTE_NOT_FOUND", message:"ไม่พบข้อมูลความจำที่ระบุ", note:null }` |
| `/api/governance` | POST | `{ projectRoot, action, recordId?, id?, targetStatus?, verificationMethod?, reason?, supersedingRecordId?, title?, summary?, content? }`; actions `promote`,`supersede`,`retract`,`expire`,`writeADR`,`writeInsight`,`writeMistake` | `{ ok, action, result }` |
| `/api/graph` | GET | `?project=` | `{ ok, projectRoot, nodes: GraphNode[], edges: GraphEdge[], causalTriads[], stats: { sessionNodes, noteNodes, fileNodes, symbolNodes, edgeCount } }` (types in `webui.ts:34-76`) |
| `/api/curator/audit` | GET | `?project=` | `{ projectRoot, healthScore, counts, recommendations[], duplicateGroups: [{ title, keeperRecordId, duplicateRecordIds[] }], staleItems[] }` |
| `/api/curator/auto-curate` | POST | `{ projectRoot, promoteCandidates?, resolveDuplicates?, expireStale? }` | `{ projectRoot, beforeHealthScore, afterHealthScore, promoted[], superseded[], expired[] }` |
| `/api/curator/chat` | POST | `{ projectRoot, message, autoExecute? }` | `{ projectRoot, reply, intent, executedTools[] }` |
| `/api/mcp/tools` | GET | — | `{ ok, tools: [{ name, description, inputSchema: { properties, required? }, annotations: { readOnlyHint, destructiveHint } }] }` (34 tools) |
| `/api/mcp/call` | POST | `{ projectRoot, tool, args }` | `{ ok, tool, result }` |
| `/api/mvc/architecture` | GET | — | legacy manifest (not used by the new UI) |

## 2. App shell

- Brand: gradient tile `linear-gradient(135deg, #6366f1, #10b981)` with lucide `Cpu`; title `Memory Studio`, subtitle `Project Memory V2`.
- Nav (id · lucide · label · subtitle): `overview` · `LayoutDashboard` · `ภาพรวม & กราฟ` · `Overview & Analytics`; `kanban` · `Kanban` · `จัดการความจำ` · `Kanban & Table`; `graph` · `Network` · `กราฟเชื่อมโยง` · `Knowledge Graph`; `curator` · `Bot` · `ผู้ช่วย AI ดูแลความจำ` · `AI Memory Curator`; `mcp` · `Wrench` · `เครื่องมือนักพัฒนา` · `34 MCP Tools`.
- Sidebar footer: `Zap` + `สถาปัตยกรรม MVC` → new copy `Vite + React + TanStack + shadcn/ui`.
- Topbar: `Folder` + `โปรเจกต์:` + project select (`id="project-switcher-select"`, option text `${name} (${mode})`); syncing badge `กำลังซิงก์ข้อมูล...` with spinning `RefreshCw` while overview is fetching; theme button `โหมดสว่าง (Light)` / `โหมดมืด (Dark)` with `Sun`/`Moon`, persisted in `localStorage["pm-v2-theme"]` toggling `dark`/`light` class on `<html>`; `รีเฟรชข้อมูล` (invalidates current project queries + success toast); `ให้ AI จัดระเบียบ` with `Sparkles` → navigates to curator.
- Mobile (≤1024px): sidebar hidden, horizontal scrolling pill nav with the 5 tabs.
- Toasts: bottom-right, tones error (`AlertTriangle`), warning (`Clock`), success/info (`CheckCircle2`); auto-dismiss 4 500 ms; never shift layout.

## 3. Routing, deep links, shortcuts

Legacy hash grammar: `#<tab>?<query>` (also `#view=<tab>&…` / `#tab=<tab>&…`); tabs `overview|kanban|graph|curator|mcp` (default `overview`). Params: `project` (omitted when = default), `note`, `node`, `session` (omitted when `all`), `q`, `kind` (alias `type`; omitted when `all`), `status` (omitted when `all`). Tab switches/project selection/external note open push history; modal open/close, typing, and graph selection replace history.
Shortcuts: `Ctrl/Cmd+K` and `/` (only when focus is not input/textarea/select/contentEditable) → close note view, go to Kanban, focus search. `Escape` closes dialogs. Keydown handlers must ignore events with `isComposing` or `keyCode === 229` (Thai IME).

## 4. Views

### Overview
1. KPI cards ×4: `คะแนนสุขภาพคลังความจำ` = `${healthScore}/100` (emerald ≥85 else amber, sub `Vault Health Score`); `ความจำที่ยืนยันแล้ว` = `counts.verifiedNotes` (indigo, `Active / Verified Notes`); `รออนุมัติ (Candidates)` = `counts.unpromotedCandidates` (amber, `Provisional Queue`); `ความจำซ้ำ / ขัดแย้ง` = `counts.conflictedNotes + counts.duplicateGroups` (rose if >0 else emerald, `Conflicts & Duplicates`).
2. Health gauge: radial, thresholds ≥85 `#10b981` / ≥65 `#f59e0b` / else `#ef4444`; badge `สมบูรณ์ดีเยี่ยม (Healthy)` / `ควรตรวจสอบ (Fair)` / `ต้องแก้ไขด่วน (Action Needed)`; progress rows Verified, Candidates, Conflicts as percentages of their sum (verified=2,candidates=2 ⇒ 50%).
3. Distribution donut over `analytics.byKind`: ADR (`Landmark`, `#6366f1`, `ADR (การตัดสินใจ)`), Insight (`Lightbulb`, `#10b981`, `Insight (บทเรียน)`), Mistake (`AlertTriangle`, `#f59e0b`, `Mistake (ข้อควรระวัง)`), Session Log (`FileText`, `#38bdf8`, `Session Log (ประวัติ)`), each with count + %.
4. Activity chart over `analytics.activitySeries`: indigo area/line for `notes`, emerald bars for `verified`, x labels from `label`.
5. Session activity map (max 6 sessions): title `แผนผังความสัมพันธ์แต่ละเซสชัน & ความจำ (AI Session Activity & Memory Map)`, button `เปิดกราฟความสัมพันธ์เต็มรูปแบบ`; state badges `AI กำลังทำงาน (Active)` `#10b981`, `กำลังปิดเซสชัน (Ending)` `#f59e0b`, `ยกเลิกกลางคัน (Abandoned)` `#ef4444`, `เสร็จสิ้น (Ended)` `#38bdf8`; `Root Agent` (`ShieldCheck`) vs `Subagent` (`GitBranch`); headline `AI กำลังทำ: <task>` / `กำลังสรุปปิดงาน: <task>`; in-progress `งานย่อย: a • b`; up to 5 linked note pills (open note) and 3 file badges; ended 0-note cards omit empty-memory boilerplate.
6. Causal triads (max 6): title `เส้นทางบทเรียนและทางแก้ (Causal Triads: Mistake ➔ Insight / ADR)`, subtitle `เชื่อมโยงข้อผิดพลาดเข้ากับบทเรียนและการตัดสินใจสถาปัตยกรรมที่แก้ไขจุดเดียวกันอัตโนมัติ (IDF-Weighted)`; per card: mistake badge + `อ่าน` + `ดูในกราฟ`, up to 3 ADR + 3 Insight buttons, overflow `+ อีก N รายการที่เชื่อมโยง (คลิกดูทั้งหมดในกราฟ)`, clickable `file:` / `symbol:` / `session:` context badges → graph.
7. Recommendations card (priority badges) + collapsible `ดูข้อมูลเทคนิค (Vault Identity & Checkpoint)` showing JSON of projectId, vaultId, releaseId, latestCheckpoint; sessions table with filter input (`id="session-table-filter"`, placeholder `ค้นหาเซสชัน...`) and sortable columns `Session ID`, `ภารกิจ AI (Task)`, `ความจำ`, `สถานะ`.

### Kanban
1. Quick entry: kind select (`id="kanban-new-kind"`: `writeADR` `ADR (การตัดสินใจ)`, `writeInsight` `Insight (บทเรียน)`, `writeMistake` `Mistake (ข้อผิดพลาด)`), title (`id="kanban-new-title"`, `หัวข้อสั้นๆ เข้าใจง่าย...`), summary (`id="kanban-new-summary"`, `รายละเอียด + ระบุไฟล์ เช่น src/v2/webui.ts (startV2WebUiServer)...`), button `บันทึก` (disabled while pending); Enter submits (IME-safe).
2. Toolbar: search (`id="kanban-search-input"`, `พิมพ์ค้นหาความจำ ชื่อไฟล์ หรือฟังก์ชัน... (Ctrl+K)`, 250 ms debounce), kind filter (`id="kanban-kind-filter"`: `ทุกหมวดหมู่`, ADR, Insight, Mistake, Session Log), view toggle `มุมมองบอร์ด (Kanban)` (`Kanban`) / `มุมมองตาราง (Table)` (`Table2`).
3. Columns: `รออนุมัติ (Candidates)` = status candidate|provisional (warning); `ยืนยันแล้ว (Verified)` = verified|active (success); `ขัดแย้ง / หมดอายุ` = conflicted|expired|superseded (destructive).
4. Card: kind + status badges, title, summary ≤180 chars, file badges ≤3 (`FileText`, → graph), symbol badges ≤4 (`Code2`, → graph), overflow `+N รายการ` titled `คลิกอ่านรายละเอียดทั้งหมด (X ไฟล์, Y สัญลักษณ์)` → open note; actions `อนุมัติ (Promote)` (candidates only), `ดูข้อมูล`, `ดูในกราฟ` (`Share2`), `หมดอายุ` (confirm), `ถอนคืน` (confirm).
5. Confirm dialog: `ยืนยันการถอนคืนความจำ (Confirm Retract)` / `ยืนยันการตั้งหมดอายุความจำ (Confirm Expire)`, reason input (`id="kanban-confirm-reason-input"`, `ระบุเหตุผลประกอบ (ไม่บังคับ)...`), `ยกเลิก` / `ยืนยันการดำเนินการ`. Nothing is POSTed before confirmation.
6. Table mode: sortable `หมวดหมู่`, `หัวข้อ (Title)`, `สถานะ`, `จัดการ` with the same actions.

### Knowledge Graph
1. Mode buttons `มุมมองลำดับเรื่องราว (อ่านง่าย)` (flow) / `มุมมองเครือข่ายวงโคจร` (orbital).
2. Filters: search (`id="graph-search-input"`, `ค้นหาชื่อเรื่อง, ชื่อไฟล์ หรือฟังก์ชันในกราฟ...`), session select (`id="graph-session-filter"`, `ทุกเซสชัน AI (All Sessions)` + sessions), kind buttons `ทั้งหมด (N)`, `เซสชัน (N)`, `ความจำ (N)`, `ไฟล์ (N)`, `โค้ด (N)`.
3. Zoom HUD (`id="graph-zoom-hud"`, above the SVG): `Minus`, percentage reset, `Plus`, `ซูมดูจุดที่เลือก` (`Crosshair`, zoom 1.75 centered on selection); drag to pan with a 4 px dead-zone; Ctrl+wheel zoom; double-click node centers it and opens the note view for notes.
4. Flow: width 960, height `max(500, maxRows*44+76)`; columns x=122 `1. ภารกิจ AI (Session)` `#38bdf8`, x=368 `2. ความจำที่ได้ (Memory)` `#6366f1`, x=628 `3. ไฟล์ที่แก้ไข (File)` `#10b981`, x=852 `4. ฟังก์ชัน/คลาส (Symbol)` `#f59e0b`; ≤14 per column, ≤56 total, highlighted neighbourhood first; cubic Bézier edges; 200×31 pill nodes (rx 8) with label ≤30 chars and full-path `<title>` tooltip; selected pin `● จุดที่เลือก`.
5. Orbital: 960×560, center (480,280); ring r=90 sessions (≤12), r=170 notes (≤16), r=215 symbols (≤14), r=242 files (≤14), ≤56 total; quadratic edges; ≤10 spotlight labels (2 sessions, 3 notes, 3 files, 3 symbols) with outward text-anchor + stroke halo; other labels only on hover; no mass labels at high zoom.
6. Inspector: kind/status badges, title, `สรุปใจความสำคัญ (อ่านเข้าใจง่าย)` narrative, buttons `อ่านเนื้อหาฉบับเต็ม`, `เปิดในบอร์ดจัดการ`, `กรองดูเฉพาะเซสชันนี้`; related sessions (`Cpu`, `#38bdf8`), notes (`Layers`, `#6366f1`), files (`FileText`, `#10b981`), symbols (`Code2`, `#f59e0b`), each clickable to refocus.

### AI Curator
1. Chat card: `Bot`, `ผู้ช่วย AI ดูแลความจำ (AI Memory Curator)`, subtitle `พิมพ์สั่งงานภาษาไทยหรืออังกฤษได้ทันที...`; 330 px scrolling stream with Thai welcome message, user/AI bubbles, executed-tool badges (`Wrench`); chips `+ ADR`→`บันทึก ADR: `, `+ Insight`→`บันทึก Insight: `, `+ Mistake`→`บันทึก Mistake: `, `ค้นหา`→`ค้นหา `; dry-run checkbox (`id="curator-dry-run-toggle"`, `โหมดจำลองก่อนเขียนจริง (Dry-Run)`) sends `autoExecute: false`; textarea (`id="curator-chat-input"`, `พิมพ์คำสั่งหรือคำถาม... (Enter ส่ง • Shift+Enter ขึ้นบรรทัดใหม่)`) — Enter sends, Shift+Enter newline, never while composing; `Send` button; quick prompts `ตรวจสุขภาพความจำ`→`ช่วยตรวจสุขภาพความจำและหาความจำซ้ำ`, `อนุมัติทั้งหมด`→`อนุมัติ candidate ทั้งหมด`, `สรุปบริบทโปรเจกต์`→`สรุปงานค้างและบริบทโปรเจกต์`; errors surface as toast.
2. Auto-curate card: `จัดระเบียบอัตโนมัติ` (`Sparkles`), recommendations list, duplicate groups with keeper (outline) and duplicate (secondary) ID buttons that open the note view.

### MCP Console
1. Tool select (`id="mcp-tool-select"`, `name — description`, default `memory_v2Status`); safety badge `Read-Only (อ่านอย่างเดียว)` (readOnlyHint) / `Destructive (ลบ/ถอนคืนข้อมูล)` (destructiveHint) / `Mutating (แก้ไขคลังความจำ)`; label `คลิกเพิ่มพารามิเตอร์:` with one button per schema property (`*` when required) that inserts the key with its default without discarding edits; args textarea (`id="mcp-tool-args"`, monospace) seeded by the starter-template builder; `รันคำสั่ง (Execute)` (destructive variant for destructive tools → confirm dialog `ยืนยันรันคำสั่งที่มีผลลบ/ถอนคืนข้อมูล (<tool>)` with `ยกเลิก` / `ยืนยันรันคำสั่ง`); `รีเซ็ต Template`; invalid JSON → warning toast `JSON Arguments ไม่ถูกต้อง`.
2. Output card: `Terminal`, `ผลลัพธ์ (Response Output)`, `คัดลอก JSON`, scrolling monospace `<pre>` (max 360 px). Read-only tools do not invalidate cached queries; others invalidate the project.
3. Starter template rules: include every `required` key; skip optional `sessionId`, `projectRoot`, `workspaceRoot`, `workflowId` and any property whose description contains the word "alias"; add at most 3 optional keys; defaults: schema `default` → first `enum` → number (`limit`→10, `staleAfterDays`→30, else 0) → boolean `true` → `[]` → `{}` → `""`; empty → `{}`.

### Note detail view
Header `รายละเอียดความจำ (Human-Readable Memory View)` + `ปิดหน้าต่าง`; kind badge, status badge (`ยืนยันความถูกต้องแล้ว (Verified)` for verified); `ดูความเชื่อมโยงในกราฟ` (closes + focuses node in graph), `คัดลอก ID`, `คัดลอก Markdown`; human title avoiding generic headings (`# Problem`, `# Context`); key-takeaway box (`Sparkles`) with inline markdown; full markdown blocks (fenced code, `#`/`##`/`###`, `-`/`*`/`1.` lists, paragraphs); inline code, `**bold**`, `[[target]]`/`[[target|label]]` wikilink pills (`Link2`; `note:<id>` opens note, else Kanban search), `[label](url)` only for `http:`, `https:`, `mailto:`, `vscode:`, `cursor:`, `#` with `target="_blank" rel="noopener noreferrer"`; files/symbols badges → graph; collapsible `ดูข้อมูลเทคนิคสำหรับนักพัฒนา (Raw JSON)`; 404 shows Thai error alert. Never renders `[object Object]` (note body may be `content.body`).

## 5. Theme tokens (HSL triplets)

| token | dark | light |
|---|---|---|
| background | 240 10% 3.9% | 0 0% 99% |
| foreground | 0 0% 98% | 240 10% 3.9% |
| card | 240 10% 6.2% | 0 0% 100% |
| popover | 240 10% 5% | 0 0% 100% |
| primary | 239 84% 67% | 239 84% 60% |
| primary-foreground | 0 0% 100% | 0 0% 100% |
| secondary / muted | 240 4.8% 13.5% / 240 3.7% 14% | 240 4.8% 95.9% |
| muted-foreground | 240 5% 64.9% | 240 3.8% 44% |
| accent | 240 3.7% 17.5% | 240 4.8% 93% |
| destructive | 0 72.2% 50.6% | 0 84.2% 60.2% |
| success (custom) | 160 84% 39% | 160 84% 35% |
| warning (custom) | 38 92% 50% | 38 92% 45% |
| border / input | 240 3.7% 15.9% | 240 5.9% 90% |
| ring | 239 84% 67% | 239 84% 60% |
| radius | 0.75rem | 0.75rem |

## 6. Pure logic to port as tested modules

`parseDeepLinkHash` / `writeDeepLinkHash` (`controllers.ts:221-295`), `buildToolStarterJson` + `defaultValueForSchemaProp` (`controllers.ts:1194-1233`), `isSafeMarkdownHref` / `renderSafeInlineMarkdown` / `renderHumanMarkdownBlocks` (`views-and-web-components.ts:3313-3515`), `humanKindLabel` / `shortNodeDisplayLabel` / `fullNodeTooltipLabel` (`views…:1754-1791`), `statusBadgeVariant` (`views…:79-84`), graph neighbourhood + flow/orbital layouts (`controllers.ts:801-964`), health gauge + activity path math (`views…:98-338`).
