import mongoose, { Schema, Document } from "mongoose";

export interface IReport extends Document {
  conversationID: string;
  messageId: string;
  reporter: string;
  reason: string;
  createdAt: Date;
}

const ReportSchema = new Schema({
  conversationID: { type: String, required: true },
  messageId: { type: String, required: true },
  reporter: { type: String, required: true },
  reason: { type: String, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

export default mongoose.model<IReport>("Report", ReportSchema);
