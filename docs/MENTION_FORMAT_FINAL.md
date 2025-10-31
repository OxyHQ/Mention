# Mention System - Final Format Summary

## Three-Stage Format Transformation

### 1. Composer Display (What User Sees While Typing)
**Format**: `@username`
**Example**: `"Hey @john_doe, check this out!"`

When user types `@joh`, the picker shows:
```
┌─────────────────────┐
│ 👤 John Doe         │
│    @john_doe        │
└─────────────────────┘
```

After selection, composer shows:
```
"Hey @john_doe, check this out!"
     ^^^^^^^^^^
     Username (handle)
```

### 2. Backend Storage (MongoDB)
**Format**: `[mention:userId]`
**Example**: `"Hey [mention:user123], check this out!"`

- Stable: User IDs never change
- Compact: Efficient storage
- Reference: Points to actual user record

### 3. Post Display (What User Sees in Feed)
**Format**: `Full Name` (no @, just clickable colored text)
**Example**: `"Hey John Doe, check this out!"` (where "John Doe" is blue/clickable)

**Internal Format from Backend**: `[@Full Name](username)`
**Example**: `"Hey [@John Doe](john_doe), check this out!"`

LinkifiedText parses this and renders:
```
"Hey John Doe, check this out!"
     ^^^^^^^^^
     Blue, clickable, navigates to /@john_doe
```

---

## Visual Comparison

### Instagram-Style Behavior

#### Composing:
```
Type: "Hey @joh"
      ↓
Pick: John Doe (@john_doe)
      ↓
See:  "Hey @john_doe"
```

#### Reading:
```
See:  "Hey John Doe"
           ^^^^^^^^^
           Blue, clickable
```

### Format at Each Stage:

| Stage | Location | Format | Example |
|-------|----------|--------|---------|
| **Typing** | Composer Input | `@username` | `@john_doe` |
| **Storage** | MongoDB | `[mention:userId]` | `[mention:user123]` |
| **Display** | Feed/Post | `Full Name` (clickable) | `John Doe` |

---

## Benefits of This Approach

### 1. Clear Composer UX
- ✅ `@username` is unambiguous - you know exactly who you're mentioning
- ✅ Usernames are unique - no confusion between "John Doe" and "John Doe"
- ✅ Familiar pattern from Twitter/X
- ✅ Easy to type and autocomplete

### 2. Stable Storage
- ✅ User IDs never change (unlike usernames which can be updated)
- ✅ Mentions remain valid even if user changes their name or username
- ✅ Efficient database storage

### 3. Natural Display
- ✅ Full names are more readable than handles
- ✅ No @ symbol clutter in posts
- ✅ Looks like natural conversation
- ✅ Instagram-style elegance

### 4. Always Current
- ✅ Display name always reflects user's current name
- ✅ Old posts automatically show updated names
- ✅ No stale data

---

## Technical Flow

### Creating a Post

```typescript
// User types in composer:
"Hey @john_doe, check this out!"

// MentionTextInput converts to storage format:
text: "Hey [mention:user123], check this out!"
mentions: ["user123"]

// Sent to backend:
POST /api/posts
{
  content: {
    text: "Hey [mention:user123], check this out!"
  },
  mentions: ["user123"]
}

// Stored in MongoDB:
{
  content: {
    text: "Hey [mention:user123], check this out!"
  },
  mentions: ["user123"]
}
```

### Displaying a Post

```typescript
// Backend fetches post from MongoDB:
{
  content: { text: "Hey [mention:user123], check this!" },
  mentions: ["user123"]
}

// Backend's replaceMentionPlaceholders():
1. Fetch user data for user123
2. Get: displayName = "John Doe", username = "john_doe"
3. Replace: [mention:user123] → [@John Doe](john_doe)

// Backend sends to frontend:
{
  content: {
    text: "Hey [@John Doe](john_doe), check this!"
  }
}

// LinkifiedText parses and renders:
"Hey " + <Text style={{color: blue}} onPress={→/@john_doe}>John Doe</Text> + ", check this!"

// User sees:
"Hey John Doe, check this out!"
     ^^^^^^^^^
     Blue, clickable
```

