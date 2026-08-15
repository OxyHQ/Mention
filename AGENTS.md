# Mention

> Org-wide engineering standards (TypeScript, React, naming, error handling, security, testing, git, bun) live at <https://github.com/OxyHQ/engineering/blob/main/AGENTS.md> and are not repeated here. Parent files (`~/AGENTS.md`, `~/Oxy/AGENTS.md`) hold the agent team, shared-SDK rules, and the Bloom/Expo/expo-router gotchas. This file holds ONLY Mention-specific RULES, commands and pointers — architecture and how-it-works narrative live in `docs/`; status and history live in git. **Budget: under 24 KB.**

Docs: `docs/architecture.mdx` (workspace/runtime/lifecycle), `docs/fediverse.mdx` (protocol surface + connector contract), `docs/federation-behaviors.md` (federation edge cases), `docs/channels-and-lanes.md`, `docs/moderation-crowdsource.md`, `docs/feed-ranking.md`, `docs/frontend-compiler-notes.md`, `docs/api.mdx`, `docs/AWS_DEPLOYMENT.md`, `docs/MONGO-TO-POSTGRES-CUTOVER.md`, `packages/mcp/README.md`, `packages/frontend/docs/INTENT_URL.md`, `packages/frontend/docs/TESTING-POLICY.md`.

## Layout

`packages/frontend` (Expo, expo-router, NativeWind, TanStack Query, Zustand, Socket.io, LiveKit) · `packages/backend` (Express, Postgres/Drizzle, Redis, Socket.io, Bun runtime) · `packages/shared-types` · `packages/mcp` · `packages/e2e` (Playwright release gate against the production origin). Bun workspaces. Every version is in `package.json` — the frontend's own manifest for `expo`, the root `overrides` for `react-native`/`react` (the override wins, read it there). Never restate a version here.

## Commands

```bash
bun run dev / dev:frontend / dev:backend / dev:mcp / dev:mcp:http
bun run build            # shared-types + backend + mcp
bun run test / lint / check / clean
```

- **Run backend tests from the package root** (`cd packages/backend && bun run test`) — from the repo root they pick up stale `.dist` copies and report false failures.
- **Rebuild `shared-types` before believing a red typecheck or build.** It is consumed through its BUILT `dist`, so after a rebase every other package compiles against the previous build and reports newly-landed symbols as missing (`TS2305`) in files you never touched.
- **A `doctor` failure SIGINTs the rest of `check:workspace`** — the killed siblings are not broken and which ones die varies per run. Re-run the survivors individually (`validate:workflows`, `validate:lockfile`, `validate:i18n`, `validate:logger`, `audit:security`) before believing any of them failed.
- **The backend and MCP run on Bun, not Node**, typed `["node","bun"]`; `@types/bun` is catalogued at the exact `packageManager` version and doctor fails on drift. The frontend stays Node-typed.
- **`bun install` refuses to RESOLVE a dependency published in the last week** (`minimumReleaseAge`). Never affects `--frozen-lockfile`. Any step that RE-RESOLVES must pass `--minimum-release-age=0` (`.github/scripts/verify-lockfile.sh` does). First-party packages are excluded by EXACT name — a scope glob parses and matches nothing, so a new first-party dependency must be added to `minimumReleaseAgeExcludes`. A warm manifest cache hides this; verify against CI or a cold cache.
- **Do not try to replace a dependency with a Bun built-in here.** `Bun.YAML` loses duplicate-key detection (breaks `scripts/validate-workflows.mjs`). `Bun.redis` has no `multi`/`exec`/`watch`. `Bun.Image` is not reachable from `expo prebuild`'s Node. `bun test` replaces neither Vitest (backend) nor Jest (frontend). The global virtual store is unreachable under `linker = "hoisted"`, which Metro requires.
- **`bun run test` computes no coverage.** CI runs `test:coverage` + `coverage:check` against `packages/frontend/coverage-policy.json` (per-file pins, a no-regression ratchet). After genuinely raising coverage, run `coverage:record` and commit `coverage-baseline.json`. **`jest-expo` resolves the NATIVE platform extension** — a bare relative import never loads a sibling `.web` fork, so a broken web-only fork can vanish from the coverage denominator and the overall percentage moves the reassuring way. The only honest signal is the file's ABSENCE from the report, which is what the policy asserts.

