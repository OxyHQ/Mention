# Jev shadow evaluation (production admission remains blocked)

Historical storage baseline: the additive first cut was based on main `285f4719f9beead269fce847a24c7a89c885dc87`,
ending at migration 0057. New migration `0058_jev_shadow_ledger` creates only
`post_evaluations` and `post_evaluation_topics`, including SDK receipt and language
evidence storage. Every pre-existing snapshot table, including
`actor_key_pairs.private_key_pem`, is preserved. This branch has no dependency on
PR #1300, its migrations, or its post-link-preview changes.

The normal dependency catalog currently pins public npm
`@oxy.so/contracts@4.9.1` and `@oxy.so/core@4.3.0`; Bun generates the lockfile.
Original-key receipt recovery uses that published additive core method.
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
ambiguous/late results uses only the original key, as described below.

The production singleton now calls `createProductionJevEvaluation`, which uses
the canonical `OxyInferenceClient` and existing Mention `serviceToken()` path.
Its reviewed source approval is absent, so it constructs no active evaluator.
There is no provider call, manual transport, committed local package override,
environment bypass, or retry after dispatch. All six existing
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

The fingerprint excludes physical rendition IDs (so a semantic no-op or an edit
away and back cannot create another paid claim), and includes ordered tags/full
bodies/article fields, canonical language
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
- Author revision identity uses full semantic content and metadata, not physical
  rendition IDs. A pass-through `replacePostContent` rewrite with identical
  author content/language preserves the existing claim, including completed,
  cancelled, claimed and cost-uncertain rows. Editing away and back cannot buy a
  second request for the original semantic identity. Machine translations remain
  outside that identity. The owned-PG regression demonstrates these cases with
  five concurrent claimers and an unchanged durable ledger. This is a pre-release
  identity correction: it does not rewrite older ledger fingerprints or enable
  production classification. The `semantic_revision_and_receipt_reconciliation`
  gate remains closed for paid/uncertain receipt recovery, split content/language
  updates and independently reviewed activation; `cancelled` never means free.
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
`scripts/validate-jev-additive.mjs` checks that migration 0058 stays additive
(snapshot, SQL and journal position) and that the gate stays dormant (six
blockers, no environment switch). `bun run validate:jev-additive` runs it and its
mutation tests inside `check:workspace`, so CI runs it on every change.

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

## Original-key usage reconciliation

The receipt-recovery followup uses the canonical core
`getGenerationRecordByIdempotencyKey` method from published `@oxy.so/core`
4.3.0, with `@oxy.so/contracts` 4.9.1. The committed registry lock and installed
package members are verified against the published release archives. The
combined receipt and atomic-edit tests pass; production binding and activation
remain separate from this adoption.

Migration 0060 adds three nullable fields to the existing ledger: the original
public authority tuple, the original request deadline, and independent usage
reconciliation metadata. The authority and deadline are written before dispatch.
The existing classifier cycle reads at most 25 matching unresolved claims through
GET only. It never calls `decide` to recover a receipt. Claimed work is eligible
only after its persisted deadline; old claims without proven authority/deadline
are not guessed or reissued. A 401/404 or missing record remains unresolved.

A recovered v1 customer charge retains its billed amount, currency and price
version; a v2 internal record retains its separate tariff and `not_charged`
status. Provider invoice cost remains unknown. Neither variant restores lost
answers: `reconciled_result_missing` is separate from the original outcome, and
no spam/topic/feed values are fabricated. Concurrent completion wins over a late
recovery write; deletion cannot resurrect a row; privacy changes never export
content through this metadata-only read. Aborted reads cannot later write.

The production gate remains closed pending the exact Jev route/privacy review,
governed Mention authority/funding and the remaining release criteria.
No production ledger backfill, funding mode, credential or provider approval is
inferred from these fixtures.

### Recovery authority and maintenance deadline

The validated, frozen receipt authority supplies the same optional delegated
user to the original SDK decision POST and its original-key GET. Mutating the
caller configuration cannot change either attribution after construction.

Receipt maintenance has one absolute deadline for selection, connection
startup, remote reading and transactional persistence. A cycle owns at most
one private connection constructed by `@oxy.so/db` with the canonical schema
and casing. Server statement/lock timeouts bound SQL; expiry or cancellation
forcibly closes that private connection and its queued work. The ordinary
classifier pool remains available. The row is checked again under lock and
after each asynchronous boundary, and a cancelled transaction cannot write
late after a blocking lock is released. Unknown receipts remain unresolved;
none of these paths issues another inference request.

## Production factory and remaining authority

`jevProductionApproval.ts` is the single source-reviewed product binding. It
currently returns `undefined`. An eventual approved record must identify the
reviewed deployment metadata and evidence, immutable model/policy/evaluation version,
question set, canonical UTC expiry and Mention's own production application and
credential. Borrowed human delegation is refused for this background product
lane. The factory does not register credentials, expand scopes, fund accounts or
interpret an environment switch as approval. Expiry is checked before and after a SQL claim, so unsent work is not
quarantined as cost-uncertain. Original-key receipt reads remain available for
accounting reconciliation. A local factory refusal is distinct from an
ambiguous provider outcome.

The deployment ID is review metadata, not request or receipt attestation: the
public decisions contract returns model/policy, and usage recovery does not
prove an exact deployment. Before activation, the matching Oxy policy must
restrict the resolver to that reviewed deployment before provider dispatch.
This factory cannot enforce or establish that condition by merely storing an ID.

