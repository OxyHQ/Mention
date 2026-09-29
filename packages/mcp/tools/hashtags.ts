import { z } from "zod/v4";
import { api, formatApiError } from "../lib/api-client.js";
import { fetchMtnFeed } from "../lib/mtn-feed.js";
import { formatFeed } from "../lib/formatters.js";
import type { MentionToolRegistrar } from "../lib/tool-registry.js";

/**
 * One trend as a person reads it: its name, whether it's a hashtag or a topic,
 * and how many posts and people carry it. The ranking score is internal and
 * meaningless outside the ranker, so it is not shown.
 */
export function formatTrend(h: Record<string, unknown>, i: number): string {
  const raw = String(h.displayName || h.name || h.hashtag || h.tag || h.label || "unknown");
  const isHashtag = h.type === "hashtag" || raw.startsWith("#");
  const name = isHashtag ? `#${raw.replace(/^#/, "")}` : raw;
  const posts = typeof h.volume === "number" ? h.volume : typeof h.count === "number" ? h.count : typeof h.postCount === "number" ? h.postCount : undefined;
  const people = typeof h.authorCount === "number" ? h.authorCount : undefined;
  const size = [posts !== undefined ? `${posts} post${posts === 1 ? "" : "s"}` : "", people !== undefined ? `${people} ${people === 1 ? "person" : "people"}` : ""].filter(Boolean).join(" by ");
  const langs = Array.isArray(h.languages) && h.languages.length ? ` · ${(h.languages as string[]).join(", ")}` : "";
  const about = typeof h.description === "string" && h.description ? ` — ${h.description}` : "";
  return `${i + 1}. ${name} (${isHashtag ? "hashtag" : "topic"}${size ? `, ${size}` : ""}${langs})${about}`;
}

export function registerHashtagsTools(server: MentionToolRegistrar): void {
  server.tool(
    "get-trending-hashtags",
    "Get what is trending on Mention now: hashtags and topics, with how many posts and people (public).",
    {
      limit: z.number().optional().describe("Number of items to return (default: 20)"),
      type: z.enum(["all", "hashtag", "topic"]).optional().describe("Hashtags, topics (people, places, subjects), or both (default: all)"),
    },
    async ({ limit, type }) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (type === "hashtag") query.type = "hashtag";
        if (type === "topic") query.type = "entity";
        if (limit) query.limit = limit;

        const result = await api.get("/trending", query);
        const resultObj = result as Record<string, unknown>;
        const trending = Array.isArray(resultObj.trending) ? resultObj.trending : [];

        if (trending.length === 0) {
          return { content: [{ type: "text" as const, text: "No trending hashtags right now." }] };
        }

        const lines = trending.map((h: Record<string, unknown>, i: number) => formatTrend(h, i));

        return { content: [{ type: "text" as const, text: `Trending on Mention:\n\n${lines.join("\n")}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  server.tool(
    "get-posts-by-hashtag",
    "Get public posts tagged with a specific hashtag.",
    {
      hashtag: z.string().describe("The hashtag to search for (without # prefix)"),
      limit: z.number().optional().describe("Number of posts (default: 20, max: 100)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    async ({ hashtag, limit, cursor }) => {
      try {
        const tag = hashtag.replace(/^#/, "");
        const result = await fetchMtnFeed(`hashtag|${tag}`, { limit, cursor });
        return { content: [{ type: "text" as const, text: formatFeed(result) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );
}
