import mongoose, { Document, Schema } from "mongoose";

export interface IRestrict extends Document {
  userId: string;
  restrictedId: string;
  createdAt: Date;
}

const RestrictSchema = new Schema({
  userId: {
    type: String,
    required: true
  },
  restrictedId: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Create compound index to ensure uniqueness of user-restrict pairs
RestrictSchema.index({ userId: 1, restrictedId: 1 }, { unique: true });

export default mongoose.model<IRestrict>("Restrict", RestrictSchema);

