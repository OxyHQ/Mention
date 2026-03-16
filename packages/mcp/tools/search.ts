import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { formatFeed } from "../lib/formatters.js";

export function registerSearchTools(server: McpServer): void {
  server.tool(
    "search",
    `Search posts on Mention. Supports advanced operators in the query:
  from:username — filter by author
  since:YYYY-MM-DD — posts after date
  until:YYYY-MM-DD — posts before date
  has:media — posts with images/video
  has:links — posts with URLs
  min_likes:N — minimum likes
  min_reposts:N — minimum reposts

Example: "climate from:scienceguy since:2025-01-01 has:media"`,
    {
      query: z.string().describe("Search query (supports operators like from:, since:, has:media, etc.)"),
      limit: z.number().optional().describe("Number of results (default: 20, max: 100)"),
      cursor: z.string().optional().describe("Pagination cursor"),
      language: z.string().optional().describe("Filter by language code (e.g. 'en', 'es')"),
    },
    async ({ query, limit, cursor, language }) => {
      try {
        const params: Record<string, string | number | boolean | undefined> = {
          query,
        };
        if (limit) params.limit = limit;
        if (cursor) params.cursor = cursor;
        if (language) params.language = language;

        const result = await api.get("/search", params);
        return { content: [{ type: "text" as const, text: formatFeed(result as Record<string, unknown>) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );
}
