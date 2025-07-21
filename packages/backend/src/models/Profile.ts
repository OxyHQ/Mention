import mongoose, { Document, Schema } from "mongoose";

export interface IProfile extends Document {
  oxyUserId: string; // Oxy user ID from JWT token
  username: string;
  displayName?: string;
  bio?: string;
  avatar?: string;
  coverImage?: string;
  location?: string;
  website?: string;
  followers: number;
  following: number;
  postsCount: number;
  verified: boolean;
  isPersonal: boolean; // True for personal profiles, false for business/other profiles
  profileType: 'personal' | 'business' | 'organization';
  created_at: Date;
  updated_at: Date;
}

const ProfileSchema = new Schema<IProfile>({
  oxyUserId: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true },
  displayName: { type: String },
  bio: { type: String, maxlength: 500 },
  avatar: { type: String },
  coverImage: { type: String },
  location: { type: String, maxlength: 100 },
  website: { type: String },
  followers: { type: Number, default: 0 },
  following: { type: Number, default: 0 },
  postsCount: { type: Number, default: 0 },
  verified: { type: Boolean, default: false },
  isPersonal: { type: Boolean, default: true },
  profileType: { 
    type: String, 
    enum: ['personal', 'business', 'organization'], 
    default: 'personal' 
  }
}, {
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  },
  toObject: { virtuals: true },
  toJSON: { virtuals: true }
});

// Indexes for performance
ProfileSchema.index({ oxyUserId: 1 });
ProfileSchema.index({ username: 1 });
ProfileSchema.index({ profileType: 1 });
ProfileSchema.index({ created_at: -1 });

export const Profile = mongoose.model<IProfile>('Profile', ProfileSchema);
export default Profile;