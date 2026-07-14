co# Awakened AI Memory MCP Server

MCP Server สำหรับระบบความจำแบบ project-local ที่เก็บข้อมูลเป็น Markdown vault สไตล์ SPX และออกแบบให้ AI agent หลายตัวใช้ความจำชุดเดียวกันได้ผ่าน MCP tools โดยไม่ต้องผูกกับ slash command เฉพาะ IDE ใด IDE หนึ่ง

เป้าหมายหลักคือทำให้ทุกโปรเจกต์มีความจำของตัวเองอยู่ข้างโค้ดจริง เช่น decision, session log, follow-up, mistake, runbook และ insight เพื่อให้ agent เริ่มงานจากบริบทเดิมได้เร็วขึ้น ลดการอ่านทั้ง vault และทำให้ขั้นตอนเริ่มงานกับปิดงานตรวจสอบได้ชัดเจน

## ภาพรวม

- ใช้ `memory/` เป็น vault หลักของแต่ละโปรเจกต์
- รองรับ MCP client ที่ใช้ stdio เช่น OpenCode, Codex, Zed, Cursor, Windsurf, Google Antigravity และ client อื่นที่รองรับ MCP
- ใช้ Obsidian เป็น UI เสริมได้ แต่ตัวระบบยังเป็น Markdown ล้วนและใช้งานได้แม้ไม่เปิด Obsidian
- มี workflow บังคับเชิงนุ่มนวลผ่าน lifecycle guardrail และ quality gate
- มี task-aware retrieval modes สำหรับงาน coding, debugging, review, deploy, planning และ docs
- มี Follow-up Radar สำหรับหา open work จาก unchecked task และหัวข้อ follow-up
- มี vault verification สำหรับตรวจ structure, frontmatter, wikilink, duplicate, staleness และคะแนนสุขภาพของ vault

## สถาปัตยกรรม

ระบบนี้แบ่งเป็น 3 ชั้นหลัก:

1. **Markdown Vault**
   เก็บความจำทั้งหมดใน `memory/` ของโปรเจกต์ที่เรียกใช้งาน

2. **MCP Server**
   ให้ client เรียก tool สำหรับค้นหา อ่าน เขียน ตรวจสอบ และปิด session

3. **AI Client Integration Pack**
   `memory_bootstrapProject` สร้างไฟล์ config/rules ให้ client ต่าง ๆ ใช้ protocol เดียวกัน

โค้ดหลักอยู่ใน `src/` และ build ออกเป็น `dist/index.js` สำหรับ MCP stdio, `dist/cli.js` สำหรับคำสั่ง `memory-vault`, `dist/workers/project-store.worker.js` สำหรับ SQLite worker และ `dist/build-info.json` สำหรับ runtime diagnostics

## โครงสร้าง Vault

ค่าเริ่มต้นของ vault คือ project-local:

```text
<calling-project>/
  memory/
    .obsidian/
    .memory-mcp/
    AGENTS.md
    AGENT-IDENTITY.md
    00_Index/
    01_Project_Rules/
    04_Architecture_Decisions/
    05_Agent_Session_Logs/
    07_Insights/
    08_Mistakes/
    09_Runbooks/
    10_Daily/
    11_Tasks/
    12_Kanban/
    13_Diagrams/
    14_Mindmaps/
    99_Templates/
```

โฟลเดอร์สำคัญ:

| Path | หน้าที่ |
| --- | --- |
| `AGENTS.md` | กติกาหลักที่ agent ต้องอ่านเมื่อเริ่มงาน |
| `AGENT-IDENTITY.md` | บทบาทและตัวตนของ agent ในโปรเจกต์ |
| `00_Index/` | navigation, goals, open follow-ups, protocol และ dashboard |
| `04_Architecture_Decisions/` | ADR สำหรับ decision ที่ควรจำระยะยาว |
| `05_Agent_Session_Logs/` | session log แบบ append-only |
| `07_Insights/` | บทเรียนที่สกัดจากหลาย session |
| `08_Mistakes/` | failure mode, root cause และวิธีเลี่ยงซ้ำ |
| `09_Runbooks/` | ขั้นตอนซ้ำได้ เช่น deploy, migration, recovery |
| `.memory-mcp/` | metadata ของ MCP เช่น usage scoring และ lifecycle state |
| `.obsidian/` | profile สำหรับเปิด vault ใน Obsidian |

