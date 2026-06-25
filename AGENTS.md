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
- **Federation**: ActivityPub protocol — federated users in Oxy (type: 'federated'), posts in Mention, linked by oxyUserId. HTTP signatures on all outbound requests. Local dev: `cloudflared tunnel --url http://localhost:3000` + set `FEDERATION_DOMAIN` to tunnel domain. Outbox sync uses the actor's advertised `outbox` URL (`fetchRemoteActor`), with `actorUri + '/outbox'` only as fallback — guessing breaks PeerTube/Lemmy/some Pleroma. Boosts (Announce) are imported as `type:'boost'` posts (mirroring native repost shape), deduped by `federation.activityId`, in both inbox push (`handleAnnounce`) and outbox backfill (`syncOutboxPosts`/`extractCandidates`) paths. Likes/boosts from federated actors are stored as NATIVE records (Like doc / boost Post) — `FederationService` no longer copies remote aggregate counts (those were fake numbers with no records); counts only move ±1 in lockstep with real records. `handleLike` resolves the actor to a federated Oxy user and creates a native `Like` doc; `handleAnnounce` creates a native `type:'boost'` Post for ALL boosters. Undo Like/Announce deletes the record + decrements. Added a `Like.postId` index. Reconciliation script: `packages/backend/src/scripts/recomputeFederatedEngagement.ts` (run once via Fargate one-shot: `bun packages/backend/dist/src/scripts/recomputeFederatedEngagement.js`).
- **Boost hydration gotcha:** A `type:'boost'` post has an intentionally EMPTY content body and relies on `boostOf` for hydration. `PostHydrationService` only embeds the boosted original when hydrated at `maxDepth >= 1`. Any endpoint/feed that INCLUDES boosts MUST pass `maxDepth:1` or boosts render blank. Affected: `routes/federation.api.routes.ts` and `mtn/feed/feeds/AuthorFeed.ts` (profile page). Native feeds (ForYou/posts via `feedQueryBuilder`) avoid this by EXCLUDING boosts from their query.
- **Background jobs (BullMQ):** Federation inbound activities are enqueued (inbox 202s fast); `FederationJobScheduler` repeatable jobs replaced setInterval timers; outbound delivery uses BullMQ instead of Mongo `FederationDeliveryQueue`. All env-gated on `REDIS_URL`. BullMQ queue names MUST NOT contain `:` — use `-` (e.g. `federation-inbox`). See global AGENTS.md BullMQ section for the ioredis isolated-linker gotcha.
- **Auth**: Oxy integration via `@oxyhq/core ^3.9.0` + `@oxyhq/services ^11.0.0`
- **Starter Packs**: tool for the VIEWER to follow pack members — one-by-one (per-member `FollowButton`) or all at once ("Follow all" via the multi-user `FollowButton`). There is NO "follow the pack" concept. "Follow all" also calls `starterPacksService.use(id)` to record usage/increment useCount. Detail screen: `app/(app)/starter-packs/[id].tsx` (SDK `FollowButton` multi for follow-all, single per member; Bloom `AvatarGroup` as hero). List rows: backend `GET /starter-packs` enriches each item with `memberAvatars: string[]` (≤8 server-resolved URLs) + `memberCount`; frontend list cards use Bloom `AvatarGroup` (rocket icon as zero-avatar fallback). Owner edit flow: `app/(app)/starter-packs/[id]/edit.tsx` (SearchInput + member rows; 150-member cap; delete pack). Backend supports PUT + POST/DELETE `/starter-packs/:id/members` + DELETE.
- **Lists (subscriptions)**: following a list = SUBSCRIBING (via `EntityFollow` entityType `'list'`) so the viewer sees members' posts WITHOUT following those members individually. `AccountList` has `subscriberCount: number`, maintained by `src/services/ListSubscriptionService.ts` on follow/unfollow; included in list DTOs. Followed-list members' posts are merged into the main feed via `feed.controller.ts` `mergeSubscribedListMemberIds()` (unions subscribed members into `context.followingIds`). Caps: `MAX_SUBSCRIBED_LISTS_FOR_FEED=200`, `MAX_SUBSCRIBED_LIST_AUTHORS_FOR_FEED=5000` (warns when hit). Frontend: `app/(app)/lists.tsx` shows a "Followed lists" section alongside "Your lists"; subscribe button reads "Follow list / Following".

