# Mention System - Quick Visual Guide

## 🎯 The Complete Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        COMPOSER (Input)                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  User types: Hey @joh                                            │
│              ↓                                                    │
│  Picker shows:                                                   │
│  ┌──────────────────────┐                                       │
│  │ 👤 John Doe          │                                       │
│  │    @john_doe         │ ← Username (handle)                   │
│  │                      │                                       │
│  │ 👤 Johnny Smith      │                                       │
│  │    @johnny_s         │                                       │
│  └──────────────────────┘                                       │
│              ↓                                                    │
│  User selects John Doe                                           │
│              ↓                                                    │
│  Text becomes: Hey @john_doe, check this out!                   │
│                    ^^^^^^^^^                                     │
│                    Username shown in composer                    │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      STORAGE (MongoDB)                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Stored as: Hey [mention:user123], check this out!              │
│                 ^^^^^^^^^^^^^^^^^^                               │
│                 Placeholder with user ID                         │
│                                                                   │
│  Document:                                                       │
│  {                                                               │
│    content: {                                                    │
│      text: "Hey [mention:user123], check this out!"             │
│    },                                                            │
│    mentions: ["user123"]                                         │
│  }                                                               │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                   BACKEND PROCESSING                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  replaceMentionPlaceholders():                                   │
│                                                                   │
│  1. Fetch user data for user123:                                │
│     - username: "john_doe"                                       │
│     - name: { full: "John Doe" }                                 │
│                                                                   │
│  2. Replace placeholder:                                         │
│     [mention:user123] → [@John Doe](john_doe)                    │
│                                                                   │
│  3. Send to frontend:                                            │
│     "Hey [@John Doe](john_doe), check this out!"                 │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    DISPLAY (Feed/Post)                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  LinkifiedText parses: [@John Doe](john_doe)                     │
│                                                                   │
│  Renders as:                                                     │
│  ┌────────────────────────────────────────┐                     │
│  │                                        │                     │
│  │  Hey John Doe, check this out!        │                     │
│  │      ^^^^^^^^^                         │                     │
│  │      └─ Blue/purple, clickable         │                     │
│  │         No @ symbol                    │                     │
│  │         Taps → /@john_doe              │                     │
│  │                                        │                     │
│  └────────────────────────────────────────┘                     │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📝 Format Cheat Sheet

| Stage | What You See | What It Actually Is |
|-------|-------------|---------------------|
| **Typing** | `@john_doe` | Display format in TextInput |
| **Saving** | _(invisible)_ | `[mention:user123]` |
| **Reading** | `John Doe` | Parsed from `[@John Doe](john_doe)` |

---

## 🎨 Visual Examples

### Example 1: Single Mention

#### Composer View:
```
┌─────────────────────────────────────────┐
│ What's happening?                       │
├─────────────────────────────────────────┤
│                                         │
│ Hey @john_doe, great work on the       │
│ project! 🎉                             │
│                                         │
└─────────────────────────────────────────┘
```

#### Feed View:
```
┌─────────────────────────────────────────┐
│ @your_username · 2m                     │
├─────────────────────────────────────────┤
│                                         │
│ Hey John Doe, great work on the        │
│     ^^^^^^^^^                           │
│     (blue, clickable)                   │
│ project! 🎉                             │
│                                         │
└─────────────────────────────────────────┘
```

### Example 2: Multiple Mentions

#### Composer View:
```
┌─────────────────────────────────────────┐
│ What's happening?                       │
├─────────────────────────────────────────┤
│                                         │
│ Thanks @john_doe and @jane_smith for    │
│ the amazing collaboration!              │
│                                         │
└─────────────────────────────────────────┘
```

#### Feed View:
```
┌─────────────────────────────────────────┐
│ @your_username · 5m                     │
├─────────────────────────────────────────┤
│                                         │
│ Thanks John Doe and Jane Smith for      │
│        ^^^^^^^^^    ^^^^^^^^^^^         │
│        (both clickable)                 │
│ the amazing collaboration!              │
│                                         │
└─────────────────────────────────────────┘
```

### Example 3: Mention at Start

#### Composer View:
```
┌─────────────────────────────────────────┐
│ What's happening?                       │
├─────────────────────────────────────────┤
│                                         │
│ @alice can you review this PR?          │
│                                         │
└─────────────────────────────────────────┘
```

#### Feed View:
```
┌─────────────────────────────────────────┐
│ @your_username · 1m                     │
├─────────────────────────────────────────┤
│                                         │
│ Alice can you review this PR?           │
│ ^^^^^                                   │
│ (clickable)                             │
│                                         │
└─────────────────────────────────────────┘
```

---

## 🔄 Real-Time Transformation

### What Happens When You Type `@joh`

```
Step 1: Type '@'
┌────────────────────┐
│ @                  │  ← Cursor here
└────────────────────┘
     ↓
MentionPicker appears


Step 2: Type 'joh'
┌────────────────────┐
│ @joh               │  ← Cursor here
└────────────────────┘
     ↓
┌──────────────────────┐
│ 👤 John Doe          │
│    @john_doe         │  ← Matches query
│                      │
│ 👤 Johnny Smith      │
│    @johnny_s         │  ← Also matches
└──────────────────────┘


Step 3: Select "John Doe"
┌────────────────────┐
│ @john_doe          │  ← Replaced
└────────────────────┘
     ↓
Picker closes
Cursor moves to end


Step 4: Continue typing
┌────────────────────┐
│ @john_doe check... │
└────────────────────┘


Step 5: Submit (storage format sent to backend)
"[mention:user123] check..."
```

---

## 💾 Database vs Display

### In MongoDB:
```json
{
  "_id": "post_456",
  "content": {
    "text": "Hey [mention:user123], check [mention:user456]!"
  },
  "mentions": ["user123", "user456"],
  "oxyUserId": "current_user_id",
  "createdAt": "2025-10-30T10:30:00Z"
}
```

### What User Sees:
```
┌─────────────────────────────────────────┐
│ @your_username · 2h                     │
├─────────────────────────────────────────┤
│                                         │
│ Hey John Doe, check Jane Smith!        │
│     ^^^^^^^^^       ^^^^^^^^^^^         │
│     (clickable)     (clickable)         │
│                                         │
└─────────────────────────────────────────┘
```

---

## 🎯 Key Points

### ✅ In Composer:
- @ triggers picker
- Shows username (`@john_doe`)
- Clear and unambiguous
- Easy to autocomplete

### ✅ In Storage:
- Uses user ID (`[mention:user123]`)
- Stable and permanent
- Works even if username changes

### ✅ In Display:
- Shows full name (`John Doe`)
- No @ symbol
- Blue/purple colored
- Clickable to profile
- Natural and elegant

---

## 🔍 Why This Works

### Problem:
❌ Usernames can change → mentions break  
❌ Full names not unique → ambiguous in composer  
❌ @ symbols everywhere → looks cluttered  

### Solution:
✅ Store user IDs → mentions never break  
✅ Use usernames in composer → unique & clear  
✅ Display full names → natural & elegant  

### Result:
🎉 Best of all worlds!
