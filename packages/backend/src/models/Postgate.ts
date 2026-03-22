/**
 * Postgate Model
 *
 * Controls quoting behavior for a post. MTN Protocol record.
 */

import mongoose, { Schema, Document } from 'mongoose';

export interface IPostgate extends Document {
  postUri: string;
  postId: string;
  disableQuotes: boolean;
  detachedQuoteUris: string[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const postgateSchema = new Schema<IPostgate>(
  {
    postUri: { type: String, required: true, unique: true, index: true },
    postId: { type: String, required: true, index: true },
    disableQuotes: { type: Boolean, default: false },
    detachedQuoteUris: [{ type: String }],
    createdBy: { type: String, required: true, index: true },
  },
  { timestamps: true }
);

export const Postgate = mongoose.model<IPostgate>('Postgate', postgateSchema);
