# Mention

> Parent files (`~/AGENTS.md`, `~/Oxy/AGENTS.md`) hold universal standards, the agent team, shared-SDK rules, SDK version targets, Bloom/Expo/expo-router gotchas, and the infra pointer. This file holds ONLY Mention-specific content.

## AWS Deployment

- **Port**: `3000` | **Domain**: `api.mention.earth`
- **ECR**: `237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/mention`
- **Deploy**: `git push origin main` → `.github/workflows/deploy-aws.yml` builds `linux/arm64` → ECR → `ecs update-service --force-new-deployment`
- **Auth**: GitHub OIDC → role `oxy-github-deploy`. No AWS keys in GitHub.
- **Secrets**: GitHub Actions secrets → synced to SSM `/oxy/mention/*`; ECS injects them. Change a secret in GitHub — the next deploy applies it.

## Commands

```bash
bun run dev                 # All packages dev mode
bun run dev:frontend        # Frontend dev (Expo tunnel)
bun run dev:backend         # Backend dev (watch mode)
bun run dev:mcp             # MCP server dev
bun run build               # shared-types + backend + mcp
bun run build:frontend      # Frontend only
bun run build:backend       # shared-types then backend
bun run test                # Test all
bun run lint                # Lint all
bun run clean               # Remove all node_modules
```

Run backend tests from the package root: `cd packages/backend && bun run test` (running from the repo root picks up stale `.dist` copies → false failures).

## Local Android device build

To produce a TRUE standalone release APK (no Metro / no Expo DevLauncher) for on-device testing:

```bash
cd packages/frontend/android
NODE_ENV=production ./gradlew :app:assembleRelease \
  -x lintVitalRelease \
  -PreactNativeArchitectures=arm64-v8a \
  -Dorg.gradle.jvmargs="-Xmx8g -XX:MaxMetaspaceSize=1g"
```

- **`NODE_ENV=production` is REQUIRED.** Without it the `export:embed` Gradle task aborts ("NODE_ENV environment variable is required but was not specified") and the APK ships with NO embedded `assets/index.android.bundle` — it becomes a dev-client build that shows Expo DevLauncherActivity and needs a running Metro server. With it, the JS bundle embeds and the app opens standalone. Verify: `unzip -l app-release.apk | grep index.android.bundle`.
- **Build arm64-only** (`-PreactNativeArchitectures=arm64-v8a`): the multi-ABI build fails at `:app:buildCMakeRelWithDebInfo[x86]`, and test devices (Pixel) are arm64. `-Xmx8g` avoids R8/native OOM.
- **Metro dev builds** (not release): Metro MUST run from `packages/frontend`, NOT the monorepo root. From the root, Expo resolves the legacy `expo/AppEntry` entry (imports a non-existent `App`) instead of `expo-router/entry`, returning HTTP 500 and crashing the app on load.

## Architecture

Monorepo using Bun workspaces.

```
packages/
  frontend/       @mention/frontend    Expo 56 / React Native 0.85.3 / React 19
  backend/        @mention/backend     Express 5.2 / Mongoose 9.3 / Redis / Socket.io
  shared-types/   @mention/shared-types TypeScript type definitions
  mcp/            @mention/mcp         Model Context Protocol server for Claude
```

### Key Tech

- **Frontend**: Expo Router, NativeWind + TailwindCSS 4.2, TanStack React Query, Zustand, Socket.io-client, LiveKit
- **Backend**: Express 5, Mongoose 9, Redis 5, Socket.io, LiveKit Server SDK, Firebase Admin, AWS S3

## MTN Protocol (Mention's signed-records layer)

Mention posts are dual-written as signed records on a per-user hash chain — the "MTN Protocol" — riding on the shared `@oxyhq/protocol` engine. Native Mongo remains authoritative; the chain write is best-effort, isolated (`Promise.allSettled`), and gated on local authors (`federation == null && oxyUserId`).

