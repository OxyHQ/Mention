# Notification System Implementation

This document describes the comprehensive notification system implemented for the Mention app, including database schema, API endpoints, frontend components, and integration patterns.

## Overview

The notification system is designed to:
- Store minimal data in the database (action, content ID, user ID, etc.)
- Transform notifications on the frontend using translations
- Support real-time notifications via WebSocket
- Provide comprehensive internationalization (i18n) support

## Database Schema

The notification model stores minimal data that gets transformed on the frontend:

```typescript
interface INotification {
  recipientId: string;    // User receiving the notification
  actorId: string;        // User who performed the action
  type: string;           // like, reply, mention, follow, repost, quote, welcome
  entityId: string;       // ID of the post/reply/profile
  entityType: string;     // post, reply, profile
  read: boolean;          // Whether notification has been read
  createdAt: Date;        // Timestamp
}
```

## Backend Implementation

### API Endpoints

- `GET /notifications` - Fetch user notifications with pagination
- `POST /notifications` - Create a new notification
- `PUT /notifications/:id/read` - Mark notification as read
- `PUT /notifications/read-all` - Mark all notifications as read
- `DELETE /notifications/:id` - Delete a notification

### Notification Utilities

Use the `notificationUtils.ts` for creating notifications:

```typescript
import { createNotification, createMentionNotifications } from '../utils/notificationUtils';

// Create a like notification
await createNotification({
  recipientId: 'user123',
  actorId: 'user456',
  type: 'like',
  entityId: 'post789',
  entityType: 'post',
});

// Create mention notifications from post content
await createMentionNotifications(
  'Check out this post @john and @jane!',
  'post789',
  'user456'
);
```

## Frontend Implementation

### Components

#### NotificationItem
Displays individual notifications with proper formatting and translations:

```tsx
import { NotificationItem } from '../components/NotificationItem';

<NotificationItem
  notification={notification}
  onMarkAsRead={(id) => markAsRead(id)}
/>
```

#### Notifications Screen
Main screen for viewing notifications:

```tsx
import NotificationsScreen from '../app/notifications';

// The screen automatically handles:
// - Fetching notifications
// - Real-time updates
// - Mark as read functionality
// - Translations
```

### Hooks

#### useNotificationActions
Hook for creating notifications when user actions occur:

```tsx
import { useNotificationActions } from '../hooks/useNotificationActions';

const { notifyLike, notifyReply, notifyRepost, notifyFollow } = useNotificationActions();

// When user likes a post
await notifyLike(postId, postAuthorId);

// When user replies to a post
await notifyReply(postId, postAuthorId, replyId);
```

#### useRealtimeNotifications
Hook for real-time notification updates:

```tsx
import { useRealtimeNotifications } from '../hooks/useRealtimeNotifications';

// Automatically connects to WebSocket and updates notifications in real-time
useRealtimeNotifications();
```

#### useNotificationTransformer
Hook for transforming raw notification data:

```tsx
import { useNotificationTransformer } from '../utils/notificationTransformer';

const { transformNotifications } = useNotificationTransformer();

const transformedNotifications = transformNotifications(rawNotifications);
```

### Services

#### notificationService
Handles API communication for notifications:

```typescript
import { notificationService } from '../services/notificationService';

// Get notifications
const { notifications, unreadCount } = await notificationService.getNotifications();

// Mark as read
await notificationService.markAsRead(notificationId);
```

#### notificationCreationService
Creates notifications from the frontend:

```typescript
import { notificationCreationService } from '../services/notificationCreationService';

// Create a like notification
await notificationCreationService.notifyLike(postId, postAuthorId, likerId);
```

## Internationalization (i18n)

The system supports multiple languages with comprehensive translations:

### Supported Languages
- English (en)
- Spanish (es)
- Italian (it)

### Translation Keys

```json
{
  "notification.like": "{{actorName}} liked your post",
  "notification.reply": "{{actorName}} replied to your post",
  "notification.mention": "{{actorName}} mentioned you",
  "notification.follow": "{{actorName}} started following you",
  "notification.repost": "{{actorName}} reposted your post",
  "notification.quote": "{{actorName}} quoted your post",
  "notification.mark_all_read": "Mark all as read",
  "notification.empty.title": "No notifications yet",
  "notification.now": "now",
  "notification.minutes_ago": "{{count}}m ago"
}
```

### Adding New Languages

1. Create a new locale file in `/locales/`
2. Add translations for all notification keys
3. Update the i18n configuration in `_layout.tsx`

## Integration Examples

### Integrating with Post Actions

Replace the standard `PostActions` component:

```tsx
// Before
import PostActions from '../components/Post/PostActions';

// After
import PostActionsWithNotifications from '../components/Post/PostActionsWithNotifications';

// Usage
<PostActionsWithNotifications
  postId={post.id}
  postAuthorId={post.authorId}
  engagement={post.engagement}
  isLiked={post.isLiked}
  onLike={() => handleLike(post.id)}
  // ... other props
/>
```

### Integrating with Reply Creation

When creating a reply, automatically notify mentions:

```tsx
import { useNotificationActions } from '../hooks/useNotificationActions';

const { notifyReply, notifyMentions } = useNotificationActions();

const handleCreateReply = async (content: string, postId: string, postAuthorId: string) => {
  // Create the reply
  const reply = await createReply(content, postId);

  // Notify the original post author
  await notifyReply(postId, postAuthorId, reply.id);

  // Notify mentioned users
  await notifyMentions(content, reply.id);
};
```

### Integrating with Follow Actions

```tsx
import { useNotificationActions } from '../hooks/useNotificationActions';

const { notifyFollow } = useNotificationActions();

const handleFollow = async (userId: string) => {
  await followUser(userId);
  await notifyFollow(userId);
};
```

## Real-time Notifications

The system automatically connects to WebSocket for real-time updates:

1. **Automatic Connection**: The `useRealtimeNotifications` hook connects when the user is authenticated
2. **Live Updates**: New notifications appear instantly without page refresh
3. **Status Updates**: Read/unread status updates in real-time
4. **Cross-tab Sync**: Notifications sync across multiple browser tabs

## Best Practices

### Database
- Keep notification data minimal
- Use indexes for performance
- Handle duplicate prevention
- Don't create notifications for self-actions

### Frontend
- Always use translations for user-facing text
- Handle notification failures gracefully
- Use the provided hooks for consistency
- Test with different languages

### Performance
- Implement pagination for large notification lists
- Use WebSocket for real-time updates
- Cache notification data appropriately
- Batch notification creation when possible

### User Experience
- Show unread counts in navigation
- Allow bulk actions (mark all read)
- Provide clear notification types with distinct icons
- Support multiple languages

## Testing

### Unit Tests
- Test notification transformation logic
- Test translation key resolution
- Test hook functionality

### Integration Tests
- Test API endpoints
- Test WebSocket connections
- Test cross-component notification flow

### E2E Tests
- Test complete notification workflows
- Test real-time updates
- Test multi-language support

## Future Enhancements

- Push notifications for mobile
- Notification preferences and filtering
- Notification digests/emails
- Advanced notification grouping
- Notification analytics
