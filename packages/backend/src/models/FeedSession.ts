import mongoose, { Document, Schema, Model } from 'mongoose';

/**
 * FeedSession - Stores feed browsing session state
 * 
 * This model tracks which posts have been seen in a feed session,
 * enabling:
 * - Duplicate prevention across infinite scroll
 * - Persistent feed state across page reloads
 * - Advanced feed algorithm features (A/B testing, personalization)
 * - Analytics on feed consumption patterns
 * 
 * Sessions are automatically cleaned up after 24 hours of inactivity
 */
export interface IFeedSession extends Document {
  /** Unique session ID (generated, sent to client) */
  sessionId: string;
  
  /** User ID (Oxy user ID) - optional for guest users */
  userId?: string;
  
  /** Feed type (for_you, following, explore, media, etc) */
  feedType: string;
  
  /** Feed filters as JSON (for custom feeds, hashtag feeds, etc) */
  feedFilters?: Record<string, any>;
  
  /** Array of post IDs that have been loaded in this session */
  seenPostIds: string[];
  
  /** Last cursor position for efficient querying */
  lastCursor?: string;
  
  /** Metadata for feed algorithm experiments */
  algorithmMetadata?: {
    /** Algorithm version used */
    version?: string;
    /** A/B test variant */
    variant?: string;
    /** Personalization factors applied */
    factors?: string[];
    /** Custom algorithm parameters */
    params?: Record<string, any>;
  };
  
  /** Session statistics */
  stats?: {
    /** Total posts loaded in this session */
    postsLoaded: number;
    /** Total scroll depth (number of load more actions) */
    scrollDepth: number;
    /** Last activity timestamp */
    lastActivity: Date;
  };
  
  /** Session creation timestamp */
  createdAt: Date;
  
  /** Last update timestamp */
  updatedAt: Date;
  
  /** Session expiry (TTL index will auto-delete after this) */
  expiresAt: Date;
  
  // Instance methods
  addSeenPosts(postIds: string[]): Promise<IFeedSession>;
  updateCursor(cursor: string): Promise<IFeedSession>;
}

// Model interface with static methods
interface IFeedSessionModel extends Model<IFeedSession> {
  createSession(
    userId: string | undefined,
    feedType: string,
    feedFilters?: Record<string, any>,
    sessionDurationHours?: number
  ): Promise<IFeedSession>;
  
  getOrCreateSession(
    sessionId: string | undefined,
    userId: string | undefined,
    feedType: string,
    feedFilters?: Record<string, any>
  ): Promise<IFeedSession>;
}

const FeedSessionSchema = new Schema<IFeedSession>({
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  userId: {
    type: String,
    index: true,
    sparse: true // Allow null for guest users
  },
  feedType: {
    type: String,
    required: true,
    index: true
  },
  feedFilters: {
    type: Schema.Types.Mixed,
    default: {}
  },
  seenPostIds: {
    type: [String],
    default: [],
    // Index for efficient $nin queries
    index: true
  },
  lastCursor: {
    type: String
  },
  algorithmMetadata: {
    version: String,
    variant: String,
    factors: [String],
    params: Schema.Types.Mixed
  },
  stats: {
    postsLoaded: { type: Number, default: 0 },
    scrollDepth: { type: Number, default: 0 },
    lastActivity: { type: Date, default: Date.now }
  },
  expiresAt: {
    type: Date,
    required: true,
    // TTL index - MongoDB will auto-delete documents after expiry
    index: { expires: 0 }
  }
}, {
  timestamps: true
});

// Compound index for efficient session lookups
FeedSessionSchema.index({ userId: 1, feedType: 1, createdAt: -1 });

// Index for cleanup queries
FeedSessionSchema.index({ expiresAt: 1 });

/**
 * Pre-save middleware to update stats
 */
FeedSessionSchema.pre('save', function(next) {
  if (this.isModified('seenPostIds')) {
    if (!this.stats) {
      this.stats = { postsLoaded: 0, scrollDepth: 0, lastActivity: new Date() };
    }
    this.stats.lastActivity = new Date();
  }
  next();
});

/**
 * Static method to create a new feed session
 */
FeedSessionSchema.statics.createSession = async function(
  this: IFeedSessionModel,
  userId: string | undefined,
  feedType: string,
  feedFilters?: Record<string, any>,
  sessionDurationHours: number = 24
): Promise<IFeedSession> {
  const sessionId = new mongoose.Types.ObjectId().toString();
  const expiresAt = new Date(Date.now() + sessionDurationHours * 60 * 60 * 1000);
  
  return await this.create({
    sessionId,
    userId,
    feedType,
    feedFilters: feedFilters || {},
    seenPostIds: [],
    stats: {
      postsLoaded: 0,
      scrollDepth: 0,
      lastActivity: new Date()
    },
    expiresAt
  });
};

/**
 * Static method to get or create a session
 */
FeedSessionSchema.statics.getOrCreateSession = async function(
  this: IFeedSessionModel,
  sessionId: string | undefined,
  userId: string | undefined,
  feedType: string,
  feedFilters?: Record<string, any>
): Promise<IFeedSession> {
  // If sessionId provided, try to get existing session
  if (sessionId) {
    const session = await this.findOne({ sessionId }).exec();
    if (session) {
      // Update expiry and last activity
      session.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      session.stats = session.stats || { postsLoaded: 0, scrollDepth: 0, lastActivity: new Date() };
      session.stats.lastActivity = new Date();
      await session.save();
      return session;
    }
  }
  
  // Create new session
  return await this.createSession(userId, feedType, feedFilters);
};

/**
 * Instance method to add seen posts
 */
FeedSessionSchema.methods.addSeenPosts = async function(this: IFeedSession, postIds: string[]): Promise<IFeedSession> {
  // Add new IDs to seenPostIds (prevent duplicates)
  const newIds = postIds.filter(id => !this.seenPostIds.includes(id));
  if (newIds.length > 0) {
    this.seenPostIds.push(...newIds);
    
    // Update stats
    this.stats = this.stats || { postsLoaded: 0, scrollDepth: 0, lastActivity: new Date() };
    this.stats.postsLoaded += newIds.length;
    this.stats.scrollDepth += 1;
    this.stats.lastActivity = new Date();
    
    await this.save();
  }
  return this;
};

/**
 * Instance method to update cursor position
 */
FeedSessionSchema.methods.updateCursor = async function(this: IFeedSession, cursor: string): Promise<IFeedSession> {
  this.lastCursor = cursor;
  this.stats = this.stats || { postsLoaded: 0, scrollDepth: 0, lastActivity: new Date() };
  this.stats.lastActivity = new Date();
  await this.save();
  return this;
};

const FeedSession = mongoose.model<IFeedSession, IFeedSessionModel>('FeedSession', FeedSessionSchema);

export default FeedSession;
