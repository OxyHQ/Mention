/**
 * FeedGenerator Model
 *
 * Stores feed generator definitions for user/third-party algorithmic feeds.
 * MTN Protocol record.
 */

import mongoose, { Schema, Document } from 'mongoose';

export interface IFeedGenerator extends Document {
  uri: string;
  name: string;
  description?: string;
  avatar?: string;
  algorithm: string;
  createdBy: string;
  likeCount: number;
  subscriberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const feedGeneratorSchema = new Schema<IFeedGenerator>(
  {
    uri: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, maxlength: 64 },
    description: { type: String, maxlength: 300 },
    avatar: { type: String },
    algorithm: { type: String, required: true },
    createdBy: { type: String, required: true, index: true },
    likeCount: { type: Number, default: 0 },
    subscriberCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const FeedGenerator = mongoose.model<IFeedGenerator>('FeedGenerator', feedGeneratorSchema);
