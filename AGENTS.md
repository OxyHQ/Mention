# Mention

> Parent files (`~/AGENTS.md`, `~/Oxy/AGENTS.md`) hold universal standards, the agent team, shared-SDK rules, SDK version targets, Bloom/Expo/expo-router gotchas, and the infra pointer. This file holds ONLY Mention-specific content.

## AWS Deployment

- **Port**: `3000` | **Domain**: `api.mention.earth` (DNS-only → ALB) **+ apex `mention.earth`** (CF-proxied → same ALB → same backend, which serves the whole web app + OG + federation — see "Fediverse Discovery"). No Cloudflare Worker.
- **MCP**: `https://mcp.mention.earth` → ECS `mention-mcp` (port `3100`, ALB rule priority 140). Separate image/workflow from main backend — see § MCP below.
- **ECR**: `237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/mention` (+ `oxy/mention-mcp` for MCP)
- **Deploy**: `git push origin main` → `.github/workflows/deploy-aws.yml` (backend) + `deploy-mcp-aws.yml` (MCP, path-filtered) → ECR → `ecs update-service --force-new-deployment`
- **Auth**: GitHub OIDC → role `oxy-github-deploy`. No AWS keys in GitHub.
- **Secrets**: GitHub Actions secrets → synced to SSM `/oxy/mention/*` and `/oxy/mention-mcp/*`; ECS injects them. Change a secret in GitHub — the next deploy applies it.

## Commands

```bash
bun run dev                 # All packages dev mode
bun run dev:frontend        # Frontend dev (Expo tunnel)
bun run dev:backend         # Backend dev (watch mode)
bun run dev:mcp             # MCP stdio transport (local)
bun run dev:mcp:http        # MCP HTTP transport (local; matches production)
bun run build               # shared-types + backend + mcp
bun run build:frontend      # Frontend only
bun run build:backend       # shared-types then backend
bun run test                # Test all
bun run lint                # Lint all
bun run clean               # Remove all node_modules
```

Run backend tests from the package root: `cd packages/backend && bun run test` (running from the repo root picks up stale `.dist` copies → false failures).

**Rebuild `shared-types` before believing a red typecheck or build.** `@mention/shared-types` is consumed through its BUILT `dist`, so after any rebase/checkout that pulls in a shared-types change, every other package still compiles against the previous build and reports the newly-landed symbols as missing — `TS2305: has no exported member 'X'`, in files you never touched. It reads exactly like someone else's broken commit, and has been reported as "N pre-existing errors" more than once. `bun run --cwd packages/shared-types build` first; only a failure that survives that is real.

## Bumping an Oxy SDK package (CRITICAL — `bun add` reports success and changes nothing)

The ROOT `package.json` `overrides` block pins `@oxyhq/bloom`, `@oxyhq/core` and `@oxyhq/services` as well as the workspace manifests, and an override beats a workspace range. So `bun add @oxyhq/bloom@^0.72.1` inside `packages/frontend` prints `installed @oxyhq/bloom@0.71.0`, exits 0, and leaves the old version in both `node_modules` and `bun.lock`. `bun update` behaves the same. Nothing mentions the override.

Every bump therefore touches four things: the workspace manifest, the root `overrides` entry, `expectedBloomVersion` in `scripts/doctor.mjs` (which pins the whole workspace to ONE Bloom release by design), and `bun.lock`. `@oxyhq/bloom` must NOT appear in the root `dependencies` — doctor rejects that ("Runtime dependencies must live in their owning workspace"), and a rebase conflict resolution reintroduces it easily.

**Assert the installed version after any bump — never trust the installer's output.** `node -e "console.log(require('./node_modules/@oxyhq/<pkg>/package.json').version)"` before running any gate, or the gate measures the old package.

For `bun.lock`, do NOT regenerate from scratch: that produced 734 lines of unrelated churn and still failed CI. The correct delta is minimal — the workspace range, the `overrides` entry, and the resolution record. `.github/scripts/verify-lockfile.sh origin/main` prints exactly that diff, and it compares the COMMITTED lockfile, so commit before re-running it.

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
  backend/        @mention/backend     Express 5.2 / Mongoose 8.24 / Redis / Socket.io
  shared-types/   @mention/shared-types TypeScript type definitions
  mcp/            @mention/mcp         Model Context Protocol server for Claude
