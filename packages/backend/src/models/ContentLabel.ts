import mongoose, { Schema, Document } from 'mongoose';

export interface IContentLabel extends Document {
  labelerId: mongoose.Types.ObjectId;
  targetType: 'post' | 'user';
  targetId: string;
  labelSlug: string;
  createdBy: string;
  reason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ContentLabelSchema = new Schema<IContentLabel>({
  labelerId: { type: Schema.Types.ObjectId, ref: 'Labeler', required: true },
  targetType: { type: String, enum: ['post', 'user'], required: true },
  targetId: { type: String, required: true },
  labelSlug: { type: String, required: true },
  createdBy: { type: String, required: true },
  reason: { type: String },
}, { timestamps: true });

ContentLabelSchema.index({ targetType: 1, targetId: 1 });
ContentLabelSchema.index({ labelerId: 1, labelSlug: 1 });
ContentLabelSchema.index({ labelerId: 1, targetType: 1, targetId: 1, labelSlug: 1 }, { unique: true });

export const ContentLabel = mongoose.model<IContentLabel>('ContentLabel', ContentLabelSchema);
export default ContentLabel;
