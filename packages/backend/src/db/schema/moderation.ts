/**
 * Moderation: `reports`, `moderation_outbox`, `moderation_events`,
 * `moderation_enforcements`, `labelers` (+ their label definitions) and
 * `content_labels`.
 *
 * CrowdSource owns cases, reviews and decisions; Mention owns only its own
 * delivery state and its own enforcement actions. Three constraints in here are
 * load-bearing rather than tidy, and each says so at the site:
 *
 *  - `moderation_enforcements` unique `(decision_id, decision_revision, action)`
 *    — Appendix D's idempotency key. Without it a redelivered decision removes a
 *    post twice and a redelivered correction restores it twice.
 *  - `moderation_events.id` IS the webhook event id — the unique primary key IS
 *    the dedupe, which is why the store is Mongo/Postgres-backed rather than
 *    in-process (Mention runs several ECS tasks behind one ALB).
 *  - `reports` unique `(reporter, reported_id, reported_type)` — one report per
 *    reporter per object.
 *
 * `moderation_outbox.payload_decision` and `moderation_events.payload` stay
 * `jsonb` deliberately: §10.11 makes a published decision document LOOSE, and
 * projecting it into columns would silently drop whatever a newer CrowdSource
 * added — including a finding the enforcement mapping may later need. They are
 * validated against the contract when READ, not when stored.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from './columns';

/** `ReportedType` — the API contract, deliberately WIDER than what is delivered. */
export const REPORTED_TYPES = ['post', 'user', 'comment', 'message', 'room'] as const;

/** `ReportCategory`. */
export const REPORT_CATEGORIES = [
  'spam',
  'hate_speech',
  'harassment',
  'misinformation',
  'explicit_content',
  'other',
] as const;

/** `ReportStatus` — the legacy moderation-lifecycle axis. Derived, never hand-written. */
export const REPORT_STATUSES = ['pending', 'reviewed', 'resolved', 'dismissed'] as const;

/** `ModerationLocalStatus` — the delivery/integration axis (§14.3). */
export const REPORT_LOCAL_STATUSES = [
  'received',
  'queued',
  'submitted',
  'delivery_failed',
  'closed',
] as const;

/** `ModerationEnforcementAction`. */
export const MODERATION_ENFORCEMENT_ACTIONS = [
  'none',
  'restrict',
  'restore',
  'label_sensitive',
  'unlabel_sensitive',
  'manual_review',
] as const;

/** `ModerationEnforcementMode` — `CROWDSOURCE_ENFORCEMENT_MODE`. */
export const MODERATION_ENFORCEMENT_MODES = ['observe', 'manual', 'automatic'] as const;

/** `ModerationOutboxKind`. */
export const MODERATION_OUTBOX_KINDS = ['report.submit', 'decision.apply'] as const;

/**
 * `ModerationOutboxStatus`. `dead_letter` is the difference from
 * `engagement_outbox`: a 409 or a rejected envelope cannot succeed on retry, so
 * those events stop and stay visible to the reconciliation sweep instead of
 * hiding a defect behind a growing attempt count.
 */
export const MODERATION_OUTBOX_STATUSES = [
  'pending',
  'processing',
  'processed',
  'dead_letter',
] as const;

/** `ModerationEventState`. */
export const MODERATION_EVENT_STATES = ['claimed', 'queued', 'ignored'] as const;

/**
 * Retention ceilings, in seconds. `MODERATION_OUTBOX_RETENTION_SECONDS` is
 * longer than the engagement outbox's because a moderation case can legitimately
 * sit open for weeks and a `dead_letter` row is evidence somebody still has to
 * look at. Asserted equal to the Mongoose models' constants by test.
 */
export const MODERATION_OUTBOX_RETENTION_SECONDS = 90 * 24 * 60 * 60;
export const MODERATION_EVENT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/** `ILabelDefinition.severity`. */
export const LABEL_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

/** `ILabelDefinition.defaultAction`. */
export const LABEL_ACTIONS = ['show', 'warn', 'blur', 'hide'] as const;

/** `ContentLabel.targetType`. */
export const CONTENT_LABEL_TARGET_TYPES = ['post', 'user'] as const;

/**
 * `reports` — a receipt and an integration state, never a verdict.
 *
 * `categories` stays a `text[]`: a small unordered set from a closed vocabulary,
 * never joined and never queried by element in SQL. The CHECK constrains the
 * ELEMENTS and additionally requires at least one, which is the Mongoose
 * validator ("At least one category is required") expressed where it cannot be
 * bypassed by an update.
 */