```

### Key Tech

- **Frontend**: Expo Router, NativeWind + TailwindCSS 4.2, TanStack React Query, Zustand, Socket.io-client, LiveKit
- **Backend**: Express 5, Mongoose 8, Redis 5, Socket.io, Firebase Admin, Oxy media services

## MTN Protocol (Mention's signed-records layer)

Mention posts are dual-written as signed records on a per-user hash chain — the "MTN Protocol" — riding on the shared `@oxyhq/protocol` engine. Native Mongo remains authoritative; the chain write is best-effort, isolated (`Promise.allSettled`), and gated on local authors (`federation == null && oxyUserId`).

Key pieces in `packages/backend/src/services/mtn/`:

- **`MentionRecordService`** — thin write API: `signAndAppend(oxyUserId, collection, rkey, payload)` builds the DID, reads the chain head, custodially signs with `MENTION_PRIVATE_KEY` (`issuer = MENTION_DID`), and calls `verifyAndAppend` from `@oxyhq/protocol`. Retries on `chain_conflict`/`bad_seq`. Inert-without-env: returns `{ok:false, reason:'disabled'}` when keys are unset.
- **`MentionSignedRecord` / `MentionRepoHead`** — Mention's own Mongo models for the chain (keyed by `oxyUserId`). Implemented via `MentionRecordStore` (the `RecordStore` adapter over these models).
- **`PostMaterializer`** (`projectRecord`) — the SINGLE writer of first-party `Post` rows FROM verified records (used by backfill and future node ingest). Resolves `embed.blob.sha256` → fileId via the reverse SHA-256 lookup. Idempotent, fail-soft, never throws.
  - **A record's `createdAt` is SELF-ASSERTED and must go through `clampFutureDate`** (`utils/ingestTimestamp.ts` — the one guard every ingest path shares; each caller passes its own window). Signature verification proves who wrote a record, not that its clock is honest, and the lexicon types `createdAt` as `z.string().min(1)`, so any non-empty string validates. Unbounded, a future value pins the post atop the profile feed and post search (both sort `{createdAt: -1, _id: -1}`) until the clock catches up, and an unparseable one throws a `RangeError` from `toISOString()` mid-projection. Windows: **1h** for MTN records and atproto (author-asserted directly), **24h** for ActivityPub (a third-party instance's clock we cannot audit). REJECT and fall back to `now` — never re-date to the clamp edge, which is the same pin one window long.
- **`mentionVerificationResolver`** — the Mention authorization policy injected into the `@oxyhq/protocol` engine: self-issued records (`issuer === subject`) use the subject's Oxy verification methods; custodial records (`issuer === MENTION_DID`) accept `MENTION_PUBLIC_KEY`.
- **Custodial signing** — web posts are signed server-side (`issuer = MENTION_DID`); native = `issuer === subject`. `MENTION_DID` / `MENTION_PRIVATE_KEY` / `MENTION_PUBLIC_KEY` env vars gate this.
- **`mention-node`** — a self-hostable node a user runs to own their own chain; synced bidirectionally via `MentionNodeSyncService` + `MentionNodeScheduler` (leader-gated background sweeps).
- **Lexicons** — the `app.mention.feed.*` record schemas (`mentionPostRecordSchema` et al.) live in **`@mention/shared-types`** (`src/mtn/lexicons.ts`); `@oxyhq/contracts` owns the transport around them (`SignedRecordEnvelope`, `LexiconRecord`). Importing a `mention*RecordSchema` from `@oxyhq/contracts` is a `TS2305` — it does not export one.

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

- `videos` feed descriptor → `videosDefinition` plus `videosSource` (`packages/backend/src/mtn/feed/definitions/presets.ts` and `engine/sources/discoverySources.ts`) — ranked feed of video posts (native + federated), powers the fullscreen Reels viewer (`packages/frontend/app/(app)/videos.tsx`). The legacy `type:'media'` global descriptor does NOT exist — returns 400.
- **Boost hydration gotcha:** A `type:'boost'` post has an intentionally empty body and relies on `boostOf` for hydration. `PostHydrationService` only embeds the boosted original at `maxDepth >= 1`. Any endpoint/feed that INCLUDES boosts MUST pass `maxDepth:1` or boosts render blank. Affected: `connectors/connectors.routes.ts` and the `author` preset (`mtn/feed/definitions/presets.ts`, `hydrateMaxDepth: 1` on every variant). Native feeds (ForYou/posts via `feedQueryBuilder`) avoid this by excluding boosts.
- **`hasMore` from authoritative overfetch:** `FeedResponseBuilder` computes `hasMore` from the overfetch flag, NOT `slicesToReturn.length >= limit` — post groups (thread slicing) can produce fewer slices than limit items, causing premature `hasMore: false`.

#### Profile feed = the `author` descriptor

The profile feed is NOT a separate endpoint — it is `GET /feed/mtn?descriptor=author|<oxyUserId>|<tab>`, served by the same engine as every other feed. There is no `/feed/user/:userId`. `<tab>` ∈ `AuthorFeedFilter` (`posts` | `replies` | `media` | `likes` | `boosts` — one per profile tab; unknown ⇒ `posts`). Frontend entry point: `feedService.getUserFeed`.

- **Cursor/sort axis:** the `authored` source sorts `{ createdAt: -1, _id: -1 }` to match the `ChronoCursor` keyset. Never sort an author query by `_id`: a federated post's import-time `_id` bears no relation to its remote `createdAt`, so an `_id` sort behind a `createdAt` cursor permanently skips backfilled posts at the page boundary (this is the "boost disappears from the profile feed" bug).
- **Profile-visibility gate** lives in the `authored` source (`canViewAuthorFeed`) and covers EVERY tab: a private / followers-only profile returns an empty feed to a non-follower. Post-level `visibility: public` is not sufficient — profile visibility is a separate setting.
- **Federated sync-on-view** (`src/connectors/federatedProfileSync.ts`): viewing a remote profile is how Mention discovers its posts (there is no push for actors nobody follows). An author feed served EMPTY on its FIRST page hands the author to `federatedProfileSync.syncOnProfileView(oxyUserId)`, which awaits ONE indexed `FederatedActor` lookup and detaches all network I/O (actor fetch → outbox sync → media). It returns whether to set `pending: true` on the response; the client (`useFeedState`) then shows a loading state and refetches. A `pending` page is never written to `anonFeedCache`. Local authors with an empty profile are never marked pending.

### Federation (ActivityPub — via connectors)

ActivityPub is implemented as the `activitypub/ActivityPubConnector` inside the connectors module (see External Network Connectors above). Federated users are type `'federated'` in Oxy, posts in Mention, linked by `oxyUserId`. HTTP signatures on all outbound requests.

- **Local dev**: `cloudflared tunnel --url http://localhost:4110` + set `FEDERATION_DOMAIN` to the tunnel domain.
- **Outbox sync** uses the actor's advertised `outbox` URL; `actorUri + '/outbox'` is fallback only — guessing breaks PeerTube/Lemmy/some Pleroma. Lives in `connectors/activitypub/outbox.service.ts`.
- **Boosts** imported as `type:'boost'` posts, deduped by `federation.activityId`, in both inbox push (`handleAnnounce`) and outbox backfill paths.
- **Likes/boosts from federated actors** stored as NATIVE records (Like doc / boost Post). The AP connector does NOT copy remote aggregate counts — counts only move ±1 in lockstep with real records.
- **Inbound follows bridge to the Oxy graph**: `handleIncomingFollow` requires the actor's `oxyUserId` and creates the Oxy edge via oxy-api `POST /federation/follow` (service auth, scope `federation:write`, follower must be Oxy type `'federated'`, idempotent) BEFORE sending Accept; `handleUndo` removes it. `FederatedFollow` stays the AP-side record; the Oxy graph is what the app UI (followers list, `_count`, notifications) reads. Follow notifications: `type:'follow'` via `createNotification`.
- **CRITICAL — outbound fan-out username resolution:** outbound federation (Create/Announce/Delete/Update/Like) MUST resolve the author's username SERVER-SIDE from `oxyUserId` via the service Oxy client (`getUserById`), NEVER from `req.user.username` — the Oxy auth middleware (`oxy.auth()` from `@oxyhq/core/server`) is called WITHOUT `loadUser:true` and never populates `req.user.username`, so gating fan-out on it silently federated ZERO posts (`metadata.federationDelivered` stayed false on every post) while everything else looked healthy. Shared helper: `resolveFederationUsername` (`connectors/outboundFederation.ts`). `Accept(Follow)` was unaffected — it parses the username from the inbound activity's target URL, not from `req.user`.
- **Outbound AP surface**: all outbound activities go through `connectorRegistry.deliver` (fire-and-forget, gated on `FEDERATION_ENABLED` + local author + fediverse sharing): `Create(Note)` to followers (`inReplyTo` + parent-author Mention tag + delivery to the parent author's inbox for replies); `Announce`/`Undo(Announce)` for boosts (a bare boost must NEVER federate as an empty `Create(Note)` — guarded); `Delete(Tombstone)` on delete; `Update(Note)` with an `updated` stamp on edit; `Like`/`Undo(Like)` delivered to the origin author only (never fanned out to the liker's followers); `Update(Person)` to followers when a Mention-owned actor field (banner `profileHeaderImage`) changes. Shared helpers: `deliverToFollowers(activity, oxyUserId, username, {extraInboxes})`, `resolveActorInbox`, `resolveFederationTarget`, `buildLocalActorObject` (`connectors/activitypub/actorObject.ts`).
- **Outbox + followers/following pagination**: outbox `?page=true` emits a keyset `next` cursor (all posts reachable, not just the first 20). Followers/following collections expose paginated member-list pages (`first` + `orderedItems` of remote actor URIs) so Mastodon can enumerate followers.
- **Known gap (pending)**: Oxy-owned actor fields — displayName (`name.displayName`), avatar (`icon`), bio (`summary`) — live in the Oxy API with no Mention-side write hook, so an Oxy profile edit does NOT trigger outbound `Update(Person)`. Only Mention-owned fields (banner) trigger it today. Propagating Oxy-owned changes needs either an Oxy→Mention signal on profile writes or a periodic leader-gated actor re-broadcast.
- **Local actor JSON**: banner comes from `UserSettings.profileHeaderImage` emitted as AP `image`; outbox pages and push delivery share `buildCreateNoteActivity` (url/tags/attachments) so they stay in sync; post objects dereference at `GET /ap/users/:username/posts/:id`. Mastodon does NOT backfill a newly-discovered remote account's regular timeline from the outbox (issue #33978, still open as of 2026) — a freshly-discovered profile shows ONLY (a) pinned posts via the actor's `featured` collection (see below) and (b) posts that arrive afterward by push to a follower, boost, reply, or individual URL import.
- **Pinned posts (`featured` collection)**: actor advertises `featured: /ap/users/:username/collections/featured`, a non-paginated `OrderedCollection` of the user's pinned posts as bare `Note` objects (`metadata.isPinned` on `Post`; query mirrors the outbox filter — local + published + public + `parentPostId:null`). Consent-gated (404 when fediverse sharing off), same as the other AP surfaces. This is what makes a freshly-discovered profile show content at all.
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

### Collaborative Posts

