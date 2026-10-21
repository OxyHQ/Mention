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

- `languages: string[]` — SINGLE multi-language field (verified ISO 639-1
  codes, primary first, deduped, cap 3). Detection is local and deterministic:
  Unicode-script evidence plus ELD (`eld`, extra-small n-gram set, 60
  languages including Catalan, Basque, Danish, Czech and Slovak), run on the
  post's prose (links, mention placeholders, handles, emoji and markdown
  markers removed). A language is accepted when ELD calls it reliable AND it
  beats the runner-up score by >= 0.04; a second language is kept when the
  sentences confidently detected as it hold >= 30% of the text. Federated:
  `extractApLanguages` reads AP `language` + all `contentMap` keys, but those
  labels do not grant distribution by themselves. Kana or hangul that
  make up at least half of the letters correct contradictory labels (a quoted
  `きんかくじ` in English prose does not). A language the post already carries
  — the author's or origin's declaration, or, on a re-classification, the
  languages it is stored under (`previousLanguages`) — is replaced only on
  strong evidence: >= 40 letters and >= 5 words of prose, a reliable verdict
  beating the runner-up by >= 0.1 and the carried language's own score by
  >= 0.15, and a carried language ELD knows (so a declared Galician post stays
  `gl`). An undeclared body needs >= 12 letters and >= 3 words. Ambiguous
  bodies, and languages ELD lacks, produce `languages: []` rather than a
  neighbour's label. Feed membership is ANY-OVERLAP against this canonical
  field.
- The primary rendition's tag follows the resolved language
  (`applyDetectedPrimaryTag`): an untagged primary takes it, and a declared
  tag the classifier contradicted is replaced, so `textLang` and translation
  never disagree with the classification.
- Top-level `post.language` = `languages[0]` (primary, the AP protocol
  field).
- Sensitive, spam, quality, toxicity scores
  (`services/contentClassification/spamQuality.ts`), normalized hashtags,
  rule-based topics via `TopicClassifier`.
- Status: `'pending'` (waiting for Stage B).
- `BASELINE_CLASSIFIER_VERSION` — ranking only trusts scores stamped at or
  above this version. Bump it whenever a Stage-A signal changes meaning so
  older stamps stop being honored.

### Canonical evidence and provenance

External metadata is evidence, not an unconditional fact. At an ingest boundary,
Mention normalizes the declaration, compares it with independently observable
deterministic evidence where that comparison is reliable, and persists one
canonical value. Consumers do not repeat their own inference. For language, the
result is `postClassification.languages`; the top-level `post.language` mirrors
its primary value for ActivityPub, and hydration exposes the selected rendition
as `content.textLang`.

The same language reconciliation applies to native posts. Compose's selected
language is evidence, but a body that clearly identifies another language is
stored under the detected language. This covers a reader who forgets to change
the Compose selector. An ambiguous body remains unclassified and therefore does
not enter language-personalized recommendations under a guess. A future
Compose warning may offer to change the selector before publish; the backend
check remains mandatory because clients can be old, offline-first, or bypassed.

For a post with several declared languages, the visible primary rendition is
validated before those labels can widen recommendation membership. Future
per-rendition UI warnings must still inspect each `(tag, body)` pair rather than
comparing every declared tag with only the
primary body.

The reconciliation rule must be conservative and auditable:

- preserve a declaration when evidence is absent, short, or ambiguous;
- override only a strong contradiction with a documented threshold;
- preserve real multi-value structures whose other values cannot be checked
  against the currently visible rendition;
- version every semantic change and backfill older rows;
- keep declared and derived inputs available at the ingest boundary for tests
  and diagnostics, without making every read surface infer again.

The same shape should be used when other canonical fields gain validators — for
example content kind versus MIME/media rows, sensitivity versus CW/hashtags,
link identity versus canonical URL, and repost ownership versus the referenced
original. Those validators are not implied to exist merely by this policy; each
requires its own schema contract, confidence rule, tests, version bump, and
backfill before a consumer may rely on it.

**Stage B — async AI enrichment** (`PostClassificationService`, Kaana's
`instant` power level through `@kaana.ai/sdk`). Mention never names a provider,
deployment or routing profile; Kaana picks the model of the level and Oxy's
grant applies Mention's policy.
`updatePostRecord` takes a PARTIAL patch of only the AI-owned fields — the
Stage-A deterministic fields (languages, region, hashtagsNorm, version,
sensitive) survive by the patch TYPE, not by convention. Never a whole-subdoc overwrite (would wipe Stage
A fields). Topics via `postClassification.topicRefs` resolved through
`TopicService.resolveTopicRefs`. Readers prefer `topicRefs`, fall back to
the Stage-A slug-only `postClassification.topics`, then neutral (`[]`).

## Discovery-quality rollout

