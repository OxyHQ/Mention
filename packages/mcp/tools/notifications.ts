import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { withAuthGuard } from "../lib/auth-guard.js";
import { formatNotification } from "../lib/formatters.js";

export function registerNotificationsTools(server: McpServer): void {
  server.tool(
    "get-notifications",
    "Get your notifications (requires authorization).",
    {
      limit: z.number().optional(),
      cursor: z.string().optional(),
    },
    withAuthGuard(async ({ limit, cursor }) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (limit) query.limit = limit;
        if (cursor) query.cursor = cursor;

        const result = await api.get("/notifications", query);
        const resultObj = result as Record<string, unknown>;
        const notifications = Array.isArray(resultObj.notifications) ? resultObj.notifications : [];
        const unreadCount = typeof resultObj.unreadCount === "number" ? resultObj.unreadCount : 0;

        if (notifications.length === 0) {
          return { content: [{ type: "text" as const, text: `No notifications. (${unreadCount} unread)` }] };
        }

        const formatted = notifications.map((n: Record<string, unknown>) => formatNotification(n)).join("\n\n");
        return {
          content: [{
            type: "text" as const,
            text: `Notifications (${notifications.length}):\n\n${formatted}\n\nUnread: ${unreadCount}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "mark-notifications-read",
    "Mark all notifications as read (requires authorization).",
    {},
    withAuthGuard(async () => {
      try {
        await api.patch("/notifications/read-all");
        return { content: [{ type: "text" as const, text: "All notifications marked as read." }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "get-unread-count",
    "Get unread notification count (requires authorization).",
    {},
    withAuthGuard(async () => {
      try {
        const result = await api.get("/notifications/unread-count");
        const count = typeof (result as Record<string, unknown>).count === "number"
          ? (result as Record<string, unknown>).count
          : 0;
        return { content: [{ type: "text" as const, text: `Unread notifications: ${count}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );
}