A post carries an `authorship[]` array (`owner` + up to `MAX_POST_COLLABORATORS` `collaborator` entries) — the denormalized `oxyUserId` is synced FROM the owner entry by the `Post` pre-save hook. Helpers live in `src/utils/postAuthorship.ts`; the write API is `src/services/PostCollaborationService.ts`. **`authorship[]` is REQUIRED on every post** — every writer sets it (composer/API/replies/boosts via `PostCreationService` + `feed.controller`, raw federated batch inserts in `outbox.service.ts`, MTN materialization in `PostMaterializer`). There is NO read-time legacy fallback: `buildAuthorFeedMatch`/`buildFollowedAuthorsMatch` match `authorship` elemMatch ONLY (no `oxyUserId` `$or` branch), and `normalizeAuthorship`/`getOwnerId`/`collectAuthorshipUserIds` take no fallback owner id. The prod backfill (313,748 posts) is complete and the one-shot script has been removed.

- **Deferred federation:** a post with a still-pending collaborator invite (`hasPendingCollabInvites`) does NOT federate at creation — an invitee must never be leaked to the fediverse before consenting. Federation fans out only once the LAST invite resolves: `accept()`/`decline()` call `maybeFederateOnResolve` (local + published + no-pending), which resolves the owner's username via Oxy and calls `getPostFederator().federateNewPost`.
- **Invites are published-only:** `PostCreationService.create` sends collab-invite notifications only when the post is actually published. A scheduled post defers invites (and MTN/notifications/federation) until it goes live.
- **Scheduled publish:** `ScheduledPostPublisher` (leader-gated 60s sweep wired into `FeedJobScheduler`) flips due `status:'scheduled'` posts to `published` via `PostCreationService.publishScheduledPost`, which runs the SAME publish pipeline (invites, MTN dual-write, notifications, socket emit, deferred federation).
- **Pending-collaborator preview:** `PostHydrationService` lets a pending collaborator (not just accepted) bypass the unpublished/private ACL so the invite UI can preview the actual post. The byline (`getHeaderAuthorshipEntries`) still shows owner + ACCEPTED collaborators only.
- **Threads have no collaborators:** `POST /posts/thread` rejects `collaboratorIds` with 400.
- **Edit-to-collab:** within the 30-minute edit window, the owner can attach collaborators to a solo top-level local post via `PUT /posts/:id` with `collaboratorIds`. Posts that already have collaborator entries, are replies/boosts, or are federated are rejected. Solo posts that already federated at creation do not re-federate when invites resolve (`metadata.federationDelivered` / `metadata.collabFederationDeferred` gate `maybeFederateOnResolve`).

## Profile Identity

- Post DTOs MUST be produced by `PostHydrationService` (`packages/backend/src/services/PostHydrationService.ts`). Controllers must not hand-build post `user` objects, notification embedded posts, or feed post shapes.
- **`post.user` / `authors[]` / `boost.actor` are the canonical Oxy `User` shape (`PostUser` in `@mention/shared-types`), NOT a Mention-local adapter.** Oxy owns identity — hydration passes Oxy user fields through UNCHANGED: `name.displayName` (render directly; fall back to the handle when absent), `avatar` (bare Oxy file id OR absolute federated URL — resolved by Bloom's `ImageResolver`, never pre-resolved to `avatarUrl`), `username`, `verified`, `isFederated`, `federation`, `instance`, `badges`. There is NO `PostActorSummary`, no flat `displayName`/`handle`/`avatarUrl` on post users, and no dual-write shims. Every renderer derives the handle via `getNormalizedUserHandle(user)`.
- **Degraded author (Oxy resolve miss)** = `degradedActorSummary`: EMPTY `username` + `name.displayName: 'Unknown user'` (ghost-handle rule — an empty username suppresses the `@handle` line and profile link, never emits the raw id as a handle). A degraded FEDERATED author is enriched from Mention's own `FederatedActor` record inside `resolveUserSummaries` (fills only `username`/`federation`/`avatar`, NEVER invents `name.displayName`); enriched/degraded users are never cached, so the DTO self-heals once Oxy recovers.
- Profile routes use `getNormalizedUserHandle` from `@oxyhq/core`. Valid URLs: `/@username` and `/@username@domain`. Duplicate suffixes (`/@user@domain@domain`) are bugs in handle normalization.

## Fediverse Discovery of Mention Profiles

Two resolution entry points; BOTH must work for full Mastodon compatibility.

**By handle (`@user@mention.earth`):** webfinger `/.well-known/webfinger?resource=acct:...` → `self` link → fetch actor.

**By profile URL (`https://mention.earth/@user`):** Mastodon GETs the URL with `Accept: application/activity+json`. Served by the BACKEND (`packages/backend/src/routes/webShell.routes.ts`): with AP Accept, `/@user` 302-redirects to the canonical actor at `https://api.mention.earth/ap/users/<user>` (GET-only content negotiation — redirecting a GET here is correct); with a browser Accept it returns an OG-injected SPA shell.

**OG cards are safety-gated (`/p/:id`):** a post carrying any sensitivity signal — or a federated content warning, or a boost whose ORIGINAL carries one — gets NO `og:image`/`twitter:image` and none of its body text; the description becomes the author's CW when there is one, else a neutral notice, and `twitter:card` follows the image (`summary` without one). An unfurl renders full-size for everyone in a Slack/Discord/iMessage thread with no warning and nobody opted in, so it cannot reproduce the content it cannot warn about. The verdict comes from the RAW post row via `requiresContentWarning` (see § Read-Surface Safety Gating) and is a REQUIRED argument to `mapPostOg`, so no future caller can render a card without deciding.

**Apex is served entirely by the backend — NO Cloudflare Worker.** `mention.earth` is a CF-PROXIED CNAME → the shared ALB (`oxy-alb-…us-west-2.elb.amazonaws.com`); the ALB routes `Host: mention.earth` to the Mention backend (a dedicated `mention.earth` ACM cert is attached to the 443 listener for SNI). Server mount order (`packages/backend/server.ts`): federation routes (`/.well-known`, `/ap`, `/xrpc`, `/media`) → `webShell.routes.ts` (`/@user`, `/p/:id` OG shells) → `apexFrontendProxy` (`packages/backend/src/middleware/apexFrontendProxy.ts` — reverse-proxies every other apex GET/HEAD to `mention-frontend.pages.dev`: the SPA, `_expo` assets, `manifest.json`). `pages.dev` is now PURE STATIC (SPA + `public/_redirects` `/* /index.html 200` fallback that the proxy relies on for client routes); the backend consumes it as `WEB_SHELL_ORIGIN` (SWR-cached). The root `/` welcome route is host-gated so the apex serves the SPA, not API JSON. History: the apex used to be CF Pages + an Advanced-Mode `_worker.js`; that worker + `_routes.json` were deleted 2026-07-05 after CF Pages Functions hit the Free 100k/day cap and Origin Rules (transparent proxy) proved paid-only. Do NOT reintroduce a worker.

**CRITICAL — never redirect the apex ActivityPub ENDPOINT paths:** `/ap/*`, webfinger, host-meta, and nodeinfo must always be served DIRECTLY (200), never via a 301/302 (CF zone redirect rule or otherwise) — Mastodon's inbox POST deliveries die on a redirect (no re-sign, strict redirector), silently killing ALL inbound federation (follows/accepts/likes/replies) while GETs keep working, so the profile still renders and looks healthy. HTTP signatures are bound to the apex host; the backend verifies the signature against `X-Forwarded-Host` (`crypto.ts`), which CF sets when proxying `mention.earth` → ALB (mount these federation routers BEFORE `apexFrontendProxy`). (The profile-URL 302 above is unaffected — it's a GET-only redirect, not an endpoint path.) The CF zone redirect rules that 301/302'd the endpoint paths were deleted 2026-07-02 — do not recreate them.

**Other verified requirements:**
- Actor `publicKey.id` host MUST equal the actor `id` host — cross-domain key causes Mastodon to reject the actor.
- Actor `icon.url` must be absolute and reachable.
- `/.well-known/host-meta` must be PUBLIC — mount before auth middleware in `connectors/connectors.routes.ts`.
- Mastodon negative-caches failed resolutions for minutes/hours — after a fix, cache-bust by searching the full profile URL (different cache key than the acct handle).
- To rule out CF bot-blocking: curl from an AWS us-west-2 Fargate one-shot using the Mastodon UA. `api.mention.earth` is DNS-only → ALB (not CF-proxied); the apex `mention.earth` is CF-proxied → the same ALB → the same backend.

