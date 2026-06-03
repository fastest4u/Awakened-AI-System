# ระบบ Frontmatter ของ Memory Vault

เอกสารนี้อธิบายระบบจัดการ frontmatter แบบ project-agnostic ที่เพิ่มเข้าไปใน MCP server (`awakened-ai-memory-mcp`) เพื่อแก้บั๊ก critical, ยกระดับการแจ้งเตือน (diagnostics), และเพิ่มความสามารถ validate / fix / migrate / report พร้อม CLI และ MCP tools

> มาตรฐานที่เลือกใช้: **Option C (hybrid)** — ดู ADR `memory/04_Architecture_Decisions/adopt-option-c-hybrid-frontmatter-standard-with-safe-never-throw-parser.md`

---

## 1. ภาพรวมปัญหาที่แก้

- **บั๊ก critical:** เดิม `gray-matter` ถูกเรียกแบบไม่มี try/catch ใน read path หลัก (`vault.service.load`, `vault.repository.readAllNotes`, `memory-query.snapshotIndex/get`) ทำให้ไฟล์ YAML เสียเพียงไฟล์เดียว → ทำให้ search / recent / get / contextPack / sessionStart ล่มทั้งระบบ
- **แจ้งเตือนกำกวม:** `vault-health` ยุบทุก YAML error เป็น `MISSING_FRONTMATTER` (วินิจฉัยผิด) และมี severity แค่ `error|warning`
- **ISO date coercion:** generator เดิมสร้าง date แบบไม่ครอบ quote → `gray-matter` แปลงเป็น `Date` object ทำให้ search/sort เพี้ยน

## 2. สถาปัตยกรรม (ไฟล์สำคัญ)

- `src/utils/frontmatter.ts` — `parseFrontmatter()` ตัว parse ที่ **ไม่ throw เด็ดขาด** + serializer (`serializeFrontmatter`, `buildNoteContent`, `yamlScalar`)
- `src/utils/frontmatter-schema.ts` — schema แบบ data-driven: alias map, date fields, key order, `canonicalizeFrontmatter()`, `validateFrontmatter()`, `normalizeDateValue()`
- `src/config/frontmatter.config.ts` — โหลด config แบบ optional (global + project) พร้อม fallback
- `src/config/vault-policy.ts` — policy กลางสำหรับ markdown ignore patterns และ semantic frontmatter exemptions
- `src/services/frontmatter.service.ts` — orchestration: `validate` / `fix` / `migrate` / `report`
- `src/controllers/frontmatter.controller.ts` — ลงทะเบียน MCP tools
- `src/cli.ts` — CLI `memory-vault`

ทุก read path ถูก route ผ่าน `parseFrontmatter()` แล้ว จึงแยกไฟล์เสียเป็นราย note ไม่ให้ล่มทั้งระบบ

ไฟล์ใต้ `99_Templates/**` ถูกยกเว้นจาก semantic validation/fix/migrate ผ่าน policy กลาง เพื่อไม่ให้ placeholder เช่น `<% tp.date.now(...) %>` กลายเป็น warning ปลอม แต่ยังคงรายงาน structural parse diagnostic ถ้า YAML เสียจริง โปรเจกต์สามารถเพิ่ม path อื่นผ่าน `semanticExemptPaths`

## 3. Severity taxonomy

| Severity | ความหมาย | ตัวอย่าง code |
|---|---|---|
| `info` | normalize เชิงแนะนำ ไม่บล็อก ไม่หักคะแนน | `DATE_NORMALIZED`, `FIELD_ALIASED`, `TAGS_COERCED`, `FRONTMATTER_BOM`, `FRONTMATTER_EMPTY` |
| `warning` | ควรแก้ แต่ไม่พังการอ่าน | `MISSING_FRONTMATTER`, `INVALID_DATE_FORMAT`, `INVALID_TAGS`, `FRONTMATTER_NOT_AT_START`, `FRONTMATTER_MULTIPLE_BLOCKS` |
| `error` | ผิด schema | `INVALID_TYPE`, `MISSING_REQUIRED_FIELD` |
| `critical` | parse ไม่ได้ (อ่านไม่ออก) | `FRONTMATTER_UNCLOSED`, `FRONTMATTER_DUPLICATE_KEY`, `FRONTMATTER_UNQUOTED_VALUE`, `FRONTMATTER_BAD_INDENTATION`, `FRONTMATTER_INVALID_YAML` |

ทุก diagnostic มี `code`, `message`, `line` (ถ้าทราบ), `field`, `suggestion`, และ `autoFixAvailable`

## 4. มาตรฐาน Option C (hybrid)

- **canonical key เป็น kebab-case** (เข้ากับ vault เดิม) แต่รับ alias แบบ snake_case/camelCase แล้ว normalize ตอนอ่าน/แก้ เช่น `created_at → created`, `last_verified → last-verified`
- **date** normalize เป็นสตริง `YYYY-MM-DD` เสมอ และ generator ครอบ quote ให้ (กัน Date coercion)
- เข้ากันได้ย้อนหลัง: ไฟล์ kebab-case เดิมทั้งหมดยังถูกต้อง ไม่ต้อง migrate

## 5. การใช้งาน CLI (`memory-vault`)

