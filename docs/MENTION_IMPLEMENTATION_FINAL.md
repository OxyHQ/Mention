# Mention System - Final Implementation

## Updated Architecture

### Storage Strategy

**Frontend (Compose/Reply)**:
- Text field stores: `"Hey @john_doe check this out!"`  (plain text with @username)
- Mentions array: `[{ userId: "user123", username: "john_doe", displayName: "John Doe", indices: [4, 13] }]`
- Backend receives: 
  - `text: "Hey @john_doe check this out!"`
  - `mentions: ["user123"]` (only user IDs)

**Backend (Database)**:
- `Post.content.text`: `"Hey @john_doe check this out!"` (plain text)
- `Post.mentions`: `["user123"]` (array of Oxy user IDs)
- Indexed for queries like "posts mentioning user123"

**Display (Feed/Detail)**:
- Frontend shows: "Hey **@John Doe** check this out!" (using current full name)
- Clickable mention navigates to profile
- If username changed, still navigates to correct user (via ID)

## Why This Approach?

✅ **User IDs in backend** - Usernames can change, IDs cannot  
✅ **Plain text storage** - No complex markup to parse  
✅ **Display flexibility** - Show current full name, not stale username  
✅ **Search friendly** - Can search by text content easily  
✅ **Backward compatible** - Works with existing @username patterns  

## Components

### 1. MentionTextInput
Stores plain text like `@john_doe` in the text field, and tracks:
```typescript
{
  userId: "user123",          // For backend
  username: "john_doe",       // For URL/navigation  
  displayName: "John Doe",    // Full name for display
  indices: [4, 13]            // Position in text
}
```

### 2. Backend
Receives:
```json
{
  "content": {
    "text": "Hey @john_doe check this out!"
  },
  "mentions": ["user123"]  // Only user IDs
}
```

Stores in MongoDB:
```javascript
{
  content: { text: "..." },
  mentions: ["user123"],  // Indexed
  // ... other fields
}
```

### 3. Display (LinkifiedText)
When rendering post:
1. Parse `@username` patterns
2. Look up in `mentions` array to get user ID
3. Optionally fetch current full name from Oxy
4. Render as clickable `@Full Name`
5. Navigate to `/@username` on click

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
User selects → Inserts: "@John Doe" (display name)
  ↓
Text: "Hey @John Doe check this!"
Mentions: [{ userId: "user123", username: "john_doe", displayName: "John Doe", indices: [4, 13] }]
  ↓
Backend receives:
  text: "Hey @John Doe check this!"
  mentions: ["user123"]
  ↓
Backend stores:
  content.text: "Hey @John Doe check this!"
  mentions: ["user123"]
  ↓
Display renders:
  "Hey @John Doe check this!" (clickable, navigates to @john_doe profile)
```

## Key Insight

The text shows the **full name at time of mention**, but navigation uses the **username**, and the backend stores the **user ID**. This gives us:
- Readable text for users
- Stable references for backend
- Current data for display
- Proper navigation regardless of username changes
