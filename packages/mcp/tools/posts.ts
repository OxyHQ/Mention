import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { formatPost } from "../lib/formatters.js";

export function registerPostsTools(server: McpServer): void {
  // ── create-post ──────────────────────────────────────────────
  server.tool(
    "create-post",
    "Create a new post on Mention. Supports text, media, hashtags, mentions, sources, location, scheduling, and visibility settings.",
    {
      text: z.string().describe("The text content of the post"),
      visibility: z
        .enum(["public", "private", "followers", "mentioned"])
        .optional()
        .describe("Post visibility (default: public)"),
      hashtags: z
        .array(z.string())
        .optional()
        .describe("Hashtags for the post (without # prefix)"),
      mentions: z
        .array(z.string())
        .optional()
        .describe("User IDs to mention in the post"),
      parentPostId: z
        .string()
        .optional()
        .describe("ID of the post to reply to"),
      sources: z
        .array(z.object({ url: z.string(), title: z.string().optional() }))
        .optional()
        .describe("External sources cited in the post"),
      status: z
        .enum(["published", "draft", "scheduled"])
        .optional()
        .describe("Post status (default: published)"),
      scheduledFor: z
        .string()
        .optional()
        .describe("ISO date string for when to publish a scheduled post"),
      language: z.string().optional().describe("Language code (default: en)"),
      replyPermission: z
        .array(z.enum(["anyone", "followers", "following", "mentioned", "nobody"]))
        .optional()
        .describe("Who can reply to this post"),
    },
    async ({ text, visibility, hashtags, mentions, parentPostId, sources, status, scheduledFor, language, replyPermission }) => {
      try {
        const body: Record<string, unknown> = {
          content: { text },
        };
        if (visibility) body.visibility = visibility;
        if (hashtags) body.hashtags = hashtags;
        if (mentions) body.mentions = mentions;
        if (parentPostId) body.parentPostId = parentPostId;
        if (sources) body.sources = sources;
        if (status) body.status = status;
        if (scheduledFor) body.scheduledFor = scheduledFor;
        if (language) body.language = language;
        if (replyPermission) body.replyPermission = replyPermission;

        const result = await api.post("/posts", body);
        return { content: [{ type: "text" as const, text: `Post created successfully.\n\n${formatPost(result as Record<string, unknown>)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── create-thread ────────────────────────────────────────────
  server.tool(
    "create-thread",
    "Create a multi-post thread on Mention.",
    {
      posts: z
        .array(
          z.object({
            text: z.string().describe("Text content for this thread post"),
            hashtags: z.array(z.string()).optional(),
            mentions: z.array(z.string()).optional(),
          }),
        )
        .min(2)
        .describe("Array of posts to create as a thread (minimum 2)"),
      visibility: z
        .enum(["public", "private", "followers", "mentioned"])
        .optional()
        .describe("Visibility for the entire thread"),
    },
    async ({ posts, visibility }) => {
      try {
        const body: Record<string, unknown> = { posts };
        if (visibility) body.visibility = visibility;

        const result = await api.post("/posts/thread", body);
        const resultObj = result as Record<string, unknown>;
        const threadPosts = Array.isArray(resultObj.posts) ? resultObj.posts : [resultObj];
        const formatted = threadPosts.map((p: Record<string, unknown>) => formatPost(p)).join("\n\n---\n\n");
        return { content: [{ type: "text" as const, text: `Thread created (${threadPosts.length} posts).\n\n${formatted}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── get-post ─────────────────────────────────────────────────
  server.tool(
    "get-post",
    "Get a single post by its ID.",
    {
      id: z.string().describe("The post ID"),
    },
    async ({ id }) => {
      try {
        const result = await api.get(`/posts/${encodeURIComponent(id)}`);
        return { content: [{ type: "text" as const, text: formatPost(result as Record<string, unknown>) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── update-post ──────────────────────────────────────────────
  server.tool(
    "update-post",
    "Update an existing post's content or settings.",
    {
      id: z.string().describe("The post ID to update"),
      text: z.string().optional().describe("New text content"),
      visibility: z
        .enum(["public", "private", "followers", "mentioned"])
        .optional()
        .describe("New visibility setting"),
      hashtags: z.array(z.string()).optional().describe("Updated hashtags"),
    },
    async ({ id, text, visibility, hashtags }) => {
      try {
        const body: Record<string, unknown> = {};
        if (text !== undefined) body.content = { text };
        if (visibility) body.visibility = visibility;
        if (hashtags) body.hashtags = hashtags;

        const result = await api.put(`/posts/${encodeURIComponent(id)}`, body);
        return { content: [{ type: "text" as const, text: `Post updated.\n\n${formatPost(result as Record<string, unknown>)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── delete-post ──────────────────────────────────────────────
  server.tool(
    "delete-post",
    "Delete a post by its ID.",
    {
      id: z.string().describe("The post ID to delete"),
    },
    async ({ id }) => {
      try {
        await api.delete(`/posts/${encodeURIComponent(id)}`);
        return { content: [{ type: "text" as const, text: `Post ${id} deleted successfully.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── get-drafts ───────────────────────────────────────────────
  server.tool(
    "get-drafts",
    "Get your draft posts.",
    {
      limit: z.number().optional().describe("Number of drafts to return (default: 20)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    async ({ limit, cursor }) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (limit) query.limit = limit;
        if (cursor) query.cursor = cursor;

        const result = await api.get("/posts/drafts", query);
        const resultObj = result as Record<string, unknown>;
        const posts = Array.isArray(resultObj.posts) ? resultObj.posts : Array.isArray(result) ? result : [];
        if (posts.length === 0) {
          return { content: [{ type: "text" as const, text: "No drafts found." }] };
        }
        const formatted = posts.map((p: Record<string, unknown>) => formatPost(p)).join("\n\n---\n\n");
        return { content: [{ type: "text" as const, text: `Drafts (${posts.length}):\n\n${formatted}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── get-scheduled-posts ──────────────────────────────────────
  server.tool(
    "get-scheduled-posts",
    "Get your scheduled posts.",
    {
      limit: z.number().optional().describe("Number of posts to return (default: 20)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    async ({ limit, cursor }) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (limit) query.limit = limit;
        if (cursor) query.cursor = cursor;

        const result = await api.get("/posts/scheduled", query);
        const resultObj = result as Record<string, unknown>;
        const posts = Array.isArray(resultObj.posts) ? resultObj.posts : Array.isArray(result) ? result : [];
        if (posts.length === 0) {
          return { content: [{ type: "text" as const, text: "No scheduled posts found." }] };
        }
        const formatted = posts.map((p: Record<string, unknown>) => formatPost(p)).join("\n\n---\n\n");
        return { content: [{ type: "text" as const, text: `Scheduled posts (${posts.length}):\n\n${formatted}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );
}
