import mongoose, { Document, Schema } from 'mongoose';

export enum RecordingStatus {
  RECORDING = 'recording',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
  DELETED = 'deleted',
}

export enum RecordingAccess {
  PUBLIC = 'public',
  PARTICIPANTS = 'participants',
}

export interface IRecording extends Document {
  roomId: string;
  roomTitle: string;
  host: string;

  status: RecordingStatus;
  egressId: string;

  objectKey: string;
  fileSize?: number;

  durationMs?: number;
  startedAt: Date;
  stoppedAt?: Date;

  access: RecordingAccess;
  participantIds: string[];

  expiresAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

const RecordingSchema = new Schema({
  roomId: {
    type: String,
    required: true,
    index: true,
  },
  roomTitle: {
    type: String,
    required: true,
    trim: true,
  },
  host: {
    type: String,
    required: true,
    index: true,
  },

  status: {
    type: String,
    enum: Object.values(RecordingStatus),
    default: RecordingStatus.RECORDING,
    index: true,
  },
  egressId: {
    type: String,
    required: true,
    unique: true,
  },

  objectKey: {
    type: String,
    required: true,
  },
  fileSize: {
    type: Number,
    default: null,
  },

  durationMs: {
    type: Number,
    default: null,
  },
  startedAt: {
    type: Date,
    required: true,
  },
  stoppedAt: {
    type: Date,
    default: null,
  },

  access: {
    type: String,
    enum: Object.values(RecordingAccess),
    default: RecordingAccess.PUBLIC,
  },
  participantIds: {
    type: [String],
    default: [],
  },

  expiresAt: {
    type: Date,
    required: true,
    index: true,
  },
}, {
  timestamps: true,
});

RecordingSchema.index({ roomId: 1, status: 1 });
RecordingSchema.index({ host: 1, status: 1, createdAt: -1 });
RecordingSchema.index({ expiresAt: 1, status: 1 });

export default mongoose.model<IRecording>('Recording', RecordingSchema);
