# Performance budgets

**Scope of this document, stated up front:** issue #703 asked for SLOs and
regression budgets across a long list of backend and client paths. This
document is deliberately narrower than that list. An SLO nobody measures is
worse than none — it looks like a commitment while giving the team nothing
to hold it against — so this covers exactly the paths that have a real
measurement pipeline BEHIND them today, and says plainly, for every other
path in the original ask, what instrumentation exists and what is still
missing before a numeric budget would mean anything.

## What is measured and enforced today

### Client JS/web bundle size

`packages/frontend/bundle-budgets.json` is a real, CI-enforced regression
budget — `packages/frontend/scripts/analyze-bundle.js --ci` fails the build
past any of:

| Budget | Ceiling |
| --- | --- |
| Total bytes | 18 MiB |
| JavaScript bytes | 14.5 MiB |
| Initial JavaScript bytes | 8.5 MiB |
| Initial JavaScript gzip bytes | ~2.35 MiB (target: ~1.9 MiB) |
| Font bytes | 4 MiB |
| Largest single file | 7.5 MiB |

Wired into `.github/workflows/ci.yml`'s "Enforce bundle budgets" step, which
also diffs the PR's export against `main`'s baseline. This is the one item
on the original SLO list that already has the property the rest of this
document argues for: a number, a place it is measured, and a build that
fails when the number is exceeded.

These are CEILINGS, and the distance to them is not the interesting number —
where the build actually sits is. Measured from a local `expo export --platform
web` (2026-09-05):

| Signal | Measured | Ceiling | Long-term target |
| --- | --- | --- | --- |
| Initial JavaScript bytes | 7.88 MiB | 8.5 MiB | — |
| Initial JavaScript gzip bytes | **1.93 MiB** | ~2.35 MiB | ~1.9 MiB |
| Font bytes | 1.91 MiB | 4 MiB | — |

So the initial gzip figure is ~30 KiB from its target, not ~470 KiB — reading
the gap off the ceiling instead of off the build overstates it by more than an
order of magnitude. `MaterialCommunityIcons.ttf` alone is 1.25 MiB of the 1.91
MiB font total, against 380 KiB for Ionicons, which the app imports directly in
86 files; that ratio is the one worth explaining before the font budget is
treated as comfortable.

The JavaScript-bytes ceiling was raised from 13 MiB by
`4ca5f1e feat(i18n): translate all fourteen locales` — the locale catalogues are
2.3 MB on disk but are correctly per-locale `import()`s (`lib/i18n.ts`), so they
count against the total and NOT against initial JavaScript.

### Real-browser release gate

`packages/e2e` drives the candidate web build at the production origin
before promotion — see `packages/e2e/README.md`. It is a correctness gate
(cold-boot deadlocks, auth races, search regressions), not a latency budget:
it does not currently assert on timing. Worth knowing before assuming
"there's an e2e gate" implies "there's a performance gate."

## What is instrumented but not held to a budget

`packages/backend/src/utils/metrics.ts` defines a real `prom-client`
registry — `http_request_duration_ms` (histogram, labeled by method/route/
status), `feed_ranking_duration_ms`, and real-user `web_vital_lcp_ms` /
`web_vital_inp_ms` / `web_vital_cls_ratio` histograms (fed by
`routes/webTelemetry.routes.ts`) all exist and are computed correctly today.
`routes/internalMetrics.routes.ts` exposes them in Prometheus text format,
IP-allowlisted and token-gated.

### Where a request's time goes: Postgres, or Oxy

Two instrumentations answer the question `http_request_duration_ms` cannot —
*what* a slow route was slow doing. Both attach at a single seam and both
report per request, on the `HTTP request completed` log line that
`middleware/requestObservability.ts` emits:

| Field | Source | Reads |
| --- | --- | --- |
| `queryCount` / `queryDurationMs` | `db/queryMetrics.ts` | Postgres statements issued and time inside them |
| `oxyCallCount` / `oxyDurationMs` | `utils/oxyMetrics.ts` | Oxy API calls issued and time waiting on them |

`slowQueryCount` / `failedQueryCount` and `failedOxyCallCount` sit beside them.
The matching histograms — `db_request_queries`, `db_request_duration_ms`,
`oxy_request_calls`, `oxy_request_duration_ms`, plus per-call
`oxy_call_duration_ms` and `oxy_calls_total` by templated route — are in the
registry too, but **the log line is the one that survives the process**, for
the reason immediately below.

