# Feed quality audit — 21 October 2026

Status: implementation and investigation in progress. The code observations below
were verified against `origin/main` at `2bfaf0cd6`. They are not measurements of
production impact. Production reads and review labels must be recorded separately;
no subjective import filter or historical-content deletion is enabled by this work.

## Product contract agreed with the owner

Exploration, import and recommendation are separate decisions:

- Continue discovering and importing worthwhile posts and accounts from other
  Fediverse servers, including small, new and not-yet-followed accounts.
- Import eligibility is not recommendation eligibility. Preserve followed
  authors, followed-community deliveries, repost originals, quoted posts,
  conversation ancestors and explicitly requested content when permitted by the
  existing protocol and access rules.
- A short post, joke, unfamiliar author, missing engagement or zero local followers
  is not sufficient evidence to reject an import. Whether it belongs in For You
  or Explore is a separate, contextual judgement.
- Following and explicit destinations must honor the user's subscriptions and the
  destination's contract. They must not inherit an unrelated discovery quality
  threshold.
- Present concrete examples to the owner before turning subjective quality labels
  into import exclusions. Preserve the owner's disagreements as evaluation cases.
- Any historical cleanup is a review-only report. No deletion, hiding or actor-wide
  suppression follows automatically from a low recommendation-quality judgement.

## Confirmed ingestion paths and evidence limits

| Path | Existing behavior | Implication |
| --- | --- | --- |
| Inbox `Create` | `inbox.service.ts` admits followed authors, followed relaying communities, objects addressing local users, and local-community submissions; protocol, ownership, content and ban checks still apply. | Subscription and conversation imports already have reasons independent of recommendation quality. |
| Followed actor polling | `FederationJobScheduler.syncFollowedActorsPosts` refreshes accepted-follow actors' outboxes. | Protect this path from subjective discovery exclusions. |
| Recent outbox backfill | `findOutboxBackfillCandidates` selects linked actors with outboxes and pending, failed or changed-outbox state. No follow-count predicate. Scheduler advances 10 actors, 20 candidates per actor per run, to a 100-candidate cap per outbox. | This intentionally supplies discovery beyond local follows. The absence of a follow alone is not a defect. |
| Profile request | `federatedProfileSync` can trigger a bounded asynchronous remote-profile fetch and outbox import with cooldown. | Opening a profile during an audit can change available inventory. |
| Boost, quote, reply ancestor | `outbox.service.ts` resolves required objects through `ensureFederatedNote`, with identity verification, fetch guards and depth bounds. | Keep dependency completeness separate from discovery eligibility. |
| Shared content builder | `buildFederatedNoteContent` rejects unrenderable empty content and reviewed bridge-flattened reposts. It emits aggregate decisions by ingest path. | Existing structural rejection rules are not a calibrated subjective-quality filter. |

`buildFederatedNoteProvenance` requires the object's ActivityPub id and author URI
and preserves relationship/source fields. This is **identity provenance**, not
historical evidence of why the particular object was first imported. Outbox
progress counters are actor aggregates; content-decision metrics distinguish
paths but do not identify each stored post's trigger. Current follow state cannot
prove the historical state at import time.

Consequently a post can be labelled “import reason unknown” even when its actor,
original URL and conversation links are known. Do not infer “unnecessary import”
from “no local followers now”. The new private ledger described below records causal evidence for future
imports; populating old rows with a fabricated reason would invalidate the audit.

## Initial production sample

The coordinating audit sampled the connected account, verified as `@nate` by
`whoami`, around 20:30 UTC on 21 October 2026. These are ten sequential pages per
feed with requested `limit: 20`, captured through the deployed MCP text formatter.
The following figures count flattened displayed posts, not canonical ranked slices.