## การติดตั้ง

ต้องมี Node.js `22.22.3` หรือใหม่กว่า พร้อม runtime SQLite `3.51.3` หรือใหม่กว่า โดยแนะนำ Node.js `24.16.0` หรือใหม่กว่าในสาย Node.js 24 LTS จากนั้นติดตั้ง dependency:

```bash
npm install
```

Build server:

```bash
npm run build
```

รันแบบ local:

```bash
npm run start
```

Development loop ที่ใช้บ่อย:

```bash
npm run typecheck
npm run build
```

คำสั่งใน `package.json`:

| Command | รายละเอียด |
| --- | --- |
| `npm run check:runtime` | ตรวจ Node.js, `node:sqlite`, SQLite, WAL, FTS5 และ capability ที่จำเป็นแบบ fail-closed |
| `npm run start` | ตรวจ runtime แล้วรัน `node dist/index.js` |
| `npm run build` | ตรวจ runtime แล้วสร้าง server, CLI, worker และ build metadata ใต้ `dist/` |
| `npm run typecheck` | ตรวจ TypeScript โดยไม่ emit |
| `npm run lint` | alias ของ typecheck |
| `npm test` | compile test แล้วรัน default suite แบบ serial; stress 10 seeds ถูก skip โดยตั้งใจ |
| `npm run test:build` | compile `src/` และ `tests/` ไปที่ `dist-test/` |
| `npm run test:stress` | compile แล้วรัน event-store stress gate 10 seeds (`16 × 250` events ต่อ seed) |
| `npm run test:build-artifacts` | build แล้ว smoke-test worker artifact จริง |
| `npm run memory-vault -- <command>` | เรียก CLI ที่ build แล้วโดยไม่ต้อง `npm link` |
| `npm run dev` | build แล้วรัน server |

GitHub Actions ที่ `.github/workflows/ci.yml` รัน runtime probe, typecheck, default tests, build และ artifact smoke test บน Ubuntu/Windows ด้วย Node.js `22.22.3` และ `24.16.0` ส่วน `.github/workflows/sqlite-stress.yml` รัน stress suite แบบ serialized ทุกสัปดาห์หรือเมื่อสั่ง manual dispatch

## V2 Administration CLI

Subproject 1 เพิ่มคำสั่งดูแล event store แบบ explicit ผ่าน CLI โดยยัง **ไม่** เปลี่ยน MCP lifecycle เดิมไปใช้ V2 และยังไม่เปิด primary-mode cutover ทุกคำสั่งต้องระบุ project/vault แบบ literal:

```bash
# ตรวจสถานะก่อน initialize โดยไม่เขียนไฟล์
npm run memory-vault -- orchestrator-init --project-root "C:/path/to/project" --vault "C:/path/to/project/memory"

# initialize แบบ explicit; replica ที่มี descriptor แต่ยังไม่มี local store ต้องเพิ่ม --replica initialize-local
npm run memory-vault -- orchestrator-init --project-root "C:/path/to/project" --vault "C:/path/to/project/memory" --apply
npm run memory-vault -- orchestrator-init --project-root "C:/path/to/project" --vault "C:/path/to/project/memory" --replica initialize-local --apply

# ตรวจ binding/runtime/store และตรวจ integrity
npm run memory-vault -- orchestrator-status --project-root "C:/path/to/project" --vault "C:/path/to/project/memory"
npm run memory-vault -- orchestrator-integrity --project-root "C:/path/to/project" --vault "C:/path/to/project/memory" --full
```

`orchestrator-init` เป็น inspection-only โดยค่าเริ่มต้นและจะเขียนเมื่อมี `--apply` เท่านั้น `orchestrator-status` แสดงเฉพาะ safe projection ของ identity/path/runtime และ `orchestrator-integrity` รัน quick check หรือ full chain check เมื่อเพิ่ม `--full`

## Environment Variables

