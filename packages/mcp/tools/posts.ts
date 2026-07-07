import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { normalizeVisibility, unwrapApiResponse } from "../lib/api-response.js";
import { withAuthGuard } from "../lib/auth-guard.js";
import { formatPost } from "../lib/formatters.js";

const visibilitySchema = z
  .enum(["public", "private", "followers", "followers_only"])
  .optional()
  .describe("Post visibility (default: public)");

export function registerPostsTools(server: McpServer): void {
  server.tool(
    "create-post",
    "Create a new post on Mention (requires authorization).",
    {
      text: z.string().describe("The text content of the post"),
      visibility: visibilitySchema,
      hashtags: z.array(z.string()).optional().describe("Hashtags (without # prefix)"),
      mentions: z.array(z.string()).optional().describe("User IDs to mention"),
      parentPostId: z.string().optional().describe("ID of the post to reply to"),
      sources: z
        .array(z.object({ url: z.string(), title: z.string().optional() }))
        .optional()
        .describe("External sources cited in the post"),
      status: z.enum(["published", "draft", "scheduled"]).optional(),
      scheduledFor: z.string().optional().describe("ISO date for scheduled posts"),
      language: z.string().optional().describe("Language code (default: en)"),
      replyPermission: z
        .array(z.enum(["anyone", "followers", "following", "mentioned", "nobody"]))
        .optional(),
    },
    withAuthGuard(async ({ text, visibility, hashtags, mentions, parentPostId, sources, status, scheduledFor, language, replyPermission }) => {
      try {
        const body: Record<string, unknown> = { content: { text } };
        const vis = normalizeVisibility(visibility);
        if (vis) body.visibility = vis;
        if (hashtags) body.hashtags = hashtags;
        if (mentions) body.mentions = mentions;
        if (parentPostId) body.parentPostId = parentPostId;
        if (sources) body.sources = sources;
        if (status) body.status = status;
        if (scheduledFor) body.scheduledFor = scheduledFor;
        if (language) body.language = language;
        if (replyPermission) body.replyPermission = replyPermission;

        const result = await api.post("/posts", body);
        const post = unwrapApiResponse(result);
        return { content: [{ type: "text" as const, text: `Post created successfully.\n\n${formatPost(post)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "create-thread",
    "Create a multi-post thread (requires authorization).",
    {
      posts: z
        .array(
          z.object({
            text: z.string(),
            hashtags: z.array(z.string()).optional(),
            mentions: z.array(z.string()).optional(),
          }),
        )
        .min(2),
      visibility: visibilitySchema,
    },
    withAuthGuard(async ({ posts, visibility }) => {
      try {
        const body: Record<string, unknown> = { posts };
        const vis = normalizeVisibility(visibility);
        if (vis) body.visibility = vis;

        const result = await api.post("/posts/thread", body);
        const resultObj = unwrapApiResponse<Record<string, unknown>>(result);
        const threadPosts = Array.isArray(resultObj.posts) ? resultObj.posts : [resultObj];
        const formatted = threadPosts.map((p: Record<string, unknown>) => formatPost(p)).join("\n\n---\n\n");
        return { content: [{ type: "text" as const, text: `Thread created (${threadPosts.length} posts).\n\n${formatted}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "get-post",
    "Get a single post by ID (uses public feed hydration when available).",
    { id: z.string().describe("The post ID") },
    async ({ id }) => {
      try {
        const result = await api.get(`/feed/item/${encodeURIComponent(id)}`);
        return { content: [{ type: "text" as const, text: formatPost(result as Record<string, unknown>) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  server.tool(
    "update-post",
    "Update an existing post (requires authorization).",
    {
      id: z.string(),
      text: z.string().optional(),
      visibility: visibilitySchema,
      hashtags: z.array(z.string()).optional(),
    },
    withAuthGuard(async ({ id, text, visibility, hashtags }) => {
      try {
        const body: Record<string, unknown> = {};
        if (text !== undefined) body.content = { text };
        const vis = normalizeVisibility(visibility);
        if (vis) body.visibility = vis;
        if (hashtags) body.hashtags = hashtags;

        const result = await api.put(`/posts/${encodeURIComponent(id)}`, body);
        const post = unwrapApiResponse(result);
        return { content: [{ type: "text" as const, text: `Post updated.\n\n${formatPost(post)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "delete-post",
    "Delete a post (requires authorization).",
    { id: z.string() },
    withAuthGuard(async ({ id }) => {
      try {
        await api.delete(`/posts/${encodeURIComponent(id)}`);
        return { content: [{ type: "text" as const, text: `Post ${id} deleted successfully.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "get-drafts",
    "Get your draft posts (requires authorization).",
    {
      limit: z.number().optional(),
      cursor: z.string().optional(),
    },
    withAuthGuard(async ({ limit, cursor }) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (limit) query.limit = limit;
        if (cursor) query.cursor = cursor;

        const result = await api.get("/posts/drafts", query);
        const resultObj = result as Record<string, unknown>;
        const posts = Array.isArray(resultObj.posts) ? resultObj.posts : [];
        if (posts.length === 0) {
          return { content: [{ type: "text" as const, text: "No drafts found." }] };
        }
        const formatted = posts.map((p: Record<string, unknown>) => formatPost(p)).join("\n\n---\n\n");
        return { content: [{ type: "text" as const, text: `Drafts (${posts.length}):\n\n${formatted}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "get-scheduled-posts",
    "Get your scheduled posts (requires authorization).",
    {
      limit: z.number().optional(),
      cursor: z.string().optional(),
    },
    withAuthGuard(async ({ limit, cursor }) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (limit) query.limit = limit;
        if (cursor) query.cursor = cursor;

        const result = await api.get("/posts/scheduled", query);
        const resultObj = result as Record<string, unknown>;
        const posts = Array.isArray(resultObj.posts) ? resultObj.posts : [];
        if (posts.length === 0) {
          return { content: [{ type: "text" as const, text: "No scheduled posts found." }] };
        }
        const formatted = posts.map((p: Record<string, unknown>) => formatPost(p)).join("\n\n---\n\n");
        return { content: [{ type: "text" as const, text: `Scheduled posts (${posts.length}):\n\n${formatted}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );
}
