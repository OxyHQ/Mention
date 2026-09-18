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

Enforcement itself is idempotent on `decisionId + revision + action` —
claimed before acting and released if the effect throws. `revision` is in
the key so an appeal's `restore` can supersede an earlier removal rather
than being treated as a duplicate of it.

## The subject-provider seam (what a second app writes)

`subjects/types.ts` is the whole per-application surface: given one of your
own nouns and its id, return a `ModerationSubjectSnapshot` (subject +
content + attachments + context) using the SDK's own input types.
Everything else — resource ids, relations, digests, pseudonymous principal
refs, the identity binding proof, the pinned policy version, privacy terms,
the idempotency key, the envelope — is composed by `@oxy.so/crowdsource`.

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
CROWDSOURCE_BASE_URL=               # optional; the SDK defaults to the one deployment
CROWDSOURCE_WEBHOOK_SECRET=
CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS=   # both accepted during a rotation
CROWDSOURCE_OUTBOX_BATCH_SIZE=50
CROWDSOURCE_OUTBOX_POLL_INTERVAL_MS=5000
CROWDSOURCE_ENFORCEMENT_MODE=observe
```

There is no `CROWDSOURCE_ENABLED` and no `CROWDSOURCE_SERVICE_KEY`. Mention is
one of Oxy's own services: it presents the Oxy service token its infrastructure
already issues, and CrowdSource resolves the tenant from the Oxy application that
token names ([oxy ADR 0026][adr-0026]). There is no key to hold, so the only
thing a flag could still mean is "can this process authenticate" — which is a
fact about where it runs, not something to type. `crowdSourceClient.ts` answers
it: in ECS the task role attests, elsewhere the service api key does, and a local
checkout can do neither.

`applicationId` is absent for the reason it always was: the application is
whatever the identity resolves to, and a variable holding it could only ever
disagree. The client asks `GET /v1/applications/me` once and remembers.

The webhook secret stays, and is the one thing here that is genuinely
configuration: CrowdSource issues it per endpoint to sign what it sends back. It
is not an identity, nothing authenticates with it, and it gates only the
DELIVERY loop — a report that leaves with no way to verify the decision coming
back is worse than one held locally.

[adr-0026]: https://github.com/OxyHQ/oxy/blob/main/docs/adr/0026-first-party-services-authenticate-as-workloads.md

## Lifecycle

- `moderationOutboxDispatcher` starts on EVERY task (`server.ts`, next to
  `engagementOutboxDispatcher`): claims are `SELECT ... FOR UPDATE SKIP
  LOCKED` over Postgres (ported from Mongo's atomic `findOneAndUpdate` over
  a disjunctive filter), so N tasks share the work and a dead task's
  expired lease is reclaimed. No-ops where the deployment cannot deliver —
  the LOOP is gated, never the durable record, so reports taken while it
  could not deliver go out once it can.
- `moderationReconciliationJob` is leader-gated, 15-minute sweep: re-derives
  a missing delivery event with the same deterministic id, COUNTS
  dead-lettered ones (re-queueing would spin) and counts cases gone quiet.
- The webhook dedupe store is Postgres-backed
  (`services/moderation/moderationEventStore.ts`) because Mention runs
  several ECS tasks; the SDK's in-process default would dedupe only the
  instance that received both copies of a redelivery. `moderation_events.id`
  IS the webhook event id.
- **The webhook route MUST stay mounted before `express.json()`** — its
  signature covers the raw request bytes, so a body parser ahead of it
  would consume them first. Guarded by a test in `appFactory.test.ts`.

## Switching it on

As of 2026-09-18 the Mention ECS task definition carries **no `CROWDSOURCE_*`
variable at all** and `/oxy/mention/` holds no CrowdSource parameter, so nothing
is talking to anything. That is not a broken state: intake stores reports either
way and the outbox delivers them once the deployment can, which is what the
gating is for.

What is left is smaller than it used to be, because there is no credential to
issue and nowhere to put one.

1. **Bind Mention to its CrowdSource tenant.** One row, written by a one-off ECS
   task inside the VPC — there is no console click and no secret:

   ```
   node dist/scripts/bootstrapFirstParty.js --name Mention --oxy-application-id <mention's oxy application id>
   ```

   Idempotent: it reuses the `oxy` organization and an existing binding, and
   refuses only when that Oxy application is already bound to a different
   CrowdSource application. Until this row exists, Mention's token authenticates
   nothing — proving what you are is not the same as being one of ours.

   Scopes are not part of this step. A first-party service holds every scope an
   application credential may hold and no privileged one; there is nothing to
   tick.

2. **Register the webhook endpoint** at
   `https://api.mention.earth/webhooks/crowdsource`, subscribed to
   `case.decided`, `decision.corrected`, `appeal.decided` and
   `community_note.status_changed`, and keep its secret — this is the one secret
   the integration still has, and it signs what CrowdSource sends back rather
   than proving who Mention is.

3. **In AWS** (`us-west-2`, account `237343248947`): store that secret as the SSM
   `SecureString` `/oxy/mention/CROWDSOURCE_WEBHOOK_SECRET` and add it to the
   `oxy-mention` task definition's `secrets`. `deploy-ecs-image.sh` mutates the
   existing revision rather than rendering one from this repo, so this is an
   AWS-side edit and not a PR.

   Nothing else is added. There is no flag to set to `true`, and
   `CROWDSOURCE_ENFORCEMENT_MODE` already defaults to `observe`.

4. **Verify** without waiting for a report:
   `GET /api/community-notes/availability` answers `{"enabled":true}` once the
   client builds, and the boot log carries `[CrowdSource] client ready` with the
   application id the binding resolved to. A deployment that can mint a token but
   was never bound logs `client built but the tenant did not resolve` instead,
   which is the failure this step exists to catch.

Community notes work from step 1 alone: they are a request and its answer, with
no webhook in the path. Reports wait for step 3 — and the backlog goes out on
the first tick after it, which on a deployment that has been taking reports for
a while is not a small number of deliveries.

Leave enforcement in `observe` until the author-facing "your post was restricted"
surface exists — see the gaps above.
