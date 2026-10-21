import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { FreshStartError } from "../orchestrator/fresh-start/contracts.js";
import { createV2Foundation } from "./composition.js";
import { diagnosticCode, loadV2LaunchConfig } from "./config.js";
import { STATUS_TOOL_DEFINITION } from "./public-tools.js";

export async function runV2Server(): Promise<void> {
  const foundation = await createV2Foundation(loadV2LaunchConfig(process.env));
  const server = new Server({ name: "project-memory-v2-foundation", version: "1.0.0" }, { capabilities: { tools: {} } });
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: foundation.content.listTools
      ? [...(await foundation.content.listTools())]
      : [STATUS_TOOL_DEFINITION],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (request.params.name === "memory_v2Status") {
        if (request.params.arguments && Object.keys(request.params.arguments).length) {
          throw new FreshStartError("FRESH_START_INPUT_INVALID");
        }
        return { content: [{ type: "text", text: JSON.stringify(await foundation.status()) }] };
      }
      const payload = await foundation.content.invoke(request.params.name, request.params.arguments);
      if (
        typeof payload === "object"
        && payload !== null
        && Array.isArray((payload as { content?: unknown }).content)
      ) {
        return payload as { content: Array<{ type: "text"; text: string }> };
      }
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    } catch (error) {
      const code = diagnosticCode(error);
      const extra = error as { toolName?: string; supersededBy?: string } | null;
      throw new McpError(ErrorCode.InvalidRequest, code, {
        code,
        ...(typeof extra?.toolName === "string" ? { toolName: extra.toolName } : {}),
        ...(typeof extra?.supersededBy === "string" ? { supersededBy: extra.supersededBy } : {}),
      });
    }
  });
  server.onerror = () => { process.stderr.write("FRESH_START_PROTOCOL_ERROR\n"); };
  let primary: unknown;
  try {
    await server.connect(transport);
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.stdin.off("end", stop);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        server.onclose = undefined;
        resolve();
      };
      process.stdin.once("end", stop);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      server.onclose = stop;
      if (process.stdin.readableEnded) stop();
    });
  } catch (error) {
    primary = error;
  } finally {
    // Both closures are attempted; a cleanup failure is never reported as success.
    const results = await Promise.allSettled([server.close(), foundation.close()]);
    if (results.some((result) => result.status === "rejected")) {
      primary ??= new FreshStartError("FRESH_START_STORAGE_FAILURE");
    }
  }
  if (primary) throw primary;
}
