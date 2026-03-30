import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IEntityFollow extends Document {
  userId: string;
  entityType: string;
  entityId: string;
  createdAt: Date;
}

const EntityFollowSchema = new Schema<IEntityFollow>(
  {
    userId: { type: String, required: true, index: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
  },
  { timestamps: true }
);

EntityFollowSchema.index({ userId: 1, entityType: 1, entityId: 1 }, { unique: true });
EntityFollowSchema.index({ entityType: 1, entityId: 1 });
EntityFollowSchema.index({ userId: 1, entityType: 1 });

export const EntityFollow: Model<IEntityFollow> = mongoose.model<IEntityFollow>('EntityFollow', EntityFollowSchema);
