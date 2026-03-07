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

export const StarterPack = mongoose.model<IStarterPack>('StarterPack', StarterPackSchema);
export default StarterPack;
