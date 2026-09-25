import { LANE_DISPLAY_MODES, MAX_LANE_NAME_LENGTH, type Lane } from "@mention/shared-types/lane";
import { z } from "zod/v4";
import { api, formatApiError } from "../lib/api-client.js";
import { unwrapApiResponse } from "../lib/api-response.js";
import { withAuthGuard } from "../lib/auth-guard.js";
import type { MentionToolRegistrar } from "../lib/tool-registry.js";

const displayModeSchema = z
  .enum(LANE_DISPLAY_MODES)
  .describe(
    "mixed = posts also show on the main profile tab (default); tab = only in the lane's own profile tab; " +
    "hidden = off the profile entirely. Every mode still reaches followers' feeds.",
  );

/**
 * The lanes routes answer `{ data }` (with `success: true` only on a 201), so
 * the generic unwrap — which keys on `success` — would hand back the envelope
 * for every 200. Unwrap the `data` member whatever the status was.
 */
export function laneData<T>(raw: unknown): T {
  if (typeof raw === "object" && raw !== null && "data" in raw) {
    return (raw as { data: T }).data;
  }
  return unwrapApiResponse<T>(raw);
}

function formatLane(lane: Lane): string {
  const count = lane.postCount !== undefined ? ` · ${lane.postCount} posts` : "";
  return `${lane.name} (id: ${lane.id}) · ${lane.displayMode}${count}`;
}

export function registerLanesTools(server: MentionToolRegistrar): void {
  server.tool(
    "list-lanes",
    "List the lanes of the active account, with how many posts each holds (requires authorization). Use a lane's id as laneId on create-post.",
    {},
    withAuthGuard(async () => {
      try {
        const lanes = laneData<Lane[]>(await api.get("/lanes/mine"));
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
        const lane = laneData<Lane>(await api.post("/lanes", body));
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
        const lane = laneData<Lane>(await api.patch(`/lanes/${encodeURIComponent(id)}`, body));
        return { content: [{ type: "text" as const, text: `Lane updated.\n\n${formatLane(lane)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );
}
