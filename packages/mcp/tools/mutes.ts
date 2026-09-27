import { z } from "zod/v4";
import { api, formatApiError } from "../lib/api-client.js";
import { unwrapData } from "../lib/api-response.js";
import { withAuthGuard } from "../lib/auth-guard.js";
import type { MentionToolRegistrar } from "../lib/tool-registry.js";

interface MutedWord {
  id: string;
  value: string;
  targets: string[];
  actorTarget: string;
}

function formatMutedWord(word: MutedWord): string {
  const scope = word.actorTarget === "exclude-following" ? " · not from people you follow" : "";
  return `${word.value} (id: ${word.id}) · ${word.targets.join(", ")}${scope}`;
}

export function registerMutesTools(server: MentionToolRegistrar): void {
  server.tool(
    "get-muted-users",
    "List the Oxy user IDs you have muted (requires authorization).",
    {},
    withAuthGuard(async () => {
      try {
        const result = await api.get<{ mutes?: Array<{ mutedId?: string; createdAt?: string }> }>("/mute");
        const mutes = Array.isArray(result.mutes) ? result.mutes : [];
        if (mutes.length === 0) {
          return { content: [{ type: "text" as const, text: "You have not muted anyone." }] };
        }
        const lines = mutes.map((mute) => `${mute.mutedId ?? "unknown"}${mute.createdAt ? ` · since ${mute.createdAt}` : ""}`);
        return { content: [{ type: "text" as const, text: `Muted users (${mutes.length}):\n\n${lines.join("\n")}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "mute-user",
    "Mute a user: their posts stop appearing in your feeds, without unfollowing or telling them (requires authorization). Undo with unmute-user.",
    { userId: z.string().describe("Oxy user ID, as get-post and get-profile show it") },
    withAuthGuard(async ({ userId }) => {
      try {
        await api.post("/mute", { mutedId: userId });
        return { content: [{ type: "text" as const, text: `Muted ${userId}.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "unmute-user",
    "Unmute a user you muted (requires authorization).",
    { userId: z.string().describe("Oxy user ID") },
    withAuthGuard(async ({ userId }) => {
      try {
        await api.delete(`/mute/${encodeURIComponent(userId)}`);
        return { content: [{ type: "text" as const, text: `Unmuted ${userId}.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "get-muted-words",
    "List the words and hashtags you have muted (requires authorization).",
    {},
    withAuthGuard(async () => {
      try {
        const words = unwrapData<MutedWord[]>(await api.get("/mute-words"));
        if (!Array.isArray(words) || words.length === 0) {
          return { content: [{ type: "text" as const, text: "No muted words." }] };
        }
        return { content: [{ type: "text" as const, text: `Muted words (${words.length}):\n\n${words.map(formatMutedWord).join("\n")}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "mute-word",
    "Mute a word, phrase or #hashtag so posts containing it stop appearing in your feeds (requires authorization). Undo with unmute-word.",
    {
      value: z.string().min(1).max(100).describe("Word, phrase or #hashtag"),
      targets: z
        .array(z.enum(["content", "tag"]))
        .min(1)
        .optional()
        .describe("Match the post text (content), its hashtags (tag), or both (default)"),
      actorTarget: z
        .enum(["all", "exclude-following"])
        .optional()
        .describe("all (default) or exclude-following to still see it from people you follow"),
    },
    withAuthGuard(async ({ value, targets, actorTarget }) => {
      try {
        const word = unwrapData<MutedWord>(await api.post("/mute-words", { value, targets, actorTarget }));
        return { content: [{ type: "text" as const, text: `Muted.\n\n${formatMutedWord(word)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "unmute-word",
    "Unmute a muted word (requires authorization). Use the id get-muted-words shows.",
    { id: z.string().describe("Muted word ID") },
    withAuthGuard(async ({ id }) => {
      try {
        await api.delete(`/mute-words/${encodeURIComponent(id)}`);
        return { content: [{ type: "text" as const, text: `Muted word ${id} removed.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );
}
