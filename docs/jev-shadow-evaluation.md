# Jev shadow evaluation (blocked candidate)

This additive first cut is based on main `285f4719f9beead269fce847a24c7a89c885dc87`,
ending at migration 0057. New migration `0058_jev_shadow_ledger` creates only
`post_evaluations` and `post_evaluation_topics`, including SDK receipt and language
evidence storage. Every pre-existing snapshot table, including
`actor_key_pairs.private_key_pem`, is preserved. This branch has no dependency on
PR #1300, its migrations, or its post-link-preview changes.

The normal dependency catalog and core override pin public npm
`@oxy.so/contracts@4.7.0` and `@oxy.so/core@4.1.0`; Bun generates the lockfile.
`createJevShadowEvaluation` consumes the published `decide()` method with typed
Noul propositions for overlapping topics, spam, internal repetition and each
canonical language, plus an ordered five-level `feedScore`. The normalized
feed value is the validated expected index divided by four. It does not derive
confidence or convert language probabilities into canonical language labels.

The consumer parses the published strict success schema, checks the immutable
model, exact answer IDs/kinds/cardinality and score distribution, and requires
the reviewed routing policy ID and version. The SDK checks the response-header
request ID against the body. `sdk_receipt` stores the contract's `requestId`
and `routingPolicy`, plus the returned typed `usage` quantities verbatim; decisions do not return a `receiptId`, so none is
invented. The claim ID is only the SDK idempotency key, not the edge request ID.
Usage quantities are not money or proof of financial settlement. Missing usage
in synthetic domain fixtures is never treated as zero cost. Receipt recovery after
ambiguous/late results remains blocked pending reconciliation review.

There is no production client binding, provider call, manual transport, local
package override, environment bypass, or retry after dispatch. All six existing
release blockers remain nonempty, including `published_decisions_sdk`: publication
and implementation alone do not satisfy independent integration review.

## Worker and persistence

Stage A v11 and canonical Stage B behavior remain unchanged: five-minute worker,
25 live posts, then 10 imported posts only when the live queue is empty, primary
text limited to 1,000 characters, three legacy attempts. Edits reset the existing
pending queue. Imports are retained. Shadow failures never consume a legacy
attempt. There is no second service, scheduler, or feed-ranking consumer.
Canonical and shadow enrichment start independently on the selected batch. Shadow
inference shares one batch deadline from the existing inference timeout and gets
an abort signal. A hung evaluator cannot hold the worker indefinitely; timeout
quarantines the claim as cost-uncertain and late results are ignored. If the
claim transaction itself exhausts the budget, the evaluator is never called and
the claim row is deleted (logged with its ID): that ID never left the process,
so nothing was spent and no retry follows in this cycle.

**Shadow coverage is opportunistic, not a sample.** The shadow pass rides the
canonical cycle. Posts it does not reach before the batch deadline are still
classified canonically, leave the pending queue, and are never shadow-evaluated;
one slow call can skip the rest of its batch. Imported posts and ineligible
authors are excluded outright. Any shadow-versus-canonical comparison is biased
toward fast, early-in-batch, native public posts, and gate reviewers must treat
it that way.

The shadow repository admits only public, published, original posts written
natively on Mention by an owner whose profile is public. Refused at claim and
again at completion, whatever the post's visibility, actor flags or follow
state:

- a post with an inbound activity ID or a remote actor URI, or whose author
  account was minted for a federated actor;
- any post with a `post_imports` row. Oxy Move imports Mastodon unlisted posts
  as `public` with no federation columns, so an import never proves listed;
- a post whose owner's `privacy_profile_visibility` is `private` or
  `followers_only`. That overrides the post's own `public`, as in
  `canViewAuthorFeed` and the sitemap's `publicSeoPost`. No settings row is the
  default public profile; a post with no owner fails closed.

A profile or import change during inference cancels the result.