Read them together. `postHydrationStatementBudget.test.ts` pins one hydration
at seven statements whether it hydrates one post or twenty, so a route that is
slow with a small `queryCount` is slow somewhere else, and `oxyCallCount` is
where to look first: `PostHydrationService.buildViewerContext` resolves the
viewer's blocked, restricted, following and follower sets live for any caller
that does not thread a pre-resolved `viewerGraph` — which the feed path does
and post detail, notifications, profile and search do not.

**Measured, because that reads like waste and mostly is not.** Threading
`viewerGraph` into search's hydration was implemented and reverted: the Oxy call
count was IDENTICAL before and after, because `buildViewerContext` already
resolves each of the four exactly once per request, so moving the resolution
moved it without removing it. `__tests__/routes/searchOxyCallBudget.test.ts`
pins those counts and is what the reversal left behind. The duplication that IS
real is ACROSS requests — the search screen's "All" tab issues `/search` and
`/posts/saved` separately and each pays the four for the same answers — and only
a combined endpoint resolving the context once can collapse that. One genuine
per-request waste survives and is pinned at its current value: with an
`exclude-following` muted word, `getUserFollowing` is called twice.

**No PRODUCTION baseline numbers are recorded here yet.** The instrumentation
exists; a number belongs in this document only once someone has read it off a
real deployment, and one written from a code trace would be a guess wearing a
measurement's clothes.

The search figures in the section below are the one exception, and they are
labelled as what they are: `EXPLAIN ANALYZE` against a seeded local database of
stated size. That is a real measurement of a QUERY PLAN, which is what changes
when an index is added — but it is not a request p95, it does not include the
network, Oxy, Clarity or hydration, and the data is synthetic. Do not read them
as a service-level baseline; read them as before/after evidence that a specific
plan changed. `OXY_REQUEST_METRICS_ENABLED=false` takes the Oxy half
out of the path entirely (no wrapper, no async context), the same posture as
`DB_QUERY_METRICS_ENABLED`.

### Search: what the plans do now, measured

Before/after `EXPLAIN ANALYZE` on seeded local databases, single backend, sizes
stated. Query-plan evidence, not request latency — see the caveat above.

| Query | Before | After | Data |
|---|---|---|---|
| Oxy people search, rare term | 191.97 ms (seq scan, 200k rows filtered) | **0.026 ms** | 200k users |
| Oxy people search, common term | 71.57 ms (3 parallel workers) | **18.84 ms** | 200k users |
| Oxy people search, 2-char term | seq scan, guaranteed | **19.90 ms** | 200k users |
| `GET /lists?search=`, selective | 59.87 ms (seq scan, 120k filtered) | **0.19 ms** | 120k lists |
| `GET /lists?search=`, unselective | 56.98 ms | 31.36 ms | 120k lists |
| The `count(*)` beside it | 54.07 ms | **0.21 ms** | 120k lists |
| `GET /hashtags/` trending window | 325.79 ms | cached | 400k posts |
| `GET /hashtags/` direction maps (×2) | 63.94 ms each | cached | 400k posts |
| `GET /hashtags/search` and the overview's hashtag lane | 51.50 ms (parallel seq scan — see below) | **1.16 ms** | 500k posts, 200k tagged |

The rare-term row is the one that matters: a sequential scan costs the same
whether it finds nothing or everything, so the old plan charged full price for
the most common outcome of a real search.

Two of these settled arguments rather than just recording wins. The
`count(*)` row is why `total` was KEPT on the list and pack endpoints after
being removed — the count was expensive because the index was missing, so
fixing the index fixed the count. And the hashtag-search row is why the planned
`hashtag_stats` table became a cache — on a measurement that turned out to be
of a hand-written query rather than the one the service ran.

