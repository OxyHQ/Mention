# Efficiency and structure, round two — Oxy egress and the frontend

**Date:** 2026-09-05
**Base:** `origin/main` @ `fae1d0b`
**Status:** partially executed; the rest specified below

## Why

`2026-08-30-backend-efficiency-design.md` measured the backend, and its most
useful result was a refutation: `PostHydrationService` was already batched, so
the biggest file was not the expensive one. It ended by naming where the cost
plausibly is instead — **network, not Postgres** — and left that unmeasured.

Two things follow, and this document is about both.

1. Postgres has a statement budget with a positive control
   (`postHydrationStatementBudget.test.ts`). Oxy had **no call budget at all**,
   so nothing in this repository could fail when an Oxy round trip was added.
2. The frontend has never had a counterpart programme. It is 109 kLOC with one
   4,042-line screen, three parallel post caches, and a 1,160-line hook that
   reimplements `useInfiniteQuery`.

## Measured baseline

Taken on this checkout, not inherited.

| Signal | Measurement |
|---|---|
| Backend source | 138,830 non-test lines / 141,869 test lines (532 files) |
| Frontend source | 109,347 non-test lines / 36,420 test lines (183 files) |
| Largest frontend file | `app/(app)/compose.tsx` **4,042** lines, 101 imports, 37 `useState`, 24 manager hooks |
| Initial web JS | 7.88 MiB raw, **1.93 MiB gzip** (ceiling 2.35, target 1.90) |
| Fonts | 1.91 MiB, of which `MaterialCommunityIcons.ttf` is **1.25 MiB** |
| Native bundle | 18,072,060 B, no route splitting (`asyncRoutes` is web-only) |
| Backend suite | 522 files / 6,300 tests |
| Frontend suite | 183 files / 1,708 tests |

Two hypotheses were **disproved** before any work was done on them, and are
recorded so they are not re-opened:

- *"The fourteen locale catalogues bloat the initial bundle."* They do not. Only
  `en.json` is static; the rest are per-locale `import()`s (`lib/i18n.ts:31-46`).
  They count against total JavaScript, never against first paint.
- *"The SQLite layer ships to browsers that cannot use it."* `expo-sqlite` is
  already excluded by a type-only import with a docstring saying why
  (`db/database.web.ts:1-12`). What does ship is ~1,700 lines of SQL string
  builders — real, but a rounding error next to what "the whole db layer" implies.

A third figure was **overstated by more than an order of magnitude** and the
correction is the point: the initial-gzip gap is ~30 KiB against the target, not
~470 KiB. That larger number comes from reading the gap off the CEILING instead
of off the build. `docs/PERFORMANCE_BUDGETS.md` now carries the measured table.

## Executed

### W1 — An Oxy call budget, and the defect it immediately found

`FeedEngine` threads `viewerGraphOption(ctx)` into hydration at four of five call
sites. `runPopularFallback` was the fifth and did not, while still passing
`viewerId` — so `buildViewerContext` took its live-fetch branch and paid
`getUserFollowing` + `getUserFollowers` per page on the authenticated never-blank
path, which is ordinary deep scroll rather than an edge case.

| Path | Before | After |
|---|---|---|
| Never-blank fallback page | **2** Oxy graph calls | **0** |

`__tests__/mtn/feedEngineViewerGraphBudget.test.ts` pins it. Positive control:
reverting the one-line fix reports `expected 2 to be +0`, while the ranked-path
and partial-context cases stay green — so the gate is specific to this path.

A spy on the threaded client, not the metrics registry, and the reason is worth
recording because it does not generalise: `oxy_calls_total` is recorded from a
patch on `HttpService`'s PROTOTYPE, reached through a real HTTP request. Under a
mocked Oxy client it records nothing, so a budget read from it would pass at zero
no matter what the engine did. The spy is sound here only because
`buildViewerContext` reaches Oxy for the graph through exactly one object, which
the test owns.

### W2 — Five `lazy()` boundaries that a static import defeated

`PostItem.tsx:61` declared `lazy(() => import('…/PostInsightsSheet'))` while
`PostItem.tsx:39` imported `usePostActions`, which named that sheet and four more
as plain imports. All five are now lazy with `<Suspense>` at each render site.

Measured across two full web exports: **4.41 KiB gzip** off initial JavaScript
(target distance 33.99 → 29.58 KiB). Deliberately recorded as a small number:
Metro places any module two chunks reach into `__common`, so these sheets were
already shared and removing one eager reference moves far less than their 1,190
lines suggest. The change is worth keeping for the boundary, not the bytes.

### W3 — The compiler opt-out on the two web feeds is now declared

`Feed.web.tsx` and `NotificationsList.web.tsx` were outside the React Compiler
only because each happens to read a ref during render.
`docs/frontend-compiler-notes.md` records the failure mode: a memoized
window-virtualized list serves its first window forever, in production only.
`ProfileGridList.web.tsx` shipped exactly that. Both now carry `'use no memo'`;
the ref reads are untouched, since removing them is what reintroduces the bug.