| Surface | Flat posts | Unique post IDs | Authors | Largest author counts |
| --- | ---: | ---: | ---: | --- |
| Following | 336 | 335 | 63 | The Verge 50; Max Leibman 30; Wired 29; Elon Musk 26 |
| Explore | 217 | 217 | 152 | Oxy 12; Clarity 10; Mashed 10; Mention 8 |
| For You | 203 | 203 | 89 | The Verge 26; Wired 18; Defector 16; Oxy 10; Dawn 8 |

For You page nine contained 20 posts from only three authors: Defector 12, Dawn 7
and Hindustan 1, with no replies identified in the capture. This is a concrete
recommendation-diversity problem to trace in candidate selection and ranking; it
is **not evidence that those publications should not have been imported**. An
aggregate count of 89 authors hides that severe concentration on an individual page.

The single repeated Following ID may be conversation context; classify it using
canonical slices before calling it a pagination duplication defect. Counts over
20 flat posts are likewise not evidence of a page-limit violation. Following's
author distribution should reflect subscriptions and posting activity; it is not
subject to the same diversity objective as For You.

Mean MCP elapsed time was approximately 2.4 seconds, including connector overhead,
not backend handler latency. Backend ECS revisions moved from 675 to 676 and MCP
from 389 to 390 during the audit. Backend revision 676 was verified against ECR
digest `sha256:93ac0267eb0a35d7e90fee1dd0eefa26b7933c00600fcf499a21e2049ffc119f`,
tagged `deployed-2bfaf0cd6c8eadad13e4fcb77a23248caa0701a9`, pushed at 20:25:32 UTC;
revision 675 used `c4ce21a`. MCP revision-to-commit attribution remains separate.
These pages must not be treated as a stable-build benchmark or a matched algorithm
comparison. They are one session, not the planned three-session coverage.

A second traversal at 20:51–20:52 UTC used the same production backend revision
676, not the new implementation. Ten For You pages yielded 209 flattened/unique
posts and 112 authors, with no IDs repeated from the first traversal while served
state remained active. Per-page author counts were 19/16/20/18/14/14/16/11/5/8;
the cursor score reached zero on page seven. Page nine had 20 posts from five
authors (The Verge 7, Elon Musk 7, DogeDesigner 3, Qasim 2, Rihard 1), without reply
context. This repeats the deep-page concentration finding, without establishing
that zero scores alone caused it. Explore returned 219 unique posts from 152
authors, 208 overlapping the first 217-post traversal and 11 new to the sample;
there were no within-traversal repeats. Explore's persistent refreshed ranking and
For You's served-state behavior are distinct contracts, not automatically a
duplicate defect. This is not a before/after quality comparison.

The third traversal at 20:59:46–21:00:09 UTC, still on the old production build,
returned 209 unique For You posts from 95 authors, with no IDs repeated from
either prior traversal. Cursor score was zero from page four; per-page author
counts were 15/15/17/18/13/10/8/13/8/8. Explore returned 218 unique posts from 165
authors, overlapping 160 IDs with traversal one and 169 with traversal two (49
new to the second sample), with no within-traversal repeats. This completes three
For You/Explore traversals; Following and Videos each have one traversal, with
the other surfaces covered only as explicitly recorded. Shared served state and
live refresh changes prevent independent before/after conclusions.

### Confirmed source timeouts and additional bounded captures

The anonymous canonical API retry around 20:43 UTC returned 40 PHP hashtag posts
from 31 authors over two pages of 20, taking 1.530 and 15.009 seconds; the second
response reported `hasMore: false`. An earlier PHP response was empty after
15.492 seconds. `topic|technology` was empty after 15.493 seconds. These responses
do not establish inventory exhaustion: CloudWatch `/oxy/ecs` recorded
`[FeedEngine] Source failed; skipping` for module `keywords` at 20:38:31.119 UTC and
module `topic` at 20:43:36.804 UTC, with PostgreSQL error `57014`,
`canceling statement due to statement timeout`. Treat those failed windows as
unavailable, preserving a retry, rather than a successful terminal page.