## Profile Identity Contract

- Oxy API owns canonical user display names. User/profile DTOs must provide `name.displayName` as the already-resolved value. Mention frontend renders `name.displayName` directly and must not recompute names from `name.first`, `name.last`, `name.full`, or add local `displayName || username` fallback chains in components.
- Profile update payloads use the shared `UserProfileUpdate` contract from `@oxyhq/contracts` via the SDK/API layers. Do not create Mention-local profile update interfaces for Oxy user fields.
- Mention post DTOs must be produced by `PostHydrationService` (`packages/backend/src/services/PostHydrationService.ts`). Controllers must not hand-build post `user` objects, notification embedded posts, or nearby/feed post responses; hydration is the single place that resolves `PostActorSummary.displayName`, avatar, engagement, permissions, and related post data.
- Profile routes use `getNormalizedUserHandle` from `@oxyhq/core` for local and federated handles. Do not add local profile-route helpers, manually append federated instances, navigate to raw ids, or generate `?username=` profile URLs.
- Valid profile URLs are `/@username` and `/@username@domain`. Duplicate instance suffixes such as `/@user@domain@domain` are bugs in handle normalization and should be fixed at the source.

## Fediverse Discovery of Mention Profiles

Two independent resolution entry points; BOTH must work for full Mastodon compatibility.

**By handle (`@user@mention.earth`):** webfinger `/.well-known/webfinger?resource=acct:...` → `self` link (`type: application/activity+json`) → fetch actor. Server-side route; works.

**By profile URL (`https://mention.earth/@user`):** Mastodon GETs the URL with `Accept: application/activity+json` expecting an actor or a `<link rel=alternate type=application/activity+json>`. The Expo SPA returned HTML with neither → URL resolution failed. Fix: a Cloudflare Pages **Advanced-Mode `_worker.js`** at `packages/frontend/public/_worker.js` (Expo export copies `public/` → `dist/`, so it lands at `dist/_worker.js`, the deploy root for `wrangler pages deploy packages/frontend/dist`). It 302s requests matching `^/@<user>$` with AP Accept header → `https://api.mention.earth/ap/users/<user>` with `Vary: Accept`; all other requests → `env.ASSETS.fetch(request)` (honors the `_redirects` SPA fallback).

**CRITICAL CF Pages gotcha:** a `functions/` directory placed INSIDE the deployed `dist/` is NOT compiled as Pages Functions when using `wrangler pages deploy <dir>` — it is served as a static asset / falls to the SPA. With direct-upload of a build output dir, you MUST use Advanced-Mode `_worker.js` at the output root, not file-based `functions/`. (We shipped `functions/` first; it silently did nothing in prod.)

**Other verified discovery requirements (each was a real blocker):**
- Actor `publicKey.id` host MUST equal the actor `id` host — cross-domain key causes Mastodon to reject the actor.
- Actor `icon.url` must be an absolute, reachable URL.
- `/.well-known/host-meta` must be PUBLIC — the route was missing and fell through to the authenticated catch-all `app.use("/", oxy.auth(), ...)`; returns 401. Fixed by adding public `host-meta` + `host-meta.json` routes in `webfinger.routes.ts`, mounted before auth middleware.

