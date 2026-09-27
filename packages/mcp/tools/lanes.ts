import { LANE_DISPLAY_MODES, MAX_LANE_NAME_LENGTH, type Lane, type LaneSummary, type MutedLane } from "@mention/shared-types/lane";
import { z } from "zod/v4";
import { api, formatApiError } from "../lib/api-client.js";
import { unwrapData } from "../lib/api-response.js";
import { withAuthGuard } from "../lib/auth-guard.js";
import type { MentionToolRegistrar } from "../lib/tool-registry.js";

const displayModeSchema = z
  .enum(LANE_DISPLAY_MODES)
  .describe(
    "mixed = posts also show on the main profile tab (default); tab = only in the lane's own profile tab; " +
    "hidden = off the profile entirely. Every mode still reaches followers' feeds.",
  );

function formatLane(lane: Lane | LaneSummary): string {
  const count = "postCount" in lane && lane.postCount !== undefined ? ` · ${lane.postCount} posts` : "";
  return `${lane.name} (id: ${lane.id}) · ${lane.displayMode}${count}`;
}

export function registerLanesTools(server: MentionToolRegistrar): void {
  server.tool(
    "list-lanes",
    "List the lanes of the active account, with how many posts each holds (requires authorization). Use a lane's id as laneId on create-post.",
    {},
    withAuthGuard(async () => {
      try {
        const lanes = unwrapData<Lane[]>(await api.get("/lanes/mine"));
        if (!Array.isArray(lanes) || lanes.length === 0) {
          return { content: [{ type: "text" as const, text: "No lanes yet. Create one with create-lane." }] };
        }
        const formatted = lanes.map(formatLane).join("\n");
        return { content: [{ type: "text" as const, text: `Lanes (${lanes.length}):\n\n${formatted}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "create-lane",
    "Create a lane on the active account: a named track for a kind of post, such as release notes (requires authorization).",
    {
      name: z.string().min(1).max(MAX_LANE_NAME_LENGTH).describe("Lane name, unique per account"),
      displayMode: displayModeSchema.optional(),
    },
    withAuthGuard(async ({ name, displayMode }) => {
      try {
        const body: Record<string, unknown> = { name };
        if (displayMode) body.displayMode = displayMode;
        const lane = unwrapData<Lane>(await api.post("/lanes", body));
        return { content: [{ type: "text" as const, text: `Lane created.\n\n${formatLane(lane)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "update-lane",
    "Rename one of your lanes or change where its posts show (requires authorization).",
    {
      id: z.string().describe("Lane ID"),
      name: z.string().min(1).max(MAX_LANE_NAME_LENGTH).optional(),
      displayMode: displayModeSchema.optional(),
    },
    withAuthGuard(async ({ id, name, displayMode }) => {
      try {
        const body: Record<string, unknown> = {};
        if (name) body.name = name;
        if (displayMode) body.displayMode = displayMode;
        const lane = unwrapData<Lane>(await api.patch(`/lanes/${encodeURIComponent(id)}`, body));
        return { content: [{ type: "text" as const, text: `Lane updated.\n\n${formatLane(lane)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "get-muted-lanes",
    "List the lanes of other accounts you have muted (requires authorization).",
    {},
    withAuthGuard(async () => {
      try {
        const muted = unwrapData<MutedLane[]>(await api.get("/lanes/muted"));
        if (!Array.isArray(muted) || muted.length === 0) {
          return { content: [{ type: "text" as const, text: "No muted lanes." }] };
        }
        const lines = muted.map((entry) => {
          const owner = entry.owner?.username ? `@${entry.owner.username}` : entry.owner?.id ?? "unknown";
          return `${formatLane(entry.lane)} · by ${owner}`;
        });
        return { content: [{ type: "text" as const, text: `Muted lanes (${muted.length}):\n\n${lines.join("\n")}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "delete-lane",
    "Delete one of your lanes (requires authorization). Its posts are not deleted: they are taken out of the lane and stay on your profile. Cannot be undone; a new lane starts empty.",
    { id: z.string().describe("Lane ID") },
    withAuthGuard(async ({ id }) => {
      try {
        await api.delete(`/lanes/${encodeURIComponent(id)}`);
        return { content: [{ type: "text" as const, text: `Lane ${id} deleted. Its posts are no longer filed in a lane.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "mute-lane",
    "Mute one lane of another publisher, so its posts stop reaching your Following feed while the rest of their posts still do (requires authorization). Undo with unmute-lane.",
    { id: z.string().describe("Lane ID of another account's lane") },
    withAuthGuard(async ({ id }) => {
      try {
        await api.post(`/lanes/${encodeURIComponent(id)}/mute`);
        return { content: [{ type: "text" as const, text: `Lane ${id} muted.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "unmute-lane",
    "Unmute a lane you muted (requires authorization).",
    { id: z.string().describe("Lane ID") },
    withAuthGuard(async ({ id }) => {
      try {
        await api.delete(`/lanes/${encodeURIComponent(id)}/mute`);
        return { content: [{ type: "text" as const, text: `Lane ${id} unmuted.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );
}
