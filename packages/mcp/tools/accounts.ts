import { z } from "zod/v4";
import { api, formatApiError } from "../lib/api-client.js";
import { withAuthGuard } from "../lib/auth-guard.js";
import type { MentionToolRegistrar } from "../lib/tool-registry.js";

export function registerAccountTools(server: MentionToolRegistrar): void {
  server.tool(
    "whoami",
    "Return the Mention account this connection is acting as right now (handle, display name, user id). Call before publishing.",
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
        lines.push(
          result.isPrimary === true
            ? "This is the account the connection was authorized for."
            : "This account was connected later; the connection is acting as it.",
        );
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "list-accounts",
    "List every Mention account this connection can act as, marking the active one. Use link-account to add more.",
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
        const hint = result.accounts.length > 1
          ? "Use switch-account to act as another one."
          : "Use link-account to connect another account to this connection.";
        return {
          content: [
            {
              type: "text" as const,
              text: `Accounts on this connection (${result.accounts.length}):\n${lines.join("\n")}\n\n${hint}`,
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
    "Generate a single-use Oxy link the user opens to connect another Mention account to this connection.",
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
                "Open this link and approve it while signed in as the account you want to add:",
                result.linkUrl,
                "",
                `It can be used once and expires in ${Math.round(expiry / 60)} minutes.`,
                "Once approved, call switch-account to act as that account.",
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
    "Act as another account already connected to this connection. Call list-accounts to see which ones are available.",
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
