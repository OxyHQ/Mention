import mongoose, { Document, Schema } from "mongoose";

export interface ITrendBatch extends Document {
  calculatedAt: Date;
  summary: string;
}

const TrendBatchSchema = new Schema({
  calculatedAt: {
    type: Date,
    required: true,
    unique: true,
    index: true,
  },
  summary: {
    type: String,
    default: '',
  },
});

export default mongoose.model<ITrendBatch>("TrendBatch", TrendBatchSchema);
