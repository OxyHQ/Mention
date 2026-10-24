# Quotes and social discovery audit — 23 October 2026

Status: implementation reviewed; final CI and deployed acceptance pending. This audit extends the
[earlier feed-quality work](../feed-quality-2026-10-21/README.md); it does not replace
its contextual owner labels or conflate recommendation with import eligibility.
Code findings below were checked against `origin/main` at
`5b9b48f43c2b7bc2699a0f7ca4fd019f203cc941`. Initial GitHub connectivity failed; a
subsequent successful team fetch supplied this reference before the findings were
finalized. Implementation and release results must be attributed separately.

## Concrete reported quote

The owner supplied [this public quote](https://mention.earth/p/01a162ff-d59a-7c4f-9788-94e623c4da88),
reported without its embedded subject in the feed and detail. The authenticated
MCP feed-item capture returned `quotedPost: null`, `originalPost: null` and
`boost: null`. That response alone cannot distinguish missing storage, omitted
hydration and a valid access decision.

A bounded [production read-only diagnostic](./quote-relation-evidence.json) at
**2026-10-23 08:05:28 UTC** established:

- The outer row is a local, public, published `quote`; its `quote_of` is intact.
- The referenced [video](https://mention.earth/p/01a162f2-fc18-771d-a10d-4b2ac5a66a53)
  exists and is public/published. The quote has no parent, boost or assigned lane.
- The local outer post has no federation-import ledger, which is expected and
  does not mean a failed import or unknown discovery decision.
- Its verified canonical creation record contains `text`, `langs`, `variants`
  and `createdAt`, but no quote reference or embed. This is a separate protocol
  fidelity limitation; it does not mean the local relation was lost.

Task `2cf1e5b79aec4f20ae3fcf71d67b800f` exited zero on revision 700, image SHA
`5b9b48f43…`, while the service was transitioning from 699 to 700. Both connection
and transaction enforced READ ONLY; seven SELECTs used a 15-second statement
limit and exact IDs. No production content or relations were repaired. A subsequent public target
feed-item read succeeded as the same viewer. The actual detail path explains the
symptom: frontend `feedService.getPostById` and MCP `get-feed-item` request
`GET /feed/item/:id`, whose `transformPostsWithProfiles` hardcodes depth zero.
`GET /posts/:id` requests depth two but is only the frontend fallback when the
first request fails; a successful response missing quote context never reaches
that fallback. The feed and actual detail therefore share the depth-zero omission.

## Prioritized gap matrix

Priorities indicate user impact and the next bounded correction, not an assertion
that every possible path is broken. Code-observed defects need regression tests;
planned corrections are not counted as deployed behavior.

| Priority / area | Existing behavior and concrete gap | Required correction or proof |
| --- | --- | --- |
| P1: direct quote content | `PostHydrationService.collectPostsWithDepth` forces boost originals but treats quotes as optional depth-limited context. For You and Following request depth zero, so a quote can lose its subject despite intact storage. | Treat the direct quote relation as required rendering context within a bounded graph; preserve the ordinary access and safety decision for the subject. Prove feed, actual `/feed/item/:id` detail and alternative `/posts/:id` paths independently. |
| P1: boost of quote | The graph collects multiple levels, but `attachNestedContext` runs only for depth-zero results and nested originals are plain `HydratedPostSummary` objects. Fetching an inner quote is not sufficient to carry it into a boosted quote's DTO. | Test boost → quote → subject and quote → quote with bounded depth/cycle handling. Carry enough explicit nested context to render faithfully without an unbounded recursive payload. |
| P1: positive reactions | `networkEngagement.ts` selects rows from `likes` without `value = 1`, so a stored downvote becomes positive social proof. `getPostLikes` has the same missing predicate and can list a downvoter as a liker. | Require positive votes in both paths; regress positive, negative and changed-vote cases. A downvote must not explain or lift a recommendation. |
| P1: privacy of social evidence | Profile Likes is private by default (`privacy.showLikes`), but existing network aggregation and known-liker lookup do not consult that opt-in. Existing boost evidence also omits published/public constraints. | Establish one disclosure boundary for new recommendations/explanations; exclude private/nonpublished activities and blocked/muted actors. Do not infer permission from a target post being public. |
| P1: discovery through followed activity | For You gathers authored posts, lists, affinity, topics, region and global lanes. Its social-proof signal only scores candidates already present; `friendsEngaged` exists as a separate source. Followed likes/boosts therefore do not independently introduce a missing target into For You. | Add bounded eligible social candidates and truthful explanations if implementing this requested behavior. Keep chronological Following's explicit subscription boundary separate. |
| P2: distinct people versus activity count | `networkEngagement` deduplicates one person's like plus boost; `friendsEngaged` adds a grouped like count to individual boost rows and can count the same person twice. | Use a documented unit and distinct actors when presenting people-based social proof. Retain distinct chronological repost events in Following. |
| P2: source progress and recency | Existing `friendsEngaged` applies a lower activity-date bound, but its boost fetch has no deterministic order or upper `asOf` bound. Arbitrary limited results are not a stable ranked-session source. | Exercise actual source queries with advancing windows, seen exclusions, tied timestamps and activity arriving after session start. Bound work before hydration. |
| P2: quote intent after target deletion | `quote_of` uses `ON DELETE SET NULL`; `type: quote` survives. `excludeQuotes` checks only the relation, whereas `originalOnly` also checks the type. | Exclude a known quote after target deletion too. A missing subject must not silently turn it into an original post. |
| P2: recommendation explanation | Feed DTOs have reply and boost context, but no canonical carrier of the followed interaction that caused a social recommendation. `KnownLikersRow` is a separate detail-only request. | Supply a viewer-scoped, bounded explanation from verified evidence; avoid per-row follow/like requests, invented actors or misleading "liked" labels for boosts/replies. |
| Separate protocol fidelity | `buildPostRecord` omits quote references, and the supplied post's signed creation record confirms that shape. MTN replay cannot reconstruct a quote from that record alone. | The app-owned MTN payload lexicon has no quote field; compatibility requires coordinated lexicon, emitter, materializer and subject-resolution work. Do not invent a remote content address or guess a historical target from prose. This is not evidence of a local database relation loss. |

## Coverage and semantic boundaries

| Dimension | What already exists | What the current correction must preserve or verify |
| --- | --- | --- |
| Reply context | A post-level `replyContext` survives surfaces without slices; inaccessible parents lose author identity. Unresolved federated replies retain reply intent. Self-thread continuations are treated as threads. | No invented parent identity; no promotion of an isolated reply merely because it has social engagement. Root/parent context and quote context remain distinct. |
| Local quote creation | The frontend maps `quotedPostId` to `quoted_post_id`; the controller validates a public share target and stores `quoteOf`. | Quoting must keep comment ownership and target identity distinct; no re-authoring the target as the quoting account. |
| ActivityPub quotes | Inbox/outbox recognize modern and legacy quote fields, resolve dependencies, and withhold unresolved declared quotes as `incomplete`. | Preserve autonomous discovery and dependency import. A malformed/unresolved remote quote is different from the local intact-reference incident. |
| AT Protocol quotes | The connector resolves quoted references into `quoteOf` when possible. | Test the canonical hydration contract rather than adding renderer-specific protocol branches. |
| Boost delivery | Boosts carry the actor separately from the original; Following can legitimately show an original and multiple boosts as distinct chronological events. | Never call zero post-ID repeats "zero repeated content". Ranked recommendation dedup and chronological event delivery have different contracts. |
| Hidden/unavailable targets | Nested subjects pass the same graph access and safety decisions; existing boost unavailability distinguishes missing data from access-filtered data. | Do not disclose a hidden subject's author, body or ID through explanation/placeholder. A generic unavailable quote state must not bypass ACLs. |
| Negative intent | Existing ranked session bindings include negative author/topic/privacy context. | Social activity from a followed but muted/blocked actor cannot override explicit negative intent or target safety. Recheck stored session candidates against current eligibility. |
| Viewer isolation | Existing feed cache/binding separates viewers and request context. | No social explanations from another viewer after cache replay or account switch; anonymous responses contain no private followed-actor context. |
| Performance | Hydration batches a page; existing social counts are input-capped. | Measure bounded SQL queries and avoid N+1 identity/privacy calls. Empty follow graph and disabled social source should require no activity lookup. |
| Import quality | Provenance records new reasons while protecting legacy unknowns; reviewed examples are recommendation labels. | No new import rejection, deletion or broad popularity/follow-only admission rule follows from this social-feed repair. |

## Acceptance evidence still required

Tests should cover public local and federated quote subjects; a missing/deleted
subject; a private/blocked/safety-denied subject; direct feed and detail reads;
boosted quotes; bounded nested/cyclic relations; positive versus negative votes;
private and opted-in like histories; public versus unpublished boosts; one actor
liking and boosting; no follows; muted/blocked actors; and independent viewers.
Source tests must use the actual PostgreSQL query shape for pagination and
privacy boundaries, not only mocked candidate arrays. Frontend tests must verify
what is rendered and where the quote or activity label navigates.

Production verification is read-only. It may compare existing public posts and
account-scoped feeds, but must not create posts, reactions, follows or settings to
manufacture a sample. The raw detail cache already retains `quoteOf` and reruns viewer hydration on
each read. Anonymous feed caches contain hydrated DTOs: rollout must account for
old entries missing context (short TTL or explicit version cutover), without
mutating production cache contents for a prettier test. The exact production issue is a useful acceptance target,
not permission to rewrite its stored relation. Missing inventory for an edge case
must remain a stated coverage limitation. New release measurements will name the
actual serving revision and preserve feed, detail and browser evidence separately.


## Protocol assessment and independent review notes

`packages/shared-types/src/mtn/lexicons.ts` explicitly owns Mention's app payload;
Oxy owns the surrounding signed envelope with an opaque record. The current
`MentionPostRecord` schema has no quote reference. The emitter follows that
contract. `PostMaterializer.projectPost` creates a new replica as a text post,
while `refreshProjectedPost` preserves an existing row's quote relation and type.
The confirmed omission is therefore **new-replica/reconstruction fidelity, identified
but not fixed in the active rendering repair**. Existing signatures must not be
rewritten, and no remote content address may be fabricated to fill the gap.

The independent review of the initial frontend patch found the explanation kept
in viewer-scoped feed state rather than canonical post storage, with account-reset
and in-flight epoch fencing. Only the named target row receives it; a sampled
blocked actor suppresses the stale label. The quote cache keeps two relationship
hops and invalidates the prior local shape. This is code review, not a native
physical-device result. The local privacy hook covers blocked accounts; immediate
client-side mute/restriction suppression must not be claimed merely from that
blocked-actor test.

The initial backend review raised two additional checks. First, a social discovery
lane must use the canonical `isReply = false` predicate, not only a null local
parent: unresolved federated replies also have null parent IDs. Second, a SQL
`LIMIT` bounds returned candidates, not database work; a chronological post scan
with correlated activity predicates needs an execution-plan check for sparse
eligible activity. Freshly querying visible social labels proves disclosure
revocation, but does not by itself prove removal of an already-pending candidate's
serialized ranking uplift; the proposed correction and its explicit snapshot-score
boundary are described below.


## Bounded production baseline before this correction

The [sanitized seven-page capture](./feed-baseline-evidence.json) contains only
aggregate metrics and the owner's public example identifiers. Feed reads ran at
**08:22:08–08:23:16 UTC on 23 October 2026**, after ECS revision **700** was
verified steady at 2/2, mapped to SHA
`5b9b48f43c2b7bc2699a0f7ca4fd019f203cc941`. Fresh per-container digest enumeration
was unavailable; the immutable task-to-image mapping and service state were
verified separately.

| Surface as @nate | Pages | Logical positions | Flattened posts | Embedded quote subjects observed |
| --- | ---: | ---: | ---: | ---: |
| For You | 3 | 60 | 61 | 0 |
| Following | 3 | 59 | 65 | 0 |
| Owner's Posts | 1 | 20 | 22 | 2 |
| Total | 7 | 139 | 148 | 2 |

All seven pages had a continuation. No repeated focal ID was reported within
each sampled traversal. Flattened context is not an extra logical position.
Zero quotes in the For You/Following sample alone cannot establish omission:
the author page actually contained the supplied outer post with its correct
quoted target, while the successful feed-item read returned no quoted subject.
That paired observation plus the intact database relation isolates the route
hydration failure. The earlier item read at 08:00:47 and direct target read at
08:06:57 did not have an independently captured serving revision; do not assign
them revision 700 merely because the later feed capture was on that revision.

Reads can advance served history. This was a bounded observation, not a matched
inventory experiment, and involved no post, reaction, follow or settings writes.

## Independent review of the proposed correction

These are local implementation and regression-test findings, **not a deployment
claim**. The original gap matrix records the diagnosed baseline; production
acceptance must be appended after the actual release.

- Quote rendering uses an already-authorized graph, a path-local cycle guard and
  two required reference hops. A generic unavailable marker preserves quote
  intent without exposing the hidden subject's identity or reason. The actual
  `/feed/item/:id` route is covered rather than relying on `/posts/:id` alone.
- Social discovery starts from indexed eligible activity IDs, unions positive
  opted-in likes with public published boosts, then applies target eligibility
  and chronological pagination. There is no activity subquery limit that can
  falsely exhaust the source before filtering targets. Unresolved federated
  replies use canonical `isReply`, not a nullable local parent relation.
- Supply, ranking counts and fresh explanations share the recent activity
  window and eligible actor set. The eligible followed-actor cohort is capped at
  500; per-page social count/evidence lookups cover at most 200 targets and return
  at most three sampled actors per explanation. These bounds are not complete
  coverage of arbitrarily large follow graphs. A person liking and boosting counts once for
  people-based ranking. A boost-only explanation is distinguished from a like;
  Following keeps its original chronological event semantics.
- Pending candidates supplied only by social activity are revalidated on each
  continuation/replay. Revoked candidates release their dedup IDs so another
  lane may supply them later, while a separate retired count keeps the scan
  budget conservative. Candidates already supplied independently remain with
  their session snapshot score; labels reread current evidence. This does **not**
  promise immediate recalculation of every score after third-party consent or
  activity changes. The social evidence binding revision invalidates older
  For You and Popular with Friends sessions lacking that provenance.
- Viewer-specific explanations remain in feed state, outside canonical post
  storage. Successful mute changes notify only the originating viewer, and
  stale explanations disappear while a fresh read is pending. Independent
  review found and corrected a native race: an in-flight continuation could
  previously prevent refresh and stamp old evidence fresh. A forced rule reload
  now supersedes initial and continuation requests, so their late responses
  cannot append old labels or overwrite freshness/loading state.

The frontend owner reported 46 focused memory-feed/store tests and 38
service/hook/menu tests passing after the race correction. Three candidate
Chromium flows passed: quote commentary plus navigation to its embedded subject,
like explanation to the Likes dialog, and boost explanation to the Boosts dialog,
without also navigating the outer row or issuing per-row like lookups. These are
candidate-browser and local-state results, not a production browser or physical
native-device result. Full integration gates and deployed verification remain
separate acceptance steps.


The backend owner reported 109 focused Vitest tests passing across the engine,
session, real-database social evidence and two engagement-controller suites, plus
78 Bun tests across source/count/preset/reply-policy/isolation suites. The quote
suite passed 24 tests separately. These include exact pre-change session-binding
rejection, privacy opt-out and unlike revalidation, retention through a remaining
public boost, and optional explanation failure without losing readable content.
A local `EXPLAIN ANALYZE` fixture with 10,000 unrelated posts and no eligible
activity observed zero target-post scan loops. That demonstrates the intended
empty-cohort query shape locally; it is not a production latency measurement.

Independent code review found no remaining blocker in that scoped correction.
The final backend commits are `7acaae3d9` (bounded quote hydration), `802847cb1`
(social discovery/evidence) and `53a0dd11d` (anonymous quote-cache cutover).
The common `mtn:quote-v2` namespace preserves the existing Explore and Media
ranking-version suffixes; old anonymous DTOs cannot conceal the repaired quote
context. The owner reported 30 controller tests, backend typechecking and the
feed hot-path validator passing for the final backend work.

A subsequent 53-test database engagement-command run established a recency
limitation: changing an old downvote to a like advances `updatedAt` while keeping
`createdAt`. Recent social evidence currently uses the latter. For You's social
candidate lane also requires the target itself to be within 72 hours, so an old
relationship to an older target is outside that lane's candidate window. An
older target supplied independently can therefore lack a recent social label
when the vote changes later. This is a measured boundary, not a claim that
`createdAt` records the latest positive transition. No event history, index or
schema was fabricated or changed to mask that limitation.


A final client review also closed the accepted follow/unfollow boundary. Mention's
adapter wraps the public SDK button and composes its existing callbacks across
profile, hover, video, discovery and starter-pack surfaces. Single-user feed
invalidation follows the SDK's accepted callback; bulk changes inspect successful
result counts because the SDK's bulk-unfollow callback can also run after a
resolved all-failure result. No optimistic state or failed bulk result invalidates
the feed. A late response can invalidate only its captured viewer and cannot
invoke a stale consumer callback under the incoming account. Existing federated
synchronization is preserved; the adapter introduces no status lookup or SDK
internal mutation. The unresolved-remote actor control and non-account entity
subscriptions retain their separate existing paths.

The adapter owner reported 79 focused tests passing across FollowButton, profile
card identity and feed interstitial suites. Full frontend coverage is a separate
integration gate; this does not claim a production follow/unfollow action was
performed to verify the behavior.


## Resumed integration and production baseline — 24 October

The work resumed against main `2a604901ec94cbc8ea2421261dc357a9a7c00bb6`.
The [new authenticated capture](./feed-baseline-20261024.json) is separate from
23 October's baseline. Backend revision **712** was steady at 2/2, pending zero,
with the image digest recorded in the artifact. The actual feed-item detail
still omitted the supplied quote's subject while the author's Posts feed
included it. This is pre-release evidence, not a failed deployed correction.

| Surface as @nate | Pages | Logical positions | Flattened posts |
| --- | ---: | ---: | ---: |
| For You | 3 | 60 | 66 |
| Following | 3 | 58 | 63 |
| Popular with Friends | 3 | 60 | 61 |
| Owner's Posts | 1 | 20 | 22 |
| Total | 10 | 198 | 212 |

The traversals reported no repeated focal IDs within each feed and all pages
had continuations. Two quoted subjects were observed on the author page. These
are positions, not globally unique posts or a matched quality experiment. No
post, reaction, follow or settings writes were made; reads may advance served
history. The artifact's capture times and service attribution remain explicit.

An [anonymous production Chromium check](./browser-baseline-20261024.json) at
05:23:07 UTC rendered the outer commentary but no embedded subject. The actual
feed-item request returned 200 with a null quote; no JavaScript errors were
observed. This browser observation is separate from the authenticated MCP reads.

The integrated candidate incorporated current main's playback and Allo changes.
A renewed independent review found no blocker in quote context propagation,
exact-target activity labels, viewer isolation and accepted follow/mute
invalidation. Five real-database backend suites passed 35 tests, including the
24 quote/detail cases plus hydration/video and For You/Explore statement budgets.
The cold handler import is now outside the individual request test deadline;
assertions and the default request deadline were not weakened.

The integration owner reported 406 frontend suites and 3,251 tests passing on
this updated candidate. Coverage was 48.84% statements, 44.14% branches, 43.24%
functions and 49.63% lines; 307 per-file pins covered 312 domain files with no
lowered pins. The new pinned hook is `useFeedRankingStaleness`; FollowButton's
component tests do not make it a pinned domain module. Frontend types, backend/
shared/MCP/e2e types, frontend lint, workspace build and all non-security workspace
guards passed. Final CI, fresh browser evidence and deployed verification are
separate gates and are not implied by these local results.

The refreshed security audit detected newly reviewed upstream advisories.
Body-parser was updated compatibly to 2.4.0; Kaana SDK 3.2.1/contracts 8.0.1 remove
the old nested Zod 4.4.3. Shared builds, backend types and lockfile validation
passed; 13 actual SDK/JEV tests and 81 inference/classification/trends/translation
tests passed with those versions. The remaining Zod 3 dependency review and its
strict, expiring resolution guard are documented [separately](./zod3-review.md).
This does not claim those dependencies are patched or all trust-boundary risks
eliminated. No global Zod major override, production exploit probe or unrelated
first-party authority migration was used.