**The hashtag row was wrong until #1140, and how is worth knowing.** The index
is on `posts_hashtags_search_text(hashtags)`, an IMMUTABLE wrapper around
`array_to_string`; the service filtered on `array_to_string(hashtags, ' ')`
directly. Postgres will not inline an IMMUTABLE function whose body is only
STABLE, so the two expressions never matched and every hashtag search — the
Hashtags tab and the `/search/overview` lane alike — read every public tagged
post. Production, 2026-09-11 to 09-25: that statement logged slow 213 times,
**4.3 s median, 17.6 s p90, 35.7 s worst**; `/search/overview` ran 1.57 s at the
median and 10.4 s at worst, and it is the request every search waits on. The
lane's 1 s statement budget did not stop it either, because the lane queries
ran on `getDb()` rather than on the transaction the budget was `SET LOCAL` on.
Both are fixed: the expression is `hashtagsSearchTextSql` on the schema, shared
by the index and the query, and `searchIndexes.test.ts` EXPLAINs the builder's
own statement; `searchOverviewBudget.test.ts` pins that a lane query is
cancelled at its budget and run once.

**The posts search (`GET /search`), the second half of #1140.** With the
overview fixed, signed-in search still took 8–10 s to show People: the All tab
awaited every source, and `/search` ran 3.2 s, 5.0 s and 6.9 s for "rust",
"climate" and "linux" (production, 15:43Z on 09-25). Two causes, both measured:

- The query's best plan depends on how common the word is — newest-first walk
  for a common word, the `search_vector` GIN index for a rare one — but
  postgres.js prepares every statement, and after five executions Postgres may
  cache a GENERIC plan that never sees the word. That plan walks newest-first
  for everything. On 1M seeded posts (warm cache), before → after
  `services/search/postSearch.ts` (`force_custom_plan`, serial, and the
  long-dead `config.search.maxTimeMS` as its `statement_timeout`): "linux"
  1411 → 5.6 ms, "rust" 1088 → 10.2 ms, "climate" 535 → 33.5 ms, "mention"
  62 → 3.7 ms. Pinned by `__tests__/db/postSearchPlan.test.ts`.
- Hydration asked Clarity to wait up to 2 s (`waitMs`) for any link it had
  not resolved yet, which is the ~2 s every production `/search` spent after
  its query. A read no longer waits; posts are warmed at ingest and creation.

The frontend now runs the All tab as one query per source
(`hooks/useSearchAllSources.ts`) and renders each section as it lands —
`__tests__/searchScreenProgressive.test.tsx` holds the posts source open and
asserts People is on screen.

**Nothing scrapes it.** There is no Prometheus, Grafana, or CloudWatch
metrics pipeline for Mention in `oxy-infra/terraform-uswest2` (checked
directly, not inferred) — `/internal/metrics` is a live snapshot an operator
can `curl` by hand, not a time series anything retains. That means:

- No p50/p95/p99 for any backend path survives past the current process.
- No dashboard, no alert, and no way to answer "did this regress since last
  week" from data — only "what is it right now."
- A numeric SLO written against `http_request_duration_ms` today would be a
  budget nothing enforces, which is the exact failure mode this document
  opens by naming.

This covers every backend path #703 asked for (following/For You/profile
feed, search, post create/update, notifications, ActivityPub inbox and
delivery-queue age, websocket propagation, background worker queue age) in
the sense that request-level latency for anything routed through Express is
already in `http_request_duration_ms` by route label, and feed ranking has
its own histogram. The gap is uniformly the pipeline, not per-path
instrumentation — fixing it once (standing up scraping + retention for
`/internal/metrics`) unlocks a budget for all of them at once, rather than
needing a bespoke solution per path.

### Web navigation latency

`packages/e2e/perf/nav-latency.mjs` measures how long the app is blank after a
tap, and attributes it. Like `reel-open.mjs` it is a measurement, not a gate:
it prints numbers and never fails.

Measured 2026-09-05 against production, real Chrome on a private Xvfb, signed
out, warm cache, fresh page per run, n=10 (mobile) / n=6 (desktop):

| feed row → `/p/<id>` | cold (first of the session) | hot (second, same page) |
| --- | --- | --- |
| blank frame, p50 | **315 ms** (430x932) / 310 ms (1440x900) | **1 ms** / 2 ms |
| tap → real content, p50 | 332 ms / 321 ms | **13 ms** / 16 ms |

The attribution matters more than the totals: the route chunk is fetched in
**1 ms** from disk cache, **no API call completes inside the blank window**
(the screen paints from the in-memory post cache before `/feed/item/` even
starts), there are **zero long tasks**, and rAF delivers 20 frames at a regular
17 ms cadence through the wait. The main thread is idle and the network is
done — the wait is the first-time resolution of the route module, and the `hot`
column is both the proof and the ceiling.

