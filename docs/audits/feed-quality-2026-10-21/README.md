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
from “no local followers now”. A future causal provenance change needs durable,
bounded import-event data at each real entry point; populating old rows with a
fabricated reason would invalidate the audit.

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
