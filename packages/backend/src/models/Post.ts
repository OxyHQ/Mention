import mongoose, { Document, Schema } from "mongoose";
import { PostType, PostVisibility, PostContent, PostStats, PostMetadata } from '@mention/shared-types';

export type ReplyPermission = 'anyone' | 'followers' | 'following' | 'mentioned';

export interface IPost extends Document {
  oxyUserId: string; // Links to Oxy user
  type: PostType;
  content: PostContent;
  visibility: PostVisibility;
  isEdited: boolean;
  editHistory?: string[];
  language?: string;
  tags?: string[];
  mentions?: string[]; // oxyUserIds
  hashtags?: string[];
  repostOf?: string; // original post id
  quoteOf?: string; // quoted post id
  parentPostId?: string; // for replies
  threadId?: string; // for thread posts
  replyPermission?: ReplyPermission; // Who can reply and quote this post
  reviewReplies?: boolean; // Whether to review and approve replies before they're visible
  stats: PostStats;
  metadata: PostMetadata;
  location?: { // Post creation location metadata
    type: 'Point';
    coordinates: [number, number]; // [longitude, latitude]
    address?: string;
  };
  status?: 'draft' | 'published' | 'scheduled';
  scheduledFor?: Date;
  createdAt: string;
  updatedAt: string;
}

const AttachmentSchema = new Schema({
  type: {
    type: String,
    enum: ['media', 'poll', 'article', 'location', 'sources'],
    required: true
  },
  id: {
    type: String,
    required: function(this: any) {
      return this.type === 'media';
    }
  },
  mediaType: {
    type: String,
    enum: ['image', 'video', 'gif'],
    required: function(this: any) {
      return this.type === 'media';
    }
  }
}, { _id: false });

const PostContentSchema = new Schema({
  text: { type: String, default: '', index: 'text' },
  media: [{
    // MediaItem objects with id and type
    type: Schema.Types.Mixed,
    validate: {
      validator: function(item: any) {
        // Only allow MediaItem objects with id and type
        if (typeof item === 'object' && item !== null) {
          return typeof item.id === 'string' && 
                 (item.type === 'image' || item.type === 'video' || item.type === 'gif');
        }
        return false;
      },
      message: 'Media must be MediaItem objects with id and type fields'
    }
  }],
  attachments: {
    type: [AttachmentSchema],
    default: undefined
  },
  // Location shared by user as part of post content - visible to other users
  location: {
    type: { 
      type: String, 
      enum: ['Point'], 
      required: function(this: any) {
        // Require type only if coordinates are provided
        return this.coordinates && this.coordinates.length > 0;
      }
    },
    coordinates: {
      type: [Number], // [longitude, latitude] - longitude first for GeoJSON standard
      required: false,
      validate: {
        validator: function(coords: number[]) {
          // Allow empty arrays or undefined - no location data
          if (!coords || coords.length === 0) return true;
          // If coordinates provided, must be valid [lng, lat] format
          return coords.length === 2 && 
                 coords[0] >= -180 && coords[0] <= 180 && // longitude
                 coords[1] >= -90 && coords[1] <= 90;    // latitude
        },
        message: 'Coordinates must be [longitude, latitude] with valid ranges'
      }
    },
    // Optional address string for display purposes
    address: { type: String, required: false }
  },
  // Poll ID reference to separate Poll collection
  pollId: { type: String, required: false },
  // External sources cited in the post
  sources: [{
    url: {
      type: String,
      required: true,
      trim: true
    },
    title: {
      type: String,
      required: false,
      trim: true,
      maxlength: 200
    }
  }],
  article: {
    articleId: {
      type: String,
      required: false,
      index: true,
    },
    title: {
      type: String,
      required: false,
      trim: true,
      maxlength: 280
    },
    excerpt: {
      type: String,
      required: false,
      trim: true
    }
  }
});

const PostStatsSchema = new Schema({
  likesCount: { type: Number, default: 0 },
  repostsCount: { type: Number, default: 0 },
  commentsCount: { type: Number, default: 0 },
  viewsCount: { type: Number, default: 0 },
  sharesCount: { type: Number, default: 0 }
}, { _id: false }); // Don't create _id for subdocuments

// Ensure stats are always initialized
PostStatsSchema.pre('save', function() {
  if (!this.likesCount && this.likesCount !== 0) this.likesCount = 0;
  if (!this.repostsCount && this.repostsCount !== 0) this.repostsCount = 0;
  if (!this.commentsCount && this.commentsCount !== 0) this.commentsCount = 0;
  if (!this.viewsCount && this.viewsCount !== 0) this.viewsCount = 0;
  if (!this.sharesCount && this.sharesCount !== 0) this.sharesCount = 0;
});

const PostMetadataSchema = new Schema({
  isSensitive: { type: Boolean, default: false },
  isPinned: { type: Boolean, default: false },
  isSaved: { type: Boolean, default: false },
  isLiked: { type: Boolean, default: false },
  isReposted: { type: Boolean, default: false },
  isCommented: { type: Boolean, default: false },
  isFollowingAuthor: { type: Boolean, default: false },
  authorBlocked: { type: Boolean, default: false },
  authorMuted: { type: Boolean, default: false },
  // Track user interactions
  likedBy: [{ type: String }], // Array of user IDs who liked this post
  savedBy: [{ type: String }],  // Array of user IDs who saved this post
  // Poll reference (separate Poll model)
  pollId: { type: String }
});

