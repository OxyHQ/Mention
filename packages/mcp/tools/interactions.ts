import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { unwrapApiResponse } from "../lib/api-response.js";
import { withAuthGuard } from "../lib/auth-guard.js";
import { formatPost } from "../lib/formatters.js";
import { buildPostContentPayload } from "../lib/resolve-media.js";
import { mediaInputSchema } from "../lib/post-content-schema.js";

export function registerInteractionsTools(server: McpServer): void {
  server.tool(
    "like-post",
    "Like a post (requires authorization).",
    { id: z.string().describe("The post ID to like") },
    withAuthGuard(async ({ id }) => {
      try {
        await api.post(`/posts/${encodeURIComponent(id)}/like`);
        return { content: [{ type: "text" as const, text: `Post ${id} liked.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "unlike-post",
    "Remove your like from a post (requires authorization).",
    { id: z.string() },
    withAuthGuard(async ({ id }) => {
      try {
        await api.delete(`/posts/${encodeURIComponent(id)}/like`);
        return { content: [{ type: "text" as const, text: `Post ${id} unliked.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "save-post",
    "Bookmark a post (requires authorization).",
    { id: z.string() },
    withAuthGuard(async ({ id }) => {
      try {
        await api.post(`/posts/${encodeURIComponent(id)}/save`);
        return { content: [{ type: "text" as const, text: `Post ${id} saved to bookmarks.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "unsave-post",
    "Remove a post from bookmarks (requires authorization).",
    { id: z.string() },
    withAuthGuard(async ({ id }) => {
      try {
        await api.delete(`/posts/${encodeURIComponent(id)}/save`);
        return { content: [{ type: "text" as const, text: `Post ${id} removed from bookmarks.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "boost",
    "Boost a post to your followers (requires authorization).",
    { id: z.string() },
    withAuthGuard(async ({ id }) => {
      try {
        const result = await api.post("/feed/boost", {
          originalPostId: id,
          content: { text: "" },
          mentions: [],
          hashtags: [],
        });
        const boost = unwrapApiResponse<Record<string, unknown>>(
          (result as { boost?: unknown }).boost ?? result,
        );
        return { content: [{ type: "text" as const, text: `Post ${id} boosted.\n\n${formatPost(boost)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "quote-post",
    "Quote a post with commentary and optional media (requires authorization).",
    {
      id: z.string(),
      text: z.string().describe("Your commentary"),
      media: z.array(mediaInputSchema).max(10).optional(),
    },
    withAuthGuard(async ({ id, text, media }) => {
      try {
        const content = await buildPostContentPayload({
          text,
          ...(media ? { media } : {}),
        });
        const result = await api.post("/posts", {
          content,
          hashtags: [],
          mentions: [],
          visibility: "public",
          quoted_post_id: id,
        });
        const post = unwrapApiResponse(result);
        return { content: [{ type: "text" as const, text: `Quote post created.\n\n${formatPost(post)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );
}
