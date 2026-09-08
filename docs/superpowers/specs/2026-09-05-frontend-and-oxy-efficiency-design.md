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

### W3 — The Compose barrel, and why it cost 4.5x what W2 did

`components/Compose/index.ts` re-exports eight sheets beside its ordinary
components. `compose.tsx` wanted seven components, none of them a sheet, and
`ComposeThreadItem.tsx` wanted four from inside that same directory — so both
pulled all eight sheets in eagerly while `compose.tsx` declared seven of them as
`lazy()` seventy lines below. Those were the barrel's only two consumers; both
now import by path.

| | Before | After |
|---|---|---|
| Initial JS gzip | 1.93 MiB | **1.91 MiB** (−20.17 KiB) |
| Initial JS raw | 7.88 MiB | 7.81 MiB |
| `async:compose` | 71.66 KiB gzip | 69.93 KiB gzip |

Four and a half times W2's 4.41 KiB for a change of the same kind, and the reason
generalises: a barrel import moves whole modules, so it defeats a `lazy()`
boundary far more thoroughly than a single named import does. Together the two
leave 9.41 KiB to the long-term target.

### W4 — Three fan-outs off the `POST /posts` request path

`createMentionNotifications` looped with an `await` inside (eight sequential
round trips at the cap); `createBatchNotifications` was an unbounded
`Promise.all` over a subscriber query with no LIMIT, which also abandoned the
remaining recipients on the first rejection. Both now use `mapWithConcurrency`,
the pool this repo already had. The socket broadcast — a full `hydratePosts`
including the Oxy author batch and its 1500 ms deadline — is detached, since its
result never reaches the response.

**Completed in #900: the notification fan-out itself is now off the request.**
Bounding the pools left the author still waiting for work addressed entirely to
other people, and that wait scaled with their own popularity — the
`post_subscriptions` select has no LIMIT, and each recipient costs an INSERT, a
conditional UPDATE and a push-token SELECT, plus an FCM multicast in production.
Measured on a seeded database, medians of five rounds, push stubbed and Oxy
stubbed at a fixed round trip:

| subscribers | 0 | 10 | 50 | 200 |
|---|---|---|---|---|
| before (Oxy 0 ms) | 25.7 | 23.5 | 39.7 | **112.1** ms |
| after (Oxy 0 ms) | 20.3 | 20.5 | 34.1 | **51.4** |
| before (Oxy 60 ms) | 32.5 | 147.6 | 464.1 | **1617.7** |
| after (Oxy 60 ms) | 36.5 | 19.4 | 16.7 | **18.8** |

Two things worth carrying forward from doing it. The fan-out resolves the same
`actorId` once per recipient, which reads like a textbook N+1 and is not one:
`getUserById` caches for five minutes by default in the SDK, so those are one
HTTP request in production. That framing was checked and dropped rather than
shipped. And the work is not cheaper, it is relocated — the 0 ms / 200 row reads
51 ms rather than 20 because the detached fan-out competes for the same
connection pool as the next write.

It goes through `runtime/backgroundWork.ts` rather than a bare `void`, so the
shutdown drain still waits for it in the phase where Postgres and Redis are open;
this is that primitive's second consumer. `postCreationFanOutDetached.test.ts`
gates it as a race — "detached" is a claim about order, not output, so the same
rows are written either way — with both controls verified red: restoring the
`await` loses the race, and deleting the fan-out outright (which would also win
it) fails the drain-registration assertion instead.

### W5 — `GET /nodeinfo/2.0` had no cache, and said it did

`runtimeApp.ts` justified an exact `count(*)` over `posts` as "read at most once
per request from a cached surface". No such surface existed, on a public,
unauthenticated endpoint advertised through `/.well-known/nodeinfo` — so every
crawler ran a sequential scan of the only table that monotonically grows.

Now behind the shared cache primitive at 300s. `nodeinfoPostCountBudget.test.ts`
pins scans of `posts` across twelve concurrent callers; positive control reports
`expected 12 to be 1`. Asserted on CONCURRENT callers deliberately: the test
setup mocks Redis with `isReady: false`, so single-flight is the half this
environment can honestly measure — and it is the half a crawl storm needs.

### W6 — The compiler opt-out on the two web feeds is now declared

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
contract — a `viewerScopedClient` assertion from the caller.

Not done blind because it is a permissions path and Oxy is mocked throughout this
suite: no test here would distinguish the service's graph from the viewer's.

### And "thread `viewerGraph` on the non-feed surfaces" is not the other half

The obvious companion — have post detail, notifications and search pre-resolve
the graph and thread it, as the feed does — was checked and **does not apply**.
Threading only removes a call when something ELSE in the same request already
resolved the graph. In the feed that is `loadViewerFeedContext`. On these
surfaces there is exactly **one** `hydratePosts` per handler
(`readPosts.ts` has five call sites, but they are five different handlers; so are
notifications' two and search's one), so hydration's live fetch is the only one
in the request. Threading would relocate the same work, not remove it.

The genuine duplicate is narrower and elsewhere: `loadFollowedAuthorIds`
(`services/viewerFollowGraph.ts:70`) issues `getUserFollowing(userId)` a SECOND
time in the same request, on both `routes/search.ts:486` and
`routes/notifications.ts:325`, to evaluate an `exclude-following` muted word —
after `buildViewerContext` already fetched exactly that list during hydration. It
is gated on `compiledMuteWords?.needsFollowState`, so it costs a third graph call
only for viewers who have such a rule.

