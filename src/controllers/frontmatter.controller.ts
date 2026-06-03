import type { z } from "zod";
import {
  fixFrontmatterInputSchema,
  migrateFrontmatterInputSchema,
  validateFrontmatterInputSchema,
} from "../schemas/memory.js";
import type { FrontmatterService } from "../services/frontmatter.service.js";
import type { ToolResponseService } from "../services/tool-response.service.js";

export class FrontmatterController {
  constructor(
    private readonly frontmatter: FrontmatterService,
    private readonly responses: ToolResponseService,
  ) {}

  register(server: { registerTool: Function }) {
    server.registerTool(
      "memory_validateFrontmatter",
      {
        description: "Validate vault frontmatter and return diagnostics (info|warning|error|critical) with line numbers, suggestions, and auto-fix flags. Read-only.",
        inputSchema: validateFrontmatterInputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      this.validate.bind(this),
    );
    server.registerTool(
      "memory_fixFrontmatter",
      {
        description: "Safely auto-fix frontmatter (canonicalize aliases, normalize dates, fill safe missing fields). dryRun defaults to true; real writes are backed up under .memory-mcp/backups.",
        inputSchema: fixFrontmatterInputSchema,
        annotations: { idempotentHint: false },
      },
      this.fix.bind(this),
    );
    server.registerTool(
      "memory_migrateFrontmatter",
      {
        description: "Migrate legacy frontmatter to the current schema version. dryRun defaults to true; real writes are backed up under .memory-mcp/backups.",
        inputSchema: migrateFrontmatterInputSchema,
        annotations: { idempotentHint: false },
      },
      this.migrate.bind(this),
    );
  }

  async validate(input: z.infer<typeof validateFrontmatterInputSchema>) {
    const startedAt = Date.now();
    const summary = await this.frontmatter.validate(input.paths.length ? input.paths : undefined);
    const report = this.frontmatter.report(summary, input.format);
    return this.responses.buildOk("memory_validateFrontmatter", startedAt, { summary, report, format: input.format });
  }

  async fix(input: z.infer<typeof fixFrontmatterInputSchema>) {
    const startedAt = Date.now();
    const result = await this.frontmatter.fix({
      paths: input.paths.length ? input.paths : undefined,
      dryRun: input.dryRun,
      backup: input.backup,
      unsafe: input.unsafe,
      confirm: input.confirm,
    });
    return this.responses.buildOk("memory_fixFrontmatter", startedAt, result);
  }

  async migrate(input: z.infer<typeof migrateFrontmatterInputSchema>) {
    const startedAt = Date.now();
    if (input.rollback) {
      const result = await this.frontmatter.rollback({ dryRun: input.dryRun });
      return this.responses.buildOk("memory_migrateFrontmatter", startedAt, { rolledBack: true, ...result });
    }
    const result = await this.frontmatter.migrate({
      paths: input.paths.length ? input.paths : undefined,
      dryRun: input.dryRun,
      backup: input.backup,
    });
    return this.responses.buildOk("memory_migrateFrontmatter", startedAt, result);
  }
}
