import mongoose, { Document, Schema } from "mongoose";
import { RoomType, SpeakerPermission } from "./Room";

// --- Enums ---

export enum RecurrenceType {
  DAILY = 'daily',
  WEEKLY = 'weekly',
  BIWEEKLY = 'biweekly',
  MONTHLY = 'monthly'
}

// --- Interfaces ---

export interface IRecurrence {
  type: RecurrenceType;
  dayOfWeek?: number;    // 0=Sunday, 6=Saturday (for weekly/biweekly)
  dayOfMonth?: number;   // 1-31 (for monthly)
  time: string;          // HH:mm in 24h format
  timezone: string;      // IANA timezone (e.g. "America/New_York")
}

export interface IRoomTemplate {
  titlePattern: string;  // e.g. "Morning Talk - Episode {n}"
  type: RoomType;
  description?: string;
  maxParticipants: number;
  speakerPermission: SpeakerPermission;
  tags: string[];
}

export interface ISeriesEpisode {
  roomId: string;
  scheduledStart: Date;
  episodeNumber: number;
}

export interface ISeries extends Document {
  title: string;
  description?: string;
  coverImage?: string;

  // Ownership
  houseId?: string;       // optional: can belong to a house
  createdBy: string;      // userId

  // Schedule
  recurrence: IRecurrence;
  roomTemplate: IRoomTemplate;

  // Episodes
  episodes: ISeriesEpisode[];
  nextEpisodeNumber: number;

  // State
  isActive: boolean;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

// --- Schema ---

const RecurrenceSchema = new Schema({
  type: {
    type: String,
    enum: Object.values(RecurrenceType),
    required: true
  },
  dayOfWeek: {
    type: Number,
    min: 0,
    max: 6
  },
  dayOfMonth: {
    type: Number,
    min: 1,
    max: 31
  },
  time: {
    type: String,
    required: true,
    match: /^\d{2}:\d{2}$/
  },
  timezone: {
    type: String,
    required: true,
    default: 'UTC'
  }
}, { _id: false });

const RoomTemplateSchema = new Schema({
  titlePattern: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },
  type: {
    type: String,
    enum: Object.values(RoomType),
    required: true,
    default: RoomType.TALK
  },
  description: {
    type: String,
    trim: true,
    maxlength: 500
  },
  maxParticipants: {
    type: Number,
    default: 100,
    min: 1,
    max: 10000
  },
  speakerPermission: {
    type: String,
    enum: Object.values(SpeakerPermission),
    default: SpeakerPermission.INVITED
  },
  tags: {
    type: [String],
    default: []
  }
}, { _id: false });

const SeriesEpisodeSchema = new Schema({
  roomId: {
    type: String,
    required: true
  },
  scheduledStart: {
    type: Date,
    required: true
  },
  episodeNumber: {
    type: Number,
    required: true
  }
}, { _id: false });

const SeriesSchema = new Schema({
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
  coverImage: {
    type: String,
    default: null,
    trim: true
  },

  // Ownership
  houseId: {
    type: String,
    default: null,
    index: true
  },
  createdBy: {
    type: String,
    required: true,
    index: true
  },

  // Schedule
  recurrence: {
    type: RecurrenceSchema,
    required: true
  },
  roomTemplate: {
    type: RoomTemplateSchema,
    required: true
  },

  // Episodes
  episodes: {
    type: [SeriesEpisodeSchema],
    default: []
  },
  nextEpisodeNumber: {
    type: Number,
    default: 1
  },

  // State
  isActive: {
    type: Boolean,
    default: true
  },
}, {
  timestamps: true
});

// --- Indexes ---

// Find series by house
SeriesSchema.index({ houseId: 1, isActive: 1 });

// Find active series for scheduling
SeriesSchema.index({ isActive: 1, 'recurrence.type': 1 });

export default mongoose.model<ISeries>("Series", SeriesSchema);
