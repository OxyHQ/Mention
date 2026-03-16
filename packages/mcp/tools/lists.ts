import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { formatList, formatFeed } from "../lib/formatters.js";

export function registerListsTools(server: McpServer): void {
  // ── create-list ──────────────────────────────────────────────
  server.tool(
    "create-list",
    "Create a new user list for organizing accounts.",
    {
      title: z.string().describe("List title"),
      description: z.string().optional().describe("List description"),
      isPublic: z.boolean().optional().describe("Whether the list is public (default: true)"),
      memberUserIds: z
        .array(z.string())
        .optional()
        .describe("Initial member user IDs to add"),
    },
    async ({ title, description, isPublic, memberUserIds }) => {
      try {
        const body: Record<string, unknown> = { title };
        if (description) body.description = description;
        if (isPublic !== undefined) body.isPublic = isPublic;
        if (memberUserIds) body.memberOxyUserIds = memberUserIds;

        const result = await api.post("/lists", body);
        return { content: [{ type: "text" as const, text: `List created.\n\n${formatList(result as Record<string, unknown>)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── get-lists ────────────────────────────────────────────────
  server.tool(
    "get-lists",
    "Get your lists or public lists.",
    {
      mine: z.boolean().optional().describe("Only return your own lists"),
      publicOnly: z.boolean().optional().describe("Only return public lists"),
    },
    async ({ mine, publicOnly }) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (mine) query.mine = true;
        if (publicOnly) query.publicOnly = true;

        const result = await api.get("/lists", query);
        const resultObj = result as Record<string, unknown>;
        const items = Array.isArray(resultObj.items) ? resultObj.items : [];
        if (items.length === 0) {
          return { content: [{ type: "text" as const, text: "No lists found." }] };
        }
        const formatted = items.map((l: Record<string, unknown>) => formatList(l)).join("\n\n");
        return { content: [{ type: "text" as const, text: `Lists (${items.length}):\n\n${formatted}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── update-list ──────────────────────────────────────────────
  server.tool(
    "update-list",
    "Update a list's title, description, visibility, or members.",
    {
      id: z.string().describe("List ID to update"),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description"),
      isPublic: z.boolean().optional().describe("New visibility setting"),
      memberUserIds: z
        .array(z.string())
        .optional()
        .describe("Replace all members with these user IDs"),
    },
    async ({ id, title, description, isPublic, memberUserIds }) => {
      try {
        const body: Record<string, unknown> = {};
        if (title !== undefined) body.title = title;
        if (description !== undefined) body.description = description;
        if (isPublic !== undefined) body.isPublic = isPublic;
        if (memberUserIds) body.memberOxyUserIds = memberUserIds;

        const result = await api.put(`/lists/${encodeURIComponent(id)}`, body);
        return { content: [{ type: "text" as const, text: `List updated.\n\n${formatList(result as Record<string, unknown>)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── delete-list ──────────────────────────────────────────────
  server.tool(
    "delete-list",
    "Delete a list.",
    {
      id: z.string().describe("List ID to delete"),
    },
    async ({ id }) => {
      try {
        await api.delete(`/lists/${encodeURIComponent(id)}`);
        return { content: [{ type: "text" as const, text: `List ${id} deleted.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── get-list-timeline ────────────────────────────────────────
  server.tool(
    "get-list-timeline",
    "Get the timeline of posts from members of a list.",
    {
      id: z.string().describe("List ID"),
      limit: z.number().optional().describe("Number of posts (default: 20)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    async ({ id, limit, cursor }) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (limit) query.limit = limit;
        if (cursor) query.cursor = cursor;

        const result = await api.get(`/lists/${encodeURIComponent(id)}/timeline`, query);
        return { content: [{ type: "text" as const, text: formatFeed(result as Record<string, unknown>) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );
}
