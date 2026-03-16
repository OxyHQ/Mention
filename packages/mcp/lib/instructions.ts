/**
 * Server instructions sent to LLM clients so they understand how to use
 * the Mention MCP server effectively.
 */
export const SERVER_INSTRUCTIONS = `# Mention MCP Server

## What is Mention?
Mention (mention.earth) is a social platform for sharing posts, following users, and engaging with content. Think of it as a modern social network with features like:
- **Posts** with text, media, polls, articles, events, and location
- **Feeds**: For You (personalized), Explore (trending), Following, and user profiles
- **Interactions**: Like, repost, quote, save/bookmark
- **Lists**: Curate groups of users and view their combined timeline
- **Notifications**: Real-time updates on likes, reposts, replies, and follows
- **Search**: Full-text search with advanced operators
- **Polls**: Create polls with multiple options and vote

## Authentication
All write operations and most read operations require authentication. The server uses an Oxy JWT Bearer token configured via the MENTION_API_TOKEN environment variable.

## Tool Usage Guide

### Creating Posts
Use \`create-post\` with at minimum a \`text\` field. You can also set:
- \`visibility\`: "public" (default), "private", "followers", "mentioned"
- \`hashtags\`: Array of hashtag strings (without #)
- \`mentions\`: Array of user IDs to mention
- \`parentPostId\`: Set this to reply to another post
- \`sources\`: Array of {url, title} for cited sources
- \`scheduledFor\`: ISO date to schedule the post for later
- \`status\`: "published" (default), "draft", "scheduled"

### Reading Feeds
Multiple feed types are available:
- \`get-for-you-feed\`: Personalized recommendations
- \`get-explore-feed\`: Trending content
- \`get-following-feed\`: Posts from followed users
- \`get-user-feed\`: A specific user's posts
All feed tools support cursor-based pagination via \`cursor\` and \`limit\` params.

### Search Operators
The \`search\` tool supports advanced operators in the query string:
- \`from:username\` — filter by author
- \`since:YYYY-MM-DD\` — posts after date
- \`until:YYYY-MM-DD\` — posts before date
- \`has:media\` — posts with images/video
- \`has:links\` — posts containing URLs
- \`min_likes:N\` — minimum like count
- \`min_reposts:N\` — minimum repost count

Example: \`"climate change from:scienceguy since:2025-01-01 has:media min_likes:10"\`

### Post Visibility
- **public**: Visible to everyone
- **private**: Only visible to the author
- **followers**: Only visible to followers
- **mentioned**: Only visible to mentioned users

### Pagination
Most list endpoints use cursor-based pagination. The response includes:
- \`hasMore\`: Whether more results exist
- \`nextCursor\`: Pass this as the \`cursor\` parameter to get the next page
`;