---

## Code Implementation

### MentionTextInput.tsx (Composer)
```typescript
// Display format: @username
const displayMention = `@${mention.username}`;

// Storage format: [mention:userId]
const storageMention = `[mention:${mention.userId}]`;

// Convert for display in composer
convertToDisplayFormat(storageText, mentions):
  [mention:user123] → @john_doe

// Convert for storage when saving
convertToStorageFormat(displayText, mentions):
  @john_doe → [mention:user123]
```

### feed.controller.ts (Backend)
```typescript
replaceMentionPlaceholders(text, mentions):
  // Fetch user data
  const userData = await oxyClient.getUserById(userId);
  const username = userData.username;
  const displayName = userData.name?.full || username;
  
  // Replace placeholder
  [mention:user123] → [@John Doe](john_doe)
```

### LinkifiedText.tsx (Display)
```typescript
// Regex pattern detects: [@DisplayName](username)
pattern: /(\[@([^\]]+)\]\(([^)]+)\))/g

// Extracts:
mentionDisplay = "John Doe"
mentionUsername = "john_doe"

// Renders:
<Text 
  style={{color: blue}} 
  onPress={() => router.push('/@john_doe')}
>
  {mentionDisplay}
</Text>
```

---

## Examples

### Example 1: Simple Mention
```
Composer: "Check out @jane_smith's profile"
Storage:  "Check out [mention:user456]'s profile"
Display:  "Check out Jane Smith's profile"
                     ^^^^^^^^^^^
                     Clickable
```

### Example 2: Multiple Mentions
```
Composer: "Hey @john_doe and @jane_smith!"
Storage:  "Hey [mention:user123] and [mention:user456]!"
Display:  "Hey John Doe and Jane Smith!"
              ^^^^^^^^^    ^^^^^^^^^^^
              Both clickable
```

### Example 3: Mention at Start
```
Composer: "@alice, can you help?"
Storage:  "[mention:user789], can you help?"
Display:  "Alice, can you help?"
          ^^^^^
          Clickable
```

### Example 4: Username Change Scenario
```
Day 1:
  Composer: "Thanks @john_doe!"
  Storage:  "Thanks [mention:user123]!"
  Display:  "Thanks John Doe!"

[User changes username from john_doe to johnny_d]

Day 2 (same post):
  Storage:  "Thanks [mention:user123]!" (unchanged)
  Display:  "Thanks John Doe!" (still shows full name)
  Click:    Goes to /@johnny_d (new username)
```

---

## Migration from Old Formats

If you have posts with old mention formats:

### Old Format 1: Plain @username
```
Old: "Hey @john_doe"
New: "Hey [mention:user123]" (storage)
     "Hey [@John Doe](john_doe)" (to frontend)
```

### Old Format 2: @[Display](userId)
```
Old: "Hey @[John Doe](user123)"
New: "Hey [mention:user123]" (storage)
     "Hey [@John Doe](john_doe)" (to frontend)
```

---

## Testing Checklist

- [ ] Type `@` in composer → picker appears
- [ ] Select user → shows `@username` in composer
- [ ] Submit post → saves with `[mention:userId]` in database
- [ ] View post → displays `Full Name` (no @)
- [ ] Mention is blue/purple colored
- [ ] Tap mention → navigates to user profile
- [ ] Multiple mentions work correctly
- [ ] User changes username → old mentions still work
- [ ] User changes display name → old mentions show new name
- [ ] Quoted posts with mentions work
- [ ] Reply with mentions work

---

## Summary

| Aspect | Format |
|--------|--------|
| **What you type** | `@username` |
| **What gets saved** | `[mention:userId]` |
| **What you see** | `Full Name` (clickable) |

This three-stage transformation gives you:
- ✅ Clarity when composing (unique usernames)
- ✅ Stability in storage (user IDs)
- ✅ Beauty in display (full names)
- ✅ Always current data
- ✅ Instagram-like UX