Key pieces in `packages/backend/src/services/mtn/`:

- **`MentionRecordService`** — thin write API: `signAndAppend(oxyUserId, collection, rkey, payload)` builds the DID, reads the chain head, custodially signs with `MENTION_PRIVATE_KEY` (`issuer = MENTION_DID`), and calls `verifyAndAppend` from `@oxyhq/protocol`. Retries on `chain_conflict`/`bad_seq`. Inert-without-env: returns `{ok:false, reason:'disabled'}` when keys are unset.
- **`MentionSignedRecord` / `MentionRepoHead`** — Mention's own Mongo models for the chain (keyed by `oxyUserId`). Implemented via `MentionRecordStore` (the `RecordStore` adapter over these models).
- **`PostMaterializer`** (`projectRecord`) — the SINGLE writer of first-party `Post` rows FROM verified records (used by backfill and future node ingest). Resolves `embed.blob.sha256` → fileId via the reverse SHA-256 lookup. Idempotent, fail-soft, never throws.
- **`mentionVerificationResolver`** — the Mention authorization policy injected into the `@oxyhq/protocol` engine: self-issued records (`issuer === subject`) use the subject's Oxy verification methods; custodial records (`issuer === MENTION_DID`) accept `MENTION_PUBLIC_KEY`.
- **Custodial signing** — web posts are signed server-side (`issuer = MENTION_DID`); native = `issuer === subject`. `MENTION_DID` / `MENTION_PRIVATE_KEY` / `MENTION_PUBLIC_KEY` env vars gate this.
- **`mention-node`** — a self-hostable node a user runs to own their own chain; synced bidirectionally via `MentionNodeSyncService` + `MentionNodeScheduler` (leader-gated background sweeps).
- **Lexicons** `app.mention.feed.*` live in `@oxyhq/contracts`.

The MTN core never knows about ActivityPub or Bluesky — external networks go through the Connectors module (see below).

## External Network Connectors

External networks are a pluggable module at `packages/backend/src/connectors/`:

- **`types.ts`** — the `NetworkConnector` interface + normalized DTOs (`NormalizedExternalActor`, `NormalizedExternalPost`, `LocalNetworkEvent`). Intentionally free of Mongoose so the layer can be extracted later.
- **`ConnectorRegistry`** — holds only `enabled` connectors (filtered at construction); fans out via `Promise.allSettled` so one connector's failure never aborts others. Implements the `PostFederator` seam registered in `serviceRegistry` — `PostCreationService` never knows any network exists.
- **`activitypub/ActivityPubConnector`** — Mastodon/fediverse. Env gate: `FEDERATION_ENABLED` (defaults ON).
- **`atproto/AtprotoConnector`** — Bluesky READ/discovery only (resolve handles, mirror profiles/posts). Env gate: `ATPROTO_ENABLED` (defaults OFF).
- **`atproto/bridge/`** — the be-discovered bridge: makes a local user's repo readable FROM atproto. Env gate: `ATPROTO_BRIDGE_ENABLED` (defaults OFF — keep dark unless explicitly enabling).
- **`resolve.ts`** (`classifyQuery`) — unified handle classification: `@user@host`/`user@domain` → activitypub; `*.bsky.social`/`did:*`/`at://`/bare handle → atproto; `@username`/local → Oxy.

The old `services/FederationService.ts` facade has been replaced by the connectors module. Code that previously imported from `FederationService` now imports from the relevant connector or the registry.

### Feed System (MTN)

Feeds live in `backend/src/mtn/` — ForYou, Following, Author, Hashtag, Explore, Custom, Videos feeds + tuners.

