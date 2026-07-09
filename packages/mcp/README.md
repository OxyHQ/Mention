# @mention/mcp — remote MCP server for Claude Web / ChatGPT
#
# Production URL: https://mcp.mention.earth/

## Connect

Add a custom MCP connector in Claude Web (Settings → Connectors):

```
https://mcp.mention.earth
```

Public read tools work without authorization. Posting, liking, personalized feeds, and other account actions require OAuth — Claude opens mention.earth for consent. Revoke access anytime in Mention → Settings → Connected AI.

## Multiple accounts

Claude allows only **one** connector for `https://mcp.mention.earth`. To publish as different Mention accounts from the same connector:

1. Connect once (OAuth as your first account).
2. In chat, run **`link-account`** → open the URL in your browser → sign in as the other account → **Link**.
3. Run **`switch-account`** with the target `@handle`.
4. Run **`whoami`** to confirm, then **`create-post`**.

| Tool | Purpose |
|------|---------|
| `whoami` | Active account for this connector |
| `list-accounts` | All linked accounts |
| `link-account` | Browser URL to add another account |
| `switch-account` | Set active account by @handle |

## Architecture

```
Claude Web  →  mcp.mention.earth  →  api.mention.earth
                     ↑ OAuth consent on mention.earth
```

| Component | Role |
|-----------|------|
| `@mention/mcp` | MCP protocol + tool handlers |
| `api.mention.earth` | REST API + OAuth authorization server |
| `mention.earth` | Consent UI + Settings revoke |

## Tool access levels

### Public (no token)

| Tool | Backend |
|------|---------|
| `get-feed`, `get-explore-feed` | `GET /feed/mtn?descriptor=explore` |
| `get-user-feed` | `GET /feed/mtn?descriptor=author\|<id>` |
| `get-replies` | `GET /feed/replies/:id` |
| `get-feed-item`, `get-post` | `GET /feed/item/:id` |
| `get-trending-hashtags` | `GET /trending?type=hashtag` |
| `get-posts-by-hashtag` | `GET /feed/mtn?descriptor=hashtag\|<tag>` |
| `get-profile` | `GET /profile/design/:userId` |
| `get-starter-pack` | `GET /starter-packs/:id` |

### Requires Mention OAuth token

All write tools, `get-for-you-feed`, `get-following-feed`, `get-videos-feed`, `search`, lists, notifications, polls, follow/unfollow.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MENTION_API_URL` | `https://api.mention.earth` | Mention REST API |
| `MENTION_MCP_PUBLIC_URL` | `https://mcp.mention.earth` | This server's public URL |
| `MENTION_OAUTH_AS_URL` | `https://api.mention.earth` | OAuth authorization server |
| `MCP_PORT` | `3100` | HTTP listen port |
| `MCP_ALLOWED_ORIGINS` | (see server defaults) | Extra CORS origins |

Backend OAuth (separate ECS service):

| Variable | Purpose |
|----------|---------|
| `MENTION_MCP_JWT_SECRET` | Sign/verify MCP access tokens |
| `MENTION_FRONTEND_ORIGIN` | Consent redirect (`https://mention.earth`) |
| `MENTION_PUBLIC_API_URL` | OAuth issuer (`https://api.mention.earth`) |

## Internal development only

```bash
cd packages/mcp
MENTION_API_URL=http://localhost:3000 bun run dev:http
```

Not intended for end users.

## Production checklist (E2E)

After deploy (`mention-mcp` ECS service + `mcp.mention.earth` DNS in oxy-infra):

1. `curl https://mcp.mention.earth/health` → 200
2. `curl https://mcp.mention.earth/.well-known/oauth-protected-resource` → JSON with `authorization_servers`
3. Claude Web connector `https://mcp.mention.earth` → `get-explore-feed` without auth
4. `create-post` prompts OAuth → consent at mention.earth/oauth/mcp/authorize → post succeeds
5. Mention Settings → Connected AI → revoke → writes fail again
6. Set `MENTION_MCP_JWT_SECRET` in GitHub secrets (synced to SSM `/oxy/mention/` and `/oxy/mention-mcp/`)
