# Prompt สำหรับ Claude Code: พัฒนาระบบ Memory Vault และจัดการ Frontmatter Warning

เอกสารนี้เป็น Prompt ภาษาไทยสำหรับใช้กับ **Claude Code** เพื่อให้ศึกษาระบบอย่างละเอียด วิเคราะห์ปัญหา และพัฒนาระบบจัดการ **Memory Vault** ให้ดีขึ้น พร้อมแก้/ออกแบบระบบจัดการ **frontmatter warning** ให้ใช้ได้กับทุกโปรเจกต์

---

## Prompt หลักสำหรับ Claude Code

```text
คุณคือ Senior Software Architect และ Senior Developer ที่มีหน้าที่วิเคราะห์ ปรับปรุง และพัฒนาระบบ Memory Vault ให้มีความเสถียร ใช้ซ้ำได้กับทุกโปรเจกต์ และจัดการปัญหา frontmatter warning ได้อย่างเป็นระบบ

เป้าหมายหลัก:
1. ศึกษาโครงสร้างระบบ Memory Vault ปัจจุบันอย่างละเอียด
2. วิเคราะห์ปัญหา frontmatter warning ที่เกิดขึ้น
3. ออกแบบแนวทางจัดการ frontmatter ให้เป็นมาตรฐาน
4. พัฒนาระบบให้ใช้ได้กับทุกโปรเจกต์ ไม่ผูกติดกับโปรเจกต์ใดโปรเจกต์หนึ่ง
5. ทำให้ระบบปลอดภัย เสถียร ขยายต่อได้ และดูแลรักษาง่าย

กรุณาทำงานตามขั้นตอนต่อไปนี้อย่างละเอียด
```

---

## 1. ศึกษาโครงสร้างระบบทั้งหมด

```text
ให้คุณสำรวจไฟล์และโฟลเดอร์ทั้งหมดที่เกี่ยวข้องกับ Memory Vault เช่น

- โฟลเดอร์ memory
- vault
- markdown files
- config files
- scripts
- CLI commands
- automation scripts
- hooks
- templates
- frontmatter parser
- markdown loader
- project settings
- global settings
- user settings

กรุณาตรวจสอบว่าแต่ละส่วนทำหน้าที่อะไร และมีความสัมพันธ์กันอย่างไร

หลังจากสำรวจแล้ว ให้สรุปออกมาเป็น:

- โครงสร้างระบบปัจจุบัน
- flow การทำงานของ Memory Vault
- จุดที่ระบบอ่าน memory
- จุดที่ระบบเขียน memory
- จุดที่ระบบ validate frontmatter
- จุดที่เกิด warning
- จุดที่เสี่ยงต่อ bug
- จุดที่ควร refactor
```

---

## 2. วิเคราะห์ปัญหา Frontmatter Warning

```text
ให้ตรวจสอบปัญหา frontmatter warning อย่างละเอียด โดยดูจากทุกไฟล์ markdown ที่เกี่ยวข้อง

ให้วิเคราะห์กรณีเหล่านี้:

- ไม่มี frontmatter
- frontmatter เปิดด้วย `---` แต่ไม่ปิด
- key ซ้ำ
- key ผิดรูปแบบ
- value ผิด type
- YAML syntax ผิด
- วันที่ผิด format
- array ผิดรูปแบบ
- string มีอักขระพิเศษ
- มี colon `:` แต่ไม่ได้ quote
- indentation ผิด
- มี frontmatter ว่างเปล่า
- มี BOM หรือ invisible character
- มี line ending ไม่ตรงกัน เช่น CRLF / LF
- มี markdown content ที่ทำให้ parser เข้าใจผิด
- มี frontmatter อยู่กลางไฟล์
- มีหลาย frontmatter block ในไฟล์เดียว

ให้แยกประเภท warning ออกเป็นระดับ:

- info
- warning
- error
- critical

และอธิบายว่าแต่ละระดับควรจัดการอย่างไร
```