- `videos` feed descriptor → `VideosFeed` (`packages/backend/src/mtn/feed/feeds/VideosFeed.ts`) — ranked feed of video posts (native + federated), powers the fullscreen Reels viewer (`packages/frontend/app/(app)/videos.tsx`). The legacy `type:'media'` global descriptor does NOT exist — returns 400.
- **Boost hydration gotcha:** A `type:'boost'` post has an intentionally empty body and relies on `boostOf` for hydration. `PostHydrationService` only embeds the boosted original at `maxDepth >= 1`. Any endpoint/feed that INCLUDES boosts MUST pass `maxDepth:1` or boosts render blank. Affected: `routes/federation.api.routes.ts` and `mtn/feed/feeds/AuthorFeed.ts`. Native feeds (ForYou/posts via `feedQueryBuilder`) avoid this by excluding boosts.
- **`hasMore` from authoritative overfetch:** `FeedResponseBuilder` computes `hasMore` from the overfetch flag, NOT `slicesToReturn.length >= limit` — post groups (thread slicing) can produce fewer slices than limit items, causing premature `hasMore: false`.

### Federation (ActivityPub — via connectors)

ActivityPub is implemented as the `activitypub/ActivityPubConnector` inside the connectors module (see External Network Connectors above). Federated users are type `'federated'` in Oxy, posts in Mention, linked by `oxyUserId`. HTTP signatures on all outbound requests.

- **Local dev**: `cloudflared tunnel --url http://localhost:3000` + set `FEDERATION_DOMAIN` to the tunnel domain.
- **Outbox sync** uses the actor's advertised `outbox` URL; `actorUri + '/outbox'` is fallback only — guessing breaks PeerTube/Lemmy/some Pleroma. Lives in `connectors/activitypub/outbox.service.ts`.
- **Boosts** imported as `type:'boost'` posts, deduped by `federation.activityId`, in both inbox push (`handleAnnounce`) and outbox backfill paths.
- **Likes/boosts from federated actors** stored as NATIVE records (Like doc / boost Post). The AP connector does NOT copy remote aggregate counts — counts only move ±1 in lockstep with real records.
- **Inbound follows bridge to the Oxy graph**: `handleIncomingFollow` requires the actor's `oxyUserId` and creates the Oxy edge via oxy-api `POST /federation/follow` (service auth, scope `federation:write`, follower must be Oxy type `'federated'`, idempotent) BEFORE sending Accept; `handleUndo` removes it. `FederatedFollow` stays the AP-side record; the Oxy graph is what the app UI (followers list, `_count`, notifications) reads. Follow notifications: `type:'follow'` via `createNotification`.
- **Local actor JSON**: banner comes from `UserSettings.profileHeaderImage` emitted as AP `image`; outbox pages and push delivery share `buildCreateNoteActivity` (url/tags/attachments) so they stay in sync; post objects dereference at `GET /ap/users/:username/posts/:id`. Old-post visibility on Mastodon is push-only for NEW posts — old posts only appear via URL-search import or the ≥4.4 outbox backfill on first discovery; there is no `featured` collection yet.
- **Engagement reconciliation**: `packages/backend/src/scripts/recomputeFederatedEngagement.ts` (run via Fargate one-shot: `bun packages/backend/dist/src/scripts/recomputeFederatedEngagement.js`).
- **One-shot scripts in `src/scripts/` MUST `mongoose.disconnect()` and `process.exit()` when done** — imported singletons (BullMQ Redis connections, MediaCache workers) otherwise keep the Fargate one-shot task running forever.
- **Background jobs (BullMQ):** Federation inbound activities enqueued (inbox 202s fast, worker runs `processInboxActivity`); `FederationJobScheduler` repeatable jobs; outbound delivery via BullMQ. All env-gated on `REDIS_URL`. Queue names must not contain `:`; see `~/Oxy/AGENTS.md` for the BullMQ job-id `:` gotcha.

### Fediverse Sharing Consent

