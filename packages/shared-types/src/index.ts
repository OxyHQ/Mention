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

// Interaction types
export * from './interaction';

// Media types
export * from './media';

// Notification types
export * from './notification';

// List types
export * from './list';

// Analytics types
export * from './analytics';

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

// MTN Protocol types
export * from './mtn';
