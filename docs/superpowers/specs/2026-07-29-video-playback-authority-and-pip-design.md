# Video playback authority + Picture-in-Picture

Date: 2026-07-29
Status: approved, ready for implementation

## Problem

Two symptoms, one missing abstraction.

**Symptom A — videos keep playing (with audio) when they are not visible.** Reported on web AND native: scrolling past a video, or navigating to another screen, leaves it playing and audible.

**Symptom B — there is no Picture-in-Picture.** PiP is explicitly disabled everywhere (`allowsPictureInPicture={false}`) and the `expo-video` config plugin is unconfigured, so the native capability does not exist in the build.

### Root causes (verified in code)

1. **Native has no coordinator at all.** `context/ActiveVideoContext.tsx:139` — `if (!context || !IS_WEB) return { active: true, ... }`. Every mounted `VideoPlayer` therefore believes it is the active video, and `PostAttachmentVideo` passes `autoPlay={true}`. FlashList keeps off-screen cells mounted, so several videos play with audio simultaneously.
2. **Web never releases the active video.** `sendViewPosition` (`ActiveVideoContext.tsx:64-96`) picks the reporter closest to `windowHeight / 2.5` but never checks that the current active view is still *inside* the viewport. Scroll past the last video and nothing contests it, so it keeps playing off-screen.
3. **Nothing reacts to screen blur or app/tab backgrounding.** `VideoPlayer` has no `useIsFocused` and no `AppState`/`visibilitychange` awareness. Only `app/(app)/videos.tsx` has a focus gate (`screenFocused`).
4. **GIF mode bypasses coordination entirely.** `VideoPlayer.tsx:75` — `effectiveActive = gif ? true : active`. Every GIF-as-mp4 decodes forever, on-screen or not. Silent, but it burns CPU and battery.

The missing abstraction is a single app-wide authority answering "may this player play right now?". PiP is a capability layered on top of that authority — which is why enabling PiP before fixing playback would have produced a floating window for a video the user never chose.

## Model

Two orthogonal concepts, one authority.

| Concept | Rule | Applies to |
|---|---|---|
| **Visible** | on screen **AND** its screen is focused **AND** the app/tab is in the foreground → may play; otherwise pause | every player, GIFs included |
| **Active** | among *visible audible* players, exactly one plays — the one closest to the viewport's ideal line | audible players only; silent (GIF) players never compete, so every visible GIF may animate |

PiP is the **single** exception to the foreground gate: a player that has entered PiP keeps playing while the app is backgrounded.

Visibility is *reported*, never guessed, and the reporting source is per platform:

- **web** — each player's own `IntersectionObserver` (already implemented) reports both its center-Y **and** whether it is intersecting.
- **native, inside a list** — the list's `onViewableItemsChanged` publishes the viewable keys; a player inside that list is visible only if its key is in the set.
- **native, not inside a list** (post detail, single-video screens) — no viewability source is mounted above the player, so it is visible while its screen is focused.

## Architecture

### `context/VideoPlaybackContext.tsx` (replaces `context/ActiveVideoContext.tsx`)

Clean cut: the old file and the `ActiveVideoProvider` / `useActiveVideo` names are deleted, not aliased. `AppShellProviders` mounts `VideoPlaybackProvider` in the same position.

Exported API:

```ts
export function VideoPlaybackProvider({ children }: { children: React.ReactNode }): React.ReactElement;

/** Mounted by a list that owns viewability for the players inside it (native feeds). */
export function VideoViewabilityProvider({
  viewableKeys,
  children,
}: {
  viewableKeys: ReadonlySet<string>;
  children: React.ReactNode;
}): React.ReactElement;

export interface UseVideoPlaybackOptions {
  /** Stable identity of this player instance. */
  id: string;
  /** Key this player is known by to the nearest viewability source; omit outside a list. */
  viewabilityKey?: string;
  /** Silent players (GIF mode) never compete for the single audible slot. */
  silent?: boolean;
  /** Set while this player owns the OS PiP window — exempts it from the foreground gate. */
  inPictureInPicture?: boolean;
}

export interface UseVideoPlaybackResult {
  /** The ONLY playback signal a consumer needs. */
  shouldPlay: boolean;
  /** Manual play wins: claim the audible slot. */
  claimActive: () => void;
  /** Web: report viewport center-Y and intersection from an IntersectionObserver. */
  reportVisibility: (y: number, isIntersecting: boolean) => void;
}

export function useVideoPlayback(options: UseVideoPlaybackOptions): UseVideoPlaybackResult;
```

Behaviour:

- `shouldPlay = visible && screenFocused && (foreground || inPictureInPicture) && (silent || activeId === id)`.
- `screenFocused` comes from `useIsFocused()` (expo-router).
- `foreground` is `AppState.currentState === 'active'` on native and `document.visibilityState === 'visible'` on web, tracked in the provider once — not per player.
- `visible` resolution order: web → last reported `isIntersecting`; native with a `VideoViewabilityProvider` above and a `viewabilityKey` → membership in `viewableKeys`; otherwise → `true`.
- Active selection keeps today's rule (closest to `windowHeight / 2.5`, a manually-played video keeps priority while it stays in the viewport) **plus** the fix: a reporter that stops intersecting immediately relinquishes the active slot, and if no intersecting candidate remains, `activeId` becomes `null` and nothing plays.
- A player unmounting while active also relinquishes.

### `components/common/VideoPlayer.tsx`

- Consumes `useVideoPlayback` and plays strictly on `shouldPlay`. `gif` maps to `silent: true` — GIFs stop being unconditionally active and become visibility-gated like everything else.
- Takes the id/viewability key from its owner rather than an anonymous `useId`, so native list viewability can address it: `PostAttachmentMedia` passes the post key and media id down.
- Keeps `allowsPictureInPicture={false}`: feed previews and GIFs never enter PiP. On web this also emits `disablePictureInPicture` on the `<video>`, removing PiP from the browser context menu for previews.
- Cleanup (explicitly requested): the four listener `useEffect`s become `useEventListener` from `expo`; `isPlaying` / `duration` / first-frame state become derived from `useEvent`; the `src`-change reset moves to the previous-value-during-render pattern already used in `videos.tsx`.

### `components/Feed/Feed.native.tsx`

`handleViewableItemsChanged` already reconciles the viewable post set for impressions. It additionally publishes that set as `viewableKeys` into a `VideoViewabilityProvider` wrapping the list, so a video is visible on native only while its row is viewable. The existing impression contract is untouched: interstitial rows still never report, and only a focused feed reports.

`utils/feedUtils.ts` `getItemKey(item: any)` is typed properly as part of this change (`any` is forbidden by the project rules and this is the key the video authority now depends on).

### `app/(app)/videos.tsx` — the only PiP surface

Tapping a video in the feed navigates to `/videos?postId=…&mediaIndex=…` (`PostAttachmentsRow.tsx:394-399`), so the reels screen *is* the fullscreen post-video screen. It is therefore the only surface that gets PiP.

- Only the surface that is both active and focused receives `allowsPictureInPicture` and `startsPictureInPictureAutomatically` — expo-video allows exactly one player in PiP, and neighbouring surfaces are preloaded but never playing.
- A PiP button in the overlay calls `startPictureInPicture()` through a `VideoView` ref. It renders only when `isPictureInPictureSupported()` is true, which is what gives web a PiP affordance (web has no automatic PiP, and `nativeControls={false}` means the browser shows no button of its own).
- `onPictureInPictureStart` / `onPictureInPictureStop` drive the `inPictureInPicture` flag so the foreground gate does not pause the video the OS is showing.
- Same listener cleanup as `VideoPlayer`: `statusChange` / `timeUpdate` effects become `useEventListener`.

### `app.config.js`

`"expo-video"` becomes `["expo-video", { supportsPictureInPicture: true }]`, which adds `UIBackgroundModes: ["audio"]` on iOS and `android:supportsPictureInPicture="true"` on the main activity.

`supportsBackgroundPlayback` stays off: it pulls in a foreground service plus a now-playing notification on Android, which is background *audio*, not PiP, and was not requested.

`android/` and `ios/` are gitignored (CNG), so this applies at the next prebuild / EAS build. **It does not ship over OTA.**

## Non-goals

- No in-app floating mini-player. PiP here means the OS window only.
- No background audio playback.
- No PiP for feed previews, GIFs, the compose preview, or the GIF picker.
- No change to external embeds (`ExternalEmbedPlayer`), which are third-party iframes/webviews.

## Verification

- `useEffect` for subscribing to an imperative external object *with cleanup* is the legitimate case, and the repo already documents this (`videos.tsx:1165`). The cleanup replaces those with expo's official `useEvent` / `useEventListener` rather than inventing a worse pattern; it does not delete effects that must exist.
- Jest does not reproduce autoplay, viewability, focus, or backgrounding behaviour. Playback must be verified in a real foregrounded browser tab and on a device build: scroll a video off screen (must go silent), navigate away (must go silent), background the app (must go silent unless in PiP), and confirm exactly one audible video at a time.