- **Per-user consent**: Oxy owns `privacySettings.fediverseSharing` (default `true`); user DTOs expose the PUBLIC derived boolean `fediverseSharing` (absent ⇒ enabled). Mention NEVER stores the flag.
- **Read path**: `packages/backend/src/services/fediverseSharing.ts` is the ONLY read path — Mention Redis `fedisharing:v1:<id>` is the single cache authority; all SDK reads for consent use `{ cache:false }` (the SDK's own 5-min GET cache must never feed consent decisions). Gates: webfinger + all user AP surfaces 404 when off (indistinguishable from unknown user); inbound NEW engagement (Follow/reply/Like/Announce) dropped for local OFF owners; Undo handlers stay UNGATED (teardown must converge); outbound gated at `ConnectorRegistry.deliver` + `/federation/follow|unfollow` routes (403). Fail-open on Oxy outage everywhere EXCEPT the cleanup job's guard (tri-state; `'unavailable'` throws for BullMQ retry) and inbox POST (`'unavailable'` proceeds 202 — a 4xx makes Mastodon drop deliveries forever).
- **Toggle flow**: frontend writes to Oxy (SDK `updatePrivacySettings`) then calls Mention `POST /federation/sharing-changed` (re-reads the flag server-side; ON→OFF enqueues `federation-sharing-cleanup`: `Delete(actor)` broadcast → bridge-unfollow → ID-scoped row deletion, throw-on-partial for retry; also invalidates the webfinger JRD cache).
- **UI**: `FediverseInfoSheet` (Bloom `BottomSheet`, 3 steps) + `FediverseBadge` + `settings/fediverse.tsx`; i18n `fediverse.*` (en/es/it).
- **Author hydration rule** (from the ghost-handle bug, `1301f07b`): author hydration must NEVER emit a raw `oxyUserId` as `handle`/`displayName` — unresolved authors get the degraded summary (empty handle, `'Unknown user'`), never cached in Redis. No `/@<id>` links.

Spec/plan: `docs/superpowers/specs/2026-07-02-fediverse-sharing-consent-design.md`, `docs/superpowers/plans/2026-07-02-fediverse-sharing-consent.md`.

### Starter Packs

Tool for the VIEWER to follow pack members — one-by-one or all at once via multi-user `FollowButton`. "Follow all" also calls `starterPacksService.use(id)`. There is NO "follow the pack" concept.

- Detail screen: `app/(app)/starter-packs/[id].tsx`. Owner edit: `app/(app)/starter-packs/[id]/edit.tsx` (150-member cap).
- `GET /starter-packs` enriches each item with `memberAvatars: string[]` (≤8) + `memberCount`.
- Backend: `PUT /starter-packs/:id`, `POST/DELETE /starter-packs/:id/members`, `DELETE /starter-packs/:id`.

### Lists (Subscriptions)

Following a list = SUBSCRIBING via `EntityFollow` entityType `'list'` — viewer sees members' posts without following individually. `AccountList.subscriberCount` maintained by `src/services/ListSubscriptionService.ts`. Subscribed-list members merged into main feed via `feed.controller.ts` `mergeSubscribedListMemberIds()`. Caps: `MAX_SUBSCRIBED_LISTS_FOR_FEED=200`, `MAX_SUBSCRIBED_LIST_AUTHORS_FOR_FEED=5000`.

## Profile Identity

- Post DTOs MUST be produced by `PostHydrationService` (`packages/backend/src/services/PostHydrationService.ts`). Controllers must not hand-build post `user` objects, notification embedded posts, or feed post shapes.
- Profile routes use `getNormalizedUserHandle` from `@oxyhq/core`. Valid URLs: `/@username` and `/@username@domain`. Duplicate suffixes (`/@user@domain@domain`) are bugs in handle normalization.

## Fediverse Discovery of Mention Profiles

Two resolution entry points; BOTH must work for full Mastodon compatibility.

**By handle (`@user@mention.earth`):** webfinger `/.well-known/webfinger?resource=acct:...` → `self` link → fetch actor.

**By profile URL (`https://mention.earth/@user`):** Mastodon GETs the URL with `Accept: application/activity+json`. Handled by the CF Pages Advanced-Mode `_worker.js` at `packages/frontend/public/_worker.js` (Expo export copies `public/` → `dist/`). Profile URLs matching `^/@<user>$` with AP Accept → 302-redirect to the canonical actor at `https://api.mention.earth/ap/users/<user>` (GET-only content negotiation — redirecting here is correct). The federation ENDPOINT paths — `/ap/*`, `/.well-known/webfinger`, `/.well-known/host-meta(.json)`, `/.well-known/nodeinfo`, `/nodeinfo/*` — are instead PROXIED (fetched and returned, never redirected) through to `https://api.mention.earth`; all other requests → `env.ASSETS.fetch(request)`.

**CRITICAL — CF Pages `_worker.js`:** A `functions/` directory inside a `wrangler pages deploy <dir>` output is served as a STATIC ASSET, not compiled as Pages Functions. Always use Advanced-Mode `_worker.js` at the output root.

**CRITICAL — never redirect the apex ActivityPub ENDPOINT paths:** `/ap/*`, webfinger, host-meta, and nodeinfo must always be PROXIED, never served via a 301/302 (CF zone redirect rule or otherwise) — Mastodon's inbox POST deliveries die on a redirect (no re-sign, strict redirector), silently killing ALL inbound federation (follows/accepts/likes/replies) while GETs keep working, so the profile still renders and looks healthy. HTTP signatures are bound to the apex host; the backend verifies the signature against `X-Forwarded-Host` (`crypto.ts`), which only works if the request reaches the backend unredirected. (The profile-URL 302 above is unaffected — it's a GET-only redirect, not an endpoint path.) The CF zone redirect rules that 301/302'd the endpoint paths were deleted 2026-07-02 — do not recreate them.

