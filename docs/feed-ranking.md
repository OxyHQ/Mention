# Feed ranking, classification, safety and interstitials

Deep detail behind the feed rules in `AGENTS.md`. Feeds live in
`packages/backend/src/mtn/` — ForYou, Following, Author, Hashtag, Explore,
Custom, Videos feeds + tuners; see `docs/architecture.mdx` § Feed engine for
the descriptor system.

## Unified Content Classification (two-stage hybrid)

All posts — native AND federated — go through the same classification
pipeline at ingest.

**Stage A — deterministic baseline** (`services/BaselineContentClassifier.ts`,
pure/sync). Runs at all ingest chokepoints: `PostCreationService`,
`feed.controller` reply path, `OutboxSyncService.insertMany`,
`InboxProcessingService`. Writes a `postClassification` subdoc:

- `languages: string[]` — SINGLE multi-language field (all detected/declared
  ISO 639-1 codes, primary first, deduped, cap 3). Detection: tinyld
  `detectAll` with a combined gate (`secondaryMinAccuracy:0.2` AND
  `secondaryMinRatioToTop:0.5`). Federated: `extractApLanguages` reads AP
  `language` + all `contentMap` keys. Feed language-match is ANY-OVERLAP
  (`$in` / `.some()`) at all 3 sites: `FeedRankingService`, `ExploreFeed`,
  `forYouCandidateSources`.
- Top-level `post.language` = `languages[0]` (primary, the AP protocol
  field).
- Sensitive, spam, quality, toxicity scores
  (`services/contentClassification/spamQuality.ts`), normalized hashtags,
  rule-based topics via `TopicClassifier`.
- Status: `'pending'` (waiting for Stage B).
- `BASELINE_CLASSIFIER_VERSION` — ranking only trusts scores stamped at or
  above this version. Bump it whenever a Stage-A signal changes meaning so
  older stamps stop being honored.

**Stage B — async AI enrichment** (`PostClassificationService`, Oxy inference backed by Kaana).
`updatePostRecord` takes a PARTIAL patch of only the AI-owned fields — the
Stage-A deterministic fields (languages, region, hashtagsNorm, version,
sensitive) survive by the patch TYPE, the guarantee a dotted Mongo `$set`
used to give by convention. Never a whole-subdoc overwrite (would wipe Stage
A fields). Topics via `postClassification.topicRefs` resolved through
`TopicService.resolveTopicRefs`. Readers prefer `topicRefs`, fall back to
the Stage-A slug-only `postClassification.topics`, then neutral (`[]`).

**Search is Postgres full-text, not a MongoDB text index.**
`postContentVariants.searchVector` is a generated `tsvector` column,
`to_tsvector('english', coalesce(body, ''))`, queried with
`websearch_to_tsquery('english', ...)` in `routes/search.ts`. It is
unconditionally English — there is no per-document `language_override`
mechanism to get wrong.

## Read-Surface Safety Gating

Sensitive/NSFW gating and muted words are per-VIEWER safety rules, not feed
features — every surface that shows a viewer other people's content applies
them. Three modules, no fourth copy of any predicate:

- **`mtn/feed/feedSafety.ts`** — the SINGLE source of truth for
  sensitive/NSFW. Two equivalent forms: Postgres SQL predicates
  (`sensitiveExcludeSql`, `nsfwHashtagExcludeSql`, `discoverySafeSql`) for
  query-level exclusion, and in-memory predicates (`isSensitivePost`,
  `isSfw`/`isDiscoverable`, `filterDiscoverable`) for already-fetched rows.
  Feeds, ranking, Trending, search, notifications and the OG web shell all
  import from here. Per-user `privacy.showSensitiveContent` (default
  `false`) makes it viewer-conditional. `requiresContentWarning` is the
  WIDER gate (sensitive OR a federated CW) for surfaces that cannot render
  a warning at all — an unfurl, a plain-text notification preview; feeds
  keep the narrower `isSensitivePost` because their client shows a spoiler.
- **`services/safety/muteWordMatcher.ts`** — the pure compile/match for
  muted words, honouring `targets` (`content`/`tag`) and `actorTarget`
  (`all`/`exclude-following`).
- **`services/safety/viewerSafety.ts`** — the ONE read path for both viewer
  preferences; soft-fails toward the safe default.
  `services/viewerFollowGraph.ts` owns the Oxy ∪ federated follow union both
  feeds and `exclude-following` mutes read.

Surface behaviour: search excludes sensitive at the QUERY level and drops
muted posts after hydration (cursor is taken from the UNFILTERED page
window, so a short page never skips a result). Notifications withhold the
preview/embed of a gated post but keep the row, and REMOVE a muted one
entirely — both only for posts the viewer did not author. OG unfurls emit
no `og:image` and none of the body for a gated post (a boost is judged
against its original too).

## For You Ranking (`FeedRankingService.rankPosts`)

`rankPosts` is the ONE ranking path for ForYou, Explore, Videos, and Media
feeds.

- Candidates (`mtn/feed/feeds/forYouCandidateSources.ts`): multi-source,
  bounded, parallel — following, affinity, topic/language/region match,
  trending, global discovery (always SFW).
- Signals (config in `packages/shared-types/src/mtn/config.ts`): author
  authority (bounded log-scale follower count), AI + deterministic
  quality/spam/toxicity (provenance-gated), engagement weights, diversity
  penalties (`sameAuthorPenalty`, `sameTopicPenalty`).
- Author-diversity rerank (`diversifyByAuthor`) runs BEFORE page
  truncation; only the page window is hydrated.
