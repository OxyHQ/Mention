# @mention/mcp — remote MCP server for Claude Web / ChatGPT

Production URL: **https://mcp.mention.earth/**

Canonical user + operator guide. Mention agents: see also [`AGENTS.md`](../../AGENTS.md) § MCP.

## Connect (Claude Web)

1. Settings → Connectors → Add custom connector
2. URL: `https://mcp.mention.earth` (no trailing slash)
3. Complete OAuth on mention.earth when prompted
4. Revoke anytime: Mention → Settings → **Connected AI**

Claude blocks duplicate URLs — you cannot add the same MCP URL twice. Use **linked accounts** (below) to post as multiple Mention users from one connector.

## Multiple accounts (one connector)

| Step | Action |
|------|--------|
| 1 | Connect once → OAuth as your first account (primary) |
| 2 | In chat: **`link-account`** → open URL in browser → sign in as other account → **Link to Claude** |
| 3 | **`switch-account`** with target `@handle` |
| 4 | **`whoami`** to confirm → **`create-post`** |

| Tool | Purpose |
|------|---------|
| `whoami` | Active account (@handle, display name, user id) |
| `list-accounts` | All accounts linked to this connector |
| `link-account` | Browser URL to add another account (single-use, 15 min) |
| `switch-account` | Set active account by `@handle` |

Max **8** linked accounts per connector (`MCP_MAX_BUNDLE_MEMBERS`).

## Architecture

```
Claude Web  →  mcp.mention.earth (ECS mention-mcp)  →  api.mention.earth (ECS mention)
                     ↑ OAuth consent + link UI on mention.earth
```

| Component | Role |
|-----------|------|
| `@mention/mcp` | MCP protocol (streamable HTTP), tool handlers |
| `api.mention.earth` | REST API + OAuth authorization server (RFC 8414 / 9728 / 7591 DCR) |
| `mention.earth` | Consent UI (`/oauth/mcp/authorize`), link UI (`/oauth/mcp/link`), Settings revoke |

**Identity model:** Claude holds one OAuth token (primary account). The backend resolves the **active account** per request via `bundleId` + Redis/Mongo (`activeOxyUserId` on the primary `McpConnection`). Linked accounts approve via browser link flow — not a second Claude OAuth grant.

## MCP tools (45 total)

### Accounts (auth required)

| Tool | Backend |
|------|---------|
| `whoami` | `GET /mcp/bundles/me` |
| `list-accounts` | `GET /mcp/bundles/accounts` |
| `link-account` | `POST /mcp/bundles/link-token` |
| `switch-account` | `POST /mcp/bundles/active` |

### Posts (auth required)

| Tool | Backend |
|------|---------|
| `create-post` | `POST /posts` |
| `create-thread` | `POST /posts/thread` (no collaborators) |
| `update-post` | `PUT /posts/:id` |
| `delete-post` | `DELETE /posts/:id` |
| `accept-collab-invite` | `POST /posts/:id/collaborators/accept` |
| `decline-collab-invite` | `POST /posts/:id/collaborators/decline` |
| `stop-collab-sharing` | `POST /posts/:id/collaborators/stop-sharing` |
| `get-drafts` | `GET /posts/drafts` |
| `get-scheduled-posts` | `GET /posts/scheduled` |

### Collaborative posts

- Invite up to **5 local** co-authors on `create-post` or `update-post` via `collaboratorIds` or `collaboratorHandles` (@username). The **backend** resolves handles to user IDs (MCP passes them through unchanged).
- **Linked bundle accounts** are auto-accepted when invited (backend intersects with bundle members).
- External users stay `pending` until they `switch-account` and call `accept-collab-invite` or `decline-collab-invite`.
- Accepted collaborators can call `stop-collab-sharing`.
- Threads do not support collaborators (backend returns 400).
- Federation is deferred until all invites resolve.

### Feed (public unless noted)

| Tool | Auth | Backend |
|------|------|---------|
| `get-feed` | no | `GET /feed/mtn` |
| `get-explore-feed` | no | `GET /feed/mtn?descriptor=explore` |
| `get-for-you-feed` | yes | `GET /feed/mtn?descriptor=for_you` |
| `get-following-feed` | yes | `GET /feed/mtn?descriptor=following` |
| `get-videos-feed` | yes | `GET /feed/mtn?descriptor=videos` |
| `get-user-feed` | no | `GET /feed/mtn?descriptor=author\|<id>` |
| `get-replies` | no | `GET /feed/replies/:id` |
| `get-feed-item` | no | `GET /feed/item/:id` |
| `get-post` | no | `GET /feed/item/:id` |

### Interactions (auth required)

`like-post`, `unlike-post`, `save-post`, `unsave-post`, `boost`, `quote-post`

### Social, search, lists, notifications, polls, hashtags, profile, starter packs

See `packages/mcp/tools/*.ts`. Most write/personalized reads require auth per `lib/tool-auth.ts`.

**Session note:** Claude must complete OAuth before `initialize` (POST requires Bearer). Some tools are callable without extra per-tool auth once the session is open, but the connector itself always needs OAuth first.

## Backend OAuth & bundle API

Implemented in `packages/backend/src/mcp/`.

### Public OAuth (no session)

| Endpoint | Purpose |
|----------|---------|
| `GET /.well-known/oauth-authorization-server` | AS discovery (includes `registration_endpoint`) |
| `GET /.well-known/oauth-protected-resource` | Resource metadata (`resource` = `https://mcp.mention.earth`, no slash) |
| `POST /mcp/oauth/register` | RFC 7591 dynamic client registration |
| `GET /mcp/oauth/authorize` | Start auth code + PKCE flow |
| `POST /mcp/oauth/token` | Exchange code / refresh token |
| `GET /mcp/bundles/link/preview?token=` | Link-flow preview (public) |

