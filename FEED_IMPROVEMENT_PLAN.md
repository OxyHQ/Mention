# Feed System Improvement Plan

Comprehensive plan based on deep research of every feed-related file across backend,
frontend, shared types, and integration points. Issues organized by priority with
exact file locations, root causes, and fixes.

---

## Phase 1: Critical — Pagination & Cursor Bugs (breaks infinite scroll)

### 1.1 Cursor format inconsistency between feed strategies and controller

**Problem:** `FeedResponseBuilder` generates cursors as plain MongoDB `_id` strings,
but `ForYouFeedStrategy` and `ExploreFeedStrategy` expect `score:id` format. When
the controller uses `FeedResponseBuilder` for ranked feeds, it loses score information.
Next-page requests re-fetch already-seen posts because the score-based cursor is
missing, causing **duplicate posts and broken pagination**.

**Files:**
- `packages/backend/src/utils/FeedResponseBuilder.ts:49-50` — builds cursor as `_id` only
- `packages/backend/src/services/feedStrategies/ForYouFeedStrategy.ts:30-33` — expects `score:id`
- `packages/backend/src/services/feedStrategies/ExploreFeedStrategy.ts:156` — returns `score:id`
- `packages/backend/src/utils/feedUtils.ts:90-104` — `parseFeedCursor()` only handles ObjectId

**Fix:**
- Extend `FeedResponseBuilder.buildResponse()` to accept an optional `buildCursor` fn
- For ranked feeds, pass a cursor builder that includes the score: `${finalScore}:${_id}`
- Extend `parseFeedCursor()` to handle both `objectId` and `score:objectId` formats
- Add `parseScoreCursor()` helper that returns `{ score: number, id: ObjectId }`

### 1.2 Cursor built BEFORE transformation, causing stale cursors

**Problem:** `FeedResponseBuilder` calculates the `nextCursor` from the raw
MongoDB doc at line 49, then transformation (hydration + privacy filtering) runs at
line 66 and can remove posts. The cursor still points to the pre-filter post. If the
last post is removed by privacy filtering, the next page starts from a deleted
position — potentially skipping real posts or causing an infinite loop.

**Files:**
- `packages/backend/src/utils/FeedResponseBuilder.ts:46-60`

**Fix:**
- Move cursor calculation AFTER transformation completes
- Build cursor from the last post in `transformedPosts` (after privacy/hydration),
  not from `postsToReturn` (before)
- Add safety: if `transformedPosts` is empty but `hasMore` is true, fetch again
  rather than returning `hasMore: false`

### 1.3 Cursor tiebreaker logic is backwards

**Problem:** When ranked post scores are tied, the tiebreaker uses
`a._id.toString().localeCompare(b._id.toString()) * -1`. This produces inconsistent
ordering because it reverses a string comparison of ObjectIds. ObjectIds should be
compared in descending order (newer first), but `localeCompare * -1` doesn't
reliably achieve this.

**Files:**
- `packages/backend/src/controllers/feed.controller.ts:737`
- `packages/backend/src/services/feedStrategies/ForYouFeedStrategy.ts:115`

**Fix:**
```typescript
// Replace:
return a._id.toString().localeCompare(b._id.toString()) * -1;
// With:
return b._id.toString().localeCompare(a._id.toString());
```

### 1.4 Cursor stall when deduplication removes posts

**Problem:** After deduplication `finalUniquePosts.length` can be less than `limit`,
causing `hasMore` to be false even though there are more posts in the database.
The user sees "end of feed" prematurely.

**File:** `packages/backend/src/utils/FeedResponseBuilder.ts:80-84`

