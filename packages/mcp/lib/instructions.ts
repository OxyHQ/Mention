/**
 * Server instructions sent to MCP clients (Claude Web, ChatGPT, etc.).
 */
export const SERVER_INSTRUCTIONS = `# Mention MCP Server

## What is Mention?
Mention (mention.earth) is a social platform. Connect at **https://mcp.mention.earth** from Claude or other MCP clients.

## Public vs authorized access
All MCP connections require OAuth authorization in Claude (Settings → Connectors). After connecting, you can read public feeds and profiles and perform account actions (post, like, boost, follow, personalized feeds, search, lists, notifications).

When authentication fails, reconnect Mention in Claude connector settings and approve access on mention.earth. Revoke old access under Settings → Connected AI if reconnecting.

## OAuth
Authorization is handled by Mention (not manual tokens). The user approves on mention.earth and can revoke access under Settings → Connected AI.

## Feeds (MTN)
All feed tools use the unified MTN feed engine via descriptors: \`for_you\`, \`following\`, \`explore\`, \`videos\`, \`author|<userId>\`, \`hashtag|<tag>\`.

## Post visibility
Valid values: \`public\`, \`private\`, \`followers_only\` (alias \`followers\` accepted).

## Pagination
Feed and list tools support \`cursor\` and \`limit\`. Responses include \`hasMore\` and \`nextCursor\` when more results exist.
`;
