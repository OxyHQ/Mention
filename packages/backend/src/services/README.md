# Feed Algorithm Services

This directory contains the advanced feed ranking and personalization services for the Mention social platform. The system is designed similar to how Twitter/X and Facebook rank content in user feeds.

## Overview

The feed algorithm consists of four main services:

1. **FeedRankingService** - Core ranking algorithm
2. **UserPreferenceService** - Learns user preferences from behavior
3. **FeedCacheService** - Caches precomputed feeds for performance
4. **FeedJobScheduler** - Background jobs for feed computation

## Important: User ID Convention

Throughout the codebase:
- **Database fields**: Use `oxyUserId` (e.g., `Post.oxyUserId`, `UserBehavior.oxyUserId`)
- **Function parameters/variables**: Use `userId` or `currentUserId` (these contain Oxy user IDs from `req.user?.id`)
- **When querying**: Use `UserBehavior.findOne({ oxyUserId: userId })` - the variable `userId` contains an Oxy user ID and is used to query the `oxyUserId` field

**Note**: `req.user?.id` is always an Oxy user ID (not a local user ID), as authentication is handled by Oxy.

## FeedRankingService

The core ranking service that calculates post scores based on multiple factors:

### Ranking Factors

1. **Engagement Score** - Likes (1.0x), Reposts (2.5x), Comments (2.0x), Saves (1.5x), Views (0.1x)
2. **Recency Score** - Exponential decay with 24-hour half-life
3. **Author Relationship** - Follow boost (1.8x), Strong relation (1.5x), Weak relation (1.2x)
4. **Personalization** - Topic matches (1.4x), Post type matches (1.3x), Language matches (1.2x)
5. **Content Quality** - High engagement rate (1.3x), Low engagement rate (0.8x)
6. **Diversity** - Same author penalty (0.95x), Same topic penalty (0.92x)
7. **Negative Signals** - Hidden/muted/blocked content filtered out

### Usage

```typescript
import { feedRankingService } from './services/FeedRankingService';

// Calculate score for a single post
const score = await feedRankingService.calculatePostScore(
  post,
  userId,
  { followingIds, userBehavior }
);

// Rank a list of posts
const rankedPosts = await feedRankingService.rankPosts(
  posts,
  userId,
  { followingIds, userBehavior }
);
```

## UserPreferenceService

Learns user preferences from interactions and behavior patterns.

### Features

- **Author Preferences** - Tracks relationship strength with authors
- **Topic Preferences** - Learns user interests from hashtags
- **Post Type Preferences** - Text, image, video, poll preferences
- **Time-based Preferences** - Active hours, language preferences
- **Negative Signals** - Tracks hidden, muted, blocked content

### Usage

```typescript
import { userPreferenceService } from './services/UserPreferenceService';

// Record an interaction
await userPreferenceService.recordInteraction(userId, postId, 'like');

// Get user behavior data
const behavior = await userPreferenceService.getUserBehavior(userId);

// Batch update preferences from historical data
await userPreferenceService.batchUpdatePreferences(userId);
```

## FeedCacheService

Caches precomputed feeds to improve performance.

### Features

- **Precomputed Feeds** - For You, Following, Explore feeds
- **Cache Invalidation** - Automatically invalidates on user interactions
- **TTL Management** - 15-minute cache expiration
- **Size Limits** - Maximum 1000 cached feeds

### Usage

```typescript
import { feedCacheService } from './services/FeedCacheService';

// Get or compute feed
const posts = await feedCacheService.getOrComputeFeed(
  userId,
  'for_you',
  async () => computeFeed()
);

// Invalidate user cache
await feedCacheService.invalidateUserCache(userId, 'for_you');

// Precompute feed
await feedCacheService.precomputeFeed(userId, 'for_you', 50);
```

## FeedJobScheduler

Background jobs for feed computation and updates.

### Jobs

- **Precompute Feeds** - Every 15 minutes for active users
- **Update Preferences** - Every hour from recent activity
- **Clean Cache** - Every 5 minutes

### Usage

The scheduler starts automatically when the server starts. You can also manually trigger jobs:

```typescript
import { feedJobScheduler } from './services/FeedJobScheduler';

// Precompute feeds for a user
await feedJobScheduler.precomputeUserFeeds(userId);

// Update preferences for a user
await feedJobScheduler.updateUserPreferencesForUser(userId);
```

## UserBehavior Model

Tracks user behavior patterns for personalization.

### Schema

- `preferredAuthors` - Array of authors with relationship weights
- `preferredTopics` - Array of topics/hashtags with interest weights
- `preferredPostTypes` - Counts for text, image, video, poll
- `activeHours` - Hours when user is most active
- `preferredLanguages` - User language preferences
- `hiddenAuthors` - Authors whose posts are hidden
- `mutedAuthors` - Muted authors
- `blockedAuthors` - Blocked authors

## Integration with Feed Controller

The feed controller uses these services to provide personalized feeds:

1. **For You Feed** - Uses FeedRankingService for personalized ranking
2. **Interaction Tracking** - UserPreferenceService records all interactions
3. **Cache Management** - FeedCacheService manages feed caching
4. **Background Jobs** - FeedJobScheduler refreshes feeds periodically

## Performance Considerations

- **Ranking** - Calculates scores for candidate posts (3x limit) then ranks
- **Caching** - Precomputed feeds reduce database load
- **Background Jobs** - Offloads feed computation from request path
- **Deduplication** - Prevents duplicate posts in feeds

## Future Enhancements

- Machine learning models for better personalization
- Real-time feed updates via WebSocket
- A/B testing for ranking weights
- Geographic preference learning
- Content similarity scoring
- Trend detection and boosting

