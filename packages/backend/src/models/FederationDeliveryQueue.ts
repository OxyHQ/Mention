import mongoose, { Document, Schema } from 'mongoose';

export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface IFederationDelivery extends Document {
  activityJson: Record<string, unknown>;
  targetInbox: string;
  senderOxyUserId: string;
  attempts: number;
  lastAttemptAt?: Date;
  nextAttemptAt: Date;
  status: DeliveryStatus;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const BACKOFF_INTERVALS_MS = [
  5 * 60 * 1000,       // 5 minutes
  30 * 60 * 1000,      // 30 minutes
  2 * 60 * 60 * 1000,  // 2 hours
  12 * 60 * 60 * 1000, // 12 hours
  48 * 60 * 60 * 1000, // 48 hours
];

const FederationDeliveryQueueSchema = new Schema<IFederationDelivery>({
  activityJson: { type: Schema.Types.Mixed, required: true },
  targetInbox: { type: String, required: true },
  senderOxyUserId: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  lastAttemptAt: { type: Date },
  nextAttemptAt: { type: Date, required: true, index: true },
  status: { type: String, default: 'pending', enum: ['pending', 'delivered', 'failed'], index: true },
  error: { type: String },
}, {
  timestamps: true,
});

FederationDeliveryQueueSchema.index({ status: 1, nextAttemptAt: 1 });

/**
 * Calculate the next retry time based on attempt count using exponential backoff.
 */
export function getNextRetryTime(attempts: number): Date | null {
  if (attempts >= BACKOFF_INTERVALS_MS.length) return null;
  return new Date(Date.now() + BACKOFF_INTERVALS_MS[attempts]);
}

export const FederationDeliveryQueue = mongoose.model<IFederationDelivery>(
  'FederationDeliveryQueue',
  FederationDeliveryQueueSchema
);
export default FederationDeliveryQueue;
