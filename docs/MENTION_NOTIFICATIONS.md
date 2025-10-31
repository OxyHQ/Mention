# Mention Notifications System

## Overview
When a user mentions someone in a post or reply, the mentioned user(s) automatically receive a notification. This creates engagement and helps users discover when they're being talked about.

## How It Works

### 1. **Creating a Post with Mentions**

When a user creates a post:
```typescript
// Frontend sends:
POST /api/posts
{
  content: {
    text: "Hey [mention:user123], check this out!"
  },
  mentions: ["user123", "user456"] // Array of mentioned user IDs
}
```

### 2. **Backend Processing**

The posts controller:
1. Saves the post to MongoDB
2. Calls `createMentionNotifications()` with the mentions array
3. Creates a notification for each mentioned user

```typescript
// In posts.controller.ts
if (mentions && mentions.length > 0) {
  await createMentionNotifications(
    mentions,           // Array of user IDs
    post._id.toString(), // Post ID
    userId,             // Actor (who mentioned)
    'post'              // Entity type
  );
}
```

### 3. **Notification Creation**

For each mentioned user:
```typescript
// In notificationUtils.ts
await createNotification({
  recipientId: mentionedUserId,  // Who receives the notification
  actorId: authorUserId,         // Who created the mention
  type: 'mention',
  entityId: postId,
  entityType: 'post', // or 'reply'
});
```

### 4. **Real-time Delivery**

The notification is:
- ✅ Saved to MongoDB (Notification collection)
- ✅ Emitted via Socket.io to the user's real-time connection
- ✅ Sent as push notification (if user has push enabled)

### 5. **Frontend Display**

The notification appears in the user's notification feed:
```
┌─────────────────────────────────────────┐
│ 🔔 Notifications                        │
├─────────────────────────────────────────┤
│                                         │
│ 👤 John Doe mentioned you               │
│    "Hey John Doe, check this out!"      │
│    2 minutes ago                        │
│                                         │
└─────────────────────────────────────────┘
```

Tapping the notification navigates to the post where they were mentioned.

---

## Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                       USER CREATES POST                          │
│                                                                   │
│  Composer: "Hey @john_doe, great work!"                         │
│            ↓                                                      │
│  Frontend: mentions = ["user123"]                                │
│            text = "Hey [mention:user123], great work!"           │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                        POST SAVED                                │
│                                                                   │
│  MongoDB Post:                                                   │
│  {                                                               │
│    content: { text: "Hey [mention:user123], great work!" },     │
│    mentions: ["user123"],                                        │
│    oxyUserId: "current_user",                                    │
│    ...                                                           │
│  }                                                               │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                  NOTIFICATION CREATED                            │
│                                                                   │
│  createMentionNotifications(["user123"], postId, authorId)      │
│                                                                   │
│  MongoDB Notification:                                           │
│  {                                                               │
│    recipientId: "user123",                                       │
│    actorId: "current_user",                                      │
│    type: "mention",                                              │
│    entityId: postId,                                             │
│    entityType: "post",                                           │
│    read: false,                                                  │
│    createdAt: "2025-10-30T10:30:00Z"                            │
│  }                                                               │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    REAL-TIME DELIVERY                            │
│                                                                   │
│  1. Socket.io emit to user123's connection:                     │
│     io.to('user:user123').emit('notification', {...})           │
│                                                                   │
│  2. Push notification sent to user123's device:                 │
│     "John Doe mentioned you in a post"                          │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                     USER RECEIVES                                │
│                                                                   │
│  - Badge appears on notifications tab                           │
│  - Notification in feed                                         │
│  - Push notification on device                                  │
│  - Tapping navigates to post                                    │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Code Implementation

### Backend: notificationUtils.ts

```typescript
/**
 * Creates notifications for mentions in content
 * @param mentionUserIds - Array of Oxy user IDs who were mentioned
 * @param postId - ID of the post containing the mentions
 * @param actorId - ID of the user who created the post
 * @param entityType - Type of entity ('post' or 'reply')
 * @param emitEvent - Whether to emit real-time events
 */
export const createMentionNotifications = async (
  mentionUserIds: string[],
  postId: string,
  actorId: string,
  entityType: 'post' | 'reply' = 'post',
  emitEvent: boolean = true
): Promise<void> => {
  if (!mentionUserIds || mentionUserIds.length === 0) return;

  const uniqueUserIds = [...new Set(mentionUserIds)];

  for (const recipientId of uniqueUserIds) {
    // Skip if user is mentioning themselves
    if (recipientId === actorId) continue;

    await createNotification({
      recipientId,
      actorId,
      type: 'mention',
      entityId: postId,
      entityType,
    }, emitEvent);
  }
};
```

### Backend: posts.controller.ts

```typescript
// After creating a post
if (mentions && mentions.length > 0) {
  const isReply = Boolean(parentPostId || in_reply_to_status_id);
  await createMentionNotifications(
    mentions,              // User IDs array
    post._id.toString(),   // Post ID
    userId,                // Author ID
    isReply ? 'reply' : 'post'
  );
}
```

### Frontend: notificationTransformer.ts

```typescript
case 'mention':
  return {
    ...baseNotification,
    title: t('notification.mention', { actorName }),
    message: getEntityDescription(rawNotification, t),
  };
```

### Translation: locales/en.json

```json
{
  "notification.mention": "{{actorName}} mentioned you",
  "notification.mention_reply": "{{actorName}} mentioned you in a reply"
}
```

