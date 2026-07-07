import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { withAuthGuard } from "../lib/auth-guard.js";
import { formatList, formatFeed } from "../lib/formatters.js";

export function registerListsTools(server: McpServer): void {
  server.tool(
    "create-list",
    "Create a user list (requires authorization).",
    {
      title: z.string(),
      description: z.string().optional(),
      isPublic: z.boolean().optional(),
      memberUserIds: z.array(z.string()).optional(),
    },
    withAuthGuard(async ({ title, description, isPublic, memberUserIds }) => {
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
    }),
  );

  server.tool(
    "get-lists",
    "Get your lists (requires authorization).",
    {
      mine: z.boolean().optional(),
      publicOnly: z.boolean().optional(),
    },
    withAuthGuard(async ({ mine, publicOnly }) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (mine) query.mine = true;
        if (publicOnly) query.publicOnly = true;

        const result = await api.get("/lists", query);
        const items = Array.isArray((result as Record<string, unknown>).items)
          ? (result as Record<string, unknown>).items as Record<string, unknown>[]
          : [];
        if (items.length === 0) {
          return { content: [{ type: "text" as const, text: "No lists found." }] };
        }
        const formatted = items.map((l) => formatList(l)).join("\n\n");
        return { content: [{ type: "text" as const, text: `Lists (${items.length}):\n\n${formatted}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "update-list",
    "Update a list (requires authorization).",
    {
      id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      isPublic: z.boolean().optional(),
      memberUserIds: z.array(z.string()).optional(),
    },
    withAuthGuard(async ({ id, title, description, isPublic, memberUserIds }) => {
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
    }),
  );

  server.tool(
    "delete-list",
    "Delete a list (requires authorization).",
    { id: z.string() },
    withAuthGuard(async ({ id }) => {
      try {
        await api.delete(`/lists/${encodeURIComponent(id)}`);
        return { content: [{ type: "text" as const, text: `List ${id} deleted.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "get-list-timeline",
    "Get posts from list members (requires authorization).",
    {
      id: z.string(),
      limit: z.number().optional(),
      cursor: z.string().optional(),
    },
    withAuthGuard(async ({ id, limit, cursor }) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (limit) query.limit = limit;
        if (cursor) query.cursor = cursor;

        const result = await api.get(`/lists/${encodeURIComponent(id)}/timeline`, query);
        return { content: [{ type: "text" as const, text: formatFeed(result as Record<string, unknown>) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );
}
