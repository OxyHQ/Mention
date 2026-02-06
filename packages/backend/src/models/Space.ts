import mongoose, { Document, Schema } from "mongoose";

export enum SpaceStatus {
  SCHEDULED = 'scheduled',
  LIVE = 'live',
  ENDED = 'ended'
}

export interface ISpace extends Document {
  title: string;
  description?: string;
  host: string;
  status: SpaceStatus;
  participants: string[];
  speakers: string[];
  maxParticipants: number;
  scheduledStart?: Date;
  startedAt?: Date;
  endedAt?: Date;
  topic?: string;
  tags: string[];
  stats: {
    peakListeners: number;
    totalJoined: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

const SpaceSchema = new Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },
  description: {
    type: String,
    trim: true,
    maxlength: 500
  },
  host: {
    type: String,
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: Object.values(SpaceStatus),
    default: SpaceStatus.SCHEDULED,
    index: true
  },
  participants: {
    type: [String],
    default: []
  },
  speakers: {
    type: [String],
    default: []
  },
  maxParticipants: {
    type: Number,
    default: 100,
    min: 1,
    max: 1000
  },
  scheduledStart: {
    type: Date
  },
  startedAt: {
    type: Date
  },
  endedAt: {
    type: Date
  },
  topic: {
    type: String,
    trim: true,
    maxlength: 100
  },
  tags: {
    type: [String],
    default: []
  },
  stats: {
    peakListeners: {
      type: Number,
      default: 0
    },
    totalJoined: {
      type: Number,
      default: 0
    }
  }
}, {
  timestamps: true
});

// Index for querying active/scheduled spaces
SpaceSchema.index({ status: 1, createdAt: -1 });

// Index for querying spaces by host
SpaceSchema.index({ host: 1, status: 1 });

export default mongoose.model<ISpace>("Space", SpaceSchema);
