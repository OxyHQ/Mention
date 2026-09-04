# @mention/mcp — remote MCP server for Claude Web / ChatGPT

Production URL: **https://mcp.mention.earth/**

Canonical user + operator guide. Mention agents: see also [`AGENTS.md`](../../AGENTS.md) § MCP.

## Connect (Claude Web)

1. Settings → Connectors → Add custom connector
2. URL: `https://mcp.mention.earth` (no trailing slash)
3. Complete OAuth on `auth.oxy.so`, selecting the exact Oxy account to use
4. Revoke anytime from Oxy Settings

The authorization never grants a general Oxy session, and the access token stays
bound to the account it was issued for. Adding more accounts does not change
that: each one gets its own authorization, on the same connector.

## Multiple accounts

One connector, several accounts. Ask the assistant, in words:

| Step | Action |
|------|--------|
| 1 | Authorize Mention for the first Oxy account |
| 2 | Ask for **`link-account`** — you get a single-use `auth.oxy.so` link, valid for 15 minutes |
| 3 | Open it signed in as the account you want to add, and approve it there |
| 4 | Ask to **`switch-account`** to that account, and **`whoami`** before a public action |

| Tool | Purpose |
|------|---------|
| `whoami` | The account this connection is acting as right now |
| `list-accounts` | Every account the connection can act as, active one marked |
| `link-account` | A single-use Oxy link that adds another account to this connection |
| `switch-account` | Act as another account already on the connection |

Oxy owns the account set (ADR 0020): each account approves its own membership on
`auth.oxy.so` and can revoke it from its own Oxy Settings without affecting the
others. Mention stores none of it — it reads the set from live introspection.

## Architecture

```
MCP client → mcp.mention.earth → api.mention.earth
                   ↘ live token introspection ↗
                         api.oxy.so
                              ↑ account selection + consent on auth.oxy.so
```

| Component | Role |
|-----------|------|
| `@mention/mcp` | MCP protocol (streamable HTTP), tool handlers |
| `api.oxy.so` | Central OAuth authorization server, DCR, refresh, revocation and live introspection |
| `auth.oxy.so` | Account selection and consent UI |
| `api.mention.earth` | Domain API; re-introspects central tokens and enforces the catalog capability for the exact route |

**Identity model:** the token carries the approving user as `sub` and the account
it was minted for as `account_id`. When the connection covers more accounts,
introspection also returns `connection.active_account_id` — the member Oxy says
the connector is acting as, and the account Mention serves. Every request is
checked live against Oxy's grant, current account authority, connection
membership and registered Mention catalog. Mention never receives an Oxy user
session or a connection secret.

**Effect safety:** every mutating tool derives an account-bound key from its
authenticated JSON-RPC request. The API stores only hashes, reserves the key
before entering domain code, and refuses concurrent or later duplicates. A
connection loss after a write therefore leaves an indeterminate reservation
rather than risking a second post, follow, moderation action, or notification
change. Receipts expire after 30 days; reads never create them.

## MCP tools (59 total)

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
| `get-saved-posts` | `GET /posts/saved` |

Media for a post goes through `POST /posts/intent-media` (SSRF-safe URL fetch
or inline base64), never Oxy `assetUpload` directly — MCP JWT callers have no
user bearer, so intent-media uploads through the service-token
`POST /assets/service/user-media` path instead.

### Collaborative posts

- Invite up to **5 local** co-authors on `create-post` or `update-post` via `collaboratorIds` or `collaboratorHandles` (@username). The **backend** resolves handles to user IDs (MCP passes them through unchanged).
- A central connection acts only as its bound account. A collaborator accepts or declines through a separate connection authorized for that account.
- Auto-acceptance across linked accounts exists only for already-issued legacy bundles during the fixed migration window.
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

### Social (public unless noted)

| Tool | Auth | Backend |
|------|------|---------|
| `follow-user` | yes | `POST /federation/follow` |
| `unfollow-user` | yes | `POST /federation/unfollow` |
| `get-recommendations` | no | `GET /recommendations` |

