import type { PollDetail, PollResults } from "@mention/shared-types";
import { z } from "zod/v4";
import { api, formatApiError } from "../lib/api-client.js";
import { unwrapApiResponse } from "../lib/api-response.js";
import { withAuthGuard } from "../lib/auth-guard.js";
import { formatPoll } from "../lib/formatters.js";
import type { MentionToolRegistrar } from "../lib/tool-registry.js";

export function registerPollsTools(server: MentionToolRegistrar): void {
  server.tool(
    "get-poll",
    "Get a poll by ID, with each option's id (requires authorization).",
    { id: z.string() },
    withAuthGuard(async ({ id }) => {
      try {
        const result = await api.get(`/polls/${encodeURIComponent(id)}`);
        return { content: [{ type: "text" as const, text: formatPoll(unwrapApiResponse<PollDetail>(result)) }] };
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
        return { content: [{ type: "text" as const, text: formatPoll(unwrapApiResponse<PollResults>(result)) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "vote-poll",
    "Vote in a poll (requires authorization). Pass the option's id from get-poll, or its zero-based position. A vote is final: Mention has no way to take one back.",
    {
      id: z.string(),
      optionId: z.string().optional().describe("Option ID, as get-poll lists it"),
      optionIndex: z.number().int().min(0).optional().describe("Zero-based option index, when the id is not known"),
    },
    withAuthGuard(async ({ id, optionId, optionIndex }) => {
      if ((optionId === undefined) === (optionIndex === undefined)) {
        return { content: [{ type: "text" as const, text: "Pass exactly one of optionId or optionIndex." }], isError: true };
      }
      try {
        // `POST /polls/:id/vote` takes the option's id only; a position is
        // resolved against the poll as the voter sees it right now.
        let chosen = optionId;
        if (chosen === undefined) {
          const poll = unwrapApiResponse<PollDetail>(await api.get(`/polls/${encodeURIComponent(id)}`));
          chosen = poll.options?.[optionIndex as number]?._id;
          if (!chosen) {
            return {
              content: [{ type: "text" as const, text: `Poll ${id} has no option at index ${optionIndex}.` }],
              isError: true,
            };
          }
        }
        const result = await api.post(`/polls/${encodeURIComponent(id)}/vote`, { optionId: chosen });
        return { content: [{ type: "text" as const, text: `Vote recorded.\n\n${formatPoll(unwrapApiResponse<PollDetail>(result))}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );
}