---

## 3. ออกแบบมาตรฐาน Frontmatter กลาง

```text
ให้สร้างมาตรฐาน frontmatter ที่ใช้ได้กับทุกโปรเจกต์

ตัวอย่าง schema ที่ควรพิจารณา:

---
id: string
title: string
type: note | task | decision | context | project | reference | log
project: string
tags:
  - string
created_at: YYYY-MM-DD
updated_at: YYYY-MM-DD
status: active | archived | draft
source: manual | auto | import
priority: low | medium | high
---

แต่ถ้าระบบปัจจุบันมี schema เดิมอยู่แล้ว ให้ตรวจสอบก่อนว่าเหมาะสมหรือไม่

กรุณาเสนอ schema ที่ดีที่สุด โดยคำนึงถึง:

- ใช้ได้หลายโปรเจกต์
- รองรับ memory หลายประเภท
- ใช้ค้นหาได้ง่าย
- รองรับ automation
- รองรับ AI agent
- รองรับ versioning
- ลด warning
- อ่านง่ายสำหรับมนุษย์
- parse ง่ายสำหรับโปรแกรม
```

---

## 4. พัฒนาระบบจัดการ Frontmatter Warning

```text
ให้สร้างหรือปรับปรุงระบบ validator สำหรับ frontmatter โดยมีความสามารถดังนี้:

1. ตรวจสอบว่าไฟล์ markdown มี frontmatter หรือไม่
2. ตรวจสอบว่า frontmatter เปิดและปิดถูกต้อง
3. parse YAML อย่างปลอดภัย
4. validate schema
5. แจ้ง warning ที่เข้าใจง่าย
6. บอกตำแหน่งไฟล์และบรรทัดที่มีปัญหา
7. เสนอวิธีแก้
8. สามารถ auto-fix ได้ในกรณีที่ปลอดภัย
9. ไม่ทำลาย content เดิม
10. มี backup ก่อนแก้ไขไฟล์
11. รองรับหลายโปรเจกต์
12. รองรับ config แยกแต่ละโปรเจกต์
13. รองรับ global config
14. ทำงานผ่าน CLI ได้
15. สามารถใช้ใน CI/CD ได้

ตัวอย่าง command ที่ควรออกแบบ:

memory-vault validate
memory-vault validate --project ./my-project
memory-vault fix
memory-vault fix --safe
memory-vault report
memory-vault init
memory-vault migrate
```

---

## 5. ออกแบบระบบ Memory Vault ให้ใช้ได้ทุกโปรเจกต์

```text
ให้ปรับระบบ Memory Vault ให้ไม่ผูกติด path แบบตายตัว

ระบบควรรองรับ:

- global memory vault
- project memory vault
- workspace memory vault
- user config
- project config
- template config
- schema config

ตัวอย่างแนวคิด path:

~/.memory-vault/
  config.yaml
  schemas/
  templates/
  global-memory/

project-root/
  .memory-vault/
    config.yaml
    memory/
    templates/
    schema.yaml

ให้ตรวจสอบว่าระบบปัจจุบันควรใช้ path แบบใด และควร fallback อย่างไร

ลำดับ priority ที่แนะนำ:

1. project config
2. workspace config
3. user config
4. default config
```

---

## 6. เพิ่มระบบ Auto-fix ที่ปลอดภัย

```text
ให้พัฒนาระบบ auto-fix สำหรับ frontmatter โดยแยกระหว่าง safe fix และ unsafe fix

Safe fix เช่น:

- เพิ่ม frontmatter ที่หายไป
- เพิ่ม field ที่จำเป็นแต่ยังไม่มี
- เติม created_at / updated_at
- normalize date format
- แปลง tags string เป็น array
- ลบ space เกิน
- แก้ line ending
- sort keys ตาม schema

Unsafe fix เช่น:

- เดา type ของ memory
- เปลี่ยน title
- เปลี่ยน project
- merge duplicate keys
- ลบ field ที่ไม่รู้จัก
- แก้ YAML ที่ ambiguous

ระบบควร auto-fix เฉพาะ safe fix โดย default และต้องขอ confirmation หรือ flag พิเศษสำหรับ unsafe fix

ตัวอย่าง:

memory-vault fix --safe
memory-vault fix --unsafe --confirm
```

