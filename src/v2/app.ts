import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { FreshStartError } from "../orchestrator/fresh-start/contracts.js";
import { createV2Foundation } from "./composition.js";
import { diagnosticCode, loadV2LaunchConfig } from "./config.js";

export async function runV2Server(): Promise<void> {
  const foundation = await createV2Foundation(loadV2LaunchConfig(process.env));
  const server = new Server({ name: "project-memory-v2-foundation", version: "1.0.0" }, { capabilities: { tools: {} } });
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "memory_v2Status",
    description: "Redacted fresh-start foundation status. Production content is unavailable.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (request.params.name !== "memory_v2Status") return await foundation.content.invoke(request.params.name, request.params.arguments);
      if (request.params.arguments && Object.keys(request.params.arguments).length) throw new FreshStartError("FRESH_START_INPUT_INVALID");
      return { content: [{ type: "text", text: JSON.stringify(await foundation.status()) }] };
    } catch (error) {
      const code = diagnosticCode(error);
      throw new McpError(ErrorCode.InvalidRequest, code, { code });
    }
  });
  server.onerror = () => { process.stderr.write("FRESH_START_PROTOCOL_ERROR\n"); };
  let primary: unknown;
  try {
    await server.connect(transport);
    await new Promise<void>(resolve => {
      const stop = () => { process.stdin.off("end", stop); process.off("SIGINT", stop); process.off("SIGTERM", stop); server.onclose = undefined; resolve(); };
      process.stdin.once("end", stop); process.once("SIGINT", stop); process.once("SIGTERM", stop); server.onclose = stop;
      if (process.stdin.readableEnded) stop();
    });
  } catch (error) { primary = error; }
  finally {
    // Both closures are attempted; a cleanup failure is never reported as success.
    const results = await Promise.allSettled([server.close(), foundation.close()]);
    if (results.some(result => result.status === "rejected")) primary ??= new FreshStartError("FRESH_START_STORAGE_FAILURE");
  }
  if (primary) throw primary;
}