| ตัวแปร | รายละเอียด |
| --- | --- |
| `MEMORY_PROJECT_ROOT` | path ของโปรเจกต์ที่ต้องการให้มี `memory/` |
| `MEMORY_VAULT_DIR` | ชื่อโฟลเดอร์ vault ค่าเริ่มต้นคือ `memory` |
| `MEMORY_VAULT_PATH` | path ของ vault แบบชัดเจน ใช้แทน `MEMORY_PROJECT_ROOT` + `MEMORY_VAULT_DIR` |
| `MEMORY_EMBEDDINGS` | optional hybrid search provider: `none`, `hash`, หรือ `http`; ค่าเริ่มต้นคือ `none` |
| `MEMORY_EMBEDDINGS_DIM` | ขนาด vector สำหรับ `hash` และ hint สำหรับ `http`; ค่าเริ่มต้นคือ `256` |
| `MEMORY_EMBEDDINGS_ENDPOINT` | endpoint สำหรับ `MEMORY_EMBEDDINGS=http` |
| `MEMORY_EMBEDDINGS_MODEL` | model name สำหรับ `MEMORY_EMBEDDINGS=http` |
| `MEMORY_EMBEDDINGS_API_KEY` | bearer token สำหรับ HTTP embedding endpoint ถ้าต้องใช้ |
| `MEMORY_EMBEDDINGS_TIMEOUT_MS` | timeout ต่อ HTTP embedding request; ค่าเริ่มต้นคือ `15000` |

ถ้า MCP client ไม่ได้ start server จาก workspace root ให้ตั้ง `MEMORY_PROJECT_ROOT` เสมอ เพื่อไม่ให้ vault ถูกสร้างผิดที่

Embeddings ปิดอยู่โดยค่าเริ่มต้นเพื่อให้ server ทำงานแบบ local-first/offline เหมือนเดิม ถ้าตั้ง `MEMORY_EMBEDDINGS=hash` จะใช้ deterministic local hash embeddings; ถ้าตั้ง `http` ต้องมี endpoint/model แบบ OpenAI-compatible หรือ local embedding server. ถ้า provider ล่มหรือส่ง response ผิดรูปแบบ search จะ fallback เป็น lexical-only ชั่วคราวและไม่ทำให้ MCP tool fail

## MCP Client Setup

ตัวอย่าง config แบบ stdio:

```json
{
  "mcpServers": {
    "project-memory": {
      "command": "node",
      "args": ["C:/Users/Server/Desktop/Awakened-AI-System/dist/index.js"],
      "env": {
        "MEMORY_PROJECT_ROOT": "C:/path/to/your/project"
      }
    }
  }
}
```

สำหรับแต่ละโปรเจกต์ ให้เปลี่ยน `MEMORY_PROJECT_ROOT` เป็น root ของโปรเจกต์นั้น แล้วเรียก:

```text
memory_bootstrapProject
```

## Bootstrap Project

`memory_bootstrapProject` สร้าง vault และ integration pack ให้โปรเจกต์ปลายทาง

input สำคัญ:

| Field | ค่าเริ่มต้น | รายละเอียด |
| --- | --- | --- |
| `projectName` | auto | ชื่อโปรเจกต์ใน memory note |
| `overwrite` | `false` | ถ้าเป็น `true` จะเขียนทับไฟล์ config ที่มีอยู่ |
| `ideConfigs` | `true` | ถ้าเป็น `false` จะสร้างเฉพาะ vault ไม่สร้างไฟล์ IDE/client |

ไฟล์ที่ bootstrap สร้างได้:

| Client / ระบบ                      | ไฟล์                                                                                                                   |
| ------------------------------------| ------------------------------------------------------------------------------------------------------------------------|
| Shared agent rule                  | `AGENTS.md`                                                                                                            |
| OpenCode                           | `opencode.json`, `.opencode/commands/*.md`                                                                             |
| Codex                              | `.codex/config.toml`                                                                                                   |
| Zed                                | `.zed/settings.json`, `.rules`                                                                                         |
| Cursor                             | `.cursor/mcp.json`, `.cursor/rules/project-memory.mdc`                                                                 |
| Windsurf                           | `.windsurfrules`, `.windsurf/rules/project-memory.md`, `.windsurf/workflows/*.md`, `.windsurf/mcp_config.example.json` |
| Google Antigravity                 | `.antigravity/mcp.example.json`                                                                                        |
| Gemini / Antigravity compatibility | `GEMINI.md`                                                                                                            |
| GitHub Copilot                     | `.github/copilot-instructions.md`                                                                                      |
| Obsidian profile                   | `memory/.obsidian/*`, dashboard และ templates                                                                          |

