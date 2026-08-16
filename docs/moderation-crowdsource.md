# Moderation (CrowdSource) — design detail

Deep detail behind the rules in `AGENTS.md` § Moderation (CrowdSource).
Reports leave Mention durably, CrowdSource decides them with a randomly
drawn jury, and decisions come back signed. CrowdSource owns cases, reviews
and decisions; Oxy Trust owns reputation; Mention owns only its own
enforcement actions and never computes reputation or calls Oxy Trust.

Code: `packages/backend/src/services/moderation/` plus three models
(`ModerationOutbox`, `ModerationEvent`, `ModerationEnforcement`) and one
route (`routes/crowdSourceWebhook.routes.ts`).

## Why the intake write must be one transaction

`ReportIntakeService` commits the `Report` and its `moderation_outbox` row
in ONE Postgres transaction (`db.transaction`); no outbound request is made
in the request handler. Whether a delivery event exists at all is decided
from ONE fact (a subject provider) read before the transaction body, so
`localStatus` and the outbox row can never disagree. Two writes outside one
transaction give two silent failure modes (a report nothing will ever send;
an event whose report was rolled back) and neither surfaces as an error
when it happens.

`enqueueModerationOutboxEvent` refuses the ROOT connection, not just a
missing session. The old Mongo invariant was `session.inTransaction()`: a
type made a session mandatory, a runtime check made it mandatory that a
transaction was actually OPEN, because a bare `startSession()` type-checks
and commits the row alone. Drizzle's `DatabaseOrTransaction` param has the
same hole and a wider one — the ROOT `Database` satisfies the type too, and
every repository here defaults to it, so forgetting the argument IS the
mistake. `requireTransaction()` (`db/moderation/transactionGuard.ts`)
discriminates by capability, not by name: the root database has no
`rollback`, a transaction (or nested savepoint) handle does, and it throws
`MissingTransactionError` when handed the former.

The upsert is `.onConflictDoNothing({ target: moderationOutbox.id })`, and a
repeated enqueue is a genuine no-op for a different structural reason than
the Mongo version worked to achieve. The Mongo write was
`{ upsert: true, session, timestamps: false }` with `createdAt`/`updatedAt`
explicit inside `$setOnInsert`, because `ModerationOutbox` declared
`{ timestamps: true }` and letting Mongoose add its own `updatedAt` on top
named that path twice in one update — Mongo refused the WHOLE write, taking
the `Report` down with it. Drizzle has no implicit timestamping on a
conflict branch: `$onUpdate` fires only for an `update()`, and
`onConflictDoNothing` writes nothing at all on a duplicate id.

## Enforcement modes and Mention's three primitives

`CROWDSOURCE_ENFORCEMENT_MODE` (`observe` | `manual` | `automatic`, default
`observe`). `observe` plans and RECORDS every action with `applied: false`
and removes nothing — the audit trail is real, so the mode proves what will
happen when it is switched off. `manual` additionally applies only the
give-something-back half (`restore`, `unlabel_sensitive`).

Mention maps `decision.recommendedActions`, not findings — the jury already
classified the material under a versioned policy, and re-deriving an action
from raw severity would be Mention re-deciding the case with a second
unversioned policy. Severity is a fallback only when a `violation` arrives
with no recommendation. The map lives in `enforcementPlan.ts`
(pure, table-tested):

- `restrict` → `Post.status = 'restricted'`. Every feed source and the
  post-hydration ACL already require `status: 'published'`, so this removes
  the post from discovery, ranking, search and every DTO with no feed query
  to edit, and the author's `visibility` choice survives for the restore.
- `label_sensitive` → `metadata.isSensitive`, which the existing
  `feedSafety` gate already reads. This is what `label`, `age_gate` and
  `reduce_distribution` all become — Mention has no separate distribution
  dial and recording an effect that did not happen would be worse than
  mapping honestly.