**Fix:**
- Track whether deduplication removed any posts
- If posts were removed, keep `hasMore: true` and keep the cursor so the
  frontend fetches the next page (which won't have the duplicates)

---

## Phase 2: Critical — Ranking & Score Bugs (breaks For You feed)

### 2.1 FeedRankingService score calculations can produce NaN/Infinity

**Problem:** Multiple arithmetic operations lack NaN/Infinity guards. If any
sub-score is NaN, the final score becomes NaN. Posts with NaN scores sort
unpredictably, pushing them to random positions in the feed.

**File:** `packages/backend/src/services/FeedRankingService.ts`
- Line 218: `Math.log1p(rawScore / 10)` — NaN if rawScore is negative
- Line 376: `rawEngagement / viewsCount` — division by zero possible
- Lines 179-189: Final score is multiplicative chain — one NaN infects all

**Fix:**
```typescript
function safeScore(value: number, fallback = 1.0): number {
  return Number.isFinite(value) ? value : fallback;
}
// Wrap every sub-score calculation with safeScore()
```

### 2.2 ExploreFeedStrategy cursor doesn't validate score format

**Problem:** Cursor string is split on `:` at line 64-66 without validating that
the score part is a finite number or that the id part is a valid ObjectId. A
malformed cursor can inject NaN into MongoDB queries.

**File:** `packages/backend/src/services/feedStrategies/ExploreFeedStrategy.ts:62-67`

**Fix:** Add `Number.isFinite(cursorScore)` and `mongoose.Types.ObjectId.isValid(cursorId)` checks.

---

## Phase 3: High — Data Integrity & Cache Bugs

### 3.1 FeedCacheService cache versioning is a no-op

**Problem:** `isCacheVersionValid()` always returns `true` (lines 291-295).
The `l1CacheVersion` counter is incremented on invalidation (line 317) but
never actually checked. Stale cache entries are served indefinitely across
horizontal instances.

**File:** `packages/backend/src/services/FeedCacheService.ts:291-295`

**Fix:** Implement version tracking:
```typescript
private isCacheVersionValid(cachedVersion: number): boolean {
  return cachedVersion >= this.l1CacheVersion;
}
```
Store version alongside cached data and compare on read.

### 3.2 FeedJobScheduler "cleanCache" job doesn't clean anything

**Problem:** The scheduled cache cleanup calls `feedCacheService.getCacheStats()`
which only reads stats — never deletes entries. The L1 in-memory cache grows
unbounded until the process restarts.

**File:** `packages/backend/src/services/FeedJobScheduler.ts:97-99`

**Fix:** Implement `feedCacheService.evictExpiredEntries()` and call it from the job.

### 3.3 Dual save persistence (Bookmark vs metadata.savedBy)

**Problem:** `saveItem()` updates `metadata.savedBy` on the Post document but
does NOT create a Bookmark record. The saved feed (`getFeed` with type=saved) queries
the Bookmark collection. This means saved posts **never appear in the saved feed**.

**Files:**
- `packages/backend/src/controllers/feed.controller.ts:1656` — updates metadata.savedBy
- `packages/backend/src/controllers/feed.controller.ts:334-346` — reads from Bookmark

**Fix:** Add Bookmark creation/deletion alongside metadata updates:
```typescript
// In saveItem():
await Bookmark.create({ userId: currentUserId, postId });
// In unsaveItem():
await Bookmark.deleteOne({ userId: currentUserId, postId });
```

### 3.4 FeedSeenPostsService uses random eviction instead of LRU

**Problem:** When seen posts exceed 1000, random members are evicted (line 183).
This causes old posts to resurface in the For You feed unpredictably.

**File:** `packages/backend/src/services/FeedSeenPostsService.ts:178-187`

**Fix:** Use Redis Sorted Sets with timestamp scores instead of Sets. Evict by
lowest score (oldest timestamp).

### 3.5 FeedSeenPostsService inconsistent Redis fallback

**Problem:** `getSeenPostIds()` falls back to in-memory cache when Redis is down,
but `isPostSeen()` returns `false` (line 121). This inconsistency causes duplicate
posts during Redis outages.

**File:** `packages/backend/src/services/FeedSeenPostsService.ts:114-121`

**Fix:** Use in-memory fallback consistently in both methods.

---

## Phase 4: High — Frontend State & Socket Bugs

### 4.1 Socket update race condition with feed loading state

**Problem:** Socket messages are queued during loading (line 478-485), then
processed after fetch completes. But the queue is checked before the feed state
update, and processed after, so duplicate posts can be added.

**File:** `packages/frontend/services/socketService.ts:419-522`

**Fix:** Add a generation counter to feed state. Only process queued updates
whose generation matches the current generation (i.e., they arrived during
the current loading cycle, not a stale one).

### 4.2 Engagement count desync between optimistic updates and socket

**Problem:** Frontend optimistically increments like count (10→11), but the
socket event from server reports `likesCount: 10` (server saw 9→10 because
another user un-liked). The count jumps back and forth, creating a confusing
user experience.

**Files:**
- `packages/frontend/stores/postsStore.ts:1414-1432`
- `packages/frontend/services/socketService.ts:594-632`

**Fix:**
- Track whether each engagement value is "optimistic" or "confirmed"
- Only allow server counts to override optimistic values if the difference is > 1
  (indicating a genuine multi-user count change vs echo of our own action)

### 4.3 useRealtimePosts cleanup bug — didCancel never set

**Problem:** `didCancel` is declared `false` and checked in the cleanup function,
but never set to `true`. The cleanup is a no-op. Socket connections created
on mount are never cleaned up on unmount.

**File:** `packages/frontend/hooks/useRealtimePosts.ts:9-19`

**Fix:**
```typescript
return () => {
  didCancel = true;
  // Optionally disconnect or at minimum stop processing updates
};
```

### 4.4 Memory leak in socketService presence/follow listener maps

**Problem:** `presenceListeners` and `followListeners` maps grow unbounded.
Components that mount/unmount frequently (like profile cards in the feed)
can accumulate thousands of listeners with no cleanup interval or size limit.

**File:** `packages/frontend/services/socketService.ts:860-942`

**Fix:** Add max size limit with LRU eviction. Periodically prune listeners
whose associated components have unmounted.

### 4.5 PostItem React.memo comparison is incomplete

**Problem:** The custom `arePropsEqual` comparator for PostItem doesn't check
`style`, `onReply`, or other callback props. If a parent passes a new style
object reference with the same content, PostItem won't re-render when it should.

**File:** `packages/frontend/components/Feed/PostItem.tsx:529-549`

**Fix:** Add missing prop comparisons or memoize parent-provided props.

---

## Phase 5: Medium — Query & Performance Improvements

### 5.1 FeedQueryBuilder missing null check for replies filter

**Problem:** `parentPostId = { $exists: false }` misses posts where
`parentPostId` is explicitly `null`.

**File:** `packages/backend/src/utils/feedQueryBuilder.ts:133-135`

**Fix:**
```typescript
query.$or = [{ parentPostId: null }, { parentPostId: { $exists: false } }];
```

### 5.2 Explore feed does unnecessary countDocuments

**Problem:** `getExploreFeed` calls `Post.countDocuments(match)` to check if
any posts exist (line 1012-1027), then runs the aggregation. This is a redundant
query that adds latency to every Explore request.

**File:** `packages/backend/src/controllers/feed.controller.ts:1012-1027`

**Fix:** Remove the countDocuments check. If the aggregation returns empty, the
fallback can be applied then. Or use `aggregate([...]).limit(1)` for existence check.

### 5.3 Following feed excludes user's own posts

**Problem:** The Following feed only shows posts from followed accounts, not the
user's own posts. Most social apps (Twitter/X, Bluesky) include the user's own
posts in the Following/chronological feed.

**Files:**
- `packages/backend/src/controllers/feed.controller.ts:931`
- `packages/backend/src/services/feedStrategies/FollowingFeedStrategy.ts:51`

**Fix:** Include `currentUserId` in the `followingIds` array:
```typescript
const feedUserIds = [...new Set([currentUserId, ...followingIds])];
```

### 5.4 Frontend cache key instability for array filters

**Problem:** `getCacheKey()` in feedService.ts uses template literals for filter
values, which produces `[object Object]` for arrays.

**File:** `packages/frontend/services/feedService.ts:81-87`

**Fix:** Use `JSON.stringify(value)` for each filter value instead of template
literal interpolation.

### 5.5 Frontend deepEqual uses JSON.stringify (slow for large objects)

**File:** `packages/frontend/utils/feedUtils.ts:60-71`

**Fix:** Replace with a proper shallow/structural comparison that early-exits
on first difference.

### 5.6 Duplicate ID normalization functions

**Problem:** Two nearly identical ID normalizers exist:
- `normalizeId()` in `postsStore.ts:148`
- `normalizeItemId()` in `feedUtils.ts:21`

**Fix:** Consolidate into one shared function, export from `feedUtils.ts`.

---

## Phase 6: Medium — API Contract & Type Safety

### 6.1 FeedResponse.items typed as any[]

**Problem:** `items: any[]` in the shared FeedResponse type completely bypasses
type checking between backend and frontend.

**File:** `packages/shared-types/src/feed.ts:46`

**Fix:** Change to `items: HydratedPost[]`.

### 6.2 Transformation errors return degraded posts with _transformError flag

**Problem:** When hydration fails, `FeedResponseBuilder` returns raw MongoDB docs
with a `_transformError: true` flag. Frontend doesn't check this flag, so users
see broken posts with missing profile data.

**File:** `packages/backend/src/utils/FeedResponseBuilder.ts:67-74`

**Fix:**
- Backend: return empty array on transformation failure, or retry once
- Frontend: check `_transformError` flag and show placeholder/error UI

### 6.3 Backend error response format inconsistency

**Problem:** Some endpoints return `{ error: '...' }`, others return
`{ error: '...', message: '...' }`. Frontend has to guess which fields exist.

**Fix:** Standardize using `sendError()` from `apiResponse.ts` utility
(already created but not wired in).

### 6.4 Socket event payload field naming inconsistency

**Problem:** Repost events send `postId: originalPostId` (confusing: postId means
the *original* post, not the new repost). Frontend has to use
`originalPostId || postId` fallback logic.

**File:** `packages/backend/src/controllers/feed.controller.ts:1352-1360`

**Fix:** Use clear field names: `targetPostId`, `newRepostId`, `actorId`.

---

## Phase 7: Low — Polish & Robustness

### 7.1 Socket room join race condition

**Problem:** Backend emits events to `post:${postId}` rooms immediately after
DB update, but frontend may not have joined the room yet if the post was just
scrolled into view.

**Fix:** Include engagement counters in HTTP response for initial load, and use
socket only for live updates after room join is confirmed.

### 7.2 FeedCacheService pub/sub invalidation is fire-and-forget

**File:** `packages/backend/src/services/FeedCacheService.ts:342-355`

**Fix:** Add retry with exponential backoff (max 3 attempts).

### 7.3 CustomFeedStrategy no cycle detection for list expansion

**File:** `packages/backend/src/services/feedStrategies/CustomFeedStrategy.ts:52-65`

**Fix:** Track visited list IDs in a Set to prevent infinite loops.

### 7.4 FeedSeenPostsService memory leak — no destructor

**File:** `packages/backend/src/services/FeedSeenPostsService.ts:26-46`

**Fix:** Add `destroy()` method that clears the interval, call on shutdown.

### 7.5 Feed key extraction fallback uses JSON.stringify

**Problem:** When a post has no `id`, `getItemKey()` falls back to
`JSON.stringify(item)`, which changes every render and breaks FlashList recycling.

**File:** `packages/frontend/components/Feed/Feed.tsx:193-199`

**Fix:** Use a stable fallback like index-based key with a warning log.

### 7.6 Rate limiting doesn't distinguish public vs authenticated endpoints

**File:** `packages/backend/src/routes/feed.routes.ts:8-13`

**Fix:** Apply stricter limits to unauthenticated endpoints, looser to authenticated.

---

## Implementation Priority

| Phase | Effort | Impact | Description |
|-------|--------|--------|-------------|
| **1** | 2-3h | Critical | Pagination & cursor fixes — stops duplicate/missing posts |
| **2** | 1-2h | Critical | Ranking score safety — prevents broken For You feed |
| **3** | 3-4h | High | Cache, data integrity, seen posts — prevents stale/wrong data |
| **4** | 3-4h | High | Frontend state, socket, memory leaks — prevents UI bugs |
| **5** | 2-3h | Medium | Query performance, UX polish |
| **6** | 1-2h | Medium | Type safety, API contracts |
| **7** | 1-2h | Low | Robustness, edge cases |

Total estimated issues: **~30 distinct bugs/improvements** across 7 phases.
