# Videos Screen Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Videos (fullscreen Reels) screen load and feel faster by (1) serving adaptive-bitrate HLS streams instead of full-resolution originals, with a safe client-side fallback, (2) widening the live-player preload window and pagination lookahead, and (3) prefetching poster images further ahead than the video window so the perceived-instant frame is always ready.

**Architecture:** oxy-api already transcodes every uploaded video into 360p/720p/1080p MP4 renditions plus an adaptive HLS ladder (`hls_360p`/`hls_720p`/`hls_1080p`/`hls_master`) on upload — verified in `OxyHQServices/packages/api/src/services/variantService.ts`. Mention's `mediaResolver.ts` currently ignores all of this and always serves the raw original file as the video `url`. This plan wires the existing `hls_master` variant through to the player (native `expo-video`/AVPlayer/ExoPlayer already handle HLS ABR switching with zero extra code), with a same-mount, one-shot client-side fallback to the original MP4 if the HLS URL 404s (which can happen for videos whose background transcode hasn't finished — the variant-generation queue is fire-and-forget per `assetService.ts:1095`, not synchronous). No backend transcoding infra is created — only wiring to what already exists.

**Tech Stack:** Express (Mention backend), `expo-video` (`useVideoPlayer`, `VideoView`), React Native `FlatList`, `expo-image` (`Image.prefetch`).

## Global Constraints

- Federated (ActivityPub) videos have NO Oxy variant system — `hlsUrl` must only ever be computed for native Oxy file ids (mirror the existing `!isAbsoluteHttpUrl(item.id)` guard already used in `mediaResolver.ts` for the poster branch).
- The HLS URL is a **preference with a mandatory one-shot fallback** — never assume it is ready. A video whose transcode hasn't finished yet must still play (from the original MP4), not error out.
- No new `useEffect` where a ref-during-render or existing effect can be extended (per this repo's AGENTS.md `useEffect` avoidance rule) — the existing `statusChange` effect is extended in place, not duplicated.
- No `as any`, `@ts-ignore`, silent catches. No dead code left behind (e.g. don't leave the old direct-original wiring unused after the switch).
- `packages/shared-types` changes must be rebuilt (`cd packages/shared-types && bun run build`) before the backend picks up the new field — this is a Mention-internal workspace package, not a published SDK, so no republish step is needed, just a rebuild.
- Manual/device verification is the testing method for `videos.tsx` changes (no render-testing harness exists in this repo for RN screens — established convention this session). State exactly what to check on a real device/browser in each task.

---

### Task 1: Add `hlsUrl` to the shared `MediaItem` type

**Files:**
- Modify: `packages/shared-types/src/post.ts:42-72` (the `MediaItem` interface)

**Interfaces:**
- Produces: `MediaItem.hlsUrl?: string` — consumed by Task 2 (backend resolver) and Task 3 (frontend types).

- [ ] **Step 1: Add the field**

In `packages/shared-types/src/post.ts`, add to the `MediaItem` interface (after `fullUrl`, line 71):

```ts
  /**
   * Adaptive-bitrate HLS master playlist URL for native (non-federated) videos,
   * when the background transcode has produced one. `expo-video` (AVPlayer on
   * iOS, ExoPlayer on Android) plays an `.m3u8` URL natively and switches
   * quality automatically based on network conditions — no extra client code
   * needed beyond preferring this URL over `url`.
   *
   * NOT guaranteed to be ready: variant generation is fire-and-forget on
   * upload (see `OxyHQServices/packages/api/src/services/assetService.ts`
   * `queueVariantGeneration`), so a just-uploaded video's HLS ladder may not
   * exist yet — requesting it can 404/500. Consumers MUST fall back to `url`
   * (the raw original, always playable) on a playback error; never treat
   * `hlsUrl` as authoritative on its own. Omitted for federated/proxied video
   * (no Oxy variant system exists for those).
   */
  hlsUrl?: string;
```

- [ ] **Step 2: Rebuild shared-types**

Run: `cd packages/shared-types && bun run build`
Expected: exits 0, no tsc errors.

- [ ] **Step 3: Typecheck backend + frontend still clean**

Run: `cd packages/backend && bunx tsc --noEmit` and `cd packages/frontend && bunx tsc --noEmit -p .`
Expected: no new errors (the field is optional, so nothing currently constructing a `MediaItem` breaks).

- [ ] **Step 4: Commit**

```bash
git add packages/shared-types/src/post.ts
git commit -m "feat(shared-types): add MediaItem.hlsUrl for adaptive video streaming"
```

---

### Task 2: Wire `hlsUrl` into Mention's `mediaResolver.ts`

**Files:**
- Modify: `packages/backend/src/utils/mediaResolver.ts:210-224` (the `item.type === 'video'` branch in `resolveMediaItems`)
- Test: `packages/backend/src/__tests__/utils/mediaResolver.test.ts` (create if it doesn't already exist — check first with `ls packages/backend/src/__tests__/utils/mediaResolver.test.ts`)

**Interfaces:**
- Consumes: `MediaItem.hlsUrl` from Task 1.
- Produces: `resolveMediaItems([...])[i].hlsUrl` populated for native video items — consumed by Task 3 (frontend).

- [ ] **Step 1: Check for an existing test file**

Run: `ls packages/backend/src/__tests__/utils/mediaResolver.test.ts 2>&1`

If it exists, read it fully first and add your new test case(s) to it following its existing mocking conventions (it will already mock `getServiceOxyClient`). If it does NOT exist, create it fresh per Step 2 below.

- [ ] **Step 2: Write the failing test**

If creating fresh, use this shape (adapt the mock of `getServiceOxyClient`/`oxyHelpers` to match whatever the existing test suite for this module — or a sibling like `packages/backend/src/__tests__/utils/` — already establishes; read a neighboring test file in that directory first for the exact mocking pattern used in this codebase before writing this):

```ts
import { resolveMediaItems } from '../../utils/mediaResolver';

// Mirror the mocking pattern already used by sibling tests in this directory
// for `getServiceOxyClient` (check e.g. an existing test that already mocks
// `../../utils/oxyHelpers` and read it before writing this mock).
const mockGetFileDownloadUrl = jest.fn((id: string, variant?: string) =>
  variant ? `https://cloud.oxy.so/${id}?variant=${variant}` : `https://cloud.oxy.so/${id}`
);

jest.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getFileDownloadUrl: mockGetFileDownloadUrl,
  }),
}));

