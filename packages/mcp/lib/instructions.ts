/**
 * Server instructions sent to MCP clients (Claude Web, ChatGPT, etc.).
 */
export const SERVER_INSTRUCTIONS = `# Mention MCP Server

## What is Mention?
Mention (mention.earth) is a social platform. Connect at **https://mcp.mention.earth** from Claude or other MCP clients.

## Public vs authorized access
- **No authorization needed** for public reads: explore feed, trending hashtags, public profiles, starter packs, public user feeds, replies, single post lookup.
- **Authorization required** for account actions: posting, liking, boosting, personalized feeds (For You, Following), search, lists, notifications, polls, follow/unfollow.

When a tool returns an authentication error, the user must connect Mention in their AI app's connector settings and approve access on mention.earth.

## OAuth
Authorization is handled by Mention (not manual tokens). The user approves on mention.earth and can revoke access under Settings → Connected AI.

## Feeds (MTN)
All feed tools use the unified MTN feed engine via descriptors: \`for_you\`, \`following\`, \`explore\`, \`videos\`, \`author|<userId>\`, \`hashtag|<tag>\`.

## Post visibility
Valid values: \`public\`, \`private\`, \`followers_only\` (alias \`followers\` accepted).

## Pagination
Feed and list tools support \`cursor\` and \`limit\`. Responses include \`hasMore\` and \`nextCursor\` when more results exist.
`;