The [Jev shadow lane](./jev-shadow-evaluation.md) evaluates recent native public
posts into a separate ledger (`post_evaluations`). Nothing reads it yet: it does
not change canonical classification, feed ranking or admission.

Two gate PROFILES, one runtime switch. For You and Explore apply the full
discovery gate (`minLength`, `lowEffortGate`, `nativeEngagement`, `minQuality`,
`noContentWarning`); Trending, Videos and Media apply recommendation HYGIENE only
(`noContentWarning`) — an engagement floor on the feed that IS the
high-engagement tail, or a length floor on a feed of videos, would not make them
cleaner, it would make them a different feed. Followed, affinity and list lanes
remain trusted on both profiles. The popular fallback — the anonymous page and
the never-blank page — runs its definition's gate too, SCANNING to fill rather
than filtering a window already cut to the page, so a rejection backfills instead
of shortening it; `hasMore` and the cursor describe how far the scan consumed the
SOURCE, which is what keeps a run of rejected posts from reading as the end of
the feed.

`DISCOVERY_GATE_ROLLOUT` is the single runtime authority: `shadow` (the default)
measures without filtering, `experiment` enforces for the stable authenticated
`gate-on` cohort while keeping `gate-off` and anonymous traffic as control, and
`enforce` filters everyone. Module selection remains controlled by
`FOR_YOU_DISCOVERY_GATE`, whose allowlist lives in `config/index.ts` and has to
cover BOTH profiles — naming a module it lacks stops the process booting, and
`presetDefinitions.test.ts` asserts the two lists agree.

**The shadow measurement is retained in CloudWatch.** `feed_discovery_gated_total`
and every other metric in `utils/metrics.ts` is published once a minute as
CloudWatch EMF (namespace `Mention/Backend`, `@oxy.so/telemetry/metrics`): the
metric total is a CloudWatch metric with history, and its labels (`reason`,
`source`, `shadow`) are properties of the log line in `/oxy/ecs`, broken down in
Logs Insights with `filter ispresent(feed_discovery_gated_total) | stats
sum(feed_discovery_gated_total) by reason, source, shadow`. Until 2026-10-17 the
registry was prom-client, exposed only by an IP-restricted endpoint nothing
scraped, so no history exists before that date. `DISCOVERY_GATE_ROLLOUT` is set
in neither SSM nor the `oxy-mention` task definition, so production runs the
`shadow` default.

A gate filter may declare `needsAuthor`. The engine then runs it in a SECOND pass
over the merged pool, after resolving that pool's authors in one batch — the same
`resolveUserSummaries` ranking uses, handed on to `rankPosts` so a request pays
for one resolution rather than two. Not knowing is never a verdict: a batch that
could not be resolved leaves `ctx.authorSummaries` UNSET, which is deliberately
distinct from an empty map (a real answer), counts
`feed_author_gate_neutral_total{reason="no_map"}`, and makes every author-aware
rule abstain. An identity outage costs the gate its opinion, not the reader their
feed.

The structural branch rejects decoration with no letters or numbers and no
media/poll. It does not impose a language-biased minimum prose length: brief
text such as “Sí” or “猫” survives and the spam, trusted-quality, engagement,
freshness and personalization branches make the remaining decision.

**Search is Postgres full-text.**
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
- **`noContentWarning`** (`engine/filters`) is a RECOMMENDATION rule rather
  than a safety one, which is why it is a separate filter module and NOT a
  widening of `isSensitivePost`: a CW says how to PRESENT a post, not that it
  is NSFW, and widening that predicate would hide CW'd posts from Following,
  search, notifications and unfurls all at once. Mention does not RECOMMEND a
  post its author asked to be shown behind a warning — and never hides one
  from a reader who chose its author. **The followed-author exemption lives
  inside the predicate**, not in which feeds list the module: that is what
  makes the rule a no-op on Following BY CONSTRUCTION rather than by every
  definition remembering not to opt in, and what lets it sit safely on the
  hashtag / topic / trend / lane feeds, which have no trusted lane to scope it
  by. The reader's own toggle is `feedTuning.forYou.noContentWarning`.
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

`rankPosts` is the shared ranking path for presets that compute personalized
scores. Pre-scored sources retain their own score order.

- Candidates (`mtn/feed/feeds/forYouCandidateSources.ts`): multi-source,
  bounded, parallel — following, affinity, topic/language/region match,
  trending, global discovery (always SFW).
- Signals (config in `packages/shared-types/src/mtn/config.ts`): author
  authority (bounded log-scale follower count), AI + deterministic
  quality/spam/toxicity (provenance-gated), engagement weights, diversity
  penalties (`sameAuthorPenalty`, `sameTopicPenalty`).