describe('resolveMediaItems — video hlsUrl', () => {
  beforeEach(() => {
    mockGetFileDownloadUrl.mockClear();
  });

  it('populates hlsUrl for a native (non-federated) video item', () => {
    const [result] = resolveMediaItems([{ id: 'file123', type: 'video' }]);
    expect(result.hlsUrl).toBe('https://cloud.oxy.so/file123?variant=hls_master');
    expect(mockGetFileDownloadUrl).toHaveBeenCalledWith('file123', 'hls_master');
  });

  it('does NOT populate hlsUrl for a federated (absolute-URL) video item', () => {
    const [result] = resolveMediaItems([
      { id: 'https://remote.example/video.mp4', type: 'video' },
    ]);
    expect(result.hlsUrl).toBeUndefined();
  });

  it('still populates url/posterUrl as before alongside hlsUrl', () => {
    const [result] = resolveMediaItems([{ id: 'file123', type: 'video' }]);
    expect(result.url).toBe('https://cloud.oxy.so/file123');
    expect(result.posterUrl).toBe('https://cloud.oxy.so/file123?variant=thumb');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/backend && bunx vitest run src/__tests__/utils/mediaResolver.test.ts`
Expected: FAIL — `hlsUrl` is `undefined` in the first test (the field isn't populated yet).

- [ ] **Step 4: Implement**

In `packages/backend/src/utils/mediaResolver.ts`, the current `item.type === 'video'` branch (lines 210-224) reads:

```ts
      if (item.type === 'video' && !isAbsoluteHttpUrl(item.id)) {
        try {
          const posterUrl = getServiceOxyClient().getFileDownloadUrl(item.id, MEDIA_VARIANT_AVATAR);
          return {
            id: item.id,
            type: item.type,
            ...altField,
            url: resolved.url || undefined,
            thumbUrl: posterUrl,
            posterUrl,
          };
        } catch (error) {
          logger.warn('[mediaResolver] Failed to resolve video poster; falling back to media ref:', error);
        }
      }
```

Change to:

```ts
      if (item.type === 'video' && !isAbsoluteHttpUrl(item.id)) {
        try {
          const posterUrl = getServiceOxyClient().getFileDownloadUrl(item.id, MEDIA_VARIANT_AVATAR);
          // Adaptive-bitrate HLS master playlist. NOT guaranteed to exist yet
          // (background transcode is fire-and-forget on upload) — the frontend
          // player MUST fall back to `url` (the raw original) on a playback
          // error. See MediaItem.hlsUrl's doc comment for the full contract.
          const hlsUrl = getServiceOxyClient().getFileDownloadUrl(item.id, 'hls_master');
          return {
            id: item.id,
            type: item.type,
            ...altField,
            url: resolved.url || undefined,
            thumbUrl: posterUrl,
            posterUrl,
            hlsUrl,
          };
        } catch (error) {
          logger.warn('[mediaResolver] Failed to resolve video poster; falling back to media ref:', error);
        }
      }
```

(`getFileDownloadUrl` is pure synchronous URL construction — per `OxyServices.assets.ts:73-91` it never makes a network call and cannot throw for an unready variant; the 404/500 risk is only realized later, when the CLIENT actually requests that URL — which is exactly why the frontend fallback in Task 4 is mandatory, not optional.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/backend && bunx vitest run src/__tests__/utils/mediaResolver.test.ts`
Expected: PASS (3/3)

- [ ] **Step 6: Run the full backend suite**

Run: `cd packages/backend && bun run test`
Expected: PASS, no regressions.

- [ ] **Step 7: Typecheck**

Run: `cd packages/backend && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/backend/src/utils/mediaResolver.ts packages/backend/src/__tests__/utils/mediaResolver.test.ts
git commit -m "feat(backend): resolve hls_master variant URL for native video posts"
```

---

### Task 3: Frontend types + resolution — carry `hlsUrl` and a fallback URL through to `VideoPost`

**Files:**
- Modify: `packages/frontend/app/(app)/videos.tsx` (the `MediaRef` interface ~line 112, `VideoPost` interface ~line 132-155, `resolveVideoUrl`/new `resolveFallbackVideoUrl` ~line 875, `toVideoPost` ~line 895-925)

**Interfaces:**
- Consumes: `MediaItem.hlsUrl` (Task 1/2), arrives on the wire as part of each post's `content.media[]`.
- Produces: `VideoPost.videoUrl` (now HLS-preferred), `VideoPost.fallbackVideoUrl?: string` (the raw original) — consumed by Task 4.

- [ ] **Step 1: Add `hlsUrl` to the local `MediaRef` interface**

Current (~line 112-118):

```ts
interface MediaRef {
    id?: string;
    url?: string;
    thumbUrl?: string;
    posterUrl?: string;
    type?: 'image' | 'video' | 'gif';
}
```

New:

```ts
interface MediaRef {
    id?: string;
    url?: string;
    thumbUrl?: string;
    posterUrl?: string;
    hlsUrl?: string;
    type?: 'image' | 'video' | 'gif';
}
```

- [ ] **Step 2: Add `fallbackVideoUrl` to `VideoPost`**

Current `VideoPost` (~line 132-155) has `videoUrl: string; posterUrl?: string;`. Add right after `videoUrl`:

```ts
    videoUrl: string;
    // The raw (non-HLS) original URL, always playable. `videoUrl` prefers the
    // adaptive HLS stream when present; `ActiveVideoSurface` retries with this
    // exactly once if the preferred source errors (e.g. HLS not transcoded yet).
    fallbackVideoUrl?: string;
    posterUrl?: string;
```

- [ ] **Step 3: Update `resolveVideoUrl` to prefer `hlsUrl`, and add a sibling resolver for the fallback**

Current (~line 875-881):

```ts
    const resolveVideoUrl = useCallback((ref: MediaRef): string => {
        if (ref?.url) return ref.url;
        const raw = ref?.id || '';
        if (!raw) return '';
        if (raw.startsWith('http')) return proxyExternalUrl(raw);
        return oxyServices?.getFileDownloadUrl ? oxyServices.getFileDownloadUrl(raw) : '';
    }, [oxyServices]);
```

Replace with two functions — rename the existing one's ORIGINAL behavior to `resolveFallbackVideoUrl` (it already resolves the raw/original URL and stays exactly as-is), and add a new `resolveVideoUrl` that prefers `hlsUrl`:

```ts
    // The raw/original URL — always playable, used as `fallbackVideoUrl`.
    // Unchanged from before this HLS work; every existing resolution path
    // (server `url`, http passthrough via proxy, legacy client-side Oxy
    // resolution) is preserved exactly.
    const resolveFallbackVideoUrl = useCallback((ref: MediaRef): string => {
        if (ref?.url) return ref.url;
        const raw = ref?.id || '';
        if (!raw) return '';
        if (raw.startsWith('http')) return proxyExternalUrl(raw);
        return oxyServices?.getFileDownloadUrl ? oxyServices.getFileDownloadUrl(raw) : '';
    }, [oxyServices]);

    // Preferred playback URL: the adaptive HLS stream when the server resolved
    // one (native video only — federated media never has `hlsUrl`), else the
    // same raw/original URL `resolveFallbackVideoUrl` would return.
    const resolveVideoUrl = useCallback((ref: MediaRef): string => {
        if (ref?.hlsUrl) return ref.hlsUrl;
        return resolveFallbackVideoUrl(ref);
    }, [resolveFallbackVideoUrl]);
```

- [ ] **Step 4: Thread `fallbackVideoUrl` through `toVideoPost`**

Current (~line 895-925):

```ts
    const toVideoPost = useCallback((post: RawPost, preferredMediaIndex?: number): VideoPost | null => {
        const media = post?.content?.media || [];
        if (media.length === 0) return null;

        let selected: MediaRef | undefined;
        if (
            preferredMediaIndex !== undefined &&
            media[preferredMediaIndex]?.type === 'video'
        ) {
            selected = media[preferredMediaIndex];
        } else {
            selected = media.find((m) => m?.type === 'video');
        }
        if (!selected) return null;

        const videoUrl = resolveVideoUrl(selected);
        if (!videoUrl) return null;

        const id = post?.id || post?._id;
        if (!id) return null;

        return {
            ...post,
            id: String(id),
            user: post.user as VideoPost['user'],
            content: post.content || {},
            stats: post.stats || { likesCount: 0, boostsCount: 0, commentsCount: 0, viewsCount: 0 },
            createdAt: post.createdAt || '',
            videoUrl,
            posterUrl: resolvePosterUrl(selected),
        };
    }, [resolveVideoUrl, resolvePosterUrl]);
```

Change to (adds `fallbackVideoUrl`, and only surfaces it when it genuinely differs from `videoUrl` — no point retrying the exact same URL):

```ts
    const toVideoPost = useCallback((post: RawPost, preferredMediaIndex?: number): VideoPost | null => {
        const media = post?.content?.media || [];
        if (media.length === 0) return null;

        let selected: MediaRef | undefined;
        if (
            preferredMediaIndex !== undefined &&
            media[preferredMediaIndex]?.type === 'video'
        ) {
            selected = media[preferredMediaIndex];
        } else {
            selected = media.find((m) => m?.type === 'video');
        }
        if (!selected) return null;

        const videoUrl = resolveVideoUrl(selected);
        if (!videoUrl) return null;
        const rawFallback = resolveFallbackVideoUrl(selected);
        const fallbackVideoUrl = rawFallback && rawFallback !== videoUrl ? rawFallback : undefined;

        const id = post?.id || post?._id;
        if (!id) return null;

        return {
            ...post,
            id: String(id),
            user: post.user as VideoPost['user'],
            content: post.content || {},
            stats: post.stats || { likesCount: 0, boostsCount: 0, commentsCount: 0, viewsCount: 0 },
            createdAt: post.createdAt || '',
            videoUrl,
            fallbackVideoUrl,
            posterUrl: resolvePosterUrl(selected),
        };
    }, [resolveVideoUrl, resolveFallbackVideoUrl, resolvePosterUrl]);
```

- [ ] **Step 5: Typecheck**

Run: `cd packages/frontend && bunx tsc --noEmit -p . 2>&1 | grep -i videos`
Expected: no output yet — Task 4 hasn't wired `fallbackVideoUrl` into `ActiveVideoSurface`'s props, so it's an unused-but-typed field at this point (not an error, just not consumed until the next task).

- [ ] **Step 6: Lint**

Run: `cd packages/frontend && bunx eslint "app/(app)/videos.tsx"`
Expected: 0 errors (same pre-existing `SEO` warning as always, nothing new).

- [ ] **Step 7: Commit**

```bash
git add "packages/frontend/app/(app)/videos.tsx"
git commit -m "feat(frontend): resolve HLS-preferred + fallback video URLs in videos.tsx"
```

---

### Task 4: One-shot fallback in `ActiveVideoSurface` when the preferred source errors

**Files:**
- Modify: `packages/frontend/app/(app)/videos.tsx` (`ActiveVideoSurfaceProps` ~line 192-207, `ActiveVideoSurface` body ~line 209-284, its call site(s) ~lines 613 and wherever else it's rendered — grep `<ActiveVideoSurface` to find all)

**Interfaces:**
- Consumes: `VideoPost.fallbackVideoUrl` (Task 3).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Add `fallbackVideoUrl` to `ActiveVideoSurfaceProps` and destructure it**

Current props interface (~line 192-207):

```ts
interface ActiveVideoSurfaceProps {
    videoUrl: string;
    posterUrl?: string;
    isActive: boolean;
    screenFocused: boolean;
    muted: boolean;
    onMutedChange: (muted: boolean) => void;
    onError: () => void;
    t: (key: string) => string;
    theme: ReturnType<typeof useTheme>;
    isLiked: boolean;
    onLikePost: () => void;
}
```

Add `fallbackVideoUrl?: string;` right after `videoUrl: string;`.

Update the destructuring at the top of `ActiveVideoSurface` (~line 209-220) to include `fallbackVideoUrl` alongside the existing `videoUrl`.

- [ ] **Step 2: Track the currently-attempted source and a one-shot fallback guard**

Right after the existing `const [posterFailed, setPosterFailed] = useState(false);` line (~inside the state block, before `const player = useVideoPlayer(...)`), add:

```ts
    // The source actually handed to the player. Starts as the preferred
    // `videoUrl` (HLS when the server resolved one); swaps to
    // `fallbackVideoUrl` EXACTLY ONCE if that source errors (e.g. the HLS
    // ladder hasn't finished transcoding yet). `triedFallbackRef` prevents a
    // second swap if the fallback ALSO errors — at that point it's a genuine
    // terminal failure and `onError` (the parent's give-up path) fires.
    const [currentSource, setCurrentSource] = useState(videoUrl);
    const triedFallbackRef = useRef(false);
```

- [ ] **Step 3: Use `currentSource` (not the `videoUrl` prop) as the player's source**

Current (~line 251-256):

```ts
    const player = useVideoPlayer(videoUrl, (p: VideoPlayer) => {
        p.loop = true;
        p.timeUpdateEventInterval = TIME_UPDATE_INTERVAL_S;
        p.muted = muted;
    });
```

Change `useVideoPlayer(videoUrl, ...)` to `useVideoPlayer(currentSource, ...)`.

- [ ] **Step 4: On error, try the fallback once before giving up**

Current `statusChange` listener (~line 264-284):

```ts
    useEffect(() => {
        const sub = player.addListener('statusChange', ({ status: next }) => {
            if (next === 'readyToPlay') {
                setHasRendered(true);
                setIsBuffering(false);
                if (player.duration > 0) {
                    setDuration(player.duration);
                }
            } else if (next === 'loading') {
                setHasRendered((rendered) => {
                    setIsBuffering(rendered);
                    return rendered;
                });
            } else if (next === 'error') {
                setHasError(true);
                onError();
            }
        });
        return () => sub.remove();
    }, [player, onError]);
```

Change the `else if (next === 'error')` branch to:

```ts
            } else if (next === 'error') {
                if (!triedFallbackRef.current && fallbackVideoUrl) {
                    triedFallbackRef.current = true;
                    setCurrentSource(fallbackVideoUrl);
                } else {
                    setHasError(true);
                    onError();
                }
            }
```

Add `fallbackVideoUrl` to this effect's dependency array: `}, [player, onError, fallbackVideoUrl]);`.

- [ ] **Step 5: Pass `fallbackVideoUrl` at every `<ActiveVideoSurface>` call site**

Run: `grep -n "<ActiveVideoSurface" "packages/frontend/app/(app)/videos.tsx"` to find every render call (there should be one, inside the row/`VideoItem` component around where `videoUrl={item.videoUrl}` is already passed — read the surrounding props at that call site). Add `fallbackVideoUrl={item.fallbackVideoUrl}` alongside the existing `videoUrl={item.videoUrl}` prop at each one.

- [ ] **Step 6: Typecheck**

Run: `cd packages/frontend && bunx tsc --noEmit -p . 2>&1 | grep -i videos`
Expected: no output.

- [ ] **Step 7: Lint**

Run: `cd packages/frontend && bunx eslint "app/(app)/videos.tsx"`
Expected: 0 errors.

- [ ] **Step 8: Manual device/browser verification**

No render-testing harness exists for this screen (established convention). Verify by reasoning AND, if a device/browser is available in your environment, by actually loading the Videos screen:
- A video with a ready HLS ladder plays normally (no visible change from today).
- To exercise the fallback path without waiting for a real not-yet-transcoded video: temporarily hardcode a broken `hlsUrl` (e.g. append `-broken` to one post's resolved `hlsUrl` in a local debug build) and confirm the video still plays via `fallbackVideoUrl`, with exactly one silent retry (no visible error badge), and that a SECOND induced failure (break both URLs) DOES show the existing "unavailable" error badge — i.e. the one-shot guard truly stops after one retry, not zero and not infinite.
- Revert any temporary debug hardcoding before committing.

- [ ] **Step 9: Commit**

```bash
git add "packages/frontend/app/(app)/videos.tsx"
git commit -m "fix(frontend): fall back to original video once when HLS source errors"
```

---

### Task 5: Widen the preload window and pagination lookahead

**Files:**
- Modify: `packages/frontend/app/(app)/videos.tsx:36,43` (the `ACTIVE_WINDOW_RADIUS` and `FLATLIST_CONFIG.END_REACHED_THRESHOLD` constants)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new consumed by later tasks — pure constant tuning.

- [ ] **Step 1: Widen the live-player window**

Current (line 36):

```ts
const ACTIVE_WINDOW_RADIUS = 1;
```

Change to:

```ts
// Widened from 1: at radius 2, the video two swipes away already has a live
// player mounted (buffering, muted, never playing — see the shouldPlay gate
// below) instead of only a static poster, so its stream has strictly more
// lead time to buffer before the viewer reaches it. Five concurrent mounted
// players (-2,-1,0,+1,+2) is still a bounded, small number of decoders.
const ACTIVE_WINDOW_RADIUS = 2;
```

- [ ] **Step 2: Fetch the next feed page earlier**

Current (line 43, inside `FLATLIST_CONFIG`):

```ts
    END_REACHED_THRESHOLD: 0.4,
```

Change to:

```ts
    // Raised from 0.4: trigger the next page fetch with more runway left in
    // the current page, so pagination network latency is absorbed before the
    // viewer actually runs out of loaded posts, instead of racing it.
    END_REACHED_THRESHOLD: 0.6,
```

- [ ] **Step 3: Typecheck + lint**

Run: `cd packages/frontend && bunx tsc --noEmit -p . 2>&1 | grep -i videos && bunx eslint "app/(app)/videos.tsx"`
Expected: no errors.

- [ ] **Step 4: Manual verification**

On a real device/simulator, scroll through several videos quickly (fast swipes) and confirm: no visible stutter/blank frames when landing on a new video, no crash or memory warning from the wider player window, and that pagination (scrolling to the end of the loaded posts) fetches the next page before hitting a visible empty state.

- [ ] **Step 5: Commit**

```bash
git add "packages/frontend/app/(app)/videos.tsx"
git commit -m "perf(frontend): widen video preload window and pagination lookahead"
```

---

### Task 6: Prefetch poster images ahead of the live-player window

**Files:**
- Modify: `packages/frontend/app/(app)/videos.tsx` (add a new effect near the `currentVisibleIndex` state, and the poster `<Image>` render in `ActiveVideoSurface`)

**Interfaces:**
- Consumes: `posts` array and `currentVisibleIndex` (both already exist in the screen's main component).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Find `currentVisibleIndex`'s declaration**

Run: `grep -n "currentVisibleIndex" "packages/frontend/app/(app)/videos.tsx" | head -5` to confirm where it's declared (state or derived) in the main screen component, so the new effect can read `posts`/`currentVisibleIndex` from the same scope.

- [ ] **Step 2: Add a poster-prefetch effect**

In the main screen component (same scope as `currentVisibleIndex` and the `posts` array — NOT inside `ActiveVideoSurface`, which only knows about its own single post), add:

```ts
    // Poster images are tiny (the `thumb` variant, already cached
    // memory-disk) — prefetch a wider window than the live-player radius so
    // the very first frame the viewer sees on a fast multi-swipe is already
    // in cache, even before that row's video decoder starts buffering.
    const POSTER_PREFETCH_RADIUS = ACTIVE_WINDOW_RADIUS + 2;
    useEffect(() => {
        const start = Math.max(0, currentVisibleIndex - POSTER_PREFETCH_RADIUS);
        const end = Math.min(posts.length - 1, currentVisibleIndex + POSTER_PREFETCH_RADIUS);
        for (let i = start; i <= end; i++) {
            const posterUrl = posts[i]?.posterUrl;
            if (posterUrl) {
                Image.prefetch(posterUrl).catch(() => {
                    // Prefetch is a pure optimization — a failure here is
                    // identical to a cache miss, never surfaced to the viewer.
                });
            }
        }
    }, [currentVisibleIndex, posts]);
```

(`Image` here is the `expo-image` import already at the top of this file, line 3 — `Image.prefetch` is a static method on it, no new import needed.)

- [ ] **Step 3: Set `priority="high"` on the currently-showing poster**

In `ActiveVideoSurface`'s poster `<Image>` render (~line 464-471):

```tsx
                        <Image
                            source={{ uri: posterUrl }}
                            style={styles.poster}
                            contentFit="contain"
                            cachePolicy="memory-disk"
                            transition={150}
                            onError={handlePosterError}
                        />
```

Add `priority="high"`:

```tsx
                        <Image
                            source={{ uri: posterUrl }}
                            style={styles.poster}
                            contentFit="contain"
                            cachePolicy="memory-disk"
                            transition={150}
                            priority="high"
                            onError={handlePosterError}
                        />
```

- [ ] **Step 4: Typecheck + lint**

Run: `cd packages/frontend && bunx tsc --noEmit -p . 2>&1 | grep -i videos && bunx eslint "app/(app)/videos.tsx"`
Expected: no errors.

- [ ] **Step 5: Manual verification**

Swipe rapidly through 5+ videos in a row on a real device; confirm the poster frame appears instantly on each new video (no blank/gray flash), even faster than before this change.

- [ ] **Step 6: Commit**

```bash
git add "packages/frontend/app/(app)/videos.tsx"
git commit -m "perf(frontend): prefetch poster images ahead of the live-player window"
```

---

## Post-plan verification (all tasks complete)

- [ ] `cd packages/shared-types && bun run build` — clean.
- [ ] `cd packages/backend && bun run test` — full suite green.
- [ ] `cd packages/backend && bunx tsc --noEmit` — no errors.
- [ ] `cd packages/frontend && bun run test` — full suite green.
- [ ] `cd packages/frontend && bunx tsc --noEmit -p .` — no new errors (3 pre-existing livekit-client externals ignored).
- [ ] `cd packages/frontend && bun run lint` — 0 errors, no new warnings.
- [ ] Real-device walkthrough of the Videos screen: normal playback, induced-fallback playback, fast multi-swipe (poster instant, no stutter), pagination at the end of a loaded page.
