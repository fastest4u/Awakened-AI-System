import type { z } from "zod";
import { createFromTemplateInputSchema, writeAdRInputSchema, writeInsightInputSchema, writeMistakeInputSchema, writeSessionLogInputSchema } from "../schemas/memory.js";
import type { AuditService } from "../services/audit.service.js";
import type { MemoryTemplateService } from "../services/memory-template.service.js";
import type { NoteService } from "../services/note.service.js";
import type { ToolResponseService } from "../services/tool-response.service.js";
import { slugify, todayIso, TYPE_FOLDERS } from "../utils/memory-format.js";

export class WriteController {
  constructor(
    private readonly notes: NoteService,
    private readonly responses: ToolResponseService,
    private readonly audit: AuditService,
    private readonly templates: MemoryTemplateService,
  ) {}

  register(server: { registerTool: Function, registerPrompt?: Function }) {
    server.registerTool("memory_writeSessionLog", { description: "Write a new SPX-style session log note.", inputSchema: writeSessionLogInputSchema, annotations: { destructiveHint: true } }, this.writeSessionLog.bind(this));
    server.registerTool("memory_writeInsight", { description: "Write a distilled insight note.", inputSchema: writeInsightInputSchema, annotations: { destructiveHint: true } }, this.writeInsight.bind(this));
    server.registerTool("memory_writeMistake", { description: "Write a mistake note.", inputSchema: writeMistakeInputSchema, annotations: { destructiveHint: true } }, this.writeMistake.bind(this));
    server.registerTool("memory_writeADR", { description: "Write an architecture decision record.", inputSchema: writeAdRInputSchema, annotations: { destructiveHint: true } }, this.writeADR.bind(this));
    server.registerTool("memory_createFromTemplate", { description: "Create a note from an SPX-style template.", inputSchema: createFromTemplateInputSchema, annotations: { destructiveHint: true } }, this.createFromTemplate.bind(this));

    if (server.registerPrompt) {
      server.registerPrompt("write_adr", {
        description: "Write an Architecture Decision Record (ADR)",
      }, () => ({
        messages: [{ role: "user", content: { type: "text", text: "Please use the `memory_writeADR` tool to document a recent architectural decision we made." } }]
      }));
    }
  }

  async writeSessionLog(input: z.infer<typeof writeSessionLogInputSchema>) {
    const startedAt = Date.now();
    const date = input.date ?? todayIso();
    const path = this.notes.create(this.templates.sessionLogPath(input), this.templates.sessionLog(input));
    this.audit.record("memory_writeSessionLog", { path, title: `${date} - ${input.topic}` });
    return this.responses.buildOk("memory_writeSessionLog", startedAt, { created: true, path, title: `${date} - ${input.topic}` });
  }

  async writeInsight(input: z.infer<typeof writeInsightInputSchema>) {
    const startedAt = Date.now();
    const path = this.notes.create(`${TYPE_FOLDERS.insight}/${slugify(input.title)}.md`, this.templates.insight(input.title, input.content, input.confidence, input.derivedFrom, input.tags));
    this.audit.record("memory_writeInsight", { path, title: input.title });
    return this.responses.buildOk("memory_writeInsight", startedAt, { created: true, path });
  }

  async writeMistake(input: z.infer<typeof writeMistakeInputSchema>) {
    const startedAt = Date.now();
    const path = this.notes.create(`${TYPE_FOLDERS.mistake}/${slugify(input.title)}.md`, this.templates.mistake(input));
    this.audit.record("memory_writeMistake", { path, title: input.title, area: input.area });
    return this.responses.buildOk("memory_writeMistake", startedAt, { created: true, path });
  }

  async writeADR(input: z.infer<typeof writeAdRInputSchema>) {
    const startedAt = Date.now();
    const path = this.notes.create(`${TYPE_FOLDERS.adr}/${slugify(input.title)}.md`, this.templates.adr(input));
    this.audit.record("memory_writeADR", { path, title: input.title, status: input.status });
    return this.responses.buildOk("memory_writeADR", startedAt, { created: true, path });
  }

  async createFromTemplate(input: z.infer<typeof createFromTemplateInputSchema>) {
    const startedAt = Date.now();
    const path = this.notes.create(input.path, this.templates.fromTemplate(input.template, input.values));
    this.audit.record("memory_createFromTemplate", { path, template: input.template });
    return this.responses.buildOk("memory_createFromTemplate", startedAt, { created: true, path, template: input.template, values: input.values });
  }
}
