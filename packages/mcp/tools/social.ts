import { z } from "zod/v4";
import { api, formatApiError } from "../lib/api-client.js";
import { withAuthGuard } from "../lib/auth-guard.js";
import type { MentionToolRegistrar } from "../lib/tool-registry.js";

export function registerSocialTools(server: MentionToolRegistrar): void {
  server.tool(
    "follow-user",
    "Follow a Mention user or a federated actor (requires authorization). Pass actorUri: a Mention username (`nate`, `@nate`, `nate@mention.earth`), an Oxy user ID, or a remote ActivityPub URI / acct handle (user@domain.com) / atproto handle.",
    {
      actorUri: z.string().describe("Mention username, Oxy user ID, or remote actor URI / acct handle to follow"),
    },
    withAuthGuard(async ({ actorUri }) => {
      try {
        const result = await api.post("/federation/follow", { actorUri });
        const obj = result as Record<string, unknown>;
        const pending = obj.pending === true ? " (pending approval)" : "";
        const text = typeof obj.oxyUserId === "string"
          ? `${obj.changed === false ? "Already following" : "Now following"} ${actorUri}.`
          : `Follow request sent for ${actorUri}${pending}.`;
        return {
          content: [{
            type: "text" as const,
            text,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "unfollow-user",
    "Unfollow a Mention user or a federated actor (requires authorization). Accepts the same forms as follow-user.",
    {
      actorUri: z.string().describe("Mention username, Oxy user ID, or remote actor URI / acct handle to unfollow"),
    },
    withAuthGuard(async ({ actorUri }) => {
      try {
        await api.post("/federation/unfollow", { actorUri });
        return { content: [{ type: "text" as const, text: `Unfollowed ${actorUri}.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "get-recommendations",
    "Get who-to-follow account recommendations (personalized when authorized).",
    {
      limit: z.number().optional(),
      excludeTypes: z.string().optional(),
      offset: z.number().optional(),
    },
    async ({ limit, excludeTypes, offset }) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (limit) query.limit = limit;
        if (excludeTypes) query.excludeTypes = excludeTypes;
        if (offset) query.offset = offset;

        const result = await api.get("/recommendations", query);
        const recommendations = Array.isArray((result as Record<string, unknown>).recommendations)
          ? ((result as Record<string, unknown>).recommendations as Record<string, unknown>[])
          : [];
        if (recommendations.length === 0) {
          return { content: [{ type: "text" as const, text: "No recommendations available." }] };
        }
        const lines = recommendations.map((profile) => {
          const nameObj = profile.name && typeof profile.name === "object" ? (profile.name as Record<string, unknown>) : undefined;
          const displayName = typeof nameObj?.displayName === "string" ? nameObj.displayName : "";
          const username = typeof profile.username === "string" ? profile.username : "";
          const label = username ? `@${username}` : displayName || "unknown";
          const suffix = username && displayName ? ` (${displayName})` : "";
          const countObj = profile._count && typeof profile._count === "object" ? (profile._count as Record<string, unknown>) : undefined;
          const followers = typeof countObj?.followers === "number" ? countObj.followers : 0;
          const mutual = typeof profile.mutualCount === "number" ? profile.mutualCount : 0;
          const badges: string[] = [];
          if (profile.verified === true) badges.push("verified");
          if (profile.isFederated === true) badges.push("federated");
          const badgeText = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
          return `${label}${suffix} — ${followers} followers, ${mutual} mutual${badgeText}`;
        });
        return { content: [{ type: "text" as const, text: `Recommendations (${recommendations.length}):\n\n${lines.join("\n")}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );
}