## Bumping an Oxy SDK package (`bun add` reports success and changes nothing)

- **Shared versions live ONLY in `workspaces.catalog` in the root `package.json`.** A bump is one catalog edit plus `bun install`. Manifests and the root `overrides` name the package as `"catalog:"`.
- **`bun add`/`bun update` are the wrong tools** — an override beats a workspace range, so they print success and leave the old version in `node_modules` and `bun.lock`. Doctor rejects a manifest or override re-pinning a catalogued package to a literal range, and rejects `@oxyhq/bloom` in the root `dependencies`.
- Packages with a single consumer and an exact pin (`@oxyhq/crowdsource*`, `@oxyhq/federation`, `@oxyhq/protocol`) are deliberately NOT catalogued.
- **After bumping, check no NESTED copy of the old version survived** — an incremental install preserves a recorded edge by nesting it, and every gate stays green while a dependent loads the old major. `grep -oE '"[^"]*<pkg>": \["<pkg>@[0-9.]+' bun.lock | sort -u` must print exactly one line; delete the stale nested keys and reinstall rather than regenerating the lockfile.
- `bun update` also writes touched packages into the ROOT `dependencies` — check `git diff package.json` after running it.
- **Assert the installed version after any bump** (`node -e "…/package.json').version"`) before running any gate.
- **Do NOT regenerate `bun.lock` from scratch.** `.github/scripts/verify-lockfile.sh origin/main` prints the minimal correct delta, and compares the COMMITTED lockfile.
- `validate:lockfile` check 4 is the only gate that catches a catalogued bump landing a major its dependents reject; deliberate cases live in `ACCEPTED_OVERRIDE_RANGE_VIOLATIONS`.

## This checkout: worktrees and stub servers

- **Never `git stash` here.** ~70 linked worktrees share one repository stash stack, a committed worktree stashes nothing (exit 0, no entry), and `pop` then takes another session's work into your tree. Compare against another commit with a separate detached worktree or `git show <commit>:<path>`. If it happened: a CONFLICTED pop does not drop the entry — restore your files, then VERIFY the entry survived.
- **A stub server must bind a RANDOM high port** — never `4110`, which every frontend dev server here targets — and its teardown must be VERIFIED (`pgrep -f`, `ss -ltnp`), never trusted to `pkill`'s exit status.

## CodeQL

A finding on your PR reports what the DIFF introduces, not what the repo accepts — **count the same rule on `main` first** (`gh api --paginate repos/OxyHQ/Mention/code-scanning/alerts`). Convention: a route-level limiter for feeds, expensive aggregations and spam-surface writes; plain CRUD rides the app-wide `createOxyRateLimit` (a closure in `app.ts`), which the query cannot see.

- **`router.use(...limiters)` with an empty array throws at import.** The `isProduction ? [x] : []` idiom is only safe in the PER-ROUTE position — which is also the only position CodeQL inspects.
- **`rateLimitPrefixUniqueness.test.ts` resolves prefixes by reading SOURCE**, so write each `RedisStore` prefix as a literal, never through a factory.

## `typedRoutes` is ON and INERT — see `~/Oxy/AGENTS.md` § expo-router

Not Mention-specific — the finding lives in the parent file. Mention's own gate: `app/(app)/settings/__tests__/settingsRouteTargets.test.ts` walks the real `app/` tree and asserts every route a settings screen navigates to exists. Scoped to settings on purpose (all-static routes); widen before trusting it elsewhere.

## Indexes and migrations (Postgres)

Schema changes go through `drizzle/` and `src/db/migrate.ts`, and nothing else. The deploy applies them as its FIRST one-shot, before `update-service`, and `assertPostgresMigrationsCurrent` refuses to let a task become ready if that step did not run.

The Mongo migration mechanism (a runner, a ledger-guarded task, 26 migrations, a top-level migrate one-shot) no longer exists. Anything you find describing a migrations-constants module, a `MIGRATIONS` array, or a hot-path-index manifest describes a mechanism that is gone — do not resurrect that pattern for a Postgres index.

## PostgreSQL — the only store

Mention was on MongoDB until August 2026 and is now Postgres-only; nothing in the repo can open Mongo (models, deps, config bindings and the `MONGODB_URI` SSM param are all deleted). Enforced by `scripts/validate-no-mongo.mjs` (`bun run check`). History: `docs/MONGO-TO-POSTGRES-CUTOVER.md`.

