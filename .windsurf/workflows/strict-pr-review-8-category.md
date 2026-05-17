---
description: strict-pr-review-8-category
---

---
name: strict-pr-review-8-category
description: ดำเนิน workflow ตรวจโค้ดแบบเข้มงวดผ่าน Pull Request โดยอัตโนมัติ — ตรวจ uncommitted/unpushed commits, จัดการ branch strategy, push, สร้าง PR ผ่าน GitHub MCP, รีวิวโค้ด 8 หมวดพร้อมจัดระดับ P0-P3, แก้ไขอัตโนมัติ, สรุปผลภาษาไทย, และ merge เฉพาะเมื่อไม่มีประเด็นค้าง. ใช้สำหรับโปรเจกต์ Awakened-AI-System (MCP Server).
---

// turbo-all

# Strict PR Review 8 Category (Awakened-AI-System Edition)

สกิลนี้กำหนดกระบวนการตายตัว 7 ขั้น ห้ามข้ามลำดับ

## Non-Negotiable Rules

- ทำงานตามลำดับ Step 1 → 7 เท่านั้น
- สรุปผลภาษาไทยเสมอ
- ใช้ GitHub MCP สำหรับสร้าง PR และ merge
- ทุกประเด็นรีวิวต้องระบุหลักฐาน (ไฟล์/บรรทัด/ฟังก์ชัน/พฤติกรรม)
- 🚨 **CRITICAL RULE**: **ห้ามกด Merge เด็ดขาดหากยังมี P0/P1/P2/P3 หลงเหลืออยู่** ต้องทำการแก้โค้ดให้เสร็จสิ้นก่อนเสมอ
- เมื่อพบ P0-P3 ต้อง **หยุดกระบวนการ Merge ทันที แล้วทำการแก้ไขอัตโนมัติ (Auto-Fix)** โดยไม่ต้องถาม user — ยกเว้นมี business ambiguity ที่ไม่สามารถอนุมานจากโค้ดได้
- หลังแก้ไขแล้ว → ดำเนินการ commit, push, แล้ว **รีวิวรอบใหม่ทั้งหมด** จนกว่าจะเคลียร์ทุกประเด็นจนสะอาด (สูงสุด 3 รอบ) ถึงจะอนุญาตให้ Merge ได้
- ตรวจเฉพาะ code ใน diff — ห้ามยก issue ของ pre-existing code ที่ไม่ได้แก้
- สำหรับ Awakened-AI-System: แก้ไขเฉพาะในโฟลเดอร์ `src/` เป็นหลัก ห้ามแก้ไขไฟล์ใน `dist/` หรือ `memory/` โดยตรงหากไม่ได้รับอนุญาต และห้ามยุ่งกับตัวแปร Secret ใน `.env` เด็ดขาด

---

## Step 1) ตรวจ Uncommitted Changes

### Objective

ยืนยันว่า state ของ repo พร้อมเข้าสู่กระบวนการ PR

### Procedure

1. ตรวจสถานะ: `git status --porcelain`
2. ถ้ามี uncommitted changes:
   - `git add -A && git commit -m "<conventional-commit-message>"`
   - ใช้ prefix: `fix:`, `feat:`, `refactor:`, `cleanup:`, `test:`
3. ถ้าไม่มี uncommitted changes:
   - ตรวจว่ามี unpushed commits: `git log origin/<base>..HEAD --oneline`
   - ถ้าไม่มี → ตอบ `ไม่มีอะไรให้ review` และหยุด

---

## Step 2) ตรวจ Branch และ Normalize Base

### Procedure

1. อ่าน branch: `git branch --show-current`
2. กำหนด base (พยายามหา `main` ก่อน ถ้าไม่มีให้เป็น `master`)
3. ถ้าอยู่บน base:
   - ตรวจ unpushed: `git log origin/<base>..HEAD --oneline`
   - ถ้ามี → แตก branch ใหม่ในรูปแบบ `<prefix>/<kebab-case-summary>`
4. ถ้าอยู่บน branch อื่น: ใช้ branch ปัจจุบันต่อได้เลย

---

## Step 3) Push Branch

### Procedure

```bash
# ครั้งแรก
git push -u origin <branch-name>
# ครั้งถัดไป
git push
```

---

## Step 4) สร้าง PR ผ่าน GitHub MCP

- ดึง owner/repo จาก `git remote get-url origin`
- ใช้ `create_pull_request`
- **title**: ใช้ conventional commit อ้างอิงจากสิ่งที่เปลี่ยนแปลง
- **head**: branch ปัจจุบัน
- **base**: branch หลักที่ detect ได้

---

## Step 5) Code Review เข้มงวด 8 หมวด (MCP Server Specific)

### ขั้นตอนก่อนรีวิว (Mandatory)

1. ดึง diff: `pull_request_read` → `get_diff`
2. ดึง file list: `pull_request_read` → `get_files`
3. **อ่านไฟล์ที่เกี่ยวข้องทั้งฟังก์ชัน/class** ไม่ใช่แค่ diff เพื่อเข้าใจ context

### หลักการให้คะแนน Severity

