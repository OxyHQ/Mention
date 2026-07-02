# Spec: Inline comments for the Videos (Reels) screen

**Date:** 2026-07-03
**Status:** approved design, implementing

## Context

Mention's Videos screen (`packages/frontend/app/(app)/videos.tsx`) is a fullscreen, TikTok/Reels-style vertical video pager. Today tapping "comment" navigates AWAY to `/compose?replyToPostId=<id>` — the viewer loses their place in the reel. The user wants an inline experience matching Instagram Reels: on mobile, a bottom-sheet; on desktop/wide viewports, a persistent right-side panel (comment list + pinned "Add a comment" input), based on a reference screenshot of Instagram Reels on iPad.

A "comment" in Mention is not a separate model — it is a reply `Post` (`parentPostId` set, `POST /feed/reply` to create, `GET /feed/replies/:parentId` to list). Both endpoints already exist and need no backend changes.

## Goal

1. Tapping "comment" on a video opens an inline comments experience (bottom-sheet on mobile, right panel on desktop) instead of navigating to `/compose`.
2. The comment list is the existing reply feed for that post (paginated, same data/endpoints the post-detail screen already uses), rendered as a nested/embedded list — not a new top-level scroll owner.
3. A new, lightweight inline text composer (text-only, no attachments/mentions — matching Reels' comment box) posts directly via the existing `createReply` store action, with optimistic comment-count update.
4. **Desktop layout change**: the like/comment/boost/share action buttons move from the right-column "rail" (`VideosRail`/`RightBar`) onto the video itself (bottom-right corner), matching mobile's existing on-video placement and the reference image. The right column (350px, currently hosting either default widgets or the video-rail) becomes dedicated to the comments panel when open; it reverts to the default widgets view when comments are closed. This is an intentional behavior change from today's desktop-only rail.

## Architecture

### Data (no backend changes)

- List: `GET /feed/replies/:parentId` via `feedService.getFeed({ type: 'replies', filters: { parentPostId } })`, cursor-paginated (`hasMore`/`nextCursor`), exactly as `p/[id].tsx` already uses it.
- Create: `usePostsStore().createReply({ postId, content: { text } })` — already does optimistic `commentsCount` bump + rollback on failure (`postsStore.ts:739`). The video screen's own optimistic comment-count logic (if any) should defer to this, not duplicate it.

### List rendering — reuse `EmbeddedWebFeed`

Per this repo's documented web-feed architecture (`components/Feed/Feed.web.tsx`): `EmbeddedWebFeed` is for "genuinely nested sub-lists only (e.g. replies inside a modal)" — this is exactly that case. The comments list (both in the mobile sheet and the desktop panel) renders via `EmbeddedWebFeed` (web) / the native equivalent nested-list path already used for in-modal reply lists, filtered to `type:'replies', parentPostId`. Do NOT use `VirtualizedWebFeed`/a document-scroll-owning `<Feed>` here — the panel/sheet owns its own bounded scroll area, which is the documented purpose of the embedded variant.

Each comment row reuses the existing `PostItem` component in its default compact variant (same as the post-detail replies list) — no new comment-row component.

### New component: inline reply composer

No inline (non-navigating) text composer exists anywhere in the app today — even the post-detail screen's "Post your reply" affordance navigates to `/compose`. Build one new, narrowly-scoped component: a text `TextInput` + submit button, pinned at the bottom of the comments list, calling `createReply` directly. Text-only — no media/mention/hashtag affordances (matches Reels' comment box; the full-featured `/compose` screen remains available for anyone who wants those, reachable some other way if ever needed, but is out of scope here).

### Desktop layout

- `VideosRail`/`RightBar`'s video-rail branch (`packages/frontend/components/RightBar.tsx`, `components/videos/VideosRail.tsx`) stops rendering the like/comment/boost/share action buttons. Those move onto the video overlay, reusing whatever the mobile on-video action column already is (check `videos.tsx`'s `showOnVideoActions` gate — it currently hides these on desktop; the fix is to stop hiding them, not build new buttons).
- `RightBar` gains a third mode: comments-open. `VideosRailContext` (or a small addition to it) publishes whether the comments panel is open and for which post id — `RightBar` branches on that to render the comments panel instead of the default widgets/rail.
- The comments panel matches `RightBar`'s existing visual conventions: 350px width, sticky positioning (`top:50/bottom:20`), `px-4` gutter — per the already-read `RightBar.tsx` styles.

### Mobile: bottom-sheet

Reuse the app's single shared `BottomSheetContext` (`context/BottomSheetContext.tsx`, `@oxyhq/bloom/bottom-sheet`) — the established one-sheet-at-a-time convention used ~118 places — rather than introducing a second competing sheet mechanism. **Verify during implementation** whether this shared sheet's snap-point/keyboard-avoidance behavior actually works well with a scrollable list + pinned text input (taller/more interactive than its typical usages like `ReplyPreferencesSheet`); if it does not, that's a decision point to bring back before building a parallel mechanism — do not silently work around a real limitation.

### Breakpoint

`useIsRightBarVisible()` (990px, `hooks/useOptimizedMediaQuery.ts:39-41`) — already the exact switch `videos.tsx` uses for `isDesktop`. Below it: bottom-sheet. At/above it: right panel.

## Edge cases

- Opening comments for a video with zero comments: empty state, composer still shown (can be the first commenter).
- Switching to a different video while comments are open: the panel/sheet should reflect the NEW active video's comments (not stay pinned to the previous post) — or close automatically on swipe, whichever reads better; decide during implementation by checking how `VideosRailContext`'s existing `activePost` already updates on swipe and mirror that reactivity.
- Posting a comment optimistically updates the visible `commentsCount` on the video's action button immediately (already provided by `postsStore.createReply`'s optimistic update — the video screen must read from the same store-synced count, not a locally-frozen copy).
- Desktop window resize crossing the 990px breakpoint while comments are open: panel closes / falls back to sheet (or vice versa) — no broken half-state.

## Testing

No existing render-testing harness for these RN screens (established convention). Backend needs no new tests (no backend changes). New pure logic (if any is extracted, e.g. a breakpoint-driven mode selector) should get a unit test if it's non-trivial; the composer/list wiring itself is manual/device-verified.

## Out of scope

- Media/mentions/hashtags in the inline composer (text-only).
- Changing the post-detail screen's (`p/[id].tsx`) existing navigate-to-compose reply flow — this spec only changes the Videos screen.
- Any change to the reply data model or backend endpoints.