- Per-table conventions: `packages/backend/src/db/schema/CONVENTIONS.md`. `packages/backend/src/db/MIGRATION-CONTRACT.md` is a historical stub holding two RDS facts; ecosystem-wide porting rules live in oxy-api's own migration contract (OxyHQServices repo).
- PostGIS-on-RDS privilege and the ownership-probe trap are general Postgres/RDS findings — see `~/Oxy/AGENTS.md` § PostgreSQL semantics. Production's `mention` role OWNS the `mention` database.
- **Ported ids are 24-hex, new ids are uuid v7, and the two interleave under text collation.** `posts.id` and friends are `text`, so `id < X` is not a time bound. Never page or order a chronological query by id — `mtn/feed/CursorBuilder.ts` carries the keyset that replaced it.
- **Local dev runs two compose files on purpose.** `docker-compose.yml` runs the whole stack on loopback port 5434; `docker-compose.postgres.yml` binds 5433 for the database that pairs with `bun run dev:backend` and the test suite, so both can be up at once. `DATABASE_URL` is required at boot.

## Local Android release APK

```bash
cd packages/frontend/android
NODE_ENV=production ./gradlew :app:assembleRelease -x lintVitalRelease \
  -PreactNativeArchitectures=arm64-v8a -Dorg.gradle.jvmargs="-Xmx8g -XX:MaxMetaspaceSize=1g"
```

- **`NODE_ENV=production` is REQUIRED** or `export:embed` aborts and the APK ships with NO embedded bundle (verify: `unzip -l app-release.apk | grep index.android.bundle`).
- Build arm64-only; the multi-ABI build fails at the x86 CMake task.
- **Metro dev builds must run from `packages/frontend`**, not the repo root — from the root Expo resolves the legacy `expo/AppEntry` and returns HTTP 500.

## MTN Protocol (Mention's signed-records layer)

Structure and lifecycle: `docs/architecture.mdx` § MTN signed records. Posts are dual-written as signed records on a per-user hash chain riding on the shared `@oxyhq/protocol` engine; Postgres stays authoritative, the chain write is a best-effort side-effect (`Promise.allSettled`), gated on local authors.

- **A record's `createdAt` is SELF-ASSERTED and must go through `clampFutureDate`** (`utils/ingestTimestamp.ts`, the one guard every ingest path shares). Windows: 1h for MTN/atproto (author-asserted directly), 24h for ActivityPub (a third-party clock we cannot audit). REJECT and fall back to `now` — never re-date to the clamp edge.
- Custodial signing (web posts, `issuer = MENTION_DID`) vs. self-issued (native, `issuer === subject`) is gated by `MENTION_DID`/`MENTION_PRIVATE_KEY`/`MENTION_PUBLIC_KEY`. Inert without them. Write API: `services/mtn/MentionRecordService.ts`; storage: `db/schema/mtn.ts`.
- **Lexicons live in `@mention/shared-types`** (`src/mtn/lexicons.ts`); `@oxyhq/contracts` owns only the transport around them. Importing a `mention*RecordSchema` from `@oxyhq/contracts` is a `TS2305` — it does not export one.

## Federation

Protocol surface, consent flow and the connector contract: `docs/fediverse.mdx`. Edge cases (reposted-post shapes, bridge identity, handle qualification, thread federation, blocklist/purge, HLS): `docs/federation-behaviors.md`.

