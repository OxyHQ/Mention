import { z } from "zod/v4";
import { api, formatApiError } from "../lib/api-client.js";
import { withAuthGuard } from "../lib/auth-guard.js";
import type { MentionToolRegistrar } from "../lib/tool-registry.js";

export function registerAccountTools(server: MentionToolRegistrar): void {
  server.tool(
    "whoami",
    "Return the exact Mention account bound to this MCP connection (handle, display name, user id). Call before publishing.",
    {},
    withAuthGuard(async () => {
      try {
        const result = await api.get<{
          oxyUserId: string;
          handle: string;
          displayName: string;
          isPrimary?: boolean;
        }>("/mcp/bundles/me");
        const lines = [
          `Active account: @${result.handle}`,
          `Display name: ${result.displayName}`,
          `User ID: ${result.oxyUserId}`,
        ];
        if (result.isPrimary === true) {
          lines.push("This is the primary account (the one Claude authorized).");
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "list-accounts",
    "List the Mention account bound to this connection. Transitional legacy bundles may return their linked accounts.",
    {},
    withAuthGuard(async () => {
      try {
        const result = await api.get<{
          accounts: Array<{
            oxyUserId: string;
            handle: string;
            displayName: string;
            isPrimary: boolean;
            isActive: boolean;
          }>;
        }>("/mcp/bundles/accounts");
        if (!result.accounts?.length) {
          return { content: [{ type: "text" as const, text: "No bound account found." }] };
        }
        const lines = result.accounts.map((account) => {
          const flags = [
            account.isActive ? "active" : null,
            account.isPrimary ? "primary" : null,
          ].filter(Boolean);
          const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
          return `@${account.handle} — ${account.displayName}${suffix}`;
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Accounts visible to this connection (${result.accounts.length}):\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "link-account",
    "Legacy transition only. Central Oxy connections require a separate authorization for every Mention account.",
    {},
    withAuthGuard(async () => {
      try {
        const result = await api.post<{ linkUrl: string; expiresInSeconds?: number }>(
          "/mcp/bundles/link-token",
        );
        const expiry = result.expiresInSeconds ?? 900;
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "Open this link in your browser to link another Mention account:",
                result.linkUrl,
                "",
                `The link expires in ${Math.round(expiry / 60)} minutes.`,
                "After linking, use switch-account before posting as that account.",
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "switch-account",
    "Legacy transition only. Central Oxy connections are fixed to the account selected during authorization.",
    {
      handle: z
        .string()
        .describe("Mention handle to switch to (with or without leading @)"),
    },
    withAuthGuard(async ({ handle }) => {
      try {
        const result = await api.post<{
          handle: string;
          displayName: string;
          message: string;
        }>("/mcp/bundles/active", { handle });
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.message}\nActive account: @${result.handle} (${result.displayName})`,
            },
          ],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );
}
