# Mention

## AWS Deployment

The backend runs on **AWS ECS Fargate** (region `us-west-2`, cluster `oxy-cluster`), behind an ALB with ACM HTTPS.

- **Port**: `3000` | **Domain**: `api.mention.earth`
- **Deploy**: `git push origin main` → `.github/workflows/deploy-aws.yml` builds a `linux/arm64` Docker image → pushes to ECR (`237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/mention`) → `aws ecs update-service --force-new-deployment`
- **Auth**: GitHub OIDC → role `oxy-github-deploy`. No AWS keys stored in GitHub.
- **Secrets**: GitHub Actions secrets are the source of truth. The deploy workflow syncs them to AWS SSM (`/oxy/mention/*`; shared secrets to `/oxy/_shared/*`); ECS injects them into the container. To change a secret: edit it in GitHub — the next deploy applies it.
- **Dockerfile**: must build for `linux/arm64` (Graviton).
- **WARNING**: Never put secret values in this file.

## Custom Agents

Use these agents for all implementation work:
- `mention-frontend` — Expo/RN frontend (components, screens, hooks, feeds, profiles)
- `mention-designer` — UI/UX (animations, styling, responsive, pixel-perfect)
- `mention-backend` — Backend (API, MongoDB, Redis, ActivityPub, feeds, MCP)
- `mention-fixer` — Cross-stack debugging (frontend ↔ backend ↔ oxy)

## Commands

```bash
bun run dev                 # All packages dev mode
bun run dev:frontend        # Frontend dev (Expo tunnel)
bun run dev:backend         # Backend dev (watch mode)
bun run dev:agora           # Agora dev
bun run dev:mcp             # MCP server dev
bun run build               # Build shared-types + backend + mcp
bun run build:frontend      # Build frontend
bun run build:backend       # Build backend (shared-types first)
bun run test                # Test all
bun run lint                # Lint all
bun run clean               # Remove all node_modules
```

## Architecture

Monorepo (v2.0.0) using Bun with workspaces.

```
packages/
  frontend/       @mention/frontend    Expo 55 / React Native 0.84 / React 19
  backend/        @mention/backend     Express 5.2 / Mongoose 9.3 / Redis / Socket.io
  shared-types/   @mention/shared-types TypeScript type definitions
  agora/          @mention/agora       Expo app for live audio/video rooms (LiveKit)
  agora-shared/   @mention/agora-shared Shared Agora components & hooks
  mcp/            @mention/mcp         Model Context Protocol server for Claude
```

## Key Tech

- **Frontend**: Expo Router, NativeWind + TailwindCSS 4.2, TanStack React Query, Zustand, Socket.io-client, LiveKit
- **Backend**: Express 5, Mongoose 9, Redis 5, Socket.io, LiveKit Server SDK, Firebase Admin, AWS S3
- **Feed System**: MTN protocol in `backend/src/mtn/` (ForYou, Following, Author, Hashtag, Explore, Custom, Videos feeds + tuners). `videos` descriptor (`packages/shared-types/src/mtn/feedDescriptor.ts`) is backed by `VideosFeed` (`packages/backend/src/mtn/feed/feeds/VideosFeed.ts`) — ranked feed of video posts (native + federated) powering the fullscreen Reels viewer (`packages/frontend/app/(app)/videos.tsx`). The legacy `type:'media'` global descriptor does NOT exist — returns 400. Use `videos`.
- **Federation**: ActivityPub protocol — federated users in Oxy (type: 'federated'), posts in Mention, linked by oxyUserId. HTTP signatures on all outbound requests. Local dev: `cloudflared tunnel --url http://localhost:3000` + set `FEDERATION_DOMAIN` to tunnel domain. Outbox sync uses the actor's advertised `outbox` URL (`fetchRemoteActor`), with `actorUri + '/outbox'` only as fallback — guessing breaks PeerTube/Lemmy/some Pleroma. Boosts (Announce) are imported as `type:'boost'` posts (mirroring native repost shape), deduped by `federation.activityId`, in both inbox push (`handleAnnounce`) and outbox backfill (`syncOutboxPosts`/`extractCandidates`) paths.
- **Auth**: Oxy integration via `@oxyhq/core ^3.4.17` + `@oxyhq/services ^10.2.11`

## Profile Identity Contract

- Oxy API owns canonical user display names. User/profile DTOs must provide `name.displayName` as the already-resolved value. Mention frontend renders `name.displayName` directly and must not recompute names from `name.first`, `name.last`, `name.full`, or add local `displayName || username` fallback chains in components.
- Profile update payloads use the shared `UserProfileUpdate` contract from `@oxyhq/contracts` via the SDK/API layers. Do not create Mention-local profile update interfaces for Oxy user fields.
- Mention post DTOs must be produced by `PostHydrationService` (`packages/backend/src/services/PostHydrationService.ts`). Controllers must not hand-build post `user` objects, notification embedded posts, or nearby/feed post responses; hydration is the single place that resolves `PostActorSummary.displayName`, avatar, engagement, permissions, and related post data.
- Profile routes use `getNormalizedUserHandle` from `@oxyhq/core` for local and federated handles. Do not add local profile-route helpers, manually append federated instances, navigate to raw ids, or generate `?username=` profile URLs.
- Valid profile URLs are `/@username` and `/@username@domain`. Duplicate instance suffixes such as `/@user@domain@domain` are bugs in handle normalization and should be fixed at the source.