- **Never redirect the apex ActivityPub ENDPOINT paths** (`/ap/*`, webfinger, host-meta, nodeinfo) — a 301/302 silently kills ALL inbound federation while GETs keep working. Signatures are verified against `X-Forwarded-Host`, so mount the federation routers BEFORE `apexFrontendProxy`. The profile-URL 302 (`/@user` with an AP `Accept`) is a GET-only content negotiation and is fine.
- Apex is served entirely by the backend — do NOT reintroduce a Cloudflare Worker or Pages Functions in front of it; `mention.earth` is CF-proxied to the shared ALB and served by the Mention backend.
- Actor `publicKey.id` host MUST equal the actor `id` host; `icon.url` must be absolute and reachable; `/.well-known/host-meta` must be mounted before auth.
- **Outbound fan-out must resolve the author's username SERVER-SIDE from `oxyUserId`** (`resolveFederationUsername`), never from `req.user.username` — the auth middleware runs without `loadUser`, so gating on it federates ZERO posts while everything looks healthy.
- **Pass the post DOCUMENT to `post.create`/`post.update`, never a hand-picked literal** — `LocalPostEventPayload` names fewer fields than the Note builder reads, so a literal silently drops `sensitive` and quote fields. Gate: `__tests__/connectors/outboundPostPayloadShape.test.ts`.
- Outbox sync uses the actor's advertised `outbox` URL; `actorUri + '/outbox'` is fallback only — guessing breaks PeerTube/Lemmy/some Pleroma.
- **A bare boost must never federate as an empty `Create(Note)`.**
- **Structure comes from structured fields, never from the body.** See `docs/federation-behaviors.md` for the three reposted-post shapes and why a bridge-flattened retweet is dropped rather than reconstructed.
- **Bridge identity comes from the actor's `type`** (`Service` = mirror, `Person` = operator), never from its bio; `Application` is refused (it is the server's own actor).
- **A thread federates through `PostCreationService.federatePublishedPost`** — the one implementation both the immediate and scheduled paths call. A chain STOPS at the first entry that does not go out, consent included.
- **Bridge relabelling policy is `connectors/activitypub/federationBridgePolicy.ts`; the blocklist is `connectors/activitypub/federationBlockPolicy.ts`** — enforcement and the public transparency page read the SAME array. oxy-api keeps a SEPARATE trust list and the two are deliberately NOT consolidated.
- **Fediverse sharing consent:** Oxy owns the flag; Mention never stores it. `services/fediverseSharing.ts` is the ONLY read path and all SDK reads use `{cache:false}`. Undo handlers stay UNGATED so teardown converges. Fail-open everywhere except the cleanup job's guard and the inbox POST (a 4xx makes Mastodon drop deliveries forever).
- **All federation UI lives under `settings/fediverse/`** — add a row inside the hub, never beside it. `/transparency` stays a public top-level route.
- **Author hydration must NEVER emit a raw `oxyUserId` as a handle.** Unresolved authors get the degraded summary (empty username, `'Unknown user'`), never cached.
- **OG cards are safety-gated (`/p/:id`)** — a post carrying any sensitivity signal, or a boost whose original carries one, gets NO `og:image`/body text; the verdict comes from `requiresContentWarning` and is a REQUIRED argument to `mapPostOg`.
- **One-shot scripts in `src/scripts/` MUST close every resource they opened and `process.exit()`** (`closeAdminScriptResources()` in `scripts/lib/adminScriptLifecycle.ts`), or the Fargate one-shot task runs forever.
- **Mastodon negative-caches failed resolutions for minutes/hours** — after a fix, cache-bust by searching the full profile URL (a different cache key than the acct handle).

## Lanes and Channels

Deep detail: `docs/channels-and-lanes.md`.

- A **lane** is a track owned by a publisher (an Oxy `oxyUserId`); a post carries at most one `laneId` and stays an ordinary post otherwise. `hidden` display mode is CURATION, not privacy — those posts still reach every feed. `assertLaneAssignable` (`utils/laneAssignment.ts`) is the single validator; skipping its `channelId` argument deanonymizes a channel writer.
- A **channel** is an Oxy account (`kind: 'channel'`), not a Mention row — `post.oxyUserId`/`post.authorship` carry the channel, and `Post.writtenByOxyUserId` (never in `authorship[]`) holds the human who wrote it.
- **`UserSettings.channel.signPosts` is the WHOLE disclosure decision**, made server-side, failing CLOSED at three points (author must resolve `kind: 'channel'`, `signPosts === true` exactly, undisclosed writer id never sent to the identity batch).
- **A channel can never be acted as** (`isActAsEligibleKind` refuses it) — publishing as one goes through `CreatePostRequest.publishAsOxyUserId`, gated by `services/publishAsAccount.ts` (fails closed). `services/postManagementAccess.ts` gates all seven management routes on CURRENT membership, never on the stored writer. Mutation-tested against real rows: `__tests__/channelAccountSchema.test.ts`, `__tests__/services/postHydrationChannelWriter.test.ts`.
- **No replies, ever** — gated on the author's account `kind` at five sites, including federated ingest where it drops silently (a throw retries forever; a 4xx ends delivery permanently).
- **A channel post has no 30-minute edit window — it has a correction trail instead** (`post_corrections`), which never discloses its author (routing around `signPosts` otherwise).
- A channel's page is `/c/<handle>`; there is no `channel|<id>` feed descriptor and no separate follow model.
- **You cannot block, report, or mute an account you operate** — refused on the SERVER with 400 (not 403), failing toward ALLOWING on an unresolvable answer.

