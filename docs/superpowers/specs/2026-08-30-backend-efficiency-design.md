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