## Federated Media Cache

Remote/federated post media (images, video, audio) is proxied and cached through the backend:

- **Proxy endpoint**: `GET /media/proxy?url=<remote url>` — SSRF-guarded (DNS-pinned, IP denylist, per-hop redirect re-validation, content-type allowlist image/video/audio, SVG rejected, range requests supported). Frontend rewrites federated media URLs to this proxy via `proxyExternalUrl()` in `packages/frontend/utils/imageUrlCache.ts`.
- **Video poster endpoint**: `GET /media/poster?url=<video url>` — extracts a frame via ffmpeg (sandboxed: bounded download to temp file, `-protocol_whitelist file`, no network). Dockerfile installs ffmpeg. Frontend helper: `videoPosterUrl()`.
- **S3 activity cache**: on proxy access, media is uploaded to Oxy S3 via `POST /assets/service/cache` on oxy-api (service-token-scoped, reserved `federation-media-cache` namespace). Cached entries are served via 302 to the Oxy CDN. Entries unused for 30 days are evicted and re-cached on next access. Model: `FederatedMediaCache`.
- **Key code locations**: `packages/backend/src/services/mediaCache/*`, `routes/media.ts`, `utils/safeUpstreamFetch.ts`, `utils/ssrfGuard.ts`, `utils/videoPoster.ts`.
- **Gated by env**: `FEDERATION_MEDIA_CACHE_WRITE_ENABLED=true` (set on the mention ECS task in `oxy-infra/terraform-uswest2/app-services-realtime.tf`). Unset = proxy works but nothing is written to S3.
- **Post storage**: federated media URLs are stored RAW (remote) on the post (`content.media[].id`). The cache keys off the remote URL and never rewrites the post.
- **SSM secrets**: `OXY_SERVICE_API_KEY` + `OXY_SERVICE_API_SECRET` are live in SSM at `/oxy/mention/OXY_SERVICE_API_KEY` and `/oxy/mention/OXY_SERVICE_API_SECRET`, wired into the ECS task definition.

## Federation — Service Credential & Outbox Sync

Federated post sync requires a valid Oxy `service`-type ApplicationCredential. Flow: view federated profile → `syncOutboxPosts` → `getKeyPair('instance')` → `getServiceToken()` (`POST api.oxy.so/auth/service-token`) → signs the GET to the remote ActivityPub outbox.

**Silent sticky outage pattern:** a bad/missing service token causes `getServiceToken()` to fail → signed fetch returns 0 posts. The outbox-sync cooldown (`OUTBOX_SYNC_MIN_INTERVAL_MS`, stamps `lastOutboxSyncAt` in `feed.controller.ts`) then makes this empty first sync PERMANENT (`pending:true`, 0 posts) until `lastOutboxSyncAt` is manually cleared from the DB. A bad service token is invisible at `LOG_LEVEL=info` — service-token and signed-fetch failures now log at `error`/`warn` (commit `7138fbaf`).

**Current service credential:** Oxy ApplicationCredential id `6a30ca4b5b15dc1bb793ad53` under the "Mention" Application, scopes `federation:write` + `user:read` + `files:write`. Secrets in GitHub `OxyHQ/Mention` → SSM `/oxy/mention/OXY_SERVICE_API_KEY|SECRET`.

**Recreating creds:** use `~/Oxy/OxyHQServices/packages/api/scripts/create-service-credential.ts` (generic/idempotent; not committed — OxyHQServices working tree has an in-progress rewrite). Always use the real `ApplicationCredential.create` (SHA-256 secretHash). NEVER do a raw DB insert. Run prod-DB one-shots as a Fargate task in the oxy-api SG/subnets.

**Mention is the only app using the Oxy service-token flow** (no other app needed a service credential as of 2026-06-16).

## Compose Intent URL

The composer accepts rich URL params for prefilling — mirrors X/Twitter `intent/tweet`:
- Canonical: `https://mention.earth/compose?text=...&url=...&hashtags=...`
- Full param reference: `packages/frontend/docs/INTENT_URL.md`
- Parser: `packages/frontend/utils/composeIntent.ts`
- Wired in: `packages/frontend/app/(app)/compose.tsx` (inside the auth group)
- OS share sheet: Web Share Target (PWA, via `app.config.js` manifest) + native via `expo-share-intent` (config plugin, needs `expo prebuild` after install)
- Share intent integration point: `packages/frontend/app/_layout.tsx`
- Platform split pattern: `shareIntent.web.ts` / `shareIntent.native.ts` (mirrors `livekit.web.ts` / `livekit.native.ts`)
- Quote flow: `hooks/useQuoteManager.ts` + `components/Compose/QuoteCard.tsx`
- Wire format: quote post field is snake_case `quoted_post_id` as top-level body field (NOT nested under `content`)