- `manual_review` → recorded, never executed. `suspend_user` is Oxy's to
  carry out, `legal_queue` needs a human.

`no_violation` always plans a `restore`, whatever it recommended — a
correction's recommendation is frequently `no_action`, which means "take no
NEW action". Mapping it straight through leaves the post its superseded
revision removed down forever, with no error anywhere.

## The subject-provider seam (what a second app writes)

`subjects/types.ts` is the whole per-application surface: given one of your
own nouns and its id, return a `ModerationSubjectSnapshot` (subject +
content + attachments + context) using the SDK's own input types.
Everything else — resource ids, relations, digests, pseudonymous principal
refs, the identity binding proof, the pinned policy version, privacy terms,
the idempotency key, the envelope — is composed by `@oxyhq/crowdsource`.

A provider returns a DESCRIPTION and never an envelope. The dedup key is
computed over exactly the values the SDK derives, so an app that composed
its own envelope would be the reason two reporters about one post open two
cases. Adding a noun = one provider file + one line in
`subjects/registry.ts`; nothing in the outbox, delivery worker, webhook
receiver, decision worker or enforcement service changes.

`EvidenceSnapshotService` builds the SDK's `ReportInput`, not a Case
Envelope. Nothing the builder composes may vary between two deliveries of
the same report — ingress fingerprints the whole envelope to detect a
payload conflict, so an invented timestamp, a random id or an unsorted list
turns a legitimate outbox retry into a permanent 409, silently, days later,
as a report stuck in a queue. Hence: `submittedAt` is the report's own
`createdAt`, allegation codes are sorted, and resource order is positional.

## Known gaps (deliberate, not oversights)

- **Media evidence is declared, not attached.** A post with no text gets a
  `metadata` subject resource saying what it consisted of, so a jury can
  answer `insufficient_context` for the right reason. `AssetRef` is
  `{ fileId, url?, mimeType, sha256, sizeBytes?, width?, height?,
  durationSeconds? }` — bytes go through the Oxy media chokepoint, and `url`
  is provenance no reviewer client ever dereferences. Mention already holds
  all of it: `MediaItem.id` IS the `fileId` (federated too, once the media
  cache rewrote it), and one batched `getServiceAssetMetadataByIds` returns
  the rest field-for-field. No byte fetching required. Closing it: one
  function in `postSubject.ts` + flip `evidenceAttachmentsSupported`. Two
  traps: the digest must enter the snapshot hash, and a federated item the
  cache never rewrote has a URL in `id` and no file id, so it must stay
  declared-only.
- **Mention only SENDS FOR REVIEW the objects it owns — `post`, `comment`,
  `user` — but it ACCEPTS every type in the enum.** Two questions, two
  authorities, and conflating them was tried and reverted: `ReportedType` is
  the API contract, `subjects/registry.ts` decides delivery. A type with a
  provider gets a `ModerationOutbox` row in the intake transaction and
  `localStatus: 'queued'`; a type without one is stored at
  `localStatus: 'received'` with `localStatusReason` saying why, and no
  outbox row is created at all. `POST /reports` only 400s a type the enum
  has never heard of.
  - Gating the route on the registry would make adopting CrowdSource a
    breaking change for every report surface an app has not yet wired up.
    Incremental adoption, one subject type at a time, is the property the
    other apps (Mercaria, Homiio, Allo, Noted, Moovo, Alia, Syra) need.
  - A live room has no provider, and would not gain one by trying harder:
    Mention owns the room experience but persists no Room document, so
    "pin the exact version reported" has nothing to pin short of capturing
    audio. `applicationId` comes off the credential, so the case would
    open in Mention's tenant naming an object only Syra can enforce
    against, and Syra reporting the same room under its own credential
    gets a different dedup key — two cases, two juries, two consequences.
  - A `received` report is a receipt for work nobody does.
    `reconcileModerationReports` COUNTS them (`localOnly`) and must never
    re-queue one — the sweep's `$in` is `['queued','delivery_failed']` and
    adding `'received'` sends every local-only report to the dead-letter
    queue.
