import mongoose, { Schema, Document } from 'mongoose';
import type { FeedDefinition, ModuleRef } from '../mtn/feed/engine/types';

export const FEED_CATEGORIES = ['news', 'tech', 'culture', 'finance', 'health', 'sports', 'entertainment', 'other'] as const;
export type FeedCategory = typeof FEED_CATEGORIES[number];

/**
 * The stored subset of a {@link FeedDefinition}: the composable module lists the
 * feed engine runs. `id`/`title` are NOT stored here — they live on the parent
 * document (`_id`/`title`) and are re-attached when the definition is resolved.
 * Typed off the engine's canonical `FeedDefinition` so the shape can never drift.
 */
export type StoredFeedDefinition = Pick<FeedDefinition, 'mode' | 'sources' | 'signals' | 'filters'>;

export interface ICustomFeed extends Document {
  ownerOxyUserId: string;
  title: string;
  description?: string;
  isPublic: boolean;
  /**
   * The composable feed definition run by the FeedEngine. Optional only for
   * legacy documents created before Phase 3; populated for every new feed and by
   * the one-shot migration (`scripts/backfillCustomFeedDefinitions.ts`).
   */
  definition?: StoredFeedDefinition;
  /** Lucide icon name shown in the feeds screen / builder. */
  icon?: string;
  // ── Legacy filter fields (read-only; consumed only by the migration + the
  // request-time definition fallback while the backfill has not yet run). New
  // writes populate `definition` instead. ──
  memberOxyUserIds: string[];
  sourceListIds?: string[]; // AccountList sources used by this feed
  keywords?: string[];
  topicIds?: string[];
  includeReplies?: boolean;
  includeBoosts?: boolean;
  includeMedia?: boolean;
  language?: string;
  category?: FeedCategory;
  tags: string[];
  coverImage?: string;
  subscriberCount: number;
  averageRating: number;
  ratingsCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A single toggleable module reference inside a stored definition. */
const ModuleRefSchema = new Schema<ModuleRef>(
  {
    module: { type: String, required: true },
    enabled: { type: Boolean, required: true },
    params: { type: Schema.Types.Mixed },
    weight: { type: Number },
  },
  { _id: false },
);

/** The embedded composable feed definition. */
const FeedDefinitionSchema = new Schema<StoredFeedDefinition>(
  {
    mode: { type: String, enum: ['ranked', 'chronological'], required: true },
    sources: { type: [ModuleRefSchema], default: [] },
    signals: { type: [ModuleRefSchema], default: [] },
    filters: { type: [ModuleRefSchema], default: [] },
  },
  { _id: false },
);

const CustomFeedSchema = new Schema<ICustomFeed>({
  ownerOxyUserId: { type: String, required: true, index: true },
  title: { type: String, required: true },
  description: { type: String },
  isPublic: { type: Boolean, default: false, index: true },
  definition: { type: FeedDefinitionSchema },
  icon: { type: String },
  memberOxyUserIds: { type: [String], default: [], index: true },
  sourceListIds: { type: [String], default: [] },
  keywords: { type: [String], default: [] },
  topicIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Topic' }], default: [] },
  includeReplies: { type: Boolean, default: true },
  includeBoosts: { type: Boolean, default: true },
  includeMedia: { type: Boolean, default: true },
  language: { type: String },
  category: { type: String, enum: FEED_CATEGORIES },
  tags: { type: [String], default: [] },
  coverImage: { type: String },
  subscriberCount: { type: Number, default: 0 },
  averageRating: { type: Number, default: 0 },
  ratingsCount: { type: Number, default: 0 },
}, { timestamps: true });

CustomFeedSchema.index({ ownerOxyUserId: 1, createdAt: -1 });
CustomFeedSchema.index({ isPublic: 1, createdAt: -1 });
CustomFeedSchema.index({ isPublic: 1, category: 1, subscriberCount: -1 });

export const CustomFeed = mongoose.model<ICustomFeed>('CustomFeed', CustomFeedSchema);
export default CustomFeed;
