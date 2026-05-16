import type { z } from "zod";
import { bootstrapProjectInputSchema, compactVaultInputSchema, exportInputSchema, importInputSchema, indexNoteInputSchema, reindexInputSchema } from "../schemas/memory.js";
import type { IndexRepository } from "../repositories/index.repository.js";
import type { MemoryCompactionService } from "../services/memory-compaction.service.js";
import type { MemoryBootstrapService } from "../services/memory-bootstrap.service.js";
import type { MemoryQueryService } from "../services/memory-query.service.js";
import type { ToolResponseService } from "../services/tool-response.service.js";

export class MaintenanceController {
  constructor(
    private readonly query: MemoryQueryService,
    private readonly index: IndexRepository,
    private readonly responses: ToolResponseService,
    private readonly bootstrapper: MemoryBootstrapService,
    private readonly compactor: MemoryCompactionService,
  ) {}

  register(server: { registerTool: Function }) {
    server.registerTool("memory_bootstrapProject", { description: "Create an SPX-style memory vault in the target project.", inputSchema: bootstrapProjectInputSchema, annotations: { destructiveHint: true } }, this.bootstrapProject.bind(this));
    server.registerTool("memory_reindex", { description: "Rebuild the whole vault index.", inputSchema: reindexInputSchema, annotations: { destructiveHint: true } }, this.reindex.bind(this));
    server.registerTool("memory_indexNote", { description: "Index a single note.", inputSchema: indexNoteInputSchema, annotations: { destructiveHint: true } }, this.indexNote.bind(this));
    server.registerTool("memory_compactVault", { description: "Compact session logs into insights.", inputSchema: compactVaultInputSchema, annotations: { destructiveHint: true } }, this.compactVault.bind(this));
    server.registerTool("memory_export", { description: "Export a curated memory bundle.", inputSchema: exportInputSchema, annotations: { readOnlyHint: true, idempotentHint: true } }, this.export.bind(this));
    server.registerTool("memory_import", { description: "Import notes into the vault.", inputSchema: importInputSchema, annotations: { destructiveHint: true } }, this.import.bind(this));
  }

  async reindex(_: z.infer<typeof reindexInputSchema>) {
    const startedAt = Date.now();
    const records = await this.query.snapshotIndex();
    return this.responses.buildOk("memory_reindex", startedAt, { indexedCount: records.length, durationMs: Date.now() - startedAt });
  }

  async bootstrapProject(input: z.infer<typeof bootstrapProjectInputSchema>) {
    const startedAt = Date.now();
    const result = this.bootstrapper.bootstrap(input);
    return this.responses.buildOk("memory_bootstrapProject", startedAt, result);
  }

  async indexNote(input: z.infer<typeof indexNoteInputSchema>) {
    const startedAt = Date.now();
    const records = await this.query.snapshotIndex();
    const record = records.find((item) => item.path === input.path) ?? null;
    if (!record) {
      return this.responses.buildError("memory_indexNote", startedAt, "NOT_FOUND", "Note not found in vault", { path: input.path });
    }
    this.index.upsert(record);
    return this.responses.buildOk("memory_indexNote", startedAt, { indexed: true, path: input.path, updatedAt: record.updatedAt });
  }

  async compactVault(input: z.infer<typeof compactVaultInputSchema>) {
    const startedAt = Date.now();
    const result = await this.compactor.compact(input);
    return this.responses.buildOk("memory_compactVault", startedAt, result);
  }

  async export(input: z.infer<typeof exportInputSchema>) {
    return this.responses.buildOk("memory_export", Date.now(), { artifactPath: "", format: input.format });
  }

  async import(input: z.infer<typeof importInputSchema>) {
    return this.responses.buildOk("memory_import", Date.now(), { importedCount: 0, warnings: [], source: input.source, format: input.format, targetFolder: input.targetFolder });
  }
}