## Post lifecycle

- **A cascade delete filter naming a field the schema lacks is a silent no-op that reports success.** `deletePost` passes the deleted post DOCUMENT to `cascadeDeletedPost` (`services/PostDeletionCascade.ts`), scored against `POST_REFERENCE_PROBE_NAMES` (`scripts/lib/adminDeletionPreflight.ts`) — every known post reference with a disposition (`cascade`/`cancel-pending`/`retain`). A new field naming a post needs a probe added there. Six direct-FK children are left to `ON DELETE CASCADE` on purpose (re-implementing them would be permanently untestable); `EngagementOutbox`/`FederationDeliveryQueue` are `cancel-pending` (unindexed, so an unscoped delete would scan); a `Report` stays `retain`ed (a resolving CrowdSource decision must not strand).
- **`authorship[]` is REQUIRED on every post**; there is no read-time legacy fallback. A post with a pending collaborator invite does NOT federate until the last invite resolves (`maybeFederateOnResolve`). Invites are published-only — a scheduled post defers invites/MTN/notifications/federation until it goes live. Threads reject `collaboratorIds` with 400.

## Post and identity rules

- **Post DTOs MUST come from `PostHydrationService`** (`services/PostHydrationService.ts`). Controllers never hand-build post `user`, notification embedded posts, or feed shapes.
- **`post.user` / `authors[]` / `boost.actor` are the canonical Oxy `User` shape**, passed through unchanged. No `avatarUrl`, no flat `displayName`/`handle`, no Mention-local adapter. Every renderer derives the handle via `getNormalizedUserHandle`.
- Degraded author (Oxy resolve miss) = empty `username` + `'Unknown user'`; a degraded FEDERATED author is enriched from Mention's own `FederatedActor` record but never invents `displayName`, and is never cached.
- Valid profile URLs: `/@username` and `/@username@domain`. A duplicate suffix (`/@user@domain@domain`) is a handle-normalization bug.

## Feed rules

Ranking, classification, safety gating and interstitials detail: `docs/feed-ranking.md`.

- **`ChronoCursor.applyToQuery` ASSIGNS `match.$or`.** Any filter written as a disjunction is deleted the moment a cursor arrives, so page one filters and every later page leaks. Use plain conjunctive terms or `$and`; a test that pins it needs a LIVE cursor.
- **FOUR field projections feed hydration** (`mtn/feed/FeedAPI.ts`, `controllers/feed.controller.ts`, `services/ThreadSlicingService.ts`, `routes/search.ts`). A field missing from one hydrates `undefined` with no error.
- **Any surface INCLUDING boosts must pass `maxDepth: 1`** or boosts render blank.
- **Never sort an author query by `_id`** — a federated post's `_id` bears no relation to its remote `createdAt`, so it skips backfilled posts at the page boundary.
- **`hasMore` comes from the overfetch flag**, never `slices.length >= limit`.
- **Never put a non-post inside `slices[].items`** — `flattenSlicesToItems` pushes `item.post` unguarded. Interstitials (planned in `mtn/feed/interstitials/planInterstitials.ts`) are a top-level field, anchor by `_sliceKey`, and must never report impressions or go through `POST /feed/mtn/interactions`.
- **Never block the feed response on remote link-preview or image fetching.**
- **Ranking gates on `status === 'classified' OR version >= BASELINE_CLASSIFIER_VERSION`** (`services/BaselineContentClassifier.ts`) — never honor default-zero scores. Stage B enriches with DOTTED `$set`, never a whole-subdoc overwrite.
- **Never point a text index's `language_override` at a field holding content-language codes** — moot now that search is Postgres full-text (`websearch_to_tsquery`), but the rule generalizes.
- **Safety gating has three modules and no fourth copy of any predicate:** `mtn/feed/feedSafety.ts` (the single source of truth), `services/safety/muteWordMatcher.ts`, `services/safety/viewerSafety.ts`.