Two ways to close it, and the second is the better one:

1. Resolve `followedAuthorIds` BEFORE hydrating and thread it as
   `viewerGraph.followingIds` (its union is the same one the feed context
   assembles, so the semantics match), fetching followers explicitly alongside.
   3 → 2 calls, but it moves graph plumbing into callers that do not otherwise
   have any.
2. **Request-scoped memoization of the Oxy graph reads.** There is no
   DataLoader-shaped facility in this backend, yet `oxyMetrics.ts` already
   establishes a per-request `AsyncLocalStorage` context that one could hang off.
   It would deduplicate this case and every future one without a single caller
   changing. The care it needs is a write-path question: a memo must not serve a
   stale graph to a request that just mutated it, so the scope belongs on read
   paths, deliberately, rather than on the client wholesale.

### What #896 settled about the threading mechanism

Landed independently after this spec was written, and it is worth recording here
because it answers a question this section left open. `FeedContext.viewerPrivacy`
threads the viewer's blocked and restricted lists through all five of the
engine's hydration sites, exactly as `viewerGraph` threads the follow graph —
`buildViewerContext` had been re-fetching them on every hydration, measured at 3x
`getBlockedUsers` and 2x `getRestrictedUsers` per authenticated For You page.

So the mechanism generalises, and the argument above about the non-feed surfaces
is unaffected by that: threading still only removes a call where something else
in the same request already resolved the value, which on the feed is
`loadViewerFeedContext` and on post detail, notifications and search is nothing.
What #896 did NOT do is make `getViewerGraph` usable in `buildViewerContext` —
both constraints above (no followers; viewer-scoped clients only) still hold.

## Remaining workstreams

- **W7 — Retained metrics.** `/internal/metrics` IS enabled in production
  (`deploy-ecs-image.sh:625-629` injects `INTERNAL_METRICS_ENABLED=true` when the
  token secret resolves; the `false` in `config/index.ts:424` is only the local
  default). Nothing scrapes it, so no p95 survives the process. CloudWatch EMF
  from the existing ECS tasks is the lowest-new-infrastructure option. Numbers
  go into `PERFORMANCE_BUDGETS.md` only after they are read off a deployment.
- **W8 — The two GLOBAL `io.emit('feed:updated')` per public post.** W4 detached
  the broadcast and the notification fan-out, but the emit itself still
  reaches EVERY connected socket in the fleet, twice, and the client filters
  locally (`socketService.ts:487`). `postEngagementBroadcast.ts:129` shows the
  room-scoped form, and `socketHandlers.ts` already runs `user:`, `post:` and
  `presence:` rooms — but there is no room keyed on the author, and creating one
  means resolving each connection's follow graph at connect time, which is a new
  Oxy cost paid per socket rather than per post. That trade is the workstream:
  it is a protocol change across both runtimes, not a server-side tidy-up.
- **W9 — Discovery indexes. HALF DONE (#899); the text search half is still
  open.** The `popular`/discovery composite is indexed: `posts_engagement_rank_idx`
  (`db/schema/posts.ts:913`) is a partial expression index on
  `engagementRankSql`, generated by ONE function so the index declaration and the
  query builder cannot spell the composite differently — which was exactly the
  silent-coupling risk this entry flagged, and it is now pinned by
  `engagementRankIndex.test.ts` rather than argued. Both concerns raised here were
  borne out in the doing: the weights ARE embedded as literals and a retuned
  `likeWeight` reds the test, and the plan assertion had to be written as "the
  ORDER BY is satisfiable by this index" rather than "the planner chose it",
  because on a near-empty CI database the planner correctly prefers a seq scan and
  the assertion would otherwise have measured row count.

  Still open, and verified still open against current `main`:
  - **`exploreFinalScoreSql`** (`mtn/feed/engine/sources/discoverySources.ts:265`)
    is a DIFFERENT expression from the one #899 indexed — it folds a relevance
    term in — so `explore` is still seq scan + sort. Whether it can take the same
    treatment is an open question, not a given: its relevance argument is built
    per request, and an expression index can only cover the parts that are not.
  - **No `pg_trgm` anywhere** (grepped: zero hits in `src/` and `drizzle/`), so
    every `ILIKE '%…%'` is a full scan. The worst remains
    `controllers/posts/bookmarks.ts:165`, inside an `EXISTS` over all of
    `post_content_variants`.

  The measurement caveat still stands for both: an `EXPLAIN` on a near-empty
  database proves nothing, so a representative row count comes before any number
  is claimed. #899 used 275,000 posts.
- **W10 — Split `compose.tsx`.** The frontend's `posts.controller.ts`. Same
  contract as W2 of the previous programme: move, do not rewrite; nothing over
  ~600 lines; unchanged export surface; an unchanged test COUNT is the point.
- **W11 — The three post caches.** `postsStore` + `db/`, React Query, and
  `feedScrollStore`, reconciled by five invalidation buses
  (`engagement`, `lane`, `safety`, `byline`, `identityUpdates`).
  `useFeedState` (1,160 lines) hand-rolls retry-with-jitter, two
  `AbortController`s, a pagination epoch and warm-start;
  `feedService` adds a second dedup map on top. Highest structural return,
  highest risk, and it touches the most-used screen — its own programme.
- **W12 — `statement_timeout`.** Already declared a handoff in
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
