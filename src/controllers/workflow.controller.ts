import type { z } from "zod";
import { awakenInputSchema, contextPackInputSchema, selfCheckInputSchema, sessionEndInputSchema, sessionStartInputSchema } from "../schemas/memory.js";
import type { MemoryWorkflowService } from "../services/memory-workflow.service.js";
import type { ToolResponseService } from "../services/tool-response.service.js";

export class WorkflowController {
  constructor(private readonly workflows: MemoryWorkflowService, private readonly responses: ToolResponseService) {}

  register(server: { registerTool: Function, registerPrompt?: Function }) {
    server.registerTool("memory_sessionStart", { description: "Load SPX-style startup context for the current project and update lightweight usage scoring.", inputSchema: sessionStartInputSchema, annotations: {} }, this.sessionStart.bind(this));
    server.registerTool("memory_contextPack", { description: "Build a token-budgeted SPX-style context pack for a task and learn which notes are selected.", inputSchema: contextPackInputSchema, annotations: {} }, this.contextPack.bind(this));
    server.registerTool("memory_awaken", { description: "Assess memory state, risks, and next actions from vault evidence.", inputSchema: awakenInputSchema, annotations: {} }, this.awaken.bind(this));
    server.registerTool("memory_selfCheck", { description: "Run an SPX-style confidence and mistake-awareness checklist before risky work.", inputSchema: selfCheckInputSchema, annotations: { readOnlyHint: true, idempotentHint: true } }, this.selfCheck.bind(this));
    server.registerTool("memory_sessionEnd", { description: "Close meaningful work by writing a session log.", inputSchema: sessionEndInputSchema, annotations: { destructiveHint: true } }, this.sessionEnd.bind(this));

    if (server.registerPrompt) {
      server.registerPrompt("session_start", {
        description: "Start a new memory session and load context",
      }, () => ({
        messages: [{ role: "user", content: { type: "text", text: "Please run the `memory_sessionStart` tool. After it finishes, please run `memory_contextPack` for the current task." } }]
      }));
      
      server.registerPrompt("session_end", {
        description: "End the current session and write a log",
      }, () => ({
        messages: [{ role: "user", content: { type: "text", text: "Please run the `memory_sessionEnd` tool. Include outcomes, files touched, decisions made, and verify the vault." } }]
      }));

      server.registerPrompt("self_check", {
        description: "Run a pre-flight safety checklist before risky work",
      }, () => ({
        messages: [{ role: "user", content: { type: "text", text: "Please run the `memory_selfCheck` tool to assess risks before making changes." } }]
      }));

      server.registerPrompt("awaken", {
        description: "Assess memory state, risks, and next actions",
      }, () => ({
        messages: [{ role: "user", content: { type: "text", text: "Please run the `memory_awaken` tool to evaluate our current state." } }]
      }));
    }
  }

  async sessionStart(input: z.infer<typeof sessionStartInputSchema>) {
    const startedAt = Date.now();
    const context = await this.workflows.sessionStart(input);
    return this.responses.buildOk("memory_sessionStart", startedAt, context);
  }

  async contextPack(input: z.infer<typeof contextPackInputSchema>) {
    const startedAt = Date.now();
    const result = await this.workflows.contextPack(input);
    return this.responses.buildOk("memory_contextPack", startedAt, result);
  }

  async awaken(input: z.infer<typeof awakenInputSchema>) {
    const startedAt = Date.now();
    const result = await this.workflows.awaken(input);
    return this.responses.buildOk("memory_awaken", startedAt, result);
  }

  async selfCheck(input: z.infer<typeof selfCheckInputSchema>) {
    const startedAt = Date.now();
    const result = await this.workflows.selfCheck(input);
    return this.responses.buildOk("memory_selfCheck", startedAt, result);
  }

  async sessionEnd(input: z.infer<typeof sessionEndInputSchema>) {
    const startedAt = Date.now();
    const result = await this.workflows.sessionEnd(input);
    return this.responses.buildOk("memory_sessionEnd", startedAt, result);
  }
}
