import type { CatalogTool } from "@oxyhq/contracts";

export const MENTION_MCP_RESOURCE = "https://mcp.mention.earth";
export const MENTION_CAPABILITY_AUDIENCE = "mention-api";

/**
 * Existing Mention-issued HS256 connector tokens stop working at this instant.
 * This is intentionally a source-controlled deadline, not an environment flag
 * that can silently turn a short migration into permanent parallel auth.
 */
export const MENTION_LEGACY_MCP_AUTH_CUTOFF = "2026-10-02T00:00:00.000Z";
export const MENTION_LEGACY_MCP_AUTH_CUTOFF_MS = Date.parse(
  MENTION_LEGACY_MCP_AUTH_CUTOFF,
);

export type MentionToolPolicy = Pick<
  CatalogTool,
  | "capabilityPackage"
  | "requiredCapabilities"
  | "resourceTypes"
  | "effect"
  | "idempotency"
  | "rollback"
  | "exposure"
  | "limitKeys"
  | "invocation"
>;

const account = ["mention_account"];
const post = ["mention_account", "post"];

function read(
  path: string,
  capability: string,
  resourceTypes: string[] = post,
  limit = false,
): MentionToolPolicy {
  return {
    capabilityPackage: "read",
    requiredCapabilities: [capability],
    resourceTypes,
    effect: "read",
    idempotency: "none",
    rollback: "none",
    exposure: ["mcp"],
    limitKeys: limit ? [{ key: "limit", kind: "maximum_number" }] : [],
    invocation: { method: "GET", path },
  };
}

function effect(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  capabilityPackage: MentionToolPolicy["capabilityPackage"],
  capability: string,
  resourceTypes: string[],
  options: {
    idempotency?: Exclude<MentionToolPolicy["idempotency"], "none">;
    rollback?: MentionToolPolicy["rollback"];
  } = {},
): MentionToolPolicy {
  return {
    capabilityPackage,
    requiredCapabilities: [capability],
    resourceTypes,
    effect: "external",
    // The MCP transport derives a stable key from the authenticated JSON-RPC
    // invocation and Mention reserves it durably before entering the route.
    idempotency: options.idempotency ?? "supported",
    rollback: options.rollback ?? "manual",
    exposure: ["mcp"],
    limitKeys: [],
    invocation: { method, path },
  };
}

function write(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  capabilityPackage: MentionToolPolicy["capabilityPackage"],
  capability: string,
  resourceTypes: string[],
  options: {
    idempotency?: Exclude<MentionToolPolicy["idempotency"], "none">;
    rollback?: MentionToolPolicy["rollback"];
  } = {},
): MentionToolPolicy {
  return {
    ...effect(method, path, capabilityPackage, capability, resourceTypes, options),
    effect: "write",
  };
}

