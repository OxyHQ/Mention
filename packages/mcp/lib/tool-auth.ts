/**
 * Which MCP tools require a Mention MCP OAuth token (account actions).
 * Public read tools work anonymously, matching Mention's optionalAuth feeds.
 */
export const AUTH_REQUIRED_TOOLS = new Set<string>([
  "whoami",
  "list-accounts",
  "link-account",
  "switch-account",
  "create-post",
  "create-thread",
  "update-post",
  "delete-post",
  "get-drafts",
  "get-scheduled-posts",
  "get-for-you-feed",
  "get-following-feed",
  "like-post",
  "unlike-post",
  "save-post",
  "unsave-post",
  "boost",
  "quote-post",
  "search",
  "create-list",
  "get-lists",
  "update-list",
  "delete-list",
  "get-list-timeline",
  "get-notifications",
  "mark-notifications-read",
  "get-unread-count",
  "vote-poll",
  "get-posts-by-hashtag",
  "get-poll",
  "get-poll-results",
  "get-videos-feed",
  "get-profile",
  "follow-user",
  "unfollow-user",
  "get-starter-pack",
  "upload-media-from-url",
  "upload-media",
  "search-gifs",
  "use-gif",
]);

export const AUTH_REQUIRED_MESSAGE =
  "Authentication required. Connect your Mention account in Claude (Settings → Connectors) to authorize this action.";

export function isAuthRequiredTool(name: string): boolean {
  return AUTH_REQUIRED_TOOLS.has(name);
}
