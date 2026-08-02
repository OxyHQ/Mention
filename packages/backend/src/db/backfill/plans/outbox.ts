/**
 * The two durable work queues that are not federation delivery:
 * `engagement_outbox` and `endorsementoutboxes`.
 *
 * Both are LEASE-claimed, so both hold rows mid-flight at the instant the
 * migration runs. That is the interesting part of copying them: `lease_owner`
 * and `lease_until` are copied VERBATIM rather than cleared, because a lease is
 * a time-bounded claim and an expired one is reclaimable by design. Clearing
 * them would look tidier and would be wrong twice — it would let a second worker
 * claim a row the old one is still processing, and it would erase the only
 * evidence of which worker had it.
 *
 * ## `payload` becomes COLUMNS, and one leaf is deliberately dropped
 *
 * Mongo declared `EngagementOutbox.payload` as a nested object with eight named
 * leaves; eight of them are columns here. The ninth, `postAuthorship`, was
 * `[Schema.Types.Mixed]` — a SNAPSHOT of the post's authorship at emit time,
 * carried so a consumer need not re-read a post that may have changed. It is
 * reconstructible from `post_authorships`, so `schema/outbox.ts` DROPS it and
 * the consumer reads the rows instead.
 *
 * That drop is a schema decision, already made, not this file's to relitigate —
 * but it does mean this transform reads eight of nine leaves on purpose. It is
 * NOT a `dropped-document`: that finding counts documents that produce no ROW,
 * and every document here produces exactly one. A field the target schema does
 * not have is a different thing entirely from a row the copy lost, and conflating
 * them is how a real loss would get waved through.
 *
 * ## `engagement_outbox.id` is caller-supplied, and that is why it is `text`
 *
 * Its `_id` is a deterministic string (relationship id plus revision), not an
 * ObjectId — which is what makes a retry re-derive the same row rather than mint
 * a second event. `ownId` preserves either shape verbatim, so nothing special is
 * needed here; the fact is recorded because the id NOT being 24 hex characters
 * is otherwise surprising in this schema.
 */

import { endorsementOutbox, engagementOutbox } from '../../schema/outbox';
import { LIKE_VALUES } from '../../schema/engagement';
import type { CollectionPlan } from '../plan';
import { buildRow } from '../rowBuilder';
import { date, int, ownId, reqDate, reqId, reqInt, reqStr, str, strArray } from '../values';
import { optionalDate, timestamps } from './timestamps';

