import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { formatPoll } from "../lib/formatters.js";

export function registerPollsTools(server: McpServer): void {
  // ── get-poll ─────────────────────────────────────────────────
  server.tool(
    "get-poll",
    "Get a poll by its ID.",
    {
      id: z.string().describe("The poll ID"),
    },
    async ({ id }) => {
      try {
        const result = await api.get(`/polls/${encodeURIComponent(id)}`);
        return { content: [{ type: "text" as const, text: formatPoll(result as Record<string, unknown>) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── get-poll-results ─────────────────────────────────────────
  server.tool(
    "get-poll-results",
    "Get the results/votes for a poll.",
    {
      id: z.string().describe("The poll ID"),
    },
    async ({ id }) => {
      try {
        const result = await api.get(`/polls/${encodeURIComponent(id)}/results`);
        return { content: [{ type: "text" as const, text: formatPoll(result as Record<string, unknown>) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── vote-poll ────────────────────────────────────────────────
  server.tool(
    "vote-poll",
    "Vote in a poll by selecting an option index.",
    {
      id: z.string().describe("The poll ID"),
      optionIndex: z.number().describe("The zero-based index of the option to vote for"),
    },
    async ({ id, optionIndex }) => {
      try {
        const result = await api.post(`/polls/${encodeURIComponent(id)}/vote`, { optionIndex });
        return { content: [{ type: "text" as const, text: `Vote recorded.\n\n${formatPoll(result as Record<string, unknown>)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );
}
