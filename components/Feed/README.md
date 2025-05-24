# Feed Component

The Feed component displays a list of posts with various filtering options and features.

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `type` | PostType | 'all' | Type of posts to display: 'all', 'posts', 'replies', 'quotes', 'reposts', 'media', 'following' |
| `parentId` | string | undefined | Optional post ID to show only replies to that specific post |
| `showCreatePost` | boolean | false | Whether to show the post creation UI at the top of the feed |
| `onCreatePostPress` | () => void | undefined | Function called when the create post area is pressed |

## Examples

### Basic usage

```tsx
<Feed />
```

### Show only replies to a specific post

```tsx
<Feed type="replies" parentId="123456" />
```

### Show posts from followed users only

```tsx
<Feed type="following" />
```

### Show create post UI at the top of the feed

```tsx
<Feed showCreatePost={true} onCreatePostPress={() => {
  // Handle post creation logic
  router.push('/compose');
}} />
```

## Post Types

- `all`: Shows all posts
- `posts`: Shows only regular posts (no replies, quotes, or reposts)
- `replies`: Shows only reply posts
- `quotes`: Shows only quoted posts
- `reposts`: Shows only reposted posts
- `media`: Shows only posts containing media
- `following`: Shows posts from users that the current user follows

## Features

### Loading States
- Animated skeleton loading placeholders during initial load
- Pull-to-refresh functionality
- Pagination loading indicator

### Responsive Design
- Adapts to different screen sizes (mobile, tablet, desktop)
- Enhanced spacing and visual presentation on larger screens

### Visual Enhancements
- Card-based post presentation
- Visual separation between posts
- Improved readability with proper spacing