The hashtag query wrapped the indexed `hashtags && text[]` predicate in
`coalesce(..., false)`. The bounded code fix removes that wrapper: SQL `WHERE`
already rejects null, including a null OR a nonmatching branch, while a matching
body branch still succeeds. A bare overlap permits the existing hashtag GIN index
to be considered. The topic helper now unions indexed matching IDs from topic refs
and the classification array, then applies the caller's unchanged visibility,
ordering and cursor filters. Both encodings, duplicate membership, null arrays,
absence, publication status and chronological pagination are covered by database
tests. These changes do not change import policy.

A production read-only plan audit on ECS revision 676, task
`598beba2b9f8450f812555ad4ced9088` (exit 0), confirmed the wrapped hashtag predicate
walked `post_public_chrono_v1`; the direct overlap used a bitmap scan on
`posts_hashtags_gin` (845 matching rows, 61 returned, execution 12.282 ms,
314 shared hits/546 reads). The original topic predicate likewise walked the
chronological index with a correlated topic-reference subplan. The union
alternative used `posts_classification_topics_gin`, topic refs and primary-key
lookup; `technology` had zero matches in that snapshot and executed in 9.605 ms
(two shared hits/43 reads). Original query plans used EXPLAIN only; the optimized
alternatives used EXPLAIN ANALYZE. Earlier actual timeouts are established by the
logs, not by a synthetic old-query timing. These are isolated SELECT timings,
not complete API response timings or a deployed before/after benchmark.

Further canonical profile reads for `@nate` returned 23/22/20 flattened posts,
20 slices per page, 65 unique IDs spanning 20 October to 2 July; media returned
three posts then ended, and replies returned 20 then three. No repeated IDs were
observed. These contextual counts are not page-limit defects. A later anonymous
Trending sample returned 60 unique posts from 58 authors over three pages,
0.818–0.831 seconds per page. These bounded observations are not load benchmarks.

## Owner calibration: concrete examples

These labels concern recommendation, not import or historical deletion. The owner
asked for shorter questions and updates during this audit.

