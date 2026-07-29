import mongoose, { Document, Schema } from 'mongoose';

/**
 * Every webhook event CrowdSource has delivered to this deployment.
 *
 * Two jobs, and they are the same document on purpose (§14.4's `ModerationEvent`).
 *
 * **Deduplication.** §10.8 requires a receiver to record the processed event id.
 * `_id` IS the event id, so the unique index on it is the dedupe: a redelivery
 * cannot insert a second row, and `claim` therefore cannot succeed twice. Doing
 * this in Mongo rather than in the SDK's default in-process store is not
 * optimisation — Mention runs several ECS tasks behind one ALB, and an in-process
 * store would dedupe only whichever task happened to receive both copies.
 *
 * **Audit.** What arrived, when, and whether it was acted on. `payload` is the
 * event's `data` exactly as delivered: §10.11 makes those payloads loose, so
 * projecting them into columns would silently drop whatever a newer CrowdSource
 * added.
 *
 * The stored payload is a decision — an outcome, findings, policy versions, a jury
 * summary. It is not the reported material and must not become a place where
 * reported material is kept: nothing in this collection is read into a log line.
 */
export type ModerationEventState = 'claimed' | 'queued' | 'ignored';

export interface IModerationEvent extends Document<string> {
  _id: string;
  /** §10.6's event type, kept open: an unknown type is recorded and ignored. */
  type?: string;
  caseId?: string;
  payload?: unknown;
  state: ModerationEventState;
  receivedAt: Date;
  queuedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Retention.
 *
 * §10.9's retry schedule ends at 24 hours, so a dedupe row only has to outlive
 * that. It is kept far longer because the row is also the audit trail of what a
 * third party told this deployment to do, and an enforcement question asked weeks
 * later is answered from here.
 */
export const MODERATION_EVENT_RETENTION_SECONDS = 90 * 24 * 60 * 60;
export const MODERATION_EVENT_COLLECTION = 'moderation_events';

const ModerationEventSchema = new Schema<IModerationEvent>(
  {
    _id: { type: String, required: true },
    type: { type: String },
    caseId: { type: String, index: true },
    payload: { type: Schema.Types.Mixed },
    state: {
      type: String,
      required: true,
      enum: ['claimed', 'queued', 'ignored'],
      default: 'claimed',
    },
    receivedAt: { type: Date, required: true, default: Date.now },
    queuedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: MODERATION_EVENT_COLLECTION },
);

ModerationEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Operational: what arrived recently, and what never got past `claimed`.
ModerationEventSchema.index({ state: 1, receivedAt: 1 });

export const ModerationEvent = mongoose.model<IModerationEvent>(
  'ModerationEvent',
  ModerationEventSchema,
);

export default ModerationEvent;