ไฟล์ที่มีอยู่แล้วจะไม่ถูกเขียนทับ ยกเว้นส่ง `overwrite: true`

## Always-On Memory Workflow

ทุก session ที่มีความหมายควรใช้ flow นี้:

1. เริ่มงานด้วย `memory_sessionStart`
2. เรียก `memory_contextPack` ตาม task area และ mode
3. อ่าน full note ด้วย `memory_get` เฉพาะ path ที่ context pack เลือกมา
4. ตรวจ `followUps` ที่แนบมา หรือเรียก `memory_followUpRadar` ถ้าต้องการ scan งานค้างแบบเจาะจง
5. ก่อนงานเสี่ยง งานหลายไฟล์ deployment schema migration security หรือ refactor ให้เรียก `memory_selfCheck`
6. ระหว่างงาน ให้เขียน ADR, insight หรือ mistake เมื่อมี decision/lesson/failure ที่ควรจำ
7. ปิดงานด้วย `memory_sessionEnd`
8. ตรวจ `qualityGate` จาก session end แล้วเรียก `memory_verifyVault` เพื่อยืนยันสุขภาพ vault

กฎ token economy:

- ใช้ `memory_contextPack` ก่อนอ่าน note เต็มเสมอ
- อ่าน full body เฉพาะ note ที่ถูกเลือกหรือจำเป็นจริง
- ใช้ ADR, runbook, mistake และ recent session logs เป็นบริบทหลักก่อนอ่าน note กว้าง ๆ
- ถ้าบทเรียนซ้ำหลาย session ให้ promote เป็น insight

## Context Pack Modes

`memory_contextPack` และ `memory_sessionStart` รองรับ `mode` เหล่านี้:

| Mode | ใช้เมื่อ | สิ่งที่ถูก boost |
| --- | --- | --- |
| `auto` | ให้ระบบ infer จาก `query` และ `taskArea` | behavior แบบ generic ถ้า signal ไม่ชัด |
| `coding` | implement, API, component, schema, test | component, ADR, runbook, recent implementation log |
| `debugging` | bug, regression, exception, broken workflow | mistake, recent session, runbook |
| `review` | code review, audit, PR, quality check | project rules, mistake, ADR, verification note |
| `deploy` | production, release, migration, rollback | runbook, operational mistake, ADR |
| `planning` | roadmap, architecture, prioritization | goals, insight, ADR, dashboard |
| `docs` | README, setup guide, protocol update | reference, rules, index, runbook |

ถ้าใส่ `mode: "auto"` ระบบจะพยายาม resolve เป็น mode ที่ตรงกับ keyword เช่น `readme` จะเข้า `docs`, `bug` จะเข้า `debugging`, `deploy` จะเข้า `deploy`

## Lifecycle Guardrails และ Quality Gate

ระบบเขียนสถานะ lifecycle ไว้ที่:

```text
memory/.memory-mcp/lifecycle.json
```

ข้อมูลที่ track:

- เริ่ม session แล้วหรือยัง
- เรียก context pack แล้วหรือยัง
- เรียก self-check สำหรับงานเสี่ยงหรือยัง
- ปิด session แล้วหรือยัง
- quality gate ล่าสุดผ่านหรือไม่

`memory_sessionEnd` จะคืน `qualityGate` ที่ตรวจเรื่องสำคัญ เช่น:

- มี `memory_sessionStart`
- มี `memory_contextPack`
- งานเสี่ยงมี `memory_selfCheck`
- session log มี outcomes
- session log ระบุ verification
- vault verification ถูกเรียก
- vault ไม่มี error หรือ warning สำคัญ

ใช้ `memory_lifecycleStatus` เพื่อตรวจ active lifecycle และ recent gates

## Follow-up Radar

`memory_followUpRadar` ใช้หา open work จาก vault โดย scan:

- unchecked task เช่น `- [ ] ...`
- bullet ภายใต้หัวข้อ เช่น `Follow-ups`, `Next Actions`, `Open Items`, `Todo`, `Tasks`

Radar จะจัดอันดับตาม:

- `query`
- `taskArea`
- `mode`
- note type
- folder เช่น `Open-Followups`
- recency ของ note
- matched terms

`memory_sessionStart` และ `memory_contextPack` แนบ `followUps` แบบ compact ให้โดยอัตโนมัติ เพื่อให้เห็นงานค้างก่อนเริ่มงานใหม่

