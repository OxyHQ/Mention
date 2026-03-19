import mongoose, { Document, Schema } from 'mongoose';
import { TopicType, TopicSource } from '@mention/shared-types';

export { TopicType, TopicSource };

export interface ITopic extends Document {
  name: string;
  slug: string;
  displayName: string;
  description: string;
  type: TopicType;
  source: TopicSource;
  aliases: string[];
  parentTopicId?: mongoose.Types.ObjectId;
  icon?: string;
  image?: string;
  popularity: number;
  postCount: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const TopicSchema = new Schema<ITopic>({
  name: { type: String, required: true, lowercase: true, trim: true },
  slug: { type: String, required: true, lowercase: true, trim: true },
  displayName: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  type: {
    type: String,
    enum: Object.values(TopicType),
    required: true,
    index: true,
  },
  source: {
    type: String,
    enum: Object.values(TopicSource),
    required: true,
  },
  aliases: { type: [String], default: [] },
  parentTopicId: { type: Schema.Types.ObjectId, ref: 'Topic' },
  icon: { type: String },
  image: { type: String },
  popularity: { type: Number, default: 0 },
  postCount: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

TopicSchema.index({ slug: 1 }, { unique: true });
TopicSchema.index({ name: 1 }, { unique: true });
TopicSchema.index({ type: 1, popularity: -1 });
TopicSchema.index({ aliases: 1 });
TopicSchema.index({ parentTopicId: 1 });
TopicSchema.index({ isActive: 1, type: 1, popularity: -1 });
TopicSchema.index(
  { name: 'text', displayName: 'text', aliases: 'text', description: 'text' },
  { weights: { name: 10, displayName: 8, aliases: 5, description: 1 } },
);

export const Topic = mongoose.model<ITopic>('Topic', TopicSchema);
export default Topic;