---

## 7. เพิ่มระบบ Migration

```text
ถ้าพบว่าไฟล์เก่าใช้ frontmatter คนละรูปแบบ ให้สร้าง migration system

ความสามารถที่ต้องการ:

- detect schema version
- migrate จาก version เก่าไป version ใหม่
- backup ก่อน migrate
- dry-run mode
- migration report
- rollback ได้ถ้าเป็นไปได้

ตัวอย่าง command:

memory-vault migrate --dry-run
memory-vault migrate --apply
memory-vault migrate --rollback
```

---

## 8. เพิ่มระบบ Report

```text
ให้สร้าง report ที่อ่านง่ายหลังตรวจสอบ Memory Vault

Report ควรมีข้อมูล:

- จำนวนไฟล์ทั้งหมด
- จำนวนไฟล์ที่ valid
- จำนวนไฟล์ที่มี warning
- จำนวนไฟล์ที่มี error
- รายชื่อไฟล์ที่มีปัญหา
- ประเภทปัญหา
- วิธีแก้ที่แนะนำ
- ปัญหาที่ auto-fix ได้
- ปัญหาที่ต้องแก้เอง
- schema version
- project name
- timestamp

รองรับ output แบบ:

memory-vault report --format text
memory-vault report --format json
memory-vault report --format markdown
```

---

## 9. เพิ่ม Test ให้ครบ

```text
ให้สร้าง test สำหรับระบบ frontmatter และ Memory Vault

ต้องครอบคลุม:

- markdown ไม่มี frontmatter
- frontmatter ถูกต้อง
- frontmatter ไม่ปิด
- YAML syntax ผิด
- missing required fields
- invalid field type
- invalid date
- tags เป็น string
- tags เป็น array
- duplicate keys
- unknown fields
- migration
- auto-fix
- backup
- report
- multiple projects
- global config fallback
- project config override

ถ้าโปรเจกต์ใช้ test framework อยู่แล้ว ให้ใช้ framework เดิม
ถ้ายังไม่มี ให้เสนอ framework ที่เหมาะสมและเพิ่ม test แบบ minimal แต่ขยายต่อได้
```

---

## 10. ปรับปรุง DX และ Error Message

```text
ให้ปรับข้อความ warning/error ให้เข้าใจง่าย เช่น:

ไม่ดี:
YAML parse error

ดี:
Frontmatter YAML ไม่ถูกต้องในไฟล์ memory/project-a/context.md บรรทัดที่ 4
สาเหตุ: พบเครื่องหมาย ':' ใน value ที่ไม่ได้ใส่ quote
แนะนำให้แก้เป็น:
title: "API: Authentication Flow"

ทุก warning ควรมี:

- code
- severity
- file path
- line number ถ้ารู้
- message
- suggestion
- auto_fix_available: true/false

ตัวอย่าง:

{
  "code": "FRONTMATTER_INVALID_YAML",
  "severity": "error",
  "file": "memory/project-a/context.md",
  "line": 4,
  "message": "Frontmatter YAML ไม่ถูกต้อง",
  "suggestion": "ตรวจสอบ colon หรือ indentation ใน YAML",
  "auto_fix_available": false
}
```

---

## 11. ห้ามทำสิ่งต่อไปนี้

```text
- ห้ามลบไฟล์ memory เดิมโดยไม่มี backup
- ห้ามแก้ content หลักของ markdown โดยไม่จำเป็น
- ห้าม hardcode path เฉพาะเครื่อง
- ห้ามผูกระบบกับโปรเจกต์เดียว
- ห้าม ignore warning โดยไม่มีเหตุผล
- ห้ามแก้ YAML แบบเดาสุ่ม
- ห้ามทำ breaking change โดยไม่อธิบาย
- ห้ามเปลี่ยน schema เดิมทันทีโดยไม่มี migration
```

