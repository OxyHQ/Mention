# Mention

> Universal standards, the agent team, SDK/Bloom/Expo/expo-router gotchas and the infra pointer live in `~/AGENTS.md` and `~/Oxy/AGENTS.md`. **Architecture and how-it-works belong in `docs/`; history belongs in git.** This file holds only Mention-specific RULES, commands and pointers. **Budget: under 12 KB.**

Docs: `docs/architecture.mdx`, `docs/fediverse.mdx`, `docs/api.mdx`, `docs/AWS_DEPLOYMENT.md`, `docs/MONGO-TO-POSTGRES-CUTOVER.md`, `packages/mcp/README.md`, `packages/frontend/docs/INTENT_URL.md`.

## Layout

`packages/frontend` (Expo, expo-router, NativeWind, TanStack Query, Zustand, Socket.io, LiveKit) · `packages/backend` (Express 5, Mongoose, Redis, Socket.io, Bun runtime) · `packages/shared-types` · `packages/mcp`. Bun workspaces.

## Commands

```bash
bun run dev / dev:frontend / dev:backend / dev:mcp / dev:mcp:http
bun run build            # shared-types + backend + mcp
bun run test / lint / check / clean
```

- **Run backend tests from the package root** (`cd packages/backend && bun run test`) — from the repo root they pick up stale `.dist` copies and report false failures.
- **Rebuild `shared-types` before believing a red typecheck or build.** It is consumed through its BUILT `dist`, so after any rebase every other package compiles against the previous build and reports newly-landed symbols as missing (`TS2305`) in files you never touched.
- **A `doctor` failure SIGINTs the rest of `check:workspace`** — the killed siblings are not broken and which ones die varies per run. Re-run the survivors individually before believing any of them failed.
- **The backend and MCP run on Bun, not Node**, and are typed `["node","bun"]`; `@types/bun` is catalogued at the exact `packageManager` version and doctor fails on drift. The frontend stays Node-typed.
- **`bun install` refuses to RESOLVE a dependency published in the last week** (`minimumReleaseAge`). It never affects `--frozen-lockfile`. Any step that RE-RESOLVES must pass `--minimum-release-age=0` (`verify-lockfile.sh` does). First-party packages are excluded by EXACT name — a scope glob parses and matches nothing, so a new first-party dependency must be added to `minimumReleaseAgeExcludes`. A warm manifest cache hides this; verify against CI or a cold cache.
- **Do not try to replace a dependency with a Bun built-in here** — `Bun.YAML` loses duplicate-key detection, `Bun.redis` has no `multi`/`exec`/`watch`, `Bun.Image` is not reachable from `expo prebuild`'s Node, `bun test` replaces neither Vitest nor Jest, and the global virtual store is unreachable under `linker = "hoisted"` (which Metro requires).

## Bumping an Oxy SDK package (`bun add` reports success and changes nothing)

- **Shared versions live ONLY in `workspaces.catalog` in the root `package.json`.** A bump is one catalog edit plus `bun install`. Manifests and the root `overrides` name the package as `"catalog:"`.
- **`bun add`/`bun update` are the wrong tools** — an override beats a workspace range, so they print success and leave the old version in `node_modules` and `bun.lock`. Doctor rejects a manifest or override re-pinning a catalogued package to a literal range, and rejects `@oxyhq/bloom` in the root `dependencies`.
- **After bumping, check no NESTED copy of the old version survived** — an incremental install preserves a recorded edge by nesting it, and every gate stays green while a dependent loads the old major. `grep -oE '"[^"]*<pkg>": \["<pkg>@[0-9.]+' bun.lock | sort -u` must print exactly one line; delete the stale nested keys and reinstall rather than regenerating the lockfile.
- **Assert the installed version after any bump** (`node -e "…/package.json').version"`) before running any gate.
- **Do NOT regenerate `bun.lock` from scratch.** The correct delta is the workspace range, the `overrides` entry and the resolution record; `.github/scripts/verify-lockfile.sh origin/main` prints exactly that, and compares the COMMITTED lockfile.
- `validate:lockfile` check 4 is the only gate that catches a catalogued bump landing a major its dependents reject; deliberate cases live in `ACCEPTED_OVERRIDE_RANGE_VIOLATIONS`.

