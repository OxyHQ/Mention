/**
 * Moderation: `reports`, `moderation_outbox`, `moderation_events`,
 * `moderation_enforcements`, `labelers` (+ their label definitions) and
 * `contentlabels`.
 *
 * CrowdSource owns cases, reviews and decisions; Mention owns only its own
 * delivery state and its own enforcement actions. Four things here are decisions
 * rather than transcription:
 *
 * ## The queues are copied MID-FLIGHT, leases and all
 *
 * `moderation_outbox` is lease-claimed, so the copy runs while rows are held by
 * a live dispatcher. `lease_owner` and `lease_until` are copied VERBATIM rather
 * than cleared — same rule as `engagement_outbox`, and it matters more here: a
 * lease is a time-bounded claim that an expired one is reclaimable by design, so
 * clearing it would both let a second worker claim a row the old one is still
 * processing AND erase the only evidence of which worker had it. `attempts`,
 * `last_error` and a `dead_letter` status are likewise carried as-is: a
 * dead-lettered event is evidence somebody still has to look at, and a migration
 * that reset it would silently retire an open defect.
 *
 * ## `payload` / `payload.decision` stay LOOSE, and that needs `jsonValue`
 *
 * The schema keeps `moderation_outbox.payload_decision` and
 * `moderation_events.payload` as `jsonb` because §10.11 makes a published
 * decision document extensible — projecting it into columns would drop whatever
 * a newer CrowdSource added, including a finding the enforcement mapping may
 * later need. `jsonObject` would re-impose a shape the schema deliberately left
 * open and abort a run over a payload the column stores perfectly well, so these
 * two read through `jsonValue`. Every OTHER `payload.*` leaf IS flattened: those
 * are Mention's own fields with known types.
 *
 * ## `reports.categories` is auditable only HALF way, and the transform covers the rest
 *
 * `reports_categories_check` does two jobs in one CHECK: the elements must come
 * from `REPORT_CATEGORIES`, and there must be at least one. The element half IS
 * audited — Mongo's `distinct('categories')` returns the ELEMENTS of an array
 * field, and `allowedValues` reads the accepted set through the array column's
 * base column, so the audit reports an illegal category with a count and sample
 * ids like any other enum finding.
 *
 * The LENGTH half cannot be audited by that mechanism at all: an empty array
 * contributes no elements to `distinct`, so it is indistinguishable from a
 * document that simply has none. So the transform refuses one, with the query
 * that counts every other instance — a report with no category cannot be
 * delivered (§7.3's dedup key is computed over the sorted codes) and inventing
 * `other` would put words in the reporter's mouth.
 *
 * ## `labeler_label_definitions` is keyed by SLUG, and the array is not
 *
 * `LabelDefinitionSchema` is `{ _id: false }`, so these ids are derived. The
 * unique keys are `(labeler, slug)` and `(labeler, position)` — a definition is
 * addressed as `(labeler, slug)` everywhere in the code, while the embedded
 * array could hold the same slug twice and nothing would notice. Dedup is on the
 * SLUG and happens before positions are assigned, so the surviving positions
 * stay dense; deduping after would leave a gap that `ON CONFLICT DO NOTHING`
 * hides.
 */

import {
  contentLabels,
  labelerLabelDefinitions,
  labelers,
  moderationEnforcements,
  moderationEvents,
  moderationOutbox,
  reports,
} from '../../schema/moderation';
import type { CollectionPlan, Emit } from '../plan';
import { buildRow } from '../rowBuilder';
import {
  bool,
  childRowId,
  date,
  id,
  int,
  jsonValue,
  ownId,
  reqDate,
  reqId,
  reqInt,
  reqStr,
  str,
  strArray,
  subdocuments,
  type MongoDocument,
} from '../values';
import { optionalDate, timestamps } from './timestamps';

