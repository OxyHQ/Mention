# Mention System - Instagram-like User Mentions

## Overview

The mention system allows users to tag other users in their posts and replies, similar to Instagram. When composing content, users can type `@` followed by a username to see a dropdown of matching users. The system stores both the display name (visible to users) and the user ID (for backend processing).

## Architecture

### Data Flow

1. **User Input**: User types `@` in the compose field
2. **Search**: System searches for matching users via Oxy services
3. **Selection**: User selects from dropdown
4. **Storage**: Text stores format: `@[username](userId)`
5. **Display**: Frontend shows: `@username` (clickable)
6. **Backend**: Receives array of user IDs in `mentions` field

### Components

#### 1. MentionPicker Component
**File**: `packages/frontend/components/MentionPicker.tsx`

Autocomplete dropdown that appears when typing `@`:
- Searches Oxy users via `oxyServices.searchProfiles()`
- Shows user avatar, name, username, and verified badge
- Debounced search (300ms delay)
- Keyboard dismissal handled
- Max 10 results

```tsx
interface MentionUser {
  id: string;
  username: string;
  name: string;
  avatar?: string;
  verified?: boolean;
}
```

#### 2. MentionTextInput Component
**File**: `packages/frontend/components/MentionTextInput.tsx`

Enhanced TextInput that handles mention detection and insertion:
- Detects `@` symbol while typing
- Shows/hides MentionPicker automatically
- Inserts mentions in format: `@[username](userId)`
- Displays only `@username` to user
- Tracks cursor position for proper insertion
- Exports mention metadata for backend

```tsx
interface MentionData {
  userId: string;
  username: string;
  displayName: string;
  startIndex: number;
  endIndex: number;
}
```

**Key Features**:
- `onMentionsChange` callback provides array of `MentionData`
- Automatically parses mentions from text
- Handles cursor positioning after mention insertion
- Compatible with existing TextInput props

#### 3. LinkifiedText Component (Updated)
**File**: `packages/frontend/components/common/LinkifiedText.tsx`

Renders mentions as clickable links in post content:
- Parses format: `@[displayName](userId)`
- Displays as: `@displayName` (colored and clickable)
- Navigates to user profile on tap
- Also handles URLs, hashtags, and cashtags
- Backwards compatible with plain `@username` format

## Usage

### In Compose Screen

```tsx
import MentionTextInput, { MentionData } from '@/components/MentionTextInput';

const [postContent, setPostContent] = useState('');
const [mentions, setMentions] = useState<MentionData[]>([]);

// In JSX
<MentionTextInput
  value={postContent}
  onChangeText={setPostContent}
  onMentionsChange={setMentions}
  placeholder="What's new?"
  multiline
  autoFocus
/>

// When submitting
await createPost({
  content: {
    text: postContent.trim(),
    // ... other content
  },
  mentions: mentions.map(m => m.userId), // Extract only user IDs
  hashtags: []
});
```

### In Reply Composer

Same pattern as compose screen. See `packages/frontend/app/p/[id].tsx`.

### In Thread Items

For multi-post threads, each item can have its own mentions:

```tsx
const [threadItems, setThreadItems] = useState<{
  id: string;
  text: string;
  mentions: MentionData[];
  // ... other fields
}[]>([]);

// In JSX for each thread item
<MentionTextInput
  value={item.text}
  onChangeText={(v) => setThreadItems(prev => 
    prev.map(p => p.id === item.id ? { ...p, text: v } : p)
  )}
  onMentionsChange={(m) => setThreadItems(prev => 
    prev.map(p => p.id === item.id ? { ...p, mentions: m } : p)
  )}
  placeholder="Say more..."
  multiline
/>
```

## Backend Integration

### Request Format

Posts and replies send mentions as an array of user IDs:

```typescript
{
  content: {
    text: "@[john_doe](user123) check this out!",
    media: [...],
    poll: {...}
  },
  mentions: ["user123"], // Only user IDs
  hashtags: []
}
```

### Backend Processing

**File**: `packages/backend/src/utils/notificationUtils.ts`

The backend already has mention notification logic:
- Extracts `@username` from text using regex
- Resolves usernames to Oxy user IDs
- Creates notifications for mentioned users
- Type: `'mention'`
- Entity type: `'post'`

The new system enhances this by:
1. Providing exact user IDs (no need to resolve usernames)
2. Storing mentions in `Post.mentions` field (array of oxyUserIds)
3. Enabling queries like "posts that mention me"

## Display Format

### In Compose/Edit Mode
User sees: `@john_doe` (standard text)

### In View Mode (Posts/Replies)
User sees: `@john_doe` (colored, clickable link)

### In Database/API
Stored as: `@[john_doe](user123)`

