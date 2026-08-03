/**
 * Shared Types for Mention
 * 
 * This package contains TypeScript interfaces and types that are shared
 * between the frontend and backend applications to ensure type consistency.
 */

// Common types and enums
export * from './common';

// Profile types
export * from './profile';

// Post types
export * from './post';

// Canonical mention placeholder parsing and reconciliation
export * from './mentions';

// Interaction types
export * from './interaction';

// Media types
export * from './media';

// Notification types
export * from './notification';

// List types
export * from './list';

// Lanes (a publisher's own named carriageways through their output)
export * from './lane';

// Channels (an Oxy account people follow without following the people who write for it)
export * from './channel';

// Activity subscriptions ("notify me when this account posts")
export * from './subscription';

// Feed types
export * from './feed';

// Language tags for multilingual post content (BCP-47 content tags, base-subtag matching)
export * from './language';

// External media embed preferences
export * from './externalEmbeds';

// Custom feeds (user-created timelines)
export * from './customFeed';

// Federation types (ActivityPub/Mastodon)
export * from './federation';

// Trending-topic telemetry
export * from './trending';

// Public (unauthenticated) realtime namespace contract
export * from './realtime';

// Local moderation-integration state (CrowdSource reports, decisions, enforcement)
export * from './moderation';

// MTN Protocol types
export * from './mtn';