/** `engagement_outbox` → `engagement_outbox`. The collection name is explicit. */
const engagementOutboxPlan: CollectionPlan = {
  collection: 'engagement_outbox',
  table: engagementOutbox,
  enumAudits: [
    { path: 'kind', column: engagementOutbox.kind },
    { path: 'status', column: engagementOutbox.status, absentAs: 'pending' },
  ],
  numericAudits: [
    {
      path: 'revision',
      column: engagementOutbox.revision,
      constraint: 'engagement_outbox_revision_check',
      // `>= 1` here, unlike `likes.revision`'s `>= 0`. The two are genuinely
      // different: an outbox event is EMITTED by a transition, so there is no
      // revision-zero event to be legacy about, and the CHECK was never widened.
      min: 1,
    },
    {
      path: 'attempts',
      column: engagementOutbox.attempts,
      constraint: 'engagement_outbox_attempts_check',
      min: 0,
      absentAs: 0,
    },
    // `engagement_outbox_values_check` is `(x is null or x in (1,-1))` on BOTH
    // vote columns, and both are nullable — so the audit's null branch already
    // declines to report a null, and these two report only a real third value.
    // The accepted set is `LIKE_VALUES`, the same tuple `likes.value` uses,
    // because it is the same vote.
    {
      path: 'payload.previousValue',
      column: engagementOutbox.payloadPreviousValue,
      constraint: 'engagement_outbox_values_check',
      values: LIKE_VALUES,
    },
    {
      path: 'payload.value',
      column: engagementOutbox.payloadValue,
      constraint: 'engagement_outbox_values_check',
      values: LIKE_VALUES,
    },
  ],
  transform: (doc, emit) => {
    emit(
      engagementOutbox,
      buildRow(
        engagementOutbox,
        {
          // A deterministic STRING, not an ObjectId — see the module docblock.
          id: ownId(doc),
          kind: reqStr(doc, 'kind'),
          revision: reqInt(doc, 'revision'),

          // Mongo nests; Postgres flattens. The dotted path is the honest
          // description of where each value lives.
          payloadActorOxyUserId: reqStr(doc, 'payload.actorOxyUserId'),
          // `reqId`, not `reqStr`, even though the model declares both `String`:
          // they hold a stringified `posts._id` / `likes._id`, and a legacy
          // document that stored the ObjectId itself would make `reqStr` throw on
          // data the target can hold perfectly well. `reqId` accepts either and
          // preserves both verbatim.
          payloadPostId: reqId(doc, 'payload.postId'),
          payloadRelationshipId: reqId(doc, 'payload.relationshipId'),
          payloadPostOwnerOxyUserId: str(doc, 'payload.postOwnerOxyUserId'),
          payloadFederationActivityId: str(doc, 'payload.federationActivityId'),
          payloadPreviousValue: int(doc, 'payload.previousValue'),
          payloadValue: int(doc, 'payload.value'),
          // `payload.postAuthorship` is NOT read — see the module docblock.

          status: str(doc, 'status') ?? 'pending',
          attempts: int(doc, 'attempts') ?? 0,
          // The lease is copied verbatim, expired or not. See the docblock.
          leaseOwner: str(doc, 'leaseOwner'),
          leaseUntil: date(doc, 'leaseUntil'),
          lastError: str(doc, 'lastError'),
          processedAt: date(doc, 'processedAt'),
          // `NOT NULL` with no default and no substitute: a row whose retention
          // deadline is missing would be swept on an unknowable schedule, so it
          // has to be a loud failure rather than an invented `now()`.
          expiresAt: reqDate(doc, 'expiresAt'),
          ...optionalDate(doc, 'availableAt', 'availableAt'),
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/** `endorsementoutboxes` → `endorsement_outbox`. One row per scope. */
const endorsementOutboxPlan: CollectionPlan = {
  collection: 'endorsementoutboxes',
  table: endorsementOutbox,
  enumAudits: [
    { path: 'source', column: endorsementOutbox.source },
    { path: 'status', column: endorsementOutbox.status, absentAs: 'pending' },
  ],
  numericAudits: [
    {
      path: 'attempts',
      column: endorsementOutbox.attempts,
      constraint: 'endorsement_outbox_attempts_check',
      min: 0,
      absentAs: 0,
    },
  ],
  uniquenessAudits: [
    {
      index: 'endorsement_outbox_source_source_id_key',
      key: [
        { path: 'source', normalize: 'exact' },
        { path: 'sourceId', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    emit(
      endorsementOutbox,
      buildRow(
        endorsementOutbox,
        {
          id: ownId(doc),
          source: reqStr(doc, 'source'),
          // POLYMORPHIC by `source`: a `starter_packs.id` or an
          // `account_lists.id`. No foreign key, for the same reason
          // `notifications.entity_id` has none — the column names a row in one
          // of two tables and a constraint can only name one.
          sourceId: reqStr(doc, 'sourceId'),
          status: str(doc, 'status') ?? 'pending',
          attempts: int(doc, 'attempts') ?? 0,
          lastAttemptAt: date(doc, 'lastAttemptAt'),
          error: str(doc, 'error'),
          pendingRemoveOwnerId: str(doc, 'pendingRemoveOwnerId'),
          // `default: undefined` in the model, so the field is ABSENT rather
          // than `[]` on a row with nothing pending — and the column is
          // NULLABLE, unlike `mute_words.targets`. NULL is therefore the correct
          // copy: it means "no pending batch", where `{}` would mean "a batch
          // that removes nobody", and the drain reads them differently.
          pendingRemoveMemberIds: strArray(doc, 'pendingRemoveMemberIds'),
          ...optionalDate(doc, 'nextAttemptAt', 'nextAttemptAt'),
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/** Every outbox plan. */
export const OUTBOX_PLANS: readonly CollectionPlan[] = [
  engagementOutboxPlan,
  endorsementOutboxPlan,
];
