import mongoose, { Document, Schema } from "mongoose";

export interface IBlock extends Document {
  userId: string;
  blockedId: string;
  createdAt: Date;
}

const BlockSchema = new Schema({
  userId: {
    type: String,
    required: true
  },
  blockedId: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Create compound index to ensure uniqueness of user-block pairs
BlockSchema.index({ userId: 1, blockedId: 1 }, { unique: true });

export default mongoose.model<IBlock>("Block", BlockSchema);