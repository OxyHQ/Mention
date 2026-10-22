# Feed quality audit — 21 October 2026

Status: implementation and follow-up fixes merged and deployed; bounded production
verification is complete below. Remaining quality and import-evidence limits are explicit. The initial
code investigation used `origin/main` at `2bfaf0cd6`; the implementation merged as
`b1b7b0b64ac8494169ec783d60eca4d275cbe8df`. Pre-release tests are not measurements of
production impact. Production reads and review labels are recorded separately;
no new subjective import filter or historical-content deletion is enabled by this work.

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
| [Standalone “3”](https://mention.earth/p/01a15cbe-daae-72e7-a9e4-f213850a9066) | Do not recommend, even when following its author. Chronological Following delivery remains a separate behavior. | Recommendation-only label; insufficient import evidence. |
| [“Good morning or whenever”](https://mention.earth/p/01a15f2a-a903-7d83-8402-d5dbc2986d8b) | May recommend in For You when following the author; not from a stranger. | Recommendation-only label; insufficient import evidence. |
| [PHP warning control](https://mention.earth/p/01a15fc2-1598-75cb-8828-b7cb97f7478b) | Uncertain; owner suggested following may matter. No approval or rejection established. | Recommendation-only label; insufficient import evidence. |
| [Personal bicycle diary](https://mention.earth/p/01a15ed9-d134-7ed7-ba4a-d5f0e9843a75): wondering whether to ride in the drizzle | Do not recommend when the viewer does not follow the author. This is the owner's contextual assessment of this example. | Following delivery and import unchanged. This example does not establish an author-wide or short-post import rule. |
| [Three original cat drawings by an unfamiliar author](https://mention.earth/p/01a16088-8e69-75bc-809b-810a5a5ae51f) | “Sí, si me interesa el arte”: recommend when art matches the viewer's interests, including an author they do not follow. | Positive recommendation label; no general import-admission threshold established. |

The first three public items were inspected with no attached media, original, quote or parent.
These concrete judgements do not establish a universal threshold. A possible rule
that relevant programming/security information may be recommended from unknown
authors is the audit team's proposal, **not an owner-approved label**. The later
cat-drawing assessment is a confirmed positive example of interest-conditioned
discovery: following or popularity is not required for that recommendation. It
does not endorse every media post or establish a blanket art preference for every
viewer.

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
import cause remained unknown. None of these observations establishes sufficient evidence for cleanup.

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
0.990 seconds, all successful with `hasMore: true`. No language-match rate was calculated in this smoke check. Language metadata
belongs under `metadata.language` / `metadata.languages`, not a top-level field.
Later investigation found that delegated MCP cannot independently read owner
languages through `users.me`: effective owner preferences depend on a cache warmed
by the app. The MCP samples without an explicit request locale therefore do not
establish the viewer's intended languages or a language-match rate.

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

Outstanding production evidence: released backend/MCP/client attribution,
canonical multi-page captures for every available surface, further quality examples
reviewed by the owner, import-trigger attribution where available, comparative
ranking samples and cross-platform client behavior. The earlier backend revision
676 was attributed to `2bfaf0cd6`; that does not establish the new release's impact. Empty
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

The first queue entry was removed before merge when independent review reproduced
a bell-priority error for an accepted coauthor with explicit negative feedback.
The correction filters matched author IDs against stored negatives and the
existing authoritative privacy exclusions before supply, trust and scoring.
Ranked-session binding also includes canonical negative author/topic sets, so
changes invalidate frozen scores through the existing typed 410 recovery.
No extra privacy query or schema change was added.

After both negative-intent corrections, the static final tree passed full backend
Vitest coverage (5,663 passed/four skipped tests, all configured floors met), the
full Bun suite (2,505 tests across 225 files), and independent reproduction of the
original coauthor case: hidden, muted and blocked matches now yield no bell match
and multiplier one; an eligible coauthor still retains its intended boost.


## Merge and release verification

[PR #1567](https://github.com/OxyHQ/Mention/pull/1567) merged through the protected
queue at **2026-10-21 23:04:04 UTC** as
`b1b7b0b64ac8494169ec783d60eca4d275cbe8df`.
[Queue CI 39689887126](https://github.com/OxyHQ/Mention/actions/runs/39689887126)
completed successfully on that exact SHA: build/lint/types, all three backend test
shards, frontend tests, shared-types/MCP, browser gate and frontend bundle budget
passed. The provenance and baseline jobs were skipped by their workflow conditions;
they are not represented as executed checks. The backend, MCP and frontend workflows subsequently succeeded on that SHA.
Backend [39690926452](https://github.com/OxyHQ/Mention/actions/runs/39690926452)
reached steady state on `oxy-mention:682` at 23:09:15 UTC and passed smoke at
23:09:16. MCP [39690926262](https://github.com/OxyHQ/Mention/actions/runs/39690926262)
reached revision 393 at 23:08:03 and passed smoke at 23:08:04. Frontend
[39690926183](https://github.com/OxyHQ/Mention/actions/runs/39690926183) promoted
Worker `f21c2ac8-7f85-4a8f-8c46-f191b328ae62` at 23:13:03, followed by successful
shell and apex smoke checks at 23:13:15 and 23:13:29. All times in this section
are 21 October 2026 UTC; these are historical release observations, not a claim
about whichever revision is currently live.

### Remaining import-quality acceptance work

This release improves recommendation behavior and records evidence needed for
future import decisions. It does **not** establish that needless import volume
has decreased. The owner's instruction covers improving both decisions; the
limitation is evidence, not a missing permission. The reviewed examples label
recommendation relevance, while historic import triggers and the complete current
follow graph remain unknown for those records. Applying those examples as a broad
import classifier would therefore conflate the two decisions and risk suppressing
discovery or required context.

The post-deployment read-only probe checked the migration ledger, validated
constraints, recorded initial and later import reasons, recent discovery import
windows, and existing bell subscriptions; results appear below. Counts of
new discovery imports can demonstrate continued import activity; they cannot alone
establish content quality, newly discovered accounts, or optimal import volume.
Public 72-hour bell supply is potential inventory before language, seen-state and
negative-preference filtering, not a claim about what the feed will recommend.
No subscriptions or content will be changed to manufacture a live test case.

Legacy origins remain unknown; a missing protocol follow is not proof of no Oxy
followers. Any future import rule needs contextual examples and measured preservation
of followed/requested content, accepted bell interest, boosts, quotes and conversation
dependencies, while continuing to discover worthwhile unfamiliar authors. The current
review report keeps every row protected and performs no deletion.


### Production database verification — 23:11 UTC

The bounded read-only task `85e1c21149174497bcc4badfbd060edd` exited successfully
on `oxy-mention:682`, captured at **2026-10-21 23:11:51.414 UTC**. The live service
was independently verified as completed with two running tasks using release
`b1b7b0b64ac8494169ec783d60eca4d275cbe8df`, image digest
`sha256:b6eccc7e64a1a0a7ff1ff68b572283f181effd6179931000fd01f9c12a7d8d9d`.
The connection and transaction were READ ONLY with a 15-second statement timeout.
[Aggregate evidence](./postdeploy-import-evidence-2026-10-21.json) contains no post
bodies, subscriber identities or credentials.

Both migration SQL hashes (`0090` provenance and `0091` Following sort) matched
the production ledger. The two cascade foreign keys and reason/order constraints
were validated; `feed_following_sort` is NOT NULL with default `chronological`.
Ledger `created_at` values are migration version timestamps, not observations of
when a migration ran.

The audit account already had **eight bell subscriptions**, with **87 public root,
nonboost posts from six subscribed authors in the preceding 72 hours**. This is
potential supply; language, negative-intent, seen-state and ranking rules may
exclude it. No bell subscription was changed for the test.

| Initial import cause | Recorded posts | Distinct remote actors within cause |
| --- | ---: | ---: |
| Discovery backfill | 147 | 10 |
| Reply dependency | 52 | 38 |
| Boost dependency | 10 | 10 |
| Unknown historical origin (NULL) | 593 | 45 |

All 209 posts with an instrumented initial cause in this sample were public and
published. Discovery causes were recorded from **23:08:50.192 to 23:11:35.848 UTC**;
minute buckets recorded 14, 43, 53 and 37 new discovery imports at 23:08–23:11.
This directly verifies continued discovery import activity across several minutes
after the new backend started. It does not measure quality, newly discovered
accounts or reduced unnecessary import volume. Actor counts overlap across causes
and must not be added as a global unique total.

Later reason observations included 547 followed-outbox, 184 discovery, 61 reply,
19 boost and one quote reason. These counts include observations of existing
posts and multiple reasons per post; they are **not new-import counts**. The 593
NULL initial causes remain honest unknown history despite newly recorded necessity
reasons. There was no historical-origin backfill, deletion or import-policy change
as part of this verification.


### Canonical authenticated feed observations on revision 682

[Aggregate capture](./postdeploy-feed-evidence-682.json) records the source times,
release identity and measurements without post bodies or author identities. Requests
used the verified `@nate` account through MCP revision 393 and requested 20 items per
page. A focal post is the final item of a reply-context slice, the first item of
other slices, or an item when the response has no slices. Flattened conversation
context is counted separately. These canonical measures are not interchangeable
with the earlier connector's flat-only counts.

| Feed / session | Pages | Unique focal posts | Focal authors | Largest author count on a page | Focal posts within 72 hours |
| --- | ---: | ---: | ---: | ---: | ---: |
| For You 1 | 10 | 200 | 94 | 3 | 200 |
| For You 2 | 10 | 200 | 115 | 3 | 200 |
| For You 3 | 10 | 200 | 101 | 3 | 200 |
| Explore 1 / 2 / 3, each | 10 | 200 | 163 | 3 | 200 |
| Following | 10 | 295 | 34 | 10 | 295 |
| Following direct | 3 | 88 | 19 | 10 | 88 |
| Videos 1 | 10 | 200 | 152 | 3 | 46 |
| Videos 2 | 10 | 200 | 140 | 3 | 0 |
| Videos 3 | 10 | 200 | 156 | 3 | 27 |
| Media, authenticated | 10 | 200 | 152 | 3 | 200 |
| Friends popular | 8, reached end | 159 | 135 | 3 | 136 |

The captures ran from 23:10:36 through 23:27:18 UTC. None contained repeated focal
IDs within its own continuation chain. Following and Following direct exceeded
20 actual slices per page; this was a real page-boundary defect, not merely reply
context inflating flattened items. The chronological correction is tracked in
[PR #1574](https://github.com/OxyHQ/Mention/pull/1574); these observations precede
that correction and must remain separate from its later retest.

For You session 2 had no overlap with session 1; session 3 overlapped 28 earlier
IDs. Videos session 2 had no overlap; session 3 overlapped 28 earlier IDs. The
30-minute / 1,000-entry served history is shared across For You, Videos and Media,
and more than 1,000 served positions preceded the third For You traversal. Such
cross-refresh overlap is distinct from a continuation duplicate. Sequential reads
also consume recent inventory, so later Videos freshness is not an independent
baseline. Explore's second and third traversals overlapped 199 and 200 prior IDs,
respectively, consistent with persistent global ranking rather than a served-state
rotation contract. All 600 Explore positions were within 24 hours.

Mutuals and friends-of-friends returned empty final pages. Saved returned eight
items and no continuation; the account had no lists. These counts do not prove an
inventory defect; saved bodies are deliberately excluded. Connector median elapsed
times were about 2.2–2.7 seconds for the populated samples and include MCP overhead,
not just backend execution. No language preference was established by these MCP
calls: the delegated client lacked `users.me`, explicit request locale was absent,
and owner-language lookup depended on an app-warmed cache.

The standalone `3` review example remained publicly retrievable at 23:28 UTC and
was absent from 600 sampled For You plus 600 Explore positions. This preserves the
import/recommendation distinction, but absence from a bounded sample alone does
not prove which filter excluded it. The old For You score cursor returned HTTP
410 as intended; MCP displayed `[object Object]` instead of the typed error's
message, motivating the focused tool error-format correction.

### Anonymous API and browser observations on revision 682

Direct public API reads at 23:10:49–23:11:05 UTC used `?lang=en` and
`Accept-Language: en,es;q=0.9`. Each of Media, Trending and Explore supplied ten
pages, 200 unique focal posts, no within-chain ID or slice repeats, and at most
three focal posts by the same author on a page. They had 163, 177 and 144 focal
authors, with median direct-request times of 468, 410 and 398 ms, respectively.
Explore's 218 flattened items included context for its 200 focal posts. URL-level
source duplication was not measurable from this capture and is not reported as zero.

PHP hashtag pages contained 20, **39**, and 20 slices in 735, 542 and 421 ms. The
middle page independently reproduced the chronological boundary defect. The
technology topic returned a successful empty result in 210 ms. Earlier queries
had timed out near 15 seconds with confirmed PostgreSQL statement-timeout errors;
these bounded observations support the repaired query path, not a general latency
SLA or an inference that every empty topic is healthy.

Anonymous Media had a median post age of 56.75 days: 169/200 posts were older than
30 days, only two were within seven days, and the oldest was 716.44 days old.
Trending's median was 3.38 days with all 200 within seven days; Explore's median
was 0.42 days with all 200 within one day. Source inspection explained the Media
path: anonymous requests started directly in lifetime-engagement popular fallback,
bypassing the primary ranking freshness signals. Authenticated Media used a
different path and all 200 sampled posts were within 72 hours. The focused followup
starts anonymous Media with primary ranking and retains popular supply after
exhaustion; it does not impose an import ban or universal content age cutoff.
Its production impact requires a separately attributed post-release sample.

Two repeated Media cursor requests returned identical canonical IDs, slice keys
and body hashes. Changing the requested limit from 20 to 19 returned typed HTTP
410 `FEED_CURSOR_EXPIRED` in 198 ms. These are observed replay results, not a
promise of permanent byte identity as hydration and access state evolve.

The direct production Chromium smoke at 23:14:08 UTC passed four anonymous flows:
Home rows; Home → Explore → post → back without document reload; `@nate` Posts →
Media; and a pushed federated profile's Posts tab. It reported zero script/console
errors and zero HTTP 4xx/5xx responses. Eight navigation-cancelled requests emitted
`ERR_ABORTED` (six page-origin, two API); they were not classified as server errors.
Both visible Home post images and the one visible Explore image loaded, and the
screenshots showed rendered pages. The preview browser gate had also passed 66
tests. This does not constitute an authenticated browser or physical-device test.

### Follow-up acceptance boundaries

The revision-682 evidence exposed separate issues: oversized chronological pages,
Explore's pre-scored source bypassing explicit learned negative intent, anonymous
Media starting with old popular supply, and MCP's missing explicit locale input
and unreadable typed error. The followups must be evaluated at their own deployed
SHA, including old Explore cursor restart behavior. The negative-intent correction
uses source-level exclusions and the canonical hidden-topic penalty rather than
applying a second complete ranking pass. Optional MCP `lang` is an explicit
request fallback, not a claim to read or change the owner's stored preferences.

Discovery continued after the initial release, but reduced unnecessary import
volume, long-term recommendation satisfaction, new-account discovery rate and
source-URL diversity remain unproven. The owner-reviewed examples are contextual
recommendation labels; they do not establish a general import-rejection classifier.
No content, follows, subscriptions or saved items were changed to manufacture
production evidence.


### Chronological correction retest — 22 October 2026

[Separate retest aggregates](./chronological-retest-2026-10-22.json) preserve the
later release range and request times. The authenticated Following and Following
direct captures ran at 17:37:37–17:38:55 UTC during rollout from backend revision
691 (`8c72f104b1aa54bf90a4979dd91597707565d4c8`) to revision 692
(`4cb7f5c4ec0499cd646526bbf495ce9ccc580b12`). Both code histories included
PR #1574; this sample cannot be attributed to one exact serving revision per page.

Each feed returned 194 logical slices across ten pages, with page sizes
20/20/20/20/18/20/18/20/19/19. Neither traversal repeated focal IDs or slice keys;
both retained continuation. A separate original-post identity check found eight
repeat occurrences across seven groups in each traversal (six pairs and one
triple). The triple included an original and two boosts by different actors on
the same page. These are distinct chronological events, not duplicate post IDs;
zero ID repeats must not be described as zero repeated content. This observation
does not establish a defect or change Following's delivery contract. Each had 225 flattened items because conversation
context may legitimately exceed the logical page limit. User identity was
reverified, and no explicit locale or deliberate engagement/settings writes were
added to these authenticated reads.

The anonymous PHP hashtag retest at 17:39:38–17:39:40 UTC ran on stable backend
692, SHA `4cb7f5c4ec0499cd646526bbf495ce9ccc580b12`, with `?lang=en` and
`Accept-Language: en,es;q=0.9`. Its three pages each returned 20 focal posts and
20 slices: 60 unique IDs, zero observed repeats, descending creation timestamps,
three distinct advancing cursors, and `hasMore: true` throughout. Direct elapsed
times were 992, 408 and 509 ms. These live samples confirm corrected page bounds
and observed continuation behavior; exhaustive absence of skipped inventory is
supported by the separate real-database fixture, not proven by these live samples.
These chronological results precede the separately attributed Media/Explore/MCP
followup verification below.


### Identity diagnostics and final sampling boundary

A supplementary check over the 143 authenticated pages collected through the
22 October chronological retest found no missing author username/ID and no
`boost.unavailable` presentation marker. Within each For You, Explore, Videos,
Media and friends-popular traversal, it found no repeated `originalPost` identity.
The Following original/boost repetitions described above remain a distinct case.
These checks establish only the inspected identity and rendering fields; they do
not measure semantically duplicated text, copied media or identical source URLs.

The final authenticated followup used explicit `lang=es` as a controlled
request locale. This is not evidence that Spanish is the owner's stored preference,
and it must remain separate from earlier MCP captures with no explicit locale.
Any language-match calculation must use the actual nested post metadata and state
its treatment of missing or multiple declarations. A fresh request, an advancing
cursor and a replay test answer different questions; their counts must not be
combined as independent recommendations. The final results below are attributed to the actual deployed SHA and request
times; the capture is observational, not a matched-inventory causal benchmark.


## Final followup release and production verification — 22 October 2026

[PR #1577](https://github.com/OxyHQ/Mention/pull/1577) merged at 18:08:49 UTC
after successful protected queue
[CI 39827996686](https://github.com/OxyHQ/Mention/actions/runs/39827996686), then deployed as
`d808a983ba8703b105b5bc386a8fee8696226a2d`. Backend
[39830509985](https://github.com/OxyHQ/Mention/actions/runs/39830509985) succeeded
with revision **695**, two healthy running tasks and image digest
`sha256:1a47a22240dcbae48c309332d4f84e6117c344ddd32f3760fc945d45206f0c15`.
MCP [39830509883](https://github.com/OxyHQ/Mention/actions/runs/39830509883)
succeeded with revision **403** on the same SHA; readiness was confirmed by
18:26:47 UTC. Frontend
[39830509654](https://github.com/OxyHQ/Mention/actions/runs/39830509654) succeeded
on that SHA, with Worker `543f02ed-68b0-4847-b447-836b268fa168` promoted at
18:35:22 and apex smoke passing at 18:35:47. These release records supersede the
prior deployment-pending status; they do not retroactively change the revision
assigned to any historical sample.

[Final aggregate evidence](./final-release-evidence-695.json) contains the
request times, counts, cursor outcomes and browser checks without post bodies,
author identities, private cached preference values or session keys. The six
authenticated traversals comprised **44 successful pages and 857 logical posts**
(883 flattened items including conversation context). This is a count of positions
across sessions, not 857 globally unique posts. Every individual traversal had no
repeated focal ID, slice key or original-post identity.

| Authenticated traversal | Successful pages | Logical posts | Authors | Largest author count on one page | Outcome |
| --- | ---: | ---: | ---: | ---: | --- |
| For You 4 | 10 | 184 | 73 | 3 | Page 11 later returned typed 410 |
| Explore 4 | 2 | 33 | 19 | 7 | Exhausted initial eligible supply |
| Media 2 | 2 | 40 | 31 | 3 | Page 3 returned typed 410 |
| Media 3, fresh | 10 | 200 | 143 | 3 | Continuation available |
| For You 5, fresh | 10 | 200 | 69 | 3 | Continuation available |
| Explore 5, fresh | 10 | 200 | 144 | 3 | Continuation available |

The initial samples began at 18:26:52; the three fresh ten-page traversals ran
from 18:31:06 through 18:36:39 UTC. All used explicit `lang=es`. That parameter is
a request fallback when account languages cannot be resolved, **not a hard language
filter or a change to saved preferences**. Initial For You, Explore and Media
samples declared Spanish on all 184, 33 and 40 focal posts. Later fresh samples
used the account-resolved context: Media declared English on 197 and Catalan on
three posts, with one also declaring Japanese; For You declared English on all
200; Explore declared English on 185, Spanish on 12 and Catalan on three.
All had language metadata; multi-language declarations can make tag counts exceed
post counts. These are metadata observations, not inferred language comprehension
or a language-filter failure. The separate served-text language field was unknown
on some posts and is preserved in the artifact rather than silently counted as a
match.

The sparse initial Explore traversal returned 13 posts on its terminal second
page, seven from one author. This is the existing scarcity relaxation when the
eligible pool cannot satisfy the usual diversity preference, and demonstrates
that three per author is not an unconditional invariant. The final fresh Media,
For You and Explore samples each stayed at or below three per page. Their median
post ages were 25.35, 6.41 and 8.76 hours; all 600 were within 72 hours and all
200 Explore posts were within 24 hours. No sampled focal post matched the
standalone-number diagnostic; bounded absence alone is not a universal quality
proof. MCP elapsed times include connector overhead and are not directly
comparable with the public API timings below.

### Cursor restart and effective-context observations

Media 2 page 3 returned `FEED_CURSOR_EXPIRED` at 18:29:34, followed by For You 4
page 11 at 18:30:51. These remain recorded outcomes, not silently discarded
failed samples. Exact-key read-only Redis diagnostics at 18:34:24 found the
inspected old keys present and unexpired. At 18:37:19, old and fresh Media
sessions both remained unexpired but had different binding hashes. The account
language cache had become nonempty during the capture, consistent with the
observed inventory language change. **A changed effective bound context is
supported; language-cache warmup is the leading inference, not proof of the
exact changed field.** Expiry/pruning was not supported by the later observations;
a transient earlier Redis read failure cannot be excluded from those snapshots.
No Redis mutation or new feed-policy change was made for this diagnosis.

Fresh sessions recovered and each completed ten pages. Separate controlled
checks verified that an Explore cursor created before the cutover continued
successfully on the old build, then returned typed 410 on the new build less
than four minutes after creation. A legacy cursor also returned 410; an invalid
language tag was rejected at tool-input validation. Two authenticated replays of
a current Explore cursor returned the same IDs and slice keys as each other and
the original page. Changing the limit to 19 returned typed 410. MCP now renders
the code and recovery message readably: `FEED_CURSOR_EXPIRED` and “refresh the
feed”, rather than `[object Object]`. These results validate explicit restart
behavior and observed replay identity, not perpetual byte stability.

### Public freshness and final browser checks

Direct anonymous API reads at 18:28:37–18:28:48 UTC used `?lang=en` and
`Accept-Language: en,es;q=0.9` on backend 695. Media and Explore each completed ten
pages with 200 unique focal posts, no focal/slice repeats and at most three posts
per author on a page. Media had 148 authors, 200 flat items and median request
latency 520 ms (454–763); Explore had 135 authors, 206 flat items and median
435.5 ms (412–668). Every page succeeded and retained a session continuation.

Anonymous Media's median post age was **1.04 days**, all 200 posts were within
seven days, and none exceeded 30 days. Its historical revision-682 sample had a
56.75-day median and 169/200 posts older than 30 days. The corrected primary-first
path and this fresher observed sample agree, but time and inventory changed
between captures: this is not a matched causal experiment. Explore's final public
sample was entirely within 24 hours. Every public post's declared metadata included
English or Spanish, with one Media post also declaring Japanese. Original federated status URLs
were unavailable in the inspected projection, so duplicate-origin content remains
unmeasured. Separate public
cursor probes encountered `EHOSTUNREACH` twice before receiving HTTP responses;
those probes are **unverified**, distinct from the successful public traversal
and authenticated replay checks.

The actual production anonymous Chromium check at 18:36:41 passed five flows:
Home; Home → Explore → post → back within the same document; `@nate` Posts →
Media; a pushed federated profile's Posts; and anonymous Media. It reported no
script/console errors or HTTP 4xx/5xx responses. Ten navigation/resource cancellations
emitted `ERR_ABORTED`. Both visible Home images and the one visible Media image
loaded; no large Explore image was in the inspected viewport, so no Explore-image
load claim is made for this run. Screenshots were inspected and rendered normally.
The frontend candidate browser gate passed 66 tests. Logged-in browser and native
physical-device behavior remain outside this verification.

### What this evidence establishes and leaves open

The implementation now has separately verified chronological page bounds,
replay/restart handling, readable MCP errors, optional explicit request locale,
fresher anonymous Media supply in the final sample, and bounded author diversity
with an explicit scarcity exception. Explore negative-intent parity is covered by
real-database regression tests; production settings were not changed to manufacture
an account-specific negative-preference experiment. Discovery import activity and
provenance were verified on revision 682; no additional database import probe was
run for revision 695 because this followup did not change import policy or schema.

Reduced needless import volume, subjective recommendation satisfaction, universal
semantic quality, copied-content/source-URL duplication and new-account discovery
rate are still not established. The documented owner labels support contextual
recommendation decisions, including useful unfamiliar art; they are not a blanket
import classifier. The session-context transition and sparse Explore concentration
are recorded limitations rather than concealed by successful fresh traversals.
