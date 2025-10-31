# Mention System - Final Implementation

## Updated Architecture

### Storage Strategy

**Frontend (Compose/Reply)**:
- Text field displays: `"Hey @john_doe check this out!"` (shows @username to user)
- Text field stores: `"Hey [mention:user123] check this out!"` (storage format with user ID)
- Mentions array: `[{ userId: "user123", username: "john_doe", displayName: "John Doe" }]`
- Backend receives: 
  - `text: "Hey [mention:user123] check this out!"` (storage format)
  - `mentions: ["user123"]` (only user IDs)

**Backend (Database)**:
- `Post.content.text`: `"Hey [mention:user123] check this out!"` (placeholder format)
- `Post.mentions`: `["user123"]` (array of Oxy user IDs)
- Indexed for queries like "posts mentioning user123"

**Backend Processing**:
- Transforms `[mention:user123]` → `[@John Doe](john_doe)` before sending to frontend
- Fetches current user data (display name and username) for each mention

**Display (Feed/Detail)**:
- Frontend receives: `"Hey [@John Doe](john_doe) check this out!"`
- Frontend displays: "Hey **John Doe** check this out!" (full name, no @ symbol, clickable)
- Clickable mention navigates to `/@john_doe` profile
- Always shows current user data (name/username may have changed since post creation)

## Why This Approach?

✅ **User IDs in storage** - Usernames can change, IDs cannot  
✅ **Placeholder format** - Uses `[mention:userId]` for stable references  
✅ **Display flexibility** - Shows current full name, not stale username  
✅ **Clean display** - No @ symbol clutter in posts (Instagram-style)  
✅ **Backend resolution** - Backend fetches current user data when serving posts  
✅ **Future-proof** - Works even if usernames or display names change  

## Components

### 1. MentionTextInput
**File**: `packages/frontend/components/MentionTextInput.tsx`

- Displays `@username` to user while typing
- Converts to `[mention:userId]` format for storage
- Tracks mention metadata:
```typescript
{
  userId: "user123",          // For backend storage
  username: "john_doe",       // For URL/navigation  
  displayName: "John Doe",    // Full name for display
}
```

### 2. Backend Storage
Receives from frontend:
```json
{
  "content": {
    "text": "Hey [mention:user123] check this out!"
  },
  "mentions": ["user123"]  // Only user IDs
}
```

Stores in MongoDB:
```javascript
{
  content: { text: "Hey [mention:user123] check this out!" },
  mentions: ["user123"],  // Indexed for queries
  // ... other fields
}
```

### 3. Backend Processing
**File**: `packages/backend/src/controllers/feed.controller.ts`

Method: `replaceMentionPlaceholders()`
- Fetches current user data for each mention
- Transforms: `[mention:user123]` → `[@John Doe](john_doe)`
- Sends formatted text to frontend

### 4. Frontend Display (LinkifiedText)
**File**: `packages/frontend/components/common/LinkifiedText.tsx`

When rendering post:
1. Receives: `"Hey [@John Doe](john_doe) check this out!"`
2. Parses `[@DisplayName](username)` format
3. Renders as clickable text: "John Doe" (no @ symbol)
4. Navigates to `/@username` on tap
5. Shows current user data (resolved by backend)

## Implementation Status

✅ MentionPicker - User search dropdown  
✅ MentionTextInput - Detects @, inserts mentions  
✅ Compose screen - Sends user IDs to backend  
✅ Reply composer - Sends user IDs to backend  
✅ Backend - Stores user IDs in mentions array  
✅ LinkifiedText - Renders @mentions as clickable links  
✅ Name object handling - Properly extracts full name from {first, last, full}

## Benefits

1. **Future-proof**: Username changes don't break mentions
2. **Performance**: No complex text parsing/replacement
3. **Accurate**: Always shows current user data
4. **Simple**: Plain text storage, metadata separate
5. **Scalable**: Can add mention analytics easily

## Example Flow

```
User types: "Hey @j"
  ↓
MentionPicker shows: "John Doe (@john_doe)"  
  ↓
User selects → MentionTextInput inserts: "@john_doe"
  ↓
User sees in composer: "Hey @john_doe check this!"
Storage format: "Hey [mention:user123] check this!"
Mentions array: [{ userId: "user123", username: "john_doe", displayName: "John Doe" }]
  ↓
Backend receives:
  text: "Hey [mention:user123] check this!"
  mentions: ["user123"]
  ↓
Backend stores in MongoDB:
  content.text: "Hey [mention:user123] check this!"
  mentions: ["user123"]
  ↓
Backend processes (replaceMentionPlaceholders):
  Fetches user data for user123
  Transforms: [mention:user123] → [@John Doe](john_doe)
  Sends to frontend: "Hey [@John Doe](john_doe) check this!"
  ↓
Frontend displays (LinkifiedText):
  Parses: [@John Doe](john_doe)
  Renders: "Hey John Doe check this!"
           ^^^^^^^^^ (blue, clickable, no @ symbol)
  Tap → navigates to /@john_doe
```

## Key Insights

### Three-Stage Transformation:
1. **Composer**: Shows `@username` (clear, unambiguous)
2. **Storage**: Uses `[mention:userId]` (stable, permanent)
3. **Display**: Shows `Full Name` (natural, elegant, no @)

### Benefits:
- ✅ **Stable storage**: User IDs never change
- ✅ **Current display**: Always shows latest user data
- ✅ **Clean UX**: No @ symbols in posts (Instagram-style)
- ✅ **Proper navigation**: Uses username for URLs
- ✅ **Future-proof**: Works even if users change names
