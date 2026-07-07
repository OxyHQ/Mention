import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";

export function registerStarterPackTools(server: McpServer): void {
  server.tool(
    "get-starter-pack",
    "Get a starter pack by ID with member list (public).",
    {
      id: z.string().describe("Starter pack ID"),
    },
    async ({ id }) => {
      try {
        const result = await api.get(`/starter-packs/${encodeURIComponent(id)}`);
        const pack = result as Record<string, unknown>;
        const name = pack.name || "Untitled pack";
        const description = pack.description || "";
        const members = Array.isArray(pack.members) ? pack.members : [];
        const memberCount = pack.memberCount ?? members.length;

        const lines = [
          `Starter pack: ${name}`,
          `ID: ${id}`,
          `Members: ${memberCount}`,
        ];
        if (description) lines.push(`Description: ${description}`);

        if (members.length > 0) {
          lines.push("", "Members:");
          for (const m of members.slice(0, 20) as Record<string, unknown>[]) {
            const handle = m.username || m.handle || m.id || "unknown";
            const dn = m.displayName || "";
            lines.push(`  @${handle}${dn ? ` (${dn})` : ""}`);
          }
          if (members.length > 20) {
            lines.push(`  … and ${members.length - 20} more`);
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );
}