export const reports = pgTable(
  'reports',
  {
    id: generatedId(),
    reportedType: text({ enum: REPORTED_TYPES }).notNull(),
    /** Polymorphic by `reported_type` — no foreign key is possible. */
    reportedId: text().notNull(),
    /** An Oxy account id — no foreign key. */
    reporter: text().notNull(),
    /**
     * The enum is declared for the ELEMENT type even though the CHECK below is
     * what Postgres enforces: it emits no DDL (drizzle's `text({ enum })` is a
     * TypeScript-level domain, the column is still `text[]`) and it is what lets
     * the backfill audit read the accepted set OFF THE COLUMN rather than
     * restating it. `allowedValues` reads through `.baseColumn` for exactly this.
     */
    categories: text({ enum: REPORT_CATEGORIES }).array().notNull(),
    details: text(),
    status: text({ enum: REPORT_STATUSES }).notNull().default('pending'),
    localStatus: text({ enum: REPORT_LOCAL_STATUSES }).notNull().default('received'),
    /** Why there is no durable route to CrowdSource, when `local_status` says so. */
    localStatusReason: text(),

    crowdSourceReportId: text(),
    crowdSourceCaseId: text(),
    /** Set when CrowdSource merged this report into an existing case (§7.3). */
    crowdSourceMerged: boolean(),
    submittedAt: timestamptz(),

    decisionId: text(),
    decisionRevision: integer(),
    decisionOutcome: text(),
    decisionStatus: text(),
    decidedAt: timestamptz(),

    enforcedAction: text({ enum: MODERATION_ENFORCEMENT_ACTIONS }),
    enforcedAt: timestamptz(),

    /**
     * SHA-256 of the exact material sent for review. A later edit changes it,
     * which is how a decision about an older version stays recognisable as being
     * about an older version (§5.6).
     */
    contentSnapshotHash: text(),
    /** Last delivery failure, truncated. Never carries reported material. */
    lastDeliveryError: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'reports_reported_type_check',
      sql`${t.reportedType} in (${sql.raw(inList(REPORTED_TYPES))})`
    ),
    check('reports_status_check', sql`${t.status} in (${sql.raw(inList(REPORT_STATUSES))})`),
    check(
      'reports_local_status_check',
      sql`${t.localStatus} in (${sql.raw(inList(REPORT_LOCAL_STATUSES))})`
    ),
    check(
      'reports_enforced_action_check',
      sql`${t.enforcedAction} is null or ${t.enforcedAction} in (${sql.raw(inList(MODERATION_ENFORCEMENT_ACTIONS))})`
    ),
    check(
      'reports_categories_check',
      sql`array_length(${t.categories}, 1) >= 1
        and ${t.categories} <@ array[${sql.raw(inList(REPORT_CATEGORIES))}]::text[]`
    ),
    check(
      'reports_decision_revision_check',
      sql`${t.decisionRevision} is null or ${t.decisionRevision} >= 1`
    ),
    unique('reports_reporter_reported_key').on(t.reporter, t.reportedId, t.reportedType),
    index('reports_reported_id_idx').on(t.reportedId),
    index('reports_reporter_idx').on(t.reporter),
    index('reports_case_id_idx')
      .on(t.crowdSourceCaseId)
      .where(sql`${t.crowdSourceCaseId} is not null`),
    // The reconciliation sweep scans by delivery state, oldest first (§14.4).
    index('reports_local_status_chrono_idx').on(t.localStatus, t.createdAt),
  ]
);

/**
 * `moderation_outbox` — moderation work that has to happen and has not yet.
 *
 * `id` is supplied by the writer, not generated: it IS the idempotency key
 * consumers use, and `enqueueModerationOutboxEvent` derives it deterministically
 * so a retry re-derives the same row. Hence a plain `text().primaryKey()` with
 * no default — a table whose id is caller-supplied says so by having no
 * generator (the same rule `link_previews.id` follows in the sibling port).
 */
