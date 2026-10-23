# Quotes and social discovery audit — 23 October 2026

Status: diagnosis and implementation review in progress. This audit extends the
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
| Separate protocol fidelity | `buildPostRecord` omits quote references, and the supplied post's signed creation record confirms that shape. MTN replay cannot reconstruct a quote from that record alone. | Assess the shared protocol's owned schema before extending it. Do not invent an app-local field or guess a historical target from prose. This is not evidence of a local database relation loss. |

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
