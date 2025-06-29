# Redux Integration Guide

This guide covers how Redux is integrated across the entire app using Redux Toolkit and best practices.

## 📁 Store Structure

```
store/
├── store.ts              # Main store configuration
├── reducers/
│   ├── analyticsReducer.ts   # Analytics data management
│   ├── trendsReducer.ts      # Trends/hashtags management  
│   ├── profileReducer.ts     # Profiles linked to Oxy users
│   ├── postsReducer.ts       # Posts & feed management
│   └── uiReducer.ts          # UI state (modals, notifications, etc.)
└── README.md             # This file

hooks/
├── useRedux.ts           # Typed Redux hooks
└── useOxyProfile.ts      # Integrated Oxy + Redux hook
```

## 🎯 Current State Structure

```typescript
{
  trends: {
    trends: Trend[],
    isLoading: boolean,
    error: string | null
  },
  analytics: {
    data: any,
    loading: boolean,
    error: string | null
  },
  profile: {
    currentProfile: Profile | null,      // Current user's profile (linked to Oxy user)
    viewingProfile: Profile | null,      // Profile being viewed
    profiles: Record<string, Profile>,   // Cached profiles by Oxy user ID
    isLoading: boolean,
    profileLoading: boolean,
    followLoading: boolean,
    error: string | null,
    followError: string | null
  },
  posts: {
    posts: Record<string, Post>,        // Normalized posts by ID
    feedPosts: Record<string, string[]>, // Feed arrays by type
    nextCursor: Record<string, string>,  // Pagination cursors
    hasMore: Record<string, boolean>,    // More data available
    isLoading: boolean,
    isRefreshing: boolean,
    isCreating: boolean,
    error: string | null,
    createError: string | null
  },
  ui: {
    isAppLoading: boolean,
    notifications: Notification[],
    modals: Modal[],
    currentRoute: string,
    colorScheme: 'light' | 'dark' | 'auto',
    sidebarCollapsed: boolean,
    isComposeModalOpen: boolean,
    composeReplyTo?: string,
    searchQuery: string,
    searchResults: any[],
    isSearching: boolean,
    keyboardVisible: boolean
  }
}
```

## 🛠️ Usage Patterns

### 1. Custom Typed Hooks

Always use the custom typed hooks for better TypeScript experience:

```typescript
import { useAppSelector, useAppDispatch } from '@/hooks/useRedux';

const MyComponent = () => {
  const dispatch = useAppDispatch();
  const profile = useAppSelector(state => state.profile.currentProfile);
  const { user: oxyUser, isAuthenticated } = useOxy(); // From OxyHQ Services
  // TypeScript will automatically infer types!
};
```

### 2. Async Operations with Thunks

```typescript
import { fetchTrends } from '@/store/reducers/trendsReducer';

const handleFetchTrends = () => {
  dispatch(fetchTrends());
};

// With parameters (using Oxy user)
const handleFetchAnalytics = () => {
  const { user: oxyUser } = useOxy();
  if (oxyUser) {
    dispatch(fetchAnalytics({ 
      userID: oxyUser.id, 
      period: '7d' 
    }));
  }
};
```

### 3. Optimistic Updates

For better UX, update UI immediately then sync with server:

```typescript
const handleLikePost = (postId: string) => {
  // Immediate UI update
  dispatch(toggleLikeLocally(postId));
  // Then API call
  dispatch(likePost(postId));
};
```

### 4. Feed Management Pattern

Posts are normalized for efficient updates and memory usage:

```typescript
// Get posts for a specific feed
const posts = useAppSelector(state => {
  const feedPostIds = state.posts.feedPosts.home || [];
  return feedPostIds
    .map(id => state.posts.posts[id])
    .filter(Boolean);
});

// Fetch more posts
const handleLoadMore = () => {
  const cursor = useAppSelector(state => state.posts.nextCursor.home);
  dispatch(fetchFeed({ 
    type: 'home', 
    cursor, 
    limit: 20 
  }));
};
```

