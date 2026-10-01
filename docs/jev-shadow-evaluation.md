# Jev shadow evaluation (blocked candidate)

This branch adds a shadow ledger and a gated fanout in the existing
`PostClassificationService`. It does **not** enable Jev inference. The installed
`@oxy.so/core@4.0.0` has no `decide()` method. The Oxy decisions foundation is
unpublished; consume its published SDK through a normal dependency/lockfile bump
before implementing the typed request and receipt projection. There is no local
HTTP transport, provider client, contract copy, package override, or production
binding for the domain projection seam.

The pilot is stacked on [Mention PR #1300](https://github.com/OxyHQ/Mention/pull/1300)
at `0a77c95cf756b1e79f98932bd10c96d96b55fd6e`. Its migrations 0058–0060 and
hydration/federation behavior are retained; this pilot adds migration 0061.
After that foundation merges, rebase the pilot onto main rather than merging the
topic branch. The unpublished SDK dependency is
[Oxy PR #1503](https://github.com/OxyHQ/oxy/pull/1503); its handoff can change
during independent review, so its final published types remain authoritative.

## Worker and persistence

Stage A v11 and canonical Stage B behavior remain unchanged: five-minute worker,
25 live posts, then 10 imported posts only when the live queue is empty, primary
text limited to 1,000 characters, three legacy attempts. Edits reset the existing
pending queue. Imports are retained. Shadow failures never consume a legacy
attempt. There is no second service, scheduler, or feed-ranking consumer.
Canonical and shadow enrichment start independently on the selected batch. Shadow
inference shares one batch deadline from the existing inference timeout and gets
an abort signal. A hung evaluator cannot hold the worker indefinitely; timeout
quarantines the claim as cost-uncertain and late results are ignored.

The shadow repository admits only public, published, original posts written
natively on Mention. A post with an inbound activity ID, a remote actor URI, or
an author account minted for a federated actor is refused at claim and again at
completion, whatever its visibility, actor flags or follow state. A successful
unique insert claims `(post, full rendition fingerprint, model revision, Oxy
policy reference/version, evaluation version)` **before** inference. The claim's
ID is the future SDK idempotency key. Replays, leadership changes and crashes
cannot acquire another claim. An abandoned `claimed` row is unresolved cost, not
permission to try again. A timeout, invalid result or uncertain write becomes
`cost_uncertain`; this worker never retries it or creates a fresh request ID.
Future receipt reconciliation must use the existing identity.

The fingerprint includes author rendition IDs (so an edit away and back is a
new revision), ordered tags/full bodies/article fields, canonical language
evidence and original actor identity. Machine translations are excluded: the
inference input is the author primary and the canonical languages, so caching
or replacing a translation neither cancels an in-flight result nor opens a
second claim. It excludes `posts.updatedAt`, counters
and other incidental post metadata. Only inference input is truncated. Claim
and completion acquire the existing rendition advisory lock, then lock the post
and rendition rows. The final transaction rechecks public/published state and
the exact fingerprint. Edits cancel stale results; deletion cascades claims and
topic rows, preventing result resurrection. No transaction spans inference.

Topics live in `post_evaluation_topics` as independent probabilities. Language,
spam, repetition and feed value remain separate from each other and from
canonical topics/scores. Media-only, unknown-language and unsupported-language
inputs abstain with null scores. The existing worker neutralizes media-only
posts before queue selection; it does not send them to shadow inference.

## Follow and context boundaries

Completion reads accepted **outbound** edges for the post's canonical original
actor URI or DID immediately before saving. Because only native posts are
eligible today, completed rows record `unknown`; the lookup is kept, and tested
directly, for when federated sources carry durable listed provenance. Following
an actor is a quality signal and never makes its posts eligible: privacy
eligibility and the follow override stay separate, as does security. Pending and inbound follows, quote
subjects, boosting actors, ancestors and exact-view context do not supply that
edge. Local Oxy graph evidence and failed lookups are `unknown`, never rejection.
The evidence is an observation at commit, not a lasting admission verdict.

No shadow record affects storage, discovery admission, security checks, local
reply/mention eligibility, thread integrity or ranking. Thus a later follow
requires no recovery from a shadow rejection: no content was discarded. Any
future admission implementation must resolve current follows before discovery
quality, preserve contextual views, and fail unknown lookups without rejecting
content. Security enforcement remains independent.

## Closed release gates and remaining integration

`JEV_SHADOW_BLOCKERS` is a hard application gate, with no environment bypass.
Removing it requires independent review of all of the following:

- Published Oxy decisions SDK/contracts, consumed normally. Build typed questions
  there: one Noul per overlapping topic, independent spam/repetition questions,
  separate language evidence, and an ordered feed-value Score. Never use an
  exclusive Choice for overlapping topics or manufacture confidence.
- Exact immutable model revision, supported languages, question-set/evaluation
  version and Oxy policy reference/version. Validate the SDK result's model,
  exact question IDs/kinds/cardinality, policy receipt and normalized score
  mapping before projecting into Mention's shadow storage. Persist the Oxy
  request/receipt reference using the published SDK contract when available.
- Affirmative internal provider eligibility, privacy and ZDR evidence on the
  exact reviewed route. TypeSafe standalone resale and OpenRouter resale /
  competitor terms block ordinary credentials; internal use is not automatically
  eligible. No public Jev service enablement is included.
- Oxy remains control-plane authority. Only Oxy signs execution authority for
  Kaana, whose sole canonical signed origin is `https://kaana.ai`.

The synthetic tests cover ledger concurrency, content/privacy/deletion changes,
independent signals, follow timing and worker isolation. They prove neither
provider eligibility nor a deployed route. No real provider calls are needed
or authorized for these checks. Merge and deployment require the independent
review coordinator.

## Independent review disposition

The review of the dormant candidate identified release conditions beyond SDK
publication. They are explicit hard blockers, not implied by `visibility=public`:

- ActivityPub maps `Public` in either `to` or `cc` to Mention's public value,
  losing the listed/unlisted distinction, and atproto and Instagram actors are
  stored `discoverable: true` unconditionally. Neither column proves a remote
  author opted into discovery, so the repository enforces native-only
  eligibility (above): unlisted, non-discoverable and suspended remote sources
  are never claimed. The `federated_public_visibility_provenance` gate stays
  closed until ingestion stores durable listed provenance and real actor
  discoverability; only then can federated sources be reconsidered. Existing
  ingestion, follows, security checks and feed behavior are unchanged.
- Author rendition identity intentionally remains conservative. A pass-through
  content replacement (`replacePostContent` re-inserts every rendition with new
  IDs) invalidates the snapshot, even if primary text is unchanged. Machine
  translations no longer do (above). A public/private/public toggle cannot
  acquire another claim for the same fingerprint. These states may have incurred
  cost: `cancelled` never means refunded or free. Superseded successful results
  log their existing evaluation ID for reconciliation. The
  `semantic_revision_and_receipt_reconciliation` gate blocks release until
  no-op rewrites, split content/language edits, privacy transitions and paid
  receipt recovery are addressed without fresh inference IDs.
- Row locks are retained for atomic public/published/deletion checks. A key-share
  lock would allow non-key visibility/status updates; an unlocked re-read would
  reopen the check/write race. These short transactions contain no inference.
- Model/policy receipt verification, supported result languages and exact topic
  question IDs remain SDK integration requirements. A consumer cannot replace
  the unpublished contract with guessed result checks.

Synthetic unlisted, listed, non-discoverable, suspended, followed atproto,
activity-only and minted-account federated sources, follow-query failure,
missing local graph evidence, restricted/boost eligibility, privacy toggles,
machine-translation caching and replacement, author rendition additions,
invalid output, late results and independent canonical progress
are covered in the pilot tests.
