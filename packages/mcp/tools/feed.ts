import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { formatFeed } from "../lib/formatters.js";

type FeedQuery = Record<string, string | number | boolean | undefined>;

function paginationParams(limit?: number, cursor?: string): FeedQuery {
  const q: FeedQuery = {};
  if (limit) q.limit = limit;
  if (cursor) q.cursor = cursor;
  return q;
}

export function registerFeedTools(server: McpServer): void {
  // ── get-feed ─────────────────────────────────────────────────
  server.tool(
    "get-feed",
    "Get the main chronological feed.",
    {
      limit: z.number().optional().describe("Number of posts (default: 20, max: 100)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response"),
    },
    async ({ limit, cursor }) => {
      try {
        const result = await api.get("/feed/feed", paginationParams(limit, cursor));
        return { content: [{ type: "text" as const, text: formatFeed(result as Record<string, unknown>) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── get-for-you-feed ─────────────────────────────────────────
  server.tool(
    "get-for-you-feed",
    "Get the personalized For You feed with recommended posts.",
    {
      limit: z.number().optional().describe("Number of posts (default: 20, max: 100)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    async ({ limit, cursor }) => {
      try {
        const result = await api.get("/feed/for-you", paginationParams(limit, cursor));
        return { content: [{ type: "text" as const, text: formatFeed(result as Record<string, unknown>) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── get-explore-feed ─────────────────────────────────────────
  server.tool(
    "get-explore-feed",
    "Get the explore/trending feed with popular posts.",
    {
      limit: z.number().optional().describe("Number of posts (default: 20, max: 100)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    async ({ limit, cursor }) => {
      try {
        const result = await api.get("/feed/explore", paginationParams(limit, cursor));
        return { content: [{ type: "text" as const, text: formatFeed(result as Record<string, unknown>) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── get-following-feed ───────────────────────────────────────
  server.tool(
    "get-following-feed",
    "Get posts from users you follow.",
    {
      limit: z.number().optional().describe("Number of posts (default: 20, max: 100)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    async ({ limit, cursor }) => {
      try {
        const result = await api.get("/feed/following", paginationParams(limit, cursor));
        return { content: [{ type: "text" as const, text: formatFeed(result as Record<string, unknown>) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── get-user-feed ────────────────────────────────────────────
  server.tool(
    "get-user-feed",
    "Get posts from a specific user's profile.",
    {
      userId: z.string().describe("The user ID whose posts to fetch"),
      limit: z.number().optional().describe("Number of posts (default: 20, max: 100)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    async ({ userId, limit, cursor }) => {
      try {
        const result = await api.get(`/feed/user/${encodeURIComponent(userId)}`, paginationParams(limit, cursor));
        return { content: [{ type: "text" as const, text: formatFeed(result as Record<string, unknown>) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── get-replies ──────────────────────────────────────────────
  server.tool(
    "get-replies",
    "Get replies to a specific post.",
    {
      parentId: z.string().describe("The post ID to get replies for"),
      limit: z.number().optional().describe("Number of replies (default: 20, max: 100)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    async ({ parentId, limit, cursor }) => {
      try {
        const result = await api.get(`/feed/replies/${encodeURIComponent(parentId)}`, paginationParams(limit, cursor));
        return { content: [{ type: "text" as const, text: formatFeed(result as Record<string, unknown>) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── get-feed-item ────────────────────────────────────────────
  server.tool(
    "get-feed-item",
    "Get a single feed item with full transformation (user profiles, engagement status).",
    {
      id: z.string().describe("The post ID"),
    },
    async ({ id }) => {
      try {
        const result = await api.get(`/feed/item/${encodeURIComponent(id)}`);
        return { content: [{ type: "text" as const, text: formatFeed({ posts: [result as Record<string, unknown>] }) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );
}