## This checkout: worktrees and stub servers

- **Never `git stash` here.** ~70 linked worktrees share one repository stash stack, a committed worktree stashes nothing (exit 0, no entry), and `pop` then takes another session's work into your tree. Compare against another commit with a separate detached worktree or `git show <commit>:<path>`. If it happened: a CONFLICTED pop does not drop the entry — restore your files, then VERIFY the entry survived.
- **A stub server must bind a RANDOM high port** — never `4110`, which every frontend dev server here targets — and its teardown must be VERIFIED (`pgrep -f`, `ss -ltnp`), never trusted to `pkill`'s exit status.

## CodeQL

A finding on your PR reports what the DIFF introduces, not what the repo accepts — **count the same rule on `main` first** (`gh api --paginate .../code-scanning/alerts`). The convention is a route-level limiter for feeds, expensive aggregations and spam-surface writes; plain CRUD rides the app-wide `createOxyRateLimit`, which the query cannot see.

- **`router.use(...limiters)` with an empty array throws at import.** The `isProduction ? [x] : []` idiom is only safe in the PER-ROUTE position — which is also the only position CodeQL inspects.
- **`rateLimitPrefixUniqueness.test.ts` resolves prefixes by reading SOURCE**, so write each `RedisStore` prefix as a literal, never through a factory.

## Indexes and migrations (Mongo)

`autoIndex`/`autoCreate` are OFF in production, so declaring an index on a schema does not create it.

- **`POST_HOT_PATH_INDEXES` is migration `0010`'s payload, not a generic manifest** — appending there is a no-op in production. A new index ships as its OWN migration, registered in `migrations/constants.ts` AND the `MIGRATIONS` array in `runner.ts`.
- **Never edit an already-written migration to add an index.**
- **`sparse: true` is wrong on a COMPOUND index here** — Mongo indexes a document if any key exists. Use `partialFilterExpression` and make every query carry a literal term on the filtered field. Verify with `explain()` on a real `mongod`; the suite is fully mocked.
- Postgres migration contract: `packages/backend/src/db/MIGRATION-CONTRACT.md` + `db/schema/CONVENTIONS.md`. Production's `mention` role OWNS the `mention` database, so a probe database created by another role misreports permissions.

## Local Android release APK

```bash
cd packages/frontend/android
NODE_ENV=production ./gradlew :app:assembleRelease -x lintVitalRelease \
  -PreactNativeArchitectures=arm64-v8a -Dorg.gradle.jvmargs="-Xmx8g -XX:MaxMetaspaceSize=1g"
```

- **`NODE_ENV=production` is REQUIRED** or `export:embed` aborts and the APK ships with NO embedded bundle (verify: `unzip -l app-release.apk | grep index.android.bundle`).
- Build arm64-only; the multi-ABI build fails at the x86 CMake task.
- **Metro dev builds must run from `packages/frontend`**, not the repo root — from the root Expo resolves the legacy `expo/AppEntry` and returns HTTP 500.

## Federation rules