The profile check is serialized with profile changes, not merely re-read.
`updateUserSettings` takes an exclusive per-account advisory lock
(`profile-visibility:<id>`) before writing any `privacyProfileVisibility`,
including the insert of a row that did not exist. Claim and completion take it
shared after the post locks, then read the settings. A change that holds the
lock first is seen, and cancels the result. A change that arrives while a
completion holds the lock waits until that completion commits. Writers take no
lock before it, so the order cannot invert, and no transaction spans
inference. The other `user_settings` writers cannot change the answer: label
subscriptions and `ensureUserSettings` insert the default public row, which
reads the same as no row, and the restricted-users pulls do not touch
visibility. Account erasure and channel deletion delete the settings row only
after removing the account's posts in an earlier step. A future writer of
profile visibility must call `lockProfileVisibility`.

A successful unique insert claims `(post, full rendition fingerprint, model revision, Oxy
policy reference/version, evaluation version)` **before** inference. The claim's
ID is the SDK idempotency key. Replays, leadership changes and crashes
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

- Published Oxy decisions SDK/contracts, consumed normally and independently
  reviewed. The implemented questions use: one Noul per overlapping topic, independent spam/repetition questions,
  separate language evidence, and an ordered feed-value Score. Never use an
  exclusive Choice for overlapping topics or manufacture confidence.
- Exact immutable model revision, supported languages, question-set/evaluation
  version and Oxy policy reference/version. Validate the SDK result's model,
  exact question IDs/kinds/cardinality, policy receipt and normalized score
  mapping before projecting into Mention's shadow storage. The implemented consumer persists the published Oxy request and routing-policy
  reference; independent acceptance and uncertain-cost reconciliation remain open.
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
  losing the listed/unlisted distinction; Oxy Move does the same for imported
  Mastodon unlisted posts; atproto and Instagram actors are stored
  `discoverable: true` unconditionally. None of these proves the author opted
  into discovery, so the repository enforces native, non-imported,
  public-profile eligibility (above): unlisted, imported, non-discoverable,
  suspended and private-profile sources are never claimed. The `federated_public_visibility_provenance` gate stays
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
- Model/policy verification, supported input languages and exact topic question
  IDs are implemented against the published contract and covered by synthetic
  SDK tests. This does not establish provider eligibility or release approval.

Synthetic unlisted, listed, non-discoverable, suspended, followed atproto,
activity-only and minted-account federated sources, imported posts (including
the imported worker lane and imports landing mid-inference), private and
followers-only profiles (including a transition mid-inference), ownerless
posts, a claim that exhausts the deadline before any call, follow-query failure,
missing local graph evidence, restricted/boost eligibility, privacy toggles,
machine-translation caching and replacement, author rendition additions,
invalid output, late results and independent canonical progress
are covered in the pilot tests.

## Validation and owned PostgreSQL handoff

`vitest.jev-unit.config.ts` runs the database-independent Jev suites, the
owned-cluster guard suite (`jevOwnedPg.test.ts`) and protected-column/channel/
account-erasure coverage guards; it does not replace the repository's PostgreSQL
gate. The normal build, backend typecheck, lockfile, architecture, inference,
feed-hot-path and logger guards are separate checks.
`scripts/validate-jev-additive.mjs` checks the additive snapshot, SQL, preserved
private-key registry, six blockers and pinned hashes.

The implementation sandbox cannot connect to the owned Unix socket (`Operation
not permitted`). The coordinator caught a bug in the first test script: it
reached a localhost server instead of the owned socket, and that attempt was
rejected at authentication with `28P01` before any query or test ran. Teardown
refused to drop `postgres`. No other data was read or written.

`scripts/test-jev-owned-pg.sh` now takes the owned cluster's identity only from
five explicit variables, with no defaults:

```bash
JEV_TEST_DATA=/tmp/mention-sdk-owned-pg-20261001/data \
JEV_TEST_SOCKET=/tmp/mention-sdk-owned-pg-20261001/socket \
JEV_TEST_PORT=5432 \
JEV_TEST_DATABASE=mention_jev_owned_base \
JEV_TEST_USER=nate \
bash scripts/test-jev-owned-pg.sh
```

Any missing variable exits 2 before Node starts. The guards live in
`scripts/lib/jevOwnedPg.mjs`. The proof (`scripts/lib/jevOwnedPgProof.mjs`) runs
these steps in order and stops at the first failure:

1. The data and socket directories must be absolute, normalized paths under
   `/tmp/` that are not symlinks. The port must be an integer. The database must
   be named, so `postgres` and the templates are refused. The role must be a
   plain identifier.
2. `postmaster.pid` must name that data directory, port and socket directory,
   with an empty TCP listen address. Its PID must be alive, and
   `/proc/<pid>/comm` must read `postgres`. `.s.PGSQL.<port>` must be a Unix
   socket, and its lock file must name the same PID.
3. `TEST_DATABASE_URL` and `DATABASE_URL` are both exactly
   `postgres:///<database>`, a URL with no hostname. `PGHOST`, `PGPORT`,
   `PGUSER` and `PGUSERNAME` come from the identity, and `PGDATABASE` is unset.
   postgres-js 3.4 reads `PGHOST` only when the URL has no hostname. On
   `postgres://localhost/db?host=/sock` it ignores the parameter and uses TCP
   localhost, and with `PGHOST` unset a hostless URL also falls back to
   localhost. So the URL guard refuses any hostname, port, credentials or
   routing query parameter.
4. postgres-js builds its options without connecting. Before any query, the
   proof checks `host`, `path`, `port`, `user` and `database` on those options
   for the named base. It then checks them for `postgres:///postgres`, the
   maintenance URL that `@oxy.so/db/testing` rewrites the base to for
   `CREATE`/`DROP DATABASE`. The maintenance database is allowed only on the same
   socket and cluster.
5. On those same clients, `SHOW data_directory` must equal the data directory,
   `SHOW listen_addresses` must be empty, and `current_database()` and
   `current_user` must match.

Only after that does Vitest run the synthetic ledger/privacy barriers, worker
isolation, protected-column, post/account/channel deletion and schema tests,
through the existing throwaway-database harness. Throwaway `oxydb_test_*`
databases are created on the owned cluster only. Values already in the
environment override `.env`, so no `.env` database fallback applies.

`jevOwnedPg.test.ts` makes no network calls and needs no database. It builds
real postgres-js clients and inspects their options without querying. It shows
that each missing variable fails before a client is constructed. It shows that
localhost URLs and the `?host` trap are refused before construction, and that
the unset-`PGHOST` localhost fallback, a foreign socket and a stray
`PGUSERNAME` are refused on the options. It captures the URL that the real
`@oxy.so/db/testing` passes to postgres-js and checks that it resolves to the
owned socket. It also covers each `postmaster.pid`, PID, socket and lock refusal
through an injected probe. No provider calls are involved.

The coordinator then ran the command above outside the sandbox against the
owned cluster. The targeted run passed 296 tests in 13 suites. On the owned base
with migration 0058 applied, `information_schema` showed
`private_key_pem_exists = 1` and both shadow tables present
(`shadow_tables = 2`). The database-independent unit config passes 111 tests:
59 Jev unit tests and 52 regression tests.

The full backend suite on the same owned cluster (638 suites, 7670 tests)
passed 636 suites and 7668 tests. The two failures were metadata guards. The
first was `docsFileReferences`, which reads `git ls-files` and could not see the
new, still-untracked docs files; it clears once they are staged. The second was
`isolatedDatabaseCoverage`, because `SCRIPT_SCOPE` had no entry for
`lib/jevOwnedPg.mjs`; that entry is now declared. The full suite stays pending
in CI until it reruns with both fixes.
