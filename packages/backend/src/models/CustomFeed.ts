import mongoose, { Schema, Document } from 'mongoose';

export interface ICustomFeed extends Document {
  ownerOxyUserId: string;
  title: string;
  description?: string;
  isPublic: boolean;
  memberOxyUserIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

const CustomFeedSchema = new Schema<ICustomFeed>({
  ownerOxyUserId: { type: String, required: true, index: true },
  title: { type: String, required: true },
  description: { type: String },
  isPublic: { type: Boolean, default: false, index: true },
  memberOxyUserIds: { type: [String], default: [], index: true },
}, { timestamps: true });

CustomFeedSchema.index({ ownerOxyUserId: 1, createdAt: -1 });
CustomFeedSchema.index({ isPublic: 1, createdAt: -1 });

export const CustomFeed = mongoose.model<ICustomFeed>('CustomFeed', CustomFeedSchema);
export default CustomFeed;

