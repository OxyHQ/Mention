import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { withAuthGuard } from "../lib/auth-guard.js";

/**
 * Format a starter pack — the raw pack doc (create/update/member writes) or the
 * hydrated detail shape (`GET /starter-packs/:id`, which adds `members`). Mirrors
 * the fields the backend returns: `name`, `_id`, `memberCount` (falls back to the
 * length of `memberOxyUserIds`), `description`, and any hydrated `members`.
 */
function formatStarterPack(pack: Record<string, unknown>): string {
  const id = pack._id ?? pack.id ?? "unknown";
  const name = pack.name || "Untitled pack";
  const description = pack.description || "";
  const members = Array.isArray(pack.members) ? (pack.members as Record<string, unknown>[]) : [];
  const memberOxyUserIds = Array.isArray(pack.memberOxyUserIds) ? (pack.memberOxyUserIds as unknown[]) : [];
  const memberCount = pack.memberCount ?? (members.length || memberOxyUserIds.length);

  const lines = [
    `Starter pack: ${name}`,
    `ID: ${id}`,
    `Members: ${memberCount}`,
  ];
  if (description) lines.push(`Description: ${description}`);

  if (members.length > 0) {
    lines.push("", "Members:");
    for (const m of members.slice(0, 20)) {
      const nameObj = m.name && typeof m.name === "object" ? (m.name as Record<string, unknown>) : undefined;
      const handle = m.username || m.handle || m.id || "unknown";
      const dn = nameObj?.displayName || m.displayName || "";
      lines.push(`  @${handle}${dn ? ` (${dn})` : ""}`);
    }
    if (members.length > 20) {
      lines.push(`  … and ${members.length - 20} more`);
    }
  }

  return lines.join("\n");
}

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
        return { content: [{ type: "text" as const, text: formatStarterPack(result as Record<string, unknown>) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  server.tool(
    "get-starter-packs",
    "List starter packs (public). Pass mine=true for your own, userId to scope to an owner, or search to filter by name/description.",
    {
      mine: z.boolean().optional(),
      userId: z.string().optional(),
      search: z.string().optional(),
      limit: z.number().optional(),
    },
    async ({ mine, userId, search, limit }) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (mine) query.mine = true;
        if (userId) query.userId = userId;
        if (search) query.search = search;
        if (limit) query.limit = limit;

        const result = await api.get("/starter-packs", query);
        const items = Array.isArray((result as Record<string, unknown>).items)
          ? ((result as Record<string, unknown>).items as Record<string, unknown>[])
          : [];
        if (items.length === 0) {
          return { content: [{ type: "text" as const, text: "No starter packs found." }] };
        }
        const lines = items.map((pack) => {
          const packId = pack._id ?? "unknown";
          const name = pack.name || "Untitled pack";
          const memberCount = pack.memberCount ?? 0;
          const description = pack.description ? ` — ${pack.description}` : "";
          return `[${packId}] ${name} (${memberCount} members)${description}`;
        });
        return { content: [{ type: "text" as const, text: `Starter packs (${items.length}):\n\n${lines.join("\n")}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  server.tool(
    "create-starter-pack",
    "Create a starter pack (requires authorization). Members are Oxy user IDs (not handles), max 150.",
    {
      name: z.string(),
      description: z.string().optional(),
      memberUserIds: z.array(z.string()).optional(),
    },
    withAuthGuard(async ({ name, description, memberUserIds }) => {
      try {
        const body: Record<string, unknown> = { name };
        if (description !== undefined) body.description = description;
        if (memberUserIds) body.memberOxyUserIds = memberUserIds;

        const result = await api.post("/starter-packs", body);
        return { content: [{ type: "text" as const, text: `Starter pack created.\n\n${formatStarterPack(result as Record<string, unknown>)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "update-starter-pack",
    "Update a starter pack (requires authorization). memberUserIds replaces the full member list (Oxy user IDs, max 150).",
    {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      memberUserIds: z.array(z.string()).optional(),
    },
    withAuthGuard(async ({ id, name, description, memberUserIds }) => {
      try {
        const body: Record<string, unknown> = {};
        if (name !== undefined) body.name = name;
        if (description !== undefined) body.description = description;
        if (memberUserIds) body.memberOxyUserIds = memberUserIds;

        const result = await api.put(`/starter-packs/${encodeURIComponent(id)}`, body);
        return { content: [{ type: "text" as const, text: `Starter pack updated.\n\n${formatStarterPack(result as Record<string, unknown>)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "delete-starter-pack",
    "Delete a starter pack (requires authorization).",
    { id: z.string() },
    withAuthGuard(async ({ id }) => {
      try {
        await api.delete(`/starter-packs/${encodeURIComponent(id)}`);
        return { content: [{ type: "text" as const, text: `Starter pack ${id} deleted.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "add-starter-pack-members",
    "Add members to a starter pack (requires authorization). memberUserIds are Oxy user IDs; total capped at 150.",
    {
      id: z.string(),
      memberUserIds: z.array(z.string()),
    },
    withAuthGuard(async ({ id, memberUserIds }) => {
      try {
        const result = await api.post(`/starter-packs/${encodeURIComponent(id)}/members`, { userIds: memberUserIds });
        return { content: [{ type: "text" as const, text: `Members added.\n\n${formatStarterPack(result as Record<string, unknown>)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "remove-starter-pack-members",
    "Remove members from a starter pack (requires authorization). memberUserIds are Oxy user IDs.",
    {
      id: z.string(),
      memberUserIds: z.array(z.string()),
    },
    withAuthGuard(async ({ id, memberUserIds }) => {
      try {
        const result = await api.delete(`/starter-packs/${encodeURIComponent(id)}/members`, { userIds: memberUserIds });
        return { content: [{ type: "text" as const, text: `Members removed.\n\n${formatStarterPack(result as Record<string, unknown>)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "use-starter-pack",
    "Record use of a starter pack and return its member Oxy user IDs (requires authorization). Does NOT auto-follow — follow the returned members yourself with follow-user.",
    { id: z.string().describe("Starter pack ID") },
    withAuthGuard(async ({ id }) => {
      try {
        const result = await api.post(`/starter-packs/${encodeURIComponent(id)}/use`);
        const obj = result as Record<string, unknown>;
        const memberIds = Array.isArray(obj.memberOxyUserIds) ? (obj.memberOxyUserIds as unknown[]) : [];
        const useCount = obj.useCount ?? 0;
        const already = obj.alreadyUsed === true ? " (already used earlier — count unchanged)" : "";

        const lines = [
          `Starter pack ${id} used${already}. Use count: ${useCount}.`,
          `Members (${memberIds.length}) — follow each with follow-user:`,
        ];
        if (memberIds.length > 0) {
          for (const mid of memberIds) lines.push(`  ${String(mid)}`);
        } else {
          lines.push("  (no members)");
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );
}