| Level | คำอธิบาย | ตัวอย่าง |
|---|---|---|
| **P0** | วิกฤต — ต้องแก้ก่อน merge | ข้อมูลลับรั่วไหล, แก้ไฟล์ใน dist/ โดยตรง, ระบบล่ม |
| **P1** | ผลกระทบสูง — ควรแก้ก่อน merge | INSERT ลง DB แบบไม่อิกนอร์ค่าเดิม, ขาด Exponential Backoff |
| **P2** | ผลกระทบกลาง — แก้เร็วๆ นี้ | ไม่ใส่ .js suffix ใน import |
| **P3** | ผลกระทบต่ำ — nice to have | โค้ดสไตล์, ความเป็นระเบียบ |

### 1) Correctness & Logic

- Logic ทำงานได้ตรงตามระบบของ MCP Tools และทำตาม Zod Schema อย่างเคร่งครัด
- ใช้ Optional Chaining (`?.`) และ Nullish Coalescing (`??`) อย่างปลอดภัย ไม่บัง error ไปหมด

### 2) Security

- **P0**: ห้าม read, print, commit หรือ copy values จากไฟล์ `.env` ที่เก็บ Secret ไว้
- ห้ามหลุด credential ใดๆ ลงใน log/response

### 3) Reliability & Error Handling

- ไม่กลืน exception (`catch (e)` ต้องนำไป log หรือทำอย่างใดอย่างหนึ่ง)
- การ Fetch API (`api-client.ts` / ข้อมูลภายนอก) ควรมี Exponential Backoff (3 retries)

### 4) Performance

- ตรวจสอบระบบอ่านเขียนไฟล์ผ่าน Obsidian-first memory vault ไม่เกิดลูปหรือโหลดไฟล์ซ้ำซ้อนโดยไม่จำเป็น
- ไม่เก็บข้อมูล File System จำนวนมากลงใน memory หลีกเลี่ยงการดึงไฟล์ทั้งโฟลเดอร์หากไม่จำเป็น

### 5) Maintainability & Readability

- **P2**: TypeScript ในโปรเจกต์นี้ใช้ `moduleResolution: "NodeNext"` ดังนั้นการ import ไฟล์ local **ต้องมีนามสกุล `.js` ต่อท้าย** (เช่น `import { env } from './env.js'`)
- SRP — ไม่ให้ไฟล์ยาวเกินความจำเป็น 

### 6) Architecture & Design (MCP Server Rules)

- **P0**: มีการแก้ไขโครงสร้างการจัดเก็บไฟล์ Memory โดยไม่ใช้รูปแบบ Markdown/Obsidian ที่ถูกต้อง หรือตั้งชื่อไฟล์ผิดกฎ (ใช้จุดแทน underscore เป็นต้น)
- **P1**: เขียนทับไฟล์เก่าแบบทำลายข้อมูลเดิมโดยไม่จำเป็น (ควรใช้ append หรือสร้างไฟล์ใหม่)
- โครงสร้างของ MCP Server (`controllers/`, `services/`) ถูกจัดวางเป็นสัดส่วนชัดเจนตามหลัก OOP

### 7) Testing & Quality Gates

- ตรวจสอบ logic เชิงลึกด้วยตา เนื่องจากการขาด automated test ในระบบส่วนใหญ่
- ระมัดระวังการเปลี่ยนโครงสร้างข้อมูลใน SQL migrations ที่อาจกระทบโค้ด runtime

### 8) Compatibility & Deployment Risk

- เปลี่ยนแปลง Tool Schema ต้องแก้ Zod Schema ให้สอดคล้องกันเสมอ
- ตรวจสอบว่าไม่ไปแก้ทำลาย Tool เดิมที่กำลังใช้งานอยู่ (งานหลักอยู่ที่ `src/`)

---

## Step 6) Output Format (ภาษาไทย) + Auto-Fix

แสดงผลรายงานแบบนี้:
```markdown
🔍 Code Review: <branch-name>

PR: #<number> — <link>
สรุป: N ไฟล์ | N commits | +X/-Y lines

🔴 P0 Critical (ต้องแก้ก่อน merge)
- [ไฟล์:บรรทัด] ประเด็น | ผลกระทบ | วิธีแก้

🟠 P1 High (ควรแก้ก่อน merge)
- ...

🟡 P2 Medium (แก้เร็วๆ นี้)
- ...

🔵 P3 Low (nice to have)
- ...

🟢 Good Practices (ทำดีแล้ว)
- ...

✅ ผลสรุป: พร้อม merge / ต้องแก้ไข N รายการ
```

**Auto-Fix Loop:**

1. แก้ไขโค้ดที่พบปัญหา P0-P3 ทันที
2. รัน Build (`npm run build`)
3. Commit & Push
4. วนกลับ Step 5 (สูงสุด 3 รอบ)

---

## Step 7) Merge Gate

### ผ่าน (เคลียร์ประเด็น P0-P3 หมดจด 100%)

1. **บังคับรัน Local Build** เพื่อตรวจ Syntax/Type:
   - รัน `npm run build`
   - หาก **ไม่ผ่าน** (Error จาก tsc/esbuild) ให้ห้าม merge และวนกลับไป Step 5 เพื่อแก้โค้ด
2. Merge ผ่าน GitHub MCP (`merge_method: squash`)
3. Cleanup local branch

### ไม่ผ่าน (ยังมี P0-P3 ที่ยังไม่ได้แก้ หรือรัน build ไม่ผ่านหลัง 3 รอบ)

1. **ห้าม merge เด็ดขาด**
2. แจ้ง user เพื่อขอคำตัดสินใจ

