# Phase 2b — New ranking signal modules (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Add the new ranking SIGNALS to the engine — each as a real `FeedRankingService` scorer + `MtnConfig.ranking` weight, wired to its signal module `weightKey`. Signals are default-neutral and **opt-in per definition**; existing preset ranking (esp. For You) is UNCHANGED unless a definition explicitly adds the signal, so no ranking regression.

**Architecture:** Every signal wraps a new (or existing-data) per-post scorer in `FeedRankingService.calculatePostScore`, provenance/data-gated to default-neutral (multiplier 1.0) when the input is absent. The engine already forwards a definition's enabled signal `weightKey`s to ranking; Phase 2b makes those keys real. New data plumbing (dwell store, seen-set penalize, network-engagement) is added where needed, fail-soft.

**Tech Stack:** TS, Mongoose, Redis (for dwell/seen), vitest. Builds on the merged Phase 0-3 engine on `main`.

## Global Constraints

- `bun`/`bunx`; tests from the worktree `packages/backend`. No `as any`/`@ts-ignore`/`!`/`console.log`/silent catch/`var`/TODO. No `Date.now()` at module scope.
- **No regression:** do NOT add new signals to `ALL_RANKING_SIGNALS` / For You's default signal set. New signals are available for custom feeds + explicit future tuning only. Parity tests for For You/Explore/Videos must still pass unchanged.
- **Default-neutral:** each scorer returns 1.0 when its data is missing or below the provenance bar (mirror `getClassifiedScores` gating for classification-derived signals).
- Config weights live in `packages/shared-types/src/mtn/config.ts` (`MtnConfig.ranking` + `preferences`). Conservative defaults.

## Base

Stacked worktree from `origin/main` (post batch-merge): `git worktree add -b phase2b-signals .claude/worktrees/phase2b-signals origin/main` + `bun install`.

---

## Signals (each = scorer + weight + module weightKey + test)

Implement each TDD: failing test on the scorer (neutral when data absent; boosts/penalizes when present) → implement scorer + config weight → wire the signal module's `weightKey` in `engine/signals/index.ts` → pass → commit.

| Signal | Data source | Scorer behavior | Plumbing needed |
|---|---|---|---|
| `mediaBoost` | post `type`/`content.media` | ×`>1` when the post carries media | none (on candidate) |
| `positivity` | `postClassification.sentiment` (provenance-gated) | ×`>1` for `positive`, neutral otherwise | none |
| `conversational` | `postClassification.scores.constructiveness` (or reply-ratio from `stats`) | ×`>1` with higher constructiveness | none |
| `coldStartBoost` | post `createdAt` + author age proxy | small × boost for brand-new posts/authors to aid discovery | none (post) |
| `penalizeSeen` | engine `ctx.seenPostIds` | ×`<1` for already-seen posts (soft de-prioritize instead of hard exclude) | reuse `execution.seenPosts` resolution; pass seen set into ranking |
| `verifiedBoost` | author verified flag (Oxy user summary) | small × boost for verified authors | needs author summary at rank time (already resolved for authority) — reuse `resolveUserSummaries` |
| `socialProof` | posts liked/boosted by `ctx.followingIds`/`ctx.mutualIds` | × boost scaled by # of network engagers | new: a per-request map of postId→network-engager-count (aggregate `Like`/boosts where `userId ∈ following/mutuals`, bounded), passed via ctx |
| `reciprocityBoost` | `userBehavior.preferredAuthors` ∩ mutuals | × boost for authors the viewer mutually engages | reuse `userBehavior` + `ctx.mutualIds` |
| `dwellTime` | avg impression `durationMs` per post | × boost for high-dwell posts | new: a dwell aggregate store (Redis key `dwell:<postId>` rolling avg, written by `feedTelemetry`/`recordInteraction`), read bounded at rank time |
| `noveltyBoost` | viewer's recently-seen topics | × boost for topics NOT recently seen (exploration) | new: per-viewer recent-topic set (Redis, TTL), read at rank time |

- [ ] For each signal: TDD scorer (neutral-when-absent is the critical test), add `MtnConfig.ranking.<signal>` weight (conservative), wire `weightKey`. Commit per signal (or small batches: "content signals", "network signals", "engagement-history signals").
- [ ] Plumbing tasks (own commits, fail-soft, `.unref?.()` any timers per the singleton rule):
  - `services/dwellAggregate.ts` (Redis rolling avg; written from the existing impression path in `feedViewCounter`/`feedTelemetry`).
  - `services/networkEngagement.ts` (per-request bounded `Like`/boost-by-network aggregation → postId→count map; threaded via ctx).
  - viewer recent-topics set (extend `UserPreferenceService` or a small Redis helper).
- [ ] Add the new signals to the `GET /feed/modules` catalog (they become builder-composable for custom ranked feeds).
- [ ] `bun run build` + full backend suite (incl. unchanged For You/Explore/Videos parity) green.

## Optional tuning (separate, gated with user)

Once the signals exist and are validated, a follow-up MAY adopt a subset into For You's default signal set with tuned weights — but that is a deliberate ranking change requiring before/after evaluation, NOT part of this behavior-safe phase.

## Post-implementation

- Gate via test-build → push (stacked on main) → PR → merge (batch/deploy per norm).

## Self-review notes

- Every signal default-neutral when data absent → no silent ranking shift.
- For You/Explore/Videos default signal sets untouched → parity preserved.
- New plumbing is fail-soft, bounded, and timer-safe.
