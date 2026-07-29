# PiP session + next/previous transport controls

Date: 2026-07-29
Status: approved (scope: web + Android; iOS excluded by platform limit)

## Goal

The OS Picture-in-Picture window should offer more than play/pause — at minimum **next video** and **previous video**, so the reels feed stays usable while the app is backgrounded.

## What is actually possible (verified against installed source)

| Platform | Next/previous in the PiP window | Mechanism |
|---|---|---|
| **Android** | Yes, with native code | `PictureInPictureParams.Builder().setActions(List<RemoteAction>)` |
| **Chromium web** | Yes, JS only | `navigator.mediaSession.setActionHandler('nexttrack' \| 'previoustrack')` |
| **iOS** | **No. Platform limit.** | AVKit exposes no public API to add buttons to an `AVPlayer`-backed PiP window |
| Safari / Firefox web | No | Safari's PiP ignores MediaSession handlers; Firefox is already excluded by our capability check |

Supporting evidence:

- `expo-video@56.1.4` never calls `setActions`: its only `PictureInPictureParams` construction sites are `PictureInPictureUtils.kt:62` (`setSourceRectHint`), `:84-94` (`setAspectRatio` + `setAutoEnterEnabled`) and `PictureInPictureManager.kt:94` (an empty `Builder().build()`). Its per-view record (`records/PiPParams.kt:6-13`) has no actions field, and the JS-visible view surface (`VideoModule.kt:387-433`) exposes no action hook.
- iOS PiP is `AVPlayerViewController`-based (`ios/VideoView.swift:6-7`). Custom PiP controls exist only on the `AVPictureInPictureSampleBufferPlaybackDelegate` path, where the app renders frames itself. **A fork of expo-video would not unlock this** — it is not an expo-video gap.
- `ButtonOptions.showNext` / `showPrevious` (`src/VideoView.types.ts:196-244`) look like the answer and are not: they map to media3's in-view control bar (`PlayerViewExtension.kt:82-83`), and the reels screen sets `nativeControls={false}` (`videos.tsx:593`).
- `MPRemoteCommandCenter` is wired in `ios/NowPlayingManager.swift` for play/pause/skip±10s/scrub only, and drives the **lock screen**, not the PiP window.

**The user has accepted the iOS asymmetry**: iPhone keeps only the system ±15s skip that AVKit provides for free.

## The real cost is not the buttons

Wiring a handler is the small part. The reels screen cannot service a "next" today, on any platform:

- Each slide owns its own `useVideoPlayer` (`videos.tsx:310`), mounted within `ACTIVE_WINDOW_RADIUS`. PiP binds to **one** `VideoView`/player, so advancing the pager mounts a *different* player while the PiP window keeps showing the old one.
- On Android, expo-video reparents the PiP-owning `playerView` into the activity root and sets every other root child to `View.GONE` (`PictureInPictureManager.kt:265-280`), so scrolling the list is driving a hidden subtree.
- **The playback authority actively fights it.** `shouldPlay` is `eligible && (foreground || inPictureInPicture) && (silent || activeId === id)` with `eligible = visible && screenFocused` (`VideoPlaybackContext.tsx:363,378-379`), and visibility on this screen comes from `isActive && screenFocused`. The moment a background "next" moves the index, the old surface stops being active → not visible → not eligible → **the player inside the PiP window pauses**; the new surface has `inPictureInPicture: false` and `foreground: false`, so it does not play either. The window freezes on a still frame. This falls out of the model as designed and is not a tuning problem.

## Design: the PiP session

One idea fixes all of the above: **while PiP is open, the surface that entered it stays the owner and stays playing, and "next" swaps the SOURCE rather than the player.**

- Entering PiP opens a *session* pinned to the owning surface: that surface remains `active` for the authority regardless of the pager index, and remains the single audible player.
- Next/previous call `player.replace(nextSource)` on that same player (`src/VideoPlayer.types.ts:285,292`; `VideoModule.kt:311-321`) — no new player is mounted, so the PiP window never loses its subject.
- The session tracks its own cursor into the post list. On PiP exit, the pager index is re-synced to wherever the session ended up, so returning to the app lands on the video the user was actually watching.
- The authority gains an explicit notion of a session owner, replacing the implicit "the visible surface wins" rule for the duration. This is the one place the two-concept model (visible / active) needs a third input, and it must be expressed as such rather than by special-casing `videos.tsx`.

Two consequences that must be handled, not discovered later:

1. **Pagination does not run in PiP.** The list is paged by scroll on web (`videos.tsx:1314-1340`) and `onEndReached` on native; neither fires while backgrounded. The session needs its own top-up fetch when its cursor approaches the end of the loaded set.
2. **Impressions and view counts have no viewability source in PiP.** Neither the IntersectionObserver nor the list's viewability callback is running, so the session must report explicitly — and must not report a bogus `postUri`, per the existing telemetry contract.

## Phases

**Phase 1 — PiP session (JS, both platforms).** The authority learns about session ownership; `videos.tsx` gains the session, source swapping via `player.replace`, cursor + top-up fetch, index re-sync on exit, and explicit impression reporting. Nothing user-visible ships yet, but the freeze-on-next defect is designed out.

**Phase 2 — web transport controls (JS).** `navigator.mediaSession` metadata plus `nexttrack` / `previoustrack` handlers (and `seekforward` / `seekbackward` for ±10s), each feature-detected: `'mediaSession' in navigator`, and every `setActionHandler` guarded because unsupported action names throw `NotSupportedError`. Ships over a normal deploy.

**Phase 3 — Android transport controls (native).** A local Expo module that calls `activity.setPictureInPictureParams` with `RemoteAction`s backed by PendingIntents plus a `BroadcastReceiver`, emitting an event to JS. Must respect `getMaxNumPictureInPictureActions()` (3 on most devices). Android merges params via `copyOnlySet`, so our actions should survive expo-video's later aspect-ratio updates — **verify on a device rather than assuming**. `android/` and `ios/` are gitignored (CNG), so this lands only at the next prebuild / EAS build and **never over OTA**.

**Follow-up, not part of this work:** an upstream PR to expo-video adding `setActions` + an `onPictureInPictureAction` event. Their own code carries the TODO (`playbackService/VideoMediaSessionCallback.kt:19-21`), so the direction is welcome. Worth doing so we do not carry a private module indefinitely.

## Non-goals

- iOS next/previous in the PiP window. Not possible; do not attempt a workaround.
- The Document PiP API (a real browser window we fill with our own DOM). It would allow arbitrary controls, but it is Chromium-desktop only and requires moving the `<video>` node out of expo-video's web `VideoView`, which means owning the element ourselves. Bigger than this project.
- `showNowPlayingNotification` / background playback. It buys only the ±10s notification and pulls in an Android foreground service; it is a different feature.

## Verification

Jest reproduces none of this. Required evidence before any phase is called done:

- **Phase 1:** in a real browser, enter PiP, trigger next, and confirm the window keeps playing the new source rather than freezing — the specific defect being designed out. Confirm the pager index matches on exit.
- **Phase 2:** Chromium only; confirm the buttons render inside the PiP window and that Safari degrades silently rather than throwing.
- **Phase 3:** a real device build, since the config-plugin/manifest path cannot be verified from a Metro bundle. Verify the actions survive an aspect-ratio update, and check `getMaxNumPictureInPictureActions()` on the target device rather than assuming 3.