---

## 12. ผลลัพธ์ที่ต้องส่งมอบ

```text
หลังทำงานเสร็จ ให้สรุปผลเป็นภาษาไทย โดยมีหัวข้อ:

1. ตรวจพบโครงสร้างระบบอะไรบ้าง
2. ปัญหาหลักของ Memory Vault คืออะไร
3. ปัญหา frontmatter warning เกิดจากอะไร
4. แก้ไขไฟล์ใดไปบ้าง
5. เพิ่มไฟล์ใดใหม่บ้าง
6. คำสั่งใหม่ที่ใช้งานได้
7. วิธีใช้งานระบบใหม่
8. วิธี validate
9. วิธี auto-fix
10. วิธี migrate
11. test ที่เพิ่ม
12. ข้อควรระวัง
13. สิ่งที่ควรพัฒนาต่อ
```

---

## 13. รูปแบบการทำงาน

```text
ก่อนแก้ไขโค้ด ให้ทำสิ่งนี้ก่อน:

1. สำรวจระบบ
2. สรุปสิ่งที่พบ
3. เสนอแผนแก้ไข
4. ระบุไฟล์ที่จะเปลี่ยน
5. ระบุความเสี่ยง
6. จากนั้นค่อยเริ่มแก้โค้ด

ระหว่างแก้ไข ให้ commit การเปลี่ยนแปลงแบบเป็นขั้นตอนในเชิงตรรกะ เช่น:

- add frontmatter schema
- add validator
- add safe fixer
- add migration support
- add CLI commands
- add tests
- improve error messages
- update documentation

ถ้าไม่มี git ไม่ต้อง commit แต่ให้แยกการทำงานเป็นขั้นตอนชัดเจน
```

---

## 14. ขอให้คิดแบบระบบระยะยาว

```text
การออกแบบต้องรองรับอนาคต เช่น:

- เพิ่ม memory type ใหม่ได้
- เพิ่ม schema version ได้
- ใช้กับหลายภาษาได้
- ใช้กับหลายโปรเจกต์ได้
- ใช้กับ AI agent อื่นได้
- export/import ได้
- sync ได้
- validate ก่อนใช้งานได้
- ทำงานใน local-first ได้
- ไม่ lock-in กับ tool ใด tool หนึ่ง
```

---

## 15. คำสั่งเริ่มทำงาน

```text
กรุณาเริ่มจากการสำรวจ repository ปัจจุบันก่อน
อย่าเพิ่งแก้โค้ดทันทีจนกว่าจะเข้าใจ flow ของระบบ
เมื่อสำรวจเสร็จ ให้รายงานสิ่งที่พบ แล้วค่อยเสนอแผนแก้ไขอย่างเป็นขั้นตอน
```

---

# เวอร์ชันสั้น สำหรับสั่งต่อหลังจาก Claude Code สำรวจระบบแล้ว

```text
จากสิ่งที่คุณสำรวจพบ กรุณาพัฒนาระบบ Memory Vault ให้มี frontmatter validator, safe auto-fix, schema กลาง, config ที่ใช้ได้ทุกโปรเจกต์, migration system, report system และ test ครอบคลุม โดยห้ามลบหรือแก้ memory เดิมโดยไม่มี backup และต้องอธิบายไฟล์ที่เปลี่ยนทั้งหมดเป็นภาษาไทย
```

---

# เวอร์ชันสำหรับให้ Claude Code ลงมือแก้ทันที