Historical runtime 694 authority readback found Mention's effective invocation scope
missing and its billing account unprovisioned. The existing Alia internal-metered
pilot does not transfer either authority or funding to Mention. Canonical
operations available for a separately reviewed activation are the Oxy application
scope update, existing workload binding scope update ([Oxy workload-binding CLI](https://github.com/OxyHQ/oxy/blob/28d90e4f2c9143253843725aa361975ec951c6cd/packages/api/scripts/bind-workload-identity.ts)),
and, for a commercial lane, the owning account's billing provisioning and balance readback.
[Oxy economic policy](https://github.com/OxyHQ/oxy/blob/28d90e4f2c9143253843725aa361975ec951c6cd/packages/api/src/config/inferenceEconomicPolicy.ts) at that historical pin exempted Alia only. Mention's later independent bounded internal relationship must be separately reviewed; it is not supplied by this factory. The exact Jev deployment/privacy/ZDR and policy approval also remains
required. Public provider availability is not this product approval.

The factory is wired to the existing worker, not a second scheduler. A real
PostgreSQL fixture invokes the actual SDK through that factory with a synthetic
source review and workload token. It observes one persisted native claim before
one POST, excludes a federated row, and preserves ordinary classification. The
repository suite separately exercises imports, private sources, federated owners
and privacy/deletion races. No real provider, production funding or human
consent is claimed by these fixtures. All six release blockers remain intact.

### A single reviewed native revision

The production approval now requires a selected post ID, its full semantic
fingerprint, a preassigned original idempotency key and the SHA-256 of the
normalized decisions input. `preparePostEvaluationSelection` uses a repeatable
read, read-only transaction and returns only these IDs/hashes; it creates no
claim and grants no authority. The request builder is shared with the SDK path,
including the existing 1,000-character primary-text limit. The fingerprint still
covers the full author content and language ordering.

At dispatch the claim transaction rechecks privacy, native provenance, content,
expiry and input hash under the existing locks before inserting that exact key.
Only the winning insert may invoke. An already-classified selected post can run
through the same shadow path without reopening its ordinary classification.
Other queued posts remain on the independent classifier. Unknown outcomes retain
the original key and use receipt GET recovery; they never gain a new paid retry.

This does not activate Jev: the production getter remains absent and the release
blockers remain closed. Oxy and Kaana still need a separately reviewed **Mention**
audience binding this exact key/input/principal and actual route/policy/card;
the earlier Alia audience cannot authorize it. Native-only approval does not admit
federated or imported content. No private post text, fake balance or user identity
is created by selection preparation.

### Bounded native factory admission

The existing scheduler already starts the production singleton. A source-reviewed
native approval can now admit its one selected operation without opening the
broader shadow gate (which still includes federated provenance). Only evaluations
created by the validated factory receive this in-process identity; copying a
projection or setting an environment flag does not authorize it.

The getter still returns `undefined`. A future source record must contain separate
review evidence for the published SDK, exact private Oxy/Kaana route, Mention's
own authority/economics, privacy/ZDR, and semantic identity/recovery. It must pin
Mention app `6a2f851751b784a86fd0e916`, owner `69b2d3df5d12f58c9800d651`, and
workload credential `wl_d61be5cd068abb658ed4d193` with production environment and
no delegation. Public source identifiers and review references are not credentials,
permissions or proof of live authority: Oxy must still enforce the independently
approved private tuple, live binding/scopes, input/quote, daily/concurrency caps and
revocation; Kaana must verify the signed own-Mention permit. Alia's approval
cannot be substituted. No route, post, expiry, funding or review is supplied here.

The worker admits only the factory's frozen selection through the existing locked
claim, post/privacy recheck and exact request hash. Ordinary classification stays
independent. Expiry stops new claims and sends; the admitted evaluator retains
original-key receipt maintenance, including after expiry during its lifetime.
Restart recovery is independent of source admission. New claims persist nullable
`receiptAuthority.recovery` metadata in the existing JSON column: own owner,
model/deployment/policy/evaluation version, provider/price, exact key/fingerprint,
normalized input hash and source-approval digest. No DDL or invented backfill is
needed. A separate GET-only reader selects only complete own lineage and bounded
unresolved records. It does not load posts, inspect current private content,
reconstruct decisions or create claims. Missing/expired source approval disables
new inference but permits these existing own records to be read with the current
Mention service credential; Oxy still enforces live `inference:usage:read`.

Stored lineage is rechecked against the row before GET and under the final write
lock. The public record verifies own app/credential/environment/delegation,
resolved model, provider and price where returned. It does **not** expose deployment
or source-approval attestation; those remain retained historical metadata, not a
new claim of public receipt verification. NULL/unknown cost remains unknown.
Foreign, malformed and old metadata-free rows are not automatically selected
across restarts. A 403/404, mismatched receipt, deleted row, cancellation or deadline
leaves the original unresolved and never causes another inference POST.

The owner constant is a local selection restriction, not trusted authentication.
Oxy's canonical `readGenerationReceiptByIdempotencyKey` requires current
`inference:usage:read` and filters the settled row by verified
`principal.ownerAccountId`, application, credential, environment and exact
undelegated attribution. A changed/revoked binding cannot gain access from this
stored metadata or configuration. Recovery writes only `post_evaluations` usage
observation/state: no topics, ranking, post content or completed answer is applied.
A private or changed post may retain original operation accounting; deletion's
existing cascade removes the row and the final lock check prevents resurrection.
