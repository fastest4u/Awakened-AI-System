import type { z } from "zod";
import { checkStalenessInputSchema, findBrokenLinksInputSchema, findDuplicatesInputSchema, verifyNoteInputSchema, verifySourceTruthInputSchema, verifyVaultInputSchema } from "../schemas/memory.js";
import type { ToolResponseService } from "../services/tool-response.service.js";
import type { VaultHealthService } from "../services/vault-health.service.js";

export class VerifyController {
  constructor(private readonly health: VaultHealthService, private readonly responses: ToolResponseService) {}

  register(server: { registerTool: Function }) {
    server.registerTool("memory_verifyVault", { description: "Run the SPX-style Memory Vault health gate.", inputSchema: verifyVaultInputSchema, annotations: { readOnlyHint: true, idempotentHint: true } }, this.verifyVault.bind(this));
    server.registerTool("memory_verifyNote", { description: "Verify note structure, links, and staleness.", inputSchema: verifyNoteInputSchema, annotations: { readOnlyHint: true, idempotentHint: true } }, this.verifyNote.bind(this));
    server.registerTool("memory_verifySourceTruth", { description: "Verify source-backed factual claims.", inputSchema: verifySourceTruthInputSchema, annotations: { readOnlyHint: true, idempotentHint: true } }, this.verifySourceTruth.bind(this));
    server.registerTool("memory_findBrokenLinks", { description: "Scan the vault for broken internal links.", inputSchema: findBrokenLinksInputSchema, annotations: { readOnlyHint: true, idempotentHint: true } }, this.findBrokenLinks.bind(this));
    server.registerTool("memory_findDuplicates", { description: "Find duplicate or overlapping notes.", inputSchema: findDuplicatesInputSchema, annotations: { readOnlyHint: true, idempotentHint: true } }, this.findDuplicates.bind(this));
    server.registerTool("memory_checkStaleness", { description: "Find notes with stale claims or verification.", inputSchema: checkStalenessInputSchema, annotations: { readOnlyHint: true, idempotentHint: true } }, this.checkStaleness.bind(this));
  }

  async verifyVault(input: z.infer<typeof verifyVaultInputSchema>) {
    const startedAt = Date.now();
    const result = await this.health.verifyVault(input);
    return this.responses.buildOk("memory_verifyVault", startedAt, result);
  }

  async verifyNote(input: z.infer<typeof verifyNoteInputSchema>) {
    const startedAt = Date.now();
    const result = await this.health.verifyNote(input.path);
    return this.responses.buildOk("memory_verifyNote", startedAt, result);
  }

  async verifySourceTruth(input: z.infer<typeof verifySourceTruthInputSchema>) {
    const startedAt = Date.now();
    const result = await this.health.verifySourceTruth(input.path, input.claimsOnly);
    return this.responses.buildOk("memory_verifySourceTruth", startedAt, result);
  }

  async findBrokenLinks(input: z.infer<typeof findBrokenLinksInputSchema>) {
    const startedAt = Date.now();
    const brokenLinks = await this.health.findBrokenLinks(input.folders, input.limit);
    return this.responses.buildOk("memory_findBrokenLinks", startedAt, { brokenLinks, scannedFolders: input.folders, limit: input.limit });
  }

  async findDuplicates(input: z.infer<typeof findDuplicatesInputSchema>) {
    const startedAt = Date.now();
    const duplicates = await this.health.findDuplicates();
    return this.responses.buildOk("memory_findDuplicates", startedAt, { duplicates, scope: input.scope, similarityThreshold: input.similarityThreshold });
  }

  async checkStaleness(input: z.infer<typeof checkStalenessInputSchema>) {
    const startedAt = Date.now();
    const staleNotes = await this.health.checkStaleness(input.folders, input.olderThanDays);
    return this.responses.buildOk("memory_checkStaleness", startedAt, { staleNotes, folders: input.folders, olderThanDays: input.olderThanDays });
  }
}
