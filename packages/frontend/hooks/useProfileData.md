# useProfileData Hook

## What It Does

`useProfileData` is a **unified hook** that combines multiple data sources into a single, consistent profile data object:

1. **Oxy Profile Data** - Basic user info from `usersStore` (username, bio, avatar, etc.)
2. **Appearance/Customization Settings** - From `appearanceStore` (displayName, coverImage, minimalistMode, etc.)
3. **Privacy Settings** - From `usePrivacySettings` (profileVisibility, etc.)

## Key Benefits

- ✅ **Automatic fetching** - Fetches profile data when username changes
- ✅ **Automatic appearance loading** - Loads customization settings automatically
- ✅ **Unified design computation** - Computes `displayName`, `coverImage`, `avatar`, `minimalistMode` from multiple sources
- ✅ **Optimized re-renders** - Uses Zustand selectors to prevent unnecessary re-renders
- ✅ **Type-safe** - Returns properly typed `ProfileData` with all computed fields

## When to Use

### ✅ **DO Use** `useProfileData` for:

1. **Profile screens/pages** - When displaying a full user profile
   - `ProfileScreen.tsx` ✅ (already using it)
   - `connections.tsx` - Should use it for the header profile display

2. **Single user detail views** - When you need complete profile info with customization
   - User detail modals
   - Profile previews
   - Settings screens showing other users

3. **When you need design/customization data** - If you need `displayName`, `minimalistMode`, `coverImage`, etc.

### ❌ **DON'T Use** `useProfileData` for:

1. **User lists** - When displaying many users in a list (followers, following, search results)
   - Use `useUserByUsername` or direct store access instead
   - `useProfileData` would create too many subscriptions and fetches

2. **Simple user cards** - When you only need basic info (username, avatar, verified)
   - `ProfileCard` component is fine with basic data
   - Search results, follower lists, etc.

3. **When you already have the user object** - If you're mapping over an array of users
   - Just use the user data directly from the array

## Current Usage

- ✅ `ProfileScreen.tsx` - Correctly using `useProfileData`

## Should Be Updated

- ⚠️ `app/[username]/connections.tsx` - Currently manually fetching profile data (lines 62-80)
  - Should use `useProfileData(cleanUsername)` instead
  - This would give it access to `displayName`, `minimalistMode`, and other customization settings

## Example Migration

### Before (connections.tsx):
```typescript
const [profile, setProfile] = useState<any | null>(null);

useEffect(() => {
  const loadProfile = async () => {
    try {
      const userProfile = await useUsersStore.getState().ensureByUsername(
        cleanUsername,
        (u) => oxyServices.getProfileByUsername(u)
      );
      if (userProfile) {
        setProfile(userProfile);
      }
    } catch (error) {
      console.error('Error loading profile:', error);
    }
  };
  if (cleanUsername) {
    loadProfile();
  }
}, [cleanUsername, oxyServices]);
```

### After:
```typescript
const { data: profileData, loading } = useProfileData(cleanUsername);
// profileData now includes:
// - profileData.design.displayName (customized display name)
// - profileData.design.minimalistMode
// - profileData.design.coverImage
// - profileData.privacy.profileVisibility
// - All original oxyProfile fields
```

## API

```typescript
const { data: profileData, loading } = useProfileData(username?: string);

// Returns:
// - data: ProfileData | null - Unified profile data with design and privacy
// - loading: boolean - True if username provided but no profile data yet
```

## ProfileData Structure

```typescript
interface ProfileData {
  // From Oxy profile
  id: string;
  username: string;
  bio?: string;
  verified?: boolean;
  avatar?: string;
  
  // Computed design values
  design: {
    displayName: string;        // Customized or fallback to name/username
    coverImage?: string;       // Custom cover image
    avatar?: string;           // Avatar URL
    coverPhotoEnabled: boolean;
    minimalistMode: boolean;
    primaryColor?: string;
  };
  
  // Privacy settings
  privacy?: {
    profileVisibility?: 'public' | 'private' | 'followers_only';
  };
  
  // All other oxyProfile fields
  [key: string]: any;
}
```

