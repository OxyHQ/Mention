import mongoose, { Document, Schema } from 'mongoose';

export interface ITopicStats extends Document {
  topicId: string;
  popularity: number;
  postCount: number;
  updatedAt: Date;
}

const TopicStatsSchema = new Schema<ITopicStats>({
  topicId: { type: String, required: true },
  popularity: { type: Number, default: 0 },
  postCount: { type: Number, default: 0 },
}, { timestamps: true });

TopicStatsSchema.index({ topicId: 1 }, { unique: true });
TopicStatsSchema.index({ popularity: -1 });

export const TopicStats = mongoose.model<ITopicStats>('TopicStats', TopicStatsSchema);
export default TopicStats;
