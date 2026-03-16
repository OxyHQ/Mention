import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { formatNotification } from "../lib/formatters.js";

export function registerNotificationsTools(server: McpServer): void {
  // ── get-notifications ────────────────────────────────────────
  server.tool(
    "get-notifications",
    "Get your notifications with unread count.",
    {
      limit: z.number().optional().describe("Number of notifications (default: 20, max: 50)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    async ({ limit, cursor }) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (limit) query.limit = limit;
        if (cursor) query.cursor = cursor;

        const result = await api.get("/notifications", query);
        const resultObj = result as Record<string, unknown>;
        const notifications = Array.isArray(resultObj.notifications) ? resultObj.notifications : [];
        const unreadCount = typeof resultObj.unreadCount === "number" ? resultObj.unreadCount : 0;
        const hasMore = resultObj.hasMore === true;
        const nextCursor = typeof resultObj.nextCursor === "string" ? resultObj.nextCursor : undefined;

        if (notifications.length === 0) {
          return { content: [{ type: "text" as const, text: `No notifications. (${unreadCount} unread)` }] };
        }

        const formatted = notifications.map((n: Record<string, unknown>) => formatNotification(n)).join("\n\n");
        const meta: string[] = [`Unread: ${unreadCount}`];
        if (hasMore) meta.push(`More available (cursor: ${nextCursor || "?"})`);

        return { content: [{ type: "text" as const, text: `Notifications (${notifications.length}):\n\n${formatted}\n\n${meta.join(" | ")}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── mark-notifications-read ──────────────────────────────────
  server.tool(
    "mark-notifications-read",
    "Mark all notifications as read.",
    {},
    async () => {
      try {
        await api.patch("/notifications/read-all");
        return { content: [{ type: "text" as const, text: "All notifications marked as read." }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── get-unread-count ─────────────────────────────────────────
  server.tool(
    "get-unread-count",
    "Get the number of unread notifications.",
    {},
    async () => {
      try {
        const result = await api.get("/notifications/unread-count");
        const count = typeof (result as Record<string, unknown>).count === "number"
          ? (result as Record<string, unknown>).count
          : 0;
        return { content: [{ type: "text" as const, text: `Unread notifications: ${count}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );
}