This separation ensures:
- Clean UX (no technical IDs visible)
- Accurate backend processing (correct user IDs)
- Future-proof (username changes don't break mentions)

## Styling

Mentions use the theme system:

```tsx
// In LinkifiedText
style={[{ color: colors.linkColor }, linkStyle]}
```

Default color: `colors.linkColor` (typically blue/primary)

Can be overridden via `linkStyle` prop:

```tsx
<LinkifiedText 
  text={content} 
  linkStyle={{ color: theme.colors.primary }}
/>
```

## Navigation

When a mention is tapped:

```tsx
router.push(`/@${displayName}`)
```

This navigates to the user's profile page following the existing `/@username` route pattern.

## Database Schema

### Post Model
**File**: `packages/backend/src/models/Post.ts`

```typescript
{
  mentions: [{ type: String, index: true }], // oxyUserIds
  // ... other fields
}
```

Index on mentions enables:
- Find posts mentioning specific users
- Analytics on mention frequency
- Notification queries

### Shared Types
**File**: `packages/shared-types/src/post.ts`

```typescript
export interface Post {
  // ...
  mentions?: string[]; // oxyUserIds
  // ...
}
```

## Features

### ✅ Implemented
- Type `@` to trigger mention picker
- Search users with debounced API calls
- Select user from dropdown
- Auto-insert mention with proper format
- Display mentions as clickable links
- Navigate to user profile on tap
- Send user IDs to backend
- Backend notification creation
- Theme support (light/dark)
- Works in compose, reply, and thread posts

### 🔄 Future Enhancements
- Mention suggestions based on:
  - Followers
  - Recent interactions
  - Previous mentions
- Bulk mention (multiple users at once)
- Mention autocomplete in search
- Analytics dashboard for mentions
- Mention-based filtering in feeds

## Testing

### Manual Testing Checklist

1. **Compose Screen**:
   - [ ] Type `@` shows picker
   - [ ] Search filters users
   - [ ] Select inserts mention
   - [ ] Multiple mentions work
   - [ ] Mention in thread items works

2. **Reply Composer**:
   - [ ] Same functionality as compose
   - [ ] Mentions saved with reply

3. **Display**:
   - [ ] Mentions show as `@username`
   - [ ] Mentions are colored
   - [ ] Tapping navigates to profile
   - [ ] Works in feed, detail view

4. **Backend**:
   - [ ] User IDs received correctly
   - [ ] Notifications created
   - [ ] Mentions stored in database

## Troubleshooting

### Picker Not Showing
- Check `@` detection logic in `handleTextChange`
- Verify `showMentionPicker` state updates
- Check for console errors in `searchProfiles`

### Mentions Not Saving
- Verify `onMentionsChange` callback is called
- Check mention data format in `handlePost`/`handleReply`
- Inspect network request payload

### Display Issues
- Check regex in `LinkifiedText`
- Verify mention format in post content
- Check theme colors

### Navigation Not Working
- Verify username format
- Check router configuration
- Ensure `/@username` route exists

## API Reference

### MentionTextInput Props

```typescript
interface MentionTextInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onMentionsChange?: (mentions: MentionData[]) => void;
  placeholder?: string;
  maxLength?: number;
  multiline?: boolean;
  style?: any;
  // ... all standard TextInput props
}
```

### MentionPicker Props

```typescript
interface MentionPickerProps {
  query: string;
  onSelect: (user: MentionUser) => void;
  onClose: () => void;
  maxHeight?: number;
}
```

## Performance Considerations

1. **Debounced Search**: 300ms delay prevents excessive API calls
2. **Memoized Callbacks**: Prevents unnecessary re-renders
3. **Lazy Rendering**: Picker only mounts when needed
4. **Efficient Parsing**: Regex-based mention extraction
5. **Cursor Tracking**: Minimal state updates

## Security

1. **User ID Validation**: Backend verifies user IDs exist
2. **Permission Checks**: Only valid Oxy users can be mentioned
3. **XSS Prevention**: Text content is sanitized
4. **Rate Limiting**: Search API has rate limits

## Accessibility

- Picker supports keyboard navigation
- Screen reader compatible
- Touch targets meet minimum size (48x48)
- Color contrast meets WCAG AA

## Related Files

- `packages/frontend/components/MentionPicker.tsx` - User search dropdown
- `packages/frontend/components/MentionTextInput.tsx` - Mention input handler
- `packages/frontend/components/common/LinkifiedText.tsx` - Mention display
- `packages/frontend/app/compose.tsx` - Main compose screen
- `packages/frontend/app/p/[id].tsx` - Reply composer
- `packages/backend/src/utils/notificationUtils.ts` - Mention notifications
- `packages/backend/src/models/Post.ts` - Database schema
- `packages/shared-types/src/post.ts` - Type definitions
