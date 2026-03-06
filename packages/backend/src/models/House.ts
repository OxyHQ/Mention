import mongoose, { Document, Schema } from "mongoose";

// --- Enums ---

export enum HouseMemberRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  HOST = 'host',
  MEMBER = 'member'
}

// --- Interfaces ---

export interface IHouseMember {
  userId: string;
  role: HouseMemberRole;
  joinedAt: Date;
}

export interface IHouse extends Document {
  name: string;
  description?: string;
  avatar?: string;
  coverImage?: string;

  // Members
  members: IHouseMember[];
  createdBy: string; // userId of the original creator

  // Settings
  isPublic: boolean;
  tags: string[];

  // Timestamps
  createdAt: Date;
  updatedAt: Date;

  // Methods
  hasRole(userId: string, minRole: HouseMemberRole): boolean;
  getMemberRole(userId: string): HouseMemberRole | null;
  isMember(userId: string): boolean;
  canCreateRoom(userId: string): boolean;
}

// --- Schema ---

const HouseMemberSchema = new Schema({
  userId: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: Object.values(HouseMemberRole),
    required: true,
    default: HouseMemberRole.MEMBER
  },
  joinedAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const HouseSchema = new Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  description: {
    type: String,
    trim: true,
    maxlength: 500
  },
  avatar: {
    type: String,
    default: null,
    trim: true
  },
  coverImage: {
    type: String,
    default: null,
    trim: true
  },

  // Members
  members: {
    type: [HouseMemberSchema],
    default: []
  },
  createdBy: {
    type: String,
    required: true,
    index: true
  },

  // Settings
  isPublic: {
    type: Boolean,
    default: true
  },
  tags: {
    type: [String],
    default: []
  },
}, {
  timestamps: true
});

// --- Indexes ---

// Find houses by member
HouseSchema.index({ 'members.userId': 1 });

// Find public houses
HouseSchema.index({ isPublic: 1, createdAt: -1 });

// Text search on name and description
HouseSchema.index({ name: 'text', description: 'text' });

// --- Methods ---

/**
 * Check if a user has a specific role or higher in the house.
 * Role hierarchy: owner > admin > host > member
 */
HouseSchema.methods.hasRole = function(userId: string, minRole: HouseMemberRole): boolean {
  const hierarchy: Record<HouseMemberRole, number> = {
    [HouseMemberRole.MEMBER]: 0,
    [HouseMemberRole.HOST]: 1,
    [HouseMemberRole.ADMIN]: 2,
    [HouseMemberRole.OWNER]: 3,
  };

  const member = this.members.find((m: IHouseMember) => m.userId === userId);
  if (!member) return false;

  return hierarchy[member.role as HouseMemberRole] >= hierarchy[minRole];
};

/**
 * Get a member's role in the house.
 */
HouseSchema.methods.getMemberRole = function(userId: string): HouseMemberRole | null {
  const member = this.members.find((m: IHouseMember) => m.userId === userId);
  return member ? member.role : null;
};

/**
 * Check if a user is a member of the house (any role).
 */
HouseSchema.methods.isMember = function(userId: string): boolean {
  return this.members.some((m: IHouseMember) => m.userId === userId);
};

/**
 * Check if a user can create rooms in this house (host, admin, or owner).
 */
HouseSchema.methods.canCreateRoom = function(userId: string): boolean {
  return this.hasRole(userId, HouseMemberRole.HOST);
};

export default mongoose.model<IHouse>("House", HouseSchema);