### Starter packs (public reads; writes auth required)

| Tool | Auth | Backend |
|------|------|---------|
| `get-starter-packs` | no | `GET /starter-packs` |
| `get-starter-pack` | no | `GET /starter-packs/:id` |
| `create-starter-pack` | yes | `POST /starter-packs` |
| `update-starter-pack` | yes | `PUT /starter-packs/:id` |
| `delete-starter-pack` | yes | `DELETE /starter-packs/:id` |
| `add-starter-pack-members` | yes | `POST /starter-packs/:id/members` |
| `remove-starter-pack-members` | yes | `DELETE /starter-packs/:id/members` |
| `use-starter-pack` | yes | `POST /starter-packs/:id/use` |

### Search, lists, notifications, polls, hashtags, profile

See `packages/mcp/tools/*.ts`. Most write and personalized reads require auth
through `lib/auth-guard.ts`.

**Session note:** Claude must complete OAuth before `initialize` (POST requires Bearer). Some tools are callable without extra per-tool auth once the session is open, but the connector itself always needs OAuth first.

## OAuth authority and transition

New connections use Oxy's central endpoints under `/auth/mcp/oauth/*`. Mention's
old authorization server and multi-account bundles remain accepted only for
already-issued tokens until **2026-10-02T00:00:00Z**. They are not advertised by
the protected-resource metadata and must be removed after that deadline.

### Central OAuth

| Endpoint | Purpose |
|----------|---------|
| `GET https://api.oxy.so/.well-known/oauth-authorization-server` | AS discovery |
| `POST https://api.oxy.so/auth/mcp/oauth/register` | Dynamic client registration |
| `POST https://api.oxy.so/auth/mcp/oauth/token` | Code exchange and refresh |
| `POST https://api.oxy.so/auth/mcp/oauth/revoke` | Token revocation |
| `POST https://api.oxy.so/auth/mcp/oauth/introspect` | Service-authenticated live validation |

### Mention resource API

| Endpoint | Purpose |
|----------|---------|
| `GET /mcp/bundles/accounts` | Every account on the connection, from Oxy's introspection |
| `GET /mcp/bundles/me` | The account being acted as |
| `POST /mcp/bundles/link-token` | Single-use `auth.oxy.so` link that adds another account |
| `POST /mcp/bundles/active` | Asks Oxy to act as a member account |

### Key backend files

- `src/mcp/routes/mcpOAuth.routes.ts` — legacy transition only
- `src/mcp/routes/mcpBundles.routes.ts` — the connection's account views, plus legacy bundle transition
- `src/mcp/services/mcpConnectionDirectory.ts` — the Oxy connection calls (link URL, act-as) and the introspected account set
- `src/mcp/routes/mcpConnections.routes.ts` — list/revoke
- `src/mcp/middleware/mcpAuth.ts` — central introspection, exact capability gate, legacy transition
- `src/mcp/services/mcpBundleService.ts` — legacy bundle lookup during the fixed transition
- `db/schema/mcp.ts` + `db/mcp/mcpConnectionRepository.ts` — legacy connection records retained until retirement

### Frontend UI

- `auth.oxy.so` — central account selection and consent for all new connections
- `packages/frontend/app/(app)/oauth/mcp/*` — legacy Mention-owned consent screens pending deletion after cutoff
- `packages/frontend/app/(app)/settings/connected-ai.tsx` — legacy connection visibility and revocation during transition

## Environment variables

### MCP server (`mention-mcp` ECS)

