# @mention/shared-types

Shared TypeScript types for the Mention social network platform. This package contains all the interfaces, enums, and types that are shared between the frontend and backend applications to ensure type consistency.

## Overview

Mention is a Twitter-like social network where users can create posts (instead of tweets), interact with content, and build communities. This package provides comprehensive type definitions for all core functionality.

## Architecture

The platform uses **Oxy** for user authentication and user data management. All user-related data is linked to Oxy users via `oxyUserId` fields.

## Package Structure

```
src/
├── common.ts          # Common utility types and enums
├── profile.ts         # Profile-related types
├── post.ts           # Post (tweet) types
├── interaction.ts    # User interaction types (likes, reposts, etc.)
├── feed.ts          # Feed and timeline types
├── media.ts         # Media content types
├── notification.ts  # Notification system types
├── list.ts          # User list types
├── analytics.ts     # Analytics and metrics types
└── index.ts         # Main export file
```

## Core Types

### Profile Types (`profile.ts`)

- **Profile**: Main profile interface linked to Oxy users
- **ProfileType**: Personal, Business, Creator, Verified
- **ProfileVisibility**: Public, Private, Followers Only
- **PersonalInfo**: Bio, display name, username, avatar, etc.
- **ProfileSettings**: Notification and privacy settings

### Post Types (`post.ts`)

- **Post**: Main post interface (equivalent to tweets)
- **PostType**: Text, Image, Video, Poll, Repost, Quote
- **PostContent**: Text, images, videos, polls, location
- **PostVisibility**: Public, Followers Only, Private
- **PollData**: Poll questions, options, and voting data

### Interaction Types (`interaction.ts`)

- **Interaction**: Generic interaction interface
- **Like**: Post/comment likes
- **Repost**: Repost and quote functionality
- **Comment**: Nested comment system
- **Follow**: User following relationships
- **Block/Mute**: User blocking and muting
- **Bookmark**: Post bookmarking
- **Report**: Content reporting system

### Feed Types (`feed.ts`)

- **Feed**: Generic feed interface
- **FeedType**: Home, Explore, Trending, User Profile, etc.
- **FeedAlgorithm**: Chronological, Relevance, Engagement, Personalized
- **TimelineFeed**: Home timeline feeds
- **ExploreFeed**: Discovery and trending feeds
- **SearchFeed**: Search results feeds

### Media Types (`media.ts`)

- **Media**: Generic media interface
- **MediaType**: Image, Video, Audio, GIF, Document
- **ImageMedia**: Image-specific metadata and EXIF data
- **VideoMedia**: Video metadata, codecs, dimensions
- **AudioMedia**: Audio metadata and properties
- **MediaProcessingJob**: Media processing and optimization

### Notification Types (`notification.ts`)

- **Notification**: Generic notification interface
- **NotificationType**: Like, Repost, Comment, Follow, Mention, etc.
- **NotificationPriority**: Low, Normal, High, Urgent
- **NotificationPreferences**: User notification settings
- **Specific notification types**: LikeNotification, FollowNotification, etc.

### List Types (`list.ts`)

- **List**: User-created lists (like Twitter lists)
- **ListVisibility**: Public, Private
- **ListType**: User, Topic, Curated
- **ListMember**: List membership
- **ListSubscriber**: List following

### Analytics Types (`analytics.ts`)

- **AnalyticsData**: Generic analytics data points
- **UserAnalytics**: User-specific metrics and insights
- **PostAnalytics**: Post performance metrics
- **AudienceAnalytics**: Follower demographics and behavior
- **PlatformAnalytics**: Platform-wide statistics

## Key Features

### Oxy Integration
All user-related data is linked to Oxy users via `oxyUserId` fields:
- Profiles are linked to Oxy users
- Posts are authored by Oxy users
- Interactions are performed by Oxy users
- Notifications are sent to Oxy users

### Comprehensive Social Features
- **Posts**: Text, images, videos, polls, location sharing
- **Interactions**: Likes, reposts, comments, follows, blocks, mutes
- **Feeds**: Multiple feed types with different algorithms
- **Media**: Rich media support with processing
- **Notifications**: Comprehensive notification system
- **Lists**: User-curated lists for organizing follows
- **Analytics**: Detailed metrics and insights

### Production Ready
- **Type Safety**: Full TypeScript support with strict typing
- **Extensible**: Easy to extend with new features
- **Consistent**: Shared between frontend and backend
- **Documented**: Comprehensive JSDoc comments
- **Maintained**: Regular updates and improvements

## Usage

### Installation

```bash
npm install @mention/shared-types
```

### Import Types

```typescript
import { 
  Post, 
  Profile, 
  InteractionType, 
  FeedType,
  NotificationType 
} from '@mention/shared-types';
```

### Example Usage

```typescript
// Create a new post
const newPost: CreatePostRequest = {
  content: {
    text: "Hello Mention!",
    images: ["image1.jpg", "image2.jpg"]
  },
  visibility: PostVisibility.PUBLIC,
  hashtags: ["mention", "social"]
};

// User profile with Oxy integration
const profile: Profile = {
  id: "profile123",
  oxyUserId: "oxy_user_456",
  profileType: ProfileType.PERSONAL,
  isPrimary: true,
  isActive: true,
  personalInfo: {
    username: "johndoe",
    displayName: "John Doe",
    bio: "Software developer"
  },
  // ... other fields
};
```

## Development

### Building

```bash
npm run build
```

### Development Mode

```bash
npm run dev
```

### Linting

```bash
npm run lint
```

## Contributing

When adding new types:

1. Follow the existing naming conventions
2. Use `oxyUserId` for user references
3. Add comprehensive JSDoc comments
4. Update this README if adding new major features
5. Ensure all types are exported from `index.ts`

## License

UNLICENSED - Private package for Mention platform 