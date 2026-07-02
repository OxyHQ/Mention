import mongoose, { Schema, Document } from 'mongoose';
import type { SavedFeed } from '@mention/shared-types';

/**
 * A viewer's server-persisted feed layout: which feeds are saved, pinned into the
 * home tab bar, and in what order. One document per Oxy user. The default layout
 * (For You + Following pinned, presets appended) is seeded by the
 * `/feed/preferences` GET handler from `PRESET_FEEDS` — not stored until the user
 * saves — so a new preset appears for everyone without a migration.
 */
export interface IUserFeedPreference extends Document {
  oxyUserId: string;
  savedFeeds: SavedFeed[];
  createdAt: Date;
  updatedAt: Date;
}

// Subdoc: `_id:false` — a saved feed is identified by its `key`, not an ObjectId.
const SavedFeedSchema = new Schema(
  {
    key: { type: String, required: true },
    descriptor: { type: String, required: true },
    pinned: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
  },
  { _id: false },
);

const UserFeedPreferenceSchema = new Schema<IUserFeedPreference>(
  {
    oxyUserId: { type: String, required: true },
    savedFeeds: { type: [SavedFeedSchema], default: [] },
  },
  { timestamps: true },
);

UserFeedPreferenceSchema.index({ oxyUserId: 1 }, { unique: true });

export const UserFeedPreference = mongoose.model<IUserFeedPreference>(
  'UserFeedPreference',
  UserFeedPreferenceSchema,
);
export default UserFeedPreference;