| Variable | Default | Purpose |
|----------|---------|---------|
| `MENTION_API_URL` | `https://api.mention.earth` | Mention REST API |
| `MENTION_API_TIMEOUT_MS` | `10000` | Per-attempt Mention API timeout; GET retries once |
| `MENTION_MCP_PUBLIC_URL` | `https://mcp.mention.earth` | Exact protected resource |
| `OXY_API_URL` | `https://api.oxy.so` | Central OAuth issuer and introspection API |
| `OXY_SERVICE_API_KEY` | (required) | Mention service credential id |
| `OXY_SERVICE_API_SECRET` | (required) | Mention service credential secret |
| `MENTION_LEGACY_OAUTH_ISSUER` | `https://api.mention.earth` | Legacy verification only, until the fixed cutoff |
| `MCP_PORT` | `3100` | HTTP listen port |
| `MENTION_MCP_JWT_SECRET` | (required during transition) | Legacy HS256 verification only |
| `MCP_ALLOWED_ORIGINS` | Claude defaults | Extra CORS origins |
| `MCP_MAX_REQUEST_BODY_BYTES` | `1048576` | Maximum JSON request body retained in memory |
| `MCP_MAX_SESSIONS` | `1000` | Per-task cap for active HTTP/SSE sessions |

### Backend (`mention` ECS)

| Variable | Purpose |
|----------|---------|
| `OXY_API_URL` | Central introspection API |
| `OXY_SERVICE_API_KEY` / `OXY_SERVICE_API_SECRET` | Live service authentication to Oxy |
| `MENTION_MCP_JWT_SECRET` | Legacy verification only, until the fixed cutoff |
| `MCP_LINK_TOKEN_TTL_SECONDS` | Legacy link token lifetime (default 900; no new link tokens issued) |
| `MCP_MAX_BUNDLE_MEMBERS` | Legacy bundle limit retained until cutoff |

Secrets: GitHub Actions → SSM `/oxy/mention/*` and `/oxy/mention-mcp/*`.

## Deployment (AWS)

| Service | ECR | Domain | Workflow |
|---------|-----|--------|----------|
| `mention` | `oxy/mention` | `api.mention.earth`, `mention.earth` | `.github/workflows/deploy-aws.yml` |
| `mention-mcp` | `oxy/mention-mcp` | `mcp.mention.earth` | `.github/workflows/deploy-mcp-aws.yml` |

Infra: `oxy-infra` — ALB rule priority 140, ACM cert `mcp.mention.earth`, DNS CNAME → ALB (DNS-only/grey cloud like `api.mention.earth`).

Capability enforcement changes deploy with **mention**; tool/protocol and
protected-resource metadata changes deploy with **mention-mcp**. The OAuth
authority and consent UI deploy from OxyHQServices.

## Local development

```bash
# Terminal 1 — backend
cd packages/backend && bun run dev

# Terminal 2 — MCP HTTP server (not for end users)
cd packages/mcp
MENTION_API_URL=http://localhost:4110 bun run dev:http
```

From repo root: `bun run dev:mcp:http`

## Production checklist (E2E)

1. `curl https://mcp.mention.earth/health` → 200
2. `curl -D - -o /dev/null https://mcp.mention.earth/` → **401** + `WWW-Authenticate: Bearer ...`
3. `curl https://mcp.mention.earth/.well-known/oauth-protected-resource` → `resource` without trailing slash
4. `curl https://api.oxy.so/.well-known/oauth-authorization-server` → includes central DCR/token/revocation endpoints
5. Claude connector → OAuth → `whoami` / `create-post` succeed
6. Revoke the Oxy MCP grant → the next MCP and backend request fail
7. Authorize a second account separately → each `whoami` stays isolated
8. Verify the deployed catalog digest and the Mention service principal used for introspection

## Security

- Oxy stores authorization codes and refresh tokens only as hashes; access
  tokens are short-lived and resource/audience/account bound.
- MCP and Mention API introspect on every request, so revocation and lost account
  authority apply without waiting for a cache.
- The semantic capability comes from the same 59-tool catalog at the MCP tool
  boundary and at the corresponding Mention route.
- Legacy bundles and HS256 verification are disabled at the source-controlled
  cutoff; the protected metadata never advertises that authorization server.
