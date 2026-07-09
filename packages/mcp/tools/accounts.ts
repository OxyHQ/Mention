import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { withAuthGuard } from "../lib/auth-guard.js";

export function registerAccountTools(server: McpServer): void {
  server.tool(
    "whoami",
    "Return the Mention account currently active for this MCP connector (handle, display name, user id). Call before posting when multiple accounts are linked.",
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
    "List all Mention accounts linked to this MCP connector.",
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
          return { content: [{ type: "text" as const, text: "No linked accounts found." }] };
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
              text: `Linked accounts (${result.accounts.length}):\n${lines.join("\n")}`,
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
    "Get a browser link to add another Mention account to this MCP connector. Open the URL, sign in as the other account, and approve linking.",
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
    "Switch the active Mention account for this MCP connector. Use whoami to confirm before posting.",
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
