#!/bin/bash
# Run after: gh auth login
# Creates GitHub Issues for active feed bugs from FEED_IMPROVEMENT_PLAN.md

REPO="OxyHQ/Mention"

gh issue create --repo "$REPO" --title "bug: Cursor tiebreaker logic is backwards in ForYouFeedStrategy" --body "$(cat <<'EOF'
## Description
`ForYouFeedStrategy.ts:115` uses `a._id.toString().localeCompare(b._id.toString()) * -1` for tiebreaking when ranked post scores are tied. This produces inconsistent ordering.

## Expected
ObjectIds should be compared in descending order (newer first).

## Fix
```typescript
// Replace:
return a._id.toString().localeCompare(b._id.toString()) * -1;
// With:
return b._id.toString().localeCompare(a._id.toString());
```

## Files
- `packages/backend/src/services/feedStrategies/ForYouFeedStrategy.ts:115`
EOF
)" --label "bug"

gh issue create --repo "$REPO" --title "bug: ExploreFeedStrategy cursor parsing lacks validation" --body "$(cat <<'EOF'
## Description
`ExploreFeedStrategy.ts:62-67` splits cursor on `:` without validating that the score is a finite number or that the id is a valid ObjectId. A malformed cursor can inject NaN into MongoDB queries.

## Fix
Add `Number.isFinite(cursorScore)` and `mongoose.Types.ObjectId.isValid(cursorId)` checks after parsing.

## Files
- `packages/backend/src/services/feedStrategies/ExploreFeedStrategy.ts:62-67`
EOF
)" --label "bug"

gh issue create --repo "$REPO" --title "bug: FeedCacheService isCacheVersionValid() always returns true" --body "$(cat <<'EOF'
## Description
`FeedCacheService.ts:291-295` - `isCacheVersionValid()` always returns `true`. The `l1CacheVersion` counter is incremented on invalidation (line 317) but never actually checked. Stale cache entries are served indefinitely.

## Fix
Implement version tracking: store version alongside cached data and compare on read.

## Files
- `packages/backend/src/services/FeedCacheService.ts:291-295`
EOF
)" --label "bug"

gh issue create --repo "$REPO" --title "bug: FeedJobScheduler cleanCache job is a no-op" --body "$(cat <<'EOF'
## Description
`FeedJobScheduler.ts:97-99` - The scheduled cache cleanup calls `feedCacheService.getCacheStats()` which only reads stats, never deletes entries. The L1 in-memory cache grows unbounded until process restart.

## Fix
Implement `feedCacheService.evictExpiredEntries()` and call it from the job.

## Files
- `packages/backend/src/services/FeedJobScheduler.ts:97-99`
EOF
)" --label "bug"

gh issue create --repo "$REPO" --title "bug: saveItem() doesn't create Bookmark record" --body "$(cat <<'EOF'
## Description
`feed.controller.ts:1656` - `saveItem()` updates `metadata.savedBy` on the Post document but does NOT create a Bookmark record. The saved feed queries the Bookmark collection, so saved posts never appear in the saved feed.

## Fix
Add Bookmark creation/deletion alongside metadata updates:
```typescript
// In saveItem():
await Bookmark.create({ userId: currentUserId, postId });
// In unsaveItem():
await Bookmark.deleteOne({ userId: currentUserId, postId });
```

## Files
- `packages/backend/src/controllers/feed.controller.ts:1656`
EOF
)" --label "bug"

gh issue create --repo "$REPO" --title "bug: FeedSeenPostsService uses random eviction instead of LRU" --body "$(cat <<'EOF'
## Description
`FeedSeenPostsService.ts:178-187` - When seen posts exceed 1000, random members are evicted via `sRandMemberCount()`. This causes old posts to resurface in the For You feed unpredictably.

## Fix
Use Redis Sorted Sets with timestamp scores instead of Sets. Evict by lowest score (oldest timestamp).

## Files
- `packages/backend/src/services/FeedSeenPostsService.ts:178-187`
EOF
)" --label "bug"

gh issue create --repo "$REPO" --title "bug: useRealtimePosts cleanup - didCancel never set to true" --body "$(cat <<'EOF'
## Description
`useRealtimePosts.ts:9-19` - `didCancel` is declared `false` and checked in cleanup, but never set to `true`. The cleanup function is a no-op.

## Fix
Either set `didCancel = true` in the cleanup return, or remove the unnecessary variable entirely if app-level persistence is intentional.

## Files
- `packages/frontend/hooks/useRealtimePosts.ts:9-19`
EOF
)" --label "bug"

gh issue create --repo "$REPO" --title "bug: Socket presenceListeners and followListeners maps grow unbounded" --body "$(cat <<'EOF'
## Description
`socketService.ts:891,921` - `presenceListeners` and `followListeners` Maps grow unbounded. Components that mount/unmount frequently can accumulate thousands of listeners with no cleanup or size limit.

## Fix
Add max size limit with LRU eviction. Periodically prune listeners whose associated components have unmounted.

## Files
- `packages/frontend/services/socketService.ts:891,921`
EOF
)" --label "bug"

gh issue create --repo "$REPO" --title "bug: FeedResponseBuilder cursor built before transformation (partial fix)" --body "$(cat <<'EOF'
## Description
`FeedResponseBuilder.ts:46-60` - Cursor is calculated from raw MongoDB docs BEFORE transformation (hydration + privacy filtering). Safety checks were added (finalHasMore recalculation, validateCursorAdvanced), but risk remains: if the last post is removed by privacy filtering, the cursor points to a deleted position.

## Fix
Move cursor calculation AFTER transformation completes. Build cursor from the last post in `transformedPosts`, not from `postsToReturn`.

## Files
- `packages/backend/src/utils/FeedResponseBuilder.ts:46-60`
EOF
)" --label "bug"

gh issue create --repo "$REPO" --title "bug: FeedRankingService NaN/Infinity can propagate through scores" --body "$(cat <<'EOF'
## Description
`FeedRankingService.ts` - Division by zero was fixed, but NaN/Infinity can still propagate through the multiplicative score chain. `Math.log1p(rawScore / 10)` returns `-Infinity` for negative rawScore. Final `Math.max(0, finalScore)` converts NaN to 0 but Infinity passes through.

## Fix
Wrap every sub-score calculation with a safety function:
```typescript
function safeScore(value: number, fallback = 1.0): number {
  return Number.isFinite(value) ? value : fallback;
}
```

## Files
- `packages/backend/src/services/FeedRankingService.ts`
EOF
)" --label "bug"

echo ""
echo "All 10 issues created successfully!"
echo "You can now delete FEED_IMPROVEMENT_PLAN.md"