**Other verified requirements:**
- Actor `publicKey.id` host MUST equal the actor `id` host — cross-domain key causes Mastodon to reject the actor.
- Actor `icon.url` must be absolute and reachable.
- `/.well-known/host-meta` must be PUBLIC — mount before auth middleware in `webfinger.routes.ts`.
- Mastodon negative-caches failed resolutions for minutes/hours — after a fix, cache-bust by searching the full profile URL (different cache key than the acct handle).
- To rule out CF bot-blocking: curl from an AWS us-west-2 Fargate one-shot using the Mastodon UA; `api.mention.earth` is DNS-only → ALB (not CF-proxied); only apex `mention.earth` is behind CF.

## Federated Media Cache

Remote/federated media proxied and cached through the backend:

- **Proxy**: `GET /media/proxy?url=<remote url>` — SSRF-guarded (DNS-pinned, IP denylist, per-hop redirect re-validation, content-type allowlist image/video/audio, SVG rejected, range requests supported). Frontend rewrites federated URLs via `proxyExternalUrl()` in `packages/frontend/utils/imageUrlCache.ts`.
- **Video poster**: `GET /media/poster?url=<video url>` — ffmpeg frame extract (sandboxed, bounded download). Dockerfile installs ffmpeg. Frontend: `videoPosterUrl()`.
- **S3 activity cache**: on proxy access, media uploaded to Oxy S3 via `POST /assets/service/cache` on oxy-api. Entries unused 30 days are evicted. Model: `FederatedMediaCache`.
- **Key code**: `packages/backend/src/services/mediaCache/*`, `routes/media.ts`, `utils/safeUpstreamFetch.ts`, `utils/ssrfGuard.ts`, `utils/videoPoster.ts`.
- **Gated by**: `FEDERATION_MEDIA_CACHE_WRITE_ENABLED=true` (set in `oxy-infra/terraform-uswest2/app-services-realtime.tf`). Unset = proxy works but nothing writes to S3.
- **Storage**: federated media URLs stored RAW on the post (`content.media[].id`). Cache keys off the remote URL.
- **Upstream error classification**: `classifyUpstreamStatus` in `routes/mediaProxyStatus.ts` maps upstream 4xx → our 404, 5xx + connection errors → 502, oversized → 413. Negative cache (`services/mediaCache/negativeCache.ts`, Redis key `mediaproxy:neg:<sha256(url)>`) short-circuits known-dead URLs with zero upstream fetch.

