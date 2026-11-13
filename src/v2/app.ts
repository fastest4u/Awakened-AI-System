import { existsSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { FreshStartError } from "../orchestrator/fresh-start/contracts.js";
import { createV2Foundation, validateRoutedProjectRoot } from "./composition.js";
import { diagnosticCode, loadV2LaunchConfig } from "./config.js";
import { STATUS_TOOL_DEFINITION } from "./public-tools.js";
import { buildMemoryKnowledgeGraph } from "./webui.js";

export async function runV2Server(): Promise<void> {
  const launchConfig = loadV2LaunchConfig(process.env);
  const foundation = await createV2Foundation(launchConfig);
  const server = new Server(
    { name: "project-memory-v2-foundation", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 });

  const resolveReadOnlyRoutedProject = (rawProjectRoot: string | null): {
    readonly effectiveRoot: string;
    readonly routedArgs: Record<string, string>;
  } => {
    if (!rawProjectRoot || rawProjectRoot.trim().length === 0) {
      return { effectiveRoot: launchConfig.projectRoot, routedArgs: {} };
    }
    const targetRoot = validateRoutedProjectRoot(rawProjectRoot, launchConfig);
    if (!targetRoot) {
      return { effectiveRoot: launchConfig.projectRoot, routedArgs: {} };
    }
    const identityFile = join(targetRoot, "memory-v2", ".memory-mcp", "project-identity.json");
    if (!existsSync(identityFile)) {
      throw new FreshStartError("FRESH_START_INPUT_INVALID");
    }
    return { effectiveRoot: targetRoot, routedArgs: { projectRoot: targetRoot } };
  };

  const formatRulesMarkdown = (selfCheck: {
    bindingADRs?: Array<{ title?: string; summary?: string }>;
    pastMistakesToAvoid?: Array<{ title?: string; summary?: string }>;
  }): string => {
    return [
      "# Active Project Memory V2 Guardrails",
      "",
      "## Binding ADRs",
      ...(selfCheck.bindingADRs ?? []).map((a) => `- **${a.title ?? "ADR"}**: ${a.summary ?? ""}`),
      "",
      "## Past Mistakes to Avoid",
      ...(selfCheck.pastMistakesToAvoid ?? []).map(
        (m) => `- **${m.title ?? "Mistake"}**: ${m.summary ?? ""}`,
      ),
    ].join("\n");
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: foundation.content.listTools
      ? [...(await foundation.content.listTools())]
      : [STATUS_TOOL_DEFINITION],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: "memory://notes/{recordId}",
        name: "Governed Memory Note by Record ID",
        description: "Full governed V2 note record, Markdown body, status, and linked entities.",
        mimeType: "application/json",
      },
      {
        uriTemplate: "memory://sessions/{sessionId}",
        name: "Governed Session Authority & Lineage",
        description: "Session lifecycle state, parent/child lineage, and authored note IDs.",
        mimeType: "application/json",
      },
      {
        uriTemplate: "memory://projects/{projectRoot}/status",
        name: "Project Memory V2 Status by Project Root",
        description: "Read-only Fresh-Start V2 status for an initialized workspace.",
        mimeType: "application/json",
      },
      {
        uriTemplate: "memory://projects/{projectRoot}/radar",
        name: "Follow-Up Radar by Project Root",
        description: "Read-only open follow-up radar items for an initialized workspace.",
        mimeType: "application/json",
      },
      {
        uriTemplate: "memory://projects/{projectRoot}/awaken",
        name: "Autonomous Awakening Briefing by Project Root",
        description: "Read-only synthesized awakening briefing for an initialized workspace.",
        mimeType: "application/json",
      },
      {
        uriTemplate: "memory://projects/{projectRoot}/rules",
        name: "Active Binding ADRs & Mistakes by Project Root",
        description: "Read-only Markdown guardrail summary for an initialized workspace.",
        mimeType: "text/markdown",
      },
    ],
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
        uri: "memory://current/radar",
        name: "Project Memory V2 Follow-Up Radar",
        description: "Open follow-up tasks and pending verification radar in the current workspace.",
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
      {
        uri: "memory://current/adrs",
        name: "Active Architectural Decision Records (ADRs)",
        description: "All active governed ADRs in the current workspace.",
        mimeType: "application/json",
      },
      {
        uri: "memory://current/mistakes",
        name: "Active Recorded Mistakes & Regressions",
        description: "All active governed mistake records in the current workspace.",
        mimeType: "application/json",
      },
      {
        uri: "memory://graph",
        name: "Project Memory V2 Knowledge Graph",
        description: "Full V2 knowledge graph (sessions, notes, files, symbols, wikilinks, supersessions, causal triads).",
        mimeType: "application/json",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      const uri = request.params.uri;
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(uri);
      } catch {
        throw new FreshStartError("FRESH_START_INPUT_INVALID");
      }
      if (parsedUrl.protocol !== "memory:") {
        throw new FreshStartError("FRESH_START_INPUT_INVALID");
      }

      const routeHost = parsedUrl.host.toLowerCase();
      let rawPathSegments: string[];
      try {
        rawPathSegments = parsedUrl.pathname
          .split("/")
          .filter((s) => s.length > 0)
          .map((s) => decodeURIComponent(s));
      } catch {
        throw new FreshStartError("FRESH_START_INPUT_INVALID");
      }

      let queryProjectRoot = parsedUrl.searchParams.get("projectRoot");
      let effectiveRoute =
        rawPathSegments.length > 0 ? `${routeHost}/${rawPathSegments.join("/")}` : routeHost;

      const projectTrailingRoutes = new Set(["status", "radar", "awaken", "rules"]);
      if (routeHost === "projects" && rawPathSegments.length >= 2) {
        const tail = rawPathSegments[rawPathSegments.length - 1]!.toLowerCase();
        if (!projectTrailingRoutes.has(tail)) {
          throw new FreshStartError("FRESH_START_INPUT_INVALID");
        }
        const joinedRoot = rawPathSegments.slice(0, -1).join("/");
        queryProjectRoot =
          /^[a-z]:/iu.test(joinedRoot) || joinedRoot.startsWith("/") || joinedRoot.startsWith("\\")
            ? joinedRoot
            : `/${joinedRoot}`;
        effectiveRoute = `current/${tail}`;
      }

      const { effectiveRoot, routedArgs } = resolveReadOnlyRoutedProject(queryProjectRoot);

      if (effectiveRoute === "current/status") {
        const statusPayload =
          routedArgs.projectRoot && foundation.statusForProject
            ? await foundation.statusForProject(routedArgs.projectRoot)
            : await foundation.status();
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify({ ok: true, ...statusPayload }, null, 2),
            },
          ],
        };
      }

      if (effectiveRoute === "current/radar") {
        const radar = await foundation.content.invoke("memory_followUpRadar", { ...routedArgs });
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(radar, null, 2),
            },
          ],
        };
      }

      if (effectiveRoute === "current/awaken") {
        const awaken = await foundation.content.invoke("memory_awaken", { ...routedArgs });
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

      if (effectiveRoute === "current/rules") {
        const selfCheck = (await foundation.content.invoke("memory_selfCheck", {
          ...routedArgs,
          autoDetectFiles: false,
        })) as {
          bindingADRs?: Array<{ title?: string; summary?: string }>;
          pastMistakesToAvoid?: Array<{ title?: string; summary?: string }>;
        };
        return {
          contents: [
            {
              uri,
              mimeType: "text/markdown",
              text: formatRulesMarkdown(selfCheck),
            },
          ],
        };
      }

      if (effectiveRoute === "current/adrs") {
        const adrs = await foundation.content.invoke("memory_list", {
          ...routedArgs,
          kind: "adr",
          limit: 100,
        });
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(adrs, null, 2),
            },
          ],
        };
      }

      if (effectiveRoute === "current/mistakes") {
        const mistakes = await foundation.content.invoke("memory_list", {
          ...routedArgs,
          kind: "mistake",
          limit: 100,
        });
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(mistakes, null, 2),
            },
          ],
        };
      }

      if (effectiveRoute === "graph") {
        const listed = (await foundation.content.invoke("memory_list", {
          ...routedArgs,
          limit: 100,
        })) as { items?: Array<Record<string, unknown>> };
        const lifecycle = (await foundation.content.invoke("memory_lifecycleStatus", {
          ...routedArgs,
        })) as { sessions?: Array<Record<string, unknown>> };
        const filterMissingRepoFiles =
          existsSync(join(effectiveRoot, "src")) || existsSync(join(effectiveRoot, "package.json"));
        const graph = buildMemoryKnowledgeGraph(
          listed.items ?? [],
          lifecycle.sessions ?? [],
          { projectRoot: effectiveRoot, filterMissingRepoFiles },
        );
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(graph, null, 2),
            },
          ],
        };
      }

      if (routeHost === "notes" && rawPathSegments.length === 1) {
        const recordId = rawPathSegments[0]!.trim();
        if (!recordId) throw new FreshStartError("FRESH_START_INPUT_INVALID");
        const note = await foundation.content.invoke("memory_get", {
          ...routedArgs,
          id: recordId,
        });
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(note, null, 2),
            },
          ],
        };
      }

      if (routeHost === "sessions" && rawPathSegments.length === 1) {
        const sessionId = rawPathSegments[0]!.trim();
        if (!sessionId) throw new FreshStartError("FRESH_START_INPUT_INVALID");
        const lifecycle = (await foundation.content.invoke("memory_lifecycleStatus", {
          ...routedArgs,
        })) as {
          sessions?: Array<Record<string, unknown>>;
        };
        const matched = (lifecycle.sessions ?? []).find(
          (s) => String(s.sessionId ?? "") === sessionId,
        );
        if (!matched) throw new FreshStartError("FRESH_START_INPUT_INVALID");
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify({ ok: true, session: matched }, null, 2),
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
      {
        name: "session-handoff",
        description: "Prepare a governed session handoff summary with open follow-ups, checkpoints, and closure verification.",
        arguments: [
          {
            name: "sessionId",
            description: "Optional session ID to generate the handoff summary for.",
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
    if (name === "session-handoff") {
      const targetSession = args.sessionId?.trim();
      return {
        description: "Governed Project Memory V2 session handoff & closure workflow",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: targetSession
                ? `Inspect session "${targetSession}" via memory_lifecycleStatus and memory_followUpRadar, record any pending decisions/lessons via memory_writeADR or memory_writeInsight, save final nextActions with memory_checkpoint, finalize closure with memory_sessionEnd(sessionId="${targetSession}", finalize=true), and verify health with memory_verifyVault.`
                : "Inspect active session state via memory_lifecycleStatus and memory_followUpRadar, record any pending decisions/lessons, save final nextActions with memory_checkpoint, finalize closure with memory_sessionEnd(finalize=true), and verify health with memory_verifyVault.",
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
