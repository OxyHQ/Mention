import mongoose, { Document, Schema } from "mongoose";
import { PostType, PostVisibility, PostContent, PostStats, PostMetadata } from '@mention/shared-types';

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
  stats: PostStats;
  metadata: PostMetadata;
  createdAt: string;
  updatedAt: string;
}

const PostContentSchema = new Schema({
  text: { type: String },
  images: [{ type: String }],
  video: { type: String },
  poll: {
    question: { type: String },
    options: [{ type: String }],
    endTime: { type: String },
    votes: { type: Map, of: Number, default: {} },
    userVotes: { type: Map, of: String, default: {} }
  },
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: [{ type: Number }]
  }
});

const PostStatsSchema = new Schema({
  likesCount: { type: Number, default: 0 },
  repostsCount: { type: Number, default: 0 },
  commentsCount: { type: Number, default: 0 },
  viewsCount: { type: Number, default: 0 },
  sharesCount: { type: Number, default: 0 }
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
  authorMuted: { type: Boolean, default: false }
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
  stats: { type: PostStatsSchema, default: () => ({}) },
  metadata: { type: PostMetadataSchema, default: () => ({}) }
}, {
  timestamps: {
    createdAt: 'createdAt',
    updatedAt: 'updatedAt'
  },
  toObject: { virtuals: true },
  toJSON: { virtuals: true }
});

// Virtual fields for backward compatibility
PostSchema.virtual('text').get(function() {
  return this.content?.text || '';
});

PostSchema.virtual('media').get(function() {
  return this.content?.images || [];
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
PostSchema.index({ 'content.images': 1, createdAt: -1 });
PostSchema.index({ 'content.video': 1, createdAt: -1 });
PostSchema.index({ createdAt: -1 }); // Default sort order

// Compound indexes for common query patterns
PostSchema.index({ oxyUserId: 1, visibility: 1, createdAt: -1 });
PostSchema.index({ type: 1, visibility: 1, createdAt: -1 });
PostSchema.index({ hashtags: 1, visibility: 1, createdAt: -1 });

export const Post = mongoose.model<IPost>('Post', PostSchema);
export default Post;