Absolute numbers here belong to one machine and one network; they are
meaningful against another run of the same harness on the same setup, and
nowhere else.

## Native feed row cost (Jest harness, issue #1103)

`packages/frontend/components/Feed/__perf__/rowCost.perf.tsx`, run with
`bun run --cwd packages/frontend test:perf` and in CI on every frontend change.
It mounts REAL feed rows — `renderFeedRow`, the function both Feed
implementations call — under the real Bloom provider, i18n and React Query.
Only native modules and the network boundary are replaced
(`test-support/perfSetup.ts`); every request a row makes is recorded.

Two kinds of number come out of it, and only one of them gates:

- **Structural, gated** (`__perf__/budgets.json`): element instances, hook
  slots, context reads and host primitives per row kind (hooks and contexts are
  read off React's committed fibers — they are the controllers and store
  subscriptions a row mounts, which an element count cannot see), requests and React Query observers per row, renders
  per mount, re-renders of UNRELATED mounted rows for an unrelated store write /
  a like on another post / a view-count update, and translation requests during
  a 200-post fling (must be zero). These are exact and deterministic. Lower a
  ceiling when an optimization lands; raising one is a decision the PR states.
- **Timing, recorded not gated**: JS ms per row mount and per recycle, median of
  7 runs. Jest on a dev React build, on a machine that may be running other
  work — relative evidence between two runs on the same machine, never device
  frame time.

Since #1115 the harness compiles rows with the React Compiler, as the app
ships them (`jest.perf.config.js` sets `supportsReactCompiler` on the Babel
caller; jest-expo's own caller does not). Numbers before that PR are for the
hand-written hooks; the last column is compiled output.

### Hook slots per row across #1103

Baseline is `main` at a1705141f, before any #1103 change
(`__perf__/results/baseline-main.json`); the current numbers are in
`__perf__/results/latest.json`. node 24, jest-expo ios.

| Row | baseline | #1109 selectors | #1114 lazy machinery | #1112 one controller | #1115 compiled | change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| text | 478 | 498 | 427 | 342 | **291** | −39% |
| image | 645 | 665 | 493 | 408 | **349** | −46% |
| multiImage | 726 | 746 | 574 | 489 | **406** | −44% |
| video | 600 | 620 | 549 | 464 | **402** | −33% |
| linkPreview | 531 | 551 | 480 | 395 | **344** | −35% |
| quote (2 posts) | 826 | 866 | 756 | 586 | **484** | −41% |
| repost | 497 | 517 | 446 | 361 | **310** | −38% |
| poll | 512 | 532 | 461 | 376 | **325** | −37% |
| communityNote | 522 | 542 | 471 | 386 | **335** | −36% |

Context reads per text row went 52 → 39. Element instances and host nodes did
not move: the work removed was hook state, subscriptions and controllers, not
views. What each step did:

- **#1109** removed the whole-store subscription in the four engagement hooks.
  It adds 20 slots (nine per-action selectors where there were four
  selector-less reads) and takes unrelated-write re-renders from 10/10 rows to 0.
- **#1114** mounts the zoom gallery (~100 slots on an image row) on first tap,
  the like burst animation on first like, and drops `useTranslation` from
  `AccountBadge` (which renders nothing for most accounts) and `PostContentText`.
- **#1112** replaces every per-row controller (engagement hooks, overflow-menu
  builder, community-note flows, share, sources/insights wiring) with one
  app-lifetime `usePostInteractions()` controller whose menu is built on press.
- **#1115** removes the reasons the React Compiler was skipping `PostItem`,
  `PostActions`, `PostAttachmentMedia`, `VideoPlayer` and `PollCard`. They were
  skipped on `main` too.

| Isolation (10 mixed rows mounted) | baseline | now |
| --- | ---: | ---: |
| row renders on an unrelated posts-store write | **10** | **0** |
| other-row renders when post A is liked | 0 | 0 |
| other-row renders on a view-count update | 0 | 0 |

The one request per row is the author avatar prefetch. A 200-post fling makes
198 requests, all avatar prefetches, and **zero** translation requests. Before
#1106 the frontend could auto-translate a row on mount; now only an explicit
Translate calls the endpoint.

Measured outside the row harness, in each PR's own test:

