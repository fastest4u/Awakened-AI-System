import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadMemoryConfig } from "./config/memory.config.js";
import { MaintenanceController } from "./controllers/maintenance.controller.js";
import { NoteController } from "./controllers/note.controller.js";
import { VerifyController } from "./controllers/verify.controller.js";
import { WorkflowController } from "./controllers/workflow.controller.js";
import { WriteController } from "./controllers/write.controller.js";
import { IndexRepository } from "./repositories/index.repository.js";
import { NoteRepository } from "./repositories/note.repository.js";
import { AuditService } from "./services/audit.service.js";
import { MemoryCompactionService } from "./services/memory-compaction.service.js";
import { MemoryBootstrapService } from "./services/memory-bootstrap.service.js";
import { MemoryFollowUpService } from "./services/memory-follow-up.service.js";
import { MemoryLifecycleService } from "./services/memory-lifecycle.service.js";
import { MemoryQueryService } from "./services/memory-query.service.js";
import { MemoryTemplateService } from "./services/memory-template.service.js";
import { MemoryUsageService } from "./services/memory-usage.service.js";
import { MemoryWorkflowService } from "./services/memory-workflow.service.js";
import { NoteService } from "./services/note.service.js";
import { ToolResponseService } from "./services/tool-response.service.js";
import { VaultHealthService } from "./services/vault-health.service.js";
import { VaultService } from "./services/vault.service.js";

export async function bootstrap() {
  const server = new McpServer({ name: "awakened-ai-memory-mcp", version: "0.1.0" });
  const config = loadMemoryConfig();
  const vaultRoot = config.vaultRoot;
  const vault = new VaultService(vaultRoot);
  const responses = new ToolResponseService();
  const audit = new AuditService(vaultRoot);
  const notes = new NoteService(new NoteRepository(vault));
  const templates = new MemoryTemplateService();
  const bootstrapper = new MemoryBootstrapService(vaultRoot);
  const index = new IndexRepository();
  const query = new MemoryQueryService(vault, index);
  const health = new VaultHealthService(vault);
  const usage = new MemoryUsageService(vaultRoot);
  const compactor = new MemoryCompactionService(query, notes);
  const lifecycle = new MemoryLifecycleService(vaultRoot);
  const followUps = new MemoryFollowUpService(vault);
  const workflows = new MemoryWorkflowService(vault, query, health, notes, templates, audit, usage, compactor, lifecycle, followUps);

  new NoteController(query, responses).register(server);
  new WriteController(notes, responses, audit, templates).register(server);
  new VerifyController(health, responses).register(server);
  new MaintenanceController(query, index, responses, bootstrapper, compactor).register(server);
  new WorkflowController(workflows, responses).register(server);

  await server.connect(new StdioServerTransport());
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