## Frontend: two post-list caches

React Query (the saved screen) and the feed store (every `<Feed>` surface, warm-starting a remount from `stores/feedScrollStore` instead of refetching page 1) cannot see each other. `stores/engagementInvalidation.ts` is the single authority; **do not invalidate from the hooks** — `usePostVote` and `app/(app)/videos.tsx` write through the store directly, bypassing `usePostSave`/`usePostLike`/`usePostBoost`. There is no query key for likes/boosts lists, so `invalidateQueries` there is a no-op. Client-wide `refetchOnMount` must stay at the library default.

## Frontend rules

- **React Query keys and effect deps MUST include `isAuthenticated` / `user?.id`** — SSO restore takes 5–25 s, and keying on `oxyServices` or `[]` fetches once while anonymous and never recovers. Gate private endpoints on `useAuth().canUsePrivateApi`, not just `isAuthenticated` (`usePrivacyControls`'s infinite-401 pattern). Jest does not reproduce this; verify in a real foregrounded tab.
- **A virtualized web list must be opted out of the React Compiler EXPLICITLY** (`'use no memo'`) — a stable virtualizer instance's re-renders are internal to the hook, so the compiler freezes `getTotalSize()`/`getVirtualItems()` forever in prod builds only. Do not reason about which shape is safe: compile the file with the app's own `babel-plugin-react-compiler` and read the CompileError/CompileSuccess events. Verify on a PROD build. Detail and the measured `try`/`finally`-bails table: `docs/frontend-compiler-notes.md`.
- **`VirtualizedWebFeed`** (`Feed.web.tsx`) is the single scroll-owning path for top-level feed screens, warm-starting a remount from `stores/feedScrollStore.ts`; `EmbeddedWebFeed` is for genuinely nested sub-lists only. The `Math.max(totalSize, lastItemEnd)` spacer-size guard stays even though its original cause (a compiler freeze) is gone — cheap insurance. Panel insets come from `components/shell/PanelChrome.tsx`, never per-page padding.
- **Two loggers, identical signatures, opposite meanings for argument two.** `@oxyhq/core/logger` (frontend) is `error(message, error?, context?)`; the backend pino wrapper merges a non-Error second argument as context. Gate: `bun run validate:logger`.
- **ONE Bloom root** — `app/_layout.tsx` mounts `<BloomProvider>` and nothing else mounts a Bloom state provider. `BloomThemeProvider` (via `persistKey`+`storage`) is the single theme authority; no local theme store, no app-local color-scope helpers, no local `SettingsItem` wrappers. Default color preset: `blue`.
- **Do NOT re-enable GET caching on any linked client** (`utils/api.ts`, the Syra client at `lib/syraApi.ts`). Syra live-rooms talk to Syra's own backend, never `api.mention.earth`.
- **Mention keeps its own CORS middleware on purpose** (`app.ts` + `utils/allowedOrigins.ts`) — do NOT switch it to `createOxyCors`, which cannot express the dev LAN pattern and would broaden production CORS to the whole `*.oxy.so` family.

## Media

Canonical avatars/media: `oxyServices.getFileDownloadUrl(id, variant)` everywhere — no per-app URL helpers or `avatarUrl` DTO fields.

- **Federated media proxy** (`GET /media/proxy?url=…`, `utils/mediaResolver.ts`) is SSRF-guarded UPSTREAM (`assertSafePublicUrl`/`isBlockedIp` from `@oxyhq/core/server`), never a local copy. HLS playlists are rewritten, never relayed (`utils/hlsManifest.ts` + `utils/hlsSignature.ts`). **Never gate HLS on `canPlayType`** (Chromium answers `"maybe"` then fails) — probe `isTypeSupported`. **`import('hls.js')` must stay a SINGLE call site** — a second one promotes the demuxer into eager `__common.js` (see `~/Oxy/AGENTS.md` § Metro web chunking). Full narrative: `docs/federation-behaviors.md`.
- Video poster (`GET /media/poster`) needs a `video/*` upstream — an HLS playlist URL 415s there.
- S3 activity cache is gated on `FEDERATION_MEDIA_CACHE_WRITE_ENABLED`; unset means the proxy works but nothing writes to S3.
- **Federation service credential:** a bad/missing credential fails signed fetch silently (0 posts), and the outbox-sync cooldown makes the empty first sync permanent until `lastOutboxSyncAt` is cleared. Invisible at `LOG_LEVEL=info` — service-token failures log at `error`/`warn`.

## Compose Intent URL

Canonical: `https://mention.earth/compose?text=...&url=...&hashtags=...`. Full reference: `packages/frontend/docs/INTENT_URL.md`. Parser: `packages/frontend/utils/composeIntent.ts`. OS share sheet: Web Share Target (PWA manifest) + native `expo-share-intent` (needs `expo prebuild` after install, entry point `lib/shareIntent.native.ts` / `lib/shareIntent.ts`). Quote flow: `hooks/useQuoteManager.ts` + `components/Compose/QuoteCard.tsx`; wire format is `quoted_post_id`, top-level snake_case (not nested under `content`).

## MCP (Claude / remote connector)

Production `https://mcp.mention.earth`, a SEPARATE ECS service and workflow from the main backend. Full doc: `packages/mcp/README.md`.

- `resource` and JWT `aud` must equal `https://mcp.mention.earth` exactly. Claude requires 401 + `WWW-Authenticate` on unauthenticated `GET /`.
- Multi-account goes through server-side bundles and the `link-account` flow — **do not add a second MCP URL per account, and do not add `as_user` to `create-post`.**
- Media upload goes through `POST /posts/intent-media`, never Oxy `assetUpload` directly.
- `MENTION_MCP_JWT_SECRET` must match in both SSM namespaces (`/oxy/mention/` and `/oxy/mention-mcp/`).

## Moderation (CrowdSource)

CrowdSource owns cases and decisions; Oxy Trust owns reputation; Mention owns only its own enforcement. Code: `services/moderation/`, three models, `routes/crowdSourceWebhook.routes.ts`. Design rationale and the full enforcement-mode map: `docs/moderation-crowdsource.md`.

- **A 201 from `POST /reports` means stored, never accepted by CrowdSource.** The report and its outbox row commit in ONE transaction; `enqueueModerationOutboxEvent` throws unless handed a real transaction handle (`requireTransaction()`), never just a session.
- **The webhook route MUST stay mounted before `express.json()`** (guarded by a test in `appFactory.test.ts`) — the signature covers the raw bytes.
- **Enforcement is idempotent on `decisionId + revision + action`**, claimed before acting and released if the effect throws. `revision` is in the key so an appeal's `restore` can supersede a removal.
- **`no_violation` always plans a `restore`** whatever it recommended — do not "simplify" that away. The recommendation→action map lives in `services/moderation/enforcementPlan.ts` (pure, table-tested).
- **A reported type with no subject provider is stored locally, NOT refused, and gets NO outbox row.** Never re-queue a `received` report — the sweep's `$in` is `['queued','delivery_failed']`.
- **Nothing the envelope builder composes may vary between two deliveries of one report** — ingress fingerprints it, so an invented timestamp or unsorted list turns a retry into a permanent 409.
- **There is no `CROWDSOURCE_APP_ID` and never add one** (`applicationId` is read off the credential). `CROWDSOURCE_ENABLED=true` requires both the service key and the webhook secret. The dispatcher gates the LOOP, never the durable record.
- **Known gap:** media evidence is declared, not attached, and a restricted post has no author-facing surface — build one before enabling `automatic`.

## Theming

Default color preset: `blue`. `BloomThemeProvider` is the single source of truth for mode + color preset — do NOT add a local theme store. `SettingsList` (`@oxyhq/bloom/settings-list`) only, no local `SettingsItem` wrappers. `BloomColorScope` owns scoped theming variables; no app-local scope helpers.

## Deploy

Port `3000` · `api.mention.earth` (DNS-only → ALB) + apex `mention.earth` (CF-proxied → same ALB) · MCP `mcp.mention.earth` → ECS `mention-mcp` port `3100`. ECR `oxy/mention` + `oxy/mention-mcp`. `git push origin main` → `deploy-aws.yml` + `deploy-mcp-aws.yml` (path-filtered). GitHub OIDC role `oxy-github-deploy`; secrets sync to SSM `/oxy/mention/*` and `/oxy/mention-mcp/*`. `/health/ready` reports `postgres` · `migrations` · `redis` — there is no `mongo` entry.