| Public example | Owner assessment | Import decision |
| --- | --- | --- |
| [Standalone “3”](https://mention.earth/p/01a15cbe-daae-72e7-a9e4-f213850a9066) | Do not recommend, even when following its author. Chronological Following delivery remains a separate behavior. | No import rejection authorized. |
| [“Good morning or whenever”](https://mention.earth/p/01a15f2a-a903-7d83-8402-d5dbc2986d8b) | May recommend in For You when following the author; not from a stranger. | No import rejection authorized. |
| [PHP warning control](https://mention.earth/p/01a15fc2-1598-75cb-8828-b7cb97f7478b) | Uncertain; owner suggested following may matter. No approval or rejection established. | No import rejection authorized. |
| [Personal bicycle diary](https://mention.earth/p/01a15ed9-d134-7ed7-ba4a-d5f0e9843a75): wondering whether to ride in the drizzle | Do not recommend when the viewer does not follow the author. This is the owner's contextual assessment of this example. | Following delivery and import unchanged. No author-wide or short-post exclusion authorized. |

The first three public items were inspected with no attached media, original, quote or parent.
These concrete judgements do not establish a universal threshold. A possible rule
that relevant programming/security information may be recommended from unknown
authors is the audit team's proposal, **not an owner-approved label**.

A production read-only PostgreSQL audit on ECS revision 676 (task
`df20d0dc34944001a500baa0571bb12a`, exit 0) checked the live schema and a last-three-day
public/published window: 13,719 posts; 13,715 had baseline version 11 with pending
classification and four had no version; 4,902 had quality score zero, and 9,666 had
zero likes, boosts and comments. These are stored baseline values, not owner quality
labels. Stage B was disabled by default, with no task override observed.

The standalone “3” had quality 0/spam 0.3; the greeting quality 0.5/spam 0;
the PHP warning quality 0.7/spam 0 and two boosts. All three had a stored post
reference protecting context. No accepted outbound protocol-follow row was found
for these samples, which does not prove absence of follows in Oxy's authoritative
graph. Sampled Defector/Dawn items from For You page nine had quality 0.64/spam
0.45, no measured engagement, no protocol follows and no references; their original
import cause remained unknown. None of these observations authorizes cleanup.

Videos was also paginated for eight pages: 152 posts without repeated IDs, ending
with 12 posts on page eight. That traversal followed the For You reads and shared
served-state effects, so it was not an independent session.

Further direct production API traversal was **anonymous**, with effective languages
unspecified, and must not be presented as @nate personalization evidence. The
scripts sent unsupported `languages=en,es` (or a combined `lang=en,es`); the
controller supports a single valid `lang` and the `Accept-Language` header. Thus
these captures do not establish English/Spanish-constrained results:

| Surface | Bounded traversal | Diversity/repetition | Observed request times |
| --- | --- | --- | --- |
| Trending | Four pages: 20/20/20/7, final `hasMore: false` | 67 unique ids, 63 authors; no repeats. Top counts: n@bgme.me 3, Max Leibman 2, glyph 2. | 0.674–0.912 seconds |
| Media | Ten pages of 20 | 200 unique ids, 170 authors; no repeats. Top counts: David Revoy 10, Tutanota 5, Natasha Jay 5. | 0.833–1.031 seconds |
| `hashtag|php` | One empty final page | No item-level quality conclusion possible. | 15.492 seconds, one observation |

The empty PHP-tag result and its timing warrant tracing the query but do not
establish a persistent performance defect or absence of PHP content. These samples
are bounded traversals, not exhaustive coverage or matched latency benchmarks.

Additional @nate reads at 20:42 UTC found no own lists, eight saved posts on the
first saved page, and 23 flattened posts on the first own-profile page with a valid
continuation cursor. No private saved bodies are included here. These bounded
observations establish inventory for coverage, not defects.

The existing `scripts/fixtures/feedQualityLabels.ts` seeds five **whole actors** as
`junk`, including legitimate German-language authors and David Revoy's webcomic
for language/interest mismatch. That fixture conflates viewer relevance with
intrinsic content quality and is **not trustworthy universal ground truth or an
import-eligibility classifier**. Its scores cannot justify rejection, historical
cleanup or actor suppression. The new per-post owner judgements above remain
separate; this change adds an explicit warning without rewriting old labels into
unreviewed new ones.

## Durable provenance implementation

Migration 0090 creates two private evidence tables: one immutable initial cause
per post and at most eleven distinct observed reason rows per post. Both cascade
with post removal. The posts foreign key is added `NOT VALID` then validated in a
separate statement; no historical post scan or cause backfill is performed.

The post-insert transaction writes the initial cause for instrumented ActivityPub
imports. Inbox follow/mention/community, discovery backfill, followed outbox,
requested profile, inbox Announce, boost-original, quoted-post and reply-ancestor
paths carry explicit reasons. Generic unlabelled outbox calls record
`unknown_outbox`, which is protected. Deduplicated observations append reasons
without replacing the first cause; legacy posts first observed now retain a NULL
initial cause. Native/remote post insertion also records reply/quote/boost
necessity on imported targets within the relationship transaction.

Evidence records no requesting user id and is not included in public post DTOs or
metric labels. No feed read query joins these tables. Source identity remains the
existing ActivityPub provenance; this ledger adds causal evidence rather than
replacing it. AT Protocol and other uninstrumented connector histories remain
unknown and protected.

`reportFederationImportReview.ts` is SELECT-only inside a repeatable-read,
read-only transaction, bounded to 500 public federated rows and a 15-second query
timeout. It reports known causes, references, protocol follows, activity-notification
subscriptions to any accepted author, engagement (including
positive remote likes/boosts/comments counters without local interaction rows), saves,
views and conversation/community context without post bodies or private account
identities. The `discoveryOnlyWithoutKnownNeed` flag is a triage group, **never a
deletion decision**. All rows retain `authoritative_follow_graph_unverified` until
that separate source has been checked; legacy/unknown origin is explicitly
protected. There is no write switch, delete code or subjective-quality cutoff.

Example local read-only invocation, after applying the migration through the normal
deployment workflow:

```sh
FEDERATION_REVIEW_LIMIT=100 bun packages/backend/src/scripts/reportFederationImportReview.ts
```

The script requires the configured database connection but never prints its URL.
Use `FEDERATION_REVIEW_AFTER_ID` to continue its bounded id-ordered scan. Its report
must remain a private review artifact when linked with private graph evidence.

## Audit tooling change

Previously MCP feed tools returned only condensed text. That formatter ignored
`metadata.createdAt` and omitted the canonical slice structure and reason fields.
This made freshness, contextual-post counts and inclusion analysis incomplete.

The updated tools preserve the complete authorized feed response as
`structuredContent`, alongside readable text. Descriptor feeds expose the backend
`data` object unchanged as JSON values, not raw HTTP bytes. Existing dates,
slices, reasons, pagination and metadata survive. No unhydrated private database
fields or invented import reasons are added.

`get-feed` accepts shared-contract descriptors, defaulting to Explore. Personalized
feeds require a token. Saved and list feeds remain on dedicated tools with their
original `social.posts.read` and `social.lists.read` capabilities. All other reads
retain `social.read` and exact tool-to-route binding. The controller at the audited
commit does not support request sorting, so MCP does not pretend to offer it.

Deployment and connector schema refresh are necessary before these new fields and
parameters exist in production. The old connector's text-only results cannot be
retroactively treated as canonical API captures. Metadata reasons describe feed
presentation/inclusion where supplied; they do not prove import causality.

## Capture and review method

For each page record timestamp, deployed version, authenticated account, tool or
endpoint, descriptor, requested limit, opaque cursor, returned cursor, latency,
errors and whether the response is complete JSON or condensed text. Keep complete
private captures outside git and never store tokens. Public examples may be linked
in the report; private content must not be quoted into public artifacts.

Use populated `slices` to count ranked blocks and `items` to inspect the flattened
posts, identifying contextual parents/continuations before classifying duplicates
or page overflows. Twenty ranked blocks may legitimately contain more than twenty
posts. A bare boost needs its hydrated original to judge content. Inspect media,
link cards and thread context before assessing a short or empty text body.

Paginate principal feeds until exhaustion or at least ten pages when inventory
permits, across three separated sessions. Record first-page, refresh, cross-feed and
continuation repetition separately. Reads may mark posts served or trigger imports;
repeated live reads are not paired algorithm experiments. Before/after ranking
comparisons need the same captured inventory, initial viewer state and clock.

For each proposed low-quality example, record:

| Field | Values/evidence |
| --- | --- |
| Publication | Canonical link, post id, author, date, body, media and relevant thread context |
| Observed surface | Actual descriptor, page and position; do not infer from text alone |
| Import basis | Proven reason and source, or `unknown`; dependencies and subscriptions checked separately |
| Recommendation | `recommend`, `do not recommend`, or `uncertain`, independently per surface |
| Content assessment | `valuable`, `dispensable`, or `depends`, with concrete rationale |
| Owner feedback | Exact assessment and disagreement; `pending` until reviewed |
| Proposed import action | `preserve`, `review`, or `unknown`; never automatic deletion |

Measure freshness, author/domain concentration, new-author coverage, languages,
repeat originals/URLs, unavailable media, candidate-source contributions and
premature exhaustion. Separate deficits in inventory from ranking, hydration and
client presentation. A discovery improvement must not collapse the arrival of
new authors and sources.

## Validation and remaining evidence

A supported-language smoke check at 20:57 UTC sent `?lang=en` and
`Accept-Language: en,es;q=0.9`. Explore returned 26 items/20 slices in 0.903 seconds,
Media 20 items/zero slices in 0.820 seconds, and Trending 20 items/20 slices in
0.990 seconds, all successful with `hasMore: true`. The DTO had no top-level
language evidence, so no language-match rate is inferred. Authenticated MCP reads
used account-derived preferences separately.

The audit also reproduced a false quality diagnostic: For You candidate shells
omit normalized text/media, so existing `lowEffortGate` and `minLength` predicates
mistook unassembled evidence for empty content, including shadow measurements.
The correction supplies a separate gate-only view of persisted renditions, shared
and rendition-specific media, and attachments. Scalar context (such as polls)
is retained. Original shells remain deferred for ranking and final hydration;
no network hydration or new classifier is introduced.

Content-dependent custom pool filters use the same mechanism. Database tests
verify exactly four SELECT batches for the ordinary text/media projection, five
when cited sources are also requested, and six when sources plus rendition alt
text are required, independent of duplicated input IDs or batch size. Empty input
does no queries. Engine tests verify no evidence reads for absent/disabled content
filters, viewer-disabled gates or trusted sources with only discovery gates.
Text, shared/rendition-only media and scalar polls survive the low-effort check;
genuinely empty content still fails that existing predicate. A min-length filter
continues to mean text length; it is not silently changed into a media exception.
No gate defaults, enforcement rollout, import eligibility or cleanup policy change.

Independent implementation review checked that bare-number eligibility is invoked
only for For You/Explore recommendations, including fallback, and not ingestion,
profiles or Following. Database shells are assembled before a numeric-caption
decision; shared and author-rendition media/article/context must be preserved.
Greeting and bicycle examples remain contextual labels rather than generic rules.

Ranked continuation state stores IDs, scores and source progress, never post
bodies. Viewer/definition/filter binding, current-record reload and hydration ACL
checks remain separate protections. Sessions expire after 30 minutes or their
5,000 scanned-ID budget; the Redis Lua operation atomically retains only three
snapshots per session. The backend implementer additionally exercised the actual
Lua against local Redis with 20 writes, confirming last-three retention, older-key
deletion and positive TTL. Unit tests using a rewritten mock alone cannot prove
Lua behavior. Immutable progress does not promise identical replay content when
live records or engagement change. Source windows use a pinned clock and bounded
candidate counts; failed queries must not become successful terminal pages.

MCP tests cover canonical response preservation, empty continuation pages,
descriptor routing, invalid and protected descriptors, anonymous personalized
reads, scope rejection, exact capability headers and upstream refusals. Existing
MCP integration and catalog tests remain required.

Outstanding production evidence: exact capture-to-revision mapping and MCP commit attribution, canonical multi-page captures for every available
surface, quality examples reviewed by the owner, import-trigger attribution where
available, comparative ranking samples and cross-platform client behavior. Empty
account-specific surfaces need fixture coverage and must not be reported as
production defects without eligible inventory. No claim of exhaustive completion
or improved production feed quality follows from code tests alone.

### Integrated client and contract validation

The integration branch was built from main `d32a89e15` with both migrations
(`0090` import provenance and `0091` Following ordering) applied by the disposable
PostgreSQL test harness. Shared contracts/backend/MCP builds, frontend TypeScript,
the production Expo web export, e2e TypeScript, migration lock checks, i18n and
feed hot-path validators passed. Frontend lint returned zero errors and 229
warnings; changed TypeScript/JSON files passed Biome checks.

- 198 shared-types tests and 161 MCP tests passed.
- The final combined backend gate passed 347 Vitest tests across 19 files and
  138 Bun tests across nine files, using isolated migrated PostgreSQL databases.
  Coverage includes ranking/session progression, privacy, Following/Saved intent,
  gate evidence, import provenance, inbox/outbox validation and settings storage.
- After merging main `63c64b008` and the bell controls, the full frontend
  coverage run passed 3,251 tests across 401 suites. Regressions verify concurrent feed/profile refresh,
  one-shot recovery for simultaneous expired-cursor callbacks, poll-budget reset
  when switching remote profiles, and rule subscription cleanup. The strict
  coverage policy passed with 308 behavioral files and 303 measured pins,
  including the two new modules; no baseline or threshold was lowered. The initial 185
  targeted frontend tests cover dwell/visibility/refresh, viewer isolation, saved
  settings invalidation, Following persistence/rollback, request deduplication and
  one-shot expired-cursor recovery in memory and SQLite.
- A real Chromium candidate smoke passed four flows: anonymous cold boot with
  feed rows, `@nate` profile default/tab navigation, a profile reached from another
  profile, and Home → Explore → post → back without a document recovery reload.
  Candidate assets were served locally at the production app origin using the
  repository's existing Playwright fixture; public API reads used production.
  No authentication bypass, production settings write or post mutation was used.

The browser run validates the candidate client against the currently deployed
backend. It cannot establish the new backend's production quality or performance.
Authenticated settings UI and native app background behavior have automated
regression coverage, but were not exercised on a logged-in browser or a physical
iOS/Android device during this integration pass.


## Owner correction: profile bell means explicit interest

The owner explicitly identified the profile notification bell as an author-interest
signal. Backend commit `f1c3a425f` implements the existing viewer-owned
`post_subscriptions` relationship as a source of
bounded fresh candidates and an additional For You score multiplier; accepted
coauthors count, pending invitations do not. The initial limits are a 72-hour
candidate horizon, at most 2× score at publication, a 24-hour half-life for the extra
boost, and a neutral multiplier after 72 hours. These are implementation bounds,
not evidence of measured production improvement. Negative feedback, access rules,
recommendation eligibility and author diversity still apply. No Following chronology,
notification-delivery behavior, import admission or autonomous discovery policy changes.

Independent review checked viewer isolation in the subscription lookup and source
semijoin, a single bounded lookup for unresolved shell coauthors, both ranking paths,
and continuation binding to the current subscription set. The profile toggle refetches
status on account changes and fences stale asynchronous results. Successful toggles
and settings removals refresh only the originating viewer's For You cache. Settings
removals also recheck the authoritative SDK runtime after asynchronous query cancellation
and before dispatch, then use the supported abort signal if the account changes during
pending auth/transport work. Already accepted server writes cannot be undone by abort.
The focused frontend regression run passed 24 tests across four suites plus typecheck,
including paused cancellation → account switch → no unsubscribe dispatch, in-flight
abort/listener cleanup, failed writes without ranking invalidation, and same-profile
account switching.

The read-only import review also recognizes a bell on any accepted author as
`activity_subscription` preservation evidence. It reports only a boolean and reason,
not the subscriber identity, and excludes such posts from
`discoveryOnlyWithoutKnownNeed`. A real-database fixture checks accepted versus pending
coauthors, absence of a follow, preserved unknown-follow-graph protection, and no private
identity output. All 14 provenance/report tests pass. This is a diagnostic correction;
there is still no cleanup write mode or deletion decision.

Final pre-release integration also passed the complete backend Vitest coverage
run: 5,651 passed and four skipped tests across 461 passed and two skipped files,
with all configured coverage floors satisfied. The bell source/context/preset
Bun/PostgreSQL selection passed 71 tests across six files; the final read-only
provenance report change passed its 14 database regressions separately.

The complete Bun suite then passed 2,502 tests across 225 files after adding the
new source to both strict registry inventories. The bell source database fixture
also includes a newer reply and confirms that only eligible root posts are
selected. Existing inventory equality checks and coverage thresholds remain intact.
