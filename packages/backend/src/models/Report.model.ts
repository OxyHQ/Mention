import mongoose, { Schema, Document } from "mongoose";

export enum ReportedType {
  POST = 'post',
  USER = 'user',
  COMMENT = 'comment',
  MESSAGE = 'message'
}

export enum ReportCategory {
  SPAM = 'spam',
  HATE_SPEECH = 'hate_speech',
  HARASSMENT = 'harassment',
  MISINFORMATION = 'misinformation',
  EXPLICIT_CONTENT = 'explicit_content',
  OTHER = 'other'
}

export enum ReportStatus {
  PENDING = 'pending',
  REVIEWED = 'reviewed',
  RESOLVED = 'resolved',
  DISMISSED = 'dismissed'
}

export interface IReport extends Document {
  reportedType: ReportedType;
  reportedId: string;
  reporter: string;
  categories: ReportCategory[];
  details?: string;
  status: ReportStatus;
  createdAt: Date;
  updatedAt: Date;
}

const ReportSchema = new Schema({
  reportedType: {
    type: String,
    enum: Object.values(ReportedType),
    required: true
  },
  reportedId: {
    type: String,
    required: true,
    index: true
  },
  reporter: {
    type: String,
    required: true,
    index: true
  },
  categories: {
    type: [String],
    enum: Object.values(ReportCategory),
    required: true,
    validate: {
      validator: (v: string[]) => v && v.length > 0,
      message: 'At least one category is required'
    }
  },
  details: {
    type: String,
    maxlength: 500
  },
  status: {
    type: String,
    enum: Object.values(ReportStatus),
    default: ReportStatus.PENDING,
    index: true
  }
}, {
  timestamps: true
});

// Compound unique index to prevent duplicate reports
ReportSchema.index({ reporter: 1, reportedId: 1, reportedType: 1 }, { unique: true });

export default mongoose.model<IReport>("Report", ReportSchema);
