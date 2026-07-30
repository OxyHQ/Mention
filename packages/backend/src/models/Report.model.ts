import mongoose, { Schema, Document } from "mongoose";
import type {
  ModerationEnforcementAction,
  ModerationLocalStatus,
} from '@mention/shared-types';

/**
 * A report is a receipt and an integration state, never a verdict.
 *
 * CrowdSource owns cases, reviews and decisions (§14.3); this collection keeps
 * what Mention needs to answer its own reporter, drive its own delivery and
 * record its own enforcement. Nothing here is the source of truth for whether a
 * rule was broken, and the decision fields below are a CACHE of a published
 * revision — overwritten by a later revision, never edited in place.
 *
 * The evolution is additive on purpose. `status` keeps its meaning and its
 * default for every client already reading it; `localStatus` is the new axis, and
 * the two are only ever written together through
 * `services/moderation/reportStatus.ts`.
 */
/**
 * The objects Mention accepts reports about.
 *
 * This is the API contract, and it is deliberately WIDER than the set of types that
 * reach CrowdSource. Whether a report can be sent for review is a property of
 * `services/moderation/subjects/registry.ts` — a type with a subject provider is
 * delivered, a type without one is stored locally and nothing more. Rejecting the
 * types with no provider was tried and reverted: it breaks the application's own
 * existing report surfaces the moment the integration is adopted, which is the one
 * property that has to hold for the other six Oxy apps to adopt it incrementally.
 *
 * `ROOM` is the case that forced the distinction. Mention owns the live-room
 * EXPERIENCE (`LiveRoomContext`, the room UI) but persists no Room document, so
 * there is nothing to snapshot and §5.6's "pin the exact version reported" cannot be
 * satisfied without capturing audio. A room report is therefore genuinely local-only.
 *
 * `MESSAGE` predates all of this and has never had a caller in Mention's UI (direct
 * messages are Allo's). It is kept because removing an enum value is a destructive
 * change to stored documents, not because anything can produce one.
 */
export enum ReportedType {
  POST = 'post',
  USER = 'user',
  COMMENT = 'comment',
  MESSAGE = 'message',
  ROOM = 'room'
}

export enum ReportCategory {
  SPAM = 'spam',
  HATE_SPEECH = 'hate_speech',
  HARASSMENT = 'harassment',
  MISINFORMATION = 'misinformation',
  EXPLICIT_CONTENT = 'explicit_content',
  OTHER = 'other'
}

export enum ReportStatus {
  PENDING = 'pending',
  REVIEWED = 'reviewed',
  RESOLVED = 'resolved',
  DISMISSED = 'dismissed'
}

/** §14.3's local integration states. The union lives in `@mention/shared-types`. */
export const REPORT_LOCAL_STATUSES: readonly ModerationLocalStatus[] = [
  'received',
  'queued',
  'submitted',
  'delivery_failed',
  'closed',
];

export const REPORT_ENFORCEMENT_ACTIONS: readonly ModerationEnforcementAction[] = [
  'none',
  'restrict',
  'restore',
  'label_sensitive',
  'unlabel_sensitive',
  'manual_review',
];

/**
 * A report's stored fields, without the Document machinery.
 *
 * The read paths use `.lean()`, and a lean document is NOT an `IReport` — it has no
 * `save`, no `id` getter and no virtuals. Typing one as `IReport` would be a claim
 * the runtime does not honour, and `report.id` on a lean row is `undefined` rather
 * than a type error. So the fields live here and `IReport` adds `Document` to them.
 */
export interface ReportFields {
  reportedType: ReportedType;
  reportedId: string;
  reporter: string;
  categories: ReportCategory[];
  details?: string;
  /** Legacy moderation-lifecycle axis. Derived, never hand-written. */
  status: ReportStatus;
  /** Delivery/integration axis (§14.3). */
  localStatus: ModerationLocalStatus;
  /** Why there is no durable route to CrowdSource, when `localStatus` says so. */
  localStatusReason?: string;

  crowdSourceReportId?: string;
  crowdSourceCaseId?: string;
  /** Set when CrowdSource merged this report into an existing case (§7.3). */
  crowdSourceMerged?: boolean;
  submittedAt?: Date;

  decisionId?: string;
  decisionRevision?: number;
  decisionOutcome?: string;
  decisionStatus?: string;
  decidedAt?: Date;

  enforcedAction?: ModerationEnforcementAction;
  enforcedAt?: Date;

  /**
   * SHA-256 of the exact material that was sent for review. A later edit changes
   * it, which is how a decision about an older version stays recognisable as
   * being about an older version (§5.6).
   */
  contentSnapshotHash?: string;
  /** Last delivery failure, truncated. Never carries reported material. */
  lastDeliveryError?: string;

  createdAt: Date;
  updatedAt: Date;
}

/** A lean report row, as every read path returns it. */
export interface LeanReport extends ReportFields {
  _id: mongoose.Types.ObjectId;
}

export interface IReport extends ReportFields, Document {}

const ReportSchema = new Schema({
  reportedType: {
    type: String,
    enum: Object.values(ReportedType),
    required: true
  },
  reportedId: {
    type: String,
    required: true,
    index: true
  },
  reporter: {
    type: String,
    required: true,
    index: true
  },
  categories: {
    type: [String],
    enum: Object.values(ReportCategory),
    required: true,
    validate: {
      validator: (v: string[]) => v && v.length > 0,
      message: 'At least one category is required'
    }
  },
  details: {
    type: String,
    maxlength: 500
  },
  status: {
    type: String,
    enum: Object.values(ReportStatus),
    default: ReportStatus.PENDING,
    index: true
  },
  // Reports written before this field existed read as `received`, which is
  // exactly what they are: stored locally, never delivered.
  localStatus: {
    type: String,
    enum: REPORT_LOCAL_STATUSES,
    default: 'received',
    required: true,
    index: true
  },
  localStatusReason: { type: String, maxlength: 300 },

  crowdSourceReportId: { type: String },
  crowdSourceCaseId: { type: String, index: true },
  crowdSourceMerged: { type: Boolean },
  submittedAt: { type: Date },

  decisionId: { type: String },
  decisionRevision: { type: Number, min: 1 },
  decisionOutcome: { type: String },
  decisionStatus: { type: String },
  decidedAt: { type: Date },

  enforcedAction: { type: String, enum: REPORT_ENFORCEMENT_ACTIONS },
  enforcedAt: { type: Date },

  contentSnapshotHash: { type: String },
  lastDeliveryError: { type: String, maxlength: 2_000 }
}, {
  timestamps: true
});

// Compound unique index to prevent duplicate reports
ReportSchema.index({ reporter: 1, reportedId: 1, reportedType: 1 }, { unique: true });
// The reconciliation sweep scans by delivery state, oldest first (§14.4).
ReportSchema.index({ localStatus: 1, createdAt: 1 });

export default mongoose.model<IReport>("Report", ReportSchema);