| What | before | after | PR |
| --- | ---: | ---: | --- |
| live-presence Query observers, 50 avatars mounted | 51 | 1 | #1108 |
| avatars re-rendered when one user goes live | 51 | 1 | #1108 |
| video players re-rendered when one more row becomes visible (21 mounted) | 21 | 1 | #1116 |
| video player renders per scroll step (21 mounted) | 42 | 6 | #1116 |
| video players re-rendered when the active player changes | 21 | 2 | #1116 |
| identity edit for user A: rows re-rendered that do not show A | all | 0 | #1107 |
| poll fetches when a poll row remounts or recycles | 1 per mount | 0 (cached per viewer) | #1115 |
| inference calls for N concurrent translate requests (same post and locale, across instances) | N | 1 | #1110, #1113 |

`LinkifiedText` parsing (§11) was measured and **not** optimized, because it is
not material: `scanLinkifyEntities` takes 0.3 µs for a plain 96-character body,
0.5 µs for 1,164 characters and 6.7 µs for 21 entities (Bun/JSC, 20k
iterations). Even at 10× on Hermes that is well under 0.1 ms, against
millisecond row mounts. The cost of an entity-heavy body is the elements it
creates, and those are counted above.

### FlashList tuning (Phase 6): not changed, deliberately

`FEED_DRAW_DISTANCE = 1000` and `maxItemsInRecyclePool={20}` stay as they are.
#1103's rule is to re-tune them only against measured blank or late rows during
a deterministic fling, and that measurement needs a release build on a device.
The harness cannot see blank cells or time-to-visible. The procedure, once a
device run exists:

1. Release build on the reference Android device, with the seeded feed (the
   harness fixtures as a mock-server response).
2. Fling top→bottom at fixed velocity (adb `input swipe` scripted, 5 runs).
3. Record blank-cell frames and JS long frames (Perf Monitor / systrace) at
   drawDistance 1000, 750, 500, 250.
4. Keep the smallest value with zero blank frames; then vary the recycle pool
   (20, 12, 8) against RSS after 500 posts.

The harness's per-row numbers are the reason to expect a lower drawDistance to
hold: rows now build with ~40% fewer hook slots and none of the per-row
controllers. That is an expectation to test, not a result.

What this harness cannot see: device frame drops, native RSS, blank-cell
incidence and time-to-visible. Those need a release build on hardware and are
listed below as still uninstrumented.

### How to profile a feed regression

1. `bun run --cwd packages/frontend test:perf` — compare
   `__perf__/results/latest.json` with the committed copy. A structural number
   that moved is the regression; the budget gate names it.
2. For a component count that grew, mount the row kind alone
   (`FEED_PERF_RUNS=1`, `it.only`) and diff `renderer.root.findAll` by type
   against `main` — the new wrapper or hook-owning component is in the diff.
3. For a re-render that appeared, the isolation case prints which trigger woke
   unrelated rows; look for a selector-less store read (the
   `validate:feed-hot-path` gate catches the zustand form) or a Context whose
   value changed identity.
4. Timings: only compare two runs on the same idle machine; for frame time,
   use a release build on a device with the React Native profiler.

## What has no instrumentation at all

Native frame timing during a fling (dropped frames, time-to-visible, blank
cells), native memory (RSS) after a long scroll, and cold-start /
first-usable-screen timing on native (iOS/Android) have no measurement in this
repository today — they need a release build on hardware. The row's JS
structure, re-render isolation and per-row network side effects ARE measured,
by the Jest harness above. Web LCP is covered by the real-user web
vitals above; native cold start is not.

For #1103 specifically, these acceptance items are still waiting for that
device run: fixed-fling dropped/janky frames against baseline, long-scroll
RSS staying bounded, time-to-visible under a re-tuned drawDistance, and a
release-build baseline of the "~40 ms per row" dev-build figure.

## Recommended next step, not taken in this pass

Wire `/internal/metrics` into a retained time series (CloudWatch embedded
metric format from the existing ECS tasks is the lowest-new-infrastructure
option, since Mention already runs there — see `oxy-infra`). That is an
infrastructure decision for `oxy-infra`'s own owners, not a Mention code
change, and is why it is a recommendation here rather than a PR. Once a
metric survives longer than the process that emitted it, come back and
write a real p95/p99 number against it — a number chosen before that lands
would be a guess wearing an SLO's clothes.