## Dependencies

- `@oxyhq/core ^3.4.17`, `@oxyhq/services ^10.2.11` — Oxy platform SDK
- `@oxyhq/bloom ^0.8.6` — Shared UI component library

## Auth Cold-Boot Reactivity (Web)

On web, the session restores asynchronously after mount — the `/sso` path can take 5–25s. The SDK auth state (`useAuth()` `isAuthenticated` / `user`) IS reactive, but consumers must treat it as such:

- **Key data fetches on identity, not on the stable singleton.** React Query keys and `useEffect` deps must include `isAuthenticated` / `user?.id`. Keying on `oxyServices` or `[]` fetches once while anonymous and never recovers when the session lands. The feed (`useFeedState`) keys its initial-fetch effect on `isAuthenticated`/`currentUserId` and invalidates the cached anon feed on identity change. The home feed (`app/(app)/index.tsx`) remounts on the auth-identity key (`isAuthenticated && user?.id ? user.id : 'anon'`).
- **SDK-owned private API readiness.** Use `useAuth().canUsePrivateApi` / `useAuth().isPrivateApiPending` from `@oxyhq/services ^10.2.11` to gate private endpoints (`/managed-accounts`, privacy lists, follow-status mutations, profile/settings, custom feeds). Do NOT add local auth hooks, token helpers, Axios auth interceptors, manual `Authorization` headers, or app-local refresh/session invalidation.
- **SDK-owned SSO callback and cold boot.** The frontend uses `OxyProvider` with a registered `clientId`; SDK cold boot owns stored-session restore, FedCM/silent restore, `/sso` bounce, and `/__oxy/sso-callback` consumption. Do not add per-app callback routes or local SSO helper copies.
- **Mention backend clients use linked SDK clients.** `packages/frontend/utils/api.ts` and `packages/agora/utils/api.ts` adapt `oxyServices.createLinkedClient({ baseURL: API_URL })` into the app's `{ data }` response shape. Refresh and invalidated-token sign-out belong to `@oxyhq/core`/`@oxyhq/services`, not the app.
- **Backend auth middleware comes from core.** Backend APIs use `@oxyhq/core/server` (`createOxyAuthMiddleware`, `createOptionalOxyAuth`, `createOxyRateLimit`, `requireOxyAuth`, `getRequiredOxyUserId`, `authSocket`). Do not define local `AuthRequest`, `requireAuth`, `getUserId`, bearer parsers, or token-decoding middleware. Bearer-authenticated writes do not fetch app-local CSRF tokens; CSRF remains for ambient cookie credentials.
- **Jest does not reproduce this class of bug.** The slow SSO restore only manifests on a real cold boot with a session. Verify in a real browser (foregrounded tab); the `/sso` bounce can take 20–30s.
- **`usePrivacyControls` infinite-401-loop pattern:** `getBlockedUsers`/`getRestrictedUsers` MUST be gated on `canUsePrivateApi` — not just `isAuthenticated`. A 401 must fail quietly (no refetch, no state toggle). Never include `loading` in the auto-refresh effect deps — it self-retrigggers. Same root cause as the auth-cold-boot-reactivity issue above.

## Theming

- **Bloom owns theming.** `BloomThemeProvider` (since v0.6.14) is the single source of truth for mode + color preset, with built-in persistence. Do NOT add a local theme store — pass `persistKey` + `storage` to the provider.
- **Default preset for Mention frontend: `blue`** (not `oxy`).
- **Default preset for Agora: `yellow`** (matches the existing `#FFC107` brand).
- Use NativeWind className-based styles for themed UI whenever a class exists. NativeWind must consume Bloom tokens/classes instead of app-local color wrappers or one-off inline color maps.
- Profile-scoped NativeWind utilities require `@oxyhq/bloom >= 0.8.6`, where `BloomColorScope` emits Tailwind v4 `--color-*` aliases from the same canonical Bloom token resolver.
- Profile-scoped colors must wrap the subtree with `BloomColorScope` before any child calls `useTheme()` / `useBloomTheme()` or renders Bloom components. Split wrapper/content components when needed so hooks run inside the scope.
- Settings UI uses Bloom's `SettingsList` (`SettingsListGroup` / `SettingsListItem` from `@oxyhq/bloom/settings-list`). Do not introduce local `SettingsItem` wrappers — they diverge from Bloom.
- Do not add app-local scoped color variable helpers for profile theming; `BloomColorScope` owns scoped Bloom/NativeWind variables.
- Frontend `app/_layout.tsx` is the only place that wires the provider; consumers read theme via `useTheme()` / `useBloomTheme()` from `@oxyhq/bloom`.