**Diagnostic technique:** to rule out CF bot-blocking of Mastodon's datacenter fetchers, curl the actor/webfinger from an AWS us-west-2 Fargate one-shot using the exact Mastodon UA (`http.rb/5.2.0 (Mastodon/4.3.0; ...)`); 200 + `cf-mitigated: null` header proves not blocked. Note: `api.mention.earth` is DNS-only→ALB (no CF proxy); only the apex `mention.earth` is behind CF and serves `/ap/*` + `/.well-known/*` dynamic redirects (zone-level CF Dynamic Redirect rules, not in the repo). Also: Mastodon negative-caches failed resolutions for minutes/hours — after a fix, cache-bust by searching the full profile URL (different cache key than the acct handle).

## Federated Media Cache

Remote/federated post media (images, video, audio) is proxied and cached through the backend:

- **Proxy endpoint**: `GET /media/proxy?url=<remote url>` — SSRF-guarded (DNS-pinned, IP denylist, per-hop redirect re-validation, content-type allowlist image/video/audio, SVG rejected, range requests supported). Frontend rewrites federated media URLs to this proxy via `proxyExternalUrl()` in `packages/frontend/utils/imageUrlCache.ts`.
- **Video poster endpoint**: `GET /media/poster?url=<video url>` — extracts a frame via ffmpeg (sandboxed: bounded download to temp file, `-protocol_whitelist file`, no network). Dockerfile installs ffmpeg. Frontend helper: `videoPosterUrl()`.
- **S3 activity cache**: on proxy access, media is uploaded to Oxy S3 via `POST /assets/service/cache` on oxy-api (service-token-scoped, reserved `federation-media-cache` namespace). Cached entries are served via 302 to the Oxy CDN. Entries unused for 30 days are evicted and re-cached on next access. Model: `FederatedMediaCache`.
- **Key code locations**: `packages/backend/src/services/mediaCache/*`, `routes/media.ts`, `utils/safeUpstreamFetch.ts`, `utils/ssrfGuard.ts`, `utils/videoPoster.ts`.
- **Gated by env**: `FEDERATION_MEDIA_CACHE_WRITE_ENABLED=true` (set on the mention ECS task in `oxy-infra/terraform-uswest2/app-services-realtime.tf`). Unset = proxy works but nothing is written to S3.
- **Post storage**: federated media URLs are stored RAW (remote) on the post (`content.media[].id`). The cache keys off the remote URL and never rewrites the post.
- **SSM secrets**: `OXY_SERVICE_API_KEY` + `OXY_SERVICE_API_SECRET` are live in SSM at `/oxy/mention/OXY_SERVICE_API_KEY` and `/oxy/mention/OXY_SERVICE_API_SECRET`, wired into the ECS task definition.
- **Error classification + negative cache (shipped 2026-06-21, tests 382/382):** upstream 4xx (deleted/protected media) were previously relayed as our 502, causing ~12% 5XX rate on the ALB target group. Fix: `classifyUpstreamStatus` in `routes/mediaProxyStatus.ts` maps upstream 4xx → our 404 (logged debug), genuine upstream 5xx + connection errors → 502, oversized body → 413. A **negative cache** (`services/mediaCache/negativeCache.ts`) backed by the existing Redis singleton (`mediaproxy:neg:<sha256(url)>`, client-error TTL 600s, connection-error TTL 60s, graceful no-op when `REDIS_URL` unset) short-circuits known-dead URLs to 404 with zero upstream fetch. First-byte/headers timeout tightened 10s→8s (`UPSTREAM_HEADERS_TIMEOUT_MS` in `safeUpstreamFetch.ts`); post-headers stream timers (`UPSTREAM_SOCKET_TIMEOUT_MS=30s` / `MAX_REQUEST_DURATION_MS=60s`) unchanged so large videos still stream.
- **Perf context:** infra is NOT resource-bound (Mongo ~1%, Valkey ~0.5%, ECS CPU 1–4%); the 5XX + p99 tail were purely this endpoint's outbound-federation I/O + mislabeling. Do NOT scale instances for this.

## Canonical Media URL — `cloud.oxy.so`