### 5. UI State Management

```typescript
// Notifications
dispatch(addNotification({
  type: 'success',
  title: 'Success!',
  message: 'Operation completed successfully'
}));

// Modal management
dispatch(openModal({
  type: 'compose',
  data: { replyTo: postId }
}));

// App-wide loading states
dispatch(setAppLoading(true));
```

## 📋 Available Actions

### Profile Actions
- `setCurrentProfile(profile)` - Set current user's profile
- `clearCurrentProfile()` - Clear current profile
- `fetchProfile(oxyUserId)` - Fetch profile by Oxy user ID
- `fetchProfileByUsername(username)` - Fetch profile by username
- `updateProfile(updates)` - Update profile data
- `followUser(targetOxyUserId)` - Follow another user
- `unfollowUser(targetOxyUserId)` - Unfollow a user

### Posts Actions
- `fetchFeed(params)` - Fetch posts feed
- `createPost(postData)` - Create new post
- `likePost(postId)` - Like a post
- `unlikePost(postId)` - Unlike a post
- `repostPost(postId)` - Repost a post
- `bookmarkPost(postId)` - Bookmark a post
- `toggleLikeLocally(postId)` - Optimistic like toggle

### UI Actions
- `addNotification(notification)` - Show notification
- `removeNotification(id)` - Remove notification
- `openModal(modal)` - Open modal
- `closeModal(id)` - Close modal
- `setAppLoading(loading)` - Set app loading state
- `openComposeModal(options)` - Open compose modal
- `toggleSidebar()` - Toggle sidebar

### Analytics & Trends
- `fetchTrends()` - Fetch trending hashtags
- `fetchAnalytics(params)` - Fetch analytics data

## 🚀 Getting Started

### 1. Import the hooks
```typescript
import { useAppSelector, useAppDispatch } from '@/hooks/useRedux';
import { useOxyProfile } from '@/hooks/useOxyProfile'; // Integrated Oxy + Redux hook
```

### 2. Use the integrated hook (recommended)
```typescript
const { 
  isAuthenticated, 
  profile, 
  isReady, 
  loginWithProfile, 
  logoutAndClearProfile 
} = useOxyProfile();
```

### 3. Or use individual hooks
```typescript
const { user: oxyUser } = useOxy(); // Authentication
const profile = useAppSelector(state => state.profile.currentProfile); // Profile
const dispatch = useAppDispatch(); // Actions
```

## 🔄 Migration from React Context

If you have components using React Context, here's how to migrate:

### Before (React Context)
```typescript
const { posts, likePost } = useContext(PostContext);
```

### After (Redux + OxyHQ Services)
```typescript
const { user: oxyUser, isAuthenticated } = useOxy(); // Authentication from Oxy
const profile = useAppSelector(state => state.profile.currentProfile); // Profile from Redux
const posts = useAppSelector(state => 
  state.posts.feedPosts.all?.map(id => state.posts.posts[id]) || []
);
const dispatch = useAppDispatch();
const handleLike = (id: string) => dispatch(likePost(id));
```

## 🎯 Best Practices

1. **Use typed hooks**: Always use `useAppSelector` and `useAppDispatch`
2. **Normalize data**: Store entities by ID for efficient updates
3. **Optimistic updates**: Update UI first, then sync with server
4. **Error handling**: Always handle loading and error states
5. **Selective subscriptions**: Only subscribe to state you need
6. **Async thunks**: Use for all API calls with automatic loading states

## 📱 Example Component

