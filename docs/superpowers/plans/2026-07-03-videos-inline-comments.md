# Videos Inline Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tapping "comment" on the Videos (Reels) screen opens an inline comments experience — bottom-sheet on mobile, persistent right panel on desktop — instead of navigating away to `/compose`. On desktop, the like/comment/boost/share action buttons move onto the video itself (matching mobile), and the right column becomes dedicated to the comments panel while open.

**Architecture:** A comment is an existing reply `Post` — no backend changes. A new shared `VideoComments` component (embedded `<Feed type="replies" scrollEnabled={false}>` + a new lightweight `InlineReplyComposer`) is presented two ways: inside the app's single shared bottom sheet on mobile (extended to support non-scrollable content), and inside `RightBar`'s existing 350px column on desktop (a new third branch, gated by a `commentsOpen` flag added to `VideosRailContext`).

**Tech Stack:** React Native, `@oxyhq/bloom/bottom-sheet`, the existing `Feed`/`postsStore` data layer.

## Global Constraints

- No backend changes — comments are replies via the already-existing `GET /feed/replies/:parentId` and `POST /feed/reply` (`feedController.createReply`, `packages/backend/src/controllers/feed.controller.ts:1148`).
- The comments list MUST use the embedded (non-document-scroll) `<Feed>` path — pass `scrollEnabled={false}` (selects `EmbeddedWebFeed` on web per `Feed.web.tsx:509`; native's `Feed.native.tsx` also branches on `scrollEnabled === false`, see its own internal handling at `Feed.native.tsx:96,136,157,183,190,193,315`). Do NOT use the document-scroll-owning path here — this is a nested sub-list inside a modal/panel, exactly the case that path exists for.
- The inline composer is text-only (no media/mentions/hashtags) — matches Reels' comment box, and is explicitly out of scope per the spec.
- `createReply`'s optimistic update lives in `postsStore.ts` (bumps `engagement.replies` on ITS OWN cached copy) but `videos.tsx` maintains a SEPARATE local `posts` array (not sourced from `postsStore`) — after a successful `createReply`, `videos.tsx` must ALSO bump its own local `VideoPost.stats.commentsCount`, mirroring the exact pattern its existing `handleLike` already uses (`setPosts(prev => prev.map(p => p.id === postId ? {...} : p))`, `videos.tsx:1196-1200`). Do not rely on `postsStore`'s optimistic update alone — it does not reach this screen's own render state.
- No `as any`, `@ts-ignore`, silent catches, unneeded `useEffect`.

---

### Task 1: Extend the shared bottom sheet to support non-scrollable content

**Files:**
- Modify: `packages/frontend/context/BottomSheetContext.tsx`

**Interfaces:**
- Produces: `setBottomSheetContent(content: ReactNode, options？: { scrollable?: boolean })` — consumed by Task 4 (mobile wiring).

**Context:** `@oxyhq/bloom/bottom-sheet`'s `BottomSheetProps` already supports a `scrollable?: boolean` prop (`node_modules/@oxyhq/bloom/lib/typescript/module/bottom-sheet/index.d.ts:56`) — "Set to false when the screen owns its own scrolling primitive (e.g. a FlatList... Nesting a VirtualizedList inside the internal ScrollView would break windowing." That is exactly our case (the embedded comments `<Feed>` owns its own list), but `BottomSheetContext.tsx`'s `<BottomSheet>` render never passes this prop through — it's hardcoded to the default (`scrollable: true`). Add a small per-invocation override, defaulting to `true` so all ~118 existing call sites (which pass no second argument) are unaffected.

- [ ] **Step 1: Read the current file**

Read `packages/frontend/context/BottomSheetContext.tsx` in full (already reproduced above in this plan's research — 60 lines) to confirm it matches.

- [ ] **Step 2: Add a `scrollable` state alongside the existing content state**

Change:

```tsx
export const BottomSheetContext = createContext<BottomSheetContextProps>({
    openBottomSheet: () => { },
    setBottomSheetContent: () => { },
    bottomSheetRef: { current: null },
});
```

to (extend the exported interface too):

```tsx
export interface BottomSheetContextProps {
    openBottomSheet: (isOpen: boolean) => void;
    setBottomSheetContent: (content: ReactNode, options?: { scrollable?: boolean }) => void;
    bottomSheetRef: React.RefObject<BottomSheetRef | null>;
}

export const BottomSheetContext = createContext<BottomSheetContextProps>({
    openBottomSheet: () => { },
    setBottomSheetContent: () => { },
    bottomSheetRef: { current: null },
});
```

- [ ] **Step 3: Track `scrollable` in provider state and pass it through**

Change:

```tsx
export const BottomSheetProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [bottomSheetContent, setBottomSheetContent] = useState<ReactNode>(null);
    const bottomSheetRef = useRef<BottomSheetRef | null>(null);

    const openBottomSheet = useCallback((isOpen: boolean) => {
        if (isOpen) {
            bottomSheetRef.current?.present();
        } else {
            bottomSheetRef.current?.dismiss();
        }
    }, []);

    const contextValue = useMemo(() => ({
        openBottomSheet,
        setBottomSheetContent,
        bottomSheetRef,
    }), [openBottomSheet]);

    return (
        <BottomSheetContext.Provider value={contextValue}>
            {children}
            <BottomSheet
                ref={bottomSheetRef}
                enablePanDownToClose={true}
                style={styles.contentContainer}
            >
                <View style={styles.contentView}>
                    {bottomSheetContent}
                </View>
            </BottomSheet>
        </BottomSheetContext.Provider>
    );
};
```

to:

```tsx
export const BottomSheetProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [bottomSheetContent, setBottomSheetContentState] = useState<ReactNode>(null);
    const [scrollable, setScrollable] = useState(true);
    const bottomSheetRef = useRef<BottomSheetRef | null>(null);

    const openBottomSheet = useCallback((isOpen: boolean) => {
        if (isOpen) {
            bottomSheetRef.current?.present();
        } else {
            bottomSheetRef.current?.dismiss();
        }
    }, []);

    const setBottomSheetContent = useCallback((content: ReactNode, options?: { scrollable?: boolean }) => {
        setBottomSheetContentState(content);
        setScrollable(options?.scrollable ?? true);
    }, []);

    const contextValue = useMemo(() => ({
        openBottomSheet,
        setBottomSheetContent,
        bottomSheetRef,
    }), [openBottomSheet, setBottomSheetContent]);

    return (
        <BottomSheetContext.Provider value={contextValue}>
            {children}
            <BottomSheet
                ref={bottomSheetRef}
                enablePanDownToClose={true}
                style={styles.contentContainer}
                scrollable={scrollable}
            >
                <View style={styles.contentView}>
                    {bottomSheetContent}
                </View>
            </BottomSheet>
        </BottomSheetContext.Provider>
    );
};
```

- [ ] **Step 4: Typecheck + lint**

Run: `cd packages/frontend && bunx tsc --noEmit -p . 2>&1 | grep -i BottomSheetContext`
Expected: no output.
Run: `cd packages/frontend && bunx eslint context/BottomSheetContext.tsx`
Expected: 0 errors.

- [ ] **Step 5: Verify no existing call site broke**

Run: `grep -rn "setBottomSheetContent(" packages/frontend --include="*.tsx" | wc -l` and spot-check 2-3 of them still compile (they call with ONE argument, which remains valid since `options` is optional). The typecheck in Step 4 covers the whole project, so this is a sanity double-check, not required to enumerate all ~118.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/context/BottomSheetContext.tsx
git commit -m "feat(frontend): support non-scrollable content in the shared bottom sheet"
```

---

### Task 2: Inline reply composer

**Files:**
- Create: `packages/frontend/components/videos/InlineReplyComposer.tsx`

**Interfaces:**
- Produces: `<InlineReplyComposer postId={string} onPosted={() => void} />` — consumed by Task 3.

- [ ] **Step 1: Check `usePostsStore`'s `createReply` export shape**

Run: `grep -n "createReply" packages/frontend/stores/postsStore.ts` to confirm the hook exposes `createReply: (request: CreateReplyRequest) => Promise<void>` as a store action (already read in this plan's research: `postsStore.ts:739`, request shape `{ postId, content: { text } }` is a valid `CreateReplyRequest` subset per `packages/shared-types/src/feed.ts:77-83` — `content: PostContentInput` and `PostContentInput = Omit<PostContent,'podcast'> & {...}` accepts `{ text: string }`).

- [ ] **Step 2: Create the component**

```tsx
import React, { useCallback, useState } from 'react';
import { View, TextInput, Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import { show as toast } from '@oxyhq/bloom/toast';
import { usePostsStore } from '@/stores/postsStore';

interface InlineReplyComposerProps {
  postId: string;
  /** Called after a reply successfully posts, so the caller can bump its own
   * local comment count (see Global Constraints — postsStore's optimistic
   * update does not reach the Videos screen's separate local state). */
  onPosted: () => void;
}

/**
 * Minimal, text-only reply composer for the inline comments panel/sheet.
 * Deliberately narrower than the full `/compose` screen (no media, mentions,
 * or hashtags) — matches Reels' plain-text comment box.
 */
export function InlineReplyComposer({ postId, onPosted }: InlineReplyComposerProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const createReply = usePostsStore((s) => s.createReply);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await createReply({ postId, content: { text: trimmed } });
      setText('');
      onPosted();
    } catch {
      toast(t('common.error'), { type: 'error' });
    } finally {
      setSubmitting(false);
    }
  }, [text, submitting, createReply, postId, onPosted, t]);

  return (
    <View style={styles.row} className="border-t border-border bg-background">
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={t('videos.addComment', { defaultValue: 'Add a comment...' })}
        placeholderTextColor={theme.colors.textSecondary}
        style={[styles.input, { color: theme.colors.text }]}
        multiline
        maxLength={2000}
      />
      <Pressable
        onPress={handleSubmit}
        disabled={!text.trim() || submitting}
        style={styles.sendButton}
        accessibilityRole="button"
        accessibilityLabel={t('common.send', { defaultValue: 'Send' })}
      >
        <Ionicons
          name="send"
          size={20}
          color={text.trim() && !submitting ? theme.colors.primary : theme.colors.textSecondary}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  input: {
    flex: 1,
    fontSize: 15,
    maxHeight: 100,
    paddingVertical: 6,
  },
  sendButton: {
    paddingBottom: 6,
    paddingHorizontal: 4,
  },
});
```

- [ ] **Step 3: Typecheck + lint**

Run: `cd packages/frontend && bunx tsc --noEmit -p . 2>&1 | grep -i InlineReplyComposer`
Expected: no output.
Run: `cd packages/frontend && bunx eslint components/videos/InlineReplyComposer.tsx`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/components/videos/InlineReplyComposer.tsx
git commit -m "feat(frontend): add text-only inline reply composer for video comments"
```

