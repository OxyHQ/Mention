# Jev shadow lane

Mention evaluates recent native public posts with Kaana's `decisions` format
(Jev, served through Oxy's decisions profile) and keeps the answers in a
separate ledger, `post_evaluations`. It is **shadow only**: nothing reads the
ledger for ranking, admission or canonical topics. Wiring `feedValue`, spam and
topics into ranking is a later step and needs a reviewed topic list (today
`topics: []`).

## What is asked

`packages/backend/src/services/contentClassification/jevLane.ts` builds the lane
and `jevRequest.ts` beside it builds the request:

- independent `noul` propositions for spam, internal repetition and each of the
  post's canonical languages, plus one ordered five-level `feedScore` (stored as
  the expected level divided by four);
- **no `model`**: Oxy's decisions profile chooses, and the row records the model
  that answered (`resolved_model`) and the routing policy (`policy_ref`,
  `policy_version`). Analyse results per `resolved_model`;
- the primary author rendition, cut to 1,000 characters. The fingerprint still
  covers the full author content;
- `supportedLanguages`: en, es, ca, pt, fr, de, it. Jev is most accurate in
  English, so split any analysis by `languages`; other languages abstain for
  free.

`JEV_EVALUATION_VERSION` names the question set. Bump it whenever the questions,
languages or instructions change: a revision is evaluated once per version.

The SDK (`@kaana.ai/sdk` ≥ 3.2.0) validates the response against
`@kaana.ai/contracts` and refuses answers that do not answer these questions.

## When it runs

The lane is on whenever the process can authenticate to Oxy as Mention
(`canAuthenticateAsService()`). It has no environment switch, and it runs
whatever `POST_CLASSIFICATION_ENABLED` says. Oxy's grant decides whether a call
may run and what it costs.

Each five-minute `PostClassificationService` cycle, alongside canonical
classification:

1. **Candidates** (`listShadowCandidates`): posts that are native, public,
   published and not boosts, created in the last 24 hours, newest first, by an
   author whose profile is public, with no row for the current evaluation
   version. 25 at most.
2. **Daily limit**: `JEV_SHADOW_DAILY_LIMIT` (1,500) claims per UTC day,
   counted from today's rows (abstentions excluded). This is below the
   2,000/day cap on Oxy's `mention-kaana-decisions` relationship. At the limit
   the lane sleeps until the next UTC midnight.
3. **Claim, then call**: the insert into `post_evaluations` is the only
   authorization to call. It runs under `ON CONFLICT DO NOTHING` on
   `(post_id, fingerprint, evaluation_version)`, so a revision is sent at most
   once per version. The claim id is the request's `Idempotency-Key`. One cycle
   deadline (`config.inference.timeoutMs`) bounds the lane; a call that outlives
   it is aborted.
4. **Settle the outcome**:

   | What happened | Row | Lane |
   |---|---|---|
   | Answer written | `completed` | continues |
   | Post changed meanwhile | `cancelled` | continues |
   | The lane refused before anything ran (auth, permission or policy, `no_route_available`, a 503 `service_unavailable`) | deleted | stops for this cycle |
   | This request refused before it ran (`invalid_request`, `request_too_large`, `idempotency_conflict`) | `rejected` | stops for this cycle; never resent |
   | `rate_limited`, `quota_exceeded` or a spend limit | deleted | sleeps until the next UTC midnight |
   | Anything that may have run (`provider_error`, any 502 or 504, timeout, dropped connection, invalid output) | `cost_uncertain` | continues; never resent |

   A 502 or 504 is never a refusal, whatever its code: Kaana answers them after
   a provider ran, and Cloudflare in front of kaana.ai replaces their body, so
   the SDK reads a body-less `service_unavailable` for a call that may have run.
   Every failure is logged with its public code, status and Kaana request id,
   never its message. The classification is `classifyKaanaFailure` in
   `utils/kaana.ts`, the same one the translate endpoint maps onto HTTP.

   The SDK client is built with `maxRetries: 0`, so Mention never resends. Kaana
   retries and fails over on the provider side before any output.

## Privacy

Only posts written natively on Mention by an author with a public profile ever
leave for Kaana. The claim refuses all of these, and completion refuses them
again:

- a federated source: an inbound activity id, a remote actor URI, or an author
  account minted for a federated actor;
- any post with a `post_imports` row;
- an owner whose `privacy_profile_visibility` is `private` or `followers_only`.
  No settings row counts as public; a post with no owner fails closed.

The claim takes the content writers' lock order: the post's content lock, then
the post row, then the owner's `profile-visibility` advisory lock (shared). This
makes the profile check serialized with profile changes, not merely re-read.
Completion re-reads the snapshot under the same locks. A changed fingerprint,
including a profile made private, an import or an author edit, cancels the
result. A machine translation is never input and never changes the fingerprint.

## Usage reconciliation

A `cost_uncertain` or `cancelled` row, or a `claimed` row past its deadline, has
no answer, but its usage can still be read back. Each cycle reads up to 25 such
rows of the current version from the last 7 days. The read goes by the claim id
(`kaana.generations.getByIdempotencyKey`) on a private, cancellable connection,
and the generation record is stored in `usage_reconciliation`:

- request id, the model that served, attribution and units;
- the economics: a charge, or internal usage with its tariff;
- `providerCost: 'unknown'`.

Kaana answers only with Mention's own records. A 404 or 403 leaves the row
unchanged. Reconciliation never runs an evaluator and never restores an answer.

## Observability

`post_evaluation_total{outcome, model}` is published to CloudWatch
(`Mention/Backend`, EMF). Its outcomes are `completed`, `superseded`,
`cost_uncertain`, `refused`, `rejected`, `exhausted` and `released`. `model` is
the model that answered, or `none`.

## Storage

- `0058_jev_shadow_ledger` created `post_evaluations` and
  `post_evaluation_topics`.
- `0060` added the deadline, the reconciliation column and the historical
  `receipt_authority`.
- `0080_post_evaluations_profile`:
  - adds `resolved_model`;
  - makes `model` and `policy_*` NULL until completion;
  - requires `resolved_model` and the policy on completed rows;
  - moves the unique key to `(post_id, fingerprint, evaluation_version)`;
  - indexes `created_at` for the daily count.
- `0081_post_evaluations_rejected` adds the terminal `rejected` state.
- Post deletion cascades to both tables.