The canonical Oxy media URL is **`https://cloud.oxy.so/<fileId>?variant=<v>`**. The ONE chokepoint is `@oxyhq/core` `getFileDownloadUrl(id, variant)` (core 3.7.1+): public assets → `cloud.oxy.so/<id>?variant=`; signed/private → `api.oxy.so/assets/<id>/stream?...&token=`.

- **Do NOT** build per-app `resolveAvatarUrl` helpers, per-DTO `avatarUrl` fields, or `enrichAvatarUrls` serializers — that was tried and reverted (Mention commits e066a531 reverted 91f06b51).
- Mention backend `utils/mediaResolver.ts` builds federated actor `icon.url` via `getFileDownloadUrl` → `https://cloud.oxy.so/<id>?variant=thumb` (verified live).
- CloudFront `cloud.oxy.so` default behavior = `media-api` custom origin (api.oxy.so, OriginPath `/cdn`); `cloud.oxy.so/<id>` → oxy-api `GET /cdn/:id` (`packages/api/src/routes/cdn.ts`, public, no auth) → 302 → `cloud.oxy.so/<key>` for public assets, 404 for private/unknown; edge-cached 1h. `api.oxy.so/assets/:id/stream` also 302s public media to CDN (commit 4434ce8c). Public bytes live under the S3 `public/` prefix.
- Mention pins `@oxyhq/core ^3.9.0` (root override). `createLinkedClient` now defaults to `enableCache:false` — the frontend's React Query owns caching; do not re-enable GET caching on linked clients.

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

## Oxy SDK Conventions