- **A restricted post is invisible to everyone but its author.** There is
  no author-facing "your post was removed" surface yet; build one before
  `automatic` mode is enabled for real.

## Environment

```
CROWDSOURCE_ENABLED=false
CROWDSOURCE_SERVICE_KEY=            # applicationId:credentialId:secret, ONE opaque value
CROWDSOURCE_BASE_URL=               # optional; the SDK defaults to the one deployment
CROWDSOURCE_WEBHOOK_SECRET=
CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS=   # both accepted during a rotation
CROWDSOURCE_OUTBOX_BATCH_SIZE=50
CROWDSOURCE_OUTBOX_POLL_INTERVAL_MS=5000
CROWDSOURCE_ENFORCEMENT_MODE=observe
```

`applicationId` is read off the credential — a `CROWDSOURCE_APP_ID` variable
could only ever disagree with it, hence there is none.

## Lifecycle

- `moderationOutboxDispatcher` starts on EVERY task (`server.ts`, next to
  `engagementOutboxDispatcher`): claims are `SELECT ... FOR UPDATE SKIP
  LOCKED` over Postgres (ported from Mongo's atomic `findOneAndUpdate` over
  a disjunctive filter), so N tasks share the work and a dead task's
  expired lease is reclaimed. No-ops when `CROWDSOURCE_ENABLED=false` — the
  LOOP is gated, never the durable record, so reports taken while off
  deliver when it is switched on.
- `moderationReconciliationJob` is leader-gated, 15-minute sweep: re-derives
  a missing delivery event with the same deterministic id, COUNTS
  dead-lettered ones (re-queueing would spin) and counts cases gone quiet.
- The webhook dedupe store is Postgres-backed
  (`services/moderation/moderationEventStore.ts`) because Mention runs
  several ECS tasks; the SDK's in-process default would dedupe only the
  instance that received both copies of a redelivery. `moderation_events.id`
  IS the webhook event id.


## Moderation (CrowdSource) — the rules that were in `AGENTS.md`

> Moved out of `AGENTS.md` unchanged, so the rule and its detail sit together.

CrowdSource owns cases and decisions; Oxy Trust owns reputation; Mention owns only its own enforcement. Code: `services/moderation/`, three models, `routes/crowdSourceWebhook.routes.ts`. Design rationale and the full enforcement-mode map: `docs/moderation-crowdsource.md`.

- **A 201 from `POST /reports` means stored, never accepted by CrowdSource.** The report and its outbox row commit in ONE transaction; `enqueueModerationOutboxEvent` throws unless handed a real transaction handle (`requireTransaction()`), never just a session.
- **The webhook route MUST stay mounted before `express.json()`** (guarded by a test in `appFactory.test.ts`) — the signature covers the raw bytes.
- **Enforcement is idempotent on `decisionId + revision + action`**, claimed before acting and released if the effect throws. `revision` is in the key so an appeal's `restore` can supersede a removal.
- **`no_violation` always plans a `restore`** whatever it recommended — do not "simplify" that away. The recommendation→action map lives in `services/moderation/enforcementPlan.ts` (pure, table-tested).
- **A reported type with no subject provider is stored locally, NOT refused, and gets NO outbox row.** Never re-queue a `received` report — the sweep's `$in` is `['queued','delivery_failed']`.
- **Nothing the envelope builder composes may vary between two deliveries of one report** — ingress fingerprints it, so an invented timestamp or unsorted list turns a retry into a permanent 409.
- **There is no `CROWDSOURCE_APP_ID` and never add one** (`applicationId` is read off the credential). `CROWDSOURCE_ENABLED=true` requires both the service key and the webhook secret. The dispatcher gates the LOOP, never the durable record.
- **Known gap:** media evidence is declared, not attached, and a restricted post has no author-facing surface — build one before enabling `automatic`.