```bash
# ตรวจ (read-only) — default format = text
node dist/cli.js validate
node dist/cli.js validate --format markdown
node dist/cli.js report                 # = validate แต่ default markdown

# แก้แบบ dry-run ก่อนเสมอ (ค่า default คือ dry-run + safe-only)
node dist/cli.js fix
node dist/cli.js fix --safe                  # safe fixes เท่านั้น (เท่ากับ default)
# ลงมือแก้จริง (เขียนไฟล์ + เก็บ backup อัตโนมัติ)
node dist/cli.js fix --apply
node dist/cli.js fix --apply --no-backup     # ข้าม backup (ไม่แนะนำ)
# รวม unsafe fix (เดา type จาก path, ลบ field ไม่รู้จักเมื่อ strict) — ต้องมีทั้ง --unsafe และ --confirm
node dist/cli.js fix --unsafe --confirm --apply

# migrate frontmatter เก่าให้เป็น schema เวอร์ชันปัจจุบัน (dry-run เป็น default)
node dist/cli.js migrate
node dist/cli.js migrate --apply
# rollback: คืนค่าไฟล์จาก backup ล่าสุด (dry-run; ใส่ --apply เพื่อคืนจริง)
node dist/cli.js migrate --rollback
node dist/cli.js migrate --rollback --apply

# สร้างไฟล์ config ระดับโปรเจกต์ใต้ .memory-mcp/
node dist/cli.js init

# debug root/vault/runtime ของ process ที่กำลังรัน
node dist/cli.js diagnose

# จำกัดเฉพาะไฟล์
node dist/cli.js validate --path 07_Insights/some-note.md

# ระบุ vault เอง (ปกติ auto-detect)
node dist/cli.js validate --vault /path/to/memory
```

`fix` / `migrate` จะ **ไม่แก้ไฟล์ที่ parse ไม่ได้** (critical) — รายงานเป็น `manual` ให้แก้ด้วยมือ

## 6. MCP tools

- `memory_validateFrontmatter` — read-only คืน `summary` + `report` (text/json/markdown)
- `memory_fixFrontmatter` — `dryRun` default `true`; เขียนจริงเมื่อ `dryRun=false` พร้อม backup; รับ `unsafe`+`confirm` (ต้องมีทั้งคู่จึงจะทำ unsafe fix)
- `memory_migrateFrontmatter` — `dryRun` default `true`; stamp `schema-version` ให้ไฟล์ legacy; ส่ง `rollback=true` เพื่อคืนค่าจาก backup ล่าสุด
- `memory_diagnoseWorkspace` — read-only คืน project root, vault root, workspace candidates, env ที่เกี่ยวกับ memory และ runtime metadata

## 7. Config (optional, มี fallback)

ลำดับความสำคัญ (ตัวหลังชนะ): built-in defaults → global → project

- global: `~/.memory-vault/frontmatter.config.json`
- project: `<vaultRoot>/.memory-mcp/frontmatter.config.json`
- project schema (สร้างโดย `memory-vault init`): `<vaultRoot>/.memory-mcp/frontmatter.config.schema.json`

ตัวอย่าง:

```json
{
  "$schema": "./frontmatter.config.schema.json",
  "aliases": { "author": "source-author" },
  "requiredFieldsByType": { "note": ["title", "type", "created", "updated"] },
  "dateFields": [],
  "validTypes": [],
  "semanticExemptPaths": [],
  "strictUnknownFields": false
}
```

ถ้าไม่มีไฟล์ config หรือไฟล์เสีย → ใช้ default โดยไม่ error

## 8. ความปลอดภัย

- **ไม่ throw** ในทุก read path — ไฟล์เสียถูกแยกเป็นราย note
- **dry-run เป็นค่า default** สำหรับ fix/migrate/rollback ทั้งใน service, CLI และ MCP tools
- **backup อัตโนมัติ** ไปที่ `<vaultRoot>/.memory-mcp/backups/<timestamp>/<path>` ก่อนเขียนทุกครั้ง
- `.memory-mcp/**` ถูก ignore จากการ scan (กัน backup ถูกอ่านซ้ำ)
- config global/project ถูก normalize แบบ defensive: shape ที่ผิดจะถูก ignore พร้อม error รายงาน แต่ไม่ทำให้ schema พัง
- ไม่มีการลบไฟล์

## 9. การทดสอบ

```bash
npm run typecheck   # tsc --noEmit
npm test            # 111 tests (รวม regression ของ frontmatter, config และ safety defaults)
npm run build       # bundle MCP server (obfuscated) + CLI
```

## 10. Runtime refresh หลัง build

`npm run build` เขียน `dist/index.js` ใหม่ แต่ MCP client ที่เปิดอยู่จะยังใช้ process เดิมจนกว่าจะ restart/reload MCP server ของ client นั้น ๆ ดังนั้นให้แยกการ verify เป็น 2 ชั้น:

1. **CLI/new bundle verification**

   ```powershell
   node dist/cli.js validate --format json
   node dist/cli.js validate --format json --path 99_Templates/Template-Daily-Note.md
   ```

   ถ้า bundle ใหม่ถูกต้อง ควรเห็น `critical=0`, `error=0`, `warning=0` และ template path ควรเป็น `filesWithIssues=0`

2. **Active MCP process verification**

   ```powershell
   # ดู process ที่ยังรัน dist/index.js อยู่
   Get-CimInstance Win32_Process |
     Where-Object { $_.CommandLine -match 'Awakened-AI-System[/\\]dist[/\\]index\.js' } |
     Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine
   ```

   ถ้า `CreationDate` ของ process เก่ากว่าเวลา build ล่าสุด ให้ reload/restart MCP server จาก IDE หรือ restart IDE นั้น แล้วค่อยรัน:

   ```text
   memory_validateFrontmatter(paths=["99_Templates/Template-Daily-Note.md"], format="json")
   memory_verifyVault(includeWarnings=true)
   ```

   ผล runtime ที่คาดหวังคือ `memory_validateFrontmatter` ไม่มี warning สำหรับ template placeholder และ `memory_verifyVault` ยังเป็น `0 errors / 0 warnings`
