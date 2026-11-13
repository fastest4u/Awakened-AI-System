# Awakened AI Memory MCP Server (Project Memory V2)

MCP Server สำหรับระบบความจำระยะยาวระดับ Production (**Project Memory V2**) ที่จัดเก็บข้อมูลในรูปแบบ **Event-Sourced SQLite + Deterministic Read Projections + Full-Text Search (FTS5) + Causal Knowledge Graph** พร้อม **WebUI Mission Control** และระบบ **Always-On Governed Session Lifecycle** สำหรับ AI IDE และ Autonomous Agents ทุกค่าย

## ภาพรวมระบบ (Project Memory V2)

- **Authoritative Store (`memory-v2/`)**: บันทึกทุกเหตุการณ์แบบ append-only พร้อม cryptographic HMAC integrity chain, fencing tokens, session leases และ verified read projections
- **Frozen V1 Archive (`memory/`)**: เก็บคลัง Markdown V1 เดิมในสถานะ read-only (`0o444`) พร้อม cryptographic archive manifest ที่ตรวจสอบได้ตลอดเวลาผ่าน `verify-v1-archive`
- **34 Public MCP Tools**: ครอบคลุมการเริ่มต้น/ปิด session, token-budgeted context pack, ค้นหาความจำ, บันทึก ADR/Insight/Mistake/Session Log, ตรวจสอบความถูกต้องกับซอร์สโค้ดจริง (`memory_verifySourceTruth`), และการจัดการ lifecycle (`promote`, `supersede`, `retract`, `expire`, `forgetEvidence`)
- **MCP Resources, Resource Templates & Prompts**:
  - Static Resources: `memory://current/status`, `memory://current/radar`, `memory://current/awaken`, `memory://current/rules`, `memory://current/adrs`, `memory://current/mistakes`, `memory://graph`
  - Resource Templates: `memory://notes/{recordId}`, `memory://sessions/{sessionId}`, `memory://projects/{projectRoot}/status`, `memory://projects/{projectRoot}/radar`, `memory://projects/{projectRoot}/awaken`, `memory://projects/{projectRoot}/rules`
  - Governed Prompt: `session-handoff`
- **Unified Knowledge Graph & Causal Triads**: สกัดความเชื่อมโยงอัตโนมัติระหว่าง Notes, ไฟล์โค้ด (`filePaths`), สัญลักษณ์ (`symbols`), `[[wikilinks]]`, สายวิวัฒนาการ (`supersedes`), และสามเหลี่ยมเหตุ-ผล (`Mistake -> Insight -> ADR`) แบบถ่วงน้ำหนัก IDF
- **WebUI Mission Control (`npm run webui`)**: แดชบอร์ดแบบ Local-First พร้อมระบบป้องกัน DNS Rebinding / CSRF / CSP, Kanban Lifecycle Board, Interactive Knowledge Graph, Deep-Linking (`#graph?...` / `#view=...`) และ Automated Memory Curator
- **Multi-IDE Sync (`generate-client-configs`)**: ซิงก์ไฟล์ตั้งค่า MCP และกฎ Always-On V2 Protocol ให้กับ Antigravity, Cursor, Claude Code, Windsurf, Codex, OpenCode, Zed และ GitHub Copilot ในคำสั่งเดียว

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
      webui/                      # Reactive Web Components, Kanban, Knowledge Graph & Deep-Linking
    orchestrator/                 # Event store, SQLite worker, migrations, projections & fresh-start
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
npm run check:runtime
npm run build
```

---

## คำสั่งหลักใน `package.json`

| คำสั่ง | รายละเอียด |
| --- | --- |
| `npm run check:runtime` | ตรวจสอบ Node.js, `node:sqlite`, WAL, FTS5 และ fail-closed query-only mode |
| `npm run build` | Bundle MCP V2 (`dist/v2.js`), Operator CLI (`dist/v2-admin.js`), workers และ `dist/v2-build.json` |
| `npm run start` / `npm run start:v2` | รัน Project Memory V2 MCP Server (`dist/v2.js`) ผ่าน stdio |
| `npm run webui` | เปิด WebUI Mission Control ที่ `http://127.0.0.1:4321` |
| `npm run v2-admin -- <cmd>` | เรียกใช้ Operator CLI (`dist/v2-admin.js`) |
| `npm run typecheck` | ตรวจสอบชนิดข้อมูล TypeScript (`tsc --noEmit`) |
| `npm run test:v2` | รันชุดทดสอบ V2 MCP Tools, AI IDE Acceleration, WebUI/Curator และ Cutover Gate |
| `npm test` | รันชุดทดสอบมาตรฐานทั้งหมดแบบ serial ตามโปรไฟล์ CI |
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
- MCP Configs (พร้อม `MEMORY_V2_AUTO_SYNC_BUILD="1"`): `.antigravity/mcp.json`, `.cursor/mcp.json`, `.windsurf/mcp.json`, `.mcp.json`, `.claude/settings.local.json`, `.codex/config.toml`, `opencode.json`, `.zed/settings.json`
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

เปิดหน้าต่างควบคุมและสำรวจความจำแบบอินเทอร์แอคทีฟ:

```bash
npm run webui
# หรือระบุพอร์ตและโปรเจกต์เริ่มต้น
node dist/v2-admin.js webui --project-root "C:/Users/Server/Desktop/Awakened-AI-System" --port 4321
```

ความสามารถหลักใน WebUI:
- **Overview & Telemetry**: คะแนนสุขภาพความจำ, สถิติสถานะโน้ต, ปุ่มสั่งงาน Curator อัตโนมัติ และรายการ **Causal Triads** (`Mistake -> Insight -> ADR`)
- **Kanban Lifecycle Board**: จัดการโน้ตแยกตามสถานะ (`candidate`, `provisional`, `verified`, `superseded`) พร้อมปุ่มคลิกข้ามไปยังไฟล์/สัญลักษณ์บนกราฟ
- **Interactive Knowledge Graph**: แผนผังเชื่อมโยง Notes, Code Files, Symbols, Wikilinks และ Supersession Lineage พร้อมโหมด 1-Hop Focus, ดับเบิลคลิกเปิดอ่านโน้ต และปุ่มสลับกลับไปยัง Kanban
- **URL Deep-Linking**: แชร์หรือบุ๊กมาร์กสถานะหน้าจอได้ผ่าน URL Hash ทั้งรูปแบบ `#graph?q=curator&kind=file`, `#kanban?note=<recordId>` และ `#view=graph&q=curator&type=file`
- **Local Security Hardening**: บังคับตรวจสอบ loopback `Host` header (ป้องกัน DNS rebinding), `X-PM-CSRF-Token` แบบ constant-time, `Sec-Fetch-Site` / `Origin`, CSP headers และอนุญาตเฉพาะโปรเจกต์ที่ลงทะเบียนแล้วเท่านั้น

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

## เอกสารเพิ่มเติม

- [V2 Fresh-Start & Production Operations](docs/v2-fresh-start-operations.md)
- [V2 CI Qualification Runbook](docs/runbooks/v2-ci-qualification.md)
- [Always-On Agent Protocol (`AGENTS.md`)](AGENTS.md)