- **Never redirect the apex ActivityPub ENDPOINT paths** (`/ap/*`, webfinger, host-meta, nodeinfo) — a 301/302 silently kills ALL inbound federation while GETs keep working. Signatures are verified against `X-Forwarded-Host`, so mount the federation routers BEFORE `apexFrontendProxy`. The profile-URL 302 (`/@user` with an AP `Accept`) is a GET-only content negotiation and is fine.
- **Do NOT reintroduce a Cloudflare Worker on the apex** — `mention.earth` is CF-proxied to the ALB and served entirely by the backend.
- Actor `publicKey.id` host MUST equal the actor `id` host; `icon.url` must be absolute and reachable; `/.well-known/host-meta` must be mounted before auth.
- **Outbound fan-out must resolve the author's username SERVER-SIDE from `oxyUserId`** (`resolveFederationUsername`), never from `req.user.username` — the auth middleware runs without `loadUser`, so gating on it federates ZERO posts while everything looks healthy.
- **Pass the post DOCUMENT to `post.create`/`post.update`, never a hand-picked literal** — `LocalPostEventPayload` names fewer fields than the Note builder reads, so a literal silently drops `sensitive` and quote fields. Gate: `__tests__/connectors/outboundPostPayloadShape.test.ts`.
- **Outbox sync uses the actor's advertised `outbox` URL**; `actorUri + '/outbox'` is fallback only.
- **A bare boost must never federate as an empty `Create(Note)`.**
- **Structure comes from structured fields, never from the body.** A quote arrives in a quote field or an FEP-e232 tag; a `RE: <url>` body alone yields no quote. Bridge-flattened retweets are DROPPED at ingest — do not reconstruct an author by parsing the prefix.
- **Bridge identity comes from the actor's `type`** (`Service` = mirror, `Person` = operator), never from its bio, and `Application` is refused (it is the server's own actor).
- **A thread federates through `PostCreationService.federatePublishedPost`** — the one implementation both the immediate and scheduled paths call. A chain STOPS at the first entry that does not go out, consent included.
- **Bridge relabelling policy is `connectors/activitypub/federationBridgePolicy.ts`; the blocklist is `federationBlockPolicy.ts`** — enforcement and the public transparency page read the SAME array. oxy-api keeps a SEPARATE trust list and the two are deliberately NOT consolidated.
- **Fediverse sharing consent:** Oxy owns the flag; Mention never stores it. `services/fediverseSharing.ts` is the ONLY read path and all SDK reads use `{cache:false}`. Undo handlers stay UNGATED so teardown converges. Fail-open everywhere except the cleanup job's guard and the inbox POST (a 4xx makes Mastodon drop deliveries forever).
- **All federation UI lives under `settings/fediverse/`** — add a row inside the hub, never beside it.
- **One-shot scripts in `src/scripts/` MUST `mongoose.disconnect()` and `process.exit()`** or the Fargate task runs forever.
- **Media proxy:** the SSRF guard is UPSTREAM (`assertSafePublicUrl`/`isBlockedIp` from `@oxyhq/core/server`), never a local copy. An HLS playlist is never relayed verbatim — it is rewritten so every URI returns through `/media/proxy`, and playlists are excluded from the S3 cache. **Never gate HLS on `canPlayType`** (Chromium answers `"maybe"` then fails) — probe `isTypeSupported`. `import('hls.js')` must stay a SINGLE call site.

## Post and identity rules

- **Post DTOs MUST come from `PostHydrationService`.** Controllers never hand-build post `user`, notification embedded posts or feed shapes.
- **`post.user` / `authors[]` / `boost.actor` are the canonical Oxy `User` shape**, passed through unchanged. No `avatarUrl`, no flat `displayName`/`handle`, no Mention-local adapter. Every renderer derives the handle via `getNormalizedUserHandle`.
- **Author hydration must NEVER emit a raw `oxyUserId` as a handle.** Unresolved authors get the degraded summary (empty username, `'Unknown user'`), never cached.
- **A record's `createdAt` is SELF-ASSERTED and must go through `clampFutureDate`** (1 h for MTN/atproto, 24 h for ActivityPub). REJECT and fall back to `now` — never re-date to the clamp edge.
- **`writtenByOxyUserId` is never in `authorship[]`** and never on the DTO. Disclosure is the server's decision from `UserSettings.channel.signPosts`, failing closed at three points.
- **A channel can never be acted as, and can never be replied to** — the reply gate reads the post AUTHOR's account kind at five sites and drops silently on federated ingest (a throw retries forever, a 4xx ends delivery permanently).
- **`services/publishAsAccount.ts` is the ONE gate for "may this person act for that account"**, answered from Oxy's account graph with the CALLER's own bearer, failing CLOSED. Acting as an `organization`/`project`/`bot` additionally requires `account:act_as` read off `AccountMember.permissions` — never inferred from the role.
- **`replyPermission` is forced by the author's KIND**, never by "published as an account".
- **You cannot block, report or mute an account you operate** — refused on the SERVER with 400 (not 403), failing toward ALLOWING on an unresolvable answer.
- **`assertLaneAssignable` is the single lane validator** and its `channelId` argument is what keeps a lane with its own publisher.
- **A cascade delete filter naming a field the schema lacks is a silent no-op that reports success** — and becomes a whole-collection wipe if `strictQuery` is ever enabled. Verify filter keys against the schema. New post references need a probe in `POST_REFERENCE_PROBE_NAMES`.
- **`authorship[]` is REQUIRED on every post**; there is no read-time legacy fallback.
- **A post with a pending collaborator invite does NOT federate** until the last invite resolves.

