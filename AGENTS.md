# Mention

> **For anything about how this works, read `docs/index.mdx`.** This file holds ONLY Mention-specific RULES, commands and pointers — architecture and how-it-works narrative live in `docs/`; status and history live in git. Org-wide standards are at <https://github.com/OxyHQ/engineering/blob/main/AGENTS.md>; the parent files (`~/AGENTS.md`, `~/Oxy/AGENTS.md`) hold the agent team, the shared-SDK rules and the Bloom/Expo/expo-router gotchas. Do not repeat any of them here.
>
> **Budget: under 12 KB**, enforced by `scripts/check-agents-md-size.mjs` (`bun run validate:agents-md`). It is prepended to EVERY agent session, so its bytes are paid on every task forever, and it grows by accretion — one reasonable paragraph at a time, invisible per-commit. An addition that pushes it over is paid for in the SAME edit.

Docs, each owning the rules this file used to restate: `docs/architecture.mdx` (workspace, runtime, lifecycle, MTN signed records, the Android release build) · `docs/fediverse.mdx` + `docs/federation-behaviors.md` (the protocol surface, the connector contract, every federation and media rule) · `docs/channels-and-lanes.md` · `docs/feed-ranking.md` · `docs/moderation-crowdsource.md` · `docs/dependencies-and-ci.md` (bumping an Oxy SDK package, lockfiles, CodeQL) · `docs/frontend-compiler-notes.md` · `docs/api.mdx` · `docs/AWS_DEPLOYMENT.md` · `docs/MONGO-TO-POSTGRES-CUTOVER.md` · `packages/mcp/README.md` · `packages/frontend/docs/INTENT_URL.md` · `packages/frontend/docs/TESTING-POLICY.md`.

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
- **`bun install` refuses to RESOLVE a dependency published in the last week**, `bun run test` computes NO coverage, and a Bun built-in is not a drop-in replacement for a dependency here — all three in `docs/dependencies-and-ci.md`.
- **The backend and MCP run on Bun, not Node**, typed `["node","bun"]`; `@types/bun` is catalogued at the exact `packageManager` version and doctor fails on drift. The frontend stays Node-typed.

## This checkout: worktrees and stub servers

- **Never `git stash` here.** ~70 linked worktrees share one repository stash stack, a committed worktree stashes nothing (exit 0, no entry), and `pop` then takes another session's work into your tree. Compare against another commit with a separate detached worktree or `git show <commit>:<path>`. If it happened: a CONFLICTED pop does not drop the entry — restore your files, then VERIFY the entry survived.
- **A stub server must bind a RANDOM high port** — never `4110`, which every frontend dev server here targets — and its teardown must be VERIFIED (`pgrep -f`, `ss -ltnp`), never trusted to `pkill`'s exit status.

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

## Post lifecycle

- **A cascade delete filter naming a field the schema lacks is a silent no-op that reports success.** `deletePost` passes the deleted post DOCUMENT to `cascadeDeletedPost` (`services/PostDeletionCascade.ts`), scored against `POST_REFERENCE_PROBE_NAMES` (`scripts/lib/adminDeletionPreflight.ts`) — every known post reference with a disposition (`cascade`/`cancel-pending`/`retain`). A new field naming a post needs a probe added there. Six direct-FK children are left to `ON DELETE CASCADE` on purpose (re-implementing them would be permanently untestable); `EngagementOutbox`/`FederationDeliveryQueue` are `cancel-pending` (unindexed, so an unscoped delete would scan); a `Report` stays `retain`ed (a resolving CrowdSource decision must not strand).
- **`authorship[]` is REQUIRED on every post**; there is no read-time legacy fallback. A post with a pending collaborator invite does NOT federate until the last invite resolves (`maybeFederateOnResolve`). Invites are published-only — a scheduled post defers invites/MTN/notifications/federation until it goes live. Threads reject `collaboratorIds` with 400.

## Post and identity rules

- **Post DTOs MUST come from `PostHydrationService`** (`services/PostHydrationService.ts`). Controllers never hand-build post `user`, notification embedded posts, or feed shapes.
- **`post.user` / `authors[]` / `boost.actor` are the canonical Oxy `User` shape**, passed through unchanged. No `avatarUrl`, no flat `displayName`/`handle`, no Mention-local adapter. Every renderer derives the handle via `getNormalizedUserHandle`.
- Degraded author (Oxy resolve miss) = empty `username` + `'Unknown user'`; a degraded FEDERATED author is enriched from Mention's own `FederatedActor` record but never invents `displayName`, and is never cached.
- Valid profile URLs: `/@username` and `/@username@domain`. A duplicate suffix (`/@user@domain@domain`) is a handle-normalization bug.

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

## Theming

Default color preset: `blue`. `BloomThemeProvider` is the single source of truth for mode + color preset — do NOT add a local theme store. `SettingsList` (`@oxyhq/bloom/settings-list`) only, no local `SettingsItem` wrappers. `BloomColorScope` owns scoped theming variables; no app-local scope helpers.

## Deploy

Port `3000` · `api.mention.earth` (DNS-only → ALB) + apex `mention.earth` (CF-proxied → same ALB) · MCP `mcp.mention.earth` → ECS `mention-mcp` port `3100`. ECR `oxy/mention` + `oxy/mention-mcp`. `git push origin main` → `deploy-aws.yml` + `deploy-mcp-aws.yml` (path-filtered). GitHub OIDC role `oxy-github-deploy`; secrets sync to SSM `/oxy/mention/*` and `/oxy/mention-mcp/*`. `/health/ready` reports `postgres` · `migrations` · `redis` — there is no `mongo` entry.
