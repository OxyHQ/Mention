import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * The entity kinds a user can follow — and the only ones with BOTH a writer and
 * a reader:
 *
 * - `hashtag` — read by `ContentAffinityService` and the feed engine's social
 *   sources, which surface posts carrying the followed tags.
 * - `list` — a subscription: `ListSubscriptionService` maintains
 *   `AccountList.subscriberCount` and the feed controller merges the members of
 *   subscribed lists into the viewer's feed.
 *
 * Custom feeds are deliberately absent. A feed subscription is a `FeedLike` row
 * (`POST /feeds/:id/like`), which moves `CustomFeed.subscriberCount` — the
 * record every feed surface reads. Rows written here with `entityType:'feed'`
 * were never read by anything.
 */
export const ENTITY_FOLLOW_TYPES = ['hashtag', 'list'] as const;

export type EntityFollowType = (typeof ENTITY_FOLLOW_TYPES)[number];

export interface IEntityFollow extends Document {
  userId: string;
  entityType: EntityFollowType;
  entityId: string;
  createdAt: Date;
}

const EntityFollowSchema = new Schema<IEntityFollow>(
  {
    userId: { type: String, required: true, index: true },
    entityType: { type: String, required: true, enum: ENTITY_FOLLOW_TYPES },
    entityId: { type: String, required: true },
  },
  { timestamps: true }
);

EntityFollowSchema.index({ userId: 1, entityType: 1, entityId: 1 }, { unique: true });
EntityFollowSchema.index({ entityType: 1, entityId: 1 });
EntityFollowSchema.index({ userId: 1, entityType: 1 });

export const EntityFollow: Model<IEntityFollow> = mongoose.model<IEntityFollow>('EntityFollow', EntityFollowSchema);
