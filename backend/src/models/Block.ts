import mongoose, { Document, Schema } from "mongoose";

export interface IBlock extends Document {
  userId: mongoose.Types.ObjectId;
  blockedId: mongoose.Types.ObjectId;
  createdAt: Date;
}

const BlockSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  blockedId: {
    type: Schema.Types.ObjectId,
    ref: "User",
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