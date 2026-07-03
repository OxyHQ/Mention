import mongoose, { Document, Schema } from "mongoose";

export type NotificationType =
  | 'like'
  | 'reply'
  | 'mention'
  | 'follow'
  | 'boost'
  | 'quote'
  | 'welcome'
  | 'post'
  | 'poke';

export type NotificationEntityType = 'post' | 'reply' | 'profile';

/**
 * Retention window for notifications, in seconds (90 days).
 *
 * Notifications accumulate without bound — every like/reply/follow/mention adds a
 * row and nothing ever deletes them, so the collection (and every recipient scan)
 * grows forever. A TTL index on `createdAt` (declared below) reaps rows older than
 * this window at the storage layer. Exported so the migration that creates the
 * index in production (`autoIndex`/`autoCreate` are OFF there) keys off the SAME
 * bound.
 */
export const NOTIFICATION_TTL_SECONDS = 90 * 24 * 60 * 60;

export interface INotification extends Document {
  recipientId: string;
  actorId: string;
  type: NotificationType;
  entityId: mongoose.Types.ObjectId;
  entityType: NotificationEntityType;
  read: boolean;
  createdAt: Date;
}

const NotificationSchema = new Schema({
  recipientId: { type: String, required: true },
  actorId: { type: String, required: true },
  type: { 
    type: String, 
    required: true,
  enum: ['like', 'reply', 'mention', 'follow', 'boost', 'quote', 'welcome', 'post', 'poke']
  },
  entityId: { type: Schema.Types.ObjectId, required: true },
  entityType: { 
    type: String, 
    required: true,
    enum: ['post', 'reply', 'profile']
  },
  read: { type: Boolean, default: false },
}, { 
  timestamps: true 
});

// Index for quick lookups by recipient
NotificationSchema.index({ recipientId: 1, createdAt: -1 });
// Compound index for unread notifications query (most common use case)
NotificationSchema.index({ recipientId: 1, read: 1, createdAt: -1 });
// Index for checking duplicates
NotificationSchema.index({ recipientId: 1, actorId: 1, type: 1, entityId: 1 }, { unique: true });
// Keyset-pagination index for the GET / list: the query filters by recipientId +
// `_id < cursor` and sorts by `_id` descending, so this compound index serves the
// filter, sort, and range in one index scan (the createdAt indexes above cannot —
// they order by createdAt, not the `_id` cursor).
// NOTE: created in production by migration `0004-notification-ttl-index`.
NotificationSchema.index({ recipientId: 1, _id: -1 });
// TTL index: MongoDB's background monitor reaps notifications older than the
// retention window so the collection stays bounded.
// NOTE: created in production by migration `0004-notification-ttl-index`.
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: NOTIFICATION_TTL_SECONDS });

export default mongoose.model<INotification>("Notification", NotificationSchema);