## Feed rules

- **`ChronoCursor.applyToQuery` ASSIGNS `match.$or`.** Any filter written as a disjunction is deleted the moment a cursor arrives, so page one filters and every later page leaks. Use plain conjunctive terms or `$and`; a test that pins it needs a LIVE cursor.
- **FOUR field projections feed hydration** (`mtn/feed/FeedAPI.ts`, `controllers/feed.controller.ts`, `services/ThreadSlicingService.ts`, `routes/search.ts`). A field missing from one hydrates `undefined` with no error.
- **Any surface INCLUDING boosts must pass `maxDepth: 1`** or boosts render blank.
- **Never sort an author query by `_id`** — a federated post's `_id` bears no relation to its remote `createdAt`, so it skips backfilled posts at the page boundary.
- **`hasMore` comes from the overfetch flag**, never `slices.length >= limit`.
- **Never put a non-post inside `slices[].items`** — `flattenSlicesToItems` pushes `item.post` unguarded. Interstitials are a top-level field, anchor by `_sliceKey`, and must never report impressions or go through `POST /feed/mtn/interactions`.
- **Never block the feed response on remote link-preview or image fetching.**
- **Ranking gates on `status === 'classified' OR version >= BASELINE_CLASSIFIER_VERSION`** — never honor default-zero scores. Stage B enriches with DOTTED `$set`, never a whole-subdoc overwrite.
- **Never point a text index's `language_override` at a field holding content-language codes** (Mongo error 17262).
- **Safety gating has three modules and no fourth copy of any predicate:** `mtn/feed/feedSafety.ts` (sensitive/NSFW, the single source of truth — `requiresContentWarning` is the wider gate for surfaces that cannot render a warning), `services/safety/muteWordMatcher.ts`, `services/safety/viewerSafety.ts`.
- **The frontend has TWO post-list caches** — React Query (saved screen) and the feed store (every `<Feed>` surface) — and neither can see the other. `stores/engagementInvalidation.ts` is the single authority; **do not invalidate from the hooks** (two call sites write through the store directly). There is no query key for likes/boosts lists, so `invalidateQueries` there is a no-op. Client-wide `refetchOnMount` must stay at the library default.

## Frontend rules

- **React Query keys and effect deps MUST include `isAuthenticated` / `user?.id`** — SSO restore takes 5–25 s, and keying on `oxyServices` or `[]` fetches once while anonymous and never recovers. Gate private endpoints on `useAuth().canUsePrivateApi`. Jest does not reproduce this; verify in a real foregrounded tab.
- **A virtualized web list must be opted out of the React Compiler EXPLICITLY** (`'use no memo'`) — the virtualizer's identity is stable and its re-renders are internal, so the compiler freezes `getTotalSize()`/`getVirtualItems()` forever in prod builds only. Do not reason about which shape is safe: compile the file with the app's own `babel-plugin-react-compiler` and read the CompileError/CompileSuccess events. Verify on a PROD build.
- **A render-phase ref write and a `finally` CLAUSE each make the compiler BAIL on the whole function** (lost memoization, not a stale read). Never restructure a `try`/`finally` that guarantees cleanup to unlock a cache, and check what the optimization would CONTAIN before refactoring for it.
- **`VirtualizedWebFeed` is the single scroll-owning path** for top-level feed screens; `EmbeddedWebFeed` is for genuinely nested sub-lists only. Panel insets come from `components/shell/PanelChrome.tsx`, never per-page padding.
- **Two loggers, identical signatures, opposite meanings for argument two.** `@oxyhq/core/logger` (frontend) is `error(message, error?, context?)`; the backend pino wrapper merges a non-Error second argument as context. Gate: `bun run validate:logger`.
- **ONE Bloom root** — `app/_layout.tsx` mounts `<BloomProvider>` and nothing else mounts a Bloom state provider. `BloomThemeProvider` (via `persistKey`+`storage`) is the single theme authority; no local theme store, no app-local color-scope helpers, no local `SettingsItem` wrappers. Default preset: `blue`.
- **Do NOT re-enable GET caching on any linked client** (`utils/api.ts`, the Syra client).
- **Mention keeps its own CORS middleware on purpose** — do NOT switch it to `createOxyCors`, which cannot express the dev LAN pattern and would broaden production CORS to the whole `*.oxy.so` family.

