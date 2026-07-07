import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { withAuthGuard } from "../lib/auth-guard.js";
import { formatPoll } from "../lib/formatters.js";

export function registerPollsTools(server: McpServer): void {
  server.tool(
    "get-poll",
    "Get a poll by ID (requires authorization).",
    { id: z.string() },
    withAuthGuard(async ({ id }) => {
      try {
        const result = await api.get(`/polls/${encodeURIComponent(id)}`);
        return { content: [{ type: "text" as const, text: formatPoll(result as Record<string, unknown>) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "get-poll-results",
    "Get poll results (requires authorization).",
    { id: z.string() },
    withAuthGuard(async ({ id }) => {
      try {
        const result = await api.get(`/polls/${encodeURIComponent(id)}/results`);
        return { content: [{ type: "text" as const, text: formatPoll(result as Record<string, unknown>) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "vote-poll",
    "Vote in a poll (requires authorization).",
    {
      id: z.string(),
      optionIndex: z.number().describe("Zero-based option index"),
    },
    withAuthGuard(async ({ id, optionIndex }) => {
      try {
        const result = await api.post(`/polls/${encodeURIComponent(id)}/vote`, { optionIndex });
        return { content: [{ type: "text" as const, text: `Vote recorded.\n\n${formatPoll(result as Record<string, unknown>)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );
}
