# Backend efficiency and structure — programme design

**Date:** 2026-08-30
**Base:** `origin/main` @ `f0ce9cea`
**Status:** approved, in execution

## Why

The backend is ~120 kLOC of TypeScript on Postgres/Drizzle + Valkey. It works, and
several of its hottest paths are already carefully optimised. What it lacks is
(a) any measurement of what its queries cost, and (b) module boundaries small
enough to change safely.

This document records what was measured, what was ruled out, and the order of
work. Each workstream below gets its own branch and its own PR.

## Measured baseline

Taken against `origin/main`, not the shared checkout (which was 145 commits
behind and would have reported Mongo as still present):

| Signal | Measurement |
|---|---|
| Source size | 160 files / 44 408 lines in `src/services`, 60/17 560 in `src/db`, 56/17 012 in `src/connectors` |
| Largest files | `posts.controller.ts` 4110, `PostHydrationService.ts` 3228, `TrendingService.ts` 1994, `ChannelDeletionService.ts` 1765 |
| Bootstrap | `server.ts` 896 lines: sockets, presence, boot, queue workers, shutdown |
| Layer bleed | 28 of 46 files in `routes/` + `controllers/` import `db/` directly |
| Raw SQL | 515 `sql\`` sites |
| Caching | no shared helper; 26 files call Redis directly with hand-rolled TTLs |
| HTTP observability | present — `middleware/requestObservability.ts` records `http_request_duration_ms` |
| DB observability | **absent** — no query timing, no roundtrip count, no slow-query log |
| Queue workers | BullMQ (5 federation queues) started in-process from `server.ts:753` via `require()` |
| Input validation | zod in 5 of 46 route/controller files |
| Tests | 495 files / 6106 tests, green in 43 s |
| Typecheck | clean |

Two initial hypotheses were **disproved** and are not part of this programme:

- *"Error handling is ad-hoc."* It is not. `app.ts` mounts a central
  `globalErrorHandler`; the 247 `try {` blocks sit above it, not instead of it.
- *"Config is scattered."* The 43 `process.env` reads outside `src/config` are
  almost entirely in `src/scripts/`, not in request-path code.

## The finding that reordered the work

`PostHydrationService` is the largest service and the obvious target by line
count. Reading `hydratePosts` end to end shows it is **already batched**: twelve
`buildXMap` helpers that each take the whole post set, eight `Promise.all`
fan-outs, a concurrency limit, a 1500 ms resolution deadline, in-flight
deduplication, and comments explaining each dependency edge.

Size is not inefficiency. Its waterfall is four stages — `buildViewerContext` →
`collectPostsWithDepth` → `Promise.all(8)` → `buildPostSummary` — and the
expensive stage is plausibly **network, not Postgres**:
`resolveOxyUserSummaryMisses` calls the Oxy service at concurrency 8 behind that
deadline.

So optimising hydration blind would most likely have optimised the wrong stage.
Cheap instrumentation comes first, and it rides inside the first workstream
rather than becoming a phase of its own.

## Workstreams

Each owns a disjoint set of files so the branches can run concurrently.

### W1 — Query instrumentation
**Owns:** `src/db/postgres.ts`, `src/db/queryMetrics.ts` (new), `src/utils/metrics.ts` (additive), `src/routes/internalMetrics.routes.ts` (additive)

Wrap the postgres.js client so every statement records duration and a
caller-supplied operation label into the existing prom-client registry, plus a
slow-query log above a configurable threshold and a per-request roundtrip
counter joined to `requestObservability`. Overhead must be negligible when the
feature is off.

**Done when:** a `GET /feed` and a `GET /posts/:id` against local Postgres report
their query count and per-query timings, and the numbers are written into this
document.

### W2 — Split `posts.controller.ts`
**Owns:** `src/controllers/posts.controller.ts`, `src/controllers/posts/**` (new), `src/routes/posts.ts`

36 exported handlers in one 4110-line file, with natural seams: create/thread,
read, engagement, geo, collaboration, translation. Move, do not rewrite —
behaviour-preserving, with the 25 existing test files still importing what they
imported before.

**Done when:** no file in `src/controllers/posts/` exceeds ~600 lines, the public
export surface is unchanged, and the suite is green.

### W3 — Slim `server.ts`
**Owns:** `server.ts`, `src/runtime/**` (new)

896 lines mixing socket wiring, presence bookkeeping, boot sequence, queue worker
startup and shutdown. Extract each concern into its own module under
`src/runtime/`, leaving a bootstrap that reads as a sequence. Drop the
`require()` at line 753 for a static import.

**Done when:** `server.ts` is a boot sequence under ~150 lines and every extracted
concern is independently importable and testable.

### Later workstreams (not yet started)

- **W4 — Unified cache layer.** One helper with TTL, stampede protection and
  explicit invalidation; migrate the 26 ad-hoc Redis sites.
- **W5 — Hot path, guided by W1's numbers.** Only after the measurements exist.
- **W6 — Layer boundaries.** `route → service → repository`, with a gate for the
  28 files that currently reach into `db/`.
- **W7 — Split the remaining monoliths.** `TrendingService`, `ChannelDeletionService`.
- **W8 — zod validation across all routes.**