## Federated Media Cache

Remote/federated media proxied and cached through the backend:

- **Proxy**: `GET /media/proxy?url=<remote url>` — SSRF-guarded (DNS-pinned, IP denylist, per-hop redirect re-validation, content-type allowlist image/video/audio, SVG rejected, range requests supported; HLS playlists take the rewrite path below). Frontend rewrites federated URLs via `proxyExternalUrl()` in `packages/frontend/utils/imageUrlCache.ts`.
- **HLS (`.m3u8`)**: a playlist is NEVER relayed verbatim — it is buffered (8 MiB cap) and REWRITTEN so every URI it contains comes back through `/media/proxy` (`utils/hlsManifest.ts`, RFC 8216 line-oriented rewrite; nested variant playlists rewrite recursively because fetching one re-enters the proxy). Pass-through is not an option: real playlists (Bluesky's) use RELATIVE URIs, which a client resolves against `/media/proxy?url=…` and never finds. Each emitted URI carries an HMAC (`utils/hlsSignature.ts`, key derived from `OXY_SERVICE_API_SECRET`) — that signature is the ONLY thing that lets `application/octet-stream` through the content-type gate, which is how object-store segments (`video.cdn.bsky.app`) play without turning the proxy into a general binary relay. Playlists are excluded from `isAllowedMediaType`, so the S3 cache never stores one (a cached playlist would be served back un-rewritten); `decideProxyServe` also refuses to serve an HLS row from Oxy. Rewritten playlists get a short revalidatable `Cache-Control` and `Accept-Ranges: none`.
- **HLS playback is HALF backend, half frontend.** A correct playlist is not enough: Safari/iOS decode HLS, desktop Chrome and Firefox do NOT, so on web the source goes to **hls.js** over MSE (`packages/frontend/lib/hlsPlayback.web.ts`, matched by `utils/hlsSource.ts` which must recognise the PROXIED spelling — the `.m3u8` sits in `?url=`). It attaches to the same `<video>` expo-video renders (`VideoView.nativeRef`), so play/pause/mute/timeUpdate/status keep coming from expo-video and hls.js only supplies bytes; the source is therefore WITHHELD from `useVideoPlayer` (`null`) whenever hls.js is active, or the element first attempts and fails a native load. `hlsPlayback.native.ts` is inert — ExoPlayer/AVPlayer decode HLS and a JS demuxer would be strictly worse. **Never gate on `canPlayType('application/vnd.apple.mpegurl')`: Chromium answers `"maybe"` and then fails the load** (`MEDIA_ERR_SRC_NOT_SUPPORTED`) — probe `isTypeSupported` on hls.js's own MediaSource constructor with H.264 Baseline 3.0 + AAC-LC instead. `import('hls.js')` must stay a SINGLE call site (a second one promotes the demuxer into eager `__common.js` — see `~/Oxy/AGENTS.md` § Metro web chunking); measured, it stays its own async chunk at +718 B on `initialJavascriptGzipBytes`.
- **Video poster**: `GET /media/poster?url=<video url>` — ffmpeg frame extract (sandboxed, bounded download). Dockerfile installs ffmpeg. Frontend: `videoPosterUrl()`. Requires a `video/*` upstream, so an HLS playlist URL still 415s here — federated HLS video has no server-extracted poster.
- **S3 activity cache**: on proxy access, media uploaded to Oxy S3 via `POST /assets/service/cache` on oxy-api. Entries unused 30 days are evicted. Model: `FederatedMediaCache`.
- **Key code**: `packages/backend/src/services/mediaCache/*`, `routes/media.ts`, `utils/safeUpstreamFetch.ts`, `utils/videoPoster.ts` — the SSRF guard itself is UPSTREAM (`assertSafePublicUrl` / `isBlockedIp` from `@oxyhq/core/server`), never a local copy.
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
- Platform split: `lib/shareIntent.native.ts` + a clean `lib/shareIntent.ts` default (there is no `.web` fork — web share-target arrives through the PWA manifest, not this module)
- Quote flow: `hooks/useQuoteManager.ts` + `components/Compose/QuoteCard.tsx`
- Quote wire format: `quoted_post_id` top-level snake_case body field (NOT nested under `content`)

## MCP (Claude / remote connector)

Production: **`https://mcp.mention.earth`**. Full doc: [`packages/mcp/README.md`](packages/mcp/README.md).

- **Two ECS services:** `mention` (OAuth AS + REST API on `api.mention.earth`) and `mention-mcp` (streamable HTTP MCP on port 3100). Backend OAuth/bundle changes → `deploy-aws.yml`; MCP tools/transport → `deploy-mcp-aws.yml`.
- **OAuth:** RFC 8414 AS on backend, protected-resource on MCP server. `resource` and JWT `aud` MUST equal `https://mcp.mention.earth` (no trailing slash). DCR at `POST /mcp/oauth/register`. Claude requires **401 + `WWW-Authenticate`** on unauthenticated `GET /` and OAuth Bearer before `initialize` POST.
- **Multi-account:** Claude allows only one connector per URL. Users link extra accounts via MCP tool `link-account` → browser `mention.earth/oauth/mcp/link` → `switch-account` / `whoami`. Server-side **bundles** (`McpConnection.bundleId`); active account in Redis + `activeOxyUserId` on primary connection. Link tokens are **single-use** (HMAC + Redis).
- **Auth on API:** `createRequireMcpOrOxyAuth` in `packages/backend/src/mcp/middleware/mcpAuth.ts` — MCP JWT OR Oxy session; resolves active bundle member to `req.user.id`.
- **UI:** consent `oauth/mcp/authorize.tsx`, link `oauth/mcp/link.tsx`, revoke Settings → Connected AI (`/mcp/connections`).
- **Secret:** `MENTION_MCP_JWT_SECRET` in GitHub → SSM `/oxy/mention/` + `/oxy/mention-mcp/` (must match both services).
- **Do not** add a second MCP URL per account — use bundle link flow. **Do not** add `as_user` on `create-post`; require `switch-account` first.
- **Media upload:** MCP uses `POST /posts/intent-media` (`url` or `base64`) → Oxy `POST /assets/service/user-media` via service token when auth is MCP JWT. Never call Oxy `assetUpload` directly from `@mention/mcp`.

## Oxy SDK Conventions

- **ContentPanel**: uses `@oxyhq/bloom/content-panel` in `packages/frontend/app/(app)/_layout.tsx`. `framed` breakpoint is 500px. Pass the UNSCOPED background as `maskColor` when inside `BloomColorScope`. Import Bloom design tokens via `@import "@oxyhq/bloom/design-tokens/theme.css"` in `global.css` (after the Tailwind/NativeWind imports) — never hand-paste `--radius-radius-*` or other Bloom scales.
- **Linked clients**: `packages/frontend/utils/api.ts` adapts `oxyServices.createLinkedClient({ baseURL: API_URL })` into the app's `{ data }` response shape. Do NOT re-enable GET caching on linked clients.
- **Live rooms (Syra)**: Mention's live-rooms feature is powered by the shared `@syra.fm/sdk` engine (DI-based; audio rooms over LiveKit) — same API the retired local live-rooms workspace package exposed. `@syra.fm/sdk` is ONE flat package with export-condition-gated entries: `require`/`import` (Node) resolves to a headless, React-Native-free client (used by the Mention backend for `createSyraClient` + catalog types, so it never pulls in RN/LiveKit/Expo); `react-native` (Metro) and `browser` (Expo web) resolve to the full entry that also exports the live-rooms engine and the `SyraIcon` brand mark. Rooms talk to SYRA's backend, NOT `api.mention.earth`: `lib/syraApi.ts` builds a Syra-pointed linked client (`SYRA_API_URL` / `SYRA_SOCKET_URL` in `config.ts`; Oxy bearer token authenticates cross-app) and passes it as `agoraConfig.httpClient` / `socketUrl`. The rooms UI (`components/RoomCard.tsx`, `components/rooms/*`, `context/LiveRoomContext.tsx`, `hooks/useRoom*.ts`) imports the live components/hooks (`RoomCard`, `useRoomAudio`, `createRoomsService`, `LiveRoomProvider`, `SyraIcon`, etc.) from `@syra.fm/sdk`. Do NOT point the rooms client at Mention's global `authenticatedClient`, and do NOT re-enable GET caching on the Syra client.
- **Backend auth**: `@oxyhq/core/server` only. No local `requireAuth`, bearer parsers, or token-decoding middleware.
- **Notifications**: `POST /notifications` is server-authored — no client mass-assignment of notification fields.
- **Debug routes**: `/test` debug route was removed from production. Do not re-add it.
- **Two loggers, indistinguishable signatures, opposite meanings for argument two.** `@oxyhq/core/logger` (frontend) is `error(message, error?, context?)` — the error goes SECOND. `packages/backend/src/utils/logger.ts` (a pino wrapper) reads identically, `error(message: string, error?: unknown)`, but its body branches: an `Error` becomes `{ err }`, anything else is merged as pino CONTEXT, so `logger.error(msg, { userId, error })` is correct there and is used in 100+ places. Write `logger.error(msg, error)` on the frontend and put context third; the wrapper-object form typechecks (the parameter is `unknown`) and silently puts a plain object where the error belongs. Note `debug`/`info`/`warn` take `LogContext` second on BOTH, so `logger.debug(msg, { error })` is right one line above a `logger.error` where it is wrong. The distinguishing fact is in a function body nobody reads, which is why this is gated rather than remembered: `bun run validate:logger` (`scripts/validate-logger-error-args.mjs`, in `bun run check`). It is scoped to files importing the SDK logger ON PURPOSE — unscoped it fires on every correct backend call, and a gate that cries wolf gets disabled by whoever hits it first.

## CORS (Web) — Intentional Exception to `createOxyCors`

Mention keeps its own CORS middleware (`app.ts` + `utils/allowedOrigins.ts`) on purpose — do NOT "fix" it to use `@oxyhq/core/server`'s `createOxyCors`. Two reasons: (1) `createOxyCors` only does exact-origin allowlist matching, so it can't express Mention's dev `DEV_ORIGIN_PATTERN` (any localhost/127.0.0.1/RFC1918 LAN-IP on any port, non-prod only — needed for the Expo dev server + physical test devices); (2) it unconditionally allows the whole HTTPS `*.oxy.so` family, which would BROADEN Mention's production CORS beyond the configured Mention frontend origin — a credentialed-CORS loosening. The hand-rolled middleware also sets `Cache-Control: no-store` on non-federation routes, which `createOxyCors` doesn't. The strict hand-rolled allowlist is the correct, tighter choice here.

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

**Never block the feed response on remote link-preview / image fetching.**
Oxy owns preview resolution/cache; hydration batches through
`OxyServices.getLinkPreviews`, while post-create warming lives in
`packages/backend/src/utils/linkPreviewWarm.ts`. Any feed-side function touching
remote URLs must be detached before the feed response returns.

## Feed Interstitials (Recommendation Cards)

Suggested users / custom feeds / starter packs spliced between post slices — horizontal snap carousel on mobile, vertical list on desktop (`packages/frontend/components/Feed/interstitials/InterstitialShell.tsx`).

- **The server sends PLACEMENT, never content.** `SlicedFeedResponse.interstitials?: FeedInterstitialSlot[]` (`{key, kind, afterSliceKey}`, `packages/shared-types/src/feed.ts`) is a new top-level field, planned by `packages/backend/src/mtn/feed/interstitials/planInterstitials.ts` — pure, synchronous, zero I/O (reads only `context.followingIds.length`, already loaded). Wired at the tail of `MtnFeedController.getFeed`, gated on `currentUserId` (authenticated only, so nothing personalized reaches `anonFeedCache`). The client fetches each card's content lazily from `/recommendations`, `GET /feeds/marketplace`, `GET /starter-packs`.
- **GOTCHA — never put a non-post inside `slices[].items`.** `FeedResponseBuilder.flattenSlicesToItems()` does `items.push(item.post)` unguarded — a non-post there fills `items[]` with `undefined` and breaks every existing client. That's why slots are a top-level field instead.
- **GOTCHA — slots anchor by `_sliceKey`, not index** (`spliceInterstitials` in `packages/frontend/components/Feed/feedRows.tsx`), because the client drops slices itself (blocked-author filter). A slot whose anchor slice produced no row is discarded, never re-anchored. A card renders after the LAST row of its slice, so it can never land inside a thread.
- **GOTCHA — interstitial rows must never report impressions.** Web (`Feed.web.tsx`): they get a measure-only ref (no `data-post-uri`, never enters the impression observer). Native (`Feed.native.tsx`): skipped in `handleViewableItemsChanged` (`row?.kind !== 'post'` short-circuit). A bogus `postUri` must never reach `POST /feed/mtn/interactions`. Each card kind also gets its own `feedRowType` bucket (`interstitial:<kind>`) so FlashList never recycles a card onto a post cell.
- **`FeedRow` (`feedRows.tsx`) is now a discriminated union** (`kind: 'post' | 'interstitial'`) — `PostFeedRow | InterstitialFeedRow` — the single row model shared by web and native, so both platforms inherit the splice from one `buildFeedRows`/`spliceInterstitials` pass.
- **Mix adapts to follow-graph density** — config-only, `MtnConfig.feed.interstitials` (`packages/shared-types/src/mtn/config.ts`): `allowedDescriptors` (`for_you`, `following`, `explore`), `coldMaxFollowing: 20` / `denseMinFollowing: 150`, per-temperature `positions` (slice indices) and `rotation` (kind order), `densePageInterval: 2`. Cold graph leads with `suggestedStarterPacks`, early (slice 3); dense graph mostly `suggestedUsers`, gated to every other page. No magic numbers in `planInterstitials.ts` itself — all tuning lives in shared-types.
- **Exclusions**: `GET /feeds/marketplace?excludeSubscribed=true` (via `FeedLike` — `EntityFollow{entityType:'feed'}` is a valid entity type but nothing reads it for this; `FeedLike` is the live subscription mechanism) and `GET /starter-packs?excludeUsed=true` (`ownerOxyUserId`/`usedByOxyUserIds` `$ne`). Oxy's scorer already excludes accounts the viewer follows, so `RecommendationService` was left alone.
- **Dismissal is per-card, in-memory only** (returns on refresh) — deliberate, matches Bluesky. No server-side dismissal state.
- **The PROFILE feed carries its own card** — `kind:'similarAccounts'`, the only kind that sets `subjectId` (the profile the suggestions are about). Planned by the SAME `planInterstitials` but on a separate path, deliberately OUTSIDE the graph-temperature model: that model asks how much bootstrapping the VIEWER needs, while this card is about the feed's SUBJECT and is just as useful to a viewer who follows a thousand people. Tuning: `MtnConfig.feed.interstitials.profile.positions`. The author descriptor is parsed with `parseFeedDescriptor` (so all four `author|<id>|<filter>` variants carry it), and the card is DROPPED on the viewer's own profile — hence `planInterstitials` takes `currentUserId`.
- **Card telemetry is counters-only** — `POST /feed/mtn/interstitial-events` (`MtnFeedController.recordInterstitialEvent`), body `FeedInterstitialEventInput`. **It must never go through `trackFeedInteraction` / `POST /feed/mtn/interactions`**: that path requires a `postUri` and feeds POST ranking, so card engagement sent there would corrupt author/topic affinity with engagement that never touched a post. Validation + the counter live in `mtn/feed/interstitials/interstitialTelemetry.ts` (pure, no Express import — the controller can't be unit-tested, it pulls in `server.ts` circularly). One metric, `feed_interstitial_events_total{kind,event,descriptor}`; `descriptor` is the BASE token (`author`, never `author|<id>`) and the body's `feedDescriptor` is validated against `isValidFeedDescriptor` precisely BECAUSE it becomes a label — an arbitrary string would let a client mint unbounded label values. Slot key, position and viewer id are never labelled. Anonymous viewers 200 no-op (never 401 — same precedent as `recordInteraction`). The hot path stays I/O-free: a counter write is a Map update.

## Feed Performance

- **Hydration author-batch**: `PostHydrationService.buildUserMap` batch-resolves authors via `oxyServices.getUsersByIds`. `services/userSummaryCache.ts` caches the raw canonical Oxy `User` (as `PostUser`) + followerCount + the account's BCP-47 `languages` in Redis (key `usersummary:v3:<id>`, 10m TTL); `invalidate()` evicts on federated-actor re-resolve (`connectors/identity.ts`). The follower count and languages are RANKING-side (`CachedUserSummary`) and deliberately never ship on the `PostUser` DTO.
- **View counts**: `services/feedViewCounter.ts` (Redis SET NX EX `viewseen:<postId>:<viewerId>`). Frontend reports impressions via `utils/feedTelemetry.ts`.
- **Instant post-detail**: memory-mode feeds seed the shared post cache (`postsStore.cachePosts`) in `useFeedState`; `app/(app)/p/[id].tsx` paints from cache + background-revalidates (`revalidatePostById`).

## Feed Ranking, Content Classification & Safety

### Unified Content Classification (two-stage hybrid)

All posts — native AND federated — go through the same classification pipeline at ingest.

**Stage A — deterministic baseline (`services/BaselineContentClassifier.ts`, pure/sync):**
Runs at all ingest chokepoints: `PostCreationService`, `feed.controller` reply path, `OutboxSyncService.insertMany`, `InboxProcessingService`. Writes a `postClassification` subdoc:

- `languages: string[]` — SINGLE multi-language field (ALL detected/declared ISO 639-1 codes, primary first, deduped, cap 3). Detection: tinyld `detectAll` with combined gate (`secondaryMinAccuracy:0.2` AND `secondaryMinRatioToTop:0.5`). Federated: `extractApLanguages` reads AP `language` + all `contentMap` keys (`connectors/activitypub/apLanguage.ts`). Feed language-match is ANY-OVERLAP (`$in` / `.some()`) at all 3 sites: `FeedRankingService`, `ExploreFeed`, `forYouCandidateSources`.
- Top-level `post.language` = `languages[0]` (primary, the AP protocol field).
- Sensitive, spam, quality, toxicity scores (`services/contentClassification/spamQuality.ts`), normalized hashtags, rule-based topics via `TopicClassifier`.
- Status: `'pending'` (waiting for Stage B).
- `BASELINE_CLASSIFIER_VERSION` (`services/BaselineContentClassifier.ts`) — ranking only trusts scores stamped at or above this version. The constant is the source of truth; never restate its value here, and bump it whenever a Stage-A signal changes meaning so older stamps stop being honored.

**Stage B — async AI enrichment (`PostClassificationService`, Alia):**
Uses DOTTED `$set` to enrich the existing subdoc — NEVER a whole-subdoc overwrite (would wipe Stage A fields). Topics via `postClassification.topicRefs` resolved through `TopicService.resolveTopicRefs`. Readers prefer `topicRefs`, fall back to `extracted.topics`, then neutral.

**MongoDB text-index `language_override` rule:** never let a text index's `language_override` point at a field holding free-form content-language codes — MongoDB rejects writes with error 17262 (`"language override unsupported"`). The `content.text_text` index uses `language_override:'textSearchLanguage'` (a sentinel field no document populates → always falls back to English stemming).

### Read-Surface Safety Gating

Sensitive/NSFW gating and muted words are per-VIEWER safety rules, not feed features — every surface that shows a viewer other people's content applies them. Three modules, no fourth copy of any predicate:

- **`mtn/feed/feedSafety.ts`** — the SINGLE source of truth for sensitive/NSFW. Reusable Mongo clauses (`SENSITIVE_EXCLUDE_MATCH`, `DISCOVERY_SAFE_MATCH`) + in-memory predicates. Feeds, ranking, Trending, **search**, **notifications** and the **OG web shell** all import from here — never re-implement the check inline. Per-user `privacy.showSensitiveContent` (default `false`, `PUT /profile/settings`) makes it viewer-conditional. `requiresContentWarning` is the WIDER gate (sensitive OR a federated CW) for surfaces that cannot render a warning at all — an unfurl, a plain-text notification preview; feeds keep the narrower `isSensitivePost` because their client shows a spoiler.
- **`services/safety/muteWordMatcher.ts`** — the pure compile/match for muted words, honouring `targets` (`content`/`tag`) and `actorTarget` (`all`/`exclude-following`; `needsFollowState` tells the caller whether the follow graph is worth loading). `MuteWord` has no expiry field.
- **`services/safety/viewerSafety.ts`** — the ONE read path for both viewer preferences (`loadShowSensitiveContent`, `loadMuteWords`); soft-fails toward the safe default. `services/viewerFollowGraph.ts` owns the Oxy ∪ federated follow union both feeds and `exclude-following` mutes read.

Surface behaviour: **search** excludes sensitive at the QUERY level and drops muted posts after hydration (cursor is taken from the UNFILTERED page window, so a short page never skips a result). **Notifications** withhold the preview/embed of a gated post but keep the row, and REMOVE a muted one entirely — both only for posts the viewer did not author (`viewerState.isOwner/isCollaborator`), since a mute must not hide engagement on your own work; `unreadCount` is a separate aggregate and still counts a removed row. **OG unfurls** emit no `og:image` and none of the body for a gated post (a boost is judged against its original too) — see § Fediverse Discovery.

### For You Ranking (`FeedRankingService.rankPosts`)

`rankPosts` is the ONE ranking path for ForYou, Explore, Videos, and Media feeds.

- **Candidates** (`mtn/feed/feeds/forYouCandidateSources.ts`): multi-source, bounded, parallel — following, affinity, topic/language/region match, trending, global discovery (always SFW).
- **Signals** (config in `packages/shared-types/src/mtn/config.ts`): author authority (bounded log-scale follower count), AI + deterministic quality/spam/toxicity (provenance-gated), engagement weights, diversity penalties (`sameAuthorPenalty`, `sameTopicPenalty`).
- **Author-diversity rerank**: `diversifyByAuthor` runs BEFORE page truncation; only the page window is hydrated.
- **Never-blank fallback**: when the unseen pool is exhausted (seen-set 1000 cap / 30-min TTL), ForYou falls back to `fetchPopular`.
- **Surface-aware engagement**: likes/saves/boosts from the Videos feed dampen author affinity but boost topic + post-type affinity. `Like.source` is persisted. Config: `preferences.engagementContext` in shared-types.
- **`userBehavior` context**: loaded in `feed.controller` on every ForYou request — affinity and preferred-topic signals were dead without it.
- **Viewer languages**: `loadViewerFeedContext` resolves the viewer's Oxy account languages (`loadViewerLanguages` → the Redis-cached `resolveUserSummaries` path — no extra Oxy round trip; fail-soft to `[]`). They are BCP-47 LOCALES (`es-ES`), while `postClassification.languages` are ISO 639-1 base codes (`es`), so `languageMismatchPenalty` compares on the BASE subtag via `getBaseLanguage` from `@oxyhq/core`. Empty on either side ⇒ neutral (never penalize).
- **Never honor default-zero scores**: ranking gates on `status === 'classified' OR version >= BASELINE_CLASSIFIER_VERSION` before trusting quality/spam/toxicity values.

## React Compiler — a render-phase ref write is REFUSED, not miscompiled

Writing a ref during render (`const r = useRef(x); r.current = x;` at the top level of a component or hook) does NOT produce a stale read with the compiler this app ships. Measured against the installed `babel-plugin-react-compiler` 19.1.0-rc.1 with the options `babel-preset-expo` passes in production (`target: '19'`, `panicThreshold: 'NONE'`): the compiler emits

```
CompileError: Ref values (the `current` property) may not be accessed during render.
```

and **bails on the entire function**, which then ships completely unoptimized. Control, same code with a closure instead of the ref: compiles to `_c(3)`.

So the live cost of this pattern today is **lost memoization for the whole component or hook**, not a stale value — one such line silently opts a file out of the compiler. Staleness remains a real risk, but through discarded concurrent renders, not through the compiler.

This matters because the fix is the same either way (close over the value and add it to the dep array, after checking callers pass a stable identity) but the REASON in a commit message or a review comment is often stated wrongly — including in `2ee96d48` and `29b82e5f`, which are correct fixes with an inaccurate rationale.

To check a specific site rather than reason about it, compile it with the app's own plugin and look for `_c(n)` versus a `CompileError` in the logger — that probe is a dozen lines and settles the question in seconds.

Distinct from the ecosystem rule in `~/AGENTS.md` about reading external mutable state inside a memoized position, which IS a stale-read hazard. Reading a ref in render and writing one in render fail differently.

**A `finally` CLAUSE also bails the whole function** (BuildHIR cannot lower it), while the promise `.finally()` METHOD is fine. Measured on the same plugin, one synthetic hook per shape against a no-try control at `_c(6)`:

| shape | result |
|---|---|
| no `try` at all (control) | `_c(6)` |
| `try` / `catch` | `_c(5)` |
| `try` / `finally` | **bails** |
| `try` / `catch` / `finally` | **bails** |
| `try` / `catch`, cleanup duplicated into both paths | `_c(6)` |
| promise `.finally()` method | `_c(6)` |
| `try` / `finally` nested inside a `try` / `catch` | **bails** |

**But a bail is NOT by itself evidence of a missing optimization.** Three hooks were audited for this (`useProfileScroll`, `useDrafts`, `useDeferredToggle`) and none was worth unlocking: they are already densely hand-memoized, and the compiler's inferred deps came out as the SAME sets as the hand-written arrays — so the cache it would add holds values nothing observes (`useDeferredToggle`'s entire net win was caching a returned object that both consumers destructure on the spot). Two of the three could not be unlocked at any acceptable price: `useProfileScroll` has no compiler-acceptable form for a throttle timestamp (ref → flagged, closure `let` → "reassigning a variable after render has completed", `useState` → a re-render per scroll check), and `useDrafts` would require rewriting four hand-written dep arrays to match inference, changing when viewer-isolation callbacks change identity.

The compiler pays off where code is NOT already hand-memoized. Check what the optimization would CONTAIN before spending a refactor to unlock it, and never restructure a `try`/`finally` that exists to guarantee cleanup on the error path — that trades correctness for a cache.

## CrowdSource Moderation (reports → cases → decisions → enforcement)

Reports leave Mention durably, CrowdSource decides them with a randomly drawn jury, and decisions come back signed. **CrowdSource owns cases, reviews and decisions; Oxy Trust owns reputation; Mention owns only its own enforcement actions.** Mention never computes reputation points and never calls Oxy Trust — it reports and enforces, nothing else.

Everything lives in `packages/backend/src/services/moderation/` plus three models (`ModerationOutbox`, `ModerationEvent`, `ModerationEnforcement`) and one route (`routes/crowdSourceWebhook.routes.ts`).

### The three rules that are load-bearing

- **A 201 from `POST /reports` means stored — and will-retry when the type is deliverable — NEVER "CrowdSource accepted it."** `ReportIntakeService` commits the `Report` and its `ModerationOutbox` event in ONE transaction; no outbound request is made in the request handler. Whether a delivery event exists at all is decided from ONE fact (a subject provider) read before the transaction body, so `localStatus` and the outbox row can never disagree. Two writes outside one transaction give two silent failure modes (a report nothing will ever send; an event whose report was rolled back) and neither surfaces as an error when it happens. **`enqueueModerationOutboxEvent` throws unless `session.inTransaction()`** — the type makes the session mandatory, the runtime check makes it mandatory that a transaction is actually open, because a bare `startSession()` type-checks, commits the row alone, and passes any test that only asserts the row exists. It is also the ONLY writer of that collection (the dispatcher claims existing rows, never creates one), so no second queue can drift out of sync: the row IS the job. **The upsert itself is `{ upsert: true, session, timestamps: false }`, with `createdAt` and `updatedAt` written explicitly inside `$setOnInsert`.** `ModerationOutbox` declares `{ timestamps: true }`, so leaving Mongoose to add its own `updatedAt` on top of the explicit one names that path in two operators of one update document — Mongo refuses the WHOLE write, which took the `Report` down with it since the enqueue runs inside `createReport`'s own transaction. Dropping the explicit fields instead of naming both under `timestamps: false` clears that error but reintroduces a different one: Mongoose's own `$set: { updatedAt }` then survives on the update, so a repeated enqueue for a row that already exists stops being a no-op and becomes a real write that contends with the dispatcher's live lease on that row. Both fields explicit, `timestamps: false`, is what keeps a retry a genuine no-op.
- **The webhook route MUST stay mounted before `express.json()` in `app.ts`.** The signature covers the bytes that arrived. Mention's parser keeps `req.rawBody` as a *string* for ActivityPub signatures, and `@oxyhq/crowdsource-express` wants a Buffer — so after the parser it REFUSES rather than verifying a re-serialisation. Guarded by a test in `appFactory.test.ts` that reads the stream and asserts `typeof req.body === 'undefined'`.
- **Enforcement is idempotent on `decisionId + revision + action`** (Appendix D), enforced by the unique compound index on `ModerationEnforcement`. Each action CLAIMS its row before acting and releases it if the effect throws. `revision` is in the key so a correction's `restore` is a *different* action from the removal it supersedes — remove it and an accepted appeal can never put the post back.

### Enforcement modes and Mention's three primitives

`CROWDSOURCE_ENFORCEMENT_MODE` (`observe` | `manual` | `automatic`, default **`observe`**). `observe` plans and RECORDS every action with `applied: false` and removes nothing — the audit trail is real, so the mode proves what will happen when it is switched off. `manual` additionally applies only the give-something-back half (`restore`, `unlabel_sensitive`).

Mention maps `decision.recommendedActions`, **not** findings — the jury already classified the material under a versioned policy, and re-deriving an action from raw severity would be Mention re-deciding the case with a second unversioned policy. Severity is a fallback only when a `violation` arrives with no recommendation. The map lives in `enforcementPlan.ts` (pure, table-tested):

- `restrict` → `Post.status = 'restricted'`. Every feed source and the post-hydration ACL already require `status: 'published'`, so this removes the post from discovery, ranking, search and every DTO with **no feed query to edit**, and the author's `visibility` choice survives for the restore. `PostPublicationStatus` in shared-types carries the fourth value; `CreatePostRequest` deliberately does not, so a client cannot ask for it.
- `label_sensitive` → `metadata.isSensitive`, which the existing `feedSafety` gate already reads. This is what `label`, `age_gate` and `reduce_distribution` all become — Mention has no separate distribution dial and recording an effect that did not happen would be worse than mapping honestly.
- `manual_review` → recorded, never executed. `suspend_user` is **Oxy's** to carry out, `legal_queue` needs a human. §7.6 lets an application refuse a recommendation provided it records what it did; a declined recommendation must never look like one that never arrived.

**`no_violation` always plans a `restore`, whatever it recommended.** A correction's recommendation is frequently `no_action`, which means "take no NEW action" — mapping it straight through leaves the post its superseded revision removed down forever, with no error anywhere. Caught by a test; do not "simplify" it away.

### The subject-provider seam (what a second app writes)

`subjects/types.ts` is the whole per-application surface: given one of your own nouns and its id, return a `ModerationSubjectSnapshot` (subject + content + attachments + context) using the **SDK's own input types**. Everything else — resource ids, relations, digests, pseudonymous principal refs, the identity binding proof, the pinned policy version, privacy terms, the idempotency key, the envelope — is composed by `@oxyhq/crowdsource`.

A provider returns a DESCRIPTION and never an envelope. §7.3's dedup key is computed over exactly the values the SDK derives, so an app that composed its own envelope would be the reason two reporters about one post open two cases. Adding a noun = one provider file + one line in `subjects/registry.ts`; nothing in the outbox, delivery worker, webhook receiver, decision worker or enforcement service changes.

`EvidenceSnapshotService` is the plan's `CrowdSourceCaseEnvelopeBuilder` under an honest name: it builds the SDK's `ReportInput`, not a Case Envelope.

**Nothing the builder composes may vary between two deliveries of the same report.** Ingress fingerprints the whole envelope to detect §10.5's payload conflict, so an invented timestamp, a random id or an unsorted list turns a legitimate outbox retry into a permanent 409 — silently, days later, as a report stuck in a queue. Hence: `submittedAt` is the report's own `createdAt`, allegation codes are sorted, and resource order is positional.

### Known gaps (deliberate, not oversights)

- **Media evidence is declared, not attached.** A post with no text gets a `metadata` subject resource saying what it consisted of, so a jury can answer `insufficient_context` for the right reason. **The answer changed at contracts 0.3.0 and is now small:** `AssetRef` is `{ fileId, url?, mimeType, sha256, sizeBytes?, width?, height?, durationSeconds? }` — the `uploadId`/`Uploads` route is gone, CrowdSource serves no upload route, bytes go through the Oxy media chokepoint, and `url` is provenance no reviewer client ever dereferences. Mention already holds all of it: `MediaItem.id` IS the `fileId` (federated too, once the media cache rewrote it — origin URL kept in `remoteUrl`), and one batched `getServiceAssetMetadataByIds` returns `{sha256, mime, size, width, height, durationSec}` field-for-field. **No byte fetching** — Mention makes that same call in `services/mtn/mentionRecordBuilders.ts` (`resolvePostRecordEmbeds`) for the MTN chain. Closing it: one function in `postSubject.ts` + flip `evidenceAttachmentsSupported`. Two traps documented in that file: the digest must enter the snapshot hash, and a federated item the cache never rewrote has a URL in `id` and no file id, so it must stay declared-only.
- **Mention only SENDS FOR REVIEW the objects it owns — `post`, `comment`, `user` — but it ACCEPTS every type in the enum.** Two questions, two authorities, and conflating them was tried and reverted: `ReportedType` is the API contract, `subjects/registry.ts` decides delivery. A type with a provider gets a `ModerationOutbox` row in the intake transaction and `localStatus: 'queued'`; a type without one is stored at `localStatus: 'received'` with `localStatusReason` saying why, and **no outbox row is created at all** — never one that a worker skips later, because that would dead-letter (`ModerationSubjectUnsupportedError`, `retryable: false`) a report that is not defective. `POST /reports` only 400s a type the enum has never heard of.
  - **Why not refuse.** Gating the route on the registry makes adopting CrowdSource a breaking change for every report surface an app has not yet wired up. Incremental adoption, one subject type at a time, is the property the other six apps (Mercaria, Homiio, Allo, Noted, Moovo, Alia, Syra) need — so a type with no provider must keep its previous local behaviour.
  - **Why a live room has no provider,** and would not gain one by trying harder: Mention owns the room *experience* (`LiveRoomContext`, the room UI) but persists no Room document, so §5.6's "pin the exact version reported" has nothing to pin short of capturing audio. The tenancy argument survives even if a Room document appeared — `applicationId` comes off the credential, so the case would open in *Mention's* tenant naming an object only Syra can enforce against, and Syra reporting the same room under its own credential gets a different §7.3 dedup key, hence two cases, two juries, two consequences. Both arguments land on a **missing provider**, not a refused report. Cross-application hand-off is still an open design question.
  - `frontend/services/reportService.ts` `reportRoom` (live-rooms overflow menu, `app/(app)/live-rooms/[id].tsx`) therefore succeeds and stores a local row. Its toast — "Thank you for helping keep our community safe." — promises no review, which is what makes that honest. `ReportedType.ROOM` was added for it; `ReportedType.MESSAGE` predates all of this and has never had a caller (DMs are Allo's).
  - **The cost is real and is measured, not hidden.** A `received` report is a receipt for work nobody does. `reconcileModerationReports` therefore COUNTS them (`localOnly`) and must never re-queue one — the sweep's `$in` is `['queued','delivery_failed']` and adding `'received'` to it sends every local-only report to the dead-letter queue.
- **A restricted post is invisible to everyone but its author.** There is no author-facing "your post was removed" surface yet; build one before `automatic` mode is enabled for real.

### Environment

The names come from the packages, not from the plan's §14.6 table, and the packages win:

```
CROWDSOURCE_ENABLED=false
CROWDSOURCE_SERVICE_KEY=            # applicationId:credentialId:secret, ONE opaque value
CROWDSOURCE_BASE_URL=               # optional; the SDK defaults to the one deployment
CROWDSOURCE_WEBHOOK_SECRET=
CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS=   # both accepted during a rotation (§10.8)
CROWDSOURCE_OUTBOX_BATCH_SIZE=50
CROWDSOURCE_OUTBOX_POLL_INTERVAL_MS=5000
CROWDSOURCE_ENFORCEMENT_MODE=observe
```

**There is no `CROWDSOURCE_APP_ID`, and never add one.** `applicationId` is read off the credential; a variable holding it could only ever disagree with the credential. `CROWDSOURCE_ENABLED=true` requires BOTH the service key and the webhook secret (enforced in `config/index.ts`) — a half-configured integration sends reports that can never come back.

### Lifecycle

- `moderationOutboxDispatcher` starts on EVERY task (`server.ts`, next to `engagementOutboxDispatcher`): claims are Mongo leases with an owner check, so N tasks share the work and a dead task's lease is reclaimed. No-ops when `CROWDSOURCE_ENABLED=false` — the LOOP is gated, never the durable record, so reports taken while off deliver when it is switched on.
- `moderationReconciliationJob` is leader-gated (`startSchedulers`), 15-minute sweep: re-derives a missing delivery event with the same deterministic id, COUNTS dead-lettered ones (re-queueing would spin) and counts cases gone quiet.
- The webhook dedupe store is **Mongo-backed** (`moderationEventStore.ts`) because Mention runs several ECS tasks; the SDK's in-process default would dedupe only the instance that received both copies of a redelivery.

## Theming

- Default color preset for **Mention frontend: `blue`**.
- `BloomThemeProvider` is the single source of truth for mode + color preset, with built-in persistence. Pass `persistKey` + `storage` — do NOT add a local theme store. It is mounted for us by `<BloomProvider>` (see below), never directly.
- Settings UI uses `SettingsList` (`SettingsListGroup` / `SettingsListItem` from `@oxyhq/bloom/settings-list`). Do not introduce local `SettingsItem` wrappers.
- `BloomColorScope` owns scoped Bloom/NativeWind variables for profile theming. Do not add app-local scope helpers.
- **ONE Bloom root:** `frontend/app/_layout.tsx` mounts `<BloomProvider>` (`@oxyhq/bloom/provider`) and nothing else mounts a Bloom state provider. It composes theme + haptics + image resolution + scroll restoration + tab-bar minimize progress, so every one of them sits above the whole shell — including `RightBar`, which renders BESIDE the routed content and hosts its own scrollable feed on `/videos` (that rail crashed the screen when scroll restoration wrapped only the center column: on web `useScrollRestoration()` throws outside its provider). Consumers use `useTheme()` / `useBloomTheme()` from `@oxyhq/bloom`. Outlets are still mounted by the app (`ToastOutlet` comes from `OxyProvider`, `Portal.Provider`/`Outlet` from `app/_layout.tsx`).
