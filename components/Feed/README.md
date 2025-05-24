# Feed Component

The Feed component displays a list of posts with various filtering options and features.

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `type` | PostType | 'all' | Type of posts to display: 'all', 'posts', 'replies', 'quotes', 'reposts', 'media' |
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

### Show only posts with media

```tsx
<Feed type="media" />
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
