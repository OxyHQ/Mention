import mongoose, { Document, Schema } from 'mongoose';

/**
 * The durable record of moderation work that has to happen but has not happened
 * yet.
 *
 * This collection is what makes §7.1's guarantee true. A 201 from `POST /reports`
 * means the report and its outbox event committed in ONE transaction — not that a
 * call to CrowdSource succeeded. Delivery is a separate, retried step, and the
 * user is never made to wait for a third party to be reachable.
 *
 * The same shape carries work in the other direction. A decision arriving over a
 * webhook is answered 2xx as soon as it is recorded here (§10.8), and applied
 * afterwards. Nothing is enqueued that is not already written down: if the
 * dispatcher, the process or the whole task disappears, every pending piece of
 * moderation work is re-derivable by reading this collection.
 *
 * Modelled on `EngagementOutbox` deliberately — same lease-based claim, same
 * `_id`-as-idempotency-key contract — so a reader who knows one knows both.
 */
export type ModerationOutboxKind = 'report.submit' | 'decision.apply';

/**
 * `dead_letter` is the difference from `EngagementOutbox`.
 *
 * The SDK answers one question about every failure: can re-delivering the same
 * payload still succeed. A 409 (§10.5's "external id reused with a different
 * body") or a rejected envelope cannot, so retrying it forever would hide a
 * defect behind an ever-growing attempt count. Those events stop, keep their
 * error, and are visible to the reconciliation sweep.
 */
export type ModerationOutboxStatus = 'pending' | 'processing' | 'processed' | 'dead_letter';

export interface ModerationOutboxPayload {
  /** The local `Report._id`, for `report.submit`. */
  reportId?: string;
  /** The inbound webhook event id, for `decision.apply` (Appendix D). */
  eventId?: string;
  /** The CrowdSource case a decision belongs to. */
  caseId?: string;
  /**
   * The decision exactly as CrowdSource published it.
   *
   * Stored whole and opaque rather than projected into columns: §10.11 makes the
   * decision document loose, and a projection would silently drop whatever a
   * newer CrowdSource added — including a finding field the enforcement mapping
   * may later need. It is validated against the published contract when it is
   * read, not when it is stored, so an event is never lost to a schema this
   * deployment has not caught up with.
   */
  decision?: unknown;
}

export interface IModerationOutbox extends Document<string> {
  _id: string;
  kind: ModerationOutboxKind;
  payload: ModerationOutboxPayload;
  status: ModerationOutboxStatus;
  attempts: number;
  availableAt: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  lastError?: string;
  processedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Retention ceiling, so a stalled dispatcher cannot turn the outbox into an
 * unbounded collection. Longer than `EngagementOutbox`'s 30 days because a
 * moderation case can legitimately sit open for weeks and a `dead_letter` event
 * is evidence somebody still has to look at. Operational alerts must fire long
 * before this deadline.
 */
export const MODERATION_OUTBOX_RETENTION_SECONDS = 90 * 24 * 60 * 60;
export const MODERATION_OUTBOX_COLLECTION = 'moderation_outbox';

const ModerationOutboxSchema = new Schema<IModerationOutbox>(
  {
    _id: { type: String, required: true },
    kind: {
      type: String,
      required: true,
      enum: ['report.submit', 'decision.apply'],
    },
    payload: {
      reportId: { type: String },
      eventId: { type: String },
      caseId: { type: String },
      decision: { type: Schema.Types.Mixed },
    },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'processing', 'processed', 'dead_letter'],
      default: 'pending',
    },
    attempts: { type: Number, required: true, default: 0 },
    availableAt: { type: Date, required: true, default: Date.now },
    leaseOwner: { type: String },
    leaseUntil: { type: Date },
    lastError: { type: String },
    processedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: MODERATION_OUTBOX_COLLECTION },
);

// Due work and expired claims are separate bounded scans.
ModerationOutboxSchema.index({ status: 1, availableAt: 1, createdAt: 1 });
ModerationOutboxSchema.index({ status: 1, leaseUntil: 1, createdAt: 1 });
ModerationOutboxSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ModerationOutbox = mongoose.model<IModerationOutbox>(
  'ModerationOutbox',
  ModerationOutboxSchema,
);

export default ModerationOutbox;
