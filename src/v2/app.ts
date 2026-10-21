import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { FreshStartError } from "../orchestrator/fresh-start/contracts.js";
import { createV2Foundation } from "./composition.js";
import { diagnosticCode, loadV2LaunchConfig } from "./config.js";
import { STATUS_TOOL_DEFINITION } from "./public-tools.js";

export async function runV2Server(): Promise<void> {
  const foundation = await createV2Foundation(loadV2LaunchConfig(process.env));
  const server = new Server(
    { name: "project-memory-v2-foundation", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: foundation.content.listTools
      ? [...(await foundation.content.listTools())]
      : [STATUS_TOOL_DEFINITION],
  }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "memory://current/status",
        name: "Project Memory V2 Status",
        description: "Live Fresh-Start V2 store status and readiness posture.",
        mimeType: "application/json",
      },
      {
        uri: "memory://current/awaken",
        name: "Autonomous Awakening Briefing",
        description: "Synthesized continuity, live workspace state, governance alerts, and autonomous agenda.",
        mimeType: "application/json",
      },
      {
        uri: "memory://current/rules",
        name: "Active Binding ADRs & Mistakes",
        description: "Summary of active architectural decisions and past mistakes to avoid.",
        mimeType: "text/markdown",
      },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      const uri = request.params.uri;
      if (uri === "memory://current/status") {
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(await foundation.status(), null, 2),
            },
          ],
        };
      }
      if (uri === "memory://current/awaken") {
        const awaken = await foundation.content.invoke("memory_awaken", {});
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(awaken, null, 2),
            },
          ],
        };
      }
      if (uri === "memory://current/rules") {
        const selfCheck = (await foundation.content.invoke("memory_selfCheck", {})) as {
          bindingADRs?: Array<{ title?: string; summary?: string }>;
          pastMistakesToAvoid?: Array<{ title?: string; summary?: string }>;
        };
        const lines = [
          "# Active Project Memory V2 Guardrails",
          "",
          "## Binding ADRs",
          ...(selfCheck.bindingADRs ?? []).map((a) => `- **${a.title ?? "ADR"}**: ${a.summary ?? ""}`),
          "",
          "## Past Mistakes to Avoid",
          ...(selfCheck.pastMistakesToAvoid ?? []).map(
            (m) => `- **${m.title ?? "Mistake"}**: ${m.summary ?? ""}`,
          ),
        ];
        return {
          contents: [
            {
              uri,
              mimeType: "text/markdown",
              text: lines.join("\n"),
            },
          ],
        };
      }
      throw new FreshStartError("FRESH_START_INPUT_INVALID");
    } catch (error) {
      const code = diagnosticCode(error);
      throw new McpError(ErrorCode.InvalidRequest, code, { code });
    }
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "awaken-session",
        description: "Start a V2 memory session with atomic awakening, context pack, and pre-flight check.",
        arguments: [
          {
            name: "taskSummary",
            description: "Summary of the task to perform.",
            required: false,
          },
        ],
      },
      {
        name: "pre-flight-check",
        description: "Run an active pre-flight check against past mistakes and binding ADRs for planned files.",
        arguments: [
          {
            name: "plannedFiles",
            description: "Comma-separated list of file paths to inspect or modify.",
            required: false,
          },
        ],
      },
    ],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    if (name === "awaken-session") {
      const taskSummary = args.taskSummary ?? "Continue active project development";
      return {
        description: "Start and awaken Project Memory V2 session",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Call memory_sessionStart with taskSummary="${taskSummary}" and follow the returned awaken.autonomousAgenda and selfCheck.preFlightChecklist.`,
            },
          },
        ],
      };
    }
    if (name === "pre-flight-check") {
      const plannedFiles = args.plannedFiles ?? "";
      return {
        description: "Pre-flight guardrail check",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Call memory_selfCheck with plannedFiles=${JSON.stringify(
                plannedFiles
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              )} before modifying any code.`,
            },
          },
        ],
      };
    }
    throw new McpError(ErrorCode.InvalidRequest, "FRESH_START_INPUT_INVALID", {
      code: "FRESH_START_INPUT_INVALID",
    });
  });
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