export const moderationOutbox = pgTable(
  'moderation_outbox',
  {
    /** Caller-supplied and deterministic — see the docblock. */
    id: text().primaryKey(),
    kind: text({ enum: MODERATION_OUTBOX_KINDS }).notNull(),
    /** The local `reports.id`, for `report.submit`. */
    payloadReportId: text().references(() => reports.id, { onDelete: 'cascade' }),
    /** The inbound webhook event id, for `decision.apply` (Appendix D). */
    payloadEventId: text(),
    /** The CrowdSource case a decision belongs to. */
    payloadCaseId: text(),
    /** The decision exactly as published. Loose by contract — see the docblock. */
    payloadDecision: jsonb(),
    /**
     * §5.1 `urgency` — how far the material had travelled when the report was
     * TAKEN, composed by the subject provider at intake.
     *
     * It is STORED rather than measured at delivery, and that is the whole
     * reason the column exists. CrowdSource's ingress fingerprints the entire
     * `{ externalReportId, envelope }` to catch §10.5's "external id reused with
     * different content", so an audience count read afresh on each delivery
     * attempt turns an ordinary outbox retry into a permanent 409 — days later,
     * as moderation work stuck in a queue, with nothing failing at the moment
     * the mistake is made. This row is written once and never updated, which is
     * exactly the property the envelope needs.
     *
     * `jsonb` and NULLABLE, for the same reason `decision` is loose: it is
     * stored data whose schema belongs to CrowdSource, read back by a
     * deployment that need not be the one that wrote it.
     * `EvidenceSnapshotService` validates it against the published
     * `CaseUrgencySchema` on the way out. NULL is the absence — never `{}`,
     * which that strict schema rejects, so a subject with no defensible
     * audience must leave the column unset rather than store an empty object.
     */
    payloadUrgency: jsonb(),
    status: text({ enum: MODERATION_OUTBOX_STATUSES }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull().defaultNow(),
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastError: text(),
    processedAt: timestamptz(),
    /** Retention ceiling, swept by `db/expiry.ts`. */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'moderation_outbox_kind_check',
      sql`${t.kind} in (${sql.raw(inList(MODERATION_OUTBOX_KINDS))})`
    ),
    check(
      'moderation_outbox_status_check',
      sql`${t.status} in (${sql.raw(inList(MODERATION_OUTBOX_STATUSES))})`
    ),
    check('moderation_outbox_attempts_check', sql`${t.attempts} >= 0`),
    // Due work and expired claims are separate bounded scans.
    index('moderation_outbox_due_idx').on(t.status, t.availableAt, t.createdAt),
    index('moderation_outbox_lease_idx').on(t.status, t.leaseUntil, t.createdAt),
    // Required by the expiry sweep: its predicate is a range scan on this column.
    index('moderation_outbox_expires_at_idx').on(t.expiresAt),
  ]
);

/**
 * `moderation_events` — every webhook event CrowdSource has delivered here.
 *
 * `id` IS the event id (§10.8), so the primary key IS the dedupe: a redelivery
 * cannot insert a second row and `claim` therefore cannot succeed twice. Doing
 * this in the database rather than in the SDK's in-process store is not
 * optimisation — Mention runs several ECS tasks, and an in-process store would
 * dedupe only whichever task received both copies.
 */
export const moderationEvents = pgTable(
  'moderation_events',
  {
    /** The CrowdSource event id. Caller-supplied — this IS the dedupe. */
    id: text().primaryKey(),
    /** §10.6's event type, kept OPEN: an unknown type is recorded and ignored. */
    type: text(),
    caseId: text(),
    /** The event's `data`, exactly as delivered. Loose by contract. */
    payload: jsonb(),
    state: text({ enum: MODERATION_EVENT_STATES }).notNull().default('claimed'),
    receivedAt: timestamptz().notNull().defaultNow(),
    queuedAt: timestamptz(),
    /** Retention ceiling, swept by `db/expiry.ts`. */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'moderation_events_state_check',
      sql`${t.state} in (${sql.raw(inList(MODERATION_EVENT_STATES))})`
    ),
    index('moderation_events_case_id_idx')
      .on(t.caseId)
      .where(sql`${t.caseId} is not null`),
    // Operational: what arrived recently, and what never got past `claimed`.
    index('moderation_events_state_received_idx').on(t.state, t.receivedAt),
    index('moderation_events_expires_at_idx').on(t.expiresAt),
  ]
);

/**
 * `moderation_enforcements` — what Mention did about a decision, one row per
 * action, and the reason it is impossible to do twice.
 */
