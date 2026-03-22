/**
 * MuteWord Model
 *
 * Words or phrases to mute from feeds. MTN Protocol record.
 */

import mongoose, { Schema, Document } from 'mongoose';

export interface IMuteWord extends Document {
  userId: string;
  value: string;
  targets: ('content' | 'tag')[];
  actorTarget: 'all' | 'exclude-following';
  createdAt: Date;
  updatedAt: Date;
}

const muteWordSchema = new Schema<IMuteWord>(
  {
    userId: { type: String, required: true, index: true },
    value: { type: String, required: true, maxlength: 100 },
    targets: [{ type: String, enum: ['content', 'tag'], required: true }],
    actorTarget: { type: String, enum: ['all', 'exclude-following'], default: 'all' },
  },
  { timestamps: true }
);

muteWordSchema.index({ userId: 1, value: 1 }, { unique: true });

export const MuteWord = mongoose.model<IMuteWord>('MuteWord', muteWordSchema);