## Canonical Media

Use `oxyServices.getFileDownloadUrl(id, variant)` everywhere. Mention backend `utils/mediaResolver.ts` builds federated actor `icon.url` via this helper. Do NOT add per-app URL helpers or per-DTO `avatarUrl` fields — that pattern was tried and reverted.

## Federation — Service Credential

**Silent sticky outage pattern:** a bad/missing service credential causes service-token acquisition to fail → signed fetch returns 0 posts. The outbox-sync cooldown stamps `lastOutboxSyncAt` → makes the empty first sync permanent (`pending:true`, 0 posts) until `lastOutboxSyncAt` is manually cleared from the DB. A bad credential is invisible at `LOG_LEVEL=info` — service-token and signed-fetch failures log at `error`/`warn`.

## Compose Intent URL

- Canonical: `https://mention.earth/compose?text=...&url=...&hashtags=...`
- Full param reference: `packages/frontend/docs/INTENT_URL.md`
- Parser: `packages/frontend/utils/composeIntent.ts`
- Wired in: `packages/frontend/app/(app)/compose.tsx`
- OS share sheet: Web Share Target (PWA, `app.config.js` manifest) + native `expo-share-intent` (config plugin, needs `expo prebuild` after install)
- Share intent entry point: `packages/frontend/app/_layout.tsx`
- Platform split: `shareIntent.web.ts` / `shareIntent.native.ts`
- Quote flow: `hooks/useQuoteManager.ts` + `components/Compose/QuoteCard.tsx`
- Quote wire format: `quoted_post_id` top-level snake_case body field (NOT nested under `content`)

## Oxy SDK Conventions

- **ContentPanel**: uses `@oxyhq/bloom/content-panel` in `packages/frontend/app/(app)/_layout.tsx`. `framed` breakpoint is 500px. Pass the UNSCOPED background as `maskColor` when inside `BloomColorScope`. Radius tokens `--radius-radius-{8,12,20,28,max}` must be in `global.css` `@theme` block.
- **Linked clients**: `packages/frontend/utils/api.ts` adapts `oxyServices.createLinkedClient({ baseURL: API_URL })` into the app's `{ data }` response shape. Do NOT re-enable GET caching on linked clients.
- **Live rooms (Syra)**: Mention's live-rooms feature is powered by the shared `@syra.fm/sdk` engine (DI-based; audio rooms over LiveKit) — same API the retired local live-rooms workspace package exposed. `@syra.fm/sdk` is ONE flat package with export-condition-gated entries: `require`/`import` (Node) resolves to a headless, React-Native-free client (used by the Mention backend for `createSyraClient` + catalog types, so it never pulls in RN/LiveKit/Expo); `react-native` (Metro) and `browser` (Expo web) resolve to the full entry that also exports the live-rooms engine and the `SyraIcon` brand mark. Rooms talk to SYRA's backend, NOT `api.mention.earth`: `lib/agoraConfig.tsx` builds a Syra-pointed linked client (`SYRA_API_URL` / `SYRA_SOCKET_URL` in `config.ts`; Oxy bearer token authenticates cross-app) and passes it as `agoraConfig.httpClient` / `socketUrl`. The rooms UI (`components/RoomCard.tsx`, `components/rooms/*`, `context/LiveRoomContext.tsx`, `hooks/useRoom*.ts`) imports the live components/hooks (`RoomCard`, `useRoomAudio`, `createRoomsService`, `LiveRoomProvider`, `SyraIcon`, etc.) from `@syra.fm/sdk`. Do NOT point the rooms client at Mention's global `authenticatedClient`, and do NOT re-enable GET caching on the Syra client.
- **Backend auth**: `@oxyhq/core/server` only. No local `requireAuth`, bearer parsers, or token-decoding middleware.
- **Notifications**: `POST /notifications` is server-authored — no client mass-assignment of notification fields.
- **Debug routes**: `/test` debug route was removed from production. Do not re-add it.

