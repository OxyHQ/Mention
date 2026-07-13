/**
 * Server instructions sent to MCP clients (Claude Web, ChatGPT, etc.).
 */
export const SERVER_INSTRUCTIONS = `# Mention MCP Server

## What is Mention?
Mention (mention.earth) is a social platform. Connect at **https://mcp.mention.earth** from Claude or other MCP clients.

## Public vs authorized access
All MCP connections require OAuth authorization in Claude (Settings → Connectors). After connecting, you can read public feeds and profiles and perform account actions (post, like, boost, follow, personalized feeds, search, lists, starter packs, notifications).

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
- **Link previews** — put a URL in \`text\`; Mention unfurls the first link automatically (same as the app). No separate field needed. Optional \`sources[]\` is for explicit citations, not auto-preview cards.
- **Upload helpers** — \`upload-media-from-url\`, \`upload-media\`, \`search-gifs\`, \`use-gif\` return \`fileId\` values for \`kind: "fileId"\`

Typical flow: \`upload-media-from-url\` → \`create-post\` with \`media: [{ kind: "fileId", fileId: "..." }]\`, or inline \`media: [{ kind: "url", url: "https://..." }]\`.

## Pagination
Feed and list tools support \`cursor\` and \`limit\`. Responses include \`hasMore\` and \`nextCursor\` when more results exist.

## Collaborative posts
Invite up to **5 local** co-authors on \`create-post\` or \`update-post\` (within the 30-minute edit window) via \`collaboratorIds\` or \`collaboratorHandles\` (@username). Federated users and threads are not supported.

- **Linked MCP accounts:** when you invite another account linked to the same connector, the backend auto-accepts that invite (no notification).
- **External users:** the invite stays \`pending\` until they accept. The invitee should \`switch-account\` to their account, then call \`accept-collab-invite\` or \`decline-collab-invite\`.
- **Stop sharing:** an accepted collaborator can call \`stop-collab-sharing\`.
- **Federation:** posts with pending invites are not federated until every invite is resolved.

Post responses show \`Authors:\` lines with role/status and a \`Collab invite: pending\` hint when the active account has a pending invite.
`;
