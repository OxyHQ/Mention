/**
 * Threadgate Model
 *
 * Controls who can reply to a post. MTN Protocol record.
 */

import mongoose, { Schema, Document } from 'mongoose';

export interface IThreadgate extends Document {
  postUri: string;
  postId: string;
  allow: Array<{
    type: 'mentionedOnly' | 'followingOnly' | 'followerOnly' | 'listOnly';
    list?: string;
  }>;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const threadgateSchema = new Schema<IThreadgate>(
  {
    postUri: { type: String, required: true, unique: true, index: true },
    postId: { type: String, required: true, index: true },
    allow: [
      {
        type: { type: String, enum: ['mentionedOnly', 'followingOnly', 'followerOnly', 'listOnly'], required: true },
        list: { type: String },
      },
    ],
    createdBy: { type: String, required: true, index: true },
  },
  { timestamps: true }
);

export const Threadgate = mongoose.model<IThreadgate>('Threadgate', threadgateSchema);
