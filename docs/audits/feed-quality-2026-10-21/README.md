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
from 389 to 390 during the audit. Exact deployed commit provenance is still pending;
these pages must not be treated as a stable-build benchmark or a matched algorithm
comparison. They are one session, not the planned three-session coverage.

## Owner calibration: concrete examples

These labels concern recommendation, not import or historical deletion. The owner
asked for shorter questions and updates during this audit.

| Public example | Owner assessment | Import decision |
| --- | --- | --- |
| [Standalone “3”](https://mention.earth/p/01a15cbe-daae-72e7-a9e4-f213850a9066) | Do not recommend, even when following its author. Chronological Following delivery remains a separate behavior. | No import rejection authorized. |
| [“Good morning or whenever”](https://mention.earth/p/01a15f2a-a903-7d83-8402-d5dbc2986d8b) | May recommend in For You when following the author; not from a stranger. | No import rejection authorized. |
| [PHP warning control](https://mention.earth/p/01a15fc2-1598-75cb-8828-b7cb97f7478b) | Uncertain; owner suggested following may matter. No approval or rejection established. | No import rejection authorized. |

These public items were inspected with no attached media, original, quote or parent.
Two concrete judgements do not establish a universal threshold. A possible rule
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

Further direct production API traversal was **anonymous**, with requested languages
`en,es`, and must not be presented as @nate personalization evidence:

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

Migration 0089 creates two private evidence tables: one immutable initial cause
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
timeout. It reports known causes, references, protocol follows, engagement, saves,
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

MCP tests cover canonical response preservation, empty continuation pages,
descriptor routing, invalid and protected descriptors, anonymous personalized
reads, scope rejection, exact capability headers and upstream refusals. Existing
MCP integration and catalog tests remain required.

Outstanding production evidence: exact deployed commits per capture, canonical multi-page captures for every available
surface, quality examples reviewed by the owner, import-trigger attribution where
available, comparative ranking samples and cross-platform client behavior. Empty
account-specific surfaces need fixture coverage and must not be reported as
production defects without eligible inventory. No claim of exhaustive completion
or improved production feed quality follows from code tests alone.
