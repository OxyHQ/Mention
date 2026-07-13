import mongoose, { Schema, Document } from 'mongoose';

export interface IStarterPack extends Document {
  ownerOxyUserId: string;
  name: string;
  description?: string;
  memberOxyUserIds: string[];
  usedByOxyUserIds: string[];
  useCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const StarterPackSchema = new Schema<IStarterPack>({
  ownerOxyUserId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  description: { type: String },
  memberOxyUserIds: { type: [String], default: [] },
  usedByOxyUserIds: { type: [String], default: [] },
  useCount: { type: Number, default: 0 },
}, { timestamps: true });

StarterPackSchema.index({ ownerOxyUserId: 1, createdAt: -1 });
StarterPackSchema.index({ useCount: -1, createdAt: -1 });
/**
 * MULTIKEY index on the member array, compounded with `useCount`.
 *
 * Serves the starter-pack CURATION aggregation (`services/starterPackCuration.ts`),
 * which matches `{ memberOxyUserIds: { $in: [...] }, useCount: { $gte: n } }` to
 * find the packs that curate a batch of feed authors. `memberOxyUserIds` is the
 * only array field in the compound (a compound index may have at most one), so the
 * `$in` on the members is index-served and `useCount` filters within it.
 */
StarterPackSchema.index({ memberOxyUserIds: 1, useCount: -1 });

export const StarterPack = mongoose.model<IStarterPack>('StarterPack', StarterPackSchema);
export default StarterPack;