---

### Task 3: `VideoComments` — the shared list+composer content

**Files:**
- Create: `packages/frontend/components/videos/VideoComments.tsx`

**Interfaces:**
- Consumes: `InlineReplyComposer` (Task 2), the existing `Feed` component (`@/components/Feed/Feed`, confirm the actual export path via `grep -n "from '@/components/Feed/Feed'" packages/frontend -r` — it's re-exported for both platforms via the standard `.native`/`.web` resolution, import it the same way `p/[id].tsx` does).
- Produces: `<VideoComments postId={string} onClose={() => void} onCommentPosted={() => void} />` — consumed by Task 4 (mobile sheet) and Task 5 (desktop panel).

- [ ] **Step 1: Confirm the exact `Feed` import path**

Run: `grep -n "^import.*Feed" "packages/frontend/app/(app)/p/[id].tsx" | head -3` to get the exact import statement used by an existing consumer of the replies feed — mirror it exactly.

- [ ] **Step 2: Create the component**

```tsx
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import { Feed } from '@/components/Feed/Feed';
import { InlineReplyComposer } from './InlineReplyComposer';

interface VideoCommentsProps {
  postId: string;
  onClose: () => void;
  /** Called after a reply successfully posts — see InlineReplyComposer. */
  onCommentPosted: () => void;
}

/**
 * Shared comments list + composer content, presented inside the mobile
 * bottom sheet (Task 4) and the desktop right-panel (Task 5). Uses the
 * embedded (non-document-scroll) Feed path since this is a nested sub-list
 * inside a modal/panel, not a top-level screen.
 */
export function VideoComments({ postId, onClose, onCommentPosted }: VideoCommentsProps) {
  const { t } = useTranslation();
  const theme = useTheme();

  return (
    <View style={styles.container}>
      <View style={styles.header} className="border-b border-border">
        <Text style={[styles.title, { color: theme.colors.text }]}>
          {t('videos.comments', { defaultValue: 'Comments' })}
        </Text>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.close', { defaultValue: 'Close' })}>
          <Ionicons name="close" size={22} color={theme.colors.text} />
        </Pressable>
      </View>

      <View style={styles.list}>
        <Feed
          type="replies"
          filters={{ postId, parentPostId: postId }}
          scrollEnabled={false}
          hideHeader
        />
      </View>

      <InlineReplyComposer postId={postId} onPosted={onCommentPosted} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },
  list: {
    flex: 1,
  },
});
```

- [ ] **Step 3: Verify `scrollEnabled={false}` genuinely renders scrollable content within `flex:1`**

Read `packages/frontend/components/Feed/Feed.web.tsx`'s `EmbeddedWebFeed` function body (~line 185 onward) and `Feed.native.tsx`'s handling of `scrollEnabled === false` (lines already found at `:96,136,157,183,190,193,315` in this plan's research) to confirm the embedded path renders its own bounded/scrollable list rather than assuming unbounded height — if it needs an explicit height/flex passed via `style`/`contentContainerStyle` props, add whatever `p/[id].tsx`'s embedded usages (if any) already establish, or a sensible `style={{ flex: 1 }}` on the `<Feed>` itself. Adjust the component above if your reading reveals this is needed — this is the one part of this task requiring you to verify against the real embedded-feed contract rather than assuming the illustrative code above is complete.

- [ ] **Step 4: Typecheck + lint**

Run: `cd packages/frontend && bunx tsc --noEmit -p . 2>&1 | grep -i VideoComments`
Expected: no output.
Run: `cd packages/frontend && bunx eslint components/videos/VideoComments.tsx`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/components/videos/VideoComments.tsx
git commit -m "feat(frontend): add shared VideoComments list+composer component"
```

---

### Task 4: Wire the mobile bottom sheet

**Files:**
- Modify: `packages/frontend/app/(app)/videos.tsx` (the `handleComment` callback, ~line 1206-1208)

**Interfaces:**
- Consumes: `VideoComments` (Task 3), the extended `setBottomSheetContent(content, { scrollable: false })` (Task 1).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Find the `BottomSheetContext` consumption convention**

Run: `grep -n "useContext(BottomSheetContext)\|from '@/context/BottomSheetContext'" "packages/frontend/app/(app)/p/[id].tsx"` — mirror exactly how that screen obtains `setBottomSheetContent`/`openBottomSheet` (likely `const { setBottomSheetContent, openBottomSheet } = useContext(BottomSheetContext);`).

- [ ] **Step 2: Replace `handleComment`'s navigation with the inline sheet, gated by the existing desktop breakpoint**

Current (`videos.tsx:1206-1208`):

```ts
    const handleComment = useCallback((postId: string) => {
        router.push(`/compose?replyToPostId=${postId}`);
    }, [router]);
```

Change to (import `BottomSheetContext`/`useContext` and `VideoComments` at the top of the file alongside the other imports; `isDesktop` is already computed in this component at `videos.tsx:826` per this plan's research — reuse it, do not recompute):

```ts
    const handleCommentPosted = useCallback((postId: string) => {
        setPosts(prev => prev.map(p =>
            p.id === postId
                ? { ...p, stats: { ...p.stats, commentsCount: p.stats.commentsCount + 1 } }
                : p
        ));
    }, []);

    const handleComment = useCallback((postId: string) => {
        if (isDesktop) {
            // Desktop: Task 5 wires this through VideosRailContext instead.
            setRailState({ commentsOpen: true, commentsPostId: postId });
            return;
        }
        setBottomSheetContent(
            <VideoComments
                postId={postId}
                onClose={() => openBottomSheet(false)}
                onCommentPosted={() => handleCommentPosted(postId)}
            />,
            { scrollable: false },
        );
        openBottomSheet(true);
    }, [isDesktop, setRailState, setBottomSheetContent, openBottomSheet, handleCommentPosted]);
```

(`setRailState` here is read from `useVideosRail()`, which `videos.tsx` — check whether it already calls this hook or only writes via a ref/effect; Task 5 defines the exact `commentsOpen`/`commentsPostId` fields on `VideosRailState`, added there. If `useVideosRail()` isn't already called in this file's main component scope, add `const { setRailState } = useVideosRail();` alongside whatever existing rail-state wiring is there — grep `setRailState(` in this file first to find the existing call site(s) and colocate.)

- [ ] **Step 3: Typecheck + lint**

Run: `cd packages/frontend && bunx tsc --noEmit -p . 2>&1 | grep -i videos`
Expected: errors ARE expected at this point referencing `commentsOpen`/`commentsPostId` not existing on `VideosRailState` yet — Task 5 adds them. If your reading shows Task 4 can be sequenced to depend on Task 5 instead (do Task 5's context change first), swap the order; do not leave the plan inconsistent — pick one order and note it in your report if you deviate from the plan's stated Task 4→5 sequence.

- [ ] **Step 4: Commit**

```bash
git add "packages/frontend/app/(app)/videos.tsx"
git commit -m "feat(frontend): open inline comments sheet on mobile instead of navigating to compose"
```

---

### Task 5: Wire the desktop right panel

**Files:**
- Modify: `packages/frontend/context/VideosRailContext.tsx` (add `commentsOpen`/`commentsPostId` to `VideosRailState`)
- Modify: `packages/frontend/components/RightBar.tsx` (third branch: comments panel)
- Modify: `packages/frontend/components/videos/VideosRail.tsx` (remove the 4 action buttons — they now live on-video; keep prev/next arrows, follow button, views count)
- Modify: `packages/frontend/app/(app)/videos.tsx` (`showOnVideoActions` — always show on-video actions; remove the desktop-only gate)

**Interfaces:**
- Consumes: `VideoComments` (Task 3).
- Produces: `VideosRailState.commentsOpen: boolean`, `VideosRailState.commentsPostId: string | null` — consumed by Task 4's `handleComment`.

- [ ] **Step 1: Add `commentsOpen`/`commentsPostId` to `VideosRailContext`**

In `packages/frontend/context/VideosRailContext.tsx`, add to `VideosRailState` (after `activePost`):

```ts
  commentsOpen: boolean;
  commentsPostId: string | null;
```

Add to `DEFAULT_STATE`:

```ts
  commentsOpen: false,
  commentsPostId: null,
```

No other change needed in this file — `setRailState`'s `Partial<...>` merge already supports patching just these two fields.

- [ ] **Step 2: Remove the 4 action buttons from `VideosRail`, keep arrows/follow/views**

In `packages/frontend/components/videos/VideosRail.tsx`, remove the entire `<View style={styles.actions}>...</View>` block (lines ~120-158 in this plan's research, the 4 `RailAction` children) — keep the arrows row, follow row, and views row exactly as they are. Remove the now-unused `RailAction` component, `LIKE_ACTIVE_COLOR`/`BOOST_ACTIVE_COLOR` constants, and `formatCompactNumber` import IF they become unused after this removal (check with a full-file re-read after deleting — `formatCompactNumber` is also used by the views-count row, so it likely stays; `RailAction`/the two color constants are likely fully removable). Also remove `onLike`/`onComment`/`onBoost`/`onShare` from the destructured `useVideosRail()` call in this file since they're no longer read here.

- [ ] **Step 3: Add the comments-panel branch to `RightBar`**

In `packages/frontend/components/RightBar.tsx`, import `VideoComments` and read the two new fields from `useVideosRail()`. Change:

```tsx
export function RightBar() {
    const isRightBarVisible = useIsRightBarVisible();
    const { active: videosRailActive } = useVideosRail();

    if (!isRightBarVisible) return null;

    if (videosRailActive) {
        return (
            <View className="flex-col px-4 pt-4" style={styles.container}>
                <VideosRail />
            </View>
        );
    }

    return (
```

to:

```tsx
export function RightBar() {
    const isRightBarVisible = useIsRightBarVisible();
    const { active: videosRailActive, commentsOpen, commentsPostId, setRailState } = useVideosRail();

    if (!isRightBarVisible) return null;

    if (videosRailActive && commentsOpen && commentsPostId) {
        return (
            <View className="flex-col" style={styles.container}>
                <VideoComments
                    postId={commentsPostId}
                    onClose={() => setRailState({ commentsOpen: false, commentsPostId: null })}
                    onCommentPosted={() => {
                        // The rail's activePost.commentsCount is a read-only projection the
                        // /videos screen owns and refreshes on its own optimistic update
                        // (see videos.tsx's handleCommentPosted) — no action needed here.
                    }}
                />
            </View>
        );
    }

    if (videosRailActive) {
        return (
            <View className="flex-col px-4 pt-4" style={styles.container}>
                <VideosRail />
            </View>
        );
    }

    return (
```

(Note the comments-panel branch drops the `px-4 pt-4` padding the other two branches use — `VideoComments` manages its own internal padding via its header/list/composer styles from Task 3, since a list+pinned-input layout needs edge-to-edge width unlike the padded widget/rail content.)

- [ ] **Step 4: Always show on-video actions (remove the desktop-only gate)**

In `packages/frontend/app/(app)/videos.tsx`, change (~line 596):

```ts
    const showOnVideoActions = !isDesktop;
```

to:

```ts
    // On-video actions now show on every platform/breakpoint — desktop no
    // longer moves them into the right-column rail (VideosRail keeps only
    // prev/next + follow + views for desktop; see VideosRail.tsx).
    const showOnVideoActions = true;
```

Leave `showOnVideoFollow` (`!isDesktop && ...`) UNCHANGED — the on-video follow button staying mobile-only (desktop already shows it in the rail) is not part of this task's scope; only the 4 action buttons move.

- [ ] **Step 5: Close comments when the active video changes**

Without this, swiping to a new video while the comments panel/sheet is open would leave it showing the PREVIOUS video's comments while the video underneath changes — a real, user-visible bug, not a hypothetical.

In `packages/frontend/app/(app)/videos.tsx`, find where `currentVisibleIndex` state is declared (`const [currentVisibleIndex, setCurrentVisibleIndex] = useState(0);`, confirmed at line ~834) and add a ref-during-render reset, using the SAME pattern already established elsewhere in this codebase today (`components/Post/PostContentText.tsx` and `components/Profile/ProfileContent.tsx` both reset expand/collapse state this exact way when their driving value changes — see either file for the precedent):

```ts
    const prevVisibleIndexRef = useRef(currentVisibleIndex);
    if (prevVisibleIndexRef.current !== currentVisibleIndex) {
        prevVisibleIndexRef.current = currentVisibleIndex;
        if (railCommentsOpen) {
            setRailState({ commentsOpen: false, commentsPostId: null });
        }
        openBottomSheet(false);
    }
```

Where `railCommentsOpen` reads `commentsOpen` off the same `useVideosRail()` call this file already makes for `setRailState` (Task 4 introduced that call — read the CURRENT file to find its exact destructuring and extend it with `commentsOpen`, rather than adding a second `useVideosRail()` call). `openBottomSheet(false)` is a no-op if no sheet is currently presented (per `BottomSheetContext`'s `dismiss()` call — confirm this is safe to call unconditionally by reading `@oxyhq/bloom/bottom-sheet`'s `dismiss` behavior; if it is not safe to call when nothing is open, gate it on whatever local/context flag already tracks whether the comments sheet specifically is the one presented, e.g. track a local `commentsSheetOpen` boolean alongside the `setBottomSheetContent`/`openBottomSheet(true)` call from Task 4 and only call `openBottomSheet(false)` here when that's true).

Place this block in the same component scope as `currentVisibleIndex` (not inside a callback), so it runs on every render where the index actually changed, exactly mirroring the cited precedent's placement (after other hooks, before the JSX return).

- [ ] **Step 6: Typecheck + lint across all 4 files**

Run: `cd packages/frontend && bunx tsc --noEmit -p . 2>&1 | grep -iE "videos|VideosRail|RightBar"`
Expected: no output.
Run: `cd packages/frontend && bunx eslint "app/(app)/videos.tsx" components/videos/VideosRail.tsx components/RightBar.tsx context/VideosRailContext.tsx`
Expected: 0 errors.

- [ ] **Step 7: Reasoning-based verification (device/browser optional if unavailable — say so explicitly if you can't)**

- On-video like/comment/boost/share buttons are now visible at every viewport width, including desktop (previously hidden ≥990px).
- The desktop rail (`RightBar`, ≥990px) shows only prev/next arrows + follow + views when NOT commenting.
- Tapping "comment" (now on-video everywhere) on desktop opens the comments panel in the right column (replacing the trimmed rail); tapping "comment" on mobile opens the bottom sheet (Task 4).
- Closing the desktop panel (`onClose`) returns the right column to the trimmed rail.
- Posting a comment updates the on-video comment count (via Task 4's `handleCommentPosted`).

- [ ] **Step 8: Commit**

```bash
git add packages/frontend/context/VideosRailContext.tsx packages/frontend/components/RightBar.tsx packages/frontend/components/videos/VideosRail.tsx "packages/frontend/app/(app)/videos.tsx"
git commit -m "feat(frontend): move video actions on-video everywhere, add desktop comments panel"
```

---

## Post-plan verification (all tasks complete)

- [ ] `cd packages/backend && bun run test` — full suite green (no backend changes expected to affect this, but confirm nothing else broke).
- [ ] `cd packages/frontend && bun run test` — full suite green.
- [ ] `cd packages/frontend && bunx tsc --noEmit -p .` — no new errors (3 pre-existing livekit-client externals ignored).
- [ ] `cd packages/frontend && bun run lint` — 0 errors, no new warnings.
- [ ] Real-device/browser walkthrough: mobile bottom-sheet comments (list scrolls independently, composer posts, count updates, sheet dismisses), desktop panel (same, plus panel replaces rail and reverts on close), on-video actions visible at every width.