## Auth Cold-Boot Reactivity (Web)

The SSO restore path can take 5–25s. React Query keys and effect deps MUST include `isAuthenticated` / `user?.id` — keying on `oxyServices` or `[]` fetches once while anonymous and never recovers when the session lands.

- Feed (`useFeedState`) keys its initial-fetch on `isAuthenticated`/`currentUserId` and invalidates the cached anon feed on identity change.
- Home feed (`app/(app)/index.tsx`) remounts on the auth-identity key (`isAuthenticated && user?.id ? user.id : 'anon'`).
- Use `useAuth().canUsePrivateApi` / `useAuth().isPrivateApiPending` to gate private endpoints. Do NOT add local auth hooks, token helpers, or manual `Authorization` headers.
- **`usePrivacyControls` infinite-401 pattern:** `getBlockedUsers`/`getRestrictedUsers` MUST be gated on `canUsePrivateApi`, not just `isAuthenticated`. A 401 must fail quietly. Never include `loading` in auto-refresh effect deps.
- Jest does NOT reproduce slow SSO restore — verify in a real, foregrounded browser tab.

## Web Feed / Virtualization

`packages/frontend/components/Feed/Feed.web.tsx`:

- **`VirtualizedWebFeed`** — `useWindowVirtualizer`; SINGLE scroll-owning path for all feed screens. `useWebFeed` is the single data owner.
- **`EmbeddedWebFeed`** — for genuinely nested sub-lists only (e.g. replies inside a modal). Do NOT use for top-level feed screens.
- **Spacer size:** use `Math.max(totalSize, lastItemEnd)` (`virtualItems.at(-1)?.end ?? 0`). On prod builds `getTotalSize()` can return 0 even with measured rows — a 0px spacer breaks sticky side rails. Always verify virtualization bugs on a PROD build (`expo export web`), not the dev server.

Panel chrome insets: `packages/frontend/components/shell/PanelChrome.tsx` (`PANEL_TOP_INSET`, `<PanelStickyHeader>`, `<PanelStickyFooter>`). Do NOT add per-page inset padding to individual feed screens.

**Never block the feed response on remote link-preview / image fetching.** Persist previews in Redis (`packages/backend/src/services/linkPreviewCache.ts`). Any function touching remote URLs must be fire-and-forget and detached before the feed response returns.

## Feed Performance

- **Hydration author-batch**: `PostHydrationService.buildUserMap` batch-resolves authors via `oxyServices.getUsersByIds`. `services/userSummaryCache.ts` caches `PostActorSummary` + followerCount in Redis (key `usersummary:v1:<id>`, 10m TTL).
- **View counts**: `services/feedViewCounter.ts` (Redis SET NX EX `viewseen:<postId>:<viewerId>`). Frontend reports impressions via `utils/feedTelemetry.ts`.
- **Instant post-detail**: memory-mode feeds seed the shared post cache (`postsStore.cachePosts`) in `useFeedState`; `app/(app)/p/[id].tsx` paints from cache + background-revalidates (`revalidatePostById`).

## Feed Ranking, Content Classification & Safety

### Unified Content Classification (two-stage hybrid)

All posts — native AND federated — go through the same classification pipeline at ingest.

**Stage A — deterministic baseline (`services/BaselineContentClassifier.ts`, pure/sync):**
Runs at all ingest chokepoints: `PostCreationService`, `feed.controller` reply path, `OutboxSyncService.insertMany`, `InboxProcessingService`. Writes a `postClassification` subdoc:

