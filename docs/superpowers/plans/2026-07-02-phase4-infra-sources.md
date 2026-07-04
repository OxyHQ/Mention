# Phase 4 — Infra-heavier source modules (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Add the remaining source modules that need more than a lean query. Per user's best-judgment defaults (away at decision time): `moreLikeThis` via topic/tag/author OVERLAP (no embeddings infra); plus `risingCreators`, `nearby/local`, `friendsOfFriends`. Re-confirm the embeddings choice with the user if they respond.

**Architecture:** Same engine module pattern (SourceModule + registry + catalog). Two need new infra: `risingCreators` (a periodic follower-count snapshot + delta) and `friendsOfFriends` (an Oxy follows-of-follows endpoint, upstream-first like mutuals). `nearby` uses the existing sparse post `location`. `moreLikeThis` uses existing classification/tag/author data — no new infra.

**Tech Stack:** TS, Mongoose, Redis, vitest; `@oxyhq/core`/oxy-api for FoF (upstream); builds on merged engine.

## Global Constraints

- `bun`/`bunx`; tests from worktree `packages/backend`. No `as any`/`@ts-ignore`/`!`/`console.log`/silent catch/`var`/TODO. No `Date.now()` at module scope. Any `setInterval` singleton → `.unref?.()`.
- New sources default `userComposable` where they aren't viewer-relative; register in `engine/sources/index.ts` + add to `GET /feed/modules` catalog.
- Sources soft-fail to `[]`; bounded; select FEED_FIELDS; maxTimeMS.

## Base

Stacked worktree from the tip of Phase 2b (after it merges) — do NOT run in parallel with 2b (shared engine files). `git worktree add -b phase4-infra-sources .claude/worktrees/phase4-infra-sources origin/main` (or origin/<phase2b branch> if 2b not yet merged) + `bun install`.

---

### Task 1: `moreLikeThis` source (overlap-based, no embeddings)

**Files:** `engine/sources/relatedSources.ts` + register; test.
- [ ] Params `{ postId }` (or `{ topics, hashtags, authorId }`). Load the seed post, then query posts sharing `postClassification.topics`/`topicRefs.name` OR `hashtagsNorm` OR same author, excluding the seed + viewer-blocked + sensitive (SFW), scored by overlap count (stamp `finalScore`), recent-window bounded. TDD (overlapping post ranks above a non-overlapping one; seed excluded). `userComposable: true`. Commit.

### Task 2: `nearby`/`local` source (geo, best-effort)

**Files:** `engine/sources/relatedSources.ts`; possibly a 2dsphere index on Post `location`; test.
- [ ] Params `{ lat, lng, radiusKm }` (or viewer region fallback). If Post `location` has coordinates, `$near`/`$geoWithin`; else fall back to `postClassification.region` match. Add a `2dsphere` index if a coordinate field exists and isn't indexed (note if location is non-geo today → document as best-effort region match until location data improves). TDD. `userComposable: true`. Commit.

### Task 3: `risingCreators` — follower-snapshot job + source

**Files:** `models/AuthorFollowerSnapshot.ts` (new), `services/followerSnapshotJob.ts` (new, leader-gated periodic like other schedulers, `.unref?.()`), `engine/sources/relatedSources.ts` (source); tests.
- [ ] Snapshot model `{ oxyUserId, followerCount, at }` (capped/rolling). A leader-gated periodic job samples follower counts for active authors (via `resolveUserSummaries`/Oxy) and records snapshots. `risingCreators` source computes delta over the window (current − prior snapshot), ranks by growth rate, returns those authors' recent public SFW posts. TDD the delta ranking with seeded snapshots. `userComposable: true`. Commit. (Env-gate the job on `REDIS_URL`/leader election, inline no-op otherwise.)

### Task 4: `friendsOfFriends` — Oxy upstream + source

**Upstream (OxyHQServices, oxy-api + core, separate agent, gate deploy/publish with user):**
- [ ] `GET /users/follows-of-follows-ids?limit=` — viewer from auth token; returns bounded ids = union of (follows of the viewer's follows) minus the viewer's own follows + self. Reuse the Follow aggregation. `@oxyhq/core getFollowsOfFollowsIds({limit?}): Promise<string[]>`. TDD; no deploy/publish without gate.
**Mention:**
- [ ] `friendsOfFriends` source (`engine/sources/socialSources.ts`): `oxyUserId ∈ ctx.fofIds` (populated by controller for this source, guarded optional-call like mutuals, ∪ nothing federated), chrono/ranked. Controller wires `ctx.fofIds` gated on the descriptor/source. `userComposable: false` (viewer-relative). TDD. Commit.

### Task 5: Optional preset definitions

- [ ] If desired, add preset descriptors for the new sources (e.g. a "Near you" or "Rising" preset) + catalog entries. Otherwise they're builder-only + available via custom feeds. Decide with user.

## Post-implementation

- Full backend suite + build green. Gate via test-build → PR → batch-merge.
- Oxy FoF endpoint + core method: upstream-first (deploy oxy-api + publish core + bump Mention), gated with the user like the mutuals go-live.

## Self-review notes

- `moreLikeThis` ships without embeddings (overlap-based) per the default; embeddings remain an open option if the user chooses the bigger infra later.
- `risingCreators` job is leader-gated + timer-unref'd + env-gated (no test hangs, no prod surprise).
- `friendsOfFriends` follows the mutuals upstream pattern (no client-side graph).
- Every source default-safe (SFW, blocked/muted excluded, soft-fail).