```text
ให้คุณลงมือ implement ระบบ Memory Vault เวอร์ชันปรับปรุงทันที โดยต้องมี:

1. frontmatter schema กลาง
2. frontmatter validator
3. safe auto-fix
4. backup ก่อนแก้ไฟล์
5. global/project config
6. CLI commands สำหรับ validate, fix, report, migrate, init
7. migration system
8. markdown report และ json report
9. test ครอบคลุม edge cases
10. documentation ภาษาไทย

ก่อนแก้ไขให้สำรวจระบบเดิมก่อน แล้วค่อยแก้แบบ incremental ห้ามลบข้อมูลเดิม และต้องสรุปผลหลังทำเสร็จ
```

---

# Checklist สำหรับตรวจงานหลัง Claude Code ทำเสร็จ

ใช้ checklist นี้ตรวจว่า Claude Code ทำครบหรือไม่

## ระบบหลัก

- [ ] สำรวจ repository ก่อนแก้ไข
- [ ] สรุป flow การอ่าน/เขียน Memory Vault
- [ ] ไม่ hardcode path เฉพาะเครื่อง
- [ ] รองรับ global config
- [ ] รองรับ project config
- [ ] มี fallback config ชัดเจน
- [ ] ใช้ได้หลายโปรเจกต์

## Frontmatter

- [ ] มี schema กลาง
- [ ] มี schema version
- [ ] ตรวจ missing frontmatter ได้
- [ ] ตรวจ YAML syntax ได้
- [ ] ตรวจ required fields ได้
- [ ] ตรวจ invalid type ได้
- [ ] ตรวจ duplicate key ได้
- [ ] ตรวจ date format ได้
- [ ] ตรวจ tags format ได้
- [ ] แจ้งตำแหน่งไฟล์และบรรทัดได้

## Warning และ Error

- [ ] มี severity: info, warning, error, critical
- [ ] มี error code
- [ ] มี message ภาษาเข้าใจง่าย
- [ ] มี suggestion
- [ ] ระบุว่า auto-fix ได้หรือไม่ได้

## Auto-fix

- [ ] มี safe fix
- [ ] มี backup ก่อนแก้ไฟล์
- [ ] ไม่แก้ markdown content หลักโดยไม่จำเป็น
- [ ] ไม่เดาข้อมูลสำคัญแบบมั่ว
- [ ] unsafe fix ต้องใช้ flag พิเศษหรือ confirmation

## Migration

- [ ] detect schema version ได้
- [ ] migrate schema เก่าได้
- [ ] มี dry-run
- [ ] มี apply mode
- [ ] มี report
- [ ] มี backup หรือ rollback strategy

## CLI

- [ ] `memory-vault init`
- [ ] `memory-vault validate`
- [ ] `memory-vault fix`
- [ ] `memory-vault fix --safe`
- [ ] `memory-vault report`
- [ ] `memory-vault migrate`

## Report

- [ ] รองรับ text report
- [ ] รองรับ JSON report
- [ ] รองรับ Markdown report
- [ ] บอกจำนวนไฟล์ valid/warning/error
- [ ] บอกรายละเอียดปัญหาแต่ละไฟล์
- [ ] บอกวิธีแก้

## Test

- [ ] test markdown ไม่มี frontmatter
- [ ] test frontmatter ถูกต้อง
- [ ] test frontmatter ไม่ปิด
- [ ] test YAML syntax ผิด
- [ ] test missing required fields
- [ ] test invalid field type
- [ ] test invalid date
- [ ] test tags string/array
- [ ] test duplicate keys
- [ ] test unknown fields
- [ ] test auto-fix
- [ ] test backup
- [ ] test migration
- [ ] test config fallback
- [ ] test project override

---

# หมายเหตุการใช้งาน

แนะนำให้เริ่มใช้ Prompt หลักก่อน เพื่อให้ Claude Code สำรวจระบบและรายงานผล จากนั้นค่อยใช้เวอร์ชันสั้นหรือเวอร์ชันลงมือแก้ทันทีตามสถานการณ์

ถ้า repository มีระบบ memory อยู่แล้ว อย่าให้ Claude Code ลบหรือ migrate ทันทีโดยไม่มี backup และควรให้รันแบบ dry-run ก่อนเสมอ