export const moderationEnforcements = pgTable(
  'moderation_enforcements',
  {
    id: generatedId(),
    decisionId: text().notNull(),
    decisionRevision: integer().notNull(),
    action: text({ enum: MODERATION_ENFORCEMENT_ACTIONS }).notNull(),

    caseId: text().notNull(),
    /** Mention's own noun (`post`), never a CrowdSource resource id. */
    subjectType: text().notNull(),
    /** Polymorphic by `subject_type` — no foreign key is possible. */
    subjectId: text().notNull(),

    outcome: text().notNull(),
    /** The recommendation it came from, when it came from one (§7.6). */
    recommendedAction: text(),
    /** Why this action, in words an operator can read. Never reported material. */
    reason: text().notNull(),

    mode: text({ enum: MODERATION_ENFORCEMENT_MODES }).notNull(),
    /**
     * Whether the effect was carried out. `false` for every action in `observe`
     * mode, which is the point of the mode: the plan is recorded and auditable
     * and nothing is removed.
     */
    applied: boolean().notNull().default(false),
    appliedAt: timestamptz(),
    /** Why an action was recorded but not carried out. */
    skippedReason: text(),

    /**
     * What to put back on a reversal. Only set for an action that changed state,
     * so an author's own content warning is not silently lifted by a moderation
     * correction that never set it.
     */
    previousStatePostStatus: text(),
    previousStateMetadataIsSensitive: boolean(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'moderation_enforcements_action_check',
      sql`${t.action} in (${sql.raw(inList(MODERATION_ENFORCEMENT_ACTIONS))})`
    ),
    check(
      'moderation_enforcements_mode_check',
      sql`${t.mode} in (${sql.raw(inList(MODERATION_ENFORCEMENT_MODES))})`
    ),
    check('moderation_enforcements_revision_check', sql`${t.decisionRevision} >= 1`),
    // Appendix D's key. Unique, and load-bearing: without it a redelivered
    // decision removes a post twice and a redelivered correction restores it
    // twice. `revision` is IN the key so a correction's `restore` is a different
    // action from the removal it supersedes.
    unique('moderation_enforcements_idempotency_key').on(
      t.decisionId,
      t.decisionRevision,
      t.action
    ),
    index('moderation_enforcements_case_id_idx').on(t.caseId),
    // Operational: what has been done to this object, newest first.
    index('moderation_enforcements_subject_idx').on(
      t.subjectType,
      t.subjectId,
      t.createdAt.desc()
    ),
  ]
);

/** `labelers` — a labelling authority a viewer can subscribe to. */
export const labelers = pgTable(
  'labelers',
  {
    id: generatedId(),
    name: text().notNull(),
    description: text(),
    /** An Oxy account id — no foreign key. */
    creatorId: text().notNull(),
    isOfficial: boolean().notNull().default(false),
    subscriberCount: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('labelers_subscriber_count_check', sql`${t.subscriberCount} >= 0`),
    index('labelers_creator_id_idx').on(t.creatorId),
  ]
);

/**
 * `labeler_label_definitions` — the `labelDefinitions[]` array.
 *
 * A definition is addressed by `(labeler, slug)` everywhere in the code, which
 * is what the unique below states; the embedded array could hold two rows with
 * the same slug and nothing would notice.
 */
export const labelerLabelDefinitions = pgTable(
  'labeler_label_definitions',
  {
    id: generatedId(),
    labelerId: text()
      .notNull()
      .references(() => labelers.id, { onDelete: 'cascade' }),
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    severity: text({ enum: LABEL_SEVERITIES }).notNull(),
    defaultAction: text({ enum: LABEL_ACTIONS }).notNull(),
    position: integer().notNull(),
  },
  (t) => [
    check(
      'labeler_label_definitions_severity_check',
      sql`${t.severity} in (${sql.raw(inList(LABEL_SEVERITIES))})`
    ),
    check(
      'labeler_label_definitions_default_action_check',
      sql`${t.defaultAction} in (${sql.raw(inList(LABEL_ACTIONS))})`
    ),
    check('labeler_label_definitions_position_check', sql`${t.position} >= 0`),
    unique('labeler_label_definitions_labeler_id_slug_key').on(t.labelerId, t.slug),
    unique('labeler_label_definitions_labeler_id_position_key').on(t.labelerId, t.position),
  ]
);

/**
 * `content_labels` — one labeler applied one label to one target.
 *
 * `labeler_id` is a REAL foreign key (a labeler is Mention's own model) with
 * CASCADE: a label from a deleted labeler enforces nothing and nothing can
 * resolve its definition. `target_id` is polymorphic by `target_type`, so it
 * carries none.
 */
export const contentLabels = pgTable(
  'content_labels',
  {
    id: generatedId(),
    labelerId: text()
      .notNull()
      .references(() => labelers.id, { onDelete: 'cascade' }),
    targetType: text({ enum: CONTENT_LABEL_TARGET_TYPES }).notNull(),
    /** A `posts.id` or an Oxy account id, by `target_type`. No foreign key. */
    targetId: text().notNull(),
    /** The `labeler_label_definitions.slug` this applies. */
    labelSlug: text().notNull(),
    /** An Oxy account id — no foreign key. */
    createdBy: text().notNull(),
    reason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'content_labels_target_type_check',
      sql`${t.targetType} in (${sql.raw(inList(CONTENT_LABEL_TARGET_TYPES))})`
    ),
    unique('content_labels_labeler_target_slug_key').on(
      t.labelerId,
      t.targetType,
      t.targetId,
      t.labelSlug
    ),
    // "What labels does this object carry" — the read-surface gate.
    index('content_labels_target_idx').on(t.targetType, t.targetId),
    index('content_labels_labeler_slug_idx').on(t.labelerId, t.labelSlug),
  ]
);