const PostSchema = new Schema<IPost>({
  oxyUserId: { type: String, required: true, index: true },
  type: { type: String, enum: Object.values(PostType), default: PostType.TEXT, index: true },
  content: { type: PostContentSchema, required: true },
  visibility: { type: String, enum: Object.values(PostVisibility), default: PostVisibility.PUBLIC, index: true },
  isEdited: { type: Boolean, default: false },
  editHistory: [{ type: String }],
  language: { type: String, default: 'en', index: true },
  tags: [{ type: String }],
  mentions: [{ type: String, index: true }],
  hashtags: [{ type: String, index: true }],
  repostOf: { type: String, index: true },
  quoteOf: { type: String, index: true },
  parentPostId: { type: String, index: true },
  threadId: { type: String, index: true },
  replyPermission: { 
    type: String, 
    enum: ['anyone', 'followers', 'following', 'mentioned'],
    default: 'anyone'
  },
  reviewReplies: { type: Boolean, default: false },
  status: {
    type: String,
    enum: ['draft', 'published', 'scheduled'],
    default: 'published',
    index: true
  },
  scheduledFor: { type: Date },
  stats: { 
    type: PostStatsSchema, 
    default: () => ({
      likesCount: 0,
      repostsCount: 0,
      commentsCount: 0,
      viewsCount: 0,
      sharesCount: 0
    })
  },
  metadata: { type: PostMetadataSchema, default: () => ({}) },
  // Post creation location - metadata for analytics/discovery
  location: {
    type: { 
      type: String, 
      enum: ['Point'], 
      required: function(this: any) {
        // Require type only if coordinates are provided in this location object
        return this.coordinates && this.coordinates.length > 0;
      }
    },
    coordinates: {
      type: [Number], // [longitude, latitude] - longitude first for GeoJSON standard
      required: false,
      validate: {
        validator: function(coords: number[]) {
          // Allow empty arrays or undefined - no location data
          if (!coords || coords.length === 0) return true;
          // If coordinates provided, must be valid [lng, lat] format
          return coords.length === 2 && 
                 coords[0] >= -180 && coords[0] <= 180 && // longitude
                 coords[1] >= -90 && coords[1] <= 90;    // latitude
        },
        message: 'Coordinates must be [longitude, latitude] with valid ranges'
      }
    },
    // Optional address string for display purposes
    address: { type: String, required: false }
  }
}, {
  timestamps: {
    createdAt: 'createdAt',
    updatedAt: 'updatedAt'
  },
  toObject: { virtuals: true },
  toJSON: { virtuals: true }
});

// Pre-save hook to clean up empty location objects
PostSchema.pre('save', function() {
  // Clean up content.location if it has empty coordinates
  if (this.content?.location && (!this.content.location.coordinates || this.content.location.coordinates.length !== 2)) {
    this.content.location = undefined;
  }
  
  // Clean up post.location if it has empty coordinates
  if (this.location && (!this.location.coordinates || this.location.coordinates.length !== 2)) {
    this.location = undefined;
  }
});

// Virtual fields for backward compatibility
PostSchema.virtual('text').get(function() {
  return this.content?.text || '';
});

PostSchema.virtual('media').get(function() {
  return this.content?.media || [];
});

PostSchema.virtual('userID').get(function() {
  return this.oxyUserId;
});

// Indexes for optimal query performance
PostSchema.index({ oxyUserId: 1, createdAt: -1 });
PostSchema.index({ type: 1, createdAt: -1 });
PostSchema.index({ visibility: 1, createdAt: -1 });
PostSchema.index({ hashtags: 1, createdAt: -1 });
PostSchema.index({ mentions: 1, createdAt: -1 });
PostSchema.index({ parentPostId: 1, createdAt: -1 });
PostSchema.index({ threadId: 1, createdAt: -1 });
PostSchema.index({ repostOf: 1, createdAt: -1 });
PostSchema.index({ quoteOf: 1, createdAt: -1 });
PostSchema.index({ 'content.media': 1, createdAt: -1 });
PostSchema.index({ createdAt: -1 }); // Default sort order

// Geospatial indexes for both location fields
PostSchema.index({ 'content.location': '2dsphere' }); // User's shared location
PostSchema.index({ 'location': '2dsphere' }); // Post creation location

// Compound indexes for common query patterns
PostSchema.index({ oxyUserId: 1, visibility: 1, createdAt: -1 });
PostSchema.index({ type: 1, visibility: 1, createdAt: -1 });
PostSchema.index({ hashtags: 1, visibility: 1, createdAt: -1 });
// Geospatial compound indexes for location + time queries
PostSchema.index({ 'content.location': '2dsphere', createdAt: -1 });
PostSchema.index({ 'location': '2dsphere', createdAt: -1 });

export const Post = mongoose.model<IPost>('Post', PostSchema);
export default Post;