## Not executed, and why — `getViewerGraph` on the non-feed surfaces

`utils/privacyHelpers.ts:26-35` documents `GET /users/me/graph` as strictly
better than `getUserFollowing`: ids-only, server-bounded, one payload for
following + mutuals + blocked. It has exactly one caller
(`engagementLists.ts:176`). The obvious move is to use it in
`buildViewerContext`, whose live-fetch branch serves 38 hydration call sites.

Two constraints, found on attempting it, narrow this from a drop-in to its own
workstream:

1. **It returns no followers.** `buildViewerContext` needs `followedBy`, and that
   set feeds `computeReplyPermission` (`PostHydrationService.ts:3031`): the
   `'following'` permission means *only people the author follows may reply*.
   Mutuals are a proper subset of followers, so substituting them would DENY
   replies to someone the author follows who does not follow back — a permission
   regression wearing an optimisation's clothes. `getUserFollowers` stays.
2. **It is only correct on a viewer-scoped client.** The viewer comes from the
   client's credential, not from the `viewerId` argument.
   `buildViewerContext` falls back to `client || getRuntimeOxyClient()`, and the
   runtime client is not scoped — there it would return the SERVICE's graph. Post
   detail (`readPosts.ts:39,75,129,194,249`) and notifications
   (`notifications.ts:301`) do pass `createScopedOxyClient(req)`, so they would be
   correct; the function cannot tell from inside.

Real scope: it folds `getUserFollowing` + `getBlockedUsers` into one call (2 → 1,
and the one removed is the unbounded full-DTO route), and needs an explicit
contract — either a `viewerScopedClient` assertion from the caller, or resolving
the graph in the caller and threading `viewerGraph` as the feed already does.
The latter needs no new Oxy semantics and should go first.

Not done blind because it is a permissions path and Oxy is mocked throughout this
suite: no test here would distinguish the service's graph from the viewer's.

## Remaining workstreams

- **W4 — Retained metrics.** `/internal/metrics` IS enabled in production
  (`deploy-ecs-image.sh:625-629` injects `INTERNAL_METRICS_ENABLED=true` when the
  token secret resolves; the `false` in `config/index.ts:424` is only the local
  default). Nothing scrapes it, so no p95 survives the process. CloudWatch EMF
  from the existing ECS tasks is the lowest-new-infrastructure option. Numbers
  go into `PERFORMANCE_BUDGETS.md` only after they are read off a deployment.
- **W5 — `POST /posts` side effects.** `runPostSideEffects` awaits, inline:
  `createBatchNotifications`, which is `map(createNotification)` — one INSERT, a
  conditional UPDATE, an Oxy `getUserById` and a push PER recipient, over an
  unbounded subscriber query; `createMentionNotifications`, a serial `for` with
  an `await` inside; a full extra hydration to build the socket DTO; and two
  GLOBAL `io.emit('feed:updated')` broadcasts per public post.
  `postEngagementBroadcast.ts:129` already shows the room-scoped form.
- **W6 — Discovery indexes.** `engagementScoreSql()` and `exploreFinalScoreSql`
  are computed expressions in `ORDER BY` with no expression index, so `popular`,
  `explore` and `trending` are seq scan + sort — the anonymous For You path. No
  `pg_trgm` anywhere, so every `ILIKE '%…%'` is a full scan; the worst is
  `bookmarks.ts:165`, inside an `EXISTS` over all of `post_content_variants`.
  `GET /nodeinfo/2.0` runs `count(*)` on `posts` per request, unauthenticated.
- **W7 — Split `compose.tsx`.** The frontend's `posts.controller.ts`. Same
  contract as W2 of the previous programme: move, do not rewrite; nothing over
  ~600 lines; unchanged export surface; an unchanged test COUNT is the point.
- **W8 — The three post caches.** `postsStore` + `db/`, React Query, and
  `feedScrollStore`, reconciled by five invalidation buses
  (`engagement`, `lane`, `safety`, `byline`, `identityUpdates`).
  `useFeedState` (1,160 lines) hand-rolls retry-with-jitter, two
  `AbortController`s, a pagination epoch and warm-start;
  `feedService` adds a second dedup map on top. Highest structural return,
  highest risk, and it touches the most-used screen — its own programme.
- **W9 — `statement_timeout`.** Already declared a handoff in
  `discoverySources.ts:33-53`. Infra (`oxy-infra`), not a Mention code change.

## Verification contract

```bash
docker compose -f docker-compose.postgres.yml up -d postgres
cd packages/backend
bun run lint
TEST_DATABASE_URL='postgres://mention:mention@127.0.0.1:5433/mention_dev' bun run test

cd ../frontend
bun run typecheck && bun run test
bun run build && node scripts/analyze-bundle.js --ci
```

Anything touching a virtualized web list additionally requires a PRODUCTION
export and compiling the file with the app's own `babel-plugin-react-compiler`,
reading the CompileError/CompileSuccess events — never the dev server, and never
a grep of the output.
