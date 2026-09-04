/**
 * Server instructions sent to MCP clients (Claude Web, ChatGPT, etc.).
 */
export const SERVER_INSTRUCTIONS = `# Mention MCP Server

## What is Mention?
Mention (mention.earth) is a social platform. Connect at **https://mcp.mention.earth** from Claude or other MCP clients.

## Public vs authorized access
All MCP connections require OAuth authorization in Claude (Settings → Connectors). After connecting, you can read public feeds and profiles and perform account actions (post, like, boost, follow, personalized feeds, search, lists, starter packs, notifications).

When authentication fails, reconnect Mention in the client and approve the account on auth.oxy.so. Revoke access from Oxy Settings when reconnecting.

## Accounts on one connection
A connection starts with the one account approved during consent, and can cover
more. Ask for **link-account** to get a single-use Oxy link; whoever opens it
approves adding the account they are signed in as, on auth.oxy.so. **list-accounts**
shows every account the connection can act as, **switch-account** selects one, and
**whoami** says which one is active — call it before publishing.

Oxy owns all of this: each account approves its own participation and can revoke
it from its own Oxy settings without affecting the others.

## OAuth
Oxy is the central authorization server; Mention never asks for or stores a manual user token. Access can be revoked immediately from Oxy Settings.

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

- **Invited accounts:** the invite stays \`pending\` until that account accepts or declines through its own authorized connection.
- **Legacy transition:** already-issued multi-account bundles can retain their historical auto-accept behavior only until the fixed migration cutoff.
- **Stop sharing:** an accepted collaborator can call \`stop-collab-sharing\`.
- **Federation:** posts with pending invites are not federated until every invite is resolved.

Post responses show \`Authors:\` lines with role/status and a \`Collab invite: pending\` hint when the active account has a pending invite.
`;
