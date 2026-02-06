import mongoose, { Document, Schema } from "mongoose";

export interface IMute extends Document {
  userId: string;
  mutedId: string;
  createdAt: Date;
}

const MuteSchema = new Schema({
  userId: {
    type: String,
    required: true,
    index: true
  },
  mutedId: {
    type: String,
    required: true,
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Create compound unique index to prevent duplicate mutes
MuteSchema.index({ userId: 1, mutedId: 1 }, { unique: true });

export default mongoose.model<IMute>("Mute", MuteSchema);
