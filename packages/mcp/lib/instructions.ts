/**
 * Server instructions sent to MCP clients (Claude Web, ChatGPT, etc.).
 */
export const SERVER_INSTRUCTIONS = `# Mention MCP Server

## What is Mention?
Mention (mention.earth) is a social platform. Connect at **https://mcp.mention.earth** from Claude or other MCP clients.

## Public vs authorized access
All MCP connections require OAuth authorization in Claude (Settings → Connectors). After connecting, you can read public feeds and profiles and perform account actions (post, like, boost, follow, personalized feeds, search, lists, notifications).

When authentication fails, reconnect Mention in Claude connector settings and approve access on mention.earth. Revoke old access under Settings → Connected AI if reconnecting.

## Multiple accounts (one connector)
Claude allows only **one** connector per MCP URL. To post as different Mention accounts:
1. Connect once at https://mcp.mention.earth
2. Call **link-account** → open the URL in a browser → sign in as the other account → approve
3. Call **switch-account** with the target @handle
4. Call **whoami** to confirm before **create-post**

## OAuth
Authorization is handled by Mention (not manual tokens). The user approves on mention.earth and can revoke access under Settings → Connected AI.

## Feeds (MTN)
All feed tools use the unified MTN feed engine via descriptors: \`for_you\`, \`following\`, \`explore\`, \`videos\`, \`author|<userId>\`, \`hashtag|<tag>\`.

## Post visibility
Valid values: \`public\`, \`private\`, \`followers_only\` (alias \`followers\` accepted).

## Attachments & media
\`create-post\` and \`create-thread\` support the full Mention attachment model:
- **Media** — pass \`media[]\` with \`kind: "fileId"\` (after upload), \`kind: "url"\` (remote fetch), or \`kind: "base64"\` (inline bytes)
- **Poll, article, event, room, podcast, location, sources** — pass the matching fields on create-post / per thread post
- **Upload helpers** — \`upload-media-from-url\`, \`upload-media\`, \`search-gifs\`, \`use-gif\` return \`fileId\` values for \`kind: "fileId"\`

Typical flow: \`upload-media-from-url\` → \`create-post\` with \`media: [{ kind: "fileId", fileId: "..." }]\`, or inline \`media: [{ kind: "url", url: "https://..." }]\`.

## Pagination
Feed and list tools support \`cursor\` and \`limit\`. Responses include \`hasMore\` and \`nextCursor\` when more results exist.
`;
