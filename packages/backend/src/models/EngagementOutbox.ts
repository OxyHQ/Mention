import mongoose, { Document, Schema } from 'mongoose';

/**
 * Durable domain events emitted by engagement commands.
 *
 * Like/save side effects (MTN records, federation and notifications) are
 * intentionally downstream of the transaction that owns the relationship and
 * counter. Consumers must therefore use `_id` as their idempotency key: claims
 * are at-least-once and an expired lease may be reclaimed after a worker dies.
 */
export type EngagementOutboxKind =
  | 'post.like'
  | 'post.unlike'
  | 'post.downvote'
  | 'post.undownvote'
  | 'post.save'
  | 'post.unsave';

export type EngagementOutboxStatus = 'pending' | 'processing' | 'processed';

export interface EngagementOutboxPayload {
  actorOxyUserId: string;
  postId: string;
  relationshipId: string;
  postOwnerOxyUserId?: string;
  postAuthorship?: unknown[];
  federationActivityId?: string;
  previousValue?: 1 | -1 | null;
  value?: 1 | -1 | null;
}

export interface IEngagementOutbox extends Document<string> {
  _id: string;
  kind: EngagementOutboxKind;
  revision: number;
  payload: EngagementOutboxPayload;
  status: EngagementOutboxStatus;
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
 * All events have a hard retention ceiling. This keeps a stalled dispatcher
 * from turning the outbox itself into an unbounded collection; operational
 * alerts must fire well before this deadline.
 */
export const ENGAGEMENT_OUTBOX_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const ENGAGEMENT_OUTBOX_COLLECTION = 'engagement_outbox';

const EngagementOutboxSchema = new Schema<IEngagementOutbox>(
  {
    _id: { type: String, required: true },
    kind: {
      type: String,
      required: true,
      enum: [
        'post.like',
        'post.unlike',
        'post.downvote',
        'post.undownvote',
        'post.save',
        'post.unsave',
      ],
    },
    revision: { type: Number, required: true, min: 1 },
    payload: {
      actorOxyUserId: { type: String, required: true },
      postId: { type: String, required: true },
      relationshipId: { type: String, required: true },
      postOwnerOxyUserId: { type: String },
      postAuthorship: { type: [Schema.Types.Mixed], default: undefined },
      federationActivityId: { type: String },
      previousValue: { type: Number, enum: [1, -1, null] },
      value: { type: Number, enum: [1, -1, null] },
    },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'processing', 'processed'],
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
  { timestamps: true, collection: ENGAGEMENT_OUTBOX_COLLECTION },
);

// Pending work and expired claims use separate bounded scans.
EngagementOutboxSchema.index({ status: 1, availableAt: 1, createdAt: 1 });
EngagementOutboxSchema.index({ status: 1, leaseUntil: 1, createdAt: 1 });
// Prevent two workers from applying transitions for one relationship out of
// order. The dispatcher checks for a lower unprocessed revision after claiming.
EngagementOutboxSchema.index({
  'payload.relationshipId': 1,
  revision: 1,
  status: 1,
});
EngagementOutboxSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 },
);

export const EngagementOutbox = mongoose.model<IEngagementOutbox>(
  'EngagementOutbox',
  EngagementOutboxSchema,
);

export default EngagementOutbox;