## Verification contract

Every workstream, before its PR:

```bash
docker compose -f docker-compose.postgres.yml up -d postgres
cd packages/backend
bun run lint                                   # tsc --noEmit, must be clean
TEST_DATABASE_URL='postgres://mention:mention@127.0.0.1:5433/mention_dev' \
  bun run test                                 # 495 files / 6106 tests, all green
```

Both commands need the sandbox disabled: tsc writes `tsconfig.tsbuildinfo`, and
vitest's `globalSetup` needs to reach Postgres on `127.0.0.1:5433`. Without it
vitest reports "No test files found", which reads like a path mistake.

W2 and W3 are behaviour-preserving refactors: an unchanged test count is the
point, and any test that needs editing to keep passing is a signal the move
changed behaviour.

---

# Measured results

Filled in after execution. Every number here was measured, not estimated.

## What the instrumentation settled

W1's first job was to make the hot path measurable; its first finding was that the
programme's starting assumption was wrong.

**The read path is not N+1.** 18 statements for a 5-post page and 18 for a 20-post
page; `hydratePosts` is flat at 8 statements from 1 post to 20. `PostHydrationService`
being the largest service by line count said nothing about its cost — attacking it
blind, as the original "biggest first" ordering implied, would have optimised a path
that was already batched.

What it did surface was specific, and became W5 and W9.

## Query counts, before and after

| Path | Table | Before | After | Workstream |
|---|---|---|---|---|
| `hydratePosts` (any page size) | `user_settings` | 2 | **1** | W5 |
| `hydratePosts` total | — | 8 | **7** | W5 |
| For You viewer context | `federated_follows` | 3 | **2** | W9 |
| Feed hydration, cold cache | `starter_pack_members` | 3 | **2** | W9 |

Each is pinned by a statement-budget test with a positive control: re-introducing the
redundancy reds the gate.

## The `user_settings` duplicate was worse than a duplicate

The second read filled `ViewerContext.privacyPreferences`, which is **read nowhere** —
three occurrences in the whole tree (declaration, initialiser, assignment) and zero
reads across backend, frontend, shared-types and mcp. It could not have been correct
if it were read: `services/engagementCountPrivacy.ts` states those four flags belong to
a post's **author** and hide a counter from everyone, so a viewer-side copy described
what the *reader* discloses on their own posts. A query per hydration for a dead and
semantically inverted field.

## Redundancies deliberately left

- **`starter_pack_members` twice in `hydratePosts`** — not one query run twice but two
  disjoint cache-fill cohorts. Merging them means resolving the viewer *after* the post
  graph, which serialises link-preview resolution behind the Oxy author batch and its
  1500 ms deadline: one statement traded for latency on the hot path.
- **`federated_actors` twice on the For You path** — a different redundancy with
  different arguments, left rather than widening W9's change.
- **`user_settings` twice in the For You context** — two different column sets read by
  two modules in `feedContext.ts`.

## Corrections to this document's own baseline

Three figures in the "Measured baseline" table above overstated their problem, and the
work narrowed them:

- **Caching.** "No shared helper; 26 files call Redis directly" counted seven sites that
  are not caches at all — `LeaderElection`, `rateLimitStore`, `FeedJobScheduler`,
  `dwellAggregate`, `feedViewCounter`, `FeedSeenPostsService`, `notificationInbox`.
  Migrating a distributed lock into a cache abstraction would have been a bug. W4
  migrated the four modules that genuinely are caches.
- **Validation.** "zod in 5 of 46 files" ignored the typed query-param helpers already
  used in 19 files. The real gap was request *bodies*: W8 audited every raw `req.query`
  site and found none unsafe. It also found that
  `middleware/validate.ts`'s zod schemas are referenced by nothing except their own
  test — a set of schemas gating zero traffic.
- **Layer bleed.** "78 value imports" was stale. Re-measured: **110 crossings across 88
  (file, area) pairs over 63 route/controller files**.

## What the boundary gate does and does not do

W6 extended `scripts/validate-architecture-boundaries.mjs` rather than adding a second
mechanism, so the route/controller → `db/` rule inherits the existing default-deny,
per-file baseline and shrink-only properties. Type-only imports are allowed outright:
they are erased at compile time, and baselining them would make shrink-only adversarial
— the only way to "fix" `import type { PostRecord }` is to duplicate the row type.

Known gaps, recorded so they are not mistaken for coverage: `@oxyhq/db` is a bare
specifier the rule cannot see, and there is no reverse-direction rule stopping `db/`
from importing a service.

## Open work

- **The posts write path is unvalidated.** W8 left it deliberately — it carries the
  densest invariants in the repo — and reported five defects, the worst being
  `mergeHashtags` throwing on any truthy non-array, so `hashtags: "cat"` answers **500
  where 400 belongs** on the busiest write in the app. Its own workstream.
- **No end-to-end For You statement total.** The real For You definition gathers no
  candidates in the test harness (its sources soft-fail to `[]`), so W9's two savings
  are measured at their own boundaries rather than as one number.
- `curatorFollowerCounts` and `viewerRecentTopics` are further genuine caches that
  would fit W4's primitive.