/** `reports` → `reports`. A receipt and an integration state, never a verdict. */
const reportsPlan: CollectionPlan = {
  collection: 'reports',
  table: reports,
  enumAudits: [
    { path: 'reportedType', column: reports.reportedType },
    { path: 'status', column: reports.status, absentAs: 'pending' },
    // Reports written before this field existed read as `received`, which is
    // exactly what they are: stored locally, never delivered.
    { path: 'localStatus', column: reports.localStatus, absentAs: 'received' },
    // NULLABLE, so the audit's null branch declines a null and this reports only
    // a real action the CHECK would refuse.
    { path: 'enforcedAction', column: reports.enforcedAction },
    // The ELEMENT half of `reports_categories_check` — see the module docblock
    // for the length half, which this cannot see.
    { path: 'categories', column: reports.categories },
  ],
  numericAudits: [
    {
      path: 'decisionRevision',
      column: reports.decisionRevision,
      constraint: 'reports_decision_revision_check',
      // `is null or >= 1`. A revision is assigned by a PUBLISHED decision, so
      // there is no revision zero to be legacy about.
      min: 1,
    },
  ],
  uniquenessAudits: [
    {
      // Mongo enforced this one too, so a collision here would mean the index
      // was missing or built after the duplicates. Audited anyway — an audit
      // that assumes an index was present is assuming the thing it checks.
      index: 'reports_reporter_reported_key',
      key: [
        { path: 'reporter', normalize: 'exact' },
        { path: 'reportedId', normalize: 'exact' },
        { path: 'reportedType', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    const reportId = ownId(doc);
    const categories = strArray(doc, 'categories') ?? [];
    if (categories.length === 0) {
      throw new Error(
        `reports ${reportId}: categories is empty, and reports_categories_check ` +
          'requires at least one. A report with no category cannot be delivered ' +
          "(§7.3's dedup key is computed over the sorted codes) and defaulting it " +
          "to 'other' would put a category in the reporter's mouth. Count every " +
          'instance with: db.reports.countDocuments({ $or: [ { categories: { ' +
          '$exists: false } }, { categories: { $size: 0 } } ] })'
      );
    }

    emit(
      reports,
      buildRow(
        reports,
        {
          id: reportId,
          reportedType: reqStr(doc, 'reportedType'),
          // POLYMORPHIC by `reported_type` — no foreign key is possible, and a
          // report about a deleted post must stay readable as a receipt.
          reportedId: reqStr(doc, 'reportedId'),
          reporter: reqStr(doc, 'reporter'),
          categories,
          details: str(doc, 'details'),
          status: str(doc, 'status') ?? 'pending',
          localStatus: str(doc, 'localStatus') ?? 'received',
          localStatusReason: str(doc, 'localStatusReason'),

          crowdSourceReportId: str(doc, 'crowdSourceReportId'),
          crowdSourceCaseId: str(doc, 'crowdSourceCaseId'),
          // Tri-state on purpose: absent means "never merged into a case", which
          // is NOT the same claim as `false` ("CrowdSource told us it opened a
          // new case"). The column is nullable for exactly that reason.
          crowdSourceMerged: bool(doc, 'crowdSourceMerged'),
          submittedAt: date(doc, 'submittedAt'),

          decisionId: str(doc, 'decisionId'),
          decisionRevision: int(doc, 'decisionRevision'),
          // No CHECK on either: they are a CACHE of a published revision, and
          // the vocabulary belongs to CrowdSource, not to this schema.
          decisionOutcome: str(doc, 'decisionOutcome'),
          decisionStatus: str(doc, 'decisionStatus'),
          decidedAt: date(doc, 'decidedAt'),

          enforcedAction: str(doc, 'enforcedAction'),
          enforcedAt: date(doc, 'enforcedAt'),

          contentSnapshotHash: str(doc, 'contentSnapshotHash'),
          lastDeliveryError: str(doc, 'lastDeliveryError'),
          ...timestamps(doc),
        },
        reportId
      )
    );
  },
};

/** `moderation_outbox` → `moderation_outbox`. The collection name is explicit. */
const moderationOutboxPlan: CollectionPlan = {
  collection: 'moderation_outbox',
  table: moderationOutbox,
  enumAudits: [
    { path: 'kind', column: moderationOutbox.kind },
    { path: 'status', column: moderationOutbox.status, absentAs: 'pending' },
  ],
  numericAudits: [
    {
      path: 'attempts',
      column: moderationOutbox.attempts,
      constraint: 'moderation_outbox_attempts_check',
      min: 0,
      absentAs: 0,
    },
  ],
  transform: (doc, emit) => {
    const eventId = ownId(doc);
    emit(
      moderationOutbox,
      buildRow(
        moderationOutbox,
        {
          // A DETERMINISTIC STRING, not an ObjectId: `enqueueModerationOutboxEvent`
          // derives it so a retry re-derives the same row rather than minting a
          // second event. `ownId` preserves either shape verbatim.
          id: eventId,
          kind: reqStr(doc, 'kind'),
          // A stringified `Report._id`, and a REAL foreign key here — so `reqId`'s
          // relative, `id`, which accepts a stored ObjectId as readily as a
          // string. Absent on a `decision.apply` row, which references no report.
          payloadReportId: id(doc, 'payload.reportId'),
          payloadEventId: str(doc, 'payload.eventId'),
          payloadCaseId: str(doc, 'payload.caseId'),
          // LOOSE by contract — see the module docblock.
          payloadDecision: jsonValue(doc, 'payload.decision'),

          status: str(doc, 'status') ?? 'pending',
          attempts: int(doc, 'attempts') ?? 0,
          // Copied verbatim, expired or not, and so is a `dead_letter` status.
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
        eventId
      )
    );
  },
};

/** `moderation_events` → `moderation_events`. The primary key IS the dedupe. */
const moderationEventsPlan: CollectionPlan = {
  collection: 'moderation_events',
  table: moderationEvents,
  enumAudits: [
    { path: 'state', column: moderationEvents.state, absentAs: 'claimed' },
    // `type` is NOT audited, and that is the schema's decision rather than an
    // omission: §10.6's event type is kept OPEN so an unknown type is recorded
    // and ignored instead of rejected, and the column carries no CHECK at all.
    // Auditing it would predict a constraint that does not exist.
  ],
  transform: (doc, emit) => {
    const eventId = ownId(doc);
    emit(
      moderationEvents,
      buildRow(
        moderationEvents,
        {
          // The CrowdSource EVENT id — a string, and the reason a redelivery
          // cannot insert a second row. Preserving it verbatim is what keeps the
          // dedupe true across the cutover: a webhook redelivered after the
          // migration must still collide with the row copied from before it.
          id: eventId,
          type: str(doc, 'type'),
          caseId: str(doc, 'caseId'),
          // LOOSE by contract — see the module docblock.
          payload: jsonValue(doc, 'payload'),
          state: str(doc, 'state') ?? 'claimed',
          queuedAt: date(doc, 'queuedAt'),
          expiresAt: reqDate(doc, 'expiresAt'),
          ...optionalDate(doc, 'receivedAt', 'receivedAt'),
          ...timestamps(doc),
        },
        eventId
      )
    );
  },
};

/** `moderation_enforcements` → `moderation_enforcements`. Appendix D's key. */
const moderationEnforcementsPlan: CollectionPlan = {
  collection: 'moderation_enforcements',
  table: moderationEnforcements,
  enumAudits: [
    { path: 'action', column: moderationEnforcements.action },
    { path: 'mode', column: moderationEnforcements.mode },
  ],
  numericAudits: [
    {
      path: 'decisionRevision',
      column: moderationEnforcements.decisionRevision,
      constraint: 'moderation_enforcements_revision_check',
      min: 1,
    },
  ],
  uniquenessAudits: [
    {
      // The one uniqueness audit here that is genuinely load-bearing: a
      // collision means two rows claim the same action on the same decision
      // revision, and the copy would drop one silently under
      // `ON CONFLICT DO NOTHING` — losing the record that an action happened
      // twice, which is precisely the defect this key exists to make impossible.
      index: 'moderation_enforcements_idempotency_key',
      key: [
        { path: 'decisionId', normalize: 'exact' },
        { path: 'decisionRevision', normalize: 'exact' },
        { path: 'action', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    const enforcementId = ownId(doc);
    emit(
      moderationEnforcements,
      buildRow(
        moderationEnforcements,
        {
          id: enforcementId,
          decisionId: reqStr(doc, 'decisionId'),
          decisionRevision: reqInt(doc, 'decisionRevision'),
          action: reqStr(doc, 'action'),
          caseId: reqStr(doc, 'caseId'),
          // Mention's own noun (`post`), never a CrowdSource resource id — and
          // polymorphic by it, so no foreign key.
          subjectType: reqStr(doc, 'subjectType'),
          subjectId: reqStr(doc, 'subjectId'),
          outcome: reqStr(doc, 'outcome'),
          recommendedAction: str(doc, 'recommendedAction'),
          reason: reqStr(doc, 'reason'),
          mode: reqStr(doc, 'mode'),
          // `NOT NULL DEFAULT false` on both sides. The default is the honest
          // one: `observe` mode records every action with `applied: false`.
          applied: bool(doc, 'applied') ?? false,
          appliedAt: date(doc, 'appliedAt'),
          skippedReason: str(doc, 'skippedReason'),
          // `previousState` is what makes a reversal real: it is set ONLY for an
          // action that changed state, so absent must stay NULL rather than
          // becoming a guessed `'published'` / `false`. Restoring from an
          // invented previous state would lift an author's own content warning
          // that no moderation action ever set.
          previousStatePostStatus: str(doc, 'previousState.postStatus'),
          previousStateMetadataIsSensitive: bool(doc, 'previousState.metadataIsSensitive'),
          ...timestamps(doc),
        },
        enforcementId
      )
    );
  },
};

/** `labelers` → `labelers` + `labeler_label_definitions`. */
const labelersPlan: CollectionPlan = {
  collection: 'labelers',
  table: labelers,
  childTables: [labelerLabelDefinitions],
  enumAudits: [
    // Paths INTO an array of subdocuments: `distinct` returns the elements'
    // values, which is exactly the set the child table's CHECK constrains.
    { path: 'labelDefinitions.severity', column: labelerLabelDefinitions.severity },
    { path: 'labelDefinitions.defaultAction', column: labelerLabelDefinitions.defaultAction },
  ],
  numericAudits: [
    {
      path: 'subscriberCount',
      column: labelers.subscriberCount,
      constraint: 'labelers_subscriber_count_check',
      // Mongo declares `default: 0` and NO `min`, so a decrement race could have
      // taken it negative and nothing would have objected — the same shape as
      // `starter_packs.useCount`.
      min: 0,
      absentAs: 0,
    },
  ],
  transform: (doc, emit) => {
    const labelerId = ownId(doc);
    emit(
      labelers,
      buildRow(
        labelers,
        {
          id: labelerId,
          name: reqStr(doc, 'name'),
          description: str(doc, 'description'),
          creatorId: reqStr(doc, 'creatorId'),
          isOfficial: bool(doc, 'isOfficial') ?? false,
          subscriberCount: int(doc, 'subscriberCount') ?? 0,
          ...timestamps(doc),
        },
        labelerId
      )
    );
    emitLabelDefinitions(doc, labelerId, emit);
  },
};

/**
 * `labelDefinitions[]` → `labeler_label_definitions`, deduped on SLUG.
 *
 * Two unique keys apply and they fail differently; the dedup key is the slug
 * rather than the whole row, because `(labeler, slug)` is how the code addresses
 * a definition. See the module docblock.
 */
function emitLabelDefinitions(doc: MongoDocument, labelerId: string, emit: Emit): void {
  const seen = new Set<string>();
  let position = 0;
  for (const [definition, ordinal] of subdocuments(doc, 'labelDefinitions')) {
    const slug = reqStr(definition, 'slug');
    if (seen.has(slug)) continue;
    seen.add(slug);
    emit(
      labelerLabelDefinitions,
      buildRow(
        labelerLabelDefinitions,
        {
          // `{ _id: false }` on the subschema, so this id is DERIVED. The
          // ORDINAL is what it derives from, not the post-dedup position: the
          // ordinal is a fact about the source array and cannot shift when an
          // earlier duplicate is removed, which keeps a re-run conflicting with
          // the row it already wrote.
          id: childRowId(definition, labelerId, 'labelDefinitions', ordinal),
          labelerId,
          slug,
          name: reqStr(definition, 'name'),
          description: str(definition, 'description'),
          severity: reqStr(definition, 'severity'),
          defaultAction: reqStr(definition, 'defaultAction'),
          position,
        },
        labelerId
      )
    );
    position += 1;
  }
}

/** `contentlabels` → `content_labels`. One labeler, one label, one target. */
const contentLabelsPlan: CollectionPlan = {
  collection: 'contentlabels',
  table: contentLabels,
  enumAudits: [{ path: 'targetType', column: contentLabels.targetType }],
  uniquenessAudits: [
    {
      index: 'content_labels_labeler_target_slug_key',
      key: [
        { path: 'labelerId', normalize: 'exact' },
        { path: 'targetType', normalize: 'exact' },
        { path: 'targetId', normalize: 'exact' },
        { path: 'labelSlug', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    const labelId = ownId(doc);
    emit(
      contentLabels,
      buildRow(
        contentLabels,
        {
          id: labelId,
          // A real `ObjectId` in Mongo (`ref: 'Labeler'`) and a real foreign key
          // here, CASCADE: a label from a deleted labeler enforces nothing and
          // nothing can resolve its definition.
          labelerId: reqId(doc, 'labelerId'),
          targetType: reqStr(doc, 'targetType'),
          // POLYMORPHIC by `target_type` — a `posts.id` or an Oxy account id.
          targetId: reqStr(doc, 'targetId'),
          // The `labeler_label_definitions.slug` this applies. NOT a foreign key
          // and deliberately so: a label whose definition was removed still
          // records that it was applied, which a constraint would delete.
          labelSlug: reqStr(doc, 'labelSlug'),
          createdBy: reqStr(doc, 'createdBy'),
          reason: str(doc, 'reason'),
          ...timestamps(doc),
        },
        labelId
      )
    );
  },
};

/** Every moderation plan. */
export const MODERATION_PLANS: readonly CollectionPlan[] = [
  reportsPlan,
  moderationOutboxPlan,
  moderationEventsPlan,
  moderationEnforcementsPlan,
  labelersPlan,
  contentLabelsPlan,
];