---

## Features

### ✅ Automatic Detection
- Mentions are detected from the `mentions` array sent with the post
- No text parsing needed on the backend
- Reliable and accurate

### ✅ Duplicate Prevention
- Only one notification per mention per post
- Won't notify if user mentions themselves
- Prevents spam

### ✅ Real-time Delivery
- Socket.io delivers notifications instantly
- Push notifications sent to mobile devices
- Badge updates in real-time

### ✅ Post vs Reply Context
- Distinguishes between post mentions and reply mentions
- Different translations available
- Proper context in notification

### ✅ Navigation
- Tapping notification navigates directly to the post
- Deep linking support
- Seamless user experience

---

## Examples

### Example 1: Single Mention

**User Action:**
```
Create post: "Hey @john_doe, check this out!"
```

**Backend Processing:**
```javascript
mentions = ["user123"] // john_doe's user ID
createMentionNotifications(["user123"], postId, authorId, 'post')
```

**Notification Created:**
```json
{
  "recipientId": "user123",
  "actorId": "current_user",
  "type": "mention",
  "entityId": "post_456",
  "entityType": "post"
}
```

**User Sees:**
```
🔔 Jane Smith mentioned you
   "Hey John Doe, check this out!"
   2 minutes ago
```

### Example 2: Multiple Mentions

**User Action:**
```
Create post: "Thanks @john_doe and @alice for the help!"
```

**Backend Processing:**
```javascript
mentions = ["user123", "user789"]
createMentionNotifications(["user123", "user789"], postId, authorId, 'post')
```

**Notifications Created:**
- Notification to user123 (john_doe)
- Notification to user789 (alice)

**Both Users See:**
```
🔔 Bob Johnson mentioned you
   "Thanks John Doe and Alice for the help!"
   5 minutes ago
```

### Example 3: Reply with Mention

**User Action:**
```
Reply to post: "@jane_smith I agree with your point"
```

**Backend Processing:**
```javascript
mentions = ["user456"]
isReply = true
createMentionNotifications(["user456"], postId, authorId, 'reply')
```

**Notification Created:**
```json
{
  "recipientId": "user456",
  "actorId": "current_user",
  "type": "mention",
  "entityId": "post_789",
  "entityType": "reply"
}
```

**User Sees:**
```
🔔 Tom Wilson mentioned you in a reply
   "Jane Smith I agree with your point"
   1 minute ago
```

---

## Edge Cases

### Self-Mention Prevention
```typescript
// User mentions themselves
if (recipientId === actorId) continue;
```
**Result:** No notification created

### Duplicate Mentions
```typescript
// User mentions same person multiple times in one post
const uniqueUserIds = [...new Set(mentionUserIds)];
```
**Result:** Only one notification per unique user

### Invalid User IDs
```typescript
// Graceful error handling
try {
  await createNotification({...});
} catch (e) {
  console.error('Failed to create mention notification for user', recipientId, e);
}
```
**Result:** Other notifications still created, error logged

### Empty Mentions Array
```typescript
if (!mentionUserIds || mentionUserIds.length === 0) return;
```
**Result:** Function exits early, no processing

---

## Notification Flow

### 1. Creation
```typescript
POST /api/posts → Save post → createMentionNotifications()
```

### 2. Storage
```typescript
MongoDB Notification document created
```

### 3. Real-time
```typescript
Socket.io emit → User's active connections notified
```

### 4. Push
```typescript
Push notification → User's registered devices
```

### 5. Display
```typescript
Notification list → Badge count → User interaction
```

---

## Testing Checklist

- [ ] Create post with one mention → Recipient gets notification
- [ ] Create post with multiple mentions → All recipients get notifications
- [ ] Reply with mention → Recipient gets notification (labeled as reply)
- [ ] Self-mention → No notification created
- [ ] Duplicate mentions in same post → Only one notification
- [ ] Real-time delivery → Notification appears immediately
- [ ] Push notification → Sent to mobile device
- [ ] Tap notification → Navigates to correct post
- [ ] Notification badge → Updates in real-time
- [ ] Mark as read → Badge count decreases
- [ ] Delete post → (Optional: Delete associated notifications)

---

## Future Enhancements

### 1. **Mention Preferences**
```typescript
// User settings
{
  mentionNotifications: 'everyone' | 'following' | 'none',
  mutedUsers: ['user456'], // Don't notify from these users
}
```

### 2. **Batch Notifications**
```typescript
// If mentioned in multiple posts quickly
"John Doe mentioned you 3 times"
```

### 3. **Thread Mentions**
```typescript
// Notify about new mentions in a thread you're part of
"New mention in a thread you're in"
```

### 4. **Mention Analytics**
```typescript
// Track who mentions you most
// See mention trends over time
```

### 5. **Rich Notifications**
```typescript
// Show post preview in notification
// Include images/media
// Action buttons (like, reply)
```

---

## Summary

The mention notification system:
- ✅ Uses the `mentions` array from post creation
- ✅ Creates notifications for each unique mentioned user
- ✅ Delivers via Socket.io and push notifications
- ✅ Distinguishes between posts and replies
- ✅ Prevents duplicates and self-mentions
- ✅ Provides seamless navigation to mentioned posts
- ✅ Works with the existing notification infrastructure

**Result:** Users are instantly notified when mentioned, creating engagement and keeping conversations flowing! 🎉