```typescript
import React, { useEffect } from 'react';
import { useAppSelector, useAppDispatch } from '@/hooks/useRedux';
import { useOxy } from '@oxyhq/services/full';
import { fetchFeed, likePost } from '@/store/reducers/postsReducer';
import { fetchProfile } from '@/store/reducers/profileReducer';

const FeedComponent = () => {
  const dispatch = useAppDispatch();
  const { user: oxyUser, isAuthenticated } = useOxy();
  
  const posts = useAppSelector(state => {
    const feedIds = state.posts.feedPosts.home || [];
    return feedIds.map(id => state.posts.posts[id]).filter(Boolean);
  });
  
  const currentProfile = useAppSelector(state => state.profile.currentProfile);
  const isLoading = useAppSelector(state => state.posts.isLoading);
  const hasMore = useAppSelector(state => state.posts.hasMore.home);

  useEffect(() => {
    dispatch(fetchFeed({ type: 'home' }));
  }, [dispatch]);

  // Sync profile with Oxy authentication
  useEffect(() => {
    if (isAuthenticated && oxyUser && !currentProfile) {
      dispatch(fetchProfile(oxyUser.id));
    }
  }, [isAuthenticated, oxyUser, currentProfile, dispatch]);

  const handleLike = (postId: string) => {
    dispatch(likePost(postId));
  };

  if (isLoading && posts.length === 0) {
    return <LoadingSpinner />;
  }

  return (
    <FlatList
      data={posts}
      renderItem={({ item }) => (
        <PostItem 
          post={item} 
          onLike={() => handleLike(item.id)}
        />
      )}
      onEndReached={() => hasMore && dispatch(fetchFeed({ 
        type: 'home', 
        cursor: state.posts.nextCursor.home 
      }))}
    />
  );
};
```

## 🔧 Store Configuration

The store is configured with:
- **Redux Toolkit**: Modern Redux with less boilerplate
- **TypeScript**: Full type safety
- **Immer**: Immutable updates with mutable syntax
- **Redux DevTools**: Debugging support (development only)
- **OxyHQ Services Integration**: Authentication handled by Oxy, profiles managed in Redux

```typescript
export const store = configureStore({
  reducer: {
    trends: trendsReducer,
    analytics: analyticsReducer,
    profile: profileReducer, // Profiles linked to Oxy users
    posts: postsReducer,
    ui: uiReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
```

## 🎨 See It In Action

Check out `components/examples/ReduxExample.tsx` for a comprehensive example showing all patterns and features in action.

## 🔗 OxyHQ Services Integration

This Redux setup is designed to work seamlessly with OxyHQ Services:

### Authentication Flow
1. **OxyHQ Services** handles user authentication (login/logout/tokens)
2. **Redux** manages app-specific profile data linked to Oxy users
3. **Automatic Sync** between Oxy authentication state and Redux profiles

### Integration Hook: `useOxyProfile`

We provide a custom hook that handles all the integration complexity:

```typescript
import { useOxyProfile } from '@/hooks/useOxyProfile';

const MyComponent = () => {
  const { 
    isAuthenticated,    // From Oxy
    profile,           // From Redux
    isReady,           // Authenticated + profile loaded
    loginWithProfile,  // Login and fetch profile
    logoutAndClearProfile, // Logout and clear profile
    isLoading          // Combined loading state
  } = useOxyProfile();

  if (isLoading) return <LoadingSpinner />;
  if (!isAuthenticated) return <LoginScreen />;
  if (!profile) return <CreateProfileScreen />;
  
  return <AuthenticatedApp profile={profile} />;
};
```

### Manual Integration (if needed)
```typescript
const { user: oxyUser, isAuthenticated } = useOxy(); // From Oxy
const profile = useAppSelector(state => state.profile.currentProfile); // From Redux

// Sync them together
useEffect(() => {
  if (isAuthenticated && oxyUser && !profile) {
    dispatch(fetchProfile(oxyUser.id));
  } else if (!isAuthenticated) {
    dispatch(clearCurrentProfile());
  }
}, [isAuthenticated, oxyUser, profile, dispatch]);
```

---

This Redux setup provides a robust, scalable foundation for state management across your entire application, perfectly integrated with OxyHQ Services for authentication. The patterns established here can be extended for any new features you add to the app. 