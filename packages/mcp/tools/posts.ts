import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { normalizeVisibility, unwrapApiResponse } from "../lib/api-response.js";
import { withAuthGuard } from "../lib/auth-guard.js";
import { formatPost } from "../lib/formatters.js";
import { buildPostContentPayload, resolveMediaInputs } from "../lib/resolve-media.js";
import {
  articleInputSchema,
  attachmentDescriptorSchema,
  eventInputSchema,
  locationInputSchema,
  mediaInputSchema,
  pollInputSchema,
  podcastInputSchema,
  postMetadataSchema,
  replyPermissionSchema,
  roomInputSchema,
  sourceLinkSchema,
  threadPostSchema,
  visibilitySchema,
} from "../lib/post-content-schema.js";

const createPostFields = {
  text: z.string().optional().describe("The text content of the post"),
  media: z.array(mediaInputSchema).max(10).optional().describe("Images/videos — fileId, url, or base64"),
  poll: pollInputSchema.optional(),
  location: locationInputSchema.optional(),
  sources: z.array(sourceLinkSchema).max(5).optional(),
  article: articleInputSchema.optional(),
  event: eventInputSchema.optional(),
  room: roomInputSchema.optional(),
  podcast: podcastInputSchema.optional(),
  attachments: z.array(attachmentDescriptorSchema).optional(),
  visibility: visibilitySchema,
  hashtags: z.array(z.string()).optional().describe("Hashtags (without # prefix)"),
  mentions: z.array(z.string()).optional().describe("User IDs to mention"),
  parentPostId: z.string().optional().describe("ID of the post to reply to"),
  status: z.enum(["published", "draft", "scheduled"]).optional(),
  scheduledFor: z.string().optional().describe("ISO date for scheduled posts"),
  replyPermission: replyPermissionSchema,
  reviewReplies: z.boolean().optional(),
  quotesDisabled: z.boolean().optional(),
  collaboratorIds: z.array(z.string()).optional(),
  metadata: postMetadataSchema.optional(),
};

export function registerPostsTools(server: McpServer): void {
  server.tool(
    "create-post",
    "Create a new post on Mention with optional media, poll, article, event, room, podcast, location, and sources (requires authorization).",
    createPostFields,
    withAuthGuard(async (args) => {
      try {
        const content = await buildPostContentPayload({
          ...(args.text !== undefined ? { text: args.text } : {}),
          ...(args.media ? { media: args.media } : {}),
          ...(args.poll ? { poll: args.poll } : {}),
          ...(args.location ? { location: args.location } : {}),
          ...(args.sources ? { sources: args.sources } : {}),
          ...(args.article ? { article: args.article } : {}),
          ...(args.event ? { event: args.event } : {}),
          ...(args.room ? { room: args.room } : {}),
          ...(args.podcast ? { podcast: args.podcast } : {}),
          ...(args.attachments ? { attachments: args.attachments } : {}),
        });

        const body: Record<string, unknown> = { content };
        const vis = normalizeVisibility(args.visibility);
        if (vis) body.visibility = vis;
        if (args.hashtags) body.hashtags = args.hashtags;
        if (args.mentions) body.mentions = args.mentions;
        if (args.parentPostId) body.parentPostId = args.parentPostId;
        if (args.status) body.status = args.status;
        if (args.scheduledFor) body.scheduledFor = args.scheduledFor;
        if (args.replyPermission) body.replyPermission = args.replyPermission;
        if (args.reviewReplies !== undefined) body.reviewReplies = args.reviewReplies;
        if (args.quotesDisabled !== undefined) body.quotesDisabled = args.quotesDisabled;
        if (args.collaboratorIds) body.collaboratorIds = args.collaboratorIds;
        if (args.metadata) body.metadata = args.metadata;

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
    "Create a multi-post thread with full attachment support per post (requires authorization).",
    {
      posts: z.array(threadPostSchema).min(2),
      mode: z.enum(["thread", "beast"]).optional().describe("thread = linked chain (default); beast = separate posts"),
    },
    withAuthGuard(async ({ posts, mode }) => {
      try {
        const wirePosts = await Promise.all(
          posts.map(async (post) => {
            const content = await buildPostContentPayload(post.content);
            const entry: Record<string, unknown> = { content };
            const vis = normalizeVisibility(post.visibility);
            if (vis) entry.visibility = vis;
            if (post.hashtags) entry.hashtags = post.hashtags;
            if (post.mentions) entry.mentions = post.mentions;
            if (post.replyPermission) entry.replyPermission = post.replyPermission;
            if (post.reviewReplies !== undefined) entry.reviewReplies = post.reviewReplies;
            if (post.quotesDisabled !== undefined) entry.quotesDisabled = post.quotesDisabled;
            if (post.metadata) entry.metadata = post.metadata;
            return entry;
          }),
        );

        const result = await api.post("/posts/thread", {
          mode: mode ?? "thread",
          posts: wirePosts,
        });
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
    "Update an existing post including media and sources (requires authorization).",
    {
      id: z.string(),
      text: z.string().optional(),
      media: z.array(mediaInputSchema).max(10).optional(),
      sources: z.array(sourceLinkSchema).max(5).optional(),
      visibility: visibilitySchema,
      hashtags: z.array(z.string()).optional(),
    },
    withAuthGuard(async ({ id, text, media, sources, visibility, hashtags }) => {
      try {
        const body: Record<string, unknown> = {};
        const content: Record<string, unknown> = {};
        if (text !== undefined) content.text = text;
        if (media !== undefined) {
          content.media = await resolveMediaInputs(media);
        }
        if (sources) content.sources = sources;
        if (Object.keys(content).length > 0) body.content = content;

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
