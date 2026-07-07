import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { withAuthGuard } from "../lib/auth-guard.js";
import { formatFeed } from "../lib/formatters.js";

export function registerSearchTools(server: McpServer): void {
  server.tool(
    "search",
    `Search posts on Mention (requires authorization). Supports operators: from:username, since:YYYY-MM-DD, until:YYYY-MM-DD, has:media, has:links, min_likes:N, min_boosts:N`,
    {
      query: z.string(),
      limit: z.number().optional(),
      cursor: z.string().optional(),
      language: z.string().optional(),
    },
    withAuthGuard(async ({ query, limit, cursor, language }) => {
      try {
        const params: Record<string, string | number | boolean | undefined> = { query };
        if (limit) params.limit = limit;
        if (cursor) params.cursor = cursor;
        if (language) params.language = language;

        const result = await api.get("/search", params);
        return { content: [{ type: "text" as const, text: formatFeed(result as Record<string, unknown>) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );
}