- `languages: string[]` — SINGLE multi-language field (ALL detected/declared ISO 639-1 codes, primary first, deduped, cap 3). Detection: tinyld `detectAll` with combined gate (`secondaryMinAccuracy:0.2` AND `secondaryMinRatioToTop:0.5`). Federated: `extractApLanguages` reads AP `language` + all `contentMap` keys (`utils/federation/apLanguage.ts`). Feed language-match is ANY-OVERLAP (`$in` / `.some()`) at all 3 sites: `FeedRankingService`, `ExploreFeed`, `forYouCandidateSources`.
- Top-level `post.language` = `languages[0]` (primary, the AP protocol field).
- Sensitive, spam, quality, toxicity scores (`services/contentClassification/spamQuality.ts`), normalized hashtags, rule-based topics via `TopicClassifier`.
- Status: `'pending'` (waiting for Stage B).
- `BASELINE_CLASSIFIER_VERSION = 4` — ranking only trusts scores stamped at or above this version.

**Stage B — async AI enrichment (`PostClassificationService`, Alia):**
Uses DOTTED `$set` to enrich the existing subdoc — NEVER a whole-subdoc overwrite (would wipe Stage A fields). Topics via `postClassification.topicRefs` resolved through `TopicService.resolveTopicRefs`. Readers prefer `topicRefs`, fall back to `extracted.topics`, then neutral.

**MongoDB text-index `language_override` rule:** never let a text index's `language_override` point at a field holding free-form content-language codes — MongoDB rejects writes with error 17262 (`"language override unsupported"`). The `content.text_text` index uses `language_override:'textSearchLanguage'` (a sentinel field no document populates → always falls back to English stemming).

### Feed Safety Gating

`mtn/feed/feedSafety.ts` is the SINGLE source of truth for sensitive/NSFW filtering. Exports reusable Mongo query clauses and composable primitives. EVERY feed imports from here — never re-implement the check inline. Per-user `privacy.showSensitiveContent` (default `false`, `PUT /profile/settings`) makes gating viewer-conditional.

### For You Ranking (`FeedRankingService.rankPosts`)

`rankPosts` is the ONE ranking path for ForYou, Explore, Videos, and Media feeds.

- **Candidates** (`mtn/feed/feeds/forYouCandidateSources.ts`): multi-source, bounded, parallel — following, affinity, topic/language/region match, trending, global discovery (always SFW).
- **Signals** (config in `packages/shared-types/src/mtn/config.ts`): author authority (bounded log-scale follower count), AI + deterministic quality/spam/toxicity (provenance-gated), engagement weights, diversity penalties (`sameAuthorPenalty`, `sameTopicPenalty`).
- **Author-diversity rerank**: `diversifyByAuthor` runs BEFORE page truncation; only the page window is hydrated.
- **Never-blank fallback**: when the unseen pool is exhausted (seen-set 1000 cap / 30-min TTL), ForYou falls back to `fetchPopular`.
- **Surface-aware engagement**: likes/saves/boosts from the Videos feed dampen author affinity but boost topic + post-type affinity. `Like.source` is persisted. Config: `preferences.engagementContext` in shared-types.
- **`userBehavior` context**: loaded in `feed.controller` on every ForYou request — affinity and preferred-topic signals were dead without it.
- **Never honor default-zero scores**: ranking gates on `status === 'classified' OR version >= BASELINE_CLASSIFIER_VERSION` before trusting quality/spam/toxicity values.

## Theming

- Default color preset for **Mention frontend: `blue`**.
- `BloomThemeProvider` is the single source of truth for mode + color preset, with built-in persistence. Pass `persistKey` + `storage` — do NOT add a local theme store.
- Settings UI uses `SettingsList` (`SettingsListGroup` / `SettingsListItem` from `@oxyhq/bloom/settings-list`). Do not introduce local `SettingsItem` wrappers.
- `BloomColorScope` owns scoped Bloom/NativeWind variables for profile theming. Do not add app-local scope helpers.
- `frontend/app/_layout.tsx` is the only place that wires `BloomThemeProvider`; consumers use `useTheme()` / `useBloomTheme()` from `@oxyhq/bloom`.
