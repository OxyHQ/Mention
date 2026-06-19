# useProfileData Hook

## What It Does

`useProfileData` is a **unified hook** that combines multiple data sources into a single, consistent profile data object:

1. **Oxy Profile Data** - Basic user info from `usersStore` (username, bio, avatar, etc.)
2. **Appearance/Customization Settings** - From `appearanceStore` (displayName, profileHeaderImage, minimalistMode, etc.)
3. **Privacy Settings** - From `usePrivacySettings` (profileVisibility, etc.)

## Key Benefits

- ✅ **Automatic fetching** - Fetches profile data when username changes
- ✅ **Automatic appearance loading** - Loads customization settings automatically
- ✅ **Unified design computation** - Uses the API-provided `displayName` plus profile design settings for `bannerUrl`, `avatar`, `minimalistMode`, and color
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

3. **When you need design/customization data** - If you need `displayName`, `minimalistMode`, `bannerUrl`, etc.

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

## Display Name Contract

`displayName` comes from the Oxy API as a required, already-resolved value. `useProfileData` may apply Mention profile customization when present, but it must not rebuild names from `name.first`, `name.last`, `name.full`, or `username`.

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
    displayName: string;        // API displayName, overridden only by profile customization
    bannerUrl?: string;        // Ready-to-render profile banner URL
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