## Obsidian Profile

`memory_bootstrapProject` สร้าง profile สำหรับ Obsidian ใน `memory/.obsidian/` พร้อม note เริ่มต้น เช่น dashboard, templates, daily notes, task inbox, kanban, diagrams และ mind map

ปลั๊กอิน productivity ที่แนะนำ:

- Templater
- Dataview
- Tasks
- QuickAdd
- Obsidian Git
- Calendar
- Linter

ปลั๊กอิน visual ที่แนะนำ:

- Excalidraw
- Kanban
- Iconize
- Mind Map

MCP สร้าง config และ note ให้เท่านั้น ไม่ดาวน์โหลดหรือรัน community plugin code ผู้ใช้ต้องติดตั้งและเปิดใช้ plugin จาก Obsidian เอง

## รายการ Tools

### Read Tools

| Tool | หน้าที่ |
| --- | --- |
| `memory_search` | ค้นหา note ด้วย text, tags, folder หรือ type |
| `memory_get` | อ่าน note ด้วย `path`, `id` หรือ `title` |
| `memory_list` | list note ตาม folder, type หรือ tag |
| `memory_recent` | ดึง note ที่เพิ่ง updated หรือ created |

### Workflow Tools

| Tool | หน้าที่ |
| --- | --- |
| `memory_sessionStart` | เปิด session, โหลด startup context, update usage scoring |
| `memory_contextPack` | สร้าง context pack แบบ token-budgeted ตาม task และ mode |
| `memory_awaken` | ประเมิน memory state, risks และ next actions |
| `memory_selfCheck` | checklist ก่อนงานเสี่ยง พร้อมดึง mistake ที่เกี่ยวข้อง |
| `memory_sessionEnd` | เขียน session log, compact insight, verify vault และคืน quality gate |
| `memory_lifecycleStatus` | ดู lifecycle state และ recent quality gates |
| `memory_followUpRadar` | หา open follow-ups จาก task และ follow-up section |
| `memory_compactVault` | สรุป session logs เป็น insight digest |

### Write Tools

| Tool | หน้าที่ |
| --- | --- |
| `memory_writeSessionLog` | เขียน session log ใหม่ |
| `memory_writeInsight` | เขียน distilled insight |
| `memory_writeMistake` | เขียน mistake note พร้อม root cause และ avoidance |
| `memory_writeADR` | เขียน Architecture Decision Record |
| `memory_createFromTemplate` | สร้าง note จาก template มาตรฐาน |

### Verification Tools

| Tool | หน้าที่ |
| --- | --- |
| `memory_verifyVault` | ตรวจสุขภาพ vault ทั้งระบบและคำนวณ score |
| `memory_verifyNote` | ตรวจ note เดี่ยวด้าน structure, links, staleness |
| `memory_verifySourceTruth` | ตรวจ claim ที่อ้างอิง source ใน note |
| `memory_findBrokenLinks` | หา wikilink ที่เสีย |
| `memory_findDuplicates` | หา note ที่ซ้ำหรือ overlap |
| `memory_checkStaleness` | หา note ที่ claim หรือ verification เก่าเกินกำหนด |

### Maintenance Tools

| Tool | หน้าที่ |
| --- | --- |
| `memory_bootstrapProject` | สร้าง vault และ client integration pack |
| `memory_reindex` | rebuild index ทั้ง vault |
| `memory_indexNote` | index note เดี่ยว |
| `memory_diagnoseWorkspace` | ตรวจ project root, vault root, workspace candidates, runtime metadata และ MCP Doctor สำหรับ config client |
| `memory_export` | placeholder สำหรับ export curated memory bundle |
| `memory_import` | placeholder สำหรับ import note เข้าสู่ vault |

หมายเหตุ: `memory_export` และ `memory_import` ถูก register แล้ว แต่ปัจจุบันยังเป็น placeholder สำหรับ implementation รอบถัดไป

`memory_diagnoseWorkspace` คืนค่า `doctor` เพิ่มเติมสำหรับไล่ปัญหา MCP client integration:

