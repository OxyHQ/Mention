import mongoose, { Document, Schema } from "mongoose";

// --- Enums ---

export enum RoomStatus {
  SCHEDULED = 'scheduled',
  LIVE = 'live',
  ENDED = 'ended'
}

export enum RoomType {
  TALK = 'talk',
  STAGE = 'stage',
  BROADCAST = 'broadcast'
}

export enum OwnerType {
  PROFILE = 'profile',
  HOUSE = 'house',
  AGORA = 'agora'
}

export enum BroadcastKind {
  USER = 'user',
  AGORA = 'agora'
}

export enum SpeakerPermission {
  EVERYONE = 'everyone',
  FOLLOWERS = 'followers',
  INVITED = 'invited'
}

// --- Interface ---

export interface IRoom extends Document {
  title: string;
  description?: string;

  // Ownership
  ownerType: OwnerType;
  host: string;              // userId of the room creator / primary host
  houseId?: string;          // set when ownerType === HOUSE
  createdByAdmin?: string;   // audit trail for AGORA-owned rooms

  // Room classification
  type: RoomType;
  broadcastKind?: BroadcastKind; // only set when type === BROADCAST

  // Lifecycle
  status: RoomStatus;
  scheduledStart?: Date;
  startedAt?: Date;
  endedAt?: Date;

  // Participation
  speakerPermission: SpeakerPermission;
  participants: string[];
  speakers: string[];
  maxParticipants: number;

  // Content
  topic?: string;
  tags: string[];
  archived: boolean;
  seriesId?: string;         // link to Series if this room was generated from one

  // Stats
  stats: {
    peakListeners: number;
    totalJoined: number;
  };

  // Recording
  recordingEnabled: boolean;
  recordingEgressId?: string;

  // Streaming (for Broadcast rooms or any room with external stream)
  activeIngressId?: string;
  activeStreamUrl?: string;
  streamTitle?: string;
  streamImage?: string;
  streamDescription?: string;
  rtmpUrl?: string;
  rtmpStreamKey?: string;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

// --- Schema ---

const RoomSchema = new Schema({
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

  // Ownership
  ownerType: {
    type: String,
    enum: Object.values(OwnerType),
    required: true,
    default: OwnerType.PROFILE
  },
  host: {
    type: String,
    required: true,
    index: true
  },
  houseId: {
    type: String,
    default: null,
    index: true
  },
  createdByAdmin: {
    type: String,
    default: null
  },

  // Room classification
  type: {
    type: String,
    enum: Object.values(RoomType),
    required: true,
    default: RoomType.TALK
  },
  broadcastKind: {
    type: String,
    enum: Object.values(BroadcastKind),
    default: null
  },

  // Lifecycle
  status: {
    type: String,
    enum: Object.values(RoomStatus),
    default: RoomStatus.SCHEDULED,
    index: true
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

  // Participation
  speakerPermission: {
    type: String,
    enum: Object.values(SpeakerPermission),
    default: SpeakerPermission.INVITED
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
    max: 10000
  },

  // Content
  topic: {
    type: String,
    trim: true,
    maxlength: 100
  },
  tags: {
    type: [String],
    default: []
  },
  archived: {
    type: Boolean,
    default: false
  },
  seriesId: {
    type: String,
    default: null
  },

  // Stats
  stats: {
    peakListeners: {
      type: Number,
      default: 0
    },
    totalJoined: {
      type: Number,
      default: 0
    }
  },

  // Recording
  recordingEnabled: {
    type: Boolean,
    default: true,
  },
  recordingEgressId: {
    type: String,
    default: null,
  },

  // Streaming
  activeIngressId: {
    type: String,
    default: null,
  },
  activeStreamUrl: {
    type: String,
    default: null,
  },
  streamTitle: {
    type: String,
    default: null,
    trim: true,
    maxlength: 200,
  },
  streamImage: {
    type: String,
    default: null,
    trim: true,
  },
  streamDescription: {
    type: String,
    default: null,
    trim: true,
    maxlength: 500,
  },
  rtmpUrl: {
    type: String,
    default: null,
  },
  rtmpStreamKey: {
    type: String,
    default: null,
  },
}, {
  timestamps: true
});

// --- Indexes ---

// Query active/scheduled rooms
RoomSchema.index({ status: 1, createdAt: -1 });

// Query rooms by host
RoomSchema.index({ host: 1, status: 1 });

// Query rooms by type
RoomSchema.index({ type: 1, status: 1 });

// Query rooms by house
RoomSchema.index({ houseId: 1, status: 1 });

// Query rooms by owner type (e.g. all AGORA broadcasts)
RoomSchema.index({ ownerType: 1, type: 1, status: 1 });

// Query rooms by series
RoomSchema.index({ seriesId: 1, scheduledStart: -1 });

// --- Validation ---

// Ensure broadcastKind is set when type is BROADCAST
RoomSchema.pre('validate', function(next) {
  if (this.type === RoomType.BROADCAST && !this.broadcastKind) {
    this.broadcastKind = BroadcastKind.USER;
  }
  // Clear broadcastKind if not a broadcast room
  if (this.type !== RoomType.BROADCAST) {
    this.broadcastKind = undefined;
  }
  // Ensure houseId is set when ownerType is HOUSE
  if (this.ownerType === OwnerType.HOUSE && !this.houseId) {
    return next(new Error('houseId is required when ownerType is HOUSE'));
  }
  // Broadcast rooms should not have speaker permission set to 'everyone'
  if (this.type === RoomType.BROADCAST) {
    this.speakerPermission = SpeakerPermission.INVITED;
  }
  next();
});

export default mongoose.model<IRoom>("Room", RoomSchema);
