import type { z } from "zod";
import { getInputSchema, listInputSchema, recentInputSchema, searchInputSchema } from "../schemas/memory.js";
import type { MemoryQueryService, SearchSortBy } from "../services/memory-query.service.js";
import type { ToolResponseService } from "../services/tool-response.service.js";

// Tool-facing sort names -> MemoryQueryService sort keys ("recent" aliases "updated").
const SEARCH_SORT_BY: Record<z.infer<typeof searchInputSchema>["sortBy"], SearchSortBy> = {
  relevance: "relevance",
  recent: "updatedAt",
  updated: "updatedAt",
  created: "createdAt",
  name: "title",
};

const LIST_SORT_BY: Record<z.infer<typeof listInputSchema>["sortBy"], SearchSortBy> = {
  name: "title",
  updated: "updatedAt",
  created: "createdAt",
};

export class NoteController {
  constructor(private readonly query: MemoryQueryService, private readonly responses: ToolResponseService) {}

  register(server: { registerTool: Function }) {
    server.registerTool("memory_search", { description: "Search notes by text, tags, folder, or type. Set includeSections to attach the best-matching heading anchor (section, line, snippet) to each hit.", inputSchema: searchInputSchema, annotations: { readOnlyHint: true, idempotentHint: true } }, (input: z.infer<typeof searchInputSchema>) => this.search(input));
    server.registerTool("memory_get", { description: "Get a note by path, id, or title. Returns outgoing and incoming wikilinks (backlinks) when includeLinks is true.", inputSchema: getInputSchema, annotations: { readOnlyHint: true, idempotentHint: true } }, (input: z.infer<typeof getInputSchema>) => this.get(input));
    server.registerTool("memory_list", { description: "List notes by folder, type, or tag.", inputSchema: listInputSchema, annotations: { readOnlyHint: true, idempotentHint: true } }, (input: z.infer<typeof listInputSchema>) => this.list(input));
    server.registerTool("memory_recent", { description: "Get recently updated or created notes.", inputSchema: recentInputSchema, annotations: { readOnlyHint: true, idempotentHint: true } }, (input: z.infer<typeof recentInputSchema>) => this.recent(input));
  }

  async search(input: z.infer<typeof searchInputSchema>) {
    const startedAt = Date.now();
    const results = await this.query.search(input.query, input.tags, input.folder, input.type, input.limit, input.offset, input.includeSections, {
      sortBy: SEARCH_SORT_BY[input.sortBy],
      scope: input.scope,
      includeBody: input.includeBody,
    });
    return this.responses.buildOk("memory_search", startedAt, { results, total: results.length, query: input.query, nextOffset: input.offset + input.limit });
  }

  async get(input: z.infer<typeof getInputSchema>) {
    const startedAt = Date.now();
    // Enforced here, not via .refine on getInputSchema: the MCP SDK advertises
    // a ZodEffects as an empty JSON schema, hiding the contract from clients.
    if (!input.path && !input.id && !input.title) {
      return this.responses.buildError("memory_get", startedAt, "INVALID_INPUT", "Provide path, id, or title");
    }
    try {
      const reference = `${input.path ?? input.title ?? input.id}`;
      const note = await this.query.get(reference);
      return this.responses.buildOk("memory_get", startedAt, { note: { ...note, body: input.includeBody ? note.body : undefined, outgoingLinks: input.includeLinks ? note.outgoingLinks : [], incomingLinks: input.includeLinks ? note.incomingLinks : [] } });
    } catch (error) {
      return this.responses.buildError("memory_get", startedAt, "NOT_FOUND", error instanceof Error ? error.message : "Note not found");
    }
  }

  async list(input: z.infer<typeof listInputSchema>) {
    const startedAt = Date.now();
    const items = await this.query.search("", input.tag ? [input.tag] : [], input.folder, input.type, input.limit, input.offset, false, { sortBy: LIST_SORT_BY[input.sortBy] });
    return this.responses.buildOk("memory_list", startedAt, { items });
  }

  async recent(input: z.infer<typeof recentInputSchema>) {
    const startedAt = Date.now();
    const items = await this.query.recent(input.folders, input.types, input.sortBy, input.limit);
    return this.responses.buildOk("memory_recent", startedAt, { items });
  }
}