- `doctor.checks`: ตรวจ project root, vault root, `memory/AGENTS.md`, build info และ vault อยู่ใน project หรือไม่
- `doctor.clients`: ตรวจ config ของ Claude Code, Codex, Cursor, Windsurf, Zed, OpenCode และ Antigravity ว่าพบ `project-memory` และ `MEMORY_PROJECT_ROOT` หรือไม่
- `doctor.issues`: issue code แบบอ่านโดย agent ได้ เช่น `VAULT_AGENT_RULES_MISSING`, `CLIENT_CONFIG_MISSING_PROJECT_MEMORY`, `CLAUDE_MCP_SERVER_DEFINITION_NOT_LOCAL`
- `doctor.issues[].remediation`: คำแนะนำแก้ไขแบบ machine-readable เช่น `summary`, `path`, `snippet` หรือ `command`

## Input สำคัญของ Workflow

`memory_sessionStart`:

```json
{
  "taskArea": "docs-readme",
  "mode": "docs",
  "recentLimit": 5,
  "maxItems": 12,
  "maxChars": 6000
}
```

`memory_contextPack`:

```json
{
  "query": "README setup workflow",
  "taskArea": "docs-readme",
  "mode": "docs",
  "maxItems": 10,
  "maxChars": 5000,
  "includeRecentSessions": false,
  "includeMistakes": false,
  "includeAdrs": true,
  "includeRunbooks": true
}
```

`memory_sessionEnd`:

```json
{
  "topic": "Update README",
  "agent": "codex",
  "outcomes": ["Updated README documentation"],
  "filesTouched": ["README.md"],
  "verification": "npm run typecheck && npm run build passed",
  "autoCompact": true,
  "verify": true
}
```

## Response Format

ทุก tool คืน envelope รูปแบบเดียวกัน:

```json
{
  "ok": true,
  "data": {},
  "warnings": [],
  "meta": {
    "tool": "memory_sessionStart",
    "elapsedMs": 12
  }
}
```

ถ้า error จะยังใช้ envelope เดียวกัน แต่ `ok` เป็น `false` และมี `error` object

## Verification และ Maintenance

คำสั่งที่ควรรันก่อนใช้งานจริงหลังแก้โค้ด:

```bash
npm run typecheck
npm run build
```

หลังทำงานกับ vault:

```text
memory_verifyVault
```

สำหรับตรวจ lifecycle:

```text
memory_lifecycleStatus
```

สำหรับ refresh insight digest:

```text
memory_compactVault
```

## Compatibility

- Transport ปัจจุบันคือ stdio เหมาะกับ local IDE และ local agent
- Client ที่ไม่รองรับ MCP ยังอ่าน Markdown vault ได้โดยตรง แต่เรียก MCP tools ไม่ได้จนกว่าจะมี bridge หรือ MCP support
- Obsidian เป็น optional UI ไม่ใช่ dependency ของ server
- Vault เป็น project-local เป็นค่าแนะนำ เพราะทำให้ code, decision และ session history อยู่ด้วยกันและ version ผ่าน git ได้

## Troubleshooting

### Vault ถูกสร้างผิดที่

ตั้ง `MEMORY_PROJECT_ROOT` ให้ชัดเจนใน MCP config ของ client

### Client ไม่เห็น tool ใหม่

รัน `npm run build` แล้ว restart หรือ reload MCP client/server เพื่อให้ client โหลด `dist/index.js` ใหม่

### `memory_get` แจ้งว่าต้องมี path, id หรือ title

ส่ง input อย่างน้อยหนึ่งค่า เช่น:

```json
{
  "path": "00_Index/Retrieval-Protocol.md"
}
```

### Quality gate เตือนว่า session flow ไม่ครบ

ตรวจด้วย `memory_lifecycleStatus` แล้วเริ่มงานรอบถัดไปด้วย flow มาตรฐาน:

```text
memory_sessionStart -> memory_contextPack -> memory_selfCheck เมื่อเสี่ยง -> memory_sessionEnd -> memory_verifyVault
```

## Roadmap ที่ยังเปิดไว้

- implement `memory_export` ให้ export Markdown/JSON/ZIP ได้จริง
- implement `memory_import` ให้ import bundle เข้าสู่ vault ได้จริง
- เพิ่ม diagnostics สำหรับ client setup และ MCP config
- เพิ่ม test coverage สำหรับ lifecycle, context modes และ follow-up radar
- เพิ่ม promotion workflow จาก follow-up หรือ repeated lesson ไปเป็น insight/ADR/runbook