## MCP

Production `https://mcp.mention.earth`, a SEPARATE ECS service and workflow. `resource` and JWT `aud` must equal that URL exactly. Claude requires 401 + `WWW-Authenticate` on unauthenticated `GET /`. Multi-account goes through server-side bundles and the `link-account` flow — **do not add a second MCP URL per account, and do not add `as_user` to `create-post`.** Media upload goes through `POST /posts/intent-media`, never Oxy `assetUpload` directly. `MENTION_MCP_JWT_SECRET` must match in both SSM namespaces.

## Moderation (CrowdSource)

CrowdSource owns cases and decisions; Oxy Trust owns reputation; Mention owns only its own enforcement. Code: `services/moderation/`, three models, `routes/crowdSourceWebhook.routes.ts`.

- **A 201 from `POST /reports` means stored, never accepted by CrowdSource.** The report and its outbox row commit in ONE transaction; `enqueueModerationOutboxEvent` throws unless `session.inTransaction()` and is the ONLY writer of that collection. Its upsert must be `{upsert:true, session, timestamps:false}` with `createdAt`/`updatedAt` written explicitly inside `$setOnInsert` — anything else either fails the whole write or turns a retry into a real write contending with the dispatcher's lease.
- **The webhook route MUST stay mounted before `express.json()`** (guarded by a test in `appFactory.test.ts`).
- **Enforcement is idempotent on `decisionId + revision + action`**, claimed before acting and released if the effect throws. `revision` is in the key so an appeal's `restore` can supersede a removal.
- **Mention maps `recommendedActions`, not findings** (`enforcementPlan.ts`). `restrict` → `Post.status='restricted'`; `label`/`age_gate`/`reduce_distribution` → `metadata.isSensitive`; `manual_review` is recorded, never executed. **`no_violation` always plans a `restore`** whatever it recommended — do not "simplify" that away.
- **A reported type with no subject provider is stored locally, NOT refused, and gets NO outbox row.** Never re-queue a `received` report — the sweep's `$in` is `['queued','delivery_failed']`.
- **Nothing the envelope builder composes may vary between two deliveries of one report** — ingress fingerprints it, so an invented timestamp or unsorted list turns a retry into a permanent 409.
- **There is no `CROWDSOURCE_APP_ID` and never add one.** `CROWDSOURCE_ENABLED=true` requires both the service key and the webhook secret. The dispatcher gates the LOOP, never the durable record. Env: `CROWDSOURCE_{ENABLED,SERVICE_KEY,BASE_URL,WEBHOOK_SECRET,WEBHOOK_SECRET_PREVIOUS,OUTBOX_BATCH_SIZE,OUTBOX_POLL_INTERVAL_MS,ENFORCEMENT_MODE}`.
- **Known gap:** media evidence is declared, not attached, and a restricted post has no author-facing surface — build one before enabling `automatic`.

## Deploy

Port `3000` · `api.mention.earth` (DNS-only → ALB) + apex `mention.earth` (CF-proxied → same ALB) · MCP `mcp.mention.earth` → ECS `mention-mcp` port `3100`. ECR `oxy/mention` + `oxy/mention-mcp`. `git push origin main` → `deploy-aws.yml` + `deploy-mcp-aws.yml` (path-filtered). GitHub OIDC role `oxy-github-deploy`; secrets sync to SSM `/oxy/mention/*` and `/oxy/mention-mcp/*`.