/** Policy-only metadata. Tool names, descriptions, schemas and handlers live once in the tool modules. */
export const MENTION_TOOL_POLICIES: Readonly<Record<string, MentionToolPolicy>> = {
  "get-feed": read("/feed/mtn", "social.read", post, true),
  "get-for-you-feed": read("/feed/mtn", "social.read", post, true),
  "get-explore-feed": read("/feed/mtn", "social.read", post, true),
  "get-following-feed": read("/feed/mtn", "social.read", post, true),
  "get-videos-feed": read("/feed/mtn", "social.read", post, true),
  "get-user-feed": read("/feed/mtn", "social.read", post, true),
  "get-replies": read("/feed/replies/{parentId}", "social.read", post, true),
  "get-feed-item": read("/feed/item/{id}", "social.read", post),
  search: read("/search", "social.search", post, true),
  "get-trending-hashtags": read("/trending", "social.read", ["mention_account", "hashtag"], true),
  "get-posts-by-hashtag": read("/feed/mtn", "social.read", ["mention_account", "hashtag", "post"], true),
  "get-profile": read("/profile/design/{userId}", "social.profile.read", ["mention_account", "profile"]),
  "get-recommendations": read("/recommendations", "social.profile.read", ["mention_account", "profile"], true),
  "get-poll": read("/polls/{id}", "social.read", ["mention_account", "poll"]),
  "get-poll-results": read("/polls/{id}/results", "social.read", ["mention_account", "poll"]),
  "get-post": read("/feed/item/{id}", "social.posts.read", post),
  "get-drafts": read("/posts/drafts", "social.posts.read", post, true),
  "get-scheduled-posts": read("/posts/scheduled", "social.posts.read", post, true),
  "get-saved-posts": read("/posts/saved", "social.posts.read", post, true),
  "get-lists": read("/lists", "social.lists.read", ["mention_account", "list"]),
  "get-list-timeline": read("/lists/{id}/timeline", "social.lists.read", ["mention_account", "list", "post"], true),
  "get-notifications": read("/notifications", "social.notifications.read", ["mention_account", "notification"], true),
  "get-unread-count": read("/notifications/unread-count", "social.notifications.read", ["mention_account", "notification"]),
  "get-starter-pack": read("/starter-packs/{id}", "social.starter_packs.read", ["mention_account", "starter_pack"]),
  "get-starter-packs": read("/starter-packs", "social.starter_packs.read", ["mention_account", "starter_pack"], true),
  "search-gifs": read("/gifs/search", "social.media.read", ["mention_account", "media"], true),
  whoami: read("/mcp/bundles/me", "social.accounts.read", account),
  "list-accounts": read("/mcp/bundles/accounts", "social.accounts.read", account),

  "create-post": effect("POST", "/posts", "publish", "social.posts.publish", post, { rollback: "none" }),
  "create-thread": effect("POST", "/posts/thread", "publish", "social.posts.publish", post, { rollback: "none" }),
  "update-post": effect("PUT", "/posts/{id}", "publish", "social.posts.update", post),
  "delete-post": effect("DELETE", "/posts/{id}", "publish", "social.posts.delete", post, { rollback: "none" }),
  "accept-collab-invite": effect("POST", "/posts/{id}/collaborators/accept", "publish", "social.collaboration.manage", post, { rollback: "supported" }),
  "decline-collab-invite": effect("POST", "/posts/{id}/collaborators/decline", "publish", "social.collaboration.manage", post, { rollback: "supported" }),
  "stop-collab-sharing": effect("POST", "/posts/{id}/collaborators/stop-sharing", "publish", "social.collaboration.manage", post, { rollback: "none" }),
  "like-post": effect("POST", "/posts/{id}/like", "communicate", "social.interact", post, { rollback: "supported" }),
  "unlike-post": effect("DELETE", "/posts/{id}/like", "communicate", "social.interact", post, { rollback: "supported" }),
  "save-post": write("POST", "/posts/{id}/save", "administer", "social.posts.save", post, { rollback: "supported" }),
  "unsave-post": write("DELETE", "/posts/{id}/save", "administer", "social.posts.save", post, { rollback: "supported" }),
  boost: effect("POST", "/feed/boost", "communicate", "social.interact", post, { rollback: "supported" }),
  "quote-post": effect("POST", "/posts", "publish", "social.posts.publish", post, { rollback: "none" }),
  "vote-poll": effect("POST", "/polls/{id}/vote", "communicate", "social.polls.vote", ["mention_account", "poll"], { rollback: "none" }),
  "follow-user": effect("POST", "/federation/follow", "communicate", "social.follow", ["mention_account", "profile"], { rollback: "supported" }),
  "unfollow-user": effect("POST", "/federation/unfollow", "communicate", "social.follow", ["mention_account", "profile"], { rollback: "supported" }),
  "mark-notifications-read": write("PATCH", "/notifications/read-all", "administer", "social.notifications.manage", ["mention_account", "notification"], { rollback: "supported" }),

  "create-list": write("POST", "/lists", "create", "social.lists.create", ["mention_account", "list"], { rollback: "supported" }),
  "update-list": write("PUT", "/lists/{id}", "administer", "social.lists.update", ["mention_account", "list"], { rollback: "supported" }),
  "delete-list": write("DELETE", "/lists/{id}", "administer", "social.lists.delete", ["mention_account", "list"], { rollback: "none" }),
  "create-starter-pack": write("POST", "/starter-packs", "create", "social.starter_packs.create", ["mention_account", "starter_pack"], { rollback: "supported" }),
  "update-starter-pack": write("PUT", "/starter-packs/{id}", "administer", "social.starter_packs.update", ["mention_account", "starter_pack"], { rollback: "supported" }),
  "delete-starter-pack": write("DELETE", "/starter-packs/{id}", "administer", "social.starter_packs.delete", ["mention_account", "starter_pack"], { rollback: "none" }),
  "add-starter-pack-members": write("POST", "/starter-packs/{id}/members", "administer", "social.starter_packs.update", ["mention_account", "starter_pack"], { rollback: "supported" }),
  "remove-starter-pack-members": write("DELETE", "/starter-packs/{id}/members", "administer", "social.starter_packs.update", ["mention_account", "starter_pack"], { rollback: "supported" }),
  "use-starter-pack": effect("POST", "/starter-packs/{id}/use", "communicate", "social.follow", ["mention_account", "starter_pack", "profile"], { rollback: "none" }),
  "upload-media-from-url": write("POST", "/posts/intent-media", "create", "social.media.create", ["mention_account", "media"], { rollback: "supported" }),
  "upload-media": write("POST", "/posts/intent-media", "create", "social.media.create", ["mention_account", "media"], { rollback: "supported" }),
  "use-gif": write("POST", "/gifs/use", "create", "social.media.create", ["mention_account", "media"], { rollback: "supported" }),
  "link-account": write("POST", "/mcp/bundles/link-token", "delegate", "social.accounts.link", account, { rollback: "none" }),
  "switch-account": write("POST", "/mcp/bundles/active", "administer", "social.accounts.switch", account, { rollback: "supported" }),
};

export const MENTION_MCP_CAPABILITIES = Object.freeze(
  [...new Set(
    Object.values(MENTION_TOOL_POLICIES).flatMap(
      (policy) => policy.requiredCapabilities,
    ),
  )].sort(),
);


export interface MentionCapabilityRequirement {
  readonly toolName: string;
  readonly requiredCapabilities: readonly string[];
}

const ROUTE_REQUIREMENTS = Object.entries(MENTION_TOOL_POLICIES).map(
  ([toolName, policy]) => ({
    toolName,
    method: policy.invocation.method,
    pathPattern: compileInvocationPath(policy.invocation.path),
    requiredCapabilities: policy.requiredCapabilities,
  }),
);

function compileInvocationPath(template: string): RegExp {
  const pattern = template
    .split("/")
    .map((segment) =>
      /^\{[^{}]+\}$/.test(segment)
        ? "[^/]+"
        : segment.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"),
    )
    .join("/");
  return new RegExp("^" + pattern + "$");
}

/**
 * Resolve every catalog tool whose declared domain invocation matches one API
 * request. More than one requirement is returned when two read tools share the
 * same endpoint; satisfying any one exact capability set authorizes that route.
 */
export function mentionCapabilityRequirementsForRequest(
  method: string,
  pathname: string,
): readonly MentionCapabilityRequirement[] {
  const normalizedMethod = method.toUpperCase();
  return ROUTE_REQUIREMENTS
    .filter(
      (entry) =>
        entry.method === normalizedMethod && entry.pathPattern.test(pathname),
    )
    .map(({ toolName, requiredCapabilities }) => ({
      toolName,
      requiredCapabilities,
    }));
}