- The engine's enabled signal modules are authoritative: a preset that excludes
  engagement or affinity does not receive those multipliers implicitly. Safety
  penalties remain mandatory. Zero engagement is a neutral multiplier of one;
  positive engagement adds a logarithmic lift, so new posts can still rank on
  freshness, quality and relevance.
- Session pages select membership jointly (`selectRankedPage`), preserving the
  author cap before applying the discovery-share target and spacing the chosen
  authors. If concentrated trusted inventory makes both constraints impossible,
  distinct discovery authors take priority over the trusted-share target.
  Same-author overflow fills only an otherwise short page. Deferred candidates
  stay in session state for later pages; only the selected page is hydrated.
  The stateless score-cursor fallback keeps its existing page-window rerank.
- `trustTierBoost` (opt-in) lifts by the author's Oxy standing
  (`new` → `verified`, read from the cached account summary). Lift-only, and
  neutral for an unresolved author — `restricted` accounts never reach Mention at
  all, so absence means "not resolved", never "badly behaved", and a penalty keyed
  on it would fall on cold caches rather than bad accounts.
- Never-blank fallback: when the unseen pool is exhausted (seen-set 1000
  cap / 30-min TTL), ForYou falls back to `fetchPopular`.
- Surface-aware engagement: likes/saves/boosts from the Videos feed dampen
  author affinity but boost topic + post-type affinity. `Like.source` is
  persisted.
- `userBehavior` context is loaded in `feed.controller` on every ForYou
  request — affinity and preferred-topic signals were dead without it.
- Viewer languages: `loadViewerLanguages` (`utils/viewerLanguage.ts`) reads
  the viewer's Oxy account languages from their owner profile (`users.me()`,
  with the request's own credential) — for `loadViewerFeedContext` and for
  every other hydration alike; Oxy's public profiles carry no languages, so the
  per-author summary cache cannot supply them. Cached per viewer in Redis
  (`viewerlanguages:v1:<id>`, the summary TTL as a safety net) and evicted by
  `userInvalidationSubscriber` on Oxy's `oxy:user:invalidate`, so a warm viewer
  costs no Oxy call and a reorder applies on the next request. They
  are BCP-47 LOCALES (`es-ES`), while `postClassification.languages` are
  ISO 639-1 base codes (`es`), so `languageMismatchPenalty` compares on the
  BASE subtag via `getBaseLanguage`. Empty on either side ⇒ neutral.

Discovery membership is stricter than chosen-content presentation. Every lane
inside For You — including candidates from followed authors and subscribed-list
members — plus Videos, Media, Explore and their popular fallbacks applies the SQL
language predicate before spending candidate caps. Trust can exempt a followed
author from discovery-quality gates, not from readability in a recommendation.
The standalone Following/List timelines and profile pages do not hide a post
merely because its language differs: there the reader chose the destination.
They still receive corrected language and rendition metadata so translation and
presentation behave correctly.

The language filter describes the post text, not speech or text embedded inside
video frames. Mention does not transcribe audio or OCR video as part of feed
selection.

For You and Explore also exclude a standalone decimal-digit text body from
recommendations when it has no reply/thread/quote/boost context, links, media,
poll, article or other structured content. This is a narrowly calibrated rule,
not a minimum text length. It changes neither import admission nor Following,
profiles or search; discovery sources remain enabled.

### Following ordering

`feedSettings.following.sort` persists `chronological` (the default) or
`relevance`. Both use the same followed accounts, subscribed lists and community
memberships; relevance adds ordering, not discovery or a popular fallback.
`sort` is a per-request override only for the Following descriptor. Following
Direct always remains chronological. The existing feed settings screen owns
the preference, and successful saves invalidate only that viewer's relevant
cached feeds.

Following (including Direct and relevance), Mutuals, List and Saved honor an
explicit sensitive-content preference while retaining privacy/ACL checks.
Hashtag, Topic, Trend and Lane keep their SFW/content-warning discovery policy;
the existing Author/profile path is unchanged by this adjustment.

### Ranked pagination sessions

Ranked presets opt into opaque `fs1:` continuations when Redis is available.
Session state stores candidate IDs, scores, source cursors and delivery history,
never post bodies. It is bound to the viewer, definition, selection settings and
page size. Each page reloads pending posts and reapplies current filters and
hydration privacy checks. Recency and the initial seen set are pinned; live
content, safety and newly gathered engagement can still change a retried page.

Sessions expire 30 minutes after creation and scan at most 5,000 distinct IDs.
Redis atomically retains the latest three immutable continuation snapshots per
session, so deep scrolling cannot accumulate quadratic historical state. Older
snapshots, missing Redis state, incompatible bindings and exhausted budgets
return HTTP 410 with `error.code = FEED_CURSOR_EXPIRED`. The client replaces the
feed with page one once, scoped to the current viewer and descriptor; a failed
restart does not create an automatic retry loop.