### Authenticated (MCP JWT or Oxy session)

| Endpoint | Purpose |
|----------|---------|
| `POST /mcp/oauth/approve` | Consent approval (Oxy session) |
| `GET /mcp/connections` | List authorized clients (Settings data) |
| `DELETE /mcp/connections/:id` | Revoke connection |
| `GET /mcp/bundles/accounts` | Linked accounts in bundle |
| `GET /mcp/bundles/me` | Active account summary |
| `POST /mcp/bundles/link-token` | Mint single-use browser link token |
| `POST /mcp/bundles/link/complete` | Complete link (Oxy session + token) |
| `POST /mcp/bundles/active` | Switch active account |

### Key backend files

- `src/mcp/routes/mcpOAuth.routes.ts` — OAuth AS + link preview
- `src/mcp/routes/mcpBundles.routes.ts` — multi-account bundle API
- `src/mcp/routes/mcpConnections.routes.ts` — list/revoke
- `src/mcp/middleware/mcpAuth.ts` — dual MCP/Oxy auth + active account resolution
- `src/mcp/services/mcpBundleService.ts` — bundles, link tokens, Redis active account
- `src/mcp/models/McpConnection.ts` — grants (`bundleId`, `isBundlePrimary`, `activeOxyUserId`)

### Frontend UI

- `packages/frontend/app/(app)/oauth/mcp/authorize.tsx` — initial OAuth consent (@handle shown)
- `packages/frontend/app/(app)/oauth/mcp/link.tsx` — link additional account
- `packages/frontend/app/(app)/settings/connected-ai.tsx` — revoke + bundle handles

## Environment variables

### MCP server (`mention-mcp` ECS)

| Variable | Default | Purpose |
|----------|---------|---------|
| `MENTION_API_URL` | `https://api.mention.earth` | Mention REST API |
| `MENTION_MCP_PUBLIC_URL` | `https://mcp.mention.earth` | Public MCP URL (JWT `aud`) |
| `MENTION_OAUTH_AS_URL` | `https://api.mention.earth` | OAuth AS origin |
| `MCP_PORT` | `3100` | HTTP listen port |
| `MENTION_MCP_JWT_SECRET` | (required) | Must match backend secret |
| `MCP_ALLOWED_ORIGINS` | Claude defaults | Extra CORS origins |

### Backend (`mention` ECS)

| Variable | Purpose |
|----------|---------|
| `MENTION_MCP_JWT_SECRET` | Sign/verify MCP access tokens |
| `MENTION_MCP_PUBLIC_URL` | Protected-resource `resource` + JWT `aud` |
| `MENTION_FRONTEND_ORIGIN` | Consent redirect (`https://mention.earth`) |
| `MENTION_PUBLIC_API_URL` | OAuth issuer (`https://api.mention.earth`) |
| `MCP_LINK_TOKEN_TTL_SECONDS` | Link token lifetime (default 900) |
| `MCP_MAX_BUNDLE_MEMBERS` | Max accounts per bundle (default 8) |

Secrets: GitHub Actions → SSM `/oxy/mention/*` and `/oxy/mention-mcp/*`.

## Deployment (AWS)

| Service | ECR | Domain | Workflow |
|---------|-----|--------|----------|
| `mention` | `oxy/mention` | `api.mention.earth`, `mention.earth` | `.github/workflows/deploy-aws.yml` |
| `mention-mcp` | `oxy/mention-mcp` | `mcp.mention.earth` | `.github/workflows/deploy-mcp-aws.yml` |

Infra: `oxy-infra` — ALB rule priority 140, ACM cert `mcp.mention.earth`, DNS CNAME → ALB (DNS-only/grey cloud like `api.mention.earth`).

Backend MCP OAuth changes deploy with **mention**; tool/protocol changes deploy with **mention-mcp**. Frontend consent/link UI deploys with **mention** (apex web shell).

## Local development

```bash
# Terminal 1 — backend
cd packages/backend && bun run dev

# Terminal 2 — MCP HTTP server (not for end users)
cd packages/mcp
MENTION_API_URL=http://localhost:3000 bun run dev:http
```

From repo root: `bun run dev:mcp:http`

## Production checklist (E2E)

1. `curl https://mcp.mention.earth/health` → 200
2. `curl -D - -o /dev/null https://mcp.mention.earth/` → **401** + `WWW-Authenticate: Bearer ...`
3. `curl https://mcp.mention.earth/.well-known/oauth-protected-resource` → `resource` without trailing slash
4. `curl https://api.mention.earth/.well-known/oauth-authorization-server` → includes `registration_endpoint`
5. Claude connector → OAuth → `whoami` / `create-post` succeed
6. `link-account` → browser link → second account → `switch-account` → `whoami` shows second account
7. Settings → Connected AI → revoke → writes fail
8. `MENTION_MCP_JWT_SECRET` set in GitHub secrets (synced to SSM)

## Security

- Link tokens: HMAC-signed, TTL 15 min, **single-use** (Redis `NX`)
- Bundle membership: explicit approve on `/oauth/mcp/link`; unique index on `(bundleId, oxyUserId)` when not revoked
- Active account: persisted on primary `McpConnection.activeOxyUserId` + Redis; switch fails closed (`503`) if neither persists
- No `as_user` on `create-post` — must `switch-account` first