- **Versions**: `@oxyhq/core ^3.10.0` (root override), `@oxyhq/services ^11.0.0`, `@oxyhq/bloom ^0.19.1`, `@oxyhq/contracts ^0.2.1` (transitive via core). `@oxyhq/services ^11.0.0` is a packaging-only major — deps moved to peerDependencies; ensure root `package.json` declares the required peers (`@tanstack/react-query`, `@tanstack/react-query-persist-client`, `@tanstack/query-async-storage-persister`).
- **Media**: avatars/images resolve ONLY through `oxyServices.getFileDownloadUrl(id, variant)` (or bloom's variant-aware `<Avatar source={fileId} variant="thumb">`). Never hardcode `cdn.oxy.so`/`cloud.oxy.so`/`/media/` URLs in components.
- **Display names**: render `name.displayName` directly (core 3.10 fixes the type under node resolution). No local name fallbacks from `name.first`/`name.last`/`username`.
- **Backend auth**: `@oxyhq/core/server` only — `createOxyAuthMiddleware`/`getRequiredOxyUserId`/`authSocket`. No local `requireAuth`, bearer parsers, or token-decoding middleware.
- **Notifications**: `POST /notifications` is server-authored — no client mass-assignment of notification fields.
- **Debug routes**: the `/test` debug route was removed in production. Do not re-add it.

## Auth Cold-Boot Reactivity (Web)

On web, the session restores asynchronously after mount — the `/sso` path can take 5–25s. The SDK auth state (`useAuth()` `isAuthenticated` / `user`) IS reactive, but consumers must treat it as such:

- **Key data fetches on identity, not on the stable singleton.** React Query keys and `useEffect` deps must include `isAuthenticated` / `user?.id`. Keying on `oxyServices` or `[]` fetches once while anonymous and never recovers when the session lands. The feed (`useFeedState`) keys its initial-fetch effect on `isAuthenticated`/`currentUserId` and invalidates the cached anon feed on identity change. The home feed (`app/(app)/index.tsx`) remounts on the auth-identity key (`isAuthenticated && user?.id ? user.id : 'anon'`).
- **SDK-owned private API readiness.** Use `useAuth().canUsePrivateApi` / `useAuth().isPrivateApiPending` from `@oxyhq/services ^11.0.0` to gate private endpoints (`/managed-accounts`, privacy lists, follow-status mutations, profile/settings, custom feeds). Do NOT add local auth hooks, token helpers, Axios auth interceptors, manual `Authorization` headers, or app-local refresh/session invalidation.
- **SDK-owned SSO callback and cold boot.** The frontend uses `OxyProvider` with a registered `clientId`; SDK cold boot owns stored-session restore, FedCM/silent restore, `/sso` bounce, and `/__oxy/sso-callback` consumption. Do not add per-app callback routes or local SSO helper copies.
- **Mention backend clients use linked SDK clients.** `packages/frontend/utils/api.ts` and `packages/agora/utils/api.ts` adapt `oxyServices.createLinkedClient({ baseURL: API_URL })` into the app's `{ data }` response shape. Refresh and invalidated-token sign-out belong to `@oxyhq/core`/`@oxyhq/services`, not the app.
- **Backend auth middleware comes from core.** Backend APIs use `@oxyhq/core/server` (`createOxyAuthMiddleware`, `createOptionalOxyAuth`, `createOxyRateLimit`, `requireOxyAuth`, `getRequiredOxyUserId`, `authSocket`). Do not define local `AuthRequest`, `requireAuth`, `getUserId`, bearer parsers, or token-decoding middleware. Bearer-authenticated writes do not fetch app-local CSRF tokens; CSRF remains for ambient cookie credentials.
- **Jest does not reproduce this class of bug.** The slow SSO restore only manifests on a real cold boot with a session. Verify in a real browser (foregrounded tab); the `/sso` bounce can take 20–30s.
- **`usePrivacyControls` infinite-401-loop pattern:** `getBlockedUsers`/`getRestrictedUsers` MUST be gated on `canUsePrivateApi` — not just `isAuthenticated`. A 401 must fail quietly (no refetch, no state toggle). Never include `loading` in the auto-refresh effect deps — it self-retrigggers. Same root cause as the auth-cold-boot-reactivity issue above.

## Web Feed / Virtualization Gotchas

### Virtualizer `getTotalSize()=0` breaks sticky side rails (PROD-only)

**Symptom:** Sticky side rails detach after one viewport of scroll; side rail container stays capped at viewport height. Does NOT reproduce on the dev server — only on `expo export web` + serve (production build).

**Root cause:** `Feed.web.tsx` uses `@tanstack/react-virtual` `useWindowVirtualizer`. Absolutely-positioned rows live inside a spacer `<div style={{height: totalSize}}>`. On the minified prod build, `getTotalSize()` can return `0` even though rows have measured real heights → 0px spacer → rows overflow without growing the feed column → the flex-row containing block stays at viewport height → rails scroll away.

**Fix:** size the spacer to `Math.max(totalSize, lastItemEnd)` (the actual mounted-row extent). `lastItemEnd` = `virtualItems.at(-1)?.end ?? 0`.

**Meta:** ALWAYS verify feed/virtualization/sticky layout bugs on a PROD build (`expo export web`), not the dev server. The dev server does not reproduce minification-timing issues.

### `hasMore` must come from the authoritative overfetch, NOT slice count

**Symptom:** Infinite scroll stalls after page 1 across ALL 9 sliced feeds (home, explore, hashtag, trend, etc.).

**Root cause:** `packages/backend/src/utils/FeedResponseBuilder.ts` computed `hasMore` from `slicesToReturn.length >= limit`. Slices are post GROUPS (thread slicing), so a full 20-post page can produce only 18 slices after thread grouping / hydration dedup → `hasMore: false` on a page that has more content.

**Fix:** `hasMore = <authoritative overfetch hasMore> && nextCursor !== undefined`. Regression test: `packages/backend/src/__tests__/feedResponseBuilder.test.ts`.

### NEVER block the feed response on remote link-preview / image fetching

**Symptom:** Link-heavy or federated feeds (e.g. the authenticated home feed) take 250–300 seconds, clients time out and retry in a loop. Fully exposed after a backend restart that clears the warm cache.

**Root cause:** `PostHydrationService.buildLinkPreviewMap` awaited `linkMetadataService.fetchMetadata` (full remote HTML fetch, 10 s timeout, serial batches) for EVERY feed URL with NO persistence → every render re-fetched all external links.

**Fix:** Persist previews in Redis (`packages/backend/src/services/linkPreviewCache.ts`, mirrors the `mediaCache`/`negativeCache` pattern). Bounded `readPreviews` ≤250 ms with NO remote I/O on the response path. Cache misses warm fire-and-forget (detached, single-flight, concurrency-capped, negative markers). Tighten `linkMetadataService`/`imageCacheService` timeouts to 6 s, no retries, background-only.

**Rule:** Image/link-metadata caching is best-effort and MUST NEVER be awaited on the feed/hydration critical path. Any function that touches remote URLs must be detached before the feed response returns.

### Feed debugging verification rules

- **Do NOT use `document.body.scrollHeight` growth to confirm pagination.** `scrollHeight` grows when virtualizer rows measure on mount, even before page-2 data loads — this is a false positive. The real signal is a page-2 `GET /feed/mtn?...&cursor=...` request firing in DevTools network tab + item count exceeding page-1 size.
- **Always verify on a PROD build + prod API.** The local dev server has no auth-gated content; the local backend has no real federation data. Use `expo export web && bun --bun serve packages/frontend/dist` and point at the prod API (or use `CloudWatch /oxy/ecs`, service `mention`) to diagnose tail-latency and pagination bugs.

## Web Feed Architecture (unified path)

`packages/frontend/components/Feed/Feed.web.tsx` contains two components:

- **`VirtualizedWebFeed`** — document-scroll `useWindowVirtualizer`; the SINGLE scroll-owning path for all feed screens (home, explore, hashtag, trend, profile, post-detail `p[id]`). `useWebFeed` is the single data owner.
- **`EmbeddedWebFeed`** — kept ONLY for genuinely nested sub-lists (e.g. a replies list inside a modal). Do NOT use it for top-level feed screens.

Panel chrome insets are centralized in `packages/frontend/components/shell/PanelChrome.tsx` (`PANEL_TOP_INSET` constant, `<PanelStickyHeader>`, `<PanelStickyFooter>`). Do NOT add per-page `web:top-2` or custom inset padding to individual feed screens — compose `PanelChrome` primitives so sticky chrome stays clear of the bleed-mask.

## Feed Performance & Ranking

### Hydration author-batch (M+1 fix)
`PostHydrationService.buildUserMap` batch-resolves post authors via `oxyServices.getUsersByIds` (feature-detected; per-id fallback). New `services/userSummaryCache.ts` caches `PostActorSummary` + followerCount in Redis (key `usersummary:v1:<id>`, 10m TTL; mirrors `linkPreviewCache` pattern; no-op without `REDIS_URL`).

### Real view counts
Feed impressions increment `Post.stats.viewsCount` deduped per (viewer, post) via `services/feedViewCounter.ts` (Redis SET NX EX, key `viewseen:<postId>:<viewerId>`). Frontend reports impression/dwell/click via `feedService.sendFeedInteraction` (was unwired) — see `utils/feedTelemetry.ts`.

### Instant post-detail open
Memory-mode feeds (web + scoped) seed the shared post cache (`postsStore.cachePosts`) in `useFeedState`; `app/(app)/p/[id].tsx` paints from cache + background-revalidates (`revalidatePostById`) instead of cold-fetching.

## Feed Ranking, Content Classification & Safety

### Unified Content Classification (two-stage hybrid)

All posts — native AND federated — go through the same classification pipeline at ingest.

**Stage A — deterministic baseline (`services/BaselineContentClassifier.ts`, pure/sync):**
Runs at ALL ingest chokepoints: `PostCreationService`, `feed.controller` reply path, `OutboxSyncService.insertMany`, `InboxProcessingService`. Writes a `postClassification` subdoc containing:
- `languages: string[]` — **SINGLE canonical multi-language field** (ALL detected/declared ISO 639-1 codes, primary first, deduped, cap 3). The old single `postClassification.language` field was REMOVED (full migration, no dual field). Native detection: tinyld `detectAll` with a combined gate (`secondaryMinAccuracy:0.2` AND `secondaryMinRatioToTop:0.5`) — a single absolute threshold can't separate a real 2nd language from tinyld's noise tail. Federated: `extractApLanguages` reads AP top-level `language` + EVERY `contentMap` key (explicit/declared set is AUTHORITATIVE over detection). `utils/federation/apLanguage.ts`.
- Top-level `post.language` (the ActivityPub protocol field) is kept = `languages[0]` (primary). Set at every ingest site: `PostCreationService`, `OutboxSync` note path, `posts.controller` edit-reclassify, `feed.controller` reply; inbox/boost flows through `PostCreationService`.
- `region` — best-effort
- normalized hashtags
- rule-based topics via the pluggable `TopicClassifier` interface (`services/contentClassification/TopicClassifier.ts`)
- `sensitive`, `spam`, `quality`, and `toxicity` scores (`services/contentClassification/spamQuality.ts`)
- status set to `'pending'` (waiting for Stage B)

Feed language-match is **ANY-OVERLAP** on `postClassification.languages` (`$in` / `.some()`) at all 3 sites: `FeedRankingService`, `ExploreFeed` (`$setIntersection` over `$ifNull:['$postClassification.languages',[]]`), `forYouCandidateSources`. NO scalar fallback — absent → neutral. `UserPreferenceService` preferred-language learning still reads the top-level `post.language` (dominant language) — that is correct behavior, not a leftover.

`BASELINE_CLASSIFIER_VERSION = 4` (multi-language ruleset). Stamps the version on every post classified at write/ingest time. `FeedRankingService` only honors classification scores whose stamped `version >= BASELINE_CLASSIFIER_VERSION` (or that are AI-`classified`); posts below the baseline are treated as having no usable signal (neutral, never penalized). The corpus backfill to v4 is DONE (56 456 posts re-baselined 2026-06-24). `scripts/backfillContentClassification.ts` and its test were REMOVED — new posts classify at ingest. If a future version bump needs to re-baseline existing posts, author a new one-shot Fargate task (git history has the old pattern).

**Stage B — async AI enrichment (`PostClassificationService`, Alia):**
Uses a DOTTED `$set` to enrich the existing subdoc — NEVER a whole-subdoc overwrite (that would wipe Stage A fields). Topics are canonical via `postClassification.topicRefs` (`{name, topicId}`) resolved through `TopicService.resolveTopicRefs`. Readers (`FeedRankingService`, `UserPreferenceService`, `TrendingService`, `getPostsByTopic`) prefer `topicRefs`, fall back to legacy `extracted.topics`, then to neutral.

**CRITICAL GOTCHA — Alia AI layer is INERT in prod:** `ALIA_API_KEY` is NOT in SSM. `POST_CLASSIFICATION_ENABLED=true` is set in the ECS task but does nothing without the key. Only the deterministic Stage-A rule layer is live. `extracted.topics` + its `TopicExtractionService` batch still exist and are slated for removal once Stage B is wired.

**GOTCHA — never honor default-zero scores:** Ranking is gated on `status === 'classified' OR version >= BASELINE_CLASSIFIER_VERSION` before trusting quality/spam/toxicity values. The schema's default all-zeros scores must never be counted as real signal.

### Centralized Feed Safety Gating

`mtn/feed/feedSafety.ts` is the SINGLE source of truth for sensitive/NSFW filtering. Exports:
- `SENSITIVE_EXCLUDE_MATCH` / `NSFW_HASHTAG_EXCLUDE_MATCH` / `DISCOVERY_SAFE_MATCH` — reusable Mongo query clauses
- `isSensitivePost` / `isSfw` / `isDiscoverable` / `filterDiscoverable` — composing primitives from `services/contentClassification/nsfw.ts`

EVERY feed and surface imports from `feedSafety.ts` — ForYou + `fetchPopular`, `forYouCandidateSources`, `ExploreFeed`, `TrendingService`, `FeedRankingService`. NEVER re-implement the sensitive/NSFW check inline in a feed (a missing copy in `fetchPopular` was the NSFW-in-For-You leak that prompted this centralization).

Per-user `privacy.showSensitiveContent` (default `false`, `UserSettings` + `PUT /profile/settings`) makes gating viewer-conditional. Anon/unset/Videos/Media surfaces default to SFW.

### For You Ranking (`FeedRankingService.rankPosts`)

`rankPosts` is the ONE ranking path for ForYou, Explore, Videos, and Media feeds.

**Candidate generation** (`mtn/feed/feeds/forYouCandidateSources.ts`): multi-source, bounded, parallel — following, affinity, topic/language/region match, trending, and global discovery (discovery sources are always SFW). Replaced the old "rank the 60 newest global posts" approach.

**Ranking signals (config in `packages/shared-types/src/mtn/config.ts`):**
- Author authority: bounded follower-count log-scale signal (`ranking.authority { logScale, min, max }`), roughly ~[0.9, 1.4] with a popularity floor
- AI + deterministic quality/spam/toxicity via `ranking.aiQuality` — provenance-gated (neutral when scores absent per the zero-default rule above)
- Recalibrated weights: `viewWeight` 0.1 → 0.3; diversity `sameAuthorPenalty` 0.95 → 0.85, `sameTopicPenalty` 0.92 → 0.80
- `ExploreFeed`: additive recency replaced with multiplicative exponential decay
- Author-diversity rerank: `diversifyByAuthor` runs BEFORE page truncation; only the page window is hydrated

**`userBehavior` context wired:** `feed.controller` now loads `userBehavior` into context on every ForYou request — affinity and preferred-topic signals were previously dead because this was never populated.

**Never-blank fallback:** when the unseen pool is exhausted (seen-set 1000 cap / 30-min TTL), ForYou falls back to `fetchPopular`.

### Key Gotchas

- **Explore aggregation `$subtract` type mismatch:** `$subtract` with `Date.now()` (JS number) instead of a `Date` object causes a MongoDB `TypeMismatch` 500 on the Explore aggregation pipeline. The operand must be `new Date()`, not `Date.now()`.
- **Run backend tests from the package root:** `cd packages/backend && bun run test`. Running vitest from the repo root picks up stale `.dist` test copies → false failures. Always run from `packages/backend`.
- **Surface-aware engagement attribution:** a like/save/boost from the Videos/reels feed (`source` / `feedContext` = feed descriptor) dampens author affinity (`videoSurfaceAuthorAffinityFactor=0.25`) while boosting topic + post-type affinity (`videoSurfaceContentBoost=1.3`). `Like.source` is persisted; `ContentAffinityService` discounts video-surface likes in the 30-day author-candidate scan. Frontend threads `source` on like/save/boost including the `videos.tsx` reels viewer. Config: `preferences.engagementContext` + exported `isVideoSurface()` in shared-types config.
- **MongoDB text-index `language_override` vs content-language field (prod incident 2026-06-24):** The posts text index (`content.text_text`) by default uses a per-document field literally named `language` as the stemmer `language_override`. Once `post.language` started holding arbitrary detected ISO codes (`ar`/`no`/`pl`/…), MongoDB REJECTED writes with error 17262 `"language override unsupported"`, breaking BOTH ingest of non-English posts AND the corpus backfill. FIX: the text index in `models/Post.ts` is now declared with `default_language:'english'`, `language_override:'textSearchLanguage'` (a field NO document has → MongoDB always falls back to English stemming and ignores `post.language`), `name:'content.text_text'`, `weights:{'content.text':1}`. The inline `index:'text'` shorthand on `content.text` was removed. The live prod index was recreated out-of-band to match. **Rule: never let a text index's `language_override` resolve to a field that holds free-form content-language codes — point it at a sentinel field that no document populates.**

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