Source progress is independent of what was selected or filtered. Bounded scans
can return an empty page with a continuation. A failed source remains resumable,
and overlapping source windows do not imply exhaustion. Page one falls back to
stateless pagination when Redis is unavailable. Existing popular fallback
cursors remain valid; incompatible old personalized score cursors restart
through the same typed 410 contract after the scoring change.

## Feed Interstitials (Recommendation Cards)

Suggested users / custom feeds / starter packs spliced between post slices —
a horizontal carousel of cards on every screen size (Bloom `Carousel`: swiped
on touch, arrows beside the title on wide screens). People are vertical tiles
(`SuggestedProfileCard`: avatar, name, bio, Follow), not list rows
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
  `PostUser`) + followerCount and the other ranking-side account facts in
  Redis (key `usersummary:v7:<id>`, 10m TTL); `invalidate()` evicts on
  federated-actor re-resolve and on Oxy's `oxy:user:invalidate`. Those facts are
  RANKING-side (`CachedUserSummary`) and deliberately never ship on the
  `PostUser` DTO. In front of Redis each task keeps a bounded (5,000 entries)
  15-second copy of what Redis returned; `invalidate()` clears it, and the
  invalidation subscriber runs on every task, so an Oxy identity change clears
  it everywhere.
- Stateless ranked pages thread-slice only the top `2 * limit + 1` candidates
  (`sliceTopWindow` in `FeedEngine.ts`), doubling the window only when it folds
  into too few slices to fill the page and say whether another follows. Slicing
  reads every candidate's thread children and parents, and a slice depends only
  on the candidates above it, so the page is the same as slicing the whole pool.
  Session pages slice their bounded pending pool before joint membership
  selection so deferred candidates remain available for later pages.
- For You candidate shells carry the `posts` row they were assembled from;
  `hydrateSlices` completes the page's shells from those rows
  (`completeShellRecords`), reading only the child tables instead of selecting
  the page's posts a second time.
- A post record is one wave of round trips: `loadPostRecords` reads `posts` and
  every child table (the variant tables through a subquery) at once. Reply
  parents, the web shell's `/p/:id` post and its SEO replies come through the
  viewer-agnostic post-record cache (`services/postDetailCache.ts`) that
  `/feed/item/:id` already used.
- View counts: `services/feedViewCounter.ts` (Redis SET NX EX
  `viewseen:<postId>:<viewerId>`). Frontend reports impressions via
  `utils/feedTelemetry.ts`.
- Instant post-detail: memory-mode feeds seed the shared post cache
  (`postsStore.cachePosts`) in `useFeedState`; `app/(app)/p/[id].tsx` paints
  from cache + background-revalidates (`revalidatePostById`).

Hydration loads viewer languages, author settings, privacy lists and the follow
graph concurrently, then resolves channel authority after those inputs settle.
Privacy failures still reject hydration. Authors and declared mentions share one
identity batch; unresolved mentions stay in the request-local map so each post or
language variant cannot retry the same failed identity. They never enter the
shared identity cache, so the next request can retry.

The regression harness uses real PostgreSQL rows and a 40 ms simulated identity
service round trip. Run from `packages/backend` with `TEST_DATABASE_URL` configured:

```bash
bun run test src/__tests__/services/postHydrationLatency.test.ts --reporter=verbose --disableConsoleIntercept
```

On a 20-post page with distinct authors and mentions, the measured cold hydration
latencies before/after this change were 124/82 ms (anonymous), 209/88 ms
(authenticated), and 87/46 ms (preloaded feed context). Identity batches fell
from 2 to 1, 3 to 2, and 2 to 1 respectively. Warm pages made no Oxy user-summary calls.
These are controlled local measurements, not production latency guarantees;
the tests enforce batching and concurrency rather than wall-clock thresholds.

The production web export was also exercised in Chromium against a local MTN
controller and migrated database, with simulated Oxy identities, at 1440 px and
390 px widths. Cold app first-row times were 1260/1211 ms; reloads were
1026/1011 ms. Both layouts fetched and rendered the next page without script
errors. This verifies the changed backend's browser integration, not native-device
or production-network performance.

## Reader languages from Oxy

Authenticated feed requests read the viewer's ordered `languages` through the
session-scoped SDK `users.me()` call. Oxy's public `/users/by-ids` projection
omits this preference, so the shared author-summary cache cannot supply it.
The owner ID must match the feed viewer, and the private response is not stored
in that public cache. Feed loading, custom feeds and the new-posts check use
this same reader-language loader.

All account languages participate in discovery eligibility (any base-language
overlap). The three-language cap applies only to request-header/query fallbacks,
not the Oxy account list. If the owner read is unavailable, the request languages
remain the fallback. Following sources intentionally preserve posts from accounts
the reader follows, regardless of language.
