# Awakened AI Memory MCP Server (Project Memory V2)

**เวอร์ชันปัจจุบัน:** [`v2.3.0`](https://github.com/fastest4u/Awakened-AI-System/releases) (2026-11-14)

MCP Server สำหรับระบบความจำระยะยาวระดับ Production (**Project Memory V2**) ที่จัดเก็บข้อมูลในรูปแบบ **Event-Sourced SQLite + Deterministic Read Projections + Hybrid Thai/BM25 Retrieval + Causal Knowledge Graph** พร้อม **WebUI Mission Control (Vite 8 + React 19 SPA)** และระบบ **Always-On Governed Session Lifecycle** สำหรับ AI IDE และ Autonomous Agents ทุกค่าย

## ภาพรวมระบบ (Project Memory V2)

- **Authoritative Store (`memory-v2/`)**: บันทึกทุกเหตุการณ์แบบ append-only พร้อม cryptographic HMAC integrity chain, fencing tokens, session leases, Cross-Branch V2 Session Continuity และ verified read projections
- **Frozen V1 Archive (`memory/`)**: เก็บคลัง Markdown V1 เดิมในสถานะ read-only (`0o444`) พร้อม cryptographic archive manifest ที่ตรวจสอบได้ตลอดเวลาผ่าน `verify-v1-archive`
- **34 Public MCP Tools**: ครอบคลุมการเริ่มต้น/ปิด session, token-budgeted context pack, Autonomous Awakening (`memory_awaken`), Hybrid Thai/BM25 Retrieval, บันทึก ADR/Insight/Mistake/Session Log, ตรวจสอบความถูกต้องกับซอร์สโค้ดจริง (`memory_verifySourceTruth`), และการจัดการ lifecycle (`promote`, `supersede`, `retract`, `expire`, `forgetEvidence`)
- **MCP Resources, Resource Templates & Prompts**:
  - Static Resources: `memory://current/status`, `memory://current/radar`, `memory://current/awaken`, `memory://current/rules`, `memory://current/adrs`, `memory://current/mistakes`, `memory://graph`
  - Resource Templates: `memory://notes/{recordId}`, `memory://sessions/{sessionId}`, `memory://projects/{projectRoot}/status`, `memory://projects/{projectRoot}/radar`, `memory://projects/{projectRoot}/awaken`, `memory://projects/{projectRoot}/rules`
  - Governed Prompt: `session-handoff`
- **Unified Knowledge Graph & Causal Triads**: สกัดความเชื่อมโยงอัตโนมัติระหว่าง Notes, ไฟล์โค้ด (`filePaths`), สัญลักษณ์ (`symbols`), `[[wikilinks]]`, สายวิวัฒนาการ (`supersedes`), และสามเหลี่ยมเหตุ-ผล (`Mistake -> Insight -> ADR`) แบบถ่วงน้ำหนัก IDF
- **WebUI Mission Control (`npm run webui`)**: **Vite 8 + React 19 SPA** (`webui/` -> `dist/webui/`) พร้อม TanStack Router & Query, Tailwind CSS v4, shadcn/ui, **Interactive Knowledge Graph (`@xyflow/react` + `elkjs`)**, **AI Memory Curator Studio** (ภาษาไทย/อังกฤษ), **MCP Console**, clean URL deep-linking (`/overview`, `/kanban`, `/graph`, `/curator`, `/mcp`) และการป้องกัน DNS rebinding / CSRF / CSP
- **Multi-Project Routing & Multi-IDE Sync (`generate-client-configs`)**: รองรับการสลับหลายโปรเจกต์ผ่าน `projectRoot` และการซิงก์ไฟล์ตั้งค่า MCP พร้อมกฎ Always-On V2 Protocol ให้ Antigravity, Cursor, Claude Code, Windsurf, Codex, OpenCode, Zed และ GitHub Copilot ในคำสั่งเดียว

---

## สถาปัตยกรรมและโครงสร้างไฟล์สำคัญ

```text
Awakened-AI-System/
  src/
    v2.ts                         # Entry point หลักของ Project Memory V2 MCP Server (stdio)
    v2-admin.ts                   # Entry point ของ Operator CLI (v2-admin)
    v2/
      app.ts                      # MCP Server registration (34 tools, resources, templates, prompts)
      composition.ts              # Runtime composition, auto build-sync & lease/projection wiring
      public-tools.ts             # 34 V2 tool handlers, source-truth verification & lineage
      entity-extractor.ts         # Unified extractor สำหรับ filePaths, symbols และ [[wikilinks]]
      curator.ts                  # Automated deduplication, supersession & verified promotion
      admin.ts                    # Operator CLI commands (bootstrap, sync-build, webui, cutover)
      webui.ts                    # Hardened local HTTP server & REST API สำหรับ Mission Control
      webui/                      # Backend MVC models/controllers & bounded immutable SPA asset server (spa-assets.ts)
    orchestrator/                 # Event store, SQLite worker, migrations, projections & fresh-start
  webui/                          # Isolated Vite 8 + React 19 + TanStack Router/Query + Tailwind CSS v4 + shadcn/ui + XYFlow/ELK SPA
  dist/                           # Compiled V2 MCP server (v2.js), admin CLI (v2-admin.js), workers & dist/webui/ SPA bundle
  memory-v2/                      # Authoritative Project Memory V2 vault descriptor & local state
  memory/                         # Frozen read-only V1 archive (0o444 — ห้ามเขียนทับโดยตรง)
  docs/
    v2-fresh-start-operations.md  # คู่มือปฏิบัติการและสถาปัตยกรรม Fresh-Start / Production V2
    runbooks/v2-ci-qualification.md
```

---

## ความต้องการของระบบและการติดตั้ง

- **Node.js**: `>= 24.16.0` (พร้อม built-in `node:sqlite`, SQLite `>= 3.51.3`, WAL และ FTS5)

```bash
npm install
npm run setup:webui
npm run check:runtime
npm run build:webui
npm run build
```

---

## คำสั่งหลักใน `package.json`

| คำสั่ง | รายละเอียด |
| --- | --- |
| `npm run check:runtime` | ตรวจสอบ Node.js, `node:sqlite`, WAL, FTS5 และ fail-closed query-only mode |
| `npm run build` | Bundle MCP V2 (`dist/v2.js`), Operator CLI (`dist/v2-admin.js`), workers และ `dist/v2-build.json` |
| `npm run start` / `npm run start:v2` | รัน Project Memory V2 MCP Server (`dist/v2.js`) ผ่าน stdio |
| `npm run setup:webui` | ติดตั้ง dependencies ของ WebUI SPA (`npm --prefix webui ci`) |
| `npm run build:webui` | คอมไพล์ WebUI SPA ด้วย Vite (`dist/webui/`) |
| `npm run test:webui` | รันชุดทดสอบ WebUI Vitest |
| `npm --prefix webui run typecheck` | ตรวจสอบชนิดข้อมูล TypeScript ของ WebUI SPA (`tsc -b --noEmit`) |
| `npm run dev:webui` | รัน Vite dev server สำหรับ WebUI (`http://localhost:5173`) |
| `npm run webui` | เปิด WebUI Mission Control ที่ `http://127.0.0.1:4321` |
| `npm run v2-admin -- <cmd>` | เรียกใช้ Operator CLI (`dist/v2-admin.js`) |
| `npm run typecheck` | ตรวจสอบชนิดข้อมูล TypeScript (`tsc --noEmit`) |
| `npm run test:v2` | รันชุดทดสอบ V2 MCP Tools, AI IDE Acceleration, WebUI/Curator และ Cutover Gate |
| `npm test` | รันชุดทดสอบมาตรฐานแบบขนานผ่าน LPT-scheduled worker runner (`scripts/run-test-profile.js`) |
| `npm run test:all` | รันชุดทดสอบทั้งหมดแบบ serial ครบทุกไฟล์ |
| `npm run test:rollout-control-plane` | รันชุดตรวจสอบ rollout control plane และ CI lifecycle gates |
| `npm run test:v2-fresh-start-foundation` | รันชุดทดสอบ Fresh-Start Foundation Gate แบบ isolated |
| `npm run test:build-artifacts` | Build และทดสอบ smoke test ของ compiled workers และ V2 artifacts จริง |

---

## การตั้งค่าใช้งานกับโปรเจกต์และ AI IDE (`v2-admin`)

### 1. เริ่มต้นใช้งานโปรเจกต์ใหม่ (`bootstrap-project`)

สร้างคลัง `memory-v2` พร้อมเปิดสถานะ Active และสร้างไฟล์ตั้งค่า IDE ทั้งหมดในคำสั่งเดียว:

```bash
node dist/v2-admin.js bootstrap-project \
  --project-root "C:/path/to/project" \
  --write-configs
```

### 2. ซิงก์ไฟล์ตั้งค่า MCP และกฎ V2 ให้ทุก IDE (`generate-client-configs`)

```bash
node dist/v2-admin.js generate-client-configs \
  --project-root "C:/Users/Server/Desktop/Awakened-AI-System" \
  --v2-vault-root "C:/Users/Server/Desktop/Awakened-AI-System/memory-v2" \
  --v1-archive-root "C:/Users/Server/Desktop/Awakened-AI-System/memory" \
  --release-id "d45b1956-e05b-4316-b68d-7014d7dda665" \
  --output-dir "C:/Users/Server/Desktop/Awakened-AI-System"
```

คำสั่งนี้สร้างและอัปเดต:
- MCP Configs (ค่าเริ่มต้น `MEMORY_V2_AUTO_SYNC_BUILD="0"` เพื่อรักษาความเข้มงวดของ Release Seal; เปิดแบบ opt-in ได้ด้วย `--auto-sync-build 1`): `.antigravity/mcp.json`, `.cursor/mcp.json`, `.windsurf/mcp.json`, `.mcp.json`, `.claude/settings.local.json`, `.codex/config.toml`, `opencode.json`, `.zed/settings.json`
- Example Configs: `.antigravity/mcp.example.json`, `.windsurf/mcp_config.example.json`
- Synchronized V2 Rules: `CLAUDE.md`, `.cursor/rules/project-memory.mdc`, `.windsurf/rules/project-memory.md`, `.rules`, `.windsurfrules`, `.github/copilot-instructions.md`

### 3. ซิงก์ Build Identity และ Rebuild Projections

หลังรัน `npm run build` ระบบรองรับการอัปเดต build hash อัตโนมัติเมื่อเปิด `MEMORY_V2_AUTO_SYNC_BUILD=1` หรือสั่งผ่าน CLI ได้โดยตรง:

```bash
# ซิงก์ buildIdentityHash และ schemaIdentityHash เข้ากับ store ปัจจุบัน
node dist/v2-admin.js sync-build \
  --project-root "C:/Users/Server/Desktop/Awakened-AI-System" \
  --v2-vault-root "C:/Users/Server/Desktop/Awakened-AI-System/memory-v2" \
  --v1-archive-root "C:/Users/Server/Desktop/Awakened-AI-System/memory" \
  --release-id "d45b1956-e05b-4316-b68d-7014d7dda665"

# สร้าง SQLite read/search projections ใหม่จาก authoritative event log (รองรับทั้งโหมด normal และ recovery)
node dist/v2-admin.js rebuild-projections \
  --project-root "C:/Users/Server/Desktop/Awakened-AI-System" \
  --v2-vault-root "C:/Users/Server/Desktop/Awakened-AI-System/memory-v2" \
  --v1-archive-root "C:/Users/Server/Desktop/Awakened-AI-System/memory"

# ตรวจสอบความสมบูรณ์ของคลัง V1 แบบ read-only
node dist/v2-admin.js verify-v1-archive \
  --project-root "C:/Users/Server/Desktop/Awakened-AI-System" \
  --v2-vault-root "C:/Users/Server/Desktop/Awakened-AI-System/memory-v2" \
  --v1-archive-root "C:/Users/Server/Desktop/Awakened-AI-System/memory"
```

---

## WebUI Mission Control

หน้าต่างควบคุมและสำรวจความจำแบบ SPA ยุคใหม่ ขับเคลื่อนด้วย **Vite 8 + React 19 + TanStack Router & Query + Tailwind CSS v4 + shadcn/ui + `@xyflow/react` + `elkjs`**:

```bash
# ติดตั้ง dependencies และ build SPA client (ครั้งแรกหรือเมื่อแก้ไข webui/)
npm run setup:webui
npm run build:webui

# เปิด WebUI Mission Control (Production Mode) ที่ http://127.0.0.1:4321
npm run webui

# หรือระบุพอร์ตและโปรเจกต์เริ่มต้น
node dist/v2-admin.js webui --project-root "C:/Users/Server/Desktop/Awakened-AI-System" --port 4321

# หรือพัฒนาในโหมด Dev (Vite HMR พร้อม proxy /api ไปยัง backend)
npm run webui          # เทอร์มินัล 1: รัน backend server
npm run dev:webui      # เทอร์มินัล 2: รัน Vite dev server ที่ http://localhost:5173
```

### 5 หน้าจอหลักใน SPA (`webui/`)

1. **Overview (`/overview`)**: Health score gauge, กราฟ Recharts แสดงสัดส่วนโน้ตและกิจกรรมย้อนหลัง, Live AI Session Activity Map, **Causal Triads** แบบถ่วงน้ำหนัก IDF (`Mistake -> Insight -> ADR` พร้อม context badges ของไฟล์/สัญลักษณ์/เซสชันที่คลิกนำทางได้) และ **AI Curator Insights** (`RecommendationsCard`)
2. **Kanban & Table Board (`/kanban`)**: จัดการโน้ตแยกตามสถานะ (`candidate`, `provisional`, `verified`, `superseded`), ปุ่มสลับโหมดตาราง (Table mode), IME-safe quick entry, ค้นหาแบบ debounced (ปุ่มลัด `/`) และ confirmation dialog ก่อนเปลี่ยนสถานะเชิงธรรมาภิบาล
3. **Interactive Knowledge Graph (`/graph`)**: ขับเคลื่อนด้วย `@xyflow/react` + `elkjs` ใน 2 มุมมองหลัก (**Story Flow**: `Session -> Memory -> File -> Symbol` และ **Orbital Galaxy**), ค่าเริ่มต้นโหมด **Focused Related-Only** (`#graph-focus-related-toggle`), glassmorphic node cards, MiniMap, Zoom HUD, ดับเบิลคลิกเปิดอ่านโน้ต และ Inspector ด้านข้าง
4. **AI Memory Curator Studio (`/curator`)**: ห้องสนทนา Curator ภาษาไทย/อังกฤษ, ตรวจสอบสุขภาพคลังความจำ (`audit`), ตรวจกลุ่มโน้ตซ้ำ (`duplicateGroups`) และปุ่ม `Auto-Curate` ในคลิกเดียว
5. **MCP Console (`/mcp`)**: ตัวเรียกใช้งาน V2 MCP Tools ทั้ง 34 รายการแบบอินเทอร์แอกทีฟ พร้อม JSON templates, parameter pills และ confirmation guard สำหรับเครื่องมือที่แก้ไขข้อมูล

### Deep-Linking, คีย์ลัด และความปลอดภัย

- **Clean URL & Search Params Deep-Linking**: รองรับ URL จริงของ SPA เช่น `/overview?project=...`, `/kanban?q=curator&note=<recordId>`, `/graph?node=file:src/v2/webui.ts&mode=flow&kind=file&session=<sessionId>`, `/curator`, `/mcp`
- **Shell UX & Reliability**: `Ctrl+K` / `Cmd+K` สำหรับ Command Palette, กด `/` เพื่อค้นหาด่วนบน Kanban, Multi-Project Switcher, Light/Dark theme persistence และ abort-aware exponential backoff สำหรับ HTTP transient (`429/502/503/504`)
- **Backend Static & Security Hardening**: ตรวจสอบ loopback `Host` header (ป้องกัน DNS rebinding), `X-PM-CSRF-Token` แบบ constant-time, `Sec-Fetch-Site` / `Origin`, CSP headers, ระบบโหลด SPA asset แบบ bounded preloader (`MAX_SPA_INDEX_BYTES` 2 MiB, `MAX_SPA_ASSET_BYTES` 16 MiB, `MAX_SPA_TOTAL_BUNDLE_BYTES` 64 MiB, `MAX_SPA_ASSET_COUNT` 256, `MAX_SPA_SCAN_DEPTH` 6) และซิงก์ build identity อัตโนมัติเมื่อเปิด `MEMORY_V2_AUTO_SYNC_BUILD`

---

## Always-On Memory V2 Workflow (34 MCP Tools)

ทุกเซสชันของ AI Agent ปฏิบัติตามขั้นตอนมาตรฐานดังนี้:

1. **เริ่มต้นงาน**: เรียก `memory_sessionStart` และเก็บ `sessionId`, `leaseId`, `leaseToken`, `fencingToken`
2. **ดึงบริบทตามงาน**: เรียก `memory_contextPack` (แนบ `filePaths` หรือ `symbols` เพื่อรับ **Proactive Mistake & ADR Warnings** เฉพาะจุด) และอ่านรายละเอียดด้วย `memory_get`, `memory_search`, `memory_list`, `memory_recent`, `memory_followUpRadar`
3. **ตรวจสอบก่อนงานเสี่ยง**: เรียก `memory_selfCheck` ก่อนแก้ไขหลายไฟล์ ปรับโครงสร้าง หรือ deploy
4. **บันทึกความรู้ระหว่างทำงาน**:
   - การตัดสินใจเชิงสถาปัตยกรรม: `memory_writeADR` (รองรับ `autoVerify: true` เมื่อมี session lease ที่ถูกต้อง)
   - บทเรียนสำคัญ: `memory_writeInsight`
   - ข้อผิดพลาดและการป้องกันซ้ำ: `memory_writeMistake`
   - ความคืบหน้าระหว่างทาง / หลักฐาน: `memory_checkpoint`, `memory_recordEvidenceBatch`
   - การจัดการสถานะความจำ: `memory_promote`, `memory_supersede`, `memory_retract`, `memory_expire`, `memory_forgetEvidence`
   - การแตกงานให้ Subagent: `memory_sessionFork`, `memory_recordChildResult`, `memory_completeChildSession`
5. **ปิดเซสชันอย่างสมบูรณ์**: เรียก `memory_sessionEnd` (`finalize: true`) ตามด้วย `memory_verifyVault` / `memory_verifySourceTruth` / `memory_v2Status`

---

## ประวัติการอัปเดต (Releases)

ดูรายละเอียดทั้งหมดได้ที่ [GitHub Releases](https://github.com/fastest4u/Awakened-AI-System/releases):

- **[v2.3.0](https://github.com/fastest4u/Awakened-AI-System/releases/tag/v2.3.0) (2026-11-14 — Latest, PR #18)**: ย้าย WebUI ไปสู่ Isolated **Vite 8 + React 19 + TanStack Router/Query + Tailwind CSS v4 + shadcn/ui SPA** (`webui/` -> `dist/webui/`), อัปเกรด Interactive Knowledge Graph ด้วย **`@xyflow/react` + `elkjs`** (โหมด **Story Flow** & **Orbital Galaxy** + ค่าเริ่มต้น **Focused Related-Only**), รองรับ **Cross-Branch V2 Session Continuity**, bounded gzip + ETag SPA asset serving (`spa-assets.ts`), abort-aware exponential backoff API client และลบโค้ด legacy `/mvc/*` ออกทั้งหมด
- **[v2.2.0](https://github.com/fastest4u/Awakened-AI-System/releases/tag/v2.2.0) (2026-11-13 — PR #16, PR #17)**: เปิดตัว **WebUI Mission Control** REST API พร้อม loopback/CSRF/CSP hardening, **AI Memory Curator** (`audit`, `auto-curate`, สนทนาไทย/อังกฤษ), MCP Static & URI-Template Resources (`memory://*`) และ IDF-weighted **Causal Triads** (`Mistake -> Insight -> ADR`)
- **[v2.1.0](https://github.com/fastest4u/Awakened-AI-System/releases/tag/v2.1.0) (2026-10-21 — PR #15)**: เพิ่ม **Autonomous Awakening (`memory_awaken`)**, **Hybrid Thai/BM25 Retrieval**, **Multi-Project Routing (`projectRoot`)**, Operator CLI (`bootstrap-project`, `sync-build`, `rebuild-projections`) และ **Multi-IDE Sync** (`generate-client-configs` ครบ 8 IDEs)
- **[v2.0.0](https://github.com/fastest4u/Awakened-AI-System/releases/tag/v2.0.0) (2026-10-21 — PR #10, PR #13, PR #14)**: **Fresh-Start V2 Production Completion (`F1–F4`)** — append-only SQLite event store + cryptographic HMAC chain, root/child session leases & fencing tokens, 34 MCP tools, full-body governed Markdown notes, privacy erasure (`forgetEvidence`), key rotation, fenced backup/restore/replay และ frozen read-only V1 archive (`0o444`)

---

## เอกสารเพิ่มเติม

- [V2 Fresh-Start & Production Operations](docs/v2-fresh-start-operations.md)
- [V2 CI Qualification Runbook](docs/runbooks/v2-ci-qualification.md)
- [Always-On Agent Protocol (`AGENTS.md`)](AGENTS.md)