- Never-blank fallback: when the unseen pool is exhausted (seen-set 1000
  cap / 30-min TTL), ForYou falls back to `fetchPopular`.
- Surface-aware engagement: likes/saves/boosts from the Videos feed dampen
  author affinity but boost topic + post-type affinity. `Like.source` is
  persisted.
- `userBehavior` context is loaded in `feed.controller` on every ForYou
  request — affinity and preferred-topic signals were dead without it.
- Viewer languages: `loadViewerFeedContext` resolves the viewer's Oxy
  account languages via the Redis-cached `resolveUserSummaries` path. They
  are BCP-47 LOCALES (`es-ES`), while `postClassification.languages` are
  ISO 639-1 base codes (`es`), so `languageMismatchPenalty` compares on the
  BASE subtag via `getBaseLanguage`. Empty on either side ⇒ neutral.

## Feed Interstitials (Recommendation Cards)

Suggested users / custom feeds / starter packs spliced between post slices —
horizontal snap carousel on mobile, vertical list on desktop
(`packages/frontend/components/Feed/interstitials/InterstitialShell.tsx`).

- The server sends PLACEMENT, never content.
  `SlicedFeedResponse.interstitials?: FeedInterstitialSlot[]`
  (`{key, kind, afterSliceKey}`) is planned by
  `packages/backend/src/mtn/feed/interstitials/planInterstitials.ts` — pure,
  synchronous, zero I/O. Wired at the tail of `MtnFeedController.getFeed`,
  gated on `currentUserId` so nothing personalized reaches `anonFeedCache`.
  The client fetches each card's content lazily from `/recommendations`,
  `GET /feeds/marketplace`, `GET /starter-packs`.
- Mix adapts to follow-graph density — config-only,
  `MtnConfig.feed.interstitials`: `allowedDescriptors`
  (`for_you`, `following`, `explore`), `coldMaxFollowing: 20` /
  `denseMinFollowing: 150`, per-temperature `positions` (slice indices) and
  `rotation` (kind order), `densePageInterval: 2`. Cold graph leads with
  `suggestedStarterPacks`, early (slice 3); dense graph mostly
  `suggestedUsers`, gated to every other page.
- Exclusions: `GET /feeds/marketplace?excludeSubscribed=true` and
  `GET /starter-packs?excludeUsed=true`. Oxy's scorer already excludes
  accounts the viewer follows.
- Dismissal is per-card, in-memory only (returns on refresh) — deliberate,
  matches Bluesky. No server-side dismissal state.
- The PROFILE feed carries its own card — `kind:'similarAccounts'`, the
  only kind that sets `subjectId`. Planned by the same `planInterstitials`
  but on a separate path, deliberately OUTSIDE the graph-temperature model:
  that model asks how much bootstrapping the VIEWER needs, while this card
  is about the feed's SUBJECT. The card is DROPPED on the viewer's own
  profile.
- Card telemetry is counters-only —
  `POST /feed/mtn/interstitial-events`. It must never go through
  `trackFeedInteraction` / `POST /feed/mtn/interactions`: that path
  requires a `postUri` and feeds POST ranking, so card engagement sent
  there would corrupt author/topic affinity with engagement that never
  touched a post. One metric,
  `feed_interstitial_events_total{kind,event,descriptor}`; `descriptor` is
  the BASE token (`author`, never `author|<id>`) validated against
  `isValidFeedDescriptor` precisely because it becomes a label. Anonymous
  viewers 200 no-op (never 401).

## Feed API plumbing

- **`ChronoCursor.applyToQuery` no longer exists** — pagination goes through the opaque, versioned token in `utils/chronoCursor.ts`, which has no query-object-mutation footgun to warn about. `posts.id` is `text` now, not `_id`; never sort or page a chronological query by id alone (see `docs/architecture.mdx` § PostgreSQL — the only store).
- **FOUR field projections feed hydration** (`mtn/feed/FeedAPI.ts`, `controllers/feed.controller.ts`, `services/ThreadSlicingService.ts`, `routes/search.ts`). A field missing from one hydrates `undefined` with no error.
- **Any surface INCLUDING boosts must pass `maxDepth: 1`** or boosts render blank.
- **`hasMore` comes from the overfetch flag**, never `slices.length >= limit`.
- **Never put a non-post inside `slices[].items`** — `flattenSlicesToItems` pushes `item.post` unguarded. Interstitials (planned in `mtn/feed/interstitials/planInterstitials.ts`) are a top-level field, anchor by `_sliceKey`, and must never report impressions or go through `POST /feed/mtn/interactions`.
- **Never block the feed response on remote link-preview or image fetching.**

## Feed Performance

- Hydration author-batch: `PostHydrationService.buildUserMap`
  batch-resolves authors via `oxyServices.getUsersByIds`.
  `services/userSummaryCache.ts` caches the raw canonical Oxy `User` (as
  `PostUser`) + followerCount + the account's BCP-47 `languages` in Redis
  (key `usersummary:v3:<id>`, 10m TTL); `invalidate()` evicts on
  federated-actor re-resolve. The follower count and languages are
  RANKING-side (`CachedUserSummary`) and deliberately never ship on the
  `PostUser` DTO.
- View counts: `services/feedViewCounter.ts` (Redis SET NX EX
  `viewseen:<postId>:<viewerId>`). Frontend reports impressions via
  `utils/feedTelemetry.ts`.
- Instant post-detail: memory-mode feeds seed the shared post cache
  (`postsStore.cachePosts`) in `useFeedState`; `app/(app)/p/[id].tsx` paints
  from cache + background-revalidates (`revalidatePostById`).